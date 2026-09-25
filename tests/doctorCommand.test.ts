import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, chmodSync, writeFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { doctorCommand, runChecks, isOpenCodeCliLaunchable, judgeOpenCode, runProbe } from '../server/cli/doctorCommand'
import { NODE_FLOOR as FLOOR } from '../server/lib/nodeFloor'
import { formatNodeVersion } from '../shared/nodeFloor'
import { writeDaemonState, type DaemonState } from '../server/lib/daemonPaths'
import { APP_VERSION } from '../server/lib/appVersion'
import { removeTempDir } from '../server/test/tempDir'

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
    vi.unstubAllEnvs()
    for (const dir of tempDirs.splice(0)) {
      try {
        chmodSync(dir, 0o700)
      } catch {
        // Already removable.
      }
      removeTempDir(dir)
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

  it('brackets an IPv6 daemon address in its report', async () => {
    const configDir = useConfigDir()
    writeDaemonState({
      instanceId: 'ipv6-daemon',
      pid: process.pid,
      host: '::1',
      port: 4317,
      startedAt: new Date().toISOString(),
      version: '0.0.0-test',
      apiToken: 'test-token',
    }, configDir)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/api/health')) {
        return new Response(JSON.stringify({ instanceId: 'ipv6-daemon' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200 })
    })

    const check = (await runChecks()).find((entry) => entry.name === 'daemon')

    expect(check?.detail).toContain('http://[::1]:4317')
  })

  /**
   * §11.5's observable change: `doctor` used to accept an older minor release
   * while the launcher refused to start below the declared floor, so a machine
   * in between passed every check the product offered and then could not run it.
   *
   * `runChecks()` reads the real `process.versions.node`, and CI runs a Node
   * well above the floor — so reverting `checkNode` to the old major.minor
   * comparison stayed green here while the behaviour users see changed. The
   * runtime is stubbed for exactly that reason: the boundary is the case.
   */
  describe('the node check', () => {
    const realVersions = process.versions

    afterEach(() => {
      Object.defineProperty(process, 'versions', { value: realVersions, configurable: true })
    })

    function nodeCheckOn(version: string) {
      Object.defineProperty(process, 'versions', {
        value: { ...realVersions, node: version },
        configurable: true,
      })
      return runChecks().then((checks) => checks.find((check) => check.name === 'node'))
    }

    const justBelow = FLOOR.patch > 0
      ? formatNodeVersion({ ...FLOOR, patch: FLOOR.patch - 1 })
      : formatNodeVersion({ ...FLOOR, minor: FLOOR.minor - 1, patch: 99 })

    it.each([
      [formatNodeVersion(FLOOR), 'ok'],
      [formatNodeVersion({ ...FLOOR, patch: FLOOR.patch + 1 }), 'ok'],
      [`${FLOOR.major + 1}.0.0`, 'ok'],
      [justBelow, 'fail'],
      [`${FLOOR.major}.${FLOOR.minor - 1}.99`, 'fail'],
      // A prerelease of the floor is *below* it, which is how npm reads
      // `engines.node` and what the launcher enforces.
      [`${formatNodeVersion(FLOOR)}-rc.1`, 'fail'],
      [`${FLOOR.major + 1}.0.0-nightly20260101`, 'ok'],
    ])('is %s on Node %s', async (version, status) => {
      useConfigDir()

      const check = await nodeCheckOn(version)

      expect(check?.status).toBe(status)
      expect(check?.detail).toContain(version)
      expect(check?.node?.version).toBe(version)
    })

    it('names the floor and a way to install it when the runtime is too old', async () => {
      useConfigDir()

      const check = await nodeCheckOn(justBelow)

      expect(check?.remedy).toContain(`LoopTroop needs Node ${formatNodeVersion(FLOOR)} or newer`)
      // The platform hint, whichever platform the suite is running on. macOS
      // names the unversioned formula: `node@<major>` is keg-only, so it
      // installs Node without putting it on PATH.
      expect(check?.remedy).toMatch(/brew install node$|winget install OpenJS\.NodeJS\.LTS|nvm install \d+/)
    })
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

  it('always reports current and latest versions when update status is supplied', async () => {
    useConfigDir()
    const stdout = captureStdout()
    const update = {
      currentVersion: APP_VERSION,
      latestVersion: '0.6.0',
      updateAvailable: true,
      checkedAt: '2026-08-16T08:00:00.000Z',
      installChannel: 'npm' as const,
      upgradeCommand: 'npm install -g looptroop@latest',
      postUpgradeCommand: 'looptroop restart',
      release: null,
    }

    await doctorCommand(false, update)

    // Named `looptroop` rather than `version`, so the line says which version it
    // is among the four the report now lists.
    expect(stdout.text()).toContain('looptroop')
    expect(stdout.text()).toContain(`${APP_VERSION} (latest 0.6.0)`)
    expect(stdout.text()).toContain('npm install -g looptroop@latest')
    expect(stdout.text()).toContain('looptroop restart')
  })

  it('says nothing about a newer version when this is the newest', async () => {
    useConfigDir()
    const stdout = captureStdout()

    await doctorCommand(false, {
      currentVersion: APP_VERSION,
      latestVersion: APP_VERSION,
      updateAvailable: false,
      checkedAt: '2026-08-16T08:00:00.000Z',
      installChannel: 'npm' as const,
      upgradeCommand: 'npm install -g looptroop@latest',
      release: null,
    })

    // Both numbers, always — "you are on the newest" is the answer being asked
    // for, and omitting it leaves the reader unsure the check ran at all. What
    // marks a version worth acting on is the emphasis, not its presence.
    const looptroopLine = stdout.text().split('\n').find((line) => line.includes('looptroop '))
    expect(looptroopLine).toBeDefined()
    expect(looptroopLine).toContain(`${APP_VERSION} (latest ${APP_VERSION})`)
  })

  it('includes structured update facts in doctor JSON', async () => {
    useConfigDir()
    const stdout = captureStdout()
    await doctorCommand(true, {
      currentVersion: APP_VERSION,
      latestVersion: null,
      updateAvailable: false,
      checkedAt: null,
      installChannel: 'unknown',
      upgradeCommand: 'See https://www.looptroop.ovh for upgrade instructions',
      release: null,
    })

    const payload = JSON.parse(stdout.text()) as { update: { currentVersion: string; latestVersion: null } }
    expect(payload.update).toEqual(expect.objectContaining({ currentVersion: APP_VERSION, latestVersion: null }))
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

  it('checks OpenCode directly through its verified API without following redirects', async () => {
    useConfigDir()
    process.env.LOOPTROOP_OPENCODE_MODE = 'real'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ version: '2.0.15', pid: 812 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    const opencode = (await runChecks()).find((check) => check.name === 'opencode')

    expect(opencode?.status).toBe('ok')
    expect(opencode?.detail).toContain('(v2, 2.0.15)')
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/info$/), expect.objectContaining({ redirect: 'manual' }))
  })

  it('uses the authenticated daemon health route and reports model discovery failures', async () => {
    const configDir = useConfigDir()
    process.env.LOOPTROOP_OPENCODE_MODE = 'real'
    writeDaemonState({
      instanceId: 'health-daemon',
      pid: process.pid,
      host: '127.0.0.1',
      port: 4318,
      startedAt: new Date().toISOString(),
      version: '0.0.0-test',
      apiToken: 'doctor-api-token',
    }, configDir)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/api/health')) {
        return new Response(JSON.stringify({ instanceId: 'health-daemon' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (String(input).endsWith('/api/health/opencode')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer doctor-api-token')
        return new Response(JSON.stringify({
          status: 'ok',
          failureKind: 'model_discovery',
          error: 'provider configuration is missing',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200 })
    })

    const opencode = (await runChecks()).find((check) => check.name === 'opencode')

    expect(opencode).toMatchObject({
      name: 'opencode',
      status: 'fail',
      detail: expect.stringContaining('model_discovery'),
    })
    expect(opencode?.remedy).toContain('provider and model')
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/\/api\/info$/), expect.anything())
  })

  it('reports the OpenCode URL recorded by the daemon', async () => {
    const configDir = useConfigDir()
    process.env.LOOPTROOP_OPENCODE_MODE = 'real'
    process.env.LOOPTROOP_OPENCODE_BASE_URL = 'http://127.0.0.1:4096'
    const daemonOpenCodeUrl = 'http://127.0.0.1:4321'
    writeDaemonState({
      instanceId: 'actual-opencode-daemon',
      pid: process.pid,
      host: '127.0.0.1',
      port: 4318,
      startedAt: new Date().toISOString(),
      version: '0.0.0-test',
      apiToken: 'doctor-api-token',
      opencode: { baseUrl: daemonOpenCodeUrl, owned: true, status: 'managed', pid: 4322 },
    }, configDir)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/api/health')) {
        return new Response(JSON.stringify({ instanceId: 'actual-opencode-daemon' }), { status: 200 })
      }
      if (String(input).endsWith('/api/health/opencode')) {
        return new Response(JSON.stringify({ status: 'ok', protocol: 'v2', version: '2.0.16' }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })

    const opencode = (await runChecks()).find((check) => check.name === 'opencode')

    expect(opencode?.detail).toContain(`reachable at ${daemonOpenCodeUrl}`)
    expect(opencode?.detail).not.toContain('reachable at http://127.0.0.1:4096')
  })

  it('attributes daemon health HTTP failures to the daemon health URL', async () => {
    const configDir = useConfigDir()
    process.env.LOOPTROOP_OPENCODE_MODE = 'real'
    writeDaemonState({
      instanceId: 'health-status-daemon',
      pid: process.pid,
      host: '127.0.0.1',
      port: 4319,
      startedAt: new Date().toISOString(),
      version: '0.0.0-test',
      apiToken: 'doctor-api-token',
    }, configDir)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/api/health/opencode')) return new Response('', { status: 503 })
      if (String(input).endsWith('/api/health')) {
        return new Response(JSON.stringify({ instanceId: 'health-status-daemon' }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })

    const opencode = (await runChecks()).find((check) => check.name === 'opencode')

    expect(opencode?.detail).toContain('responded 503 at http://127.0.0.1:4319/api/health/opencode')
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

  it('uses one detected OpenCode version to choose and render the matching latest package', async () => {
    const configDir = useConfigDir()
    const binDir = mkdtempSync(join(tmpdir(), 'looptroop-doctor-bin-'))
    tempDirs.push(binDir)
    const tracePath = join(configDir, 'opencode-probe.txt')
    const scriptPath = join(binDir, 'opencode-fixture.cjs')
    const script = [
      "const fs = require('node:fs')",
      "fs.appendFileSync(process.env.OPENCODE_PROBE_TRACE, process.argv.slice(2).join(' ') + '\\n')",
      "if (process.argv[2] === '--version') { process.stdout.write('OpenCode 2.0.15\\n'); process.exit(0) }",
      'process.exit(1)',
      '',
    ].join('\n')
    writeFileSync(scriptPath, script, 'utf8')

    if (process.platform === 'win32') {
      writeFileSync(join(binDir, 'opencode.cmd'), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8')
    } else {
      const executablePath = join(binDir, 'opencode')
      writeFileSync(executablePath, `#!/usr/bin/env node\n${script}`, 'utf8')
      chmodSync(executablePath, 0o700)
    }

    vi.stubEnv('PATH', `${binDir}${delimiter}${process.env.PATH ?? ''}`)
    vi.stubEnv('LOOPTROOP_TRUSTED_EXECUTABLE_DIRS', binDir)
    vi.stubEnv('LOOPTROOP_OPENCODE_MODE', 'live')
    vi.stubEnv('LOOPTROOP_OPENCODE_BASE_URL', 'http://127.0.0.1:4319')
    vi.stubEnv('OPENCODE_PROBE_TRACE', tracePath)

    const requested: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      requested.push(url)
      if (url.endsWith('/api/info')) {
        return new Response(JSON.stringify({ version: '2.0.15', pid: 4319 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      const body = url.endsWith('/@opencode/cli/latest')
        ? { version: '2.0.16' }
        : url.endsWith('/repos/cli/cli/releases/latest')
          ? { tag_name: 'v2.83.0' }
          : url.endsWith('/repos/git/git/tags?per_page=100')
            ? [{ name: 'v2.50.1' }]
            : { version: '24.8.0' }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const checks = await runChecks()
    const cli = checks.find((check) => check.name === 'opencode cli')

    expect(cli?.detail).toBe('2.0.15 (latest 2.0.16)')
    expect(cli).not.toHaveProperty('opencodeMajor')
    expect(requested).toContain('https://registry.npmjs.org/@opencode/cli/latest')
    expect(requested).not.toContain('https://registry.npmjs.org/opencode-ai/latest')
    expect(readFileSync(tracePath, 'utf8').trim().split('\n')).toEqual(['--version'])
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

    it('treats a timed-out version probe as launchable, and a missing binary as not', () => {
      // Both report `warn`. Only one of them means the binary is not there, and
      // keying on `status === 'ok'` made a slow probe say `opencode` cannot be
      // launched.
      expect(isOpenCodeCliLaunchable({ name: 'opencode cli', status: 'ok', detail: '1.2.3' })).toBe(true)
      expect(isOpenCodeCliLaunchable({ name: 'opencode cli', status: 'warn', detail: 'timed out' })).toBe(true)
      expect(isOpenCodeCliLaunchable({ name: 'opencode cli', status: 'warn', missing: true, detail: 'not found on PATH' })).toBe(false)
    })

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

    it('does not pass daemon credentials to a probe child', () => {
      const ambientApiToken = process.env.LOOPTROOP_API_TOKEN
      const ambientDevEventToken = process.env.LOOPTROOP_DEV_EVENT_TOKEN
      process.env.LOOPTROOP_API_TOKEN = 'doctor-test-api-token'
      process.env.LOOPTROOP_DEV_EVENT_TOKEN = 'doctor-test-event-token'
      try {
        const result = runProbe(
          process.execPath,
          ['-e', 'process.stdout.write(JSON.stringify({ api: process.env.LOOPTROOP_API_TOKEN, event: process.env.LOOPTROOP_DEV_EVENT_TOKEN }))'],
          5_000,
        )

        expect(result.kind).toBe('ok')
        if (result.kind === 'ok') expect(JSON.parse(result.output)).toEqual({})
      } finally {
        if (ambientApiToken === undefined) delete process.env.LOOPTROOP_API_TOKEN
        else process.env.LOOPTROOP_API_TOKEN = ambientApiToken
        if (ambientDevEventToken === undefined) delete process.env.LOOPTROOP_DEV_EVENT_TOKEN
        else process.env.LOOPTROOP_DEV_EVENT_TOKEN = ambientDevEventToken
      }
    })
  })
})
