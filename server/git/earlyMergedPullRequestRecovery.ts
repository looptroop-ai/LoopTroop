import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { assertSafeRefName } from './ref'
import {
  decodeGitPathList,
  ensureNoTrackedWorktreeChanges,
  ensureNoUntrackedPathsClobberedBy,
  ensureNoUntrackedPathsOverwrittenBy,
  fetchPullRequestHead,
  PullRequestHeadProofError,
  readGitTreeSha,
  RemoteBaseProofError,
  verifyRemoteBaseContainsCommit,
  type PullRequestInfo,
  type RemoteBaseVerification,
} from './github'
import { getCurrentBranch } from './repository'
import { readWorktreeGitHookPolicy, shouldBypassGitHooks } from './hookPolicy'
import { RunCommandTimeoutError, runGitBinarySync, runGitMutationOrThrow, runGitSync, runGitSyncOrThrow, type RunCommandOptions } from './runCommand'

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
  reason: 'missing_proof' | 'conflict' | 'local_work_preserved'
  message: string
  recoveryWorktreePath: string | null
  recoveryWorktreeBaseHead?: string | null
  conflictPaths: string[]
}

export class EarlyMergeRecoveryManualError extends Error {
  constructor(readonly recovery: EarlyMergeManualRecovery, readonly proof: EarlyMergeProof | null = null) {
    super(recovery.message)
    this.name = 'EarlyMergeRecoveryManualError'
  }
}

class LocalWorkProtectionError extends Error {}

export type EarlyMergeReconciliation =
  | { kind: 'equivalent'; proof: EarlyMergeProof }
  | { kind: 'already_landed'; proof: EarlyMergeProof; remoteBaseTreeSha: string; manualResolutionNoChange?: boolean }
  | { kind: 'corrected'; proof: EarlyMergeProof; correctedCandidateSha: string; recoveryWorktreePath: string | null }

function gitSync(projectPath: string, args: string[], options?: RunCommandOptions): string {
  const result = runGitSync(projectPath, args, options)
  if (!result.ok) {
    if (result.timedOut) throw new RunCommandTimeoutError(result.errorDetail)
    throw new Error(result.errorDetail)
  }
  return result.stdout
}

function comparableWorktreePath(path: string): string {
  const absolute = resolve(path)
  const canonical = existsSync(absolute)
    ? realpathSync.native(absolute)
    : resolve(realpathSync.native(dirname(absolute)), basename(absolute))
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function registeredWorktreePath(projectPath: string, target: string): string | undefined {
  const worktreeList = gitSync(projectPath, ['worktree', 'list', '--porcelain', '-z'], { trimOutput: false })
  return worktreeList.split('\0').flatMap((entry) => {
    if (!entry.startsWith('worktree ')) return []
    const path = entry.slice('worktree '.length)
    try {
      return comparableWorktreePath(path) === comparableWorktreePath(target) ? [path] : []
    } catch {
      return []
    }
  })[0]
}

function gitRefExists(projectPath: string, name: string): boolean {
  const result = runGitSync(projectPath, ['show-ref', '--verify', '--quiet', name])
  if (result.ok) return true
  if (result.timedOut) throw new RunCommandTimeoutError(result.errorDetail)
  if (result.status === 1 && !result.spawnError) return false
  throw new Error(result.errorDetail)
}

async function captureCommitRef(projectPath: string, name: string, sha: string): Promise<void> {
  try {
    await runGitMutationOrThrow(projectPath, ['update-ref', '--stdin'], { input: `create ${name} ${sha}\n` })
  } catch (error) {
    if (gitRefExists(projectPath, name) && gitSync(projectPath, ['rev-parse', name]) === sha) return
    throw error
  }
}

async function captureCorrectionRefs(projectPath: string, correctedRef: string, correctionRef: string, sha: string, previousSha?: string): Promise<void> {
  try {
    await runGitMutationOrThrow(projectPath, ['update-ref', '--stdin'], {
      input: `start\ncreate ${correctedRef} ${sha}\n${previousSha ? `update ${correctionRef} ${sha} ${previousSha}` : `create ${correctionRef} ${sha}`}\nprepare\ncommit\n`,
    })
  } catch (error) {
    const refsMatch = [correctedRef, correctionRef].every((name) => (
      gitRefExists(projectPath, name) && gitSync(projectPath, ['rev-parse', name]) === sha
    ))
    if (refsMatch) return
    throw error
  }
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
  try {
    ensureNoTrackedWorktreeChanges(worktreePath, operation)
    ensureNoUntrackedPathsClobberedBy(worktreePath, correctedCandidateSha, operation)
  } catch (error) {
    if (error instanceof Error
      && (error.message.startsWith('Worktree has tracked changes')
        || error.message.startsWith('Local files would be overwritten by'))) {
      throw new LocalWorkProtectionError(error.message)
    }
    throw error
  }
  const changedPaths = runGitBinarySync(
    worktreePath,
    ['diff', '--name-only', '--no-renames', '-z', candidateCommitSha, correctedCandidateSha],
  )
  if (!changedPaths.ok) {
    if (changedPaths.timedOut) throw new RunCommandTimeoutError(changedPaths.errorDetail)
    throw new Error(`Could not inspect corrected candidate paths: ${changedPaths.errorDetail}`)
  }
  const paths = decodeGitPathList(changedPaths.stdout)
  try {
    ensureNoUntrackedPathsOverwrittenBy(worktreePath, paths, operation)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Local files would be overwritten by')) {
      throw new LocalWorkProtectionError(error.message)
    }
    throw error
  }
}

