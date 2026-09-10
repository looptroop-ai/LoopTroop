import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
const resolveTrustedProgram = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync }
})

// Resolution is stubbed so these cases describe the *probe*, not this machine's
// tool layout: a Linux runner has no `npm.cmd` to find, and a real resolution
// would decide the branch under test.
vi.mock('../server/lib/executablePath', () => ({ resolveTrustedProgram }))

/** An npm-installed shim: what Node refuses to launch directly. */
const NPM_SHIM = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\npm.cmd'
/** A real program, which needs no interpreter on any platform. */
const GH_EXE = 'C:\\Program Files\\GitHub CLI\\gh.exe'

const { runProbe } = await import('../server/cli/doctorCommand')

/**
 * A doctor probe resolves the tool's name to a file and then decides how to
 * launch it, and the second half is not cosmetic: `npm` is `npm.cmd` on
 * Windows, and Node has refused to launch a `.cmd` directly since the BatBadBut
 * hardening. Without cmd.exe for that one case, `doctor` told users npm was
 * missing on machines where `npm --version` answered instantly — and would have
 * said the same about an OpenCode installed from npm. What changed with the
 * trusted-path work is that the shell is no longer used to *find* the tool, so
 * it is now applied to the shim alone and handed the resolved path.
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
    execFileSync.mockReset()
    execFileSync.mockReturnValue('11.12.1\n')
    resolveTrustedProgram.mockReset()
    resolveTrustedProgram.mockImplementation((command: string) => {
      if (command === 'npm') return { path: NPM_SHIM }
      if (command === 'gh') return { path: GH_EXE }
      return { path: command }
    })
  })

  it('runs a resolved command script through a shell, by path', () => {
    const result = withPlatform('win32', () => runProbe('npm', ['--version'], 5_000))

    expect(result).toEqual({ kind: 'ok', output: '11.12.1\n' })
    // The *path*, quoted — not the name. cmd.exe searches PATH for a name, so
    // handing it one would have put the choice of file back where this work
    // took it from.
    expect(execFileSync).toHaveBeenCalledWith(
      `"${NPM_SHIM}" --version`,
      [],
      expect.objectContaining({ shell: true }),
    )
  })

  it('reports a tool the resolver refuses as unavailable', () => {
    // The same answer `doctor` already gives for a tool that is not installed,
    // which is what the report has to keep saying: nothing here becomes fatal.
    resolveTrustedProgram.mockReturnValue({ reason: 'npm resolves to /tmp/npm, in a directory this daemon does not trust' })

    expect(withPlatform('win32', () => runProbe('npm', ['--version'], 5_000))).toEqual({ kind: 'unavailable' })
    expect(execFileSync).not.toHaveBeenCalled()
  })

  /**
   * The command line is joined here rather than handed to Node as an array.
   * Node joins the two itself and, since DEP0190 (Node 22), prints a
   * DeprecationWarning for doing so — which arrived on stderr above the report
   * on every Windows `doctor` run, making the diagnostic command look like the
   * thing with the problem. The joined line is byte-for-byte what Node
   * would have built, and safe for the same reason it always was: every
   * argument here is a literal.
   */
  it('passes no argument array under the shell, so Node does not warn', () => {
    resolveTrustedProgram.mockReturnValue({ path: NPM_SHIM })
    withPlatform('win32', () => runProbe('npm', ['auth', 'status'], 5_000))

    const [file, args] = execFileSync.mock.calls[0] as [string, string[]]
    expect(file).toBe(`"${NPM_SHIM}" auth status`)
    expect(args).toEqual([])
  })

  it('spawns a resolved program directly, even on Windows', () => {
    // The shell is only for what Node cannot launch. A real program needs none
    // of it, and cmd.exe would re-parse the arguments — where a `>` in a value
    // is a redirection and `()` are syntax.
    withPlatform('win32', () => runProbe('gh', ['auth', 'status'], 5_000))

    expect(execFileSync).toHaveBeenCalledWith(
      GH_EXE,
      ['auth', 'status'],
      expect.objectContaining({ shell: false }),
    )
  })

  it('leaves every other platform spawning directly', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      execFileSync.mockClear()
      resolveTrustedProgram.mockReturnValue({ path: '/usr/bin/npm' })
      withPlatform(platform, () => runProbe('npm', ['--version'], 5_000))

      expect(execFileSync).toHaveBeenCalledWith(
        '/usr/bin/npm',
        ['--version'],
        expect.objectContaining({ shell: false }),
      )
    }
  })

  it('still calls a command missing under the shell unavailable', () => {
    // cmd.exe starts fine for a command that does not exist and exits 9009 with
    // "is not recognized", so the missing case arrives as a non-zero exit rather
    // than as the ENOENT this used to rely on.
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), { status: 9009 })
    })

    const result = withPlatform('win32', () => runProbe('npm', ['--version'], 5_000))
    expect(result).toEqual({ kind: 'unavailable' })
  })

  it('still tells a command that hung apart from one that is missing', () => {
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('Command timed out'), { code: 'ETIMEDOUT' })
    })

    const result = withPlatform('win32', () => runProbe('gh', ['auth', 'status'], 5_000))
    expect(result).toEqual({ kind: 'timed-out' })
  })

  /**
   * Under a shell the deadline does not arrive as `ETIMEDOUT`: it kills cmd.exe,
   * and what surfaces is an ordinary non-zero exit from the wrapper — the same
   * shape a missing command produces. Recognising the deadline by how long the
   * call took is what keeps the two apart, and getting this wrong reported every
   * hung probe on Windows as a missing one, sending people to install `gh` when
   * their `gh auth status` was stuck on a black-holed proxy.
   */
  it('recognises the deadline even when the shell swallows ETIMEDOUT', () => {
    execFileSync.mockImplementation(() => {
      const started = Date.now()
      while (Date.now() - started < 60) { /* spin past the deadline */ }
      throw Object.assign(new Error('Command failed'), { status: 1 })
    })

    const result = withPlatform('win32', () => runProbe('gh', ['auth', 'status'], 50))
    expect(result).toEqual({ kind: 'timed-out' })
  })
})
