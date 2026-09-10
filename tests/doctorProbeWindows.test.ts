import { describe, it, expect, vi, beforeEach } from 'vitest'

const spawnSync = vi.hoisted(() => vi.fn())
const resolveTrustedProgram = vi.hoisted(() => vi.fn())
const resolveInterpreter = vi.hoisted(() => vi.fn())

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

/** An npm-installed shim: what Node refuses to launch directly. */
const NPM_SHIM = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\npm.cmd'
/** A real program, which needs no interpreter on any platform. */
const GH_EXE = 'C:\\Program Files\\GitHub CLI\\gh.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'

const { runProbe } = await import('../server/cli/doctorCommand')

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
      ['/d', '/s', '/c', '"C:\\Users\\dev\\AppData\\Roaming\\npm\\npm.cmd ^"--version^""'],
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
})
