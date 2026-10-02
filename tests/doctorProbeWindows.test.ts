import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDaemonState } from '../server/lib/daemonPaths'

const spawnSync = vi.hoisted(() => vi.fn())
const resolveTrustedProgram = vi.hoisted(() => vi.fn())
const resolveInterpreter = vi.hoisted(() => vi.fn())
const probeOpenCodeConnection = vi.hoisted(() => vi.fn())
const probePort = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync }
})

// Resolution is stubbed so these cases describe the *probe*, not this machine's
// tool layout: a Linux runner has no `npm.cmd` to find, and a real resolution
// would decide the branch under test. The launcher itself is the real one; only
// the cmd.exe it would resolve is supplied, because a Linux runner has none.
vi.mock('../server/lib/executablePath', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/lib/executablePath')>()
  return {
    ...actual,
    resolveTrustedProgram,
    planProgramLaunch: (program: string, args: readonly string[], options: import('../server/lib/executablePath').ProgramLaunchOptions = {}) =>
      actual.planProgramLaunch(program, args, { ...options, resolveInterpreter }),
  }
})

vi.mock('../server/opencode/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/opencode/connection')>()
  return { ...actual, probeOpenCodeConnection }
})

vi.mock('../server/lib/portProbe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/lib/portProbe')>()
  return { ...actual, probePort }
})

/** An npm-installed shim: what Node refuses to launch directly. */
const NPM_SHIM = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\npm.cmd'
/** A real program, which needs no interpreter on any platform. */
const GH_EXE = 'C:\\Program Files\\GitHub CLI\\gh.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'

const { runProbe, runChecks } = await import('../server/cli/doctorCommand')
const { OpenCodeConnectionError } = await import('../server/opencode/connection')

/**
 * A doctor probe resolves the tool's name to a file and then decides how to
 * launch it, and the second half is not cosmetic: `npm` is `npm.cmd` on
 * Windows, and Node has refused to launch a `.cmd` directly since the BatBadBut
 * hardening. Without cmd.exe for that one case, `doctor` told users npm was
 * missing on machines where `npm --version` answered instantly — and would have
 * said the same about an OpenCode installed from npm. cmd.exe is applied to the
 * shim alone, is itself resolved rather than looked up by `shell: true`, and is
 * handed the resolved path.
 *
 * The spawn and the resolution are both mocked because this has to be asserted
 * from Linux CI, where the Windows branch can otherwise never run.
 */
