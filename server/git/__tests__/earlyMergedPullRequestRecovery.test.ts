import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { reconcileMergedPullRequestCandidate, EarlyMergeRecoveryManualError } from '../earlyMergedPullRequestRecovery'

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function commit(cwd: string, message: string, allowEmpty = false): string {
  git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', ...(allowEmpty ? ['--allow-empty'] : []), '-m', message])
  return git(cwd, ['rev-parse', 'HEAD'])
}

function makeFixture(options: {
  conflictOnBaseUpdate?: boolean
  addRemoteOnlyPath?: boolean
  sameTreeCandidate?: boolean
  binaryCandidate?: boolean
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'looptroop-early-merge-'))
  roots.push(root)
  const projectPath = resolve(root, 'project')
  const worktreePath = resolve(root, 'ticket-worktree')
  const remotePath = resolve(root, 'origin.git')
  mkdirSync(projectPath)
  mkdirSync(remotePath)
  execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' })
  execFileSync('git', ['-C', projectPath, 'init'], { stdio: 'ignore' })
  git(projectPath, ['config', 'user.name', 'Test'])
  git(projectPath, ['config', 'user.email', 'test@example.com'])
  writeFileSync(resolve(projectPath, 'shared.txt'), 'first\nsecond\n')
  git(projectPath, ['add', '--', 'shared.txt'])
  commit(projectPath, 'base')
  git(projectPath, ['branch', '-M', 'main'])
  git(projectPath, ['remote', 'add', 'origin', remotePath])
  git(projectPath, ['push', '-u', 'origin', 'main'])

  git(projectPath, ['checkout', '-b', 'ticket'])
  writeFileSync(resolve(projectPath, 'shared.txt'), 'first\nmerged PR change\n')
  git(projectPath, ['add', '--', 'shared.txt'])
  const mergedHeadSha = commit(projectPath, 'merged PR head')

  git(projectPath, ['checkout', 'main'])
  git(projectPath, ['merge', '--no-ff', 'ticket', '-m', 'land merged PR'])
  const landedCommitSha = git(projectPath, ['rev-parse', 'HEAD'])
  if (options.conflictOnBaseUpdate) {
    writeFileSync(resolve(projectPath, 'shared.txt'), 'first\nremote base update\n')
    git(projectPath, ['add', '--', 'shared.txt'])
    commit(projectPath, 'unrelated conflicting base update')
  } else if (options.addRemoteOnlyPath) {
    writeFileSync(resolve(projectPath, 'local-only.txt'), 'now tracked by the updated base\n')
    git(projectPath, ['add', '--', 'local-only.txt'])
    commit(projectPath, 'unrelated base file')
  } else {
    writeFileSync(resolve(projectPath, 'unrelated.txt'), 'base update preserved\n')
    git(projectPath, ['add', '--', 'unrelated.txt'])
    commit(projectPath, 'unrelated base update')
  }
  git(projectPath, ['push', 'origin', 'main'])
  git(projectPath, ['push', 'origin', `${mergedHeadSha}:refs/pull/42/head`])

  git(projectPath, ['worktree', 'add', worktreePath, 'ticket'])
  if (options.sameTreeCandidate) {
    const candidateCommitSha = commit(worktreePath, 'candidate identity only', true)
    return { projectPath, worktreePath, mergedHeadSha, landedCommitSha, candidateCommitSha }
  }
  if (options.conflictOnBaseUpdate) {
    writeFileSync(resolve(worktreePath, 'shared.txt'), 'first\ncandidate change\n')
    git(worktreePath, ['add', '--', 'shared.txt'])
  } else {
    writeFileSync(resolve(worktreePath, 'candidate.txt'), 'candidate change\n')
    if (options.binaryCandidate) writeFileSync(resolve(worktreePath, 'candidate.bin'), Buffer.from([0, 1, 2, 255]))
    git(worktreePath, ['add', '--', 'candidate.txt'])
    if (options.binaryCandidate) git(worktreePath, ['add', '--', 'candidate.bin'])
  }
  const candidateCommitSha = commit(worktreePath, 'candidate after merged PR')
  if (options.addRemoteOnlyPath) {
    writeFileSync(resolve(worktreePath, 'local-only.txt'), 'local-only data\n')
  }
  return { projectPath, worktreePath, mergedHeadSha, landedCommitSha, candidateCommitSha }
}

