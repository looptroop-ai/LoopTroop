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

describe('server/git/github', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnSyncMock.mockReset()
    spawnMock.mockClear()
  })

  it('accepts a direct github.com remote without SSH alias resolution', async () => {
    const github = await import('../github')

    const repo = github.parseGitHubRemoteUrl('git@github.com:openai/looptroop.git')

    expect(repo).toEqual({
      owner: 'openai',
      repo: 'looptroop',
      slug: 'openai/looptroop',
      remoteUrl: 'git@github.com:openai/looptroop.git',
    })
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('accepts an SSH alias remote when the alias resolves to github.com', async () => {
    spawnSyncMock.mockImplementation((command: string, args: readonly string[]) => {
      expect(command).toBe('ssh')
      expect(args).toEqual(['-G', 'github-second'])
      return makeSpawnResult({
        stdout: 'host github-second\nhostname github.com\nuser git\n',
      })
    })

    const github = await import('../github')
    const repo = github.parseGitHubRemoteUrl('git@github-second:looptroop-ai/pocketbase-master.git')

    expect(repo).toEqual({
      owner: 'looptroop-ai',
      repo: 'pocketbase-master',
      slug: 'looptroop-ai/pocketbase-master',
      remoteUrl: 'git@github-second:looptroop-ai/pocketbase-master.git',
    })
    expect(spawnSyncMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an SSH alias remote when the alias resolves to a non-GitHub host', async () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult({
      stdout: 'host company-git\nhostname gitlab.example.com\nuser git\n',
    }))

    const github = await import('../github')
    const repo = github.parseGitHubRemoteUrl('git@company-git:looptroop-ai/pocketbase-master.git')

    expect(repo).toBeNull()
  })

  it('treats gh auth as ready when an active GitHub account succeeds even if another account fails', async () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult({
      stdout: JSON.stringify({
        hosts: {
          'github.com': [
            { state: 'success', active: true, login: 'looptroop-ai' },
            { state: 'error', active: false, login: 'liviux', error: 'HTTP 401: Bad credentials' },
          ],
        },
      }),
    }))

    const github = await import('../github')

    expect(await github.getGhAuthStatus()).toEqual({ ok: true })
  })

  it('surfaces a useful auth error when there is no active successful GitHub account', async () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult({
      stdout: JSON.stringify({
        hosts: {
          'github.com': [
            { state: 'error', active: true, login: 'looptroop-ai', error: 'HTTP 401: Bad credentials' },
          ],
        },
      }),
    }))

    const github = await import('../github')
    const result = await github.getGhAuthStatus()

    expect(result.ok).toBe(false)
    expect(result).toEqual({
      ok: false,
      error: 'looptroop-ai (error): HTTP 401: Bad credentials',
    })
  })

  it('falls back to the non-JSON auth-status command when the installed gh CLI does not support --json', async () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult({
        status: 1,
        stderr: 'unknown flag: --json',
      }))
      .mockReturnValueOnce(makeSpawnResult())

    const github = await import('../github')

    expect(await github.getGhAuthStatus()).toEqual({ ok: true })
    expect(spawnSyncMock.mock.calls).toEqual([
      ['gh', ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], expect.any(Object)],
      ['gh', ['auth', 'status', '--hostname', 'github.com'], expect.any(Object)],
    ])
  })

  it.each(['WRITE', 'MAINTAIN', 'ADMIN'])(
    'recognizes %s GitHub viewer permission as writable',
    async (permission) => {
      spawnSyncMock.mockImplementation((command: string) => {
        if (command === 'git') {
          return makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git\n' })
        }
        return makeSpawnResult({ stdout: JSON.stringify({ viewerPermission: permission }) })
      })

      const github = await import('../github')

      expect(await github.getGitHubRepoWriteAccess('/repo')).toEqual({
        status: 'writable',
        permission,
      })
      // The permission probe's 5s budget is enforced by the shared runner, so
      // it is covered there; what matters here is the command and its cwd.
      expect(spawnMock.mock.calls.at(-1)).toEqual([
        'gh',
        ['repo', 'view', 'looptroop-ai/LoopTroop', '--json', 'viewerPermission'],
        expect.objectContaining({ cwd: '/repo' }),
      ])
    },
  )

  it.each(['READ', 'TRIAGE'])(
    'recognizes %s GitHub viewer permission as read-only for branch delivery',
    async (permission) => {
      spawnSyncMock.mockImplementation((command: string) => {
        if (command === 'git') {
          return makeSpawnResult({ stdout: 'git@github.com:iamkun/dayjs.git\n' })
        }
        return makeSpawnResult({ stdout: JSON.stringify({ viewerPermission: permission }) })
      })

      const github = await import('../github')

      expect(await github.getGitHubRepoWriteAccess('/repo')).toEqual({
        status: 'read_only',
        permission,
      })
    },
  )

  it('keeps malformed GitHub permission output advisory instead of claiming read-only access', async () => {
    spawnSyncMock.mockImplementation((command: string) => {
      if (command === 'git') {
        return makeSpawnResult({ stdout: 'https://github.com/iamkun/dayjs.git\n' })
      }
      return makeSpawnResult({ stdout: 'not-json' })
    })

    const github = await import('../github')
    const result = await github.getGitHubRepoWriteAccess('/repo')

    expect(result.status).toBe('unknown')
    expect(result.permission).toBeNull()
    expect(result.error).toContain('Failed to parse GitHub repository permission')
  })

  it('omits an oversized patch instead of throwing during PR diff capture', async () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('--stat')) {
        return makeSpawnResult({ stdout: 'src/app.ts | 2 +-' })
      }
      if (args.includes('--name-status')) {
        return makeSpawnResult({ stdout: 'M\tsrc/app.ts' })
      }
      if (args.includes('--unified=0')) {
        return makeSpawnResult({ error: new Error('spawnSync git ENOBUFS') })
      }
      return makeSpawnResult()
    })

    const github = await import('../github')
    const result = github.readGitDiff('/repo', 'base', 'head')

    expect(result.stat).toBe('src/app.ts | 2 +-')
    expect(result.nameStatus).toBe('M\tsrc/app.ts')
    expect(result.patchTruncated).toBe(true)
    expect(result.patchError).toBe('spawnSync git ENOBUFS')
    expect(result.patch).toContain('omitted the full patch')
  })

  it('syncs the local base branch with fetch progress disabled', async () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('status')) return makeSpawnResult()
      if (args.includes('fetch')) return makeSpawnResult()
      if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
        return makeSpawnResult({ stdout: 'main\n' })
      }
      if (args.includes('rev-parse') && args.includes('refs/remotes/origin/main')) {
        return makeSpawnResult({ stdout: 'remote-sha\n' })
      }
      if (args.includes('merge')) return makeSpawnResult()
      if (args.includes('rev-parse') && args.includes('HEAD')) {
        return makeSpawnResult({ stdout: 'local-sha\n' })
      }
      return makeSpawnResult()
    })

    const github = await import('../github')
    const result = await github.syncLocalBaseBranch('/repo', 'main')

    expect(result).toEqual({
      originalBranch: 'main',
      localBaseHead: 'local-sha',
      remoteBaseHead: 'remote-sha',
    })
    expect(spawnSyncMock.mock.calls.some(([, args]) => (
      Array.isArray(args)
      && args.join(' ') === '-C /repo fetch --no-progress --prune origin'
    ))).toBe(true)
    const fetchCallIndex = spawnSyncMock.mock.calls.findIndex(([, args]) => Array.isArray(args) && args.includes('fetch'))
    const statusCallIndex = spawnSyncMock.mock.calls.findIndex(([, args]) => Array.isArray(args) && args.includes('status'))
    expect(fetchCallIndex).toBeGreaterThanOrEqual(0)
    expect(statusCallIndex).toBeGreaterThan(fetchCallIndex)
  })

  it('allows untracked files during explicit local base sync until Git reports an overwrite conflict', async () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('fetch')) return makeSpawnResult()
      if (args.includes('status')) return makeSpawnResult({ stdout: '?? scratch.log\n' })
      if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
        return makeSpawnResult({ stdout: 'main\n' })
      }
      if (args.includes('rev-parse') && args.includes('refs/remotes/origin/main')) {
        return makeSpawnResult({ stdout: 'remote-sha\n' })
      }
      if (args.includes('merge')) return makeSpawnResult()
      if (args.includes('rev-parse') && args.includes('HEAD')) {
        return makeSpawnResult({ stdout: 'local-sha\n' })
      }
      return makeSpawnResult()
    })

    const github = await import('../github')
    const result = await github.syncLocalBaseBranch('/repo', 'main')

    expect(result.remoteBaseHead).toBe('remote-sha')
    expect(spawnSyncMock.mock.calls.some(([, args]) => (
      Array.isArray(args)
      && args.join(' ') === '-C /repo status --porcelain=1 --untracked-files=all -- . :(top,exclude).looptroop'
    ))).toBe(true)
  })

  it('reports tracked and untracked dirty files with the checked path', async () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('status')) {
        return makeSpawnResult({
          stdout: [
            'M  staged.ts',
            ' D deleted.ts',
            '?? scratch.log',
          ].join('\n'),
        })
      }
      return makeSpawnResult()
    })

    const github = await import('../github')

    expect(() => github.ensureWorktreeClean('/repo')).toThrow(
      'Checked path: /repo Tracked staged files: staged.ts Tracked unstaged files: deleted.ts Untracked files: scratch.log',
    )
  })

  it('verifies a remote base contains the merged commit without touching the checkout', async () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('fetch')) return makeSpawnResult()
      if (args.includes('rev-parse') && args.includes('refs/remotes/origin/main')) {
        return makeSpawnResult({ stdout: 'remote-base-sha\n' })
      }
      if (args.includes('merge-base')) return makeSpawnResult()
      return makeSpawnResult()
    })

    const github = await import('../github')
    const result = await github.verifyRemoteBaseContainsCommit('/repo', 'main', 'candidate123')

    expect(result).toEqual({
      baseBranch: 'main',
      verifiedCommitSha: 'candidate123',
      remoteBaseHead: 'remote-base-sha',
    })
    expect(spawnSyncMock.mock.calls.some(([, args]) => (
      Array.isArray(args)
      && args.join(' ') === '-C /repo merge-base --is-ancestor candidate123 remote-base-sha'
    ))).toBe(true)
    expect(spawnSyncMock.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('checkout'))).toBe(false)
    expect(spawnSyncMock.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('merge'))).toBe(false)
  })

  it('fails remote merge verification when the base does not contain the commit', async () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('fetch')) return makeSpawnResult()
      if (args.includes('rev-parse') && args.includes('refs/remotes/origin/main')) {
        return makeSpawnResult({ stdout: 'remote-base-sha\n' })
      }
      if (args.includes('merge-base')) return makeSpawnResult({ status: 1 })
      return makeSpawnResult()
    })

    const github = await import('../github')

    await expect(github.verifyRemoteBaseContainsCommit('/repo', 'main', 'candidate123')).rejects.toThrow(
      'Remote origin/main does not contain commit candidate123. Latest remote base is remote-base-sha.',
    )
  })
})
