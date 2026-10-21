import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { assertSafeRefName } from './ref'
import {
  ensureNoTrackedWorktreeChanges,
  ensureNoUntrackedPathsClobberedBy,
  ensureNoUntrackedPathsOverwrittenBy,
  fetchPullRequestHead,
  readGitTreeSha,
  verifyRemoteBaseContainsCommit,
  type PullRequestInfo,
} from './github'
import { getCurrentBranch } from './repository'
import { readWorktreeGitHookPolicy, shouldBypassGitHooks } from './hookPolicy'
import { gitSyncSucceeds, runGit, runGitMutationOrThrow, runGitSyncOrThrow } from './runCommand'

export interface EarlyMergeProof {
  prNumber: number
  prUrl: string
  candidateCommitSha: string
  candidateTreeSha: string
  mergedHeadSha: string
  mergedHeadTreeSha: string
  landedCommitSha: string
  remoteBaseHead: string
}

export interface EarlyMergeManualRecovery {
  reason: 'missing_proof' | 'conflict'
  message: string
  recoveryWorktreePath: string | null
  conflictPaths: string[]
}

export class EarlyMergeRecoveryManualError extends Error {
  constructor(readonly recovery: EarlyMergeManualRecovery, readonly proof: EarlyMergeProof | null = null) {
    super(recovery.message)
    this.name = 'EarlyMergeRecoveryManualError'
  }
}

export type EarlyMergeReconciliation =
  | { kind: 'equivalent'; proof: EarlyMergeProof }
  | { kind: 'corrected'; proof: EarlyMergeProof; correctedCandidateSha: string; recoveryWorktreePath: string | null }

function git(projectPath: string, args: string[]): Promise<string> {
  return runGit(projectPath, args, { trimOutput: false }).then((result) => {
    if (!result.ok) throw new Error(result.errorDetail)
    return result.stdout
  })
}

function captureCommitRef(projectPath: string, name: string, sha: string): Promise<void> {
  return runGitMutationOrThrow(projectPath, ['update-ref', name, sha]).then(() => undefined)
}

function conflictPaths(projectPath: string): string[] {
  try {
    return runGitSyncOrThrow(projectPath, ['diff', '--name-only', '--diff-filter=U', '-z'], { trimOutput: false })
      .split('\0')
      .filter(Boolean)
  } catch {
    return []
  }
}

function protectTicketWorktreeForCorrection(
  worktreePath: string,
  candidateCommitSha: string,
  correctedCandidateSha: string,
): void {
  const operation = 'early-merge candidate correction'
  ensureNoTrackedWorktreeChanges(worktreePath, operation)
  ensureNoUntrackedPathsClobberedBy(worktreePath, correctedCandidateSha, operation)
  const changedPaths = runGitSyncOrThrow(
    worktreePath,
    ['diff', '--name-only', '--no-renames', '-z', candidateCommitSha, correctedCandidateSha],
    { trimOutput: false },
  ).split('\0').filter(Boolean)
  ensureNoUntrackedPathsOverwrittenBy(worktreePath, changedPaths, operation)
}

function manualError(input: {
  reason: EarlyMergeManualRecovery['reason']
  pr: PullRequestInfo
  candidateCommitSha: string
  recoveryWorktreePath?: string | null
  conflictPaths?: string[]
  detail: string
  proof?: EarlyMergeProof | null
}): EarlyMergeRecoveryManualError {
  const recoveryWorktreePath = input.recoveryWorktreePath ?? null
  const conflictPaths = input.conflictPaths ?? []
  return new EarlyMergeRecoveryManualError({
    reason: input.reason,
    recoveryWorktreePath,
    conflictPaths,
    message: [
      `Pull request #${input.pr.number} was already merged, but LoopTroop could not safely reconcile candidate ${input.candidateCommitSha}.`,
      input.detail,
      recoveryWorktreePath
        ? `The ticket worktree was left untouched. A recovery checkout remains at ${recoveryWorktreePath}${conflictPaths.length ? ` (conflicts: ${conflictPaths.join(', ')})` : ''}. Inspect both checkouts and resolve the merge manually; LoopTroop will not guess or resume automatically from that checkout.`
        : 'The original ticket worktree was preserved. Review the merge and candidate manually; LoopTroop will not guess a resolution.',
    ].join(' '),
  }, input.proof ?? null)
}

