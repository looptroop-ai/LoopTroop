import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync }
})

const { runProbe } = await import('../server/cli/doctorCommand')

/**
 * Doctor probes have to go through a shell on Windows, and the reason is not
 * cosmetic: `npm` is `npm.cmd` there, `CreateProcess` appends only `.exe` and
 * never reads `PATHEXT`, and Node has refused to launch `.cmd` files directly
 * since the BatBadBut hardening. Without a shell, `doctor` told users npm was
 * missing on machines where `npm --version` answered instantly — and would have
 * said the same about an OpenCode installed from npm.
 *
 * The spawn is mocked because this has to be asserted from Linux CI, where the
 * Windows branch can otherwise never run.
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
  })

  it('runs the probe through a shell on Windows', () => {
    const result = withPlatform('win32', () => runProbe('npm', ['--version'], 5_000))

    expect(result).toEqual({ kind: 'ok', output: '11.12.1\n' })
    expect(execFileSync).toHaveBeenCalledWith(
      'npm',
      ['--version'],
      expect.objectContaining({ shell: true }),
    )
  })

  it('leaves every other platform spawning directly', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      execFileSync.mockClear()
      withPlatform(platform, () => runProbe('npm', ['--version'], 5_000))

      expect(execFileSync).toHaveBeenCalledWith(
        'npm',
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