function manualError(input: {
  reason: EarlyMergeManualRecovery['reason']
  pr: PullRequestInfo
  candidateCommitSha: string
  recoveryWorktreePath?: string | null
  recoveryWorktreeBaseHead?: string | null
  conflictPaths?: string[]
  detail: string
  proof?: EarlyMergeProof | null
  originalWorktreePath?: string
}): EarlyMergeRecoveryManualError {
  const recoveryWorktreePath = input.recoveryWorktreePath ?? null
  const conflictPaths = input.conflictPaths ?? []
  return new EarlyMergeRecoveryManualError({
    reason: input.reason,
    recoveryWorktreePath,
    recoveryWorktreeBaseHead: recoveryWorktreePath ? input.recoveryWorktreeBaseHead ?? null : null,
    conflictPaths,
    message: [
      `Pull request #${input.pr.number} was already merged, but LoopTroop could not safely reconcile candidate ${input.candidateCommitSha}.`,
      input.detail,
      input.reason === 'local_work_preserved'
        ? `Local files in the original ticket worktree${input.originalWorktreePath ? ` at ${input.originalWorktreePath}` : ''} were preserved. Review and preserve those files before retrying.${recoveryWorktreePath ? ` The clean corrective checkout remains at ${recoveryWorktreePath}; it has no patch conflicts to resolve.` : ''}`
        : recoveryWorktreePath
        ? `The ticket worktree was left untouched. A recovery checkout remains at ${recoveryWorktreePath}${conflictPaths.length ? ` (conflicts: ${conflictPaths.join(', ')})` : ''}. Resolve the conflict there, stage your changes, and create one commit directly on the current base. Then retry Verify; LoopTroop will adopt that commit and rerun final validation.`
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
    if (!(error instanceof LocalWorkProtectionError)) throw error
    throw manualError({
      reason: 'local_work_preserved',
      pr: input.pr,
      candidateCommitSha: input.candidateCommitSha,
      recoveryWorktreePath: existsSync(input.recoveryWorktreePath) ? input.recoveryWorktreePath : null,
      recoveryWorktreeBaseHead: input.proof.remoteBaseHead,
      proof: input.proof,
      originalWorktreePath: input.worktreePath,
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
  if (!Number.isSafeInteger(input.pr.number) || input.pr.number <= 0) {
    throw new Error('The merged pull request number is missing or invalid.')
  }
  assertSafeRefName(input.baseBranch, 'Base branch')
  assertSafeRefName(input.headBranch, 'Head branch')
  if (input.pr.state !== 'merged') throw new Error(`Pull request #${input.pr.number} is not merged.`)
  if (input.pr.baseRefName !== input.baseBranch || input.pr.headRefName !== input.headBranch) {
    throw new Error(`Pull request #${input.pr.number} does not match head branch ${input.headBranch} and base ${input.baseBranch}.`)
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
  ticketBranch?: string
  candidateCommitSha: string
  pr: PullRequestInfo
  previousRecoveryBaseHead?: string
}): Promise<EarlyMergeReconciliation> {
  const ticketBranch = input.ticketBranch ?? input.headBranch
  try {
    validateMergedPullRequest(input)
  } catch (error) {
    throw manualError({
      reason: 'missing_proof',
      pr: input.pr,
      candidateCommitSha: input.candidateCommitSha,
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  let remote: RemoteBaseVerification
  try {
    remote = await verifyRemoteBaseContainsCommit(input.projectPath, input.baseBranch, input.pr.mergeCommitSha!)
  } catch (error) {
    if (!(error instanceof RemoteBaseProofError)) throw error
    throw manualError({
      reason: 'missing_proof',
      pr: input.pr,
      candidateCommitSha: input.candidateCommitSha,
      detail: error.message,
    })
  }

  let mergedHeadSha: string
  try {
    mergedHeadSha = await fetchPullRequestHead(input.projectPath, input.pr.number, input.pr.headRefOid!)
  } catch (error) {
    if (!(error instanceof PullRequestHeadProofError)) throw error
    throw manualError({
      reason: 'missing_proof',
      pr: input.pr,
      candidateCommitSha: input.candidateCommitSha,
      detail: error.message,
    })
  }
  if (mergedHeadSha !== input.pr.headRefOid) {
    throw manualError({
      reason: 'missing_proof',
      pr: input.pr,
      candidateCommitSha: input.candidateCommitSha,
      detail: `GitHub's pull request head ${input.pr.headRefOid} does not match fetched commit ${mergedHeadSha}.`,
    })
  }

  let candidateTreeSha: string
  let mergedHeadTreeSha: string
  try {
    candidateTreeSha = readGitTreeSha(input.projectPath, input.candidateCommitSha)
    mergedHeadTreeSha = readGitTreeSha(input.projectPath, mergedHeadSha)
  } catch (error) {
    if (error instanceof RunCommandTimeoutError) throw error
    throw manualError({
      reason: 'missing_proof',
      pr: input.pr,
      candidateCommitSha: input.candidateCommitSha,
      detail: error instanceof Error ? error.message : String(error),
    })
  }

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
  if (!/^[0-9a-f]{40,64}$/i.test(remote.remoteBaseHead)) {
    throw manualError({
      reason: 'missing_proof',
      pr: input.pr,
      candidateCommitSha: input.candidateCommitSha,
      proof,
      detail: 'The fetched remote base did not resolve to a full commit SHA.',
    })
  }

  const recoveryPathForBase = (base: string) => resolve(input.projectPath, '.looptroop', 'merge-recovery', `pr-${input.pr.number}-${input.candidateCommitSha}-${base}`)
  const recoveryWorktreePath = recoveryPathForBase(remote.remoteBaseHead)
  const refRoot = `refs/looptroop/early-merge/pr-${input.pr.number}`
  const correctionRef = `${refRoot}/corrected-from-${input.candidateCommitSha}`
  const correctedCommitRef = (sha: string) => `${refRoot}/candidate-${input.candidateCommitSha}-corrected-${sha}`
  const hasSavedCorrection = gitRefExists(input.projectPath, correctionRef)
  let previousRecoveryBaseHead = input.previousRecoveryBaseHead
  if (previousRecoveryBaseHead
    && !existsSync(recoveryPathForBase(previousRecoveryBaseHead))
    && !hasSavedCorrection) previousRecoveryBaseHead = undefined
  const savedCorrectionSha = hasSavedCorrection ? gitSync(input.projectPath, ['rev-parse', correctionRef]) : undefined
  const correctionAlreadyRefreshed = Boolean(savedCorrectionSha
    && gitSync(input.projectPath, ['rev-parse', `${savedCorrectionSha}^`]) === remote.remoteBaseHead)
  let previousCorrectionSha: string | undefined
  let previousRecoveryWorktreePath: string | undefined
  let expectedTicketHead = input.candidateCommitSha
  let patchBaseSha = mergedHeadSha
  const candidateParent = runGitSync(input.projectPath, ['rev-parse', `${input.candidateCommitSha}^`])
  if (candidateParent.ok) {
    const baseContainsMergedPr = runGitSync(input.projectPath, [
      'merge-base', '--is-ancestor', proof.landedCommitSha, candidateParent.stdout.trim(),
    ])
    if (baseContainsMergedPr.ok) patchBaseSha = candidateParent.stdout.trim()
    else if (baseContainsMergedPr.status !== 1 || baseContainsMergedPr.spawnError) {
      if (baseContainsMergedPr.timedOut) throw new RunCommandTimeoutError(baseContainsMergedPr.errorDetail)
      throw new Error(baseContainsMergedPr.errorDetail)
    }
  } else if (candidateParent.timedOut) {
    throw new RunCommandTimeoutError(candidateParent.errorDetail)
  }
  const patchResult = runGitBinarySync(input.projectPath, [
    '-c', 'core.quotePath=true',
    'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
    '--unified=3', '--src-prefix=a/', '--dst-prefix=b/', patchBaseSha, input.candidateCommitSha,
  ])
  if (!patchResult.ok) {
    if (patchResult.timedOut) throw new RunCommandTimeoutError(patchResult.errorDetail)
    throw manualError({
      reason: 'missing_proof', pr: input.pr, candidateCommitSha: input.candidateCommitSha, proof,
      detail: `Git could not produce the A-to-B patch: ${patchResult.errorDetail}`,
    })
  }
  if (patchResult.stdout.length === 0) {
    throw manualError({
      reason: 'missing_proof', pr: input.pr, candidateCommitSha: input.candidateCommitSha, proof,
      detail: 'The candidate trees differ, but Git produced no A-to-B patch.',
    })
  }

  const patchDirectory = mkdtempSync(resolve(tmpdir(), 'looptroop-early-merge-'))
  const patchPath = resolve(patchDirectory, 'candidate.patch')
  try {
    writeFileSync(patchPath, patchResult.stdout)
    if (previousRecoveryBaseHead && previousRecoveryBaseHead !== remote.remoteBaseHead && !correctionAlreadyRefreshed) {
      const previousPath = recoveryPathForBase(previousRecoveryBaseHead)
      let previousHead: string | undefined
      if (existsSync(previousPath)) {
        if (!registeredWorktreePath(input.projectPath, previousPath)) {
          throw manualError({
            reason: 'conflict', pr: input.pr, candidateCommitSha: input.candidateCommitSha,
            recoveryWorktreePath: previousPath, recoveryWorktreeBaseHead: previousRecoveryBaseHead, proof,
            detail: 'The saved manual recovery checkout is no longer registered with this Git repository.',
          })
        }
        previousHead = gitSync(previousPath, ['rev-parse', 'HEAD'])
        const previousStatus = gitSync(previousPath, ['status', '--porcelain=1', '-z', '--untracked-files=all'], { trimOutput: false })
        const parent = gitSync(previousPath, ['rev-parse', `${previousHead}^`])
        if (previousStatus || parent !== previousRecoveryBaseHead) {
          throw manualError({
            reason: 'conflict', pr: input.pr, candidateCommitSha: input.candidateCommitSha,
            recoveryWorktreePath: previousPath, recoveryWorktreeBaseHead: previousRecoveryBaseHead, proof,
            detail: 'The saved manual resolution must be clean and committed once on its recorded base before it can be refreshed.',
          })
        }
        previousRecoveryWorktreePath = previousPath
      } else if (hasSavedCorrection) {
        previousHead = savedCorrectionSha
        if (gitSync(input.projectPath, ['rev-parse', `${previousHead}^`]) !== previousRecoveryBaseHead) {
          throw manualError({
            reason: 'conflict', pr: input.pr, candidateCommitSha: input.candidateCommitSha,
            proof,
            detail: 'The saved correction is not based on its recorded base commit.',
          })
        }
      }
      if (previousHead) {
        const manualPatch = runGitBinarySync(input.projectPath, [
          '-c', 'core.quotePath=true', 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv',
          '--no-color', '--no-renames', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/',
          previousRecoveryBaseHead, previousHead,
        ])
        if (!manualPatch.ok) {
          throw manualError({
            reason: 'conflict', pr: input.pr, candidateCommitSha: input.candidateCommitSha,
            recoveryWorktreePath: existsSync(previousPath) ? previousPath : null,
            recoveryWorktreeBaseHead: previousRecoveryBaseHead, proof,
            detail: 'Git could not produce the saved manual resolution for checking against the current base.',
          })
        }
        writeFileSync(patchPath, manualPatch.stdout)
      }
    }
    if (gitRefExists(input.projectPath, correctionRef)) {
      const correctedCandidateSha = gitSync(input.projectPath, ['rev-parse', correctionRef])
      if (!gitRefExists(input.projectPath, correctedCommitRef(correctedCandidateSha))
        || gitSync(input.projectPath, ['rev-parse', correctedCommitRef(correctedCandidateSha)]) !== correctedCandidateSha) {
        throw new Error('The previously prepared correction is missing its matching commit ref.')
      }
      const ticketHead = gitSync(input.worktreePath, ['rev-parse', 'HEAD'])
      const savedTicketHead = gitRefExists(input.projectPath, correctedCommitRef(ticketHead))
        && gitSync(input.projectPath, ['rev-parse', correctedCommitRef(ticketHead)]) === ticketHead
      if (ticketHead !== input.candidateCommitSha && !savedTicketHead) {
        throw new Error('A previously prepared correction exists, but the ticket worktree has moved to another commit.')
      }
      if (getCurrentBranch(input.worktreePath) !== ticketBranch) {
        throw new Error('The ticket worktree is no longer on its ticket branch.')
      }
      expectedTicketHead = ticketHead
      if (gitSync(input.projectPath, ['rev-parse', `${correctedCandidateSha}^`]) === remote.remoteBaseHead) {
        if (ticketHead !== correctedCandidateSha) {
          protectTicketWorktreeForCorrectionOrStop({
            worktreePath: input.worktreePath,
            candidateCommitSha: input.candidateCommitSha,
            correctedCandidateSha,
            recoveryWorktreePath,
            pr: input.pr,
            proof,
          })
          await runGitMutationOrThrow(input.worktreePath, ['reset', '--hard', correctedCandidateSha])
        } else {
          ensureNoTrackedWorktreeChanges(input.worktreePath, 'early-merge candidate correction')
        }
        return {
          kind: 'corrected', proof, correctedCandidateSha,
          recoveryWorktreePath: existsSync(recoveryWorktreePath) ? recoveryWorktreePath : null,
        }
      }
      previousCorrectionSha = correctedCandidateSha
    }

    ensureNoTrackedWorktreeChanges(input.worktreePath, 'early-merge candidate correction')
    if (gitSync(input.worktreePath, ['rev-parse', 'HEAD']) !== expectedTicketHead
      || getCurrentBranch(input.worktreePath) !== ticketBranch) {
      throw new Error('The ticket worktree no longer points to the approved candidate on its ticket branch.')
    }
    mkdirSync(dirname(recoveryWorktreePath), { recursive: true })

    for (const [name, sha] of [
      [`${refRoot}/head-${mergedHeadSha}`, mergedHeadSha],
      [`${refRoot}/candidate-${input.candidateCommitSha}`, input.candidateCommitSha],
      [`${refRoot}/landed-${proof.landedCommitSha}`, proof.landedCommitSha],
    ] as const) {
      await captureCommitRef(input.projectPath, name, sha)
    }

    if (existsSync(recoveryWorktreePath)) {
      if (!registeredWorktreePath(input.projectPath, recoveryWorktreePath)) {
        throw manualError({
          reason: 'conflict', pr: input.pr, candidateCommitSha: input.candidateCommitSha,
          recoveryWorktreePath, recoveryWorktreeBaseHead: remote.remoteBaseHead, proof,
          detail: `A path already exists at ${recoveryWorktreePath}, but it is not the expected Git recovery worktree.`,
        })
      }
      const recoveryHead = gitSync(recoveryWorktreePath, ['rev-parse', 'HEAD'])
      const recoveryStatus = gitSync(recoveryWorktreePath, ['status', '--porcelain=1', '-z', '--untracked-files=all'], { trimOutput: false })
      const parent = recoveryHead === remote.remoteBaseHead ? undefined : gitSync(recoveryWorktreePath, ['rev-parse', `${recoveryHead}^`])
      if (recoveryStatus || (recoveryHead !== remote.remoteBaseHead && parent !== remote.remoteBaseHead)) {
        throw manualError({
          reason: 'conflict', pr: input.pr, candidateCommitSha: input.candidateCommitSha,
          recoveryWorktreePath, recoveryWorktreeBaseHead: remote.remoteBaseHead,
          conflictPaths: conflictPaths(recoveryWorktreePath), proof,
          detail: 'Resolve the conflict in the recovery checkout, stage the result, and commit it once on the current base before retrying.',
        })
      }
      if (recoveryHead !== remote.remoteBaseHead) {
        const remoteBaseTreeSha = readGitTreeSha(input.projectPath, remote.remoteBaseHead)
        if (gitSync(recoveryWorktreePath, ['rev-parse', 'HEAD^{tree}']) === remoteBaseTreeSha) {
          await runGitMutationOrThrow(input.projectPath, ['worktree', 'remove', recoveryWorktreePath])
          return { kind: 'already_landed', proof, remoteBaseTreeSha, manualResolutionNoChange: true }
        }
        const correctedCandidateSha = recoveryHead
        await captureCorrectionRefs(input.projectPath, correctedCommitRef(correctedCandidateSha), correctionRef, correctedCandidateSha, previousCorrectionSha)
        if (gitSync(input.worktreePath, ['rev-parse', 'HEAD']) !== expectedTicketHead
          || getCurrentBranch(input.worktreePath) !== ticketBranch) {
          throw new Error('The ticket worktree changed before the resolved candidate could be installed.')
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
        } catch (error) {
          if (error instanceof RunCommandTimeoutError) throw error
        }
        return { kind: 'corrected', proof, correctedCandidateSha, recoveryWorktreePath: retainedRecoveryWorktreePath }
      }
    } else {
      const staleRegistration = registeredWorktreePath(input.projectPath, recoveryWorktreePath)
      if (staleRegistration && !existsSync(recoveryWorktreePath)) {
        await runGitMutationOrThrow(input.projectPath, ['worktree', 'remove', '--force', staleRegistration])
      }
      await runGitMutationOrThrow(input.projectPath, ['worktree', 'add', '--detach', recoveryWorktreePath, remote.remoteBaseHead])
    }

    const changedPathResult = runGitBinarySync(input.projectPath, [
      'diff', '--name-only', '--no-renames', '-z', patchBaseSha, input.candidateCommitSha,
    ])
    if (!changedPathResult.ok) {
      if (changedPathResult.timedOut) throw new RunCommandTimeoutError(changedPathResult.errorDetail)
      throw new Error(`Could not inspect candidate paths: ${changedPathResult.errorDetail}`)
    }
    const changedPaths = decodeGitPathList(changedPathResult.stdout)
    ensureNoTrackedWorktreeChanges(recoveryWorktreePath, 'early-merge candidate correction')
    ensureNoUntrackedPathsOverwrittenBy(recoveryWorktreePath, changedPaths, 'early-merge candidate correction')

    const savedPatch = readFileSync(patchPath)
    if (savedPatch.length > 0) {
      try {
        await runGitMutationOrThrow(recoveryWorktreePath, ['-c', 'apply.whitespace=nowarn', 'apply', '--3way', '--binary', '--', patchPath])
      } catch (error) {
        if (error instanceof RunCommandTimeoutError) throw error
        throw manualError({
          reason: 'conflict',
          pr: input.pr,
          candidateCommitSha: input.candidateCommitSha,
          recoveryWorktreePath,
          recoveryWorktreeBaseHead: remote.remoteBaseHead,
          conflictPaths: conflictPaths(recoveryWorktreePath),
          proof,
          detail: `The A-to-B patch could not be applied cleanly to origin/${input.baseBranch}@${remote.remoteBaseHead}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }

    const recoveryStatus = gitSync(recoveryWorktreePath, ['status', '--porcelain=1', '-z', '--untracked-files=all'], { trimOutput: false })
    const savedManualResolutionIsEmpty = Boolean(previousRecoveryBaseHead && readFileSync(patchPath).length === 0)
    if (savedManualResolutionIsEmpty && recoveryStatus) {
      throw manualError({
        reason: 'conflict', pr: input.pr, candidateCommitSha: input.candidateCommitSha,
        recoveryWorktreePath, recoveryWorktreeBaseHead: remote.remoteBaseHead,
        conflictPaths: conflictPaths(recoveryWorktreePath), proof,
        detail: 'The saved manual resolution leaves no candidate changes, but the recovery checkout still has local files that must be preserved.',
      })
    }
    if (savedManualResolutionIsEmpty) {
      const remoteBaseTreeSha = readGitTreeSha(input.projectPath, remote.remoteBaseHead)
      for (const cleanWorktreePath of [recoveryWorktreePath, previousRecoveryWorktreePath]) {
        if (!cleanWorktreePath || !existsSync(cleanWorktreePath)) continue
        try {
          await runGitMutationOrThrow(input.projectPath, ['worktree', 'remove', cleanWorktreePath])
        } catch (error) {
          if (error instanceof RunCommandTimeoutError) throw error
          // A failed cleanup leaves only a clean recovery checkout.
        }
      }
      return { kind: 'already_landed', proof, remoteBaseTreeSha, manualResolutionNoChange: true }
    }
    if (!recoveryStatus) {
      const remoteBaseTreeSha = readGitTreeSha(input.projectPath, remote.remoteBaseHead)
      try {
        await runGitMutationOrThrow(input.projectPath, ['worktree', 'remove', recoveryWorktreePath])
      } catch (error) {
        if (error instanceof RunCommandTimeoutError) throw error
        // The verified base is unchanged; a clean checkout can be removed on a later retry.
      }
      return { kind: 'already_landed', proof, remoteBaseTreeSha }
    }

    const bypassHooks = shouldBypassGitHooks(readWorktreeGitHookPolicy(input.worktreePath))
    await runGitMutationOrThrow(recoveryWorktreePath, [
      '-c', 'user.name=LoopTroop',
      '-c', 'user.email=looptroop@local',
      'commit',
      ...(bypassHooks ? ['--no-verify'] : []),
      '-m', `${input.externalId}: carry candidate changes after merged PR #${input.pr.number}`,
    ])
    const correctedCandidateSha = gitSync(recoveryWorktreePath, ['rev-parse', 'HEAD'])
    if (gitSync(recoveryWorktreePath, ['rev-parse', 'HEAD^']) !== remote.remoteBaseHead) {
      throw new Error('The corrected candidate is not based directly on the verified current origin base.')
    }
    await captureCorrectionRefs(input.projectPath, correctedCommitRef(correctedCandidateSha), correctionRef, correctedCandidateSha, previousCorrectionSha)

    if (gitSync(input.worktreePath, ['rev-parse', 'HEAD']) !== expectedTicketHead
      || getCurrentBranch(input.worktreePath) !== ticketBranch) {
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
    } catch (error) {
      if (error instanceof RunCommandTimeoutError) throw error
      // The corrected commit is already referenced and installed; a clean recovery checkout is harmless to retain.
    }
    if (previousRecoveryWorktreePath) {
      try {
        await runGitMutationOrThrow(input.projectPath, ['worktree', 'remove', previousRecoveryWorktreePath])
      } catch (error) {
        if (error instanceof RunCommandTimeoutError) throw error
      }
    }
    return { kind: 'corrected', proof, correctedCandidateSha, recoveryWorktreePath: retainedRecoveryWorktreePath }
  } catch (error) {
    if (error instanceof EarlyMergeRecoveryManualError || error instanceof RunCommandTimeoutError) throw error
    throw manualError({
      reason: 'missing_proof',
      pr: input.pr,
      candidateCommitSha: input.candidateCommitSha,
      recoveryWorktreePath: existsSync(recoveryWorktreePath) ? recoveryWorktreePath : null,
      recoveryWorktreeBaseHead: existsSync(recoveryWorktreePath) ? remote.remoteBaseHead : null,
      conflictPaths: existsSync(recoveryWorktreePath) ? conflictPaths(recoveryWorktreePath) : [],
      proof,
      detail: `Corrective recovery stopped without changing the ticket worktree: ${error instanceof Error ? error.message : String(error)}`,
    })
  } finally {
    rmSync(patchDirectory, { recursive: true, force: true })
  }
}
