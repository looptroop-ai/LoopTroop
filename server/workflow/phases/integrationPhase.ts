import type { TicketContext, TicketEvent } from '../../machines/types'
import { getLatestPhaseArtifact, getTicketPaths, insertPhaseArtifact } from '../../storage/tickets'
import { isMockOpenCodeMode } from '../../opencode/factory'
import { prepareSquashCandidate } from '../../phases/integration/squash'
import {
  resolveFinalTestCandidateFiles,
  restoreTrackedFinalTestLocalFiles,
} from '../../phases/finalTest/fileEffectsAudit'
import { emitPhaseLog } from './helpers'
import { handleMockExecutionUnsupported } from './executionPhase'
import { withCommandLoggingAsync } from '../../log/commandLogger'
import { CancelledError } from '../../council/types'
import { readManualQaDeliverySummaryForTicket as readManualQaDeliverySummary } from '../../phases/manualQa/delivery'
import { EXECUTION_SETUP_PROFILE_ARTIFACT_TYPE } from '../../phases/executionSetup/types'
import { runExplicitGitHookValidation } from '../../phases/executionSetup/hookValidation'
import { DEFAULT_GIT_HOOK_POLICY } from '@shared/gitHookPolicy'
import {
  discoverGitHooks,
  gitHookEvidenceMatches,
  normalizeGitHookEvidence,
  readApprovedGitHookEvidence,
} from '../../git/hookDiscovery'

function readFinalTestFilesToStage(ticketId: string): string[] {
  const artifact = getLatestPhaseArtifact(ticketId, 'final_test_report', 'RUNNING_FINAL_TEST')
  if (!artifact) return []

  try {
    const parsed = JSON.parse(artifact.content) as {
      modifiedFiles?: unknown
      testFiles?: unknown
    }
    const modifiedFiles = Array.isArray(parsed.modifiedFiles)
      ? parsed.modifiedFiles.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    if (modifiedFiles.length > 0) return [...new Set(modifiedFiles)]

    const testFiles = Array.isArray(parsed.testFiles)
      ? parsed.testFiles.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    return [...new Set(testFiles)]
  } catch {
    return []
  }
}

