import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorCommand, runChecks, judgeOpenCode, runProbe } from '../server/cli/doctorCommand'
import type { DaemonState } from '../server/lib/daemonPaths'

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

  /**
   * The verdict `doctor` exists to give, and the one it got wrong.
   *
   * Every OpenCode outcome was a warning, so the command exited 0 and printed
   * "This machine can run LoopTroop" on a machine where `looptroop start` is
   * refused outright for want of the binary — and on one where the daemon is up
   * and its OpenCode died an hour ago. Both are exactly the question someone
   * runs `doctor` to have answered.
   */
  describe('whether OpenCode can actually run', () => {
    const baseUrl = 'http://127.0.0.1:4096'

    function daemonWith(opencode: DaemonState['opencode']): DaemonState {
      return {
        instanceId: 'i-1',
        pid: process.pid,
        port: 4317,
        host: '127.0.0.1',
        startedAt: '2026-01-01T00:00:00.000Z',
        version: '0.0.0-test',
        apiToken: 'secret',
        ...(opencode === undefined ? {} : { opencode }),
      }
    }

    it('fails when nothing is running and nothing could start one', () => {
      const check = judgeOpenCode(
        { kind: 'unreachable' },
        { baseUrl, daemon: null, cliAvailable: false },
      )

      // The next start throws OpenCodeMissingError before it binds a port, so
      // reporting this as survivable is a straight contradiction of what
      // happens next.
      expect(check.status).toBe('fail')
      expect(check.remedy).toContain('opencode.ai')
    })

    it('only warns when a start would launch one', () => {
      const check = judgeOpenCode(
        { kind: 'unreachable' },
        { baseUrl, daemon: null, cliAvailable: true },
      )

      // A fresh install has no server running and does not need one yet.
      // Failing here would fail every machine before its first start.
      expect(check.status).toBe('warn')
      expect(check.detail).toContain('will launch one')
    })

    it('fails when a running daemon has lost the server it depends on', () => {
      const check = judgeOpenCode(
        { kind: 'unreachable' },
        {
          baseUrl,
          daemon: daemonWith({ baseUrl, owned: true, status: 'managed', pid: 4242 }),
          cliAvailable: true,
        },
      )

      // The binary being installed does not help here: LoopTroop is already
      // running, and every coding operation it is asked for fails right now.
      expect(check.status).toBe('fail')
      expect(check.remedy).toContain('looptroop restart')
    })

    it('repeats the reason the supervisor recorded when it gave up', () => {
      const check = judgeOpenCode(
        { kind: 'unreachable' },
        {
          baseUrl,
          daemon: daemonWith({
            baseUrl,
            owned: false,
            status: 'degraded',
            detail: 'OpenCode exited 3 times; giving up.',
          }),
          cliAvailable: true,
        },
      )

      expect(check.status).toBe('fail')
      // Written by the daemon that watched it happen; `doctor` runs in a
      // different process minutes later and cannot rediscover it.
      expect(check.detail).toContain('OpenCode exited 3 times')
    })

    it('reports a reachable server as healthy whoever started it', () => {
      expect(judgeOpenCode({ kind: 'ok' }, { baseUrl, daemon: null, cliAvailable: false }).status).toBe('ok')
    })

    it('carries the status code when something else answers on that port', () => {
      const check = judgeOpenCode(
        { kind: 'responded', status: 502 },
        { baseUrl, daemon: null, cliAvailable: true },
      )

      expect(check.detail).toContain('502')
    })
  })

  /**
   * `doctor` is what someone runs when the machine is already misbehaving, and
   * every probe here shells out to a binary that can hang: `gh auth status`
   * reaches github.com, and a black-holed proxy used to turn the diagnosis into
   * a second hang with no output. execFileSync blocks the whole process, so
   * there is no later point at which it could be given up on.
   */
  describe('probing external commands', () => {
    it('gives up on a command that does not answer', () => {
      const started = Date.now()
      const result = runProbe(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], 500)

      expect(result.kind).toBe('timed-out')
      // The deadline, not the command's own lifetime: without a timeout this
      // sits for a full minute.
      expect(Date.now() - started).toBeLessThan(30_000)
    })

    it('tells a hung command apart from a missing one', () => {
      // Both used to report "not found on PATH", which sends someone to install
      // a tool they already have.
      expect(runProbe('looptroop-not-a-real-binary', ['--version'], 500).kind).toBe('unavailable')
    })

    it('returns the output of a command that answers', () => {
      const result = runProbe(process.execPath, ['--version'], 5_000)

      expect(result.kind).toBe('ok')
      if (result.kind === 'ok') expect(result.output).toContain('v')
    })
  })
})
