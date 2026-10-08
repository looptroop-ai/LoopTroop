import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, chmodSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { doctorCommand, runChecks, isOpenCodeCliLaunchable, judgeOpenCode, runProbe } from '../server/cli/doctorCommand'
import { NODE_FLOOR as FLOOR } from '../server/lib/nodeFloor'
import { formatNodeVersion } from '../shared/nodeFloor'
import { getDaemonStatePath, writeDaemonState, writeDaemonStartFailure, type DaemonState } from '../server/lib/daemonPaths'
import { readProcessStartToken } from '../server/lib/processIdentity'
import { applyIgnoreMode } from '../server/git/repository'
import { APP_VERSION } from '../server/lib/appVersion'
import { removeTempDir } from '../server/test/tempDir'
import { leaderlessProcessGroup } from '../server/test/processGroup'

/**
 * 2.12 contract: doctor tells a user whether this machine can run LoopTroop,
 * names a remedy for anything wrong, and emits only JSON on stdout under --json
 * so its output can be piped into a parser.
 */
describe('doctor command', () => {
  const tempDirs: string[] = []
  const previousConfigDir = process.env.LOOPTROOP_CONFIG_DIR
  const previousMode = process.env.LOOPTROOP_OPENCODE_MODE
  const previousFrontendPort = process.env.LOOPTROOP_FRONTEND_PORT

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
    if (previousFrontendPort === undefined) delete process.env.LOOPTROOP_FRONTEND_PORT
    else process.env.LOOPTROOP_FRONTEND_PORT = previousFrontendPort
  })

  function useConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-doctor-'))
    tempDirs.push(dir)
    process.env.LOOPTROOP_CONFIG_DIR = dir
    process.env.LOOPTROOP_OPENCODE_MODE = 'mock'
    writeFileSync(join(dir, 'tool-versions.json'), JSON.stringify({
      lastAttemptAt: new Date().toISOString(),
      opencodeSource: null,
      // The line the cached `node` answer is for: another one is looked up again.
      nodeLine: Number(process.versions.node.split('.')[0]),
      versions: { node: '24.0.0', npm: '11.0.0', gh: '2.75.0', git: '2.50.0' },
    }))

    const gh = join(dir, process.platform === 'win32' ? 'gh.cmd' : 'gh')
    writeFileSync(gh, process.platform === 'win32'
      ? '@echo off\r\nif "%1"=="--version" echo gh version 2.75.0 (test)\r\nif "%1"=="auth" echo Logged in to github.com account test\r\nexit /b 0\r\n'
      : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh version 2.75.0 (test)"; else echo "Logged in to github.com account test"; fi\n')
    if (process.platform !== 'win32') chmodSync(gh, 0o700)
    vi.stubEnv('PATH', `${dir}${delimiter}${process.env.PATH ?? ''}`)
    vi.stubEnv('LOOPTROOP_TRUSTED_EXECUTABLE_DIRS', dir)
    return dir
  }

  /**
   * An `opencode` the resolver will run, in `dir`. Without it a case that needs
   * a launchable CLI passes only on a machine that has OpenCode installed —
   * this one does, CI runners do not. 9.9.9 maps to no package source, so the
   * cached latest-version answer stays valid and nothing is fetched.
   */
  function fakeOpenCode(dir: string): void {
    const opencode = join(dir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode')
    writeFileSync(opencode, process.platform === 'win32'
      ? '@echo off\r\necho 9.9.9\r\nexit /b 0\r\n'
      : '#!/bin/sh\necho 9.9.9\n')
    if (process.platform !== 'win32') chmodSync(opencode, 0o700)
  }

  function captureStdout(): { text: () => string } {
    let captured = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    })
    return { text: () => captured }
  }

  it('reports attached-project ignore state and a database it cannot read', async () => {
    const configDir = useConfigDir()
    // These repeated checks exercise database state, so npm's host startup cost
    // must not decide whether the case fits its timeout.
    const npm = join(configDir, process.platform === 'win32' ? 'npm.cmd' : 'npm')
    writeFileSync(npm, process.platform === 'win32'
      ? '@echo off\r\necho 11.0.0\r\nexit /b 0\r\n'
      : '#!/bin/sh\necho 11.0.0\n')
    if (process.platform !== 'win32') chmodSync(npm, 0o700)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }))
    const [{ db, sqlite, APP_DB_PATH, closeDatabase }, { initializeDatabase }, { attachedProjects }, schemaVersion] = await Promise.all([
      import('../server/db/index'),
      import('../server/db/init'),
      import('../server/db/schema'),
      import('../server/db/schemaVersion'),
    ])
    initializeDatabase()

    try {
      const currentSchema = (await runChecks()).find((check) => check.name === 'schema')
      expect(currentSchema).toMatchObject({ status: 'ok', detail: `database schema v${schemaVersion.APP_SCHEMA_VERSION}, matching this LoopTroop` })

      sqlite.pragma(`user_version = ${schemaVersion.APP_SCHEMA_VERSION + 1}`)
      const newerSchema = (await runChecks()).find((check) => check.name === 'schema')
      expect(newerSchema).toMatchObject({
        status: 'fail',
        detail: expect.stringContaining(`version ${schemaVersion.APP_SCHEMA_VERSION + 1}`),
      })

      sqlite.pragma('user_version = 1')
      const olderSchema = (await runChecks()).find((check) => check.name === 'schema')
      expect(olderSchema).toMatchObject({
        status: 'warn',
        detail: expect.stringContaining(`will be upgraded to ${schemaVersion.APP_SCHEMA_VERSION}`),
      })

      sqlite.pragma('user_version = 0')
      const unversionedSchema = (await runChecks()).find((check) => check.name === 'schema')
      expect(unversionedSchema).toMatchObject({ status: 'warn', detail: expect.stringContaining('predates LoopTroop') })

      sqlite.pragma(`user_version = ${schemaVersion.APP_SCHEMA_VERSION}`)
      const beforeAttach = (await runChecks()).find((check) => check.name === 'project ignores')
      expect(beforeAttach).toMatchObject({ status: 'ok', detail: 'no projects attached yet' })

      db.insert(attachedProjects).values({ folderPath: configDir }).run()
      const afterAttach = (await runChecks()).find((check) => check.name === 'project ignores')
      expect(afterAttach).toMatchObject({ status: 'warn', label: 'git ignores' })
      expect(afterAttach?.detail).toContain(configDir)

      db.delete(attachedProjects).run()
      const ignoredProject = mkdtempSync(join(tmpdir(), 'looptroop-doctor-project-'))
      tempDirs.push(ignoredProject)
      execFileSync('git', ['-C', ignoredProject, 'init'], { stdio: 'pipe' })
      applyIgnoreMode(ignoredProject, 'repo')
      db.insert(attachedProjects).values({ folderPath: ignoredProject }).run()
      const ignored = (await runChecks()).find((check) => check.name === 'project ignores')
      expect(ignored).toMatchObject({ status: 'ok', label: 'git ignores' })
      expect(ignored?.detail).toContain('1 project(s)')

      closeDatabase()
      rmSync(APP_DB_PATH, { force: true })
      rmSync(`${APP_DB_PATH}-wal`, { force: true })
      rmSync(`${APP_DB_PATH}-shm`, { force: true })
      const { Database } = await import('../server/db/sqliteShim')
      const emptyDatabase = new Database(APP_DB_PATH)
      emptyDatabase.close()
      const freshSchema = (await runChecks()).find((check) => check.name === 'schema')
      expect(freshSchema).toMatchObject({ status: 'ok', detail: 'no database yet' })

      closeDatabase()
      writeFileSync(APP_DB_PATH, 'not a SQLite database')
      const unreadable = await runChecks()
      expect(unreadable.find((check) => check.name === 'schema')).toMatchObject({
        status: 'fail',
        detail: expect.stringContaining('cannot read'),
        remedy: expect.stringContaining('file permissions'),
      })
      expect(unreadable.find((check) => check.name === 'project ignores')?.detail)
        .toBe('skipped, database unreadable')
    } finally {
      closeDatabase()
    }
  })

  it('reports on the runtime, tooling, config and services', async () => {
    useConfigDir()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'))

    const checks = await runChecks()
    const names = checks.map((check) => check.name)

    expect(names).toContain('node')
    expect(names).toContain('git')
    expect(names).toContain('config dir')
    expect(names).toContain('schema')
    expect(names).toContain('opencode')
    expect(names).toContain('daemon')
    expect(checks.find((check) => check.name === 'gh auth')).toMatchObject({ status: 'ok', detail: 'authenticated' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('recognizes a development server without a registered daemon', async () => {
    useConfigDir()
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    process.env.LOOPTROOP_FRONTEND_PORT = String((server.address() as { port: number }).port)

    try {
      const check = (await runChecks()).find((entry) => entry.name === 'daemon')

      expect(check).toMatchObject({
        status: 'ok',
        detail: 'not running: a development server is serving the interface instead',
      })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }
  })

  // A start will not launch OpenCode on the port its own server is about to
  // bind, and a set address is not moved; doctor used to call that ready.
  it('fails when a set OpenCode address uses the port LoopTroop itself is set to', async () => {
    useConfigDir()
    process.env.LOOPTROOP_OPENCODE_MODE = 'real'
    const server = createServer()
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.stubEnv('LOOPTROOP_BACKEND_PORT', String(port))
    vi.stubEnv('LOOPTROOP_OPENCODE_BASE_URL', `http://127.0.0.1:${port}`)

    expect((await runChecks()).find((entry) => entry.name === 'opencode')).toMatchObject({
      status: 'fail',
      detail: `http://127.0.0.1:${port} uses port ${port}, which LoopTroop's own server is set to use, so \`looptroop start\` will fail`,
    })
  })

  // A start refuses this before it probes, so a server answering there changes
  // nothing: the daemon could not bind its own port beside it.
  it('fails that clash even when a server answers at the address', async () => {
    useConfigDir()
    process.env.LOOPTROOP_OPENCODE_MODE = 'real'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubEnv('LOOPTROOP_BACKEND_PORT', '45124')
    vi.stubEnv('LOOPTROOP_OPENCODE_BASE_URL', 'http://127.0.0.1:45124')

    expect((await runChecks()).find((entry) => entry.name === 'opencode')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('which LoopTroop\'s own server is set to use'),
    })
  })

  // `looptroop start --port 4096`: the default address moves, and doctor names
  // where to, as it does for a default address held by another server.
  it('names the port a start moves the default OpenCode address to when LoopTroop takes its port', async () => {
    const configDir = useConfigDir()
    process.env.LOOPTROOP_OPENCODE_MODE = 'real'
    fakeOpenCode(configDir)
    vi.stubEnv('LOOPTROOP_BACKEND_PORT', '4096')

    expect((await runChecks()).find((entry) => entry.name === 'opencode')).toMatchObject({
      status: 'warn',
      detail: expect.stringMatching(/^http:\/\/127\.0\.0\.1:4096 uses port 4096, which LoopTroop's own server is set to use; `looptroop start` will start its own OpenCode on the next free port \(now \d+\)$/),
    })
  })

  /**
   * What the next start would refuse before it ever looks at OpenCode's
   * address. Each case is one `startDaemon` reconciles from its previous
   * record, and doctor has to agree with it rather than promise a move.
   */
  describe('a previous LoopTroop that is still around', () => {
    /** A pid that has certainly exited, for the record of a daemon that died. */
    function departedPid(): number {
      return Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }))
    }

    function tokenOfThisProcess(): string {
      const token = readProcessStartToken(process.pid)
      expect(token, 'this platform cannot report process start times').toBeTruthy()
      return token ?? ''
    }

    /** The record a daemon leaves; this test process stands in for live pids, so nothing is signalled. */
    function recordDaemon(
      configDir: string,
      daemon: { pid: number; startToken?: string },
      opencode: { pid?: number; startToken?: string },
      extra: Partial<DaemonState> = {},
    ) {
      writeDaemonState({
        instanceId: 'previous-daemon',
        pid: daemon.pid,
        ...(daemon.startToken === undefined ? {} : { startToken: daemon.startToken }),
        host: '127.0.0.1',
        port: 1,
        startedAt: new Date().toISOString(),
        version: '0.0.0-test',
        apiToken: 'test-token',
        opencode: {
          baseUrl: 'http://127.0.0.1:4096',
          owned: true,
          status: 'managed',
          ...(opencode.pid === undefined ? {} : { pid: opencode.pid }),
          ...(opencode.startToken === undefined ? {} : { startToken: opencode.startToken }),
        },
        ...extra,
      }, configDir)
      // Its password died with the daemon, so the address answers 401 — the
      // case a start would otherwise move past.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }))
    }

    async function opencodeCheck() {
      return (await runChecks()).find((entry) => entry.name === 'opencode')
    }

    it('fails while a killed daemon\'s own OpenCode is still running, whatever answers on its port', async () => {
      const configDir = useConfigDir()
      process.env.LOOPTROOP_OPENCODE_MODE = 'real'
      recordDaemon(configDir, { pid: departedPid() }, { pid: process.pid, startToken: tokenOfThisProcess() })

      expect(await opencodeCheck()).toMatchObject({
        status: 'fail',
        detail: expect.stringContaining(`(pid ${process.pid}) is still running`),
        // `stop` ends a dead daemon's OpenCode, and it is also what a start
        // that already refused tells people to run: one command for both.
        remedy: 'Run `looptroop stop` to end it.',
      })
    })

    it('reports the leftover in mock mode too, which a start reconciles before reading the mode', async () => {
      const configDir = useConfigDir()
      recordDaemon(configDir, { pid: departedPid() }, { pid: process.pid, startToken: tokenOfThisProcess() })

      expect(await opencodeCheck()).toMatchObject({ status: 'fail', remedy: 'Run `looptroop stop` to end it.' })
    })

    it('fails for a leftover it cannot identify, which a start refuses to replace', async () => {
      const configDir = useConfigDir()
      process.env.LOOPTROOP_OPENCODE_MODE = 'real'
      // No start token: a number is not an identity.
      recordDaemon(configDir, { pid: departedPid() }, { pid: process.pid })

      expect(await opencodeCheck()).toMatchObject({
        status: 'fail',
        detail: expect.stringContaining('cannot be identified'),
        remedy: `If pid ${process.pid} is that OpenCode, end it, then run \`looptroop stop\` to clear the record. `
          + `If it is something else, delete ${getDaemonStatePath(configDir)}.`,
      })
    })

    // `stop` cannot finish a shutdown whose daemon is gone, and a start
    // refuses the record; doctor used to call that machine ready.
    it('fails for a daemon that exited before it finished shutting down, in mock mode too', async () => {
      const configDir = useConfigDir()
      recordDaemon(configDir, { pid: departedPid() }, { pid: departedPid() }, { shutdownPending: true })

      expect(await opencodeCheck()).toMatchObject({
        status: 'fail',
        detail: expect.stringContaining('exited before it finished shutting down'),
        remedy: expect.stringContaining(`then delete ${getDaemonStatePath(configDir)}.`),
      })
    })

    it.skipIf(process.platform === 'win32')('fails for a dead leader whose process group runs on, which a start refuses to replace', async () => {
      const configDir = useConfigDir()
      const pgid = await leaderlessProcessGroup()
      try {
        recordDaemon(configDir, { pid: departedPid() }, { pid: pgid, startToken: 'anything' })

        expect(await opencodeCheck()).toMatchObject({
          status: 'fail',
          detail: expect.stringContaining(`(pid ${pgid}) has exited, but processes in its process group are still running`),
          remedy: `End them (\`pgrep -g ${pgid}\` lists them), then run \`looptroop stop\` to clear the record. `
            + `If they are not LoopTroop's, delete ${getDaemonStatePath(configDir)}.`,
        })
      } finally {
        process.kill(-pgid, 'SIGKILL')
      }
    })

    it('fails for a record of its own OpenCode with no pid, which a start refuses to replace', async () => {
      const configDir = useConfigDir()
      recordDaemon(configDir, { pid: departedPid() }, {})

      expect(await opencodeCheck()).toMatchObject({
        status: 'fail',
        detail: expect.stringContaining('but not its pid'),
        remedy: 'If an OpenCode server is still running at http://127.0.0.1:4096, end it. Then run `looptroop stop` to clear the record.',
      })
    })

    it('moves past a recorded pid that now belongs to another process, as a start does', async () => {
      const configDir = useConfigDir()
      process.env.LOOPTROOP_OPENCODE_MODE = 'real'
      fakeOpenCode(configDir)
      recordDaemon(configDir, { pid: departedPid() }, { pid: process.pid, startToken: 'the-token-of-a-process-that-has-exited' })

      expect(await opencodeCheck()).toMatchObject({
        status: 'warn',
        detail: expect.stringContaining('will start its own OpenCode on the next free port'),
      })
    })

    it('calls a daemon that is alive but not answering neither stopped nor orphaned', async () => {
      const configDir = useConfigDir()
      process.env.LOOPTROOP_OPENCODE_MODE = 'real'
      // Alive with its real identity, answering nothing on the port it holds.
      vi.stubEnv('LOOPTROOP_BACKEND_PORT', '45123')
      const token = tokenOfThisProcess()
      recordDaemon(configDir, { pid: process.pid, startToken: token }, { pid: process.pid, startToken: token }, { port: 45123 })

      const checks = await runChecks()

      expect(checks.find((entry) => entry.name === 'opencode')).toMatchObject({
        status: 'warn',
        detail: `not checked: pid ${process.pid}, recorded as LoopTroop, is running but not answering`,
        remedy: 'See the daemon check.',
      })
      // `start` refuses to run beside it, so the machine cannot run LoopTroop.
      expect(checks.find((entry) => entry.name === 'daemon')).toMatchObject({
        status: 'fail',
        detail: `pid ${process.pid} is still running but not answering`,
        remedy: 'Run `looptroop stop`, then start LoopTroop again.',
      })
      // Its own port, not "another process" to be stopped by hand.
      expect(checks.find((entry) => entry.name === 'port')).toMatchObject({
        status: 'ok',
        detail: `45123 in use by this LoopTroop (pid ${process.pid})`,
      })
    })

    // `stop` will not signal a pid it cannot identify, so it cannot be the remedy.
    it('says how to get past a live daemon pid it cannot identify', async () => {
      const configDir = useConfigDir()
      recordDaemon(configDir, { pid: process.pid }, { pid: process.pid })

      expect((await runChecks()).find((entry) => entry.name === 'daemon')).toMatchObject({
        status: 'fail',
        detail: expect.stringContaining('not answering, and no start-identity token was recorded for it'),
        remedy: `If pid ${process.pid} is LoopTroop, end it, then run \`looptroop stop\`. `
          + `If it is something else, delete ${getDaemonStatePath(configDir)}.`,
      })
    })

    it('leaves a start that already recorded the leftover to the start cleanup check', async () => {
      const configDir = useConfigDir()
      process.env.LOOPTROOP_OPENCODE_MODE = 'real'
      writeDaemonStartFailure({
        reason: 'startup-cleanup-incomplete',
        at: new Date().toISOString(),
        version: '0.0.0-test',
        message: 'The previous daemon ended while its owned OpenCode server was still running.',
        openCode: { baseUrl: 'http://127.0.0.1:4096', pid: process.pid, startToken: tokenOfThisProcess() },
      }, configDir)
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }))

      const checks = await runChecks()

      expect(checks.find((entry) => entry.name === 'last start')).toMatchObject({ status: 'fail' })
      expect(checks.find((entry) => entry.name === 'opencode')).toMatchObject({
        status: 'warn',
        detail: `not checked: a previous start still owns OpenCode at http://127.0.0.1:4096 (pid ${process.pid})`,
      })
    })
  })

  it('brackets an IPv6 daemon address in its report', async () => {
    const configDir = useConfigDir()
    writeDaemonState({
      instanceId: 'ipv6-daemon',
      pid: process.pid,
      host: '::1',
      port: 3000,
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

    expect(check?.detail).toContain('http://[::1]:3000')
  })

  it('reports a free frontend port as no development server', async () => {
    useConfigDir()
    process.env.LOOPTROOP_FRONTEND_PORT = String(await reservePort())

    const check = (await runChecks()).find((entry) => entry.name === 'daemon')

    expect(check).toMatchObject({ status: 'ok', detail: 'not running' })
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
      latestVersion: '99.99.99',
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
    expect(stdout.text()).toContain(`${APP_VERSION} (latest 99.99.99)`)
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

    const stdout = captureStdout()
    await doctorCommand(true)
    const { checks } = JSON.parse(stdout.text()) as { checks: Awaited<ReturnType<typeof runChecks>> }
    const cli = checks.find((check) => check.name === 'opencode cli')

    expect(cli?.detail).toBe('2.0.15 (latest 2.0.16)')
    expect(cli?.note).toBe(`Resolved executable: ${join(binDir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode')}`)
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

    it('reports when startup could not prove its OpenCode process was stopped', async () => {
      const configDir = useConfigDir()
      writeDaemonStartFailure({
        reason: 'startup-cleanup-incomplete',
        at: '2026-01-02T03:04:05.000Z',
        version: '0.0.0-test',
        message: 'OpenCode cleanup was not confirmed.',
        openCode: { baseUrl: 'http://127.0.0.1:4096', pid: 12345 },
      }, configDir)

      const check = (await runChecks()).find((entry) => entry.name === 'last start')

      expect(check).toMatchObject({
        name: 'last start',
        label: 'start cleanup',
        status: 'fail',
        detail: expect.stringContaining('http://127.0.0.1:4096 (pid 12345) was not proven stopped'),
        remedy: 'Run `looptroop stop` to retry the owned cleanup before starting again.',
      })
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

    // A start waits for a booting server and adopts it, which needs no CLI.
    // The `opencode cli` line still says the binary is missing.
    it('only warns about a server still booting, with or without a CLI', () => {
      const check = judgeOpenCode({ kind: 'responded', status: 503 }, { baseUrl, daemon: null, cliAvailable: false })

      expect(check.status).toBe('warn')
      expect(check.detail).toContain('still responding')
    })

    it('reports a reachable server as healthy whoever started it', () => {
      expect(judgeOpenCode({ kind: 'ok' }, { baseUrl, daemon: null, cliAvailable: false }).status).toBe('ok')
    })

    /**
     * The default address held by a server LoopTroop cannot use. A start
     * leaves it alone and takes the next free port, so before a start it is
     * not a failure — it was the one this report called fatal on a machine
     * whose only problem was a hand-started OpenCode v2 with its own password.
     */
    describe('a default address held by a server LoopTroop cannot use', () => {
      const NOT_CONFIGURED = 'OpenCode requires a password, and none is configured (HTTP 401).'

      it('only warns when a start would move past it', () => {
        for (const failureKind of ['authentication', 'unsupported_protocol'] as const) {
          const check = judgeOpenCode(
            { kind: 'failed', failureKind, error: NOT_CONFIGURED, status: 401 },
            { baseUrl, daemon: null, cliAvailable: true, movable: true },
          )

          expect(check.status).toBe('warn')
          expect(check.detail).toBe(`${baseUrl} is used by another server that LoopTroop cannot use: ${NOT_CONFIGURED} `
            + '`looptroop start` will start its own OpenCode on the next free port.')
        }
      })

      it('names the port a start would take, and fails when there is none', () => {
        const failed = { kind: 'failed', failureKind: 'authentication', error: NOT_CONFIGURED, status: 401 } as const

        expect(judgeOpenCode(failed, { baseUrl, daemon: null, cliAvailable: true, movable: true, nextFreePort: 4097 }).detail)
          .toContain('will start its own OpenCode on the next free port (now 4097).')
        expect(judgeOpenCode(failed, { baseUrl, daemon: null, cliAvailable: true, movable: true, nextFreePort: null }))
          .toMatchObject({ status: 'fail', remedy: 'Stop that server, or set LOOPTROOP_OPENCODE_BASE_URL to a free address.' })
      })

      it('fails when no OpenCode could be started next to it', () => {
        const check = judgeOpenCode(
          { kind: 'failed', failureKind: 'authentication', error: NOT_CONFIGURED, status: 401 },
          { baseUrl, daemon: null, cliAvailable: false, movable: true },
        )

        expect(check.status).toBe('fail')
        expect(check.remedy).toContain('opencode.ai')
      })

      it('fails, and says what to change, when the user set that address', () => {
        const check = judgeOpenCode(
          { kind: 'failed', failureKind: 'authentication', error: NOT_CONFIGURED, status: 401 },
          { baseUrl, daemon: null, cliAvailable: true, movable: false },
        )

        expect(check.status).toBe('fail')
        expect(check.remedy).toContain('Set OPENCODE_PASSWORD to that server\'s password')
        expect(check.remedy).toContain('remove LOOPTROOP_OPENCODE_BASE_URL')
      })

      it('does not offer a move to a daemon that is already running', () => {
        const check = judgeOpenCode(
          { kind: 'failed', failureKind: 'authentication', error: NOT_CONFIGURED, status: 401 },
          { baseUrl, daemon: daemonWith({ baseUrl, owned: false, status: 'adopted' }), cliAvailable: true, movable: true },
        )

        expect(check.status).toBe('fail')
        expect(check.remedy).not.toContain('LOOPTROOP_OPENCODE_BASE_URL')
      })

      it('says where the running server went instead', () => {
        const movedTo = 'http://127.0.0.1:4098'
        const check = judgeOpenCode(
          { kind: 'ok', protocol: 'v2', version: '2.0.22', url: movedTo },
          {
            baseUrl,
            daemon: daemonWith({
              baseUrl: movedTo,
              owned: true,
              status: 'managed',
              pid: 4242,
              movedFrom: { baseUrl, reason: NOT_CONFIGURED },
            }),
            cliAvailable: true,
            movable: true,
          },
        )

        expect(check).toMatchObject({
          status: 'ok',
          detail: `reachable at ${movedTo} (v2, 2.0.22). ${baseUrl} could not be used when LoopTroop started: `
            + NOT_CONFIGURED,
        })
      })
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

    it('reports the selected OpenCode shim and its failure instead of telling the user to install it', async () => {
      const root = useConfigDir()
      const program = join(root, process.platform === 'win32' ? 'opencode.cmd' : 'opencode')
      writeFileSync(program, process.platform === 'win32'
        ? '@echo off\r\necho Error: OpenCode postinstall did not run. 1>&2\r\necho More installation details. 1>&2\r\nexit /b 1\r\n'
        : '#!/bin/sh\nprintf "Error: OpenCode postinstall did not run.\\nMore installation details.\\n" >&2\nexit 1\n')
      if (process.platform !== 'win32') chmodSync(program, 0o700)
      vi.stubEnv('LOOPTROOP_OPENCODE_MODE', 'real')
      vi.stubEnv('LOOPTROOP_OPENCODE_BASE_URL', 'http://127.0.0.1:1')
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'))

      expect(runProbe('opencode', ['--version'], 5_000)).toEqual({
        kind: 'unavailable', path: program,
        failure: 'exited with code 1: Error: OpenCode postinstall did not run.',
      })
      const stdout = captureStdout()
      await doctorCommand(true)
      const { checks } = JSON.parse(stdout.text()) as { checks: Awaited<ReturnType<typeof runChecks>> }
      const cli = checks.find((check) => check.name === 'opencode cli')
      expect(cli).toMatchObject({
        status: 'warn', missing: true,
        detail: `${program}: exited with code 1: Error: OpenCode postinstall did not run.`,
      })
      expect(cli?.remedy).toContain('Repair this OpenCode installation')
      expect(cli?.remedy).not.toContain('Install it from')
    })

    it('reports missing tools when no executables resolve from PATH', async () => {
      const root = mkdtempSync(join(tmpdir(), 'looptroop-doctor-empty-path-'))
      tempDirs.push(root)
      const emptyBinDir = join(root, 'bin')
      const configDir = join(root, 'config')
      vi.stubEnv('PATH', emptyBinDir)
      vi.stubEnv('HOME', root)
      vi.stubEnv('USERPROFILE', root)
      vi.stubEnv('OPENCODE_INSTALL_DIR', '')
      vi.stubEnv('OPENCODE_DIR', '')
      vi.stubEnv('LOOPTROOP_TRUSTED_EXECUTABLE_DIRS', emptyBinDir)
      vi.stubEnv('LOOPTROOP_CONFIG_DIR', configDir)
      vi.stubEnv('LOOPTROOP_OPENCODE_MODE', 'real')
      vi.stubEnv('LOOPTROOP_OPENCODE_BASE_URL', 'http://127.0.0.1:1')
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'))

      const checks = await runChecks()
      const check = (name: string) => checks.find((entry) => entry.name === name)

      expect(check('npm')).toMatchObject({ status: 'warn', missing: true })
      expect(check('git')).toMatchObject({ status: 'fail', missing: true })
      expect(check('git')?.remedy).toMatch(/install/i)
      expect(check('gh')).toMatchObject({ status: 'warn', missing: true })
      expect(check('gh auth')).toMatchObject({ status: 'warn' })
      expect(check('config dir')).toMatchObject({ name: 'config dir', status: 'ok', detail: configDir })
      expect(check('opencode cli')).toMatchObject({ status: 'warn', missing: true })
      expect(check('opencode')).toMatchObject({ status: 'fail' })
    })

    it('says an absent optional tool is optional, and names only what blocks', async () => {
      const root = mkdtempSync(join(tmpdir(), 'looptroop-doctor-empty-path-'))
      tempDirs.push(root)
      const emptyBinDir = join(root, 'bin')
      vi.stubEnv('PATH', emptyBinDir)
      vi.stubEnv('HOME', root)
      vi.stubEnv('USERPROFILE', root)
      vi.stubEnv('OPENCODE_INSTALL_DIR', '')
      vi.stubEnv('OPENCODE_DIR', '')
      vi.stubEnv('LOOPTROOP_TRUSTED_EXECUTABLE_DIRS', emptyBinDir)
      vi.stubEnv('LOOPTROOP_CONFIG_DIR', join(root, 'config'))
      vi.stubEnv('LOOPTROOP_OPENCODE_MODE', 'real')
      vi.stubEnv('LOOPTROOP_OPENCODE_BASE_URL', 'http://127.0.0.1:1')
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'))
      const failing = (await runChecks()).filter((entry) => entry.status === 'fail').map((entry) => entry.label ?? entry.name)
      const stdout = captureStdout()

      expect(await doctorCommand(false)).toBe(1)
      const lines = stdout.text().split('\n')
      const gh = lines.findIndex((line) => /^✗ gh\s/.test(line))
      // A ticket's pre-flight check needs it before coding starts, so "only
      // for pull requests" was wrong.
      expect(lines[gh + 1]).toBe('  ↳ Optional to start LoopTroop, but a ticket needs it before coding starts.')
      // Every absent tool is marked ✗, so the verdict names the ones that block.
      expect(failing).toContain('git')
      expect(failing).not.toContain('gh')
      expect(lines).toContain(`LoopTroop cannot run until these are fixed: ${failing.join(', ')}.`)
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