export async function handleIntegration(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal?: AbortSignal,
) {
  if (isMockOpenCodeMode()) {
    await handleMockExecutionUnsupported(ticketId, context, 'INTEGRATING_CHANGES', sendEvent)
    return
  }

  return withCommandLoggingAsync(
    ticketId, context.externalId, 'INTEGRATING_CHANGES',
    async () => {
  const paths = getTicketPaths(ticketId)
  if (!paths) {
    throw new Error(`Ticket workspace not initialized: missing ticket paths for ${context.externalId}`)
  }

  if (signal?.aborted) throw new CancelledError(ticketId)

  const setupProfileArtifact = getLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PROFILE_ARTIFACT_TYPE,
    'PREPARING_EXECUTION_ENV',
  )
  // Both sides go through the canonical reader, so equivalent hook sets compare
  // equal regardless of the order they were discovered or serialised in.
  const currentHookEvidence = normalizeGitHookEvidence(discoverGitHooks(paths.worktreePath).detected)
  const approvedHookEvidence = setupProfileArtifact
    ? readApprovedGitHookEvidence(setupProfileArtifact.content)
    : []
  const hookEvidenceDrift = {
    changed: !gitHookEvidenceMatches(approvedHookEvidence, currentHookEvidence),
    approved: approvedHookEvidence,
    current: currentHookEvidence,
  }
  if (hookEvidenceDrift.changed) {
    emitPhaseLog(
      ticketId,
      context.externalId,
      'INTEGRATING_CHANGES',
      'info',
      'Git-hook evidence changed after setup approval; integration recorded the drift and kept the approved policy.',
      { source: 'system', audience: 'all', hookEvidenceDrift },
    )
  }
  const hookValidation = setupProfileArtifact
    ? await runExplicitGitHookValidation({
        profileContent: setupProfileArtifact.content,
        worktreePath: paths.worktreePath,
        signal,
      })
    : {
        policy: DEFAULT_GIT_HOOK_POLICY,
        receipts: [{
          id: 'git-hook-policy', status: 'skipped' as const, exitCode: null, durationMs: 0,
          outputExcerpt: 'No execution setup profile was available for explicit Git hook validation.',
        }],
        errors: [],
        warnings: [],
        fileAudit: { mutated: false, candidatePaths: [], temporaryPaths: [], internalPaths: [] },
      }
  if (hookValidation.warnings.length > 0) {
    emitPhaseLog(
      ticketId,
      context.externalId,
      'INTEGRATING_CHANGES',
      'info',
      `Advisory Git hook validation reported: ${hookValidation.warnings.join('; ')}`,
      { source: 'system', audience: 'all', gitHookValidation: hookValidation },
    )
  }
  if (hookValidation.errors.length > 0) {
    const message = `Explicit Git hook validation failed before integration: ${hookValidation.errors.join('; ')}`
    insertPhaseArtifact(ticketId, {
      phase: 'INTEGRATING_CHANGES',
      artifactType: 'integration_report',
      content: JSON.stringify({
        status: 'blocked',
        completedAt: new Date().toISOString(),
        baseBranch: paths.baseBranch,
        gitHookValidation: hookValidation,
        hookEvidenceDrift,
        message,
      }),
    })
    emitPhaseLog(ticketId, context.externalId, 'INTEGRATING_CHANGES', 'error', message, {
      source: 'system', audience: 'all', gitHookValidation: hookValidation,
    })
    sendEvent({ type: 'ERROR', message, codes: ['GIT_HOOK_VALIDATION_FAILED'] })
    return
  }

  emitPhaseLog(ticketId, context.externalId, 'INTEGRATING_CHANGES', 'info',
    'Analyzing ticket branch for squash...', { source: 'system', audience: 'all' })

  const finalTestFileResolution = resolveFinalTestCandidateFiles(ticketId)
  const restoredTrackedLocalFiles = restoreTrackedFinalTestLocalFiles(
    paths.worktreePath,
    finalTestFileResolution.audit,
  )
  if (restoredTrackedLocalFiles.length > 0) {
    emitPhaseLog(
      ticketId,
      context.externalId,
      'INTEGRATING_CHANGES',
      'info',
      `Restored ${restoredTrackedLocalFiles.length} tracked local-only final-test file${restoredTrackedLocalFiles.length === 1 ? '' : 's'} before candidate staging.`,
      { source: 'system', audience: 'all', files: restoredTrackedLocalFiles },
    )
  }
  const finalTestFilesToStage = finalTestFileResolution.audit
    ? finalTestFileResolution.candidateFiles
    : readFinalTestFilesToStage(ticketId)

  const squash = prepareSquashCandidate(
    paths.worktreePath,
    paths.baseBranch,
    context.title,
    context.externalId,
    finalTestFilesToStage,
  )

  if (squash.success) {
    emitPhaseLog(ticketId, context.externalId, 'INTEGRATING_CHANGES', 'info',
      `Squashed ${squash.commitCount ?? '?'} commit(s) into candidate ${squash.commitHash}`,
      { source: 'system', audience: 'all' })

    if (signal?.aborted) throw new CancelledError(ticketId)

    emitPhaseLog(ticketId, context.externalId, 'INTEGRATING_CHANGES', 'info',
      'Remote ticket branch update deferred until draft PR creation.', { source: 'system', audience: 'all' })
  }

  const report = {
    status: squash.success ? 'passed' : 'failed',
    completedAt: new Date().toISOString(),
    baseBranch: paths.baseBranch,
    preSquashHead: squash.preSquashHead ?? null,
    candidateCommitSha: squash.commitHash ?? null,
    mergeBase: squash.mergeBase ?? null,
    commitCount: squash.commitCount ?? null,
    pushed: false,
    pushDeferred: squash.success,
    pushError: null,
    manualQa: readManualQaDeliverySummary(ticketId),
    gitHookValidation: hookValidation,
    hookEvidenceDrift,
    message: squash.success
      ? 'Integration phase completed. Draft pull request creation is next.'
      : squash.message,
  }
  insertPhaseArtifact(ticketId, {
    phase: 'INTEGRATING_CHANGES',
    artifactType: 'integration_report',
    content: JSON.stringify(report),
  })

  if (!squash.success) {
    emitPhaseLog(ticketId, context.externalId, 'INTEGRATING_CHANGES', 'error',
      `Integration failed: ${squash.message}`, { source: 'system', audience: 'all' })
    throw new Error(squash.message)
  }

  emitPhaseLog(ticketId, context.externalId, 'INTEGRATING_CHANGES', 'info',
    `Integration complete — candidate ${report.candidateCommitSha} ready for draft pull request creation`,
    { source: 'system', audience: 'all' })
  sendEvent({ type: 'INTEGRATION_DONE' })
    },
    (phase, type, content) => emitPhaseLog(ticketId, context.externalId, phase, type, content, { source: 'system', audience: 'all' }),
  )
}
