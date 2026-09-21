import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
vi.mock('../scripts/trusted-tool.ts', () => ({ resolveTrustedTool: (command: string) => ({ path: command }) }))

const token = 'winget-test-secret'
const credential = Buffer.from(`x-access-token:${token}`).toString('base64')
const originalArgv = process.argv

afterEach(() => {
  process.argv = originalArgv
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.resetModules()
})

/**
 * A run where every command succeeds.
 *
 * `differs` is what `git diff --quiet` reports, and it decides which path the
 * script takes: a non-zero exit means the manifests are not already there,
 * which is the ordinary submission. Defaulting it to "everything succeeds"
 * silently turned every test into the already-published no-op.
 */
function prepare({ differs = true }: { differs?: boolean } = {}) {
  vi.stubEnv('WINGET_TOKEN', token)
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  process.argv = ['node', 'winget-submit.ts', '--version', '9.9.9', '--url', 'https://example.invalid/package.zip', '--sha256', 'a'.repeat(64)]
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.mocked(execFileSync).mockImplementation((command, args) => {
    if (command === 'gh' && args?.[1] === 'list') return '[]'
    if (differs && command === 'git' && args?.[0] === 'diff') {
      throw Object.assign(new Error('exit 1'), { status: 1, stderr: '' })
    }
    return ''
  })
}

describe('WinGet submission credentials', () => {
  it('keeps clone URLs and every argument credential-free while authenticating git through its environment', async () => {
    prepare()
    await import('../scripts/winget-submit.ts')

    const calls = vi.mocked(execFileSync).mock.calls
    const gitCalls = calls.filter(([command]) => command === 'git')
    expect(gitCalls.find(([, args]) => args?.[0] === 'clone')?.[1]).toContain('https://github.com/looptroop-ai/winget-pkgs.git')
    expect(gitCalls.some(([, args]) => args?.[0] === 'push')).toBe(true)
    for (const [command, args, options] of calls) {
      expect(JSON.stringify(args)).not.toContain(token)
      expect(JSON.stringify(args)).not.toContain(credential)
      if (command === 'gh') {
        expect(options?.env?.GH_TOKEN).toBe(token)
      } else {
        expect(options?.env?.GH_TOKEN).toBeUndefined()
        expect(options?.env?.GITHUB_TOKEN).toBeUndefined()
      }
      if (command === 'git') {
        expect(options?.env).toMatchObject({
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/looptroop-ai/winget-pkgs.git.extraHeader',
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credential}`,
        })
        expect(options?.env?.WINGET_TOKEN).toBeUndefined()
      }
    }
  })

  it('syncs the fork before building a branch on upstream', async () => {
    // Ordering is the whole fix. The branch is built on `upstream/master`, so
    // every file upstream has added since the fork was last synced is a file
    // this push *introduces* — and GitHub refuses a push that introduces a
    // workflow file unless the token carries the `workflow` scope. A sync after
    // the clone, or no sync at all, leaves that rejection in place: it is what
    // stopped a correct submission with the fork 18,821 commits behind.
    prepare()
    await import('../scripts/winget-submit.ts')

    const calls = vi.mocked(execFileSync).mock.calls
    const sync = calls.findIndex(([command, args]) => command === 'gh' && args?.[0] === 'repo' && args?.[1] === 'sync')
    const clone = calls.findIndex(([command, args]) => command === 'git' && args?.[0] === 'clone')
    expect(sync, 'the fork is never synced').toBeGreaterThanOrEqual(0)
    // `--force` because this fork carries no work of its own: without it a
    // sync refuses a non-fast-forward, which is the other way a stale fork
    // survives into the push.
    expect(calls[sync]?.[1]).toEqual([
      'repo', 'sync', 'looptroop-ai/winget-pkgs', '--source', 'microsoft/winget-pkgs', '--branch', 'master', '--force',
    ])
    expect(clone, 'the clone does not follow the sync').toBeGreaterThan(sync)
  })

  it('does nothing when the version is already merged with these manifests', async () => {
    // The state a re-run is most likely to find: the pull request merged, so
    // nothing is open, and upstream already carries exactly these bytes. Every
    // command after this point would fail on that — `git commit` with nothing
    // staged exits non-zero — and this script is documented as re-runnable.
    prepare({ differs: false })
    await import('../scripts/winget-submit.ts')

    const calls = vi.mocked(execFileSync).mock.calls
    const ran = (command: string, first: string) => calls.some(([cmd, args]) => cmd === command && args?.[0] === first)
    expect(ran('git', 'commit'), 'committed onto an already-published version').toBe(false)
    expect(ran('git', 'push'), 'pushed an already-published version').toBe(false)
    expect(
      calls.some(([cmd, args]) => cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create'),
      'opened a second pull request for an already-published version',
    ).toBe(false)
  })

  it('preserves inherited Git configuration when adding authentication', async () => {
    prepare()
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'http.version')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'HTTP/1.1')
    await import('../scripts/winget-submit.ts')
    for (const [command, , options] of vi.mocked(execFileSync).mock.calls) {
      if (command !== 'git') continue
      expect(options?.env).toMatchObject({
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'http.version',
        GIT_CONFIG_VALUE_0: 'HTTP/1.1',
        GIT_CONFIG_KEY_1: 'http.https://github.com/looptroop-ai/winget-pkgs.git.extraHeader',
        GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${credential}`,
      })
    }
  })

  it('does not pass ambient GitHub auth variables to git', async () => {
    prepare()
    vi.stubEnv('GH_TOKEN', 'ambient-gh-token')
    vi.stubEnv('GITHUB_TOKEN', 'ambient-github-token')
    await import('../scripts/winget-submit.ts')

    for (const [command, , options] of vi.mocked(execFileSync).mock.calls) {
      if (command === 'gh') {
        expect(options?.env?.GH_TOKEN).toBe(token)
      }
      if (command === 'git') {
        expect(options?.env?.GH_TOKEN).toBeUndefined()
        expect(options?.env?.GITHUB_TOKEN).toBeUndefined()
      }
    }
  })

  it('does not pass the source WINGET_TOKEN to git', async () => {
    prepare()
    await import('../scripts/winget-submit.ts')

    const gitCalls = vi.mocked(execFileSync).mock.calls.filter(([command]) => command === 'git')
    expect(gitCalls.length).toBeGreaterThan(0)
    for (const [, , options] of gitCalls) expect(options?.env?.WINGET_TOKEN).toBeUndefined()
  })

  it('redacts both raw and encoded credentials from git failures', async () => {
    prepare()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    vi.mocked(execFileSync).mockImplementation((command) => {
      if (command === 'git') throw Object.assign(new Error('git failed'), { stderr: `${token} ${credential}` })
      return '[]'
    })
    await expect(import('../scripts/winget-submit.ts')).rejects.toThrow('exit')
    const output = stderr.mock.calls.flat().join('')
    expect(output).toContain('[redacted]')
    expect(output).not.toContain(token)
    expect(output).not.toContain(credential)
  })
})
