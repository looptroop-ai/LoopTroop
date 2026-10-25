import { EarlyMergeRecoveryManualError } from '../../git/earlyMergedPullRequestRecovery'
import { requestManualQaSubmissionRecovery } from '../../phases/manualQa/operations'
import { completeTicketMerge, hasClosedUnmergedReport, hasVerifiedMergeReport, withTicketMergeLock } from '../../workflow/mergeCompletion'
import type { Context } from 'hono'
import type { z } from 'zod'
import { PROFILE_DEFAULTS } from '../../db/defaults'
import {
  ensureActorForTicket,
  getTicketState,
  sendTicketEvent,
  stopActor,
} from '../../machines/persistence'
import { abortTicketSessions, listOpenCodeSessionsForTicket } from '../../opencode/sessionManager'
import { getActivePhaseAttempt } from '../../storage/ticketPhaseAttempts'
import { clearContextCache } from '../../opencode/contextBuilder'
import { getOpenCodeAdapter } from '../../opencode/factory'
import { normalizeStructuredRetryCount } from '../../lib/structuredRetryPolicy'
import { isGitHookPolicy } from '../../git/hookPolicy'
import {
  cancelTicket,
  clearTicketCancellationPending,
  isTicketCancellationPending,
  markTicketCancellationPending,
  schedulePendingCancellationCleanupRetry,
} from '../../workflow/runner'
import { TicketInitializationError, initializeTicket } from '../../ticket/initialize'
import { readTicketMetaForMutation, TicketMetadataFormatError } from '../../ticket/metadata'
import { withCommandLoggingAsync } from '../../log/commandLogger'
import { validateModelSelection } from '../../opencode/modelValidation'
import {
  needsOpenRouterRoutingConfig,
  openRouterRoutingModelsWouldChangeConfig,
  registerOpenRouterRoutingModels,
} from '../../opencode/openRouterRoutingConfig'
import { withProviderCatalogReload } from '../../opencode/providerCatalog'
import { ProviderCatalogBusyError } from '../../opencode/providerCatalogReload'
import { getOpenCodeConnection } from '../../opencode/connection'
import { getOpenCodeBaseUrl } from '../../opencode/runtimeConfig'
import {
  archiveActivePhaseAttempts,
  buildTicketRef,
  cleanupCanceledTicketData,
  createFreshPhaseAttempts,
  deleteTicket as deleteStoredTicket,
  ensureActivePhaseAttempt,
  findProjectExecutionBandConflict,
  getTicketByRef,
  getTicketContext,
  getTicketPaths,
  isDisplayOnlyMockTicket,
  isAttemptTrackedPhase,
  lockTicketStartConfiguration,
  rollbackTicketStartConfiguration,
  patchTicket,
  resolveTicketContinuationCandidate,
} from '../../storage/tickets'
import {
  buildObservedPullRequestReport,
  completeCloseUnmerged,
  recordPullRequestRefreshFailure,
  readPullRequestReport,
  resolvePullRequestHeadBranch,
  refreshPullRequestReport,
  refreshPullRequestState,
} from '../../workflow/phases/pullRequestPhase'
import type { PullRequestInfo } from '../../git/github'
import { recoverCodingBeadWithReset } from '../../workflow/phases/beadsPhase'
import { hasSuccessfulExecutionCheckpointForFinalization, recoverSuccessfulExecutionCheckpointForFinalization } from '../../workflow/phases/executionPhase'
import { persistInterviewRetrySnapshot, readInterviewRetrySnapshot } from '../../workflow/phases/interviewPhase'
import { interviewQASessions } from '../../workflow/phases/state'
import { isExecutionBandStatus } from '../../workflow/executionBand'
import { getErrorMessage } from '@shared/typeGuards'
import { normalizeBlockedErrorDiagnostics, sanitizeDiagnosticText } from '@shared/errorDiagnostics'
import { buildOpenCodeBlockedErrorDiagnostics } from '../../opencode/blockedErrorDiagnostics'
import { getAvailableWorkflowActions, isTerminalWorkflowStatus } from '@shared/workflowMeta'
import { canRetryWithExtraNote, savePhaseRetryNote } from '../../workflow/retryNotes'
import { broadcaster } from '../../sse/broadcaster'
import {
  clearSessionContinuation,
  requestSessionContinuation,
} from '../../opencode/sessionContinuation'
import {
  assertPlanningEditClaim,
  claimPlanningEdit,
  releasePlanningEdit,
  buildExecutionBandConflictMessage,
  emitRoutePhaseLog,
  getProfileDefaults,
  getTicketParam,
  logTicketOperationError,
  readJsonBody,
  rejectDisplayOnlyMockTicket,
  respondWithState,
} from './routeUtils'
import { cancelTicketSchema, closeUnmergedSchema, retryTicketSchema } from './schemas'
import { deriveSkipActionId, formatSkipReceiptLogLines, writeSkipReceipts } from '../../workflow/skipReceipts'
import { normalizeSkipReason } from '@shared/skipReceipt'
import { clampAiQuestionWindowMs } from '@shared/aiQuestions'
import { clearTicketWindows } from '../../workflow/questionWindows'
import { resolveStoredWorkflowPhase } from '@shared/workflowMeta'
import { parseLockedCouncilMemberVariants } from '../../storage/ticketQueries'

function rollbackTicketStartToDraft(ticketId: string): void {
  const ticket = getTicketByRef(ticketId)
  if (ticket && ticket.status !== 'DRAFT') return

  const actorState = getTicketState(ticketId)
  if (actorState && actorState.state !== 'DRAFT') cancelTicket(ticketId)

  try {
    if (ticket) rollbackTicketStartConfiguration(ticketId)
  } catch (error) {
    logTicketOperationError(ticketId, 'Failed to roll back ticket start configuration', error)
  } finally {
    const ticketAfterRollback = getTicketByRef(ticketId)
    if (!ticketAfterRollback || ticketAfterRollback.status === 'DRAFT') stopActor(ticketId)
  }
}

