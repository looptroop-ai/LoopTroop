import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorCommand, runChecks } from '../server/cli/doctorCommand'

/**
 * 2.12 contract: doctor tells a user whether this machine can run LoopTroop,
 * names a remedy for anything wrong, and emits only JSON on stdout under --json
 * so its output can be piped into a parser.
 */
describe('doctor command', () => {
  const tempDirs: string[] = []
  const previousConfigDir = process.env.LOOPTROOP_CONFIG_DIR
  const previousMode = process.env.LOOPTROOP_OPENCODE_MODE

  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) {
      try {
        chmodSync(dir, 0o700)
      } catch {
        // Already removable.
      }
      rmSync(dir, { recursive: true, force: true })
    }
    if (previousConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
    else process.env.LOOPTROOP_CONFIG_DIR = previousConfigDir
    if (previousMode === undefined) delete process.env.LOOPTROOP_OPENCODE_MODE
    else process.env.LOOPTROOP_OPENCODE_MODE = previousMode
  })

  function useConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-doctor-'))
    tempDirs.push(dir)
    process.env.LOOPTROOP_CONFIG_DIR = dir
    process.env.LOOPTROOP_OPENCODE_MODE = 'mock'
    return dir
  }

  function captureStdout(): { text: () => string } {
    let captured = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    })
    return { text: () => captured }
  }

  it('reports on the runtime, tooling, config and services', async () => {
    useConfigDir()

    const names = (await runChecks()).map((check) => check.name)

    expect(names).toContain('node')
    expect(names).toContain('git')
    expect(names).toContain('config dir')
    expect(names).toContain('schema')
    expect(names).toContain('opencode')
    expect(names).toContain('daemon')
  })

  it('treats a missing database as healthy rather than a fault', async () => {
    useConfigDir()

    const schema = (await runChecks()).find((check) => check.name === 'schema')

    expect(schema?.status).toBe('ok')
    expect(schema?.detail).toContain('no database')
  })

  it('emits only valid JSON on stdout under --json', async () => {
    useConfigDir()
    const stdout = captureStdout()

    await doctorCommand(true)

    // Any stray human-readable line would break a caller parsing this.
    const parsed = JSON.parse(stdout.text()) as { ok: boolean; checks: unknown[] }
    expect(typeof parsed.ok).toBe('boolean')
    expect(Array.isArray(parsed.checks)).toBe(true)
  })

  it('exits zero when nothing is failing', async () => {
    useConfigDir()
    captureStdout()

    const checks = await runChecks()
    const anyFailing = checks.some((check) => check.status === 'fail')
    const code = await doctorCommand(false)

    expect(code).toBe(anyFailing ? 1 : 0)
  })

  it('attaches a remedy to anything that is not ok', async () => {
    useConfigDir()

    for (const check of await runChecks()) {
      if (check.status === 'ok') continue
      expect(check.remedy, `${check.name} reported ${check.status} without a remedy`).toBeTruthy()
    }
  })

  it('treats mock OpenCode as healthy so a machine without it can still be checked', async () => {
    useConfigDir()

    const opencode = (await runChecks()).find((check) => check.name === 'opencode')

    expect(opencode?.status).toBe('ok')
    expect(opencode?.detail).toContain('mock')
  })

  it('prints a human summary without --json', async () => {
    useConfigDir()
    const stdout = captureStdout()

    await doctorCommand(false)

    expect(stdout.text()).toMatch(/can run LoopTroop|cannot run/)
  })

  it('reports the port the next start would ask for', async () => {
    useConfigDir()
    // A port bound and released here rather than the default, so the check has
    // a known answer instead of depending on what else runs on this machine.
    const free = await reservePort()
    process.env.LOOPTROOP_BACKEND_PORT = String(free)

    try {
      const port = (await runChecks()).find((check) => check.name === 'port')
      expect(port?.status).toBe('ok')
      expect(port?.detail).toContain(String(free))
    } finally {
      delete process.env.LOOPTROOP_BACKEND_PORT
    }
  })

  it('fails when a port the user named is already taken', async () => {
    useConfigDir()
    const blocker = createServer()
    await new Promise<void>((ready) => blocker.listen(0, '127.0.0.1', ready))
    process.env.LOOPTROOP_BACKEND_PORT = String((blocker.address() as { port: number }).port)

    try {
      // The runtime refuses to relocate off a port the user named, so doctor
      // must not report this as survivable.
      const port = (await runChecks()).find((check) => check.name === 'port')
      expect(port?.status).toBe('fail')
      expect(port?.remedy).toBeTruthy()
    } finally {
      delete process.env.LOOPTROOP_BACKEND_PORT
      await new Promise<void>((done) => blocker.close(() => done()))
    }
  })

  it('reports the OpenCode CLI version separately from the running server', async () => {
    useConfigDir()

    const checks = await runChecks()
    const cli = checks.find((check) => check.name === 'opencode cli')
    const server = checks.find((check) => check.name === 'opencode')

    // They answer different questions: which binary a start would launch, and
    // whether a server is answering right now.
    expect(cli).toBeDefined()
    expect(server).toBeDefined()
    expect(cli?.status).toBe('ok')
  })

  async function reservePort(): Promise<number> {
    const server = createServer()
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    const port = (server.address() as { port: number }).port
    await new Promise<void>((done) => server.close(() => done()))
    return port
  }

  /**
   * 2.16 contract: a start refused by the schema guard is reported by the
   * command a user is told to run, in a form a script can act on. The daemon
   * that hit it is gone, and the database it named need not be the app database
   * checked above, so nothing else here can see it.
   */
  describe('a refused start', () => {
    async function recordRefusal(configDir: string, options: { found: number }): Promise<string> {
      const dbPath = join(configDir, 'refused.sqlite')
      const { Database } = await import('../server/db/sqliteShim')
      const seed = new Database(dbPath)
      // Version 0 with no tables reads as a brand-new file, which is the one
      // case the guard lets through.
      seed.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY)')
      seed.pragma(`user_version = ${options.found}`)
      seed.close()

      const { writeDaemonStartFailure } = await import('../server/lib/daemonPaths')
      writeDaemonStartFailure({
        reason: 'schema-incompatible',
        at: '2026-01-02T03:04:05.000Z',
        version: '0.0.0-test',
        message: `The project database at ${dbPath} was created by a newer version of LoopTroop.`,
        schema: {
          databaseLabel: 'project database',
          databasePath: dbPath,
          found: options.found,
          expected: 1,
          migratableFrom: 1,
        },
      }, configDir)

      return dbPath
    }

    it('reports a refusal that is still true, with a remedy', async () => {
      const configDir = useConfigDir()
      const dbPath = await recordRefusal(configDir, { found: 99 })

      const check = (await runChecks()).find((entry) => entry.name === 'last start')

      expect(check?.status).toBe('fail')
      expect(check?.detail).toContain('project database')
      expect(check?.remedy).toContain(dbPath)
    })

    it('carries the version numbers so a caller need not parse the prose', async () => {
      const configDir = useConfigDir()
      const dbPath = await recordRefusal(configDir, { found: 99 })
      const stdout = captureStdout()

      await doctorCommand(true)

      const parsed = JSON.parse(stdout.text()) as {
        ok: boolean
        checks: { name: string; schema?: { databasePath: string; found: number; expected: number } }[]
      }
      const check = parsed.checks.find((entry) => entry.name === 'last start')
      expect(check?.schema).toEqual({ databasePath: dbPath, found: 99, expected: 1 })
      expect(parsed.ok).toBe(false)
    })

    it('stops reporting a refusal the user has already fixed', async () => {
      const configDir = useConfigDir()
      // Version 1 is what this build expects: whoever hit the refusal has since
      // upgraded LoopTroop or replaced the file.
      await recordRefusal(configDir, { found: 1 })

      const check = (await runChecks()).find((entry) => entry.name === 'last start')

      // A week-old refusal reported as a live failure sends someone hunting for
      // a problem that is no longer there.
      expect(check?.status).toBe('ok')
    })

    it('says nothing when no start has been refused', async () => {
      useConfigDir()

      const check = (await runChecks()).find((entry) => entry.name === 'last start')

      expect(check?.status).toBe('ok')
      expect(check?.remedy).toBeUndefined()
    })
  })
})
