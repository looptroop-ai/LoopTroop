import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnFromSyncResult } from '../../test/childProcess'

const spawnSyncMock = vi.fn()
// Async commands run through `spawn`; both stubs answer from one description.
const spawnMock = vi.fn((...args: unknown[]) => spawnFromSyncResult(
  spawnSyncMock(...args) as ReturnType<typeof import('node:child_process').spawnSync>,
))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    spawnSync: spawnSyncMock,
    spawn: spawnMock,
  }
})

function makeSpawnResult(overrides: {
  status?: number
  stdout?: string
  stderr?: string
  error?: Error
} = {}): ReturnType<typeof import('node:child_process').spawnSync> {
  return {
    status: overrides.status ?? 0,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    error: overrides.error,
    pid: 123,
    output: [null, overrides.stdout ?? '', overrides.stderr ?? ''],
    signal: null,
  } as ReturnType<typeof import('node:child_process').spawnSync>
}

describe('server/git/push', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnSyncMock.mockReset()
    spawnMock.mockClear()
  })

  it('pushes branch refs without forcing progress output', async () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult())

    const { pushBranchRef } = await import('../push')
    const result = await pushBranchRef({
      projectPath: '/repo',
      destinationBranch: 'TEST-1',
      sourceRef: 'HEAD',
      maxRetries: 1,
    })

    expect(result).toEqual({ pushed: true })
    // The push runs asynchronously now, so the options carry cwd and env only;
    // `encoding` belonged to the synchronous call this replaced.
    expect(spawnSyncMock).toHaveBeenCalledWith('git', [
      '-C',
      '/repo',
      'push',
      'origin',
      'HEAD:refs/heads/TEST-1',
    ], expect.objectContaining({ env: expect.any(Object) }))
    expect(spawnSyncMock.mock.calls[0]?.[1]).not.toContain('--progress')
  })

  // gh reads GH_TOKEN from the environment; git does not. On a machine whose
  // only credential is that variable — a container, typically — every gh call
  // works and the push that follows asks for a password it cannot request.
  describe('credentials for the push itself', () => {
    const tokenVars = ['GH_TOKEN', 'GITHUB_TOKEN'] as const

    function withEnv(overrides: Record<string, string | undefined>, run: () => Promise<void>) {
      const saved = new Map<string, string | undefined>()
      for (const [key, value] of Object.entries(overrides)) {
        saved.set(key, process.env[key])
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return run().finally(() => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      })
    }

    function pushEnv(): Record<string, string | undefined> {
      const call = spawnSyncMock.mock.calls.find((c) => c[0] === 'git')
      return (call?.[2] as { env: Record<string, string | undefined> }).env
    }

    async function push() {
      const { pushBranchRef } = await import('../push')
      await pushBranchRef({ projectPath: '/repo', destinationBranch: 'TEST-1', sourceRef: 'HEAD', maxRetries: 1 })
    }

    for (const variable of tokenVars) {
      it(`points git at gh's credential helper when ${variable} is the only credential`, async () => {
        spawnSyncMock.mockReturnValue(makeSpawnResult())
        await withEnv(
          { GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GIT_CONFIG_COUNT: undefined, [variable]: 'token' },
          async () => {
            await push()
            const env = pushEnv()
            expect(env.GIT_CONFIG_COUNT).toBe('1')
            expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper')
            expect(env.GIT_CONFIG_VALUE_0).toBe('!gh auth git-credential')
          },
        )
      })
    }

    it('adds no helper when there is no token to lend', async () => {
      spawnSyncMock.mockReturnValue(makeSpawnResult())
      await withEnv({ GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GIT_CONFIG_COUNT: undefined }, async () => {
        await push()
        expect(pushEnv().GIT_CONFIG_COUNT).toBeUndefined()
      })
    })

    it('adds no helper when gh is not installed, rather than one that cannot run', async () => {
      spawnSyncMock.mockImplementation((bin: string) =>
        bin === 'gh' ? makeSpawnResult({ error: new Error('spawn gh ENOENT') }) : makeSpawnResult(),
      )
      await withEnv({ GH_TOKEN: 'token', GITHUB_TOKEN: undefined, GIT_CONFIG_COUNT: undefined }, async () => {
        await push()
        expect(pushEnv().GIT_CONFIG_COUNT).toBeUndefined()
      })
    })

    it('appends to git config the environment already carries instead of replacing it', async () => {
      spawnSyncMock.mockReturnValue(makeSpawnResult())
      await withEnv(
        {
          GH_TOKEN: 'token',
          GITHUB_TOKEN: undefined,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'user.name',
          GIT_CONFIG_VALUE_0: 'Someone',
        },
        async () => {
          await push()
          const env = pushEnv()
          expect(env.GIT_CONFIG_COUNT).toBe('2')
          expect(env.GIT_CONFIG_KEY_0).toBe('user.name')
          expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper')
        },
      )
    })

    it('keeps prompting off, so a missing credential fails instead of hanging', async () => {
      spawnSyncMock.mockReturnValue(makeSpawnResult())
      await withEnv({ GH_TOKEN: 'token', GITHUB_TOKEN: undefined, GIT_CONFIG_COUNT: undefined }, async () => {
        await push()
        expect(pushEnv().GIT_TERMINAL_PROMPT).toBe('0')
      })
    })
  })
})