const startingTickets = new Set<string>()

export async function handleStartTicket(c: Context) {
  const ticketId = getTicketParam(c)
  const ticketContext = getTicketContext(ticketId)
  if (!ticketContext) return c.json({ error: 'Ticket not found' }, 404)
  if (isDisplayOnlyMockTicket(ticketContext.localTicket)) {
    return c.json({ error: 'Display-only mock tickets cannot be started' }, 409)
  }
  if (ticketContext.localTicket.status !== 'DRAFT') {
    return c.json({ error: 'Ticket can only be started from DRAFT status' }, 409)
  }
  try {
    readTicketMetaForMutation(ticketContext.projectRoot, ticketContext.externalId)
  } catch (error) {
    if (error instanceof TicketMetadataFormatError) {
      return c.json({ error: error.message }, 409)
    }
    return c.json({ error: 'Unable to read ticket metadata.' }, 500)
  }

  const startKey = buildTicketRef(ticketContext.projectId, ticketContext.externalId)
  if (startingTickets.has(startKey)) {
    return c.json({ error: 'Ticket start is already in progress' }, 429)
  }
  startingTickets.add(startKey)

  try {
  const startPhase = 'DRAFT'
  emitRoutePhaseLog(ticketId, startPhase, 'info', 'Start requested.')

  const profile = getProfileDefaults()
  const councilRaw = ticketContext.localProject.councilMembers ?? profile?.councilMembers ?? null
  emitRoutePhaseLog(ticketId, startPhase, 'info', 'Validating model availability.')
  let modelSelection
  try {
    modelSelection = await validateModelSelection(profile?.mainImplementer, councilRaw)
    emitRoutePhaseLog(
      ticketId,
      startPhase,
      'info',
      `✓ Model Availability: Main implementer ${modelSelection.mainImplementer}; council size ${modelSelection.councilMembers.length}.`,
      {
        mainImplementer: modelSelection.mainImplementer,
        councilMembers: modelSelection.councilMembers,
      },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid model configuration'
    emitRoutePhaseLog(ticketId, startPhase, 'error', `✗ Model Availability: ${message}`, {
      error: message,
    })
    return c.json({ error: message }, 400)
  }

  try {
    if (needsOpenRouterRoutingConfig(modelSelection.councilMembers)) {
      const connection = await getOpenCodeConnection(getOpenCodeBaseUrl())
      if (openRouterRoutingModelsWouldChangeConfig(modelSelection.councilMembers, connection.protocol)) {
        const registered = await withProviderCatalogReload(async (connection, refresh) => {
          if (!openRouterRoutingModelsWouldChangeConfig(modelSelection.councilMembers, connection.protocol)) return false
          if (!registerOpenRouterRoutingModels(modelSelection.councilMembers, connection.protocol)) return false
          await refresh()
          return true
        })
        if (registered) {
          emitRoutePhaseLog(ticketId, startPhase, 'info', 'Registered selected OpenRouter routing variants with OpenCode.')
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to register OpenRouter routing models'
    emitRoutePhaseLog(ticketId, startPhase, 'error', `✗ OpenRouter Routing: ${message}`, { error: message })
    return c.json(
      { error: message, ...(err instanceof ProviderCatalogBusyError ? { code: 'OPENCODE_BUSY' } : {}) },
      err instanceof ProviderCatalogBusyError ? 409 : 502,
    )
  }

  emitRoutePhaseLog(ticketId, startPhase, 'info', 'Initializing workspace and ticket directories.')
  let init: Awaited<ReturnType<typeof initializeTicket>>
  try {
    init = await withCommandLoggingAsync(
      ticketId,
      ticketContext.externalId,
      startPhase,
      () => initializeTicket({
        externalId: ticketContext.externalId,
        projectFolder: ticketContext.projectRoot,
      }),
      (phase, type, content) => emitRoutePhaseLog(ticketId, phase, type, content),
    )
    emitRoutePhaseLog(
      ticketId,
      startPhase,
      'info',
      init.reused
        ? `✓ Workspace Init: Ready on branch ${init.branchName} (reused existing worktree).`
        : `✓ Workspace Init: Ready on branch ${init.branchName} (new worktree and ticket directories created).`,
      {
        branchName: init.branchName,
        baseBranch: init.baseBranch,
        worktreePath: init.worktreePath,
        reused: init.reused,
      },
    )
  } catch (err) {
    if (err instanceof TicketMetadataFormatError) {
      const message = sanitizeDiagnosticText(err.message)
      emitRoutePhaseLog(ticketId, startPhase, 'error', `✗ Workspace Init: ${message}`, {
        error: message,
      })
      return c.json({ error: message }, 409)
    }
    const initErr = err instanceof TicketInitializationError
      ? err
      : new TicketInitializationError('INIT_UNKNOWN', getErrorMessage(err), { cause: err })
    const message = sanitizeDiagnosticText(initErr.message)
    const diagnostics = normalizeBlockedErrorDiagnostics({
      ...buildOpenCodeBlockedErrorDiagnostics({ error: initErr }).diagnostics,
      kind: 'runtime',
      source: 'system',
      summary: message,
      operation: 'initializing the ticket workspace',
    })
    emitRoutePhaseLog(ticketId, startPhase, 'error', `✗ Workspace Init: ${message}`, {
      code: initErr.code,
      error: message,
      diagnostics,
    })

    try {
      ensureActorForTicket(ticketId)
      sendTicketEvent(ticketId, {
        type: 'INIT_FAILED',
        message,
        codes: [initErr.code],
        diagnostics,
      })
    } catch (sendErr) {
      const sendErrDetails = sanitizeDiagnosticText(getErrorMessage(sendErr))
      emitRoutePhaseLog(
        ticketId,
        startPhase,
        'error',
        `Failed to block ticket after initialization error: ${sendErrDetails}`,
        {
          code: initErr.code,
          error: sendErrDetails,
        },
      )
      logTicketOperationError(ticketId, 'Failed to send INIT_FAILED to ticket', sendErr)
      return c.json({ error: 'Failed to block ticket after initialization error', details: sendErrDetails }, 500)
    }

    const updated = getTicketByRef(ticketId)
    const state = getTicketState(ticketId)
    return c.json({
      message: 'Start blocked during initialization',
      ticketId,
      status: updated?.status,
      state: state?.state,
      details: message,
      codes: [initErr.code],
    })
  }

  const lockedInterviewQuestions = ticketContext.localProject.interviewQuestions
    ?? profile?.interviewQuestions
    ?? PROFILE_DEFAULTS.interviewQuestions
  const lockedCoverageFollowUpBudgetPercent = profile?.coverageFollowUpBudgetPercent
    ?? PROFILE_DEFAULTS.coverageFollowUpBudgetPercent
  const lockedMaxCoveragePasses = profile?.maxCoveragePasses
    ?? PROFILE_DEFAULTS.maxCoveragePasses
  const lockedMaxPrdCoveragePasses = profile?.maxPrdCoveragePasses
    ?? PROFILE_DEFAULTS.maxPrdCoveragePasses
  const lockedMaxBeadsCoveragePasses = profile?.maxBeadsCoveragePasses
    ?? PROFILE_DEFAULTS.maxBeadsCoveragePasses
  const lockedStructuredRetryCount = normalizeStructuredRetryCount(profile?.structuredRetryCount)
  const manualQaResolution = ticketContext.localTicket.manualQaOverride !== null
    ? { enabled: ticketContext.localTicket.manualQaOverride, source: 'ticket' as const }
    : ticketContext.localProject.manualQaOverride !== null
      ? { enabled: ticketContext.localProject.manualQaOverride, source: 'project' as const }
      : { enabled: profile?.manualQaEnabled ?? PROFILE_DEFAULTS.manualQaEnabled, source: 'profile' as const }
  // The two AI question settings cascade separately: a ticket can shorten the window
  // while still inheriting whether questions are allowed at all.
  const aiQuestionsResolution = ticketContext.localTicket.aiQuestionsOverride !== null
    ? { enabled: ticketContext.localTicket.aiQuestionsOverride, source: 'ticket' as const }
    : ticketContext.localProject.aiQuestionsOverride !== null
      ? { enabled: ticketContext.localProject.aiQuestionsOverride, source: 'project' as const }
      : { enabled: profile?.aiQuestionsEnabled ?? PROFILE_DEFAULTS.aiQuestionsEnabled, source: 'profile' as const }
  const aiQuestionWindowResolution = ticketContext.localTicket.aiQuestionWindowOverride !== null
    ? { windowMs: ticketContext.localTicket.aiQuestionWindowOverride, source: 'ticket' as const }
    : ticketContext.localProject.aiQuestionWindowOverride !== null
      ? { windowMs: ticketContext.localProject.aiQuestionWindowOverride, source: 'project' as const }
      : { windowMs: profile?.aiQuestionWindow ?? PROFILE_DEFAULTS.aiQuestionWindow, source: 'profile' as const }
  const gitHookPolicyResolution = isGitHookPolicy(ticketContext.localProject.gitHookPolicy)
    ? { policy: ticketContext.localProject.gitHookPolicy, source: 'project' as const }
    : {
        policy: isGitHookPolicy(profile?.gitHookPolicy)
          ? profile.gitHookPolicy
          : PROFILE_DEFAULTS.gitHookPolicy,
        source: 'profile' as const,
      }
  const lockedMainImplementerVariant = profile?.mainImplementerVariant ?? null
  let lockedCouncilMemberVariants: Record<string, string> | null = null
  if (profile?.councilMemberVariants) {
    if (typeof profile.councilMemberVariants === 'string') {
      // The canonical parser, not a bare JSON.parse. An array, a number or an
      // empty key used to be locked here and then read back as `null` by
      // `parseLockedCouncilMemberVariants`, so the ticket's variants silently
      // disappeared for the rest of its life. A shape this cannot lock is a
      // configuration error the caller should hear about at start.
      lockedCouncilMemberVariants = parseLockedCouncilMemberVariants(profile.councilMemberVariants)
      if (!lockedCouncilMemberVariants) {
        return c.json({ error: 'Invalid configuration: malformed councilMemberVariants' }, 400)
      }
    } else {
      lockedCouncilMemberVariants = profile.councilMemberVariants
    }
  }
  const startedAt = new Date().toISOString()

  emitRoutePhaseLog(ticketId, startPhase, 'info', 'Locking start configuration.')
  // Note: The individual lock steps below use ✓/✗ formatting for consistency with pre-flight checks.
  try {
    const lockedTicket = lockTicketStartConfiguration(ticketId, {
      branchName: init.branchName,
      startedAt,
      lockedMainImplementer: modelSelection.mainImplementer,
      lockedMainImplementerVariant: lockedMainImplementerVariant,
      lockedCouncilMembers: modelSelection.councilMembers,
      lockedCouncilMemberVariants: lockedCouncilMemberVariants,
      lockedInterviewQuestions,
      lockedCoverageFollowUpBudgetPercent,
      lockedMaxCoveragePasses,
      lockedMaxPrdCoveragePasses,
      lockedMaxBeadsCoveragePasses,
      lockedStructuredRetryCount,
      lockedManualQaEnabled: manualQaResolution.enabled,
      lockedManualQaSource: manualQaResolution.source,
      lockedAiQuestionsEnabled: aiQuestionsResolution.enabled,
      lockedAiQuestionsSource: aiQuestionsResolution.source,
      lockedAiQuestionWindow: clampAiQuestionWindowMs(aiQuestionWindowResolution.windowMs),
      lockedAiQuestionWindowSource: aiQuestionWindowResolution.source,
      lockedGitHookPolicy: gitHookPolicyResolution.policy,
      lockedGitHookPolicySource: gitHookPolicyResolution.source,
    })
    if (!lockedTicket) {
      rollbackTicketStartToDraft(ticketId)
      emitRoutePhaseLog(ticketId, startPhase, 'error', '✗ Start Config: Ticket not found.')
      return c.json({ error: 'Ticket not found' }, 404)
    }
    emitRoutePhaseLog(ticketId, startPhase, 'info', '✓ Start Config: Configuration locked.', {
      branchName: init.branchName,
      startedAt,
      manualQaEnabled: manualQaResolution.enabled,
      manualQaSource: manualQaResolution.source,
      aiQuestionsEnabled: aiQuestionsResolution.enabled,
      aiQuestionsSource: aiQuestionsResolution.source,
      aiQuestionWindow: clampAiQuestionWindowMs(aiQuestionWindowResolution.windowMs),
      aiQuestionWindowSource: aiQuestionWindowResolution.source,
      gitHookPolicy: gitHookPolicyResolution.policy,
      gitHookPolicySource: gitHookPolicyResolution.source,
    })
  } catch (err) {
    const details = getErrorMessage(err)
    rollbackTicketStartToDraft(ticketId)
    emitRoutePhaseLog(ticketId, startPhase, 'error', `✗ Start Config: ${details}`, {
      error: details,
      rollback: 'preserved_worktree',
    })
    if (err instanceof TicketMetadataFormatError) {
      return c.json({ error: details }, 409)
    }
    return c.json({
      error: 'Failed to persist ticket start configuration',
      details,
    }, 500)
  }

  emitRoutePhaseLog(ticketId, startPhase, 'info', '✓ Workflow Dispatch: Start dispatched.')
  try {
    ensureActorForTicket(ticketId)
    sendTicketEvent(ticketId, {
      type: 'START',
      lockedMainImplementer: modelSelection.mainImplementer,
      lockedMainImplementerVariant: lockedMainImplementerVariant,
      lockedCouncilMembers: modelSelection.councilMembers,
      lockedCouncilMemberVariants: lockedCouncilMemberVariants,
      lockedInterviewQuestions,
      lockedCoverageFollowUpBudgetPercent,
      lockedMaxCoveragePasses,
      lockedMaxPrdCoveragePasses,
      lockedMaxBeadsCoveragePasses,
      lockedStructuredRetryCount,
      lockedManualQaEnabled: manualQaResolution.enabled,
      lockedManualQaSource: manualQaResolution.source,
      lockedAiQuestionsEnabled: aiQuestionsResolution.enabled,
      lockedAiQuestionsSource: aiQuestionsResolution.source,
      lockedAiQuestionWindow: clampAiQuestionWindowMs(aiQuestionWindowResolution.windowMs),
      lockedAiQuestionWindowSource: aiQuestionWindowResolution.source,
    })
  } catch (err) {
    rollbackTicketStartToDraft(ticketId)
    emitRoutePhaseLog(ticketId, startPhase, 'error', `✗ Workflow Dispatch: ${getErrorMessage(err)}`, {
      error: getErrorMessage(err),
      rollback: 'preserved_worktree',
    })
    logTicketOperationError(ticketId, 'Failed to send START to ticket', err)
    return c.json({ error: 'Failed to start ticket', details: getErrorMessage(err) }, 500)
  }

  return respondWithState(c, ticketId, 'Start action accepted')
  } finally {
    startingTickets.delete(startKey)
  }
}

export async function handleCancelTicket(c: Context) {
  const rawBody = await readJsonBody(c)
  if (!rawBody.ok) {
    return c.json({ error: 'Cancel request body must be valid JSON' }, 400)
  }
  const cancelOptions = cancelTicketSchema.safeParse(rawBody.body)
  // Rejecting rather than falling back to defaults. The old behaviour cancelled
  // the ticket anyway, which meant an oversized or malformed reason was dropped
  // while the destructive part of the request went ahead regardless.
  if (!cancelOptions.success) {
    return c.json({ error: 'Invalid cancel payload', details: cancelOptions.error.flatten() }, 400)
  }
  const ticketId = getTicketParam(c)
  return withTicketMergeLock(ticketId, () => handleCancelTicketLocked(c, cancelOptions.data))
}

async function handleCancelTicketLocked(c: Context, options: z.infer<typeof cancelTicketSchema>) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  if (isTerminalWorkflowStatus(ticket.status)) {
    return c.json({ error: 'Cannot cancel a terminal ticket' }, 409)
  }
  if (!getAvailableWorkflowActions(ticket.status).includes('cancel')
    || (ticket.status === 'WAITING_PR_REVIEW'
      && (hasVerifiedMergeReport(ticket) || hasClosedUnmergedReport(ticket)))) {
    return c.json({ error: 'Cannot cancel a ticket after completion has started' }, 409)
  }

  const { deleteContent, deleteLog, deleteTicket } = options
  const cancelReason = normalizeSkipReason(options.reason)
  // Snapshotted before anything fires: `CANCEL` moves the ticket to CANCELED, so
  // reading the phase afterwards would attribute the skip to the wrong status.
  const statusBeforeCancel = ticket.status

  try {
    if (isDisplayOnlyMockTicket(ticket)) {
      if (deleteTicket) {
        await deleteStoredTicket(ticketId)
      } else {
        patchTicket(ticketId, {
          status: 'CANCELED',
          xstateSnapshot: null,
          errorMessage: null,
        })
      }
    } else {
      const actor = ensureActorForTicket(ticketId)
      markTicketCancellationPending(ticketId)
      cancelTicket(ticketId)
      // Before the sessions go, so the receipts say the ticket was cancelled
      // rather than that a session vanished. Tearing the sessions down first
      // would file every outstanding question under `session_lost`, which is
      // true but tells a later reader nothing about why.
      const windowsClearedBeforeAbort = await clearTicketWindows(
        ticketId,
        'ticket_canceled',
        'The ticket was canceled while the question was open.',
      )
      const sessionsStopped = await abortTicketSessions(ticketId)
      // A question fallback and the session sweep can race each other. If the
      // sweep confirmed the remote session after the first window attempt, let
      // the session-ended hook finish the window before deciding cancellation
      // is unsafe.
      const windowsCleared = windowsClearedBeforeAbort || await clearTicketWindows(
        ticketId,
        'ticket_canceled',
        'The ticket was canceled while the question was open.',
      )
      if (windowsCleared === false || sessionsStopped === false) {
        schedulePendingCancellationCleanupRetry(ticketId, actor, event => sendTicketEvent(ticketId, event))
        return c.json({
          error: 'Cancellation could not be confirmed while OpenCode work is still active',
        }, 409)
      }
      sendTicketEvent(ticketId, { type: 'CANCEL' })
      if (deleteTicket) {
        stopActor(ticketId)
        clearContextCache(ticketId)
        emitRoutePhaseLog(ticketId, resolveStoredWorkflowPhase(ticket.status), 'info', `Deleting ticket ${ticket.externalId}: removing worktree, branch, and database records.`)
        await deleteStoredTicket(ticketId)
      }
    }
    if (!deleteTicket && cancelReason) {
      // The column, not a phase artifact: `deleteContent` wipes every phase
      // artifact for the ticket, which is exactly the option most likely to be
      // chosen alongside a cancel. `deleteTicket` leaves nothing at all, and
      // there is no point pretending otherwise.
      patchTicket(ticketId, { cancelReason })
    }
    if (!deleteTicket) {
      const receipts = writeSkipReceipts({
        ticketId,
        surface: 'cancel_ticket',
        itemType: 'ticket',
        phase: resolveStoredWorkflowPhase(statusBeforeCancel),
        ticketStatusBefore: statusBeforeCancel,
        actionId: deriveSkipActionId('cancel_ticket', [ticketId, statusBeforeCancel, cancelReason]),
        items: [{ itemId: null, reason: cancelReason }],
      })
      for (const line of formatSkipReceiptLogLines(receipts)) {
        emitRoutePhaseLog(ticketId, resolveStoredWorkflowPhase(statusBeforeCancel), 'info', line)
      }
    }
    if (deleteTicket) {
      broadcaster.clearTicket(ticketId)
    }
  } catch (err) {
    logTicketOperationError(ticketId, 'Failed to send CANCEL to ticket', err)
    return c.json({ error: 'Failed to cancel ticket', details: getErrorMessage(err) }, 500)
  }

  if (deleteTicket) {
    return c.json({ success: true, ticketId })
  }

  if (deleteContent || deleteLog) {
    try {
      await cleanupCanceledTicketData(ticketId, { deleteContent, deleteLog })
    } catch (err) {
      logTicketOperationError(ticketId, 'Failed to cleanup canceled ticket', err)
    }
  }

  return respondWithState(c, ticketId, 'Cancel action accepted')
}

export async function handleMergeTicket(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (hasClosedUnmergedReport(ticket)) {
    return c.json({ error: 'The pull request was already recorded as closed without merge; completion is pending. Try again to resume it.' }, 409)
  }
  if ((ticket.status === 'CLEANING_ENV' || ticket.status === 'COMPLETED') && hasVerifiedMergeReport(ticket)) {
    return respondWithState(c, ticketId, 'Merge complete')
  }
  if (ticket.status !== 'WAITING_PR_REVIEW') {
    return c.json({ error: 'Ticket is not waiting for pull request review' }, 409)
  }

  const ticketContext = getTicketContext(ticketId)
  if (!ticketContext) return c.json({ error: 'Ticket not found' }, 404)
  const prReport = readPullRequestReport(ticketId)
  if (!prReport || prReport.prNumber == null) {
    return c.json({ error: 'Pull request report not found' }, 409)
  }

  // The provider read is deliberately outside the ticket lock. The locked
  // phase rechecks the report identity before committing any merge result.
  let observed: PullRequestInfo
  try {
    observed = await refreshPullRequestState(ticketContext.projectRoot, prReport.prNumber)
  } catch (error) {
    try {
      recordPullRequestRefreshFailure({
        ticketId,
        projectPath: ticketContext.projectRoot,
        baseBranch: ticket.runtime.baseBranch,
        headBranch: prReport.headBranch,
        candidateCommitSha: ticket.runtime.candidateCommitSha,
        prNumber: prReport.prNumber,
        error,
      })
    } catch (receiptError) {
      logTicketOperationError(ticketId, 'Failed to persist pull request refresh receipt', receiptError)
    }
    return c.json({
      error: 'Could not verify the pull request before merging. No merge decision was recorded.',
      details: getErrorMessage(error),
    }, 502)
  }

  return withTicketMergeLock(ticketId, () => handleMergeTicketLocked(c, observed))
}

async function handleMergeTicketLocked(c: Context, observed: PullRequestInfo) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (hasClosedUnmergedReport(ticket)) {
    return c.json({ error: 'The pull request was already recorded as closed without merge; completion is pending. Try again to resume it.' }, 409)
  }
  if ((ticket.status === 'CLEANING_ENV' || ticket.status === 'COMPLETED') && hasVerifiedMergeReport(ticket)) {
    return respondWithState(c, ticketId, 'Merge complete')
  }
  if (ticket.status !== 'WAITING_PR_REVIEW') {
    return c.json({ error: 'Ticket is not waiting for pull request review' }, 409)
  }

  const ticketContext = getTicketContext(ticketId)
  if (!ticketContext) return c.json({ error: 'Ticket not found' }, 404)
  const prReport = readPullRequestReport(ticketId)
  if (!prReport || prReport.prNumber !== observed.number
    || (prReport.prUrl !== null && prReport.prUrl !== observed.url)) {
    return c.json({ error: 'Pull request report not found' }, 409)
  }

  const phase = 'WAITING_PR_REVIEW'

  try {
    const result = await completeTicketMerge(ticket, ticketContext.projectRoot, prReport, false, observed)
    if (result === 'corrected') {
      return respondWithState(c, ticketId, 'Final tests will run again for the corrected candidate.')
    }
    if (result === 'already_landed') {
      return respondWithState(c, ticketId, 'The merged pull request changes are verified on the base branch.')
    }
    if (result === 'skipped') {
      return respondWithState(c, ticketId, 'The merged pull request is older than the current candidate. Final tests will run before a new pull request is created.')
    }
  } catch (err) {
    const current = getTicketByRef(ticketId)
    if (current && hasVerifiedMergeReport(current)) {
      // Keep the verified attempt visible so the poller or another Merge can finish it.
      // Dispatching ERROR here would let Retry archive the committed checkpoint.
      return c.json({
        error: 'The pull request merge is verified, but ticket completion failed. Try Merge again.',
        details: getErrorMessage(err),
      }, 500)
    }
    const recovery = err instanceof EarlyMergeRecoveryManualError ? err.recovery : null
    const details = getErrorMessage(err)
    if (!recovery) {
      return c.json({
        error: 'The pull request could not be verified for completion. The ticket remains available to retry.',
        details,
      }, 502)
    }
    const message = `Pull request #${observed.number} requires manual recovery: ${details}`
    const codes = ['EARLY_MERGE_RECOVERY_MANUAL']
    try {
      ensureActorForTicket(ticketId)
      emitRoutePhaseLog(ticketId, phase, 'error', message, {
        recoveryReason: recovery.reason,
        recoveryWorktreePath: recovery.recoveryWorktreePath,
        conflictPaths: recovery.conflictPaths,
      })
      sendTicketEvent(ticketId, {
        type: 'ERROR',
        message,
        codes,
      })
      return respondWithState(c, ticketId, 'Merge failed and ticket was blocked')
    } catch (dispatchErr) {
      logTicketOperationError(ticketId, 'Failed to dispatch merge error for ticket', dispatchErr)
      return c.json({ error: 'Failed to merge pull request', details }, 500)
    }
  }

  return respondWithState(c, ticketId, 'Merge complete')
}

export async function handleCloseUnmergedTicket(c: Context) {
  const rawBody = await readJsonBody(c)
  if (!rawBody.ok) {
    return c.json({ error: 'Close request body must be valid JSON' }, 400)
  }
  const parsed = closeUnmergedSchema.safeParse(rawBody.body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid close payload', details: parsed.error.flatten() }, 400)
  }
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (ticket.status !== 'WAITING_PR_REVIEW') {
    return c.json({ error: 'Ticket is not waiting for pull request review' }, 409)
  }
  if (hasVerifiedMergeReport(ticket)) {
    return c.json({ error: 'The pull request merge is already verified; completion is pending. Try Merge again.' }, 409)
  }
  if (hasClosedUnmergedReport(ticket)) {
    return c.json({ error: 'The pull request was already recorded as closed without merge; completion is pending. Try again to resume it.' }, 409)
  }

  const context = getTicketContext(ticketId)
  const prReport = readPullRequestReport(ticketId)
  if (!context || !prReport || prReport.prNumber == null) {
    return c.json({ error: 'Pull request report not found; the ticket cannot be finished without verifying its current pull request.' }, 409)
  }

  // Do not hold the ticket lock while asking the remote provider. The observed
  // state is passed into the locked write phase and checked again there.
  let observed: PullRequestInfo
  try {
    observed = await refreshPullRequestState(context.projectRoot, prReport.prNumber)
  } catch (error) {
    try {
      recordPullRequestRefreshFailure({
        ticketId,
        projectPath: context.projectRoot,
        baseBranch: ticket.runtime.baseBranch,
        headBranch: prReport.headBranch,
        candidateCommitSha: ticket.runtime.candidateCommitSha,
        prNumber: prReport.prNumber,
        error,
      })
    } catch (receiptError) {
      logTicketOperationError(ticketId, 'Failed to persist pull request refresh receipt', receiptError)
    }
    return c.json({
      error: 'Could not verify the pull request before finishing without merge. No close decision was recorded.',
      details: getErrorMessage(error),
    }, 502)
  }
  return withTicketMergeLock(ticketId, () => handleCloseUnmergedTicketLocked(c, parsed.data, observed))
}

async function handleCloseUnmergedTicketLocked(
  c: Context,
  options: z.infer<typeof closeUnmergedSchema>,
  observed: PullRequestInfo,
) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (ticket.status !== 'WAITING_PR_REVIEW') {
    return c.json({ error: 'Ticket is not waiting for pull request review' }, 409)
  }

  if (hasVerifiedMergeReport(ticket)) {
    return c.json({ error: 'The pull request merge is already verified; completion is pending. Try Merge again.' }, 409)
  }
  if (hasClosedUnmergedReport(ticket)) {
    return c.json({ error: 'The pull request was already recorded as closed without merge; completion is pending. Try again to resume it.' }, 409)
  }

  const currentPrReport = readPullRequestReport(ticketId)
  if (!currentPrReport || currentPrReport.prNumber !== observed.number
    || (currentPrReport.prUrl !== null && currentPrReport.prUrl !== observed.url)) {
    return c.json({ error: 'The pull request changed while it was being verified. Reload and try again.' }, 409)
  }

  if (observed.state === 'merged') {
    // Keep the review projection honest before refusing a contradictory close
    // decision. The next request can use Merge to write the verified checkpoint.
    refreshPullRequestReport(ticketId, buildObservedPullRequestReport(currentPrReport, observed))
    return c.json({ error: 'The pull request is already merged; use Merge to finish completion.' }, 409)
  }

  const closeReason = normalizeSkipReason(options.reason)
  const statusBeforeClose = ticket.status
  let headBranch: string
  try {
    headBranch = resolvePullRequestHeadBranch(ticketId, ticket.branchName?.trim() || ticket.externalId, currentPrReport)
  } catch (error) {
    return c.json({ error: 'The active pull request does not match the ticket or its recorded corrective recovery.', details: getErrorMessage(error) }, 409)
  }
  if (observed.baseRefName !== ticket.runtime.baseBranch || observed.headRefName !== headBranch) {
    return c.json({ error: 'The pull request changed while it was being verified. Reload and try again.' }, 409)
  }

  try {
    const report = completeCloseUnmerged({
      ticketId,
      baseBranch: ticket.runtime.baseBranch,
      headBranch,
      candidateCommitSha: ticket.runtime.candidateCommitSha,
      prReport: buildObservedPullRequestReport(currentPrReport, observed),
      reason: closeReason,
    })

    ensureActorForTicket(ticketId)
    emitRoutePhaseLog(ticketId, 'WAITING_PR_REVIEW', 'info', report.message, {
      disposition: report.disposition,
      prNumber: report.prNumber,
      prUrl: report.prUrl,
    })
    const closeReceipts = writeSkipReceipts({
      ticketId,
      surface: 'close_unmerged',
      itemType: 'ticket',
      phase: 'WAITING_PR_REVIEW',
      ticketStatusBefore: statusBeforeClose,
      actionId: deriveSkipActionId('close_unmerged', [ticketId, closeReason]),
      items: [{ itemId: null, reason: closeReason }],
    })
    for (const line of formatSkipReceiptLogLines(closeReceipts)) {
      emitRoutePhaseLog(ticketId, 'WAITING_PR_REVIEW', 'info', line)
    }
    sendTicketEvent(ticketId, { type: 'CLOSE_UNMERGED_COMPLETE' })
  } catch (err) {
    logTicketOperationError(ticketId, 'Failed to close ticket', err, 'without merge')
    return c.json({ error: 'Failed to finish ticket without merge', details: getErrorMessage(err) }, 500)
  }

  return respondWithState(c, ticketId, 'Finished without merge')
}

export function handleVerifyTicket(c: Context) {
  return handleMergeTicket(c)
}

async function clearPendingCancellationForRetry(ticketId: string): Promise<boolean> {
  if (!isTicketCancellationPending(ticketId)) return true
  let stopped = false
  try {
    stopped = await abortTicketSessions(ticketId)
  } catch {
    return false
  }
  if (!stopped) return false
  const windowsCleared = await clearTicketWindows(
    ticketId,
    'ticket_canceled',
    'The ticket was canceled while the question was open.',
  )
  return windowsCleared && clearTicketCancellationPending(ticketId)
}

export async function handleRetryTicket(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (ticket.status !== 'BLOCKED_ERROR') {
    return c.json({ error: 'Retry only works from BLOCKED_ERROR state' }, 409)
  }
  if (!ticket.previousStatus) {
    return c.json({ error: 'Retry is not available because the failed status could not be recovered' }, 409)
  }

  let body: unknown = {}
  try {
    const rawBody = await c.req.text()
    body = rawBody.length === 0 ? {} : JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Retry request body must be valid JSON' }, 400)
  }
  const parsedBody = retryTicketSchema.safeParse(body)
  if (!parsedBody.success) {
    return c.json({ error: parsedBody.error.issues[0]?.message ?? 'Invalid retry request' }, 400)
  }
  const recoveryClaim = claimPlanningEdit(ticketId)
  if (!recoveryClaim) return c.json({ error: 'Another ticket recovery or edit is already in progress' }, 409)
  try {
    if (getTicketByRef(ticketId)?.status !== 'BLOCKED_ERROR') {
      return c.json({ error: 'Retry only works from BLOCKED_ERROR state' }, 409)
    }
    const userRetryNote = parsedBody.data.note
    if (userRetryNote !== undefined && ticket.previousStatus === 'CODING'
      && hasSuccessfulExecutionCheckpointForFinalization(ticketId)) {
      return c.json({ error: 'The AI implementation already succeeded; use Retry to finish saving its result' }, 409)
    }
    if (userRetryNote !== undefined && !canRetryWithExtraNote(ticketId, ticket.previousStatus)) {
      return c.json({ error: 'Retry with extra note is only available for failed AI work' }, 409)
    }

    const codingPaths = ticket.previousStatus === 'CODING' ? getTicketPaths(ticketId) : null
    if (ticket.previousStatus === 'CODING' && !codingPaths) {
      return c.json({ error: 'Retry is not available because the ticket workspace could not be resolved' }, 409)
    }

    if (isExecutionBandStatus(ticket.previousStatus)) {
      const executionConflict = findProjectExecutionBandConflict(ticket.projectId, ticket.id)
      if (executionConflict) {
        return c.json({ error: buildExecutionBandConflictMessage(ticket, executionConflict) }, 409)
      }
    }

    let retryStep: string | undefined
    if (['CREATING_PULL_REQUEST', 'VERIFYING_PRD_COVERAGE', 'VERIFYING_BEADS_COVERAGE'].includes(ticket.previousStatus)) {
      const failedSessionId = ticket.errorOccurrences.find(error => error.id === ticket.activeErrorOccurrenceId)?.diagnostics?.sessionId
      const attempt = getActivePhaseAttempt(ticketId, ticket.previousStatus) ?? 1
      const failedSession = listOpenCodeSessionsForTicket(ticketId, [])
        .filter(session => session.phase === ticket.previousStatus && session.phaseAttempt === attempt
          && (failedSessionId === undefined || session.sessionId === failedSessionId))
        .sort((left, right) => right.id - left.id)[0]
      retryStep = failedSession?.step ?? undefined
    }

    // Retry must never reconnect to work that the previous attempt left running.
    let stopped: boolean
    try {
      stopped = await abortTicketSessions(ticketId)
    } catch (err) {
      return c.json({
        error: 'Retry is not available until the previous OpenCode session stop is confirmed',
        details: getErrorMessage(err),
      }, 409)
    }
    if (!stopped) {
      return c.json({
        error: 'Retry is not available until the previous OpenCode session stop is confirmed',
      }, 409)
    }
    assertPlanningEditClaim(ticketId, recoveryClaim)
    if (!await clearPendingCancellationForRetry(ticketId)) {
      return c.json({ error: 'Retry is not available until the previous cancellation cleanup is confirmed' }, 409)
    }
    assertPlanningEditClaim(ticketId, recoveryClaim)
    const interviewSnapshot = ticket.previousStatus === 'WAITING_INTERVIEW_ANSWERS'
      ? readInterviewRetrySnapshot(ticketId)
      : null
    if (ticket.previousStatus === 'WAITING_INTERVIEW_ANSWERS') interviewQASessions.delete(ticketId)

    if (ticket.previousStatus === 'CODING' && codingPaths) {
      const paths = codingPaths
      try {
        const finalizedBead = recoverSuccessfulExecutionCheckpointForFinalization(ticketId)
        const recoveredBead = finalizedBead ?? await recoverCodingBeadWithReset(ticketId, {
          worktreePath: paths.worktreePath,
          requireReset: true,
          userRetryNote,
        })
        if (!recoveredBead) {
          return c.json({ error: 'Retry is not available because no failed bead could be restored' }, 409)
        }
      } catch (err) {
        return c.json({
          error: 'Retry is not available because the failed bead could not be safely reset',
          details: getErrorMessage(err),
        }, 409)
      }
    }

    try {
      if (isAttemptTrackedPhase(ticket.previousStatus)) {
        ensureActivePhaseAttempt(ticketId, ticket.previousStatus)
        archiveActivePhaseAttempts(ticketId, [ticket.previousStatus], 'manual_retry_after_blocked_error')
        createFreshPhaseAttempts(ticketId, [ticket.previousStatus])
      }
      if (interviewSnapshot) persistInterviewRetrySnapshot(ticketId, interviewSnapshot)
      if (ticket.previousStatus !== 'CODING') {
        savePhaseRetryNote(ticketId, resolveStoredWorkflowPhase(ticket.previousStatus), userRetryNote, retryStep)
      }
      if (ticket.previousStatus === 'WAITING_MANUAL_QA') requestManualQaSubmissionRecovery(ticketId)
      ensureActorForTicket(ticketId)
      sendTicketEvent(ticketId, { type: 'RETRY' })
    } catch (err) {
      if (ticket.previousStatus === 'WAITING_MANUAL_QA') requestManualQaSubmissionRecovery(ticketId, false)
      if (userRetryNote !== undefined && ticket.previousStatus !== 'CODING') {
        try {
          savePhaseRetryNote(ticketId, resolveStoredWorkflowPhase(ticket.previousStatus), undefined)
        } catch (cleanupError) {
          logTicketOperationError(ticketId, 'Failed to clear the rejected retry note', cleanupError)
        }
      }
      logTicketOperationError(ticketId, 'Failed to send RETRY to ticket', err)
      return c.json({ error: 'Failed to retry ticket', details: getErrorMessage(err) }, 500)
    }

    if (userRetryNote !== undefined) {
      emitRoutePhaseLog(ticketId, resolveStoredWorkflowPhase(ticket.previousStatus), 'info',
        `Retry with extra note:\n${userRetryNote}`, { userRetryNote })
    }
    return respondWithState(c, ticketId, 'Retry action accepted')
  } finally {
    releasePlanningEdit(ticketId, recoveryClaim)
  }
}

export async function handleContinueTicket(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (ticket.status !== 'BLOCKED_ERROR') {
    return c.json({ error: 'Continue only works from BLOCKED_ERROR state' }, 409)
  }
  if (!ticket.previousStatus) {
    return c.json({ error: 'Continue is not available because the failed status could not be recovered' }, 409)
  }

  const continuation = resolveTicketContinuationCandidate(ticketId)
  if (!continuation) {
    return c.json({ error: 'Continue is not available for this blocked error' }, 409)
  }

  if (isExecutionBandStatus(continuation.previousStatus)) {
    const executionConflict = findProjectExecutionBandConflict(ticket.projectId, ticket.id)
    if (executionConflict) {
      return c.json({ error: buildExecutionBandConflictMessage(ticket, executionConflict) }, 409)
    }
  }

  const recoveryClaim = claimPlanningEdit(ticketId)
  if (!recoveryClaim) return c.json({ error: 'Another ticket recovery or edit is already in progress' }, 409)
  try {
    if (getTicketByRef(ticketId)?.status !== 'BLOCKED_ERROR') {
      return c.json({ error: 'Continue only works from BLOCKED_ERROR state' }, 409)
    }
    let liveSession
    try {
      liveSession = await getOpenCodeAdapter().getSession(continuation.sessionId)
    } catch (err) {
      logTicketOperationError(ticketId, 'Failed to verify OpenCode session before continuing ticket', err)
      return c.json({
        error: 'Continue is not available because the OpenCode session could not be verified',
        details: getErrorMessage(err),
      }, 500)
    }

    if (!liveSession) {
      return c.json({
        error: 'Continue is not available because the preserved OpenCode session is no longer active',
      }, 409)
    }

    let stopped = false
    try {
      stopped = await getOpenCodeAdapter().abortSession(continuation.sessionId)
    } catch (err) {
      logTicketOperationError(ticketId, 'Failed to stop OpenCode turn before continuing ticket', err)
    }
    if (!stopped) {
      return c.json({ error: 'Continue is not available until the previous OpenCode turn stop is confirmed' }, 409)
    }
    assertPlanningEditClaim(ticketId, recoveryClaim)
    requestSessionContinuation({
      ticketId,
      phase: resolveStoredWorkflowPhase(continuation.previousStatus),
      sessionId: continuation.sessionId,
    })

    try {
      if (continuation.previousStatus === 'WAITING_MANUAL_QA') requestManualQaSubmissionRecovery(ticketId)
      ensureActorForTicket(ticketId)
      sendTicketEvent(ticketId, { type: 'CONTINUE' })
    } catch (err) {
      if (continuation.previousStatus === 'WAITING_MANUAL_QA') requestManualQaSubmissionRecovery(ticketId, false)
      clearSessionContinuation(continuation.sessionId)
      logTicketOperationError(ticketId, 'Failed to send CONTINUE to ticket', err)
      return c.json({ error: 'Failed to continue ticket', details: getErrorMessage(err) }, 500)
    }

    return respondWithState(c, ticketId, 'Continue action accepted')
  } finally {
    releasePlanningEdit(ticketId, recoveryClaim)
  }
}
