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

function prepare() {
  vi.stubEnv('WINGET_TOKEN', token)
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  process.argv = ['node', 'winget-submit.ts', '--version', '9.9.9', '--url', 'https://example.invalid/package.zip', '--sha256', 'a'.repeat(64)]
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.mocked(execFileSync).mockImplementation((command, args) => command === 'gh' && args?.[1] === 'list' ? '[]' : '')
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
      expect(options?.env?.GH_TOKEN).toBe(token)
      if (command === 'git') {
        expect(options?.env).toMatchObject({
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/looptroop-ai/winget-pkgs.git.extraHeader',
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credential}`,
        })
      }
    }
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