describe('probing external commands on Windows', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    try {
      return run()
    } finally {
      if (original) Object.defineProperty(process, 'platform', original)
    }
  }

  beforeEach(() => {
    spawnSync.mockReset()
    spawnSync.mockReturnValue({ status: 0, signal: null, stdout: '11.12.1\n', stderr: '', output: [], pid: 1 })
    resolveInterpreter.mockReset()
    resolveInterpreter.mockReturnValue({ path: CMD })
    probeOpenCodeConnection.mockReset()
    probePort.mockReset().mockResolvedValue({ kind: 'free' })
    resolveTrustedProgram.mockReset()
    resolveTrustedProgram.mockImplementation((command: string) => {
      if (command === 'npm') return { path: NPM_SHIM }
      if (command === 'gh') return { path: GH_EXE }
      return { path: command }
    })
  })

  it('runs a resolved command script through a resolved cmd.exe, by path', () => {
    const result = withPlatform('win32', () => runProbe('npm', ['--version'], 5_000))

    expect(result).toEqual({ kind: 'ok', output: '11.12.1\n' })
    // The *path*, not the name — cmd.exe searches PATH for a name — with the
    // path and every argument escaped for cmd.exe, and Node told not to quote
    // the line again.
    expect(spawnSync).toHaveBeenCalledWith(
      CMD,
      ['/d', '/v:off', '/s', '/c', '"C:\\Users\\dev\\AppData\\Roaming\\npm\\npm.cmd --version"'],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    )
  })

  it('reports a tool the resolver refuses as unavailable', () => {
    // The same answer `doctor` already gives for a tool that is not installed,
    // which is what the report has to keep saying: nothing here becomes fatal.
    resolveTrustedProgram.mockReturnValue({ reason: 'npm was not found in any trusted directory on PATH.' })

    expect(withPlatform('win32', () => runProbe('npm', ['--version'], 5_000))).toEqual({ kind: 'unavailable' })
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it('carries the reason for a refused tool, so the report does not tell you to install it', () => {
    // Found and refused is not "not found on PATH": the tool is installed, and
    // the install hint that used to follow was advice to reinstall it.
    const reason = 'npm resolves to /srv/tools/npm, which this daemon will not run: its directory is owned by uid 4242.'
    resolveTrustedProgram.mockReturnValue({ reason, refusedAt: '/srv/tools/npm' })

    expect(withPlatform('linux', () => runProbe('npm', ['--version'], 5_000))).toEqual({ kind: 'unavailable', refusal: reason })
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it('says why when cmd.exe itself cannot be used, and starts nothing', () => {
    resolveInterpreter.mockReturnValue({ reason: 'cmd.exe was not found in any trusted directory on PATH.' })

    const result = withPlatform('win32', () => runProbe('npm', ['--version'], 5_000))
    expect(result.kind).toBe('unavailable')
    expect(result.kind === 'unavailable' && result.refusal).toContain('needs cmd.exe to run')
    expect(spawnSync).not.toHaveBeenCalled()
  })

  /**
   * No `shell` option at all. Node joins an argument array under a shell and,
   * since DEP0190 (Node 22), prints a DeprecationWarning for doing so — which
   * arrived on stderr above the report on every Windows `doctor` run — and a
   * shell is found by name, which is the lookup the launcher replaces.
   */
  it('passes no shell option, so Node neither warns nor looks cmd.exe up', () => {
    resolveTrustedProgram.mockReturnValue({ path: NPM_SHIM })
    withPlatform('win32', () => runProbe('npm', ['auth', 'status'], 5_000))

    const [file, , options] = spawnSync.mock.calls[0] as [string, string[], { shell?: unknown }]
    expect(file).toBe(CMD)
    expect(options.shell).toBeUndefined()
  })

  it('spawns a resolved program directly, even on Windows', () => {
    // cmd.exe is only for what Node cannot launch. A real program needs none
    // of it, and cmd.exe would re-parse the arguments.
    withPlatform('win32', () => runProbe('gh', ['auth', 'status'], 5_000))

    expect(spawnSync).toHaveBeenCalledWith(
      GH_EXE,
      ['auth', 'status'],
      expect.objectContaining({ windowsVerbatimArguments: false }),
    )
    expect(resolveInterpreter).not.toHaveBeenCalled()
  })

  it('leaves every other platform spawning directly, whatever the file is called', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      spawnSync.mockClear()
      resolveTrustedProgram.mockReturnValue({ path: '/usr/local/bin/npm.cmd' })
      withPlatform(platform, () => runProbe('npm', ['--version'], 5_000))

      expect(spawnSync).toHaveBeenCalledWith(
        '/usr/local/bin/npm.cmd',
        ['--version'],
        expect.objectContaining({ windowsVerbatimArguments: false }),
      )
    }
  })

  it('still calls a command missing behind cmd.exe unavailable', () => {
    // cmd.exe starts fine for a shim whose target is gone and exits 9009 with
    // "is not recognized", so the missing case arrives as a non-zero exit rather
    // than as ENOENT.
    spawnSync.mockReturnValue({ status: 9009, signal: null, stdout: '', stderr: '', output: [], pid: 1 })

    const result = withPlatform('win32', () => runProbe('npm', ['--version'], 5_000))
    expect(result).toEqual({ kind: 'unavailable' })
  })

  it('still tells a command that hung apart from one that is missing', () => {
    spawnSync.mockReturnValue({
      status: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
      output: [],
      pid: 1,
      error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    })

    const result = withPlatform('win32', () => runProbe('gh', ['auth', 'status'], 5_000))
    expect(result).toEqual({ kind: 'timed-out' })
  })

  /**
   * Through cmd.exe the deadline does not arrive as `ETIMEDOUT`: it kills
   * cmd.exe, and what surfaces is an ordinary non-zero exit from the wrapper —
   * the same shape a missing command produces. Recognising the deadline by how
   * long the call took is what keeps the two apart, and getting this wrong
   * reported every hung probe on Windows as a missing one, sending people to
   * install `gh` when their `gh auth status` was stuck on a black-holed proxy.
   */
  it('recognises the deadline even when cmd.exe swallows ETIMEDOUT', () => {
    spawnSync.mockImplementation(() => {
      const started = Date.now()
      while (Date.now() - started < 60) { /* spin past the deadline */ }
      return { status: 1, signal: null, stdout: '', stderr: '', output: [], pid: 1 }
    })

    const result = withPlatform('win32', () => runProbe('gh', ['auth', 'status'], 50))
    expect(result).toEqual({ kind: 'timed-out' })
  })

  it('reports timeout and trust refusal outcomes through stable doctor checks', async () => {
    vi.stubEnv('LOOPTROOP_OPENCODE_MODE', 'real')
    vi.stubEnv('LOOPTROOP_OPENCODE_BASE_URL', 'http://127.0.0.1:4096')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'))
    probeOpenCodeConnection.mockRejectedValue(new Error('offline'))
    spawnSync.mockReturnValue({
      status: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
      output: [],
      pid: 1,
      error: Object.assign(new Error('probe timed out'), { code: 'ETIMEDOUT' }),
    })
    const refusal = 'git resolves outside the trusted executable directories.'
    resolveTrustedProgram.mockImplementation((command: string) => {
      if (command === 'npm') return { path: NPM_SHIM }
      if (command === 'gh') return { path: GH_EXE }
      if (command === 'git') return { reason: refusal, refusedAt: '/untrusted/git' }
      return { path: command }
    })

    const checks = await runChecks()
    const check = (name: string) => checks.find(entry => entry.name === name)

    expect(check('npm')).toMatchObject({
      name: 'npm',
      status: 'warn',
      detail: '`npm --version` did not answer within 5s',
    })
    expect(check('git')).toMatchObject({
      name: 'git',
      status: 'fail',
      missing: true,
      detail: refusal,
      remedy: expect.stringContaining('LOOPTROOP_TRUSTED_EXECUTABLE_DIRS'),
    })
    expect(check('gh')).toMatchObject({
      name: 'gh',
      status: 'warn',
      detail: '`gh --version` did not answer within 5s',
    })
    expect(check('gh auth')).toMatchObject({
      name: 'gh auth',
      status: 'warn',
      detail: '`gh auth status` did not answer within 10s',
    })
    expect(check('opencode cli')).toMatchObject({
      name: 'opencode cli',
      status: 'warn',
      detail: '`opencode --version` did not answer within 5s',
    })
    expect(check('opencode')?.detail).toContain('offline')
  })

  it('preserves a typed OpenCode config authentication failure', async () => {
    vi.stubEnv('LOOPTROOP_OPENCODE_MODE', 'real')
    // Set by the user: the default address would be moved past instead.
    vi.stubEnv('LOOPTROOP_OPENCODE_BASE_URL', 'http://127.0.0.1:4096')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }))
    probeOpenCodeConnection.mockRejectedValue(new OpenCodeConnectionError(
      'authentication',
      'credentials were rejected',
      401,
    ))

    const check = (await runChecks()).find(entry => entry.name === 'opencode')

    expect(check).toMatchObject({
      name: 'opencode',
      status: 'fail',
      detail: 'authentication: credentials were rejected',
      remedy: 'Set OPENCODE_PASSWORD to that server\'s password (and OPENCODE_SERVER_USERNAME if a v1 server\'s user is not `opencode`). '
        + 'Or remove LOOPTROOP_OPENCODE_BASE_URL (or opencodeBaseUrl in config.json) so LoopTroop starts its own OpenCode.',
    })
  })

  it.each([
    ['refused', new OpenCodeConnectionError('network', 'Could not reach the OpenCode server.', undefined, true), 'warn', 'will launch one'],
    // Accepted the connection and never answered: the supervisor fails that start.
    ['silent', new OpenCodeConnectionError('network', 'Could not reach the OpenCode server.', undefined, false), 'fail', 'network: Could not reach'],
    ['timed out', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'fail', 'Nothing answered within 2 seconds.'],
    // Still booting: the supervisor waits for it.
    ['booting', new OpenCodeConnectionError('network', 'OpenCode v2 info probe failed (HTTP 503).', 503), 'warn', 'responded 503'],
  ] as const)('promises a launch only for a refused connection (%s)', async (_label, error, status, detail) => {
    vi.stubEnv('LOOPTROOP_OPENCODE_MODE', 'real')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }))
    probeOpenCodeConnection.mockRejectedValue(error)

    const check = (await runChecks()).find(entry => entry.name === 'opencode')

    expect(check).toMatchObject({ name: 'opencode', status })
    expect(check?.detail).toContain(detail)
  })

  it('warns, rather than fails, when the default OpenCode address is held by a server LoopTroop cannot use', async () => {
    vi.stubEnv('LOOPTROOP_OPENCODE_MODE', 'real')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }))
    probeOpenCodeConnection.mockRejectedValue(new OpenCodeConnectionError(
      'authentication',
      'OpenCode requires a password, and none is configured (HTTP 401).',
      401,
    ))

    const check = (await runChecks()).find(entry => entry.name === 'opencode')

    // The smokes read this check before `start` and accept `ok` or `warn` only.
    expect(check).toMatchObject({ name: 'opencode', status: 'warn' })
    expect(check?.detail).toContain('will start its own OpenCode on the next free port')
  })

  it.each([
    ['darwin', 'brew install git'],
    ['win32', 'winget install git'],
  ] as const)('uses the %s package-manager hint for a missing tool', async (platform, remedy) => {
    vi.stubEnv('PATH', '')
    vi.stubEnv('LOOPTROOP_TRUSTED_EXECUTABLE_DIRS', '')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }))
    resolveTrustedProgram.mockReturnValue({ reason: 'git was not found in any trusted directory on PATH.' })
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })

    try {
      const check = (await runChecks()).find(entry => entry.name === 'git')

      expect(check).toMatchObject({ name: 'git', status: 'fail', missing: true, remedy })
    } finally {
      if (original) Object.defineProperty(process, 'platform', original)
    }
  })

  it('reports an uncheckable port as a warning', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }))
    probePort.mockResolvedValue({ kind: 'error', message: 'permission denied' })
    resolveTrustedProgram.mockReturnValue({ reason: 'tool is missing' })

    const check = (await runChecks()).find(entry => entry.name === 'port')

    expect(check).toMatchObject({
      name: 'port',
      status: 'warn',
      detail: '3000 could not be checked: permission denied',
      remedy: 'Check the local firewall or privilege rules for this port.',
    })
  })

  it.each([
    ['non-object health response', { kind: 'json', value: [] }, 'responded 200 at'],
    ['starting health response', { kind: 'json', value: { status: 'starting', error: 'still warming up' } }, 'network: still warming up'],
    ['disconnected health response', { kind: 'reject' }, 'offline; not reachable at'],
  ] as const)('reports a daemon with a %s OpenCode health check', async (_caseName, result, expectedDetail) => {
    const configDir = mkdtempSync(join(tmpdir(), 'looptroop-doctor-daemon-'))
    tempDirs.push(configDir)
    vi.stubEnv('LOOPTROOP_CONFIG_DIR', configDir)
    vi.stubEnv('LOOPTROOP_OPENCODE_MODE', 'real')
    vi.stubEnv('LOOPTROOP_OPENCODE_BASE_URL', 'http://127.0.0.1:4096')
    const daemon = {
      instanceId: 'doctor-probe-daemon',
      pid: process.pid,
      port: 3000,
      host: '127.0.0.1',
      startedAt: '2026-01-02T03:04:05.000Z',
      version: '0.0.0-test',
      apiToken: 'doctor-token',
      opencode: { baseUrl: 'http://127.0.0.1:4096', owned: false, status: 'adopted' as const },
    }
    writeDaemonState(daemon, configDir)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({ instanceId: daemon.instanceId }), { status: 200 })
      }
      if (url.endsWith('/api/health/opencode')) {
        if (result.kind === 'reject') throw new TypeError('offline')
        return new Response(JSON.stringify(result.value), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })

    const check = (await runChecks()).find(entry => entry.name === 'opencode')

    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain(expectedDetail)
  })
})
