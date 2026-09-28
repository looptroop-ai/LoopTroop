import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function pullRequestRecord(number: number) {
  return {
    number,
    html_url: `https://github.com/looptroop-ai/LoopTroop/pull/${number}`,
    title: `Change ${number}`,
    body: `Details for ${number}`,
    state: 'open',
    draft: true,
    head: { ref: 'ticket-branch', sha: 'candidate-sha' },
    base: { ref: 'main' },
  }
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
      expect(args).toEqual(['api', 'repos/looptroop-ai/LoopTroop/pulls/42', '--method', 'GET', '-H', 'X-GitHub-Api-Version: 2022-11-28'])
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

  it.each([null, {}, { number: 42 }, { number: 42, html_url: 'url', title: 'PR', state: 'closed', base: { ref: 'main' } }])('rejects malformed numbered PR metadata: %j', async (record) => {
    spawnSyncMock.mockImplementation((command: string) => command === 'git'
      ? makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      : makeSpawnResult({ stdout: JSON.stringify(record) }))
    const github = await import('../github')
    await expect(github.getPullRequestByNumber('/repo', 42)).rejects.toThrow('invalid metadata for pull request #42')
  })

  it('rejects an empty GitHub response when reading a numbered pull request', async () => {
    spawnSyncMock.mockImplementation((command: string) => command === 'git'
      ? makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      : makeSpawnResult())

    const github = await import('../github')
    await expect(github.getPullRequestByNumber('/repo', 42)).rejects.toThrow('GitHub CLI returned empty JSON output')
  })

  it('recognizes merged=true even when the merged timestamp is unavailable', async () => {
    spawnSyncMock.mockImplementation((command: string) => command === 'git'
      ? makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      : makeSpawnResult({ stdout: JSON.stringify({
        number: 42, html_url: 'url', title: 'Merged PR', state: 'closed', merged: true, merged_at: null,
        merge_commit_sha: 'landed', head: { ref: 'head', sha: 'candidate' }, base: { ref: 'main' },
      }) }))
    const github = await import('../github')
    expect(await github.getPullRequestByNumber('/repo', 42)).toMatchObject({ state: 'merged', mergedAt: null })
  })

  it.each(['ready', 'merge'])('validates the refreshed PR identity after %s', async (action) => {
    spawnSyncMock.mockImplementation((command: string, args: readonly string[]) => {
      if (command === 'git') return makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      if (args.includes('ready') || args.includes('PUT')) return makeSpawnResult({ stdout: '{}' })
      expect(args).toContain('X-GitHub-Api-Version: 2022-11-28')
      return makeSpawnResult({ stdout: JSON.stringify({
        number: 99, html_url: 'url', title: 'Wrong PR', state: 'open',
        head: { ref: 'head', sha: 'candidate' }, base: { ref: 'main' },
      }) })
    })
    const github = await import('../github')
    await expect(action === 'ready'
      ? github.markPullRequestReady('/repo', 42)
      : github.mergePullRequest('/repo', 42, 'PR', 'candidate')).rejects.toThrow('returned pull request #99, expected #42')
  })

  it('pins the GitHub merge request to the approved candidate head', async () => {
    spawnSyncMock.mockImplementation((command: string, args: readonly string[]) => {
      if (command === 'git') return makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      if (args.includes('PUT')) {
        expect(args).toEqual([
          'api', 'repos/looptroop-ai/LoopTroop/pulls/42/merge', '--method', 'PUT',
          '-f', 'merge_method=merge', '-f', 'commit_title=Approved change', '-f', 'sha=candidate-sha',
          '-H', 'X-GitHub-Api-Version: 2022-11-28',
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

  it('rejects unsafe diff refs before they can become a Git option', async () => {
    const github = await import('../github')

    expect(() => github.readGitDiff('/repo', '--output=outside', 'HEAD')).toThrow('Diff base ref is not a safe Git ref')
    expect(spawnSyncMock).not.toHaveBeenCalled()
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

  it('reuses a successful SSH alias hostname probe', async () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult({ stdout: 'hostname github.com\n' }))

    const github = await import('../github')
    expect(github.parseGitHubRemoteUrl('git@company-git:owner/repo.git')).toMatchObject({ owner: 'owner', repo: 'repo' })
    expect(github.parseGitHubRemoteUrl('git@company-git:owner/another-repo.git')).toMatchObject({ repo: 'another-repo' })
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

  it('does not cache a transient SSH alias probe failure', async () => {
    let probes = 0
    spawnSyncMock.mockImplementation((_command: string) => {
      probes += 1
      return probes === 1
        ? makeSpawnResult({ status: 1, stderr: 'temporary ssh config failure' })
        : makeSpawnResult({ stdout: 'hostname github.com\n' })
    })

    const github = await import('../github')
    expect(github.parseGitHubRemoteUrl('git@company-git:owner/repo.git')).toBeNull()
    expect(github.parseGitHubRemoteUrl('git@company-git:owner/repo.git')).toMatchObject({
      owner: 'owner',
      repo: 'repo',
    })
    expect(probes).toBe(2)
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

  it.each([
    [JSON.stringify({ hosts: { 'github.com': [
      { state: 'error', active: false, login: 'first', error: 'expired' },
      { state: 'error', active: false, login: 'second' },
    ] } }), 'first (error): expired; second (error)'],
    ['{}', 'No github.com auth entries found.'],
    ['not-json', 'Failed to parse gh auth status JSON:'],
  ])('explains inactive or missing GitHub auth entries', async (stdout, expectedError) => {
    spawnSyncMock.mockReturnValue(makeSpawnResult({ stdout }))

    const github = await import('../github')
    await expect(github.getGhAuthStatus()).resolves.toMatchObject({ ok: false, error: expect.stringContaining(expectedError) })
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

  it('returns a direct GitHub auth command failure', async () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult({ status: 1, stderr: 'network unavailable' }))

    const github = await import('../github')
    await expect(github.getGhAuthStatus()).resolves.toEqual({ ok: false, error: 'network unavailable' })
  })

  it('reports whether gh is installed from its version probe', async () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult({ status: 1, stderr: 'gh missing' }))

    const github = await import('../github')
    expect(github.isGhInstalled()).toBe(false)
    expect(spawnSyncMock).toHaveBeenCalledWith('gh', ['--version'], expect.any(Object))
  })

  it.each([
    [0, 'viewer can access the repository'],
    [1, 'repository is unavailable'],
  ])('reports repository access when gh exits with status %i', async (status, message) => {
    spawnSyncMock.mockImplementation((command: string) => command === 'git'
      ? makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      : makeSpawnResult({ status, stderr: status === 0 ? '' : message }))

    const github = await import('../github')
    const result = await github.getGitHubRepoAccess('/repo')
    if (status === 0) {
      expect(result).toMatchObject({ ok: true, repo: { slug: 'looptroop-ai/LoopTroop' } })
    } else {
      expect(result).toEqual({ ok: false, error: message })
    }
  })

  it('keeps repository write access unknown when origin cannot be read', async () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult({ status: 1, stderr: 'origin is missing' }))

    const github = await import('../github')
    await expect(github.getGitHubRepoWriteAccess('/repo')).resolves.toEqual({
      status: 'unknown',
      permission: null,
      error: 'Project must have an origin remote that resolves to github.com.',
    })
  })

  it('keeps repository write access unknown when the permission request fails', async () => {
    spawnSyncMock.mockImplementation((command: string) => command === 'git'
      ? makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      : makeSpawnResult({ status: 1, stderr: 'permission request failed' }))

    const github = await import('../github')
    await expect(github.getGitHubRepoWriteAccess('/repo')).resolves.toEqual({
      status: 'unknown',
      permission: null,
      error: 'permission request failed',
    })
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

  it.each([
    [{ viewerPermission: 'PULL_REQUEST_REVIEWER' }, 'GitHub CLI returned an unsupported viewer permission: PULL_REQUEST_REVIEWER'],
    [{}, 'GitHub CLI did not return a viewer permission.'],
  ])('keeps unsupported or missing repository permissions unknown', async (payload, error) => {
    spawnSyncMock.mockImplementation((command: string) => command === 'git'
      ? makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      : makeSpawnResult({ stdout: JSON.stringify(payload) }))

    const github = await import('../github')
    await expect(github.getGitHubRepoWriteAccess('/repo')).resolves.toEqual({
      status: 'unknown',
      permission: ('viewerPermission' in payload ? payload.viewerPermission : undefined) ?? null,
      error,
    })
  })

  it('updates the newest matching draft pull request and keeps its metadata if GitHub returns a sparse update', async () => {
    spawnSyncMock.mockImplementation((command: string, args: readonly string[]) => {
      if (command === 'git') return makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      if (args.includes('PATCH')) return makeSpawnResult({ stdout: '{}' })
      if (args.includes('GET')) {
        return makeSpawnResult({ stdout: JSON.stringify([pullRequestRecord(4), { number: 5 }, pullRequestRecord(12)]) })
      }
      return makeSpawnResult()
    })

    const github = await import('../github')
    const result = await github.createOrUpdateDraftPullRequest({
      projectPath: '/repo',
      branchName: 'ticket-branch',
      baseBranch: 'main',
      title: 'Updated title',
      body: 'Updated description',
    })

    expect(result).toMatchObject({ number: 12, title: 'Change 12', state: 'draft' })
    const patchCall = spawnSyncMock.mock.calls.find(([, args]) => Array.isArray(args) && args.includes('PATCH'))
    expect(patchCall?.[1]).toContain('repos/looptroop-ai/LoopTroop/pulls/12')
    expect(patchCall?.[1]).toContain('title=Updated title')
    expect(patchCall?.[1]).toContain('body=Updated description')
  })

  it('creates a draft pull request when no matching request exists', async () => {
    spawnSyncMock.mockImplementation((command: string, args: readonly string[]) => {
      if (command === 'git') return makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      if (args.includes('GET')) return makeSpawnResult({ stdout: '[]' })
      if (args.includes('POST')) return makeSpawnResult({ stdout: JSON.stringify(pullRequestRecord(42)) })
      return makeSpawnResult()
    })

    const github = await import('../github')
    const result = await github.createOrUpdateDraftPullRequest({
      projectPath: '/repo',
      branchName: 'ticket-branch',
      baseBranch: 'main',
      title: 'New draft',
      body: 'Review the candidate.',
    })

    expect(result).toMatchObject({ number: 42, title: 'Change 42', state: 'draft' })
    const postCall = spawnSyncMock.mock.calls.find(([, args]) => Array.isArray(args) && args.includes('POST'))
    expect(postCall?.[1]).toEqual(expect.arrayContaining([
      'repos/looptroop-ai/LoopTroop/pulls',
      'head=ticket-branch',
      'base=main',
      'title=New draft',
      'body=Review the candidate.',
      'draft=true',
    ]))
  })

  it('rejects a draft creation response that contains no pull request metadata', async () => {
    spawnSyncMock.mockImplementation((command: string, args: readonly string[]) => {
      if (command === 'git') return makeSpawnResult({ stdout: 'https://github.com/looptroop-ai/LoopTroop.git' })
      return makeSpawnResult({ stdout: args.includes('GET') ? '[]' : '{}' })
    })

    const github = await import('../github')
    await expect(github.createOrUpdateDraftPullRequest({
      projectPath: '/repo',
      branchName: 'ticket-branch',
      baseBranch: 'main',
      title: 'New draft',
      body: 'Review the candidate.',
    })).rejects.toThrow('GitHub CLI did not return pull request metadata after creation')
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

  it('returns patch and NUL-delimited file names when diff capture succeeds', async () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('--stat')) return makeSpawnResult({ stdout: 'src/app.ts | 1 +' })
      if (args.includes('--name-status') && args.includes('-z')) {
        return makeSpawnResult({ stdout: 'M\0src/app.ts\0' })
      }
      if (args.includes('--name-status')) return makeSpawnResult({ stdout: 'M\tsrc/app.ts' })
      if (args.includes('--unified=0')) return makeSpawnResult({ stdout: '@@ -0,0 +1 @@\n+new line' })
      return makeSpawnResult()
    })

    const github = await import('../github')
    expect(github.readGitDiff('/repo', 'base', 'head')).toEqual({
      stat: 'src/app.ts | 1 +',
      nameStatus: 'M\tsrc/app.ts',
      nameStatusZ: 'M\0src/app.ts\0',
      patch: '@@ -0,0 +1 @@\n+new line',
      patchTruncated: false,
      patchError: null,
    })
  })

  it('marks recovery receipt git status as unreadable instead of implying the worktree is clean', async () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => (
      args.includes('rev-parse') || args.includes('status')
        ? makeSpawnResult({ status: 1, stderr: 'not a git repository' })
        : makeSpawnResult()
    ))

    const github = await import('../github')
    const receipt = github.captureGitRecoveryReceipt({
      projectPath: '/missing-repo',
      phase: 'delivery',
      step: 'push_candidate_branch',
      error: 'push failed',
      branch: 'ticket-1',
      baseBranch: 'main',
    })

    expect(receipt).toMatchObject({
      headSha: null,
      statusUnreadable: true,
      stagedFiles: [],
      unstagedFiles: [],
      untrackedFiles: [],
      nextSafeActions: expect.arrayContaining(['Inspect the local candidate commit and remote ticket branch before retrying.']),
    })
  })

  it.each([
    ['create_or_update_pull_request', 'Run gh auth status and re-authenticate if needed, then retry the ticket.'],
    ['mark_pull_request_ready', 'Inspect the draft pull request state in GitHub, then retry the merge action.'],
    ['merge_pull_request', 'Inspect the pull request mergeability in GitHub, resolve blockers, then retry the merge action.'],
    ['verify_pull_request_candidate', 'Confirm the pull request targets the expected base branch and still points at the recorded candidate commit, then retry.'],
    ['verify_remote_merge', 'Fetch origin and confirm the remote base branch contains the merged pull request commit, then retry.'],
    ['rewrite_candidate_commit', 'Commit, stash or restore tracked changes in the ticket worktree, then retry the ticket.'],
    ['sync_local_base_branch', 'Resolve tracked local changes or any Git-reported untracked overwrite conflict, then retry the explicit local base-branch sync.'],
    ['unrecognized_step', 'Inspect the recorded git recovery receipt, resolve the blocking git or GitHub issue, then retry.'],
  ])('gives recovery guidance for %s', async (step, action) => {
    spawnSyncMock.mockReturnValue(makeSpawnResult())

    const github = await import('../github')
    const receipt = github.captureGitRecoveryReceipt({
      projectPath: '/repo', phase: 'delivery', step, error: 'failed', branch: 'ticket-1', baseBranch: 'main',
    })
    expect(receipt.nextSafeActions).toContain(action)
  })

  it('refuses a reset when an ignored local file blocks a path restored by the candidate base', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'looptroop-github-clobber-'))
    try {
      writeFileSync(join(projectPath, 'generated'), 'local output')
      spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => (
        args.includes('--diff-filter=D')
          ? makeSpawnResult({ stdout: 'generated/result.json\0' })
          : makeSpawnResult()
      ))

      const github = await import('../github')
      expect(() => github.ensureNoUntrackedPathsClobberedBy(projectPath, 'merge-base', 'candidate rewrite')).toThrow(
        'Local files would be overwritten by candidate rewrite: generated',
      )
    } finally {
      rmSync(projectPath, { recursive: true, force: true })
    }
  })

  it('allows a candidate checkout to replace a path that HEAD already tracks', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'looptroop-github-overwrite-'))
    try {
      writeFileSync(join(projectPath, 'scratch.log'), 'local content')
      spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => (
        args.includes('ls-tree')
          ? makeSpawnResult({ stdout: 'scratch.log\0' })
          : makeSpawnResult()
      ))

      const github = await import('../github')
      expect(() => github.ensureNoUntrackedPathsOverwrittenBy(projectPath, ['scratch.log'], 'candidate checkout')).not.toThrow()
      expect(spawnSyncMock.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('ls-tree'))).toBe(true)
    } finally {
      rmSync(projectPath, { recursive: true, force: true })
    }
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

  it('creates the local base from origin when its local branch does not exist', async () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('checkout') && args.at(-1) === 'main') {
        return makeSpawnResult({ status: 1, stderr: "error: pathspec 'main' did not match any file(s) known to git" })
      }
      if (args.includes('rev-parse') && args.includes('--abbrev-ref')) return makeSpawnResult({ stdout: 'ticket-1\n' })
      if (args.includes('rev-parse') && args.includes('refs/remotes/origin/main')) return makeSpawnResult({ stdout: 'remote-sha\n' })
      if (args.includes('rev-parse') && args.includes('HEAD')) return makeSpawnResult({ stdout: 'local-sha\n' })
      return makeSpawnResult()
    })

    const github = await import('../github')
    await expect(github.syncLocalBaseBranch('/repo', 'main')).resolves.toEqual({
      originalBranch: 'ticket-1',
      localBaseHead: 'local-sha',
      remoteBaseHead: 'remote-sha',
    })
    expect(spawnMock.mock.calls.some(([command, args]) => command === 'git' && (args as string[]).join(' ') === 'checkout main')).toBe(true)
    expect(spawnMock.mock.calls.some(([command, args]) => command === 'git' && (args as string[]).join(' ') === 'checkout -B main origin/main')).toBe(true)
  })

  it('allows untracked files during explicit local base sync until Git reports an overwrite conflict', async () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('fetch')) return makeSpawnResult()
      if (args.includes('status')) return makeSpawnResult({ stdout: '?? scratch.log\0' })
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
      && args.join(' ') === 'status --porcelain=1 -z --untracked-files=all -- . :(top,exclude).looptroop'
      && (options as { cwd?: string } | undefined)?.cwd === '/repo'
    ))).toBe(true)
  })

  it('reports tracked and untracked dirty files with the checked path', async () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('status')) {
        return makeSpawnResult({
          stdout: 'M  staged.ts\0 D deleted.ts\0?? scratch.log\0',
        })
      }
      return makeSpawnResult()
    })

    const github = await import('../github')

    expect(() => github.ensureWorktreeClean('/repo')).toThrow(
      'Checked path: /repo Tracked staged files: staged.ts Tracked unstaged files: deleted.ts Untracked files: scratch.log',
    )
  })

  it('allows the same known generated noise that bead commits leave local', async () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('status')) return makeSpawnResult({ stdout: '?? dist/bundle.js\0' })
      return makeSpawnResult()
    })
    const github = await import('../github')

    expect(() => github.ensureWorktreeClean('/repo')).not.toThrow()
  })

  it('blocks local base sync when tracked worktree changes could be lost', async () => {
    spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => (
      args.includes('status') ? makeSpawnResult({ stdout: ' M tracked.ts\0' }) : makeSpawnResult()
    ))

    const github = await import('../github')
    expect(() => github.ensureNoTrackedWorktreeChanges('/repo', 'candidate rewrite')).toThrow(
      'Worktree has tracked changes that would make candidate rewrite unsafe.',
    )
  })

  it('fails closed when Git cannot compare the paths restored by a candidate base', async () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult({ status: 1, stderr: 'object is unavailable' }))

    const github = await import('../github')
    expect(() => github.ensureNoUntrackedPathsClobberedBy('/repo', 'merge-base', 'candidate rewrite')).toThrow(
      'Could not compare merge-base with HEAD before candidate rewrite: object is unavailable',
    )
  })

  it('fails closed when Git cannot determine whether a candidate path is tracked', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'looptroop-github-tree-error-'))
    try {
      writeFileSync(join(projectPath, 'scratch.log'), 'local content')
      spawnSyncMock.mockImplementation((_command: string, args: readonly string[]) => (
        args.includes('ls-tree') ? makeSpawnResult({ status: 1, stderr: 'tree is unavailable' }) : makeSpawnResult()
      ))

      const github = await import('../github')
      expect(() => github.ensureNoUntrackedPathsOverwrittenBy(projectPath, ['scratch.log'], 'candidate checkout')).toThrow(
        'Could not read HEAD before candidate checkout: tree is unavailable',
      )
    } finally {
      rmSync(projectPath, { recursive: true, force: true })
    }
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

  it('rejects remote merge verification when the candidate SHA is unavailable', async () => {
    const github = await import('../github')

    await expect(github.verifyRemoteBaseContainsCommit('/repo', 'main', '  ')).rejects.toThrow(
      'Cannot verify remote merge without a pull request head or candidate commit SHA.',
    )
    expect(spawnSyncMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('deletes a remote branch only with the verified expected-head lease', async () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult())
    const github = await import('../github')
    const expectedSha = 'a'.repeat(40)

    await expect(github.tryDeleteRemoteBranch('/repo', 'ticket-1', expectedSha)).resolves.toEqual({
      deleted: true,
      warning: null,
    })

    const pushCall = spawnSyncMock.mock.calls.find(([, args]) => (
      Array.isArray(args) && args[0] === 'push'
    ))
    expect(pushCall?.[1]).toEqual([
      'push',
      'origin',
      `--force-with-lease=refs/heads/ticket-1:${expectedSha}`,
      ':refs/heads/ticket-1',
    ])
  })

  it('skips remote branch deletion when no expected head SHA is available', async () => {
    const github = await import('../github')

    await expect(github.tryDeleteRemoteBranch('/repo', 'ticket-1', '')).resolves.toEqual({
      deleted: false,
      warning: 'Remote branch deletion was skipped because its expected head SHA was unavailable.',
    })
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })
})
