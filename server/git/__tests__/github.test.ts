import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnFromSyncResult } from '../../test/childProcess'

const spawnSyncMock = vi.fn()
// Async commands run through `spawn`; both stubs answer from one description.
const spawnMock = vi.fn((...args: unknown[]) => spawnFromSyncResult(
  spawnSyncMock(...args) as ReturnType<typeof import('node:child_process').spawnSync>,
))

// The runner resolves `git`, `gh` and `ssh` to a real file before spawning
// them. These cases describe what a command *returns*, so they stub the
// resolution to the name itself: otherwise every argv assertion would carry
// whichever directory this machine keeps its tools in, and a runner without
// `gh` installed would never reach the stub at all.
vi.mock('../../lib/executablePath', () => ({
  resolveTrustedProgram: (program: string) => ({ path: program }),
}))

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

  it('reads the GitHub-recorded landed SHA by PR number even with a deleted head repository', async () => {
    spawnSyncMock.mockImplementation((command: string, args: readonly string[]) => {
      if (command === 'git') return makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      expect(args).toEqual(['api', 'repos/looptroop-ai/LoopTroop/pulls/42', '--method', 'GET'])
      return makeSpawnResult({ stdout: JSON.stringify({
        number: 42, html_url: 'https://github.com/looptroop-ai/LoopTroop/pull/42', title: 'Merged PR',
        state: 'closed', merged_at: '2026-01-01T00:00:00Z', merge_commit_sha: 'landed-sha',
        head: { ref: 'deleted-head', sha: 'candidate-sha', repo: null }, base: { ref: 'main' },
      }) })
    })
    const github = await import('../github')
    expect(await github.getPullRequestByNumber('/repo', 42)).toMatchObject({
      number: 42, state: 'merged', headRefName: 'deleted-head', headRefOid: 'candidate-sha', mergeCommitSha: 'landed-sha',
    })
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid stored PR number %s before querying GitHub', async (number) => {
    const github = await import('../github')
    await expect(github.getPullRequestByNumber('/repo', number)).rejects.toThrow('positive safe integer')
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('rejects GitHub metadata for a different PR number', async () => {
    spawnSyncMock.mockImplementation((command: string) => command === 'git'
      ? makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      : makeSpawnResult({ stdout: JSON.stringify({
        number: 99, html_url: 'https://github.com/looptroop-ai/LoopTroop/pull/99', title: 'Wrong PR',
        state: 'open', head: { ref: 'head', sha: 'candidate' }, base: { ref: 'main' },
      }) }))
    const github = await import('../github')
    await expect(github.getPullRequestByNumber('/repo', 42)).rejects.toThrow('returned pull request #99, expected #42')
  })

  it('pins the GitHub merge request to the approved candidate head', async () => {
    spawnSyncMock.mockImplementation((command: string, args: readonly string[]) => {
      if (command === 'git') return makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      if (args.includes('PUT')) {
        expect(args).toEqual([
          'api', 'repos/looptroop-ai/LoopTroop/pulls/42/merge', '--method', 'PUT',
          '-f', 'merge_method=merge', '-f', 'commit_title=Approved change', '-f', 'sha=candidate-sha',
        ])
        return makeSpawnResult({ stdout: '{"merged":true}' })
      }
      return makeSpawnResult({ stdout: JSON.stringify({
        number: 42, html_url: 'https://github.com/looptroop-ai/LoopTroop/pull/42', title: 'Approved change',
        state: 'closed', merged_at: '2026-01-01T00:00:00Z', merge_commit_sha: 'landed-sha',
        head: { ref: 'head', sha: 'candidate-sha' }, base: { ref: 'main' },
      }) })
    })
    const github = await import('../github')
    expect(await github.mergePullRequest('/repo', 42, 'Approved change', 'candidate-sha')).toMatchObject({ state: 'merged' })
    expect(spawnMock.mock.calls.some(([, args]) => (args as string[]).includes('PUT'))).toBe(true)
  })

  it('propagates a GitHub head conflict without refreshing or retrying the merge', async () => {
    spawnSyncMock.mockImplementation((command: string) => command === 'git'
      ? makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      : makeSpawnResult({ status: 1, stderr: 'HTTP 409: Head branch was modified' }))
    const github = await import('../github')
    await expect(github.mergePullRequest('/repo', 42, 'Approved change', 'candidate-sha')).rejects.toThrow('Head branch was modified')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it.each(['', '  '])('rejects an empty approved merge SHA before contacting GitHub', async (sha) => {
    const github = await import('../github')
    await expect(github.mergePullRequest('/repo', 42, 'Approved change', sha)).rejects.toThrow('approved candidate commit SHA is required')
    expect(spawnSyncMock).not.toHaveBeenCalled()
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
    expect(spawnSyncMock.mock.calls.some(([, args, options]) => (
      Array.isArray(args)
      && args.join(' ') === 'fetch --no-progress --prune origin'
      && (options as { cwd?: string } | undefined)?.cwd === '/repo'
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
    expect(spawnSyncMock.mock.calls.some(([, args, options]) => (
      Array.isArray(args)
      && args.join(' ') === 'status --porcelain=1 --untracked-files=all -- . :(top,exclude).looptroop'
      && (options as { cwd?: string } | undefined)?.cwd === '/repo'
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
    expect(spawnSyncMock.mock.calls.some(([, args, options]) => (
      Array.isArray(args)
      && args.join(' ') === 'merge-base --is-ancestor candidate123 remote-base-sha'
      && (options as { cwd?: string } | undefined)?.cwd === '/repo'
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