function pullRequest(fixture: ReturnType<typeof makeFixture>) {
  return {
    number: 42,
    url: 'https://github.example/pulls/42',
    title: 'Early merged change',
    body: null,
    state: 'merged' as const,
    baseRefName: 'main',
    headRefName: 'ticket',
    headRefOid: fixture.mergedHeadSha,
    mergeCommitSha: fixture.landedCommitSha,
    createdAt: null,
    updatedAt: null,
    closedAt: null,
    mergedAt: null,
  }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('reconcileMergedPullRequestCandidate', () => {
  it('completes when different commits have the same tree and retains both commit identities', async () => {
    const fixture = makeFixture({ sameTreeCandidate: true })

    const result = await reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    })

    expect(result.kind).toBe('equivalent')
    if (result.kind !== 'equivalent') throw new Error('Expected equivalent candidates')
    expect(result.proof).toMatchObject({
      candidateCommitSha: fixture.candidateCommitSha,
      mergedHeadSha: fixture.mergedHeadSha,
      landedCommitSha: fixture.landedCommitSha,
    })
    expect(result.proof.candidateTreeSha).toBe(result.proof.mergedHeadTreeSha)
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.candidateCommitSha)
    expect(git(fixture.projectPath, ['rev-parse', `refs/looptroop/pull-heads/42/${fixture.mergedHeadSha}`])).toBe(fixture.mergedHeadSha)
  })

  it('carries only A-to-B changes onto current origin base and preserves unrelated base updates', async () => {
    const fixture = makeFixture({ binaryCandidate: true })

    const result = await reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    })

    expect(result.kind).toBe('corrected')
    if (result.kind !== 'corrected') throw new Error('Expected a corrected candidate')
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD^'])).toBe(result.proof.remoteBaseHead)
    expect(readFileSync(resolve(fixture.worktreePath, 'candidate.txt'), 'utf8')).toBe('candidate change\n')
    expect(readFileSync(resolve(fixture.worktreePath, 'candidate.bin'))).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(readFileSync(resolve(fixture.worktreePath, 'unrelated.txt'), 'utf8')).toBe('base update preserved\n')
    expect(git(fixture.projectPath, ['rev-parse', `refs/looptroop/pull-heads/42/${fixture.mergedHeadSha}`])).toBe(fixture.mergedHeadSha)
  })

  it('leaves the ticket candidate and conflicting recovery checkout intact when the A-to-B patch conflicts', async () => {
    const fixture = makeFixture({ conflictOnBaseUpdate: true })
    const untrackedPath = resolve(fixture.worktreePath, 'draft.md')
    writeFileSync(untrackedPath, 'keep this untracked draft\n')

    await expect(reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    })).rejects.toMatchObject({
      recovery: expect.objectContaining({ reason: 'conflict', conflictPaths: ['shared.txt'] }),
    })
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.candidateCommitSha)
    expect(readFileSync(resolve(fixture.worktreePath, 'shared.txt'), 'utf8')).toBe('first\ncandidate change\n')
    expect(readFileSync(untrackedPath, 'utf8')).toBe('keep this untracked draft\n')
  })

  it('preserves an untracked file that the new remote base would track', async () => {
    const fixture = makeFixture({ addRemoteOnlyPath: true })

    await expect(reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    })).rejects.toBeInstanceOf(EarlyMergeRecoveryManualError)
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.candidateCommitSha)
    expect(readFileSync(resolve(fixture.worktreePath, 'local-only.txt'), 'utf8')).toBe('local-only data\n')
  })
})