function protectTicketWorktreeForCorrectionOrStop(input: {
  worktreePath: string
  candidateCommitSha: string
  correctedCandidateSha: string
  recoveryWorktreePath: string
  pr: PullRequestInfo
  proof: EarlyMergeProof
}): void {
  try {
    protectTicketWorktreeForCorrection(input.worktreePath, input.candidateCommitSha, input.correctedCandidateSha)
  } catch (error) {
    throw manualError({
      reason: 'conflict',
      pr: input.pr,
      candidateCommitSha: input.candidateCommitSha,
      recoveryWorktreePath: existsSync(input.recoveryWorktreePath) ? input.recoveryWorktreePath : null,
      proof: input.proof,
      detail: `The ticket worktree was not reset because local files would be lost or tracked changes are present: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

function validateMergedPullRequest(input: {
  pr: PullRequestInfo
  baseBranch: string
  headBranch: string
  candidateCommitSha: string
}): void {
  if (input.pr.state !== 'merged') throw new Error(`Pull request #${input.pr.number} is not merged.`)
  if (input.pr.baseRefName !== input.baseBranch || input.pr.headRefName !== input.headBranch) {
    throw new Error(`Pull request #${input.pr.number} does not match ticket branch ${input.headBranch} and base ${input.baseBranch}.`)
  }
  if (!/^[0-9a-f]{40,64}$/i.test(input.candidateCommitSha)) {
    throw new Error('The approved candidate commit SHA is missing or invalid.')
  }
  if (!input.pr.headRefOid || !/^[0-9a-f]{40,64}$/i.test(input.pr.headRefOid)) {
    throw new Error(`Pull request #${input.pr.number} does not expose a full head commit SHA.`)
  }
  if (!input.pr.mergeCommitSha || !/^[0-9a-f]{40,64}$/i.test(input.pr.mergeCommitSha)) {
    throw new Error(`Pull request #${input.pr.number} does not expose a full landed commit SHA.`)
  }
}

/** Proves a merged PR and, when needed, carries only its head-to-candidate delta forward. */
export async function reconcileMergedPullRequestCandidate(input: {
  projectPath: string
  worktreePath: string
  externalId: string
  baseBranch: string
  headBranch: string
  candidateCommitSha: string
  pr: PullRequestInfo
}): Promise<EarlyMergeReconciliation> {
  try {
    validateMergedPullRequest(input)
    const remote = await verifyRemoteBaseContainsCommit(input.projectPath, input.baseBranch, input.pr.mergeCommitSha!)
    const mergedHeadSha = await fetchPullRequestHead(input.projectPath, input.pr.number, input.pr.headRefOid!)
    if (mergedHeadSha !== input.pr.headRefOid) {
      throw new Error(`GitHub's pull request head ${input.pr.headRefOid} does not match fetched commit ${mergedHeadSha}.`)
    }
    const candidateTreeSha = readGitTreeSha(input.projectPath, input.candidateCommitSha)
    const mergedHeadTreeSha = readGitTreeSha(input.projectPath, mergedHeadSha)
    const proof: EarlyMergeProof = {
      prNumber: input.pr.number,
      prUrl: input.pr.url,
      candidateCommitSha: input.candidateCommitSha,
      candidateTreeSha,
      mergedHeadSha,
      mergedHeadTreeSha,
      landedCommitSha: input.pr.mergeCommitSha!,
      remoteBaseHead: remote.remoteBaseHead,
    }
    if (candidateTreeSha === mergedHeadTreeSha) return { kind: 'equivalent', proof }

    assertSafeRefName(input.baseBranch, 'Base branch')
    if (!/^[0-9a-f]{40,64}$/i.test(remote.remoteBaseHead)) {
      throw new Error('The fetched remote base did not resolve to a full commit SHA.')
    }
    const recoveryWorktreePath = resolve(input.projectPath, '.looptroop', 'merge-recovery', `pr-${input.pr.number}-${input.candidateCommitSha.slice(0, 12)}`)
    const refRoot = `refs/looptroop/early-merge/pr-${input.pr.number}`
    const correctionRef = `${refRoot}/corrected-from-${input.candidateCommitSha}`
    if (gitSyncSucceeds(input.projectPath, ['show-ref', '--verify', '--quiet', correctionRef])) {
      const correctedCandidateSha = runGitSyncOrThrow(input.projectPath, ['rev-parse', correctionRef])
      const ticketHead = runGitSyncOrThrow(input.worktreePath, ['rev-parse', 'HEAD'])
      if (ticketHead !== input.candidateCommitSha && ticketHead !== correctedCandidateSha) {
        throw new Error('A previously prepared correction exists, but the ticket worktree has moved to another commit.')
      }
      if (getCurrentBranch(input.worktreePath) !== input.headBranch) {
        throw new Error('The ticket worktree is no longer on its ticket branch.')
      }
      if (ticketHead === input.candidateCommitSha) {
        protectTicketWorktreeForCorrectionOrStop({
          worktreePath: input.worktreePath,
          candidateCommitSha: input.candidateCommitSha,
          correctedCandidateSha,
          recoveryWorktreePath,
          pr: input.pr,
          proof,
        })
        await runGitMutationOrThrow(input.worktreePath, ['reset', '--hard', correctedCandidateSha])
      }
      return {
        kind: 'corrected', proof, correctedCandidateSha,
        recoveryWorktreePath: existsSync(recoveryWorktreePath) ? recoveryWorktreePath : null,
      }
    }
    if (existsSync(recoveryWorktreePath)) {
      throw new Error(`A recovery worktree already exists at ${recoveryWorktreePath}; it was left untouched.`)
    }
    ensureNoTrackedWorktreeChanges(input.worktreePath, 'early-merge candidate correction')
    if (runGitSyncOrThrow(input.worktreePath, ['rev-parse', 'HEAD']) !== input.candidateCommitSha
      || getCurrentBranch(input.worktreePath) !== input.headBranch) {
      throw new Error('The ticket worktree no longer points to the approved candidate on its ticket branch.')
    }
    mkdirSync(dirname(recoveryWorktreePath), { recursive: true })

    const patch = await git(input.projectPath, [
      'diff', '--binary', '--full-index', '--no-ext-diff', mergedHeadSha, input.candidateCommitSha,
    ])
    if (!patch) throw new Error('The candidate trees differ, but Git produced no A-to-B patch.')

    for (const [name, sha] of [
      [`${refRoot}/head-${mergedHeadSha}`, mergedHeadSha],
      [`${refRoot}/candidate-${input.candidateCommitSha}`, input.candidateCommitSha],
      [`${refRoot}/landed-${proof.landedCommitSha}`, proof.landedCommitSha],
    ] as const) {
      await captureCommitRef(input.projectPath, name, sha)
    }

    await runGitMutationOrThrow(input.projectPath, ['worktree', 'add', '--detach', recoveryWorktreePath, remote.remoteBaseHead])
    try {
      const applied = await runGit(recoveryWorktreePath, ['apply', '--3way', '--binary'], { input: patch })
      if (!applied.ok) {
        throw manualError({
          reason: 'conflict',
          pr: input.pr,
          candidateCommitSha: input.candidateCommitSha,
          recoveryWorktreePath,
          conflictPaths: conflictPaths(recoveryWorktreePath),
          proof,
          detail: `The A-to-B patch could not be applied cleanly to origin/${input.baseBranch}@${remote.remoteBaseHead}: ${applied.errorDetail}`,
        })
      }

      const bypassHooks = shouldBypassGitHooks(readWorktreeGitHookPolicy(input.worktreePath))
      await runGitMutationOrThrow(recoveryWorktreePath, [
        '-c', 'user.name=LoopTroop',
        '-c', 'user.email=looptroop@local',
        'commit',
        ...(bypassHooks ? ['--no-verify'] : []),
        '-m', `${input.externalId}: carry candidate changes after merged PR #${input.pr.number}`,
      ])
      const correctedCandidateSha = runGitSyncOrThrow(recoveryWorktreePath, ['rev-parse', 'HEAD'])
      if (runGitSyncOrThrow(recoveryWorktreePath, ['rev-parse', 'HEAD^']) !== remote.remoteBaseHead) {
        throw new Error('The corrected candidate is not based directly on the verified current origin base.')
      }
      await captureCommitRef(input.projectPath, `${refRoot}/corrected-${correctedCandidateSha}`, correctedCandidateSha)
      await captureCommitRef(input.projectPath, correctionRef, correctedCandidateSha)

      if (runGitSyncOrThrow(input.worktreePath, ['rev-parse', 'HEAD']) !== input.candidateCommitSha
        || getCurrentBranch(input.worktreePath) !== input.headBranch) {
        throw new Error('The ticket worktree changed before the corrected candidate could be installed.')
      }
      protectTicketWorktreeForCorrectionOrStop({
        worktreePath: input.worktreePath,
        candidateCommitSha: input.candidateCommitSha,
        correctedCandidateSha,
        recoveryWorktreePath,
        pr: input.pr,
        proof,
      })
      await runGitMutationOrThrow(input.worktreePath, ['reset', '--hard', correctedCandidateSha])
      let retainedRecoveryWorktreePath: string | null = recoveryWorktreePath
      try {
        await runGitMutationOrThrow(input.projectPath, ['worktree', 'remove', recoveryWorktreePath])
        retainedRecoveryWorktreePath = null
      } catch {
        // The corrected commit is already referenced and installed; a clean recovery checkout is harmless to retain.
      }
      return { kind: 'corrected', proof, correctedCandidateSha, recoveryWorktreePath: retainedRecoveryWorktreePath }
    } catch (error) {
      if (error instanceof EarlyMergeRecoveryManualError) throw error
      throw manualError({
        reason: 'missing_proof',
        pr: input.pr,
        candidateCommitSha: input.candidateCommitSha,
        recoveryWorktreePath: existsSync(recoveryWorktreePath) ? recoveryWorktreePath : null,
        conflictPaths: existsSync(recoveryWorktreePath) ? conflictPaths(recoveryWorktreePath) : [],
        proof,
        detail: `Corrective recovery stopped without changing the ticket worktree: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  } catch (error) {
    if (error instanceof EarlyMergeRecoveryManualError) throw error
    throw manualError({
      reason: 'missing_proof',
      pr: input.pr,
      candidateCommitSha: input.candidateCommitSha,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
