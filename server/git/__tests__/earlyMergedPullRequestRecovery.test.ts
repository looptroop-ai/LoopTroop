import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { reconcileMergedPullRequestCandidate, EarlyMergeRecoveryManualError } from '../earlyMergedPullRequestRecovery'
import { pinGitLineEndings } from '../../test/tempDir'

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function normalizedPath(path: string): string {
  const absolute = resolve(path)
  const canonical = existsSync(absolute)
    ? realpathSync.native(absolute)
    : resolve(realpathSync.native(dirname(absolute)), basename(absolute))
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
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
  candidateDeltaAlreadyOnRemote?: boolean
  candidateRemovesMergedFile?: boolean
  candidateUpdatesMergedFile?: boolean
  squashMerge?: boolean
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
  pinGitLineEndings(remotePath)
  pinGitLineEndings(projectPath)
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
  if (options.squashMerge) {
    git(projectPath, ['merge', '--squash', 'ticket'])
    commit(projectPath, 'land merged PR')
  } else {
    git(projectPath, ['merge', '--no-ff', 'ticket', '-m', 'land merged PR'])
  }
  const landedCommitSha = git(projectPath, ['rev-parse', 'HEAD'])
  if (options.conflictOnBaseUpdate) {
    writeFileSync(resolve(projectPath, 'shared.txt'), 'first\nremote base update\n')
    git(projectPath, ['add', '--', 'shared.txt'])
    commit(projectPath, 'unrelated conflicting base update')
  } else if (options.candidateDeltaAlreadyOnRemote) {
    writeFileSync(resolve(projectPath, 'candidate.txt'), 'candidate change\n')
    git(projectPath, ['add', '--', 'candidate.txt'])
    commit(projectPath, 'candidate delta already landed')
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
    return { projectPath, worktreePath, remotePath, mergedHeadSha, landedCommitSha, candidateCommitSha }
  }
  if (options.conflictOnBaseUpdate) {
    writeFileSync(resolve(worktreePath, 'shared.txt'), 'first\ncandidate change\n')
    git(worktreePath, ['add', '--', 'shared.txt'])
  } else if (options.candidateUpdatesMergedFile) {
    writeFileSync(resolve(worktreePath, 'shared.txt'), 'candidate prefix\nmerged PR change\n')
    git(worktreePath, ['add', '--', 'shared.txt'])
  } else if (options.candidateRemovesMergedFile) {
    rmSync(resolve(worktreePath, 'shared.txt'))
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
  return { projectPath, worktreePath, remotePath, mergedHeadSha, landedCommitSha, candidateCommitSha }
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

function reconcileFixture(fixture: ReturnType<typeof makeFixture>) {
  return reconcileMergedPullRequestCandidate({
    ...fixture, externalId: 'TEST-42', baseBranch: 'main', headBranch: 'ticket', pr: pullRequest(fixture),
  })
}

function advanceBase(fixture: ReturnType<typeof makeFixture>, file: string, content: string) {
  writeFileSync(resolve(fixture.projectPath, file), content)
  git(fixture.projectPath, ['add', '--', file])
  const head = commit(fixture.projectPath, 'later base update')
  git(fixture.projectPath, ['push', 'origin', 'main'])
  return head
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('reconcileMergedPullRequestCandidate', () => {
  it('reconciles a squash-merged PR whose head is not an ancestor of the base', async () => {
    const fixture = makeFixture({ squashMerge: true })

    await expect(reconcileFixture(fixture)).resolves.toMatchObject({ kind: 'corrected' })
  })

  it('validates a correction PR head while keeping the local checkout on the ticket branch', async () => {
    const fixture = makeFixture()
    const correctionBranch = `looptroop/early-merge/pr-42-${fixture.candidateCommitSha.slice(0, 12)}`

    const result = await reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: correctionBranch,
      ticketBranch: 'ticket',
      pr: { ...pullRequest(fixture), headRefName: correctionBranch },
    })

    expect(result.kind).toBe('corrected')
    expect(git(fixture.worktreePath, ['branch', '--show-current'])).toBe('ticket')
  })

  it('records permanent merged PR proof mismatches as manual recovery', async () => {
    const fixture = makeFixture()
    const error = await reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: { ...pullRequest(fixture), headRefName: 'different-branch' },
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(EarlyMergeRecoveryManualError)
    if (!(error instanceof EarlyMergeRecoveryManualError)) throw new Error('Expected a permanent proof mismatch')
    expect(error.recovery).toMatchObject({ reason: 'missing_proof' })
    expect(error.message).toContain('does not match head branch ticket')
  })

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

  it('accepts verified merge history when a later commit reverted its content', async () => {
    const fixture = makeFixture({ sameTreeCandidate: true })
    writeFileSync(resolve(fixture.projectPath, 'shared.txt'), 'first\nsecond\n')
    git(fixture.projectPath, ['add', '--', 'shared.txt'])
    commit(fixture.projectPath, 'revert merged content')
    git(fixture.projectPath, ['push', 'origin', 'main'])

    const result = await reconcileMergedPullRequestCandidate({
      ...fixture, externalId: 'TEST-42', baseBranch: 'main', headBranch: 'ticket', pr: pullRequest(fixture),
    })

    expect(result.kind).toBe('equivalent')
    expect(readFileSync(resolve(fixture.projectPath, 'shared.txt'), 'utf8')).toBe('first\nsecond\n')
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.candidateCommitSha)
  })

  it('carries only A-to-B changes onto current origin base and preserves unrelated base updates', async () => {
    const fixture = makeFixture({ binaryCandidate: true })
    for (const [key, value] of [
      ['diff.noprefix', 'true'],
      ['diff.mnemonicPrefix', 'true'],
      ['color.diff', 'always'],
      ['diff.renames', 'true'],
      ['core.quotePath', 'false'],
    ] as const) {
      git(fixture.projectPath, ['config', key, value])
    }

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
    expect(git(fixture.projectPath, ['rev-parse', `refs/looptroop/early-merge/pr-42/corrected-from-${fixture.candidateCommitSha}`])).toBe(result.correctedCandidateSha)

    await expect(reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    })).resolves.toMatchObject({ kind: 'corrected', correctedCandidateSha: result.correctedCandidateSha })
  })

  it('uses the candidate base when it already contains the merged PR', async () => {
    const fixture = makeFixture({ addRemoteOnlyPath: true, squashMerge: true })
    rmSync(resolve(fixture.worktreePath, 'local-only.txt'), { force: true })
    git(fixture.projectPath, ['fetch', 'origin'])
    git(fixture.worktreePath, ['reset', '--hard', 'origin/main'])
    const candidateBase = git(fixture.worktreePath, ['rev-parse', 'HEAD'])
    writeFileSync(resolve(fixture.worktreePath, 'candidate.txt'), 'candidate change\n')
    git(fixture.worktreePath, ['add', '--', 'candidate.txt'])
    const candidateCommitSha = commit(fixture.worktreePath, 'candidate on updated base')
    advanceBase(fixture, 'local-only.txt', 'newer base content\n')

    const result = await reconcileMergedPullRequestCandidate({
      ...fixture,
      candidateCommitSha,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    })

    expect(result.kind).toBe('corrected')
    expect(readFileSync(resolve(fixture.worktreePath, 'candidate.txt'), 'utf8')).toBe('candidate change\n')
    expect(readFileSync(resolve(fixture.worktreePath, 'local-only.txt'), 'utf8')).toBe('newer base content\n')
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD^'])).toBe(git(fixture.projectPath, ['rev-parse', 'origin/main']))
    expect(git(fixture.projectPath, ['merge-base', '--is-ancestor', fixture.landedCommitSha, candidateBase])).toBe('')
  })

  it('completes with distinct proof when the exact remaining delta is already on the remote base', async () => {
    const fixture = makeFixture({ candidateDeltaAlreadyOnRemote: true })

    const result = await reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    })

    expect(result.kind).toBe('already_landed')
    if (result.kind !== 'already_landed') throw new Error('Expected already-landed delta proof')
    expect(result.proof.candidateTreeSha).not.toBe(result.proof.mergedHeadTreeSha)
    expect(result.remoteBaseTreeSha).toBe(git(fixture.projectPath, ['rev-parse', `${result.proof.remoteBaseHead}^{tree}`]))
    expect(readFileSync(resolve(fixture.worktreePath, 'candidate.txt'), 'utf8')).toBe('candidate change\n')
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.candidateCommitSha)
  })

  it('carries an intentional candidate removal onto the updated remote base', async () => {
    const fixture = makeFixture({ candidateRemovesMergedFile: true })

    const result = await reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    })

    expect(result.kind).toBe('corrected')
    expect(existsSync(resolve(fixture.worktreePath, 'shared.txt'))).toBe(false)
    expect(readFileSync(resolve(fixture.worktreePath, 'unrelated.txt'), 'utf8')).toBe('base update preserved\n')
  })

  it('leaves a failed remote fetch retryable and reconciles after connectivity returns', async () => {
    const fixture = makeFixture()
    git(fixture.projectPath, ['remote', 'set-url', 'origin', resolve(fixture.remotePath, 'missing.git')])

    const firstAttempt = await reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    }).catch((error) => error)
    expect(firstAttempt).not.toBeInstanceOf(EarlyMergeRecoveryManualError)
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.candidateCommitSha)
    expect(git(fixture.projectPath, ['worktree', 'list', '--porcelain'])).not.toContain('merge-recovery')

    git(fixture.projectPath, ['remote', 'set-url', 'origin', fixture.remotePath])
    await expect(reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    })).resolves.toMatchObject({ kind: 'corrected' })
  })

  it('reuses a clean recovery checkout left at the verified base by an interrupted attempt', async () => {
    const fixture = makeFixture()
    git(fixture.projectPath, ['fetch', 'origin'])
    const remoteBaseHead = git(fixture.projectPath, ['rev-parse', 'refs/remotes/origin/main'])
    const recoveryWorktreePath = resolve(
      fixture.projectPath,
      '.looptroop',
      'merge-recovery',
      `pr-42-${fixture.candidateCommitSha}-${remoteBaseHead}`,
    )
    mkdirSync(resolve(fixture.projectPath, '.looptroop', 'merge-recovery'), { recursive: true })
    git(fixture.projectPath, ['worktree', 'add', '--detach', recoveryWorktreePath, remoteBaseHead])

    await expect(reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    })).resolves.toMatchObject({ kind: 'corrected' })
    expect(existsSync(recoveryWorktreePath)).toBe(false)
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD^'])).toBe(remoteBaseHead)
  })

  it('restarts recovery when a conflict checkout disappears before any resolution was saved', async () => {
    const fixture = makeFixture({ conflictOnBaseUpdate: true })
    const error = await reconcileFixture(fixture).catch((caught) => caught)
    expect(error).toBeInstanceOf(EarlyMergeRecoveryManualError)
    if (!(error instanceof EarlyMergeRecoveryManualError) || !error.proof) throw new Error('Expected a proven manual conflict')
    const oldBase = error.proof.remoteBaseHead
    const oldRecoveryPath = error.recovery.recoveryWorktreePath!
    git(fixture.projectPath, ['worktree', 'remove', '--force', oldRecoveryPath])
    const latestBase = advanceBase(fixture, 'shared.txt', 'first\nmerged PR change\n')

    const retry = await reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      previousRecoveryBaseHead: oldBase,
      pr: pullRequest(fixture),
    })

    expect(retry).toMatchObject({ kind: 'corrected', proof: { remoteBaseHead: latestBase } })
    if (retry.kind !== 'corrected') throw new Error('Expected recovery to restart from the original candidate')
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(retry.correctedCandidateSha)
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD^'])).toBe(latestBase)
    expect(readFileSync(resolve(fixture.worktreePath, 'shared.txt'), 'utf8')).toBe('first\ncandidate change\n')
    expect(existsSync(oldRecoveryPath)).toBe(false)
  })

  it('recognizes a recovery checkout through a symlinked project path', async () => {
    const fixture = makeFixture()
    const projectAlias = resolve(fixture.projectPath, '..', 'project-alias')
    symlinkSync(fixture.projectPath, projectAlias, process.platform === 'win32' ? 'junction' : 'dir')
    git(projectAlias, ['fetch', 'origin'])
    const remoteBaseHead = git(projectAlias, ['rev-parse', 'refs/remotes/origin/main'])
    const recoveryWorktreePath = resolve(
      fixture.projectPath,
      '.looptroop',
      'merge-recovery',
      `pr-42-${fixture.candidateCommitSha}-${remoteBaseHead}`,
    )
    mkdirSync(resolve(fixture.projectPath, '.looptroop', 'merge-recovery'), { recursive: true })
    git(fixture.projectPath, ['worktree', 'add', '--detach', recoveryWorktreePath, remoteBaseHead])

    await expect(reconcileMergedPullRequestCandidate({
      ...fixture,
      projectPath: projectAlias,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    })).resolves.toMatchObject({ kind: 'corrected' })
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD^'])).toBe(remoteBaseHead)
  })

  it('replaces a removed recovery checkout without pruning unrelated worktrees', async () => {
    const fixture = makeFixture()
    git(fixture.projectPath, ['fetch', 'origin'])
    const remoteBaseHead = git(fixture.projectPath, ['rev-parse', 'refs/remotes/origin/main'])
    const recoveryWorktreePath = resolve(
      fixture.projectPath,
      '.looptroop',
      'merge-recovery',
      `pr-42-${fixture.candidateCommitSha}-${remoteBaseHead}`,
    )
    mkdirSync(resolve(fixture.projectPath, '.looptroop', 'merge-recovery'), { recursive: true })
    git(fixture.projectPath, ['worktree', 'add', '--detach', recoveryWorktreePath, remoteBaseHead])
    const unrelatedStaleWorktree = resolve(fixture.projectPath, '..', 'unrelated-stale-worktree')
    git(fixture.projectPath, ['worktree', 'add', '--detach', unrelatedStaleWorktree, remoteBaseHead])
    rmSync(recoveryWorktreePath, { recursive: true, force: true })
    rmSync(unrelatedStaleWorktree, { recursive: true, force: true })

    await expect(reconcileFixture(fixture)).resolves.toMatchObject({ kind: 'corrected' })
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD^'])).toBe(remoteBaseHead)
    const worktrees = git(fixture.projectPath, ['worktree', 'list', '--porcelain'])
    const listedWorktrees = worktrees.split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => normalizedPath(line.slice('worktree '.length)))
    expect(listedWorktrees).not.toContain(normalizedPath(recoveryWorktreePath))
    expect(listedWorktrees).toContain(normalizedPath(unrelatedStaleWorktree))
  })

  it('adopts a committed manual resolution on retry and preserves the original merged PR ref', async () => {
    const fixture = makeFixture({ conflictOnBaseUpdate: true })
    const untrackedPath = resolve(fixture.worktreePath, 'draft.md')
    writeFileSync(untrackedPath, 'keep this untracked draft\n')

    const error = await reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    }).catch((caught) => caught)
    expect(error).toBeInstanceOf(EarlyMergeRecoveryManualError)
    if (!(error instanceof EarlyMergeRecoveryManualError)) throw new Error('Expected manual recovery error')
    expect(error.recovery).toMatchObject({ reason: 'conflict', conflictPaths: ['shared.txt'] })
    expect(error.recovery.recoveryWorktreePath).toContain(fixture.candidateCommitSha)
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.candidateCommitSha)
    expect(readFileSync(resolve(fixture.worktreePath, 'shared.txt'), 'utf8')).toBe('first\ncandidate change\n')
    expect(readFileSync(untrackedPath, 'utf8')).toBe('keep this untracked draft\n')

    const recoveryWorktreePath = error.recovery.recoveryWorktreePath!
    const manualResolution = 'manual resolution preserved\n'
    writeFileSync(resolve(recoveryWorktreePath, 'shared.txt'), manualResolution)
    git(recoveryWorktreePath, ['add', '--', 'shared.txt'])
    const resolvedCommit = commit(recoveryWorktreePath, 'resolve early merge conflict')
    const retry = await reconcileFixture(fixture)

    expect(retry).toMatchObject({ kind: 'corrected', correctedCandidateSha: resolvedCommit })
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(resolvedCommit)
    expect(readFileSync(resolve(fixture.worktreePath, 'shared.txt'), 'utf8')).toBe(manualResolution)
    expect(readFileSync(untrackedPath, 'utf8')).toBe('keep this untracked draft\n')
    expect(existsSync(recoveryWorktreePath)).toBe(false)
    expect(git(fixture.remotePath, ['rev-parse', 'refs/pull/42/head'])).toBe(fixture.mergedHeadSha)
  }, 45_000)

  it('finishes from the verified merge when a manual resolution leaves no changes', async () => {
    const fixture = makeFixture({ conflictOnBaseUpdate: true })
    const error = await reconcileFixture(fixture).catch((caught) => caught)
    expect(error).toBeInstanceOf(EarlyMergeRecoveryManualError)
    if (!(error instanceof EarlyMergeRecoveryManualError) || !error.proof) throw new Error('Expected a proven manual conflict')
    const oldBase = error.proof.remoteBaseHead
    const oldRecoveryPath = error.recovery.recoveryWorktreePath!
    writeFileSync(resolve(oldRecoveryPath, 'shared.txt'), 'first\nremote base update\n')
    git(oldRecoveryPath, ['add', '--', 'shared.txt'])
    commit(oldRecoveryPath, 'keep the current base version', true)
    const latestBase = advanceBase(fixture, 'latest.txt', 'later base change\n')

    const result = await reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      previousRecoveryBaseHead: oldBase,
      pr: pullRequest(fixture),
    })

    expect(result).toMatchObject({
      kind: 'already_landed', manualResolutionNoChange: true, proof: { remoteBaseHead: latestBase },
    })
    expect(readFileSync(resolve(fixture.worktreePath, 'shared.txt'), 'utf8')).toBe('first\ncandidate change\n')
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.candidateCommitSha)
    expect(existsSync(oldRecoveryPath)).toBe(false)
  }, 45_000)

  it('finishes from the verified merge when a manual resolution commits the base tree unchanged', async () => {
    const fixture = makeFixture({ conflictOnBaseUpdate: true })
    const error = await reconcileFixture(fixture).catch((caught) => caught)
    expect(error).toBeInstanceOf(EarlyMergeRecoveryManualError)
    if (!(error instanceof EarlyMergeRecoveryManualError) || !error.proof) throw new Error('Expected a proven manual conflict')
    const recoveryWorktreePath = error.recovery.recoveryWorktreePath!
    const baseHead = error.proof.remoteBaseHead
    writeFileSync(resolve(recoveryWorktreePath, 'shared.txt'), 'first\nremote base update\n')
    git(recoveryWorktreePath, ['add', '--', 'shared.txt'])
    commit(recoveryWorktreePath, 'keep the base version', true)

    const result = await reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      previousRecoveryBaseHead: baseHead,
      pr: pullRequest(fixture),
    })

    expect(result).toMatchObject({ kind: 'already_landed', manualResolutionNoChange: true, proof: { remoteBaseHead: baseHead } })
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.candidateCommitSha)
    expect(existsSync(recoveryWorktreePath)).toBe(false)
  }, 45_000)

  it('retains the checkout base across a dirty retry before refreshing a later committed resolution', async () => {
    const fixture = makeFixture({ conflictOnBaseUpdate: true })
    const firstError = await reconcileFixture(fixture).catch((caught) => caught)
    expect(firstError).toBeInstanceOf(EarlyMergeRecoveryManualError)
    if (!(firstError instanceof EarlyMergeRecoveryManualError) || !firstError.proof) {
      throw new Error('Expected a proven manual conflict')
    }
    const recoveryWorktreePath = firstError.recovery.recoveryWorktreePath!
    const recoveryBaseHead = firstError.proof.remoteBaseHead
    expect(firstError.recovery.recoveryWorktreeBaseHead).toBe(recoveryBaseHead)

    const latestBase = advanceBase(fixture, 'latest.txt', 'later base change\n')
    const dirtyRetry = await reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      previousRecoveryBaseHead: recoveryBaseHead,
      pr: pullRequest(fixture),
    }).catch((caught) => caught)

    expect(dirtyRetry).toBeInstanceOf(EarlyMergeRecoveryManualError)
    if (!(dirtyRetry instanceof EarlyMergeRecoveryManualError) || !dirtyRetry.proof) {
      throw new Error('Expected the dirty recovery checkout to remain manual')
    }
    expect(dirtyRetry.proof.remoteBaseHead).toBe(latestBase)
    expect(dirtyRetry.recovery).toMatchObject({
      recoveryWorktreePath,
      recoveryWorktreeBaseHead: recoveryBaseHead,
    })

    const manualResolution = 'manual resolution preserved\n'
    writeFileSync(resolve(recoveryWorktreePath, 'shared.txt'), manualResolution)
    git(recoveryWorktreePath, ['add', '--', 'shared.txt'])
    const resolvedCommit = commit(recoveryWorktreePath, 'resolve early merge conflict')
    const result = await reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      previousRecoveryBaseHead: dirtyRetry.recovery.recoveryWorktreeBaseHead!,
      pr: pullRequest(fixture),
    })

    expect(result).toMatchObject({ kind: 'corrected', correctedCandidateSha: expect.any(String), proof: { remoteBaseHead: latestBase } })
    expect(readFileSync(resolve(fixture.worktreePath, 'shared.txt'), 'utf8')).toBe(manualResolution)
    expect(readFileSync(resolve(fixture.worktreePath, 'latest.txt'), 'utf8')).toBe('later base change\n')
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD^'])).toBe(latestBase)
    expect(git(fixture.projectPath, ['rev-parse', resolvedCommit])).toBe(resolvedCommit)
  }, 45_000)

  it('applies the remaining change when the latest base changes a different line in the same file', async () => {
    const fixture = makeFixture({ candidateUpdatesMergedFile: true })
    const latestBase = advanceBase(fixture, 'shared.txt', 'first\nmerged PR change\nremote base addition\n')

    const result = await reconcileMergedPullRequestCandidate({
      ...fixture, externalId: 'TEST-42', baseBranch: 'main', headBranch: 'ticket', pr: pullRequest(fixture),
    })

    expect(result).toMatchObject({ kind: 'corrected', proof: { remoteBaseHead: latestBase } })
    expect(readFileSync(resolve(fixture.worktreePath, 'shared.txt'), 'utf8'))
      .toBe('candidate prefix\nmerged PR change\nremote base addition\n')
  }, 45_000)

  describe.each([false, true])('saved correction retries (local work blocked installation: %s)', (blocked) => {
    let fixture: ReturnType<typeof makeFixture>
    let originalCorrection: string
    let originalBase: string
    let oldCheckout: string

    beforeEach(async () => {
      fixture = makeFixture({ addRemoteOnlyPath: blocked })
      const first = await reconcileFixture(fixture).catch((error: unknown) => error)
      if (blocked) expect(first).toMatchObject({ recovery: { reason: 'local_work_preserved' } })
      else expect(first).toMatchObject({ kind: 'corrected' })
      originalCorrection = git(fixture.projectPath, ['rev-parse', `refs/looptroop/early-merge/pr-42/corrected-from-${fixture.candidateCommitSha}`])
      originalBase = git(fixture.projectPath, ['rev-parse', `${originalCorrection}^`])
      oldCheckout = resolve(fixture.projectPath, '.looptroop', 'merge-recovery', `pr-42-${fixture.candidateCommitSha}-${originalBase}`)
    })

    it('refreshes the original remaining changes on the latest base and preserves the earlier correction', async () => {
      const backup = resolve(fixture.worktreePath, '..', 'preserved-local-only.txt')
      if (blocked) renameSync(resolve(fixture.worktreePath, 'local-only.txt'), backup)
      const latestBase = advanceBase(fixture, 'later.txt', 'newer base work\n')

      const result = await reconcileMergedPullRequestCandidate({
        ...fixture,
        externalId: 'TEST-42',
        baseBranch: 'main',
        headBranch: 'ticket',
        previousRecoveryBaseHead: originalBase,
        pr: pullRequest(fixture),
      })

      expect(result.kind).toBe('corrected')
      if (result.kind !== 'corrected') throw new Error('Expected a refreshed correction')
      expect(result.correctedCandidateSha).not.toBe(originalCorrection)
      expect(result.proof.remoteBaseHead).toBe(latestBase)
      expect(git(fixture.worktreePath, ['rev-parse', 'HEAD^'])).toBe(latestBase)
      expect(readFileSync(resolve(fixture.worktreePath, 'later.txt'), 'utf8')).toBe('newer base work\n')
      expect(readFileSync(resolve(fixture.worktreePath, 'candidate.txt'), 'utf8')).toBe('candidate change\n')
      expect(git(fixture.projectPath, ['rev-parse', `refs/looptroop/early-merge/pr-42/candidate-${fixture.candidateCommitSha}-corrected-${originalCorrection}`])).toBe(originalCorrection)
      if (blocked) {
        expect(existsSync(oldCheckout)).toBe(false)
        expect(readFileSync(backup, 'utf8')).toBe('local-only data\n')
      }
    })

    if (blocked) {
      it('preserves both saved work and the ticket candidate when the refreshed patch conflicts', async () => {
        const latestBase = advanceBase(fixture, 'candidate.txt', 'conflicting newer base work\n')

        const result = await reconcileFixture(fixture).catch((error: unknown) => error)

        expect(result).toMatchObject({ recovery: { reason: 'conflict', conflictPaths: ['candidate.txt'] } })
        if (!(result instanceof EarlyMergeRecoveryManualError)) throw new Error('Expected a preserved conflict')
        expect(result.recovery.recoveryWorktreePath).toContain(latestBase)
        expect(result.recovery.recoveryWorktreePath).not.toBe(oldCheckout)
        expect(git(oldCheckout, ['rev-parse', 'HEAD'])).toBe(originalCorrection)
        expect(git(fixture.projectPath, ['rev-parse', `refs/looptroop/early-merge/pr-42/corrected-from-${fixture.candidateCommitSha}`])).toBe(originalCorrection)
        expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.candidateCommitSha)
        expect(readFileSync(resolve(fixture.worktreePath, 'local-only.txt'), 'utf8')).toBe('local-only data\n')
      })
    }

    if (!blocked) {
      it('refreshes the saved correction after the base history is rewritten', async () => {
        const originalCorrectionHead = git(fixture.worktreePath, ['rev-parse', 'HEAD'])

        git(fixture.projectPath, ['checkout', '--detach', fixture.landedCommitSha])
        git(fixture.projectPath, ['checkout', '-b', 'rewritten-main'])
        writeFileSync(resolve(fixture.projectPath, 'replacement-base.txt'), 'replacement base\n')
        git(fixture.projectPath, ['add', '--', 'replacement-base.txt'])
        commit(fixture.projectPath, 'replacement base history')
        git(fixture.projectPath, ['push', '--force', 'origin', 'rewritten-main:main'])

        const result = await reconcileMergedPullRequestCandidate({
          ...fixture,
          externalId: 'TEST-42',
          baseBranch: 'main',
          headBranch: 'ticket',
          previousRecoveryBaseHead: originalBase,
          pr: pullRequest(fixture),
        })

        expect(result).toMatchObject({ kind: 'corrected', proof: { remoteBaseHead: expect.any(String) } })
        if (result.kind !== 'corrected') throw new Error('Expected the saved correction to refresh')
        expect(result.proof.remoteBaseHead).not.toBe(originalBase)
        expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(result.correctedCandidateSha)
        expect(result.correctedCandidateSha).not.toBe(originalCorrectionHead)
        expect(readFileSync(resolve(fixture.worktreePath, 'candidate.txt'), 'utf8')).toBe('candidate change\n')
        expect(readFileSync(resolve(fixture.worktreePath, 'replacement-base.txt'), 'utf8')).toBe('replacement base\n')
      })
    }
  })

  describe('retrying an installed correction', () => {
    let fixture: ReturnType<typeof makeFixture>

    beforeEach(async () => {
      fixture = makeFixture()
      await expect(reconcileFixture(fixture)).resolves.toMatchObject({ kind: 'corrected' })
    })

    it('resumes a refreshed correction after local files prevented its installation', async () => {
      const originalInstalledHead = git(fixture.worktreePath, ['rev-parse', 'HEAD'])
      const originalBase = git(fixture.worktreePath, ['rev-parse', 'HEAD^'])
      writeFileSync(resolve(fixture.worktreePath, 'later.txt'), 'local draft to preserve\n')
      const latestBase = advanceBase(fixture, 'later.txt', 'newer tracked base file\n')
      await expect(reconcileMergedPullRequestCandidate({
        ...fixture,
        externalId: 'TEST-42',
        baseBranch: 'main',
        headBranch: 'ticket',
        previousRecoveryBaseHead: originalBase,
        pr: pullRequest(fixture),
      })).rejects.toMatchObject({ recovery: { reason: 'local_work_preserved' } })
      expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(originalInstalledHead)
      const refreshedHead = git(fixture.projectPath, ['rev-parse', `refs/looptroop/early-merge/pr-42/corrected-from-${fixture.candidateCommitSha}`])
      const backup = resolve(fixture.worktreePath, '..', 'preserved-later.txt')
      renameSync(resolve(fixture.worktreePath, 'later.txt'), backup)

      await expect(reconcileMergedPullRequestCandidate({
        ...fixture,
        externalId: 'TEST-42',
        baseBranch: 'main',
        headBranch: 'ticket',
        previousRecoveryBaseHead: originalBase,
        pr: pullRequest(fixture),
      })).resolves.toMatchObject({
        kind: 'corrected', correctedCandidateSha: refreshedHead, proof: { remoteBaseHead: latestBase },
      })

      expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(refreshedHead)
      expect(readFileSync(backup, 'utf8')).toBe('local draft to preserve\n')
      expect(readFileSync(resolve(fixture.worktreePath, 'later.txt'), 'utf8')).toBe('newer tracked base file\n')
    })

    it('completes when the newer base already contains the saved correction delta', async () => {
      const originalCorrection = git(fixture.worktreePath, ['rev-parse', 'HEAD'])
      const originalBase = git(fixture.worktreePath, ['rev-parse', 'HEAD^'])
      const latestBase = advanceBase(fixture, 'candidate.txt', 'candidate change\n')

      await expect(reconcileMergedPullRequestCandidate({
        ...fixture,
        externalId: 'TEST-42',
        baseBranch: 'main',
        headBranch: 'ticket',
        previousRecoveryBaseHead: originalBase,
        pr: pullRequest(fixture),
      })).resolves.toMatchObject({
        kind: 'already_landed', proof: { remoteBaseHead: latestBase },
      })
      expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(originalCorrection)
    })
  })

  it('preserves an untracked file that the new remote base would track', async () => {
    const fixture = makeFixture({ addRemoteOnlyPath: true })

    await expect(reconcileMergedPullRequestCandidate({
      ...fixture,
      externalId: 'TEST-42',
      baseBranch: 'main',
      headBranch: 'ticket',
      pr: pullRequest(fixture),
    })).rejects.toMatchObject({ recovery: { reason: 'local_work_preserved', conflictPaths: [] } })
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.candidateCommitSha)
    expect(readFileSync(resolve(fixture.worktreePath, 'local-only.txt'), 'utf8')).toBe('local-only data\n')
  })
})
