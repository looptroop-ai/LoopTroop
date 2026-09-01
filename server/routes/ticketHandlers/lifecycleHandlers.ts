import type { Context } from 'hono'
import { PROFILE_DEFAULTS } from '../../db/defaults'
import {
  ensureActorForTicket,
  getTicketState,
  sendTicketEvent,
  stopActor,
} from '../../machines/persistence'
import {
  abortTicketSessions,
  listOpenCodeSessionsForTicket,
  reactivateOpenCodeSessionForContinuation,
} from '../../opencode/sessionManager'
import { clearContextCache } from '../../opencode/contextBuilder'
import { getOpenCodeAdapter } from '../../opencode/factory'
import { normalizeStructuredRetryCount } from '../../lib/structuredRetryPolicy'
import { isGitHookPolicy } from '../../git/hookPolicy'
import { cancelTicket } from '../../workflow/runner'
import { TicketInitializationError, initializeTicket } from '../../ticket/initialize'
import { withCommandLogging } from '../../log/commandLogger'
import { validateModelSelection } from '../../opencode/modelValidation'
import { registerOpenRouterRoutingModels } from '../../opencode/openRouterRoutingConfig'
import { refreshProviderCatalog } from '../../opencode/providerCatalog'
import {
  archiveActivePhaseAttempts,
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
  patchTicket,
  resolveTicketContinuationCandidate,
} from '../../storage/tickets'
import {
  completeCloseUnmerged,
  completeMergedPullRequest,
  readPullRequestReport,
} from '../../workflow/phases/pullRequestPhase'
import { recoverCodingBeadWithReset } from '../../workflow/phases/beadsPhase'
import { recoverSuccessfulExecutionCheckpointForFinalization } from '../../workflow/phases/executionPhase'
import { isExecutionBandStatus } from '../../workflow/executionBand'
import { getErrorMessage } from '@shared/typeGuards'
import { isTerminalWorkflowStatus } from '@shared/workflowMeta'
import { broadcaster } from '../../sse/broadcaster'
import {
  clearSessionContinuation,
  requestSessionContinuation,
} from '../../opencode/sessionContinuation'
import {
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
import { clearTicketWorkBudget } from '../../workflow/workBudget'
import { resolveStoredWorkflowPhase } from '@shared/workflowMeta'

function rollbackTicketStartToDraft(ticketId: string): void {
  patchTicket(ticketId, {
    status: 'DRAFT',
    xstateSnapshot: null,
    errorMessage: null,
    branchName: null,
    startedAt: null,
    lockedMainImplementer: null,
    lockedMainImplementerVariant: null,
    lockedCouncilMembers: null,
    lockedCouncilMemberVariants: null,
    lockedInterviewQuestions: null,
    lockedCoverageFollowUpBudgetPercent: null,
    lockedMaxCoveragePasses: null,
    lockedMaxPrdCoveragePasses: null,
    lockedMaxBeadsCoveragePasses: null,
    lockedStructuredRetryCount: null,
    lockedManualQaEnabled: null,
    lockedManualQaSource: null,
    lockedAiQuestionsEnabled: null,
    lockedAiQuestionsSource: null,
    lockedAiQuestionWindow: null,
    lockedAiQuestionWindowSource: null,
    lockedGitHookPolicy: null,
    lockedGitHookPolicySource: null,
  })
  stopActor(ticketId)
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

  if (startingTickets.has(ticketId)) {
    return c.json({ error: 'Ticket start is already in progress' }, 429)
  }
  startingTickets.add(ticketId)

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
    if (registerOpenRouterRoutingModels(modelSelection.councilMembers)) {
      await refreshProviderCatalog()
      emitRoutePhaseLog(ticketId, startPhase, 'info', 'Registered selected OpenRouter routing variants with OpenCode.')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to register OpenRouter routing models'
    emitRoutePhaseLog(ticketId, startPhase, 'error', `✗ OpenRouter Routing: ${message}`, { error: message })
    return c.json({ error: message }, 502)
  }

  emitRoutePhaseLog(ticketId, startPhase, 'info', 'Initializing workspace and ticket directories.')
  let init: ReturnType<typeof initializeTicket>
  try {
    init = withCommandLogging(
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
    const initErr = err instanceof TicketInitializationError
      ? err
      : new TicketInitializationError('INIT_UNKNOWN', getErrorMessage(err))
    emitRoutePhaseLog(ticketId, startPhase, 'error', `✗ Workspace Init: ${initErr.message}`, {
      code: initErr.code,
      error: initErr.message,
    })

    try {
      ensureActorForTicket(ticketId)
      sendTicketEvent(ticketId, {
        type: 'INIT_FAILED',
        message: initErr.message,
        codes: [initErr.code],
      })
    } catch (sendErr) {
      const sendErrDetails = getErrorMessage(sendErr)
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
      details: initErr.message,
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
      try {
        lockedCouncilMemberVariants = JSON.parse(profile.councilMemberVariants)
      } catch (err) {
        console.warn(`[tickets] Invalid councilMemberVariants configuration for ticket ${ticketId}:`, err)
        return c.json({ error: 'Invalid configuration: malformed councilMemberVariants' }, 500)
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
    startingTickets.delete(ticketId)
  }
}

export async function handleCancelTicket(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  if (isTerminalWorkflowStatus(ticket.status)) {
    return c.json({ error: 'Cannot cancel a terminal ticket' }, 409)
  }

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
  const { deleteContent, deleteLog, deleteTicket } = cancelOptions.data
  const cancelReason = normalizeSkipReason(cancelOptions.data.reason)
  // Snapshotted before anything fires: `CANCEL` moves the ticket to CANCELED, so
  // reading the phase afterwards would attribute the skip to the wrong status.
  const statusBeforeCancel = ticket.status

  try {
    if (isDisplayOnlyMockTicket(ticket)) {
      if (deleteTicket) {
        deleteStoredTicket(ticketId)
      } else {
        patchTicket(ticketId, {
          status: 'CANCELED',
          xstateSnapshot: null,
          errorMessage: null,
        })
      }
    } else {
      ensureActorForTicket(ticketId)
      sendTicketEvent(ticketId, { type: 'CANCEL' })
      cancelTicket(ticketId)
      // Before the sessions go, so the receipts say the ticket was cancelled
      // rather than that a session vanished. Tearing the sessions down first
      // would file every outstanding question under `session_lost`, which is
      // true but tells a later reader nothing about why.
      await clearTicketWindows(ticketId, 'ticket_canceled', 'The ticket was canceled while the question was open.')
      await abortTicketSessions(ticketId)
      // A suspension surviving the cancel would hold the clocks of whatever
      // runs next on this ticket.
      clearTicketWorkBudget(ticketId)
      if (deleteTicket) {
        stopActor(ticketId)
        clearContextCache(ticketId)
        emitRoutePhaseLog(ticketId, resolveStoredWorkflowPhase(ticket.status), 'info', `Deleting ticket ${ticket.externalId}: removing worktree, branch, and database records.`)
        deleteStoredTicket(ticketId)
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
      cleanupCanceledTicketData(ticketId, { deleteContent, deleteLog })
    } catch (err) {
      logTicketOperationError(ticketId, 'Failed to cleanup canceled ticket', err)
    }
  }

  return respondWithState(c, ticketId, 'Cancel action accepted')
}

export function handleMergeTicket(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (ticket.status !== 'WAITING_PR_REVIEW') {
    return c.json({ error: 'Ticket is not waiting for pull request review' }, 409)
  }

  const ticketContext = getTicketContext(ticketId)
  if (!ticketContext) return c.json({ error: 'Ticket not found' }, 404)
  const prReport = readPullRequestReport(ticketId)
  if (!prReport) {
    return c.json({ error: 'Pull request report not found' }, 409)
  }

  const phase = 'WAITING_PR_REVIEW'

  try {
    const mergeReport = withCommandLogging(
      ticketId,
      ticket.externalId,
      phase,
      () => completeMergedPullRequest({
        ticketId,
        externalId: ticket.externalId,
        projectPath: ticketContext.projectRoot,
        baseBranch: ticket.runtime.baseBranch,
        headBranch: ticket.branchName?.trim() || ticket.externalId,
        candidateCommitSha: ticket.runtime.candidateCommitSha,
        prReport,
      }),
      (cmdPhase, type, content) => emitRoutePhaseLog(ticketId, cmdPhase, type, content),
    )

    ensureActorForTicket(ticketId)
    emitRoutePhaseLog(ticketId, phase, 'info', mergeReport.message, {
      prNumber: mergeReport.prNumber,
      prUrl: mergeReport.prUrl,
      prState: mergeReport.prState,
      localBaseHead: mergeReport.localBaseHead,
      remoteBaseHead: mergeReport.remoteBaseHead,
    })
    sendTicketEvent(ticketId, { type: 'MERGE_COMPLETE' })
  } catch (err) {
    const details = getErrorMessage(err)
    const message = `Pull request merge failed: ${details}`
    const codes = ['PULL_REQUEST_MERGE_FAILED']
    try {
      ensureActorForTicket(ticketId)
      emitRoutePhaseLog(ticketId, phase, 'error', message)
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
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (ticket.status !== 'WAITING_PR_REVIEW') {
    return c.json({ error: 'Ticket is not waiting for pull request review' }, 409)
  }

  const rawBody = await readJsonBody(c)
  if (!rawBody.ok) {
    return c.json({ error: 'Close request body must be valid JSON' }, 400)
  }
  const parsed = closeUnmergedSchema.safeParse(rawBody.body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid close payload', details: parsed.error.flatten() }, 400)
  }
  const closeReason = normalizeSkipReason(parsed.data.reason)
  const statusBeforeClose = ticket.status

  try {
    const report = completeCloseUnmerged({
      ticketId,
      baseBranch: ticket.runtime.baseBranch,
      headBranch: ticket.branchName?.trim() || ticket.externalId,
      candidateCommitSha: ticket.runtime.candidateCommitSha,
      prReport: readPullRequestReport(ticketId),
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
  const userRetryNote = parsedBody.data.note
  if (userRetryNote !== undefined && ticket.previousStatus !== 'CODING' && ticket.previousStatus !== 'PREPARING_EXECUTION_ENV') {
    return c.json({ error: 'Retry notes are only available for implementation or workspace runtime setup errors' }, 409)
  }

  if (isExecutionBandStatus(ticket.previousStatus)) {
    const executionConflict = findProjectExecutionBandConflict(ticket.projectId, ticket.id)
    if (executionConflict) {
      return c.json({ error: buildExecutionBandConflictMessage(ticket, executionConflict) }, 409)
    }
  }

  if (userRetryNote !== undefined && ticket.previousStatus === 'PREPARING_EXECUTION_ENV') {
    const setupSession = listOpenCodeSessionsForTicket(ticketId, ['active', 'abandoned'])
      .filter(session => session.phase === 'PREPARING_EXECUTION_ENV')
      .sort((left, right) => (
        (right.phaseAttempt ?? 0) - (left.phaseAttempt ?? 0)
        || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      ))[0]
    if (!setupSession) {
      return c.json({
        error: 'Retry with extra note is not available because the workspace setup session could not be recovered',
      }, 409)
    }

    let liveSession
    try {
      liveSession = await getOpenCodeAdapter().getSession(setupSession.sessionId)
    } catch (err) {
      return c.json({
        error: 'Retry with extra note is not available because the workspace setup session could not be verified',
        details: getErrorMessage(err),
      }, 500)
    }
    if (!liveSession) {
      return c.json({
        error: 'Retry with extra note is not available because the workspace setup session is no longer active',
      }, 409)
    }
    if (!reactivateOpenCodeSessionForContinuation(
      ticketId,
      'PREPARING_EXECUTION_ENV',
      setupSession.sessionId,
    )) {
      return c.json({ error: 'Retry with extra note could not recover the workspace setup session' }, 409)
    }

    requestSessionContinuation({
      ticketId,
      phase: 'PREPARING_EXECUTION_ENV',
      sessionId: setupSession.sessionId,
      prompt: userRetryNote,
      additionalRetryAttempts: 1,
    })
    try {
      ensureActorForTicket(ticketId)
      sendTicketEvent(ticketId, { type: 'RETRY' })
    } catch (err) {
      clearSessionContinuation(setupSession.sessionId)
      logTicketOperationError(ticketId, 'Failed to resume workspace setup session for ticket', err)
      return c.json({ error: 'Failed to retry workspace setup with the extra note', details: getErrorMessage(err) }, 500)
    }

    return respondWithState(c, ticketId, 'Workspace setup note accepted')
  }

  if (ticket.previousStatus === 'CODING') {
    const paths = getTicketPaths(ticketId)
    if (!paths) {
      return c.json({ error: 'Retry is not available because the ticket workspace could not be resolved' }, 409)
    }
    try {
      const recoveredBead = (userRetryNote === undefined
        ? recoverSuccessfulExecutionCheckpointForFinalization(ticketId)
        : null)
        ?? recoverCodingBeadWithReset(ticketId, {
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
    if (ticket.previousStatus === 'PREPARING_EXECUTION_ENV') {
      await abortTicketSessions(ticketId)
    }
    if (isAttemptTrackedPhase(ticket.previousStatus)) {
      ensureActivePhaseAttempt(ticketId, ticket.previousStatus)
      archiveActivePhaseAttempts(ticketId, [ticket.previousStatus], 'manual_retry_after_blocked_error')
      createFreshPhaseAttempts(ticketId, [ticket.previousStatus])
    }
    ensureActorForTicket(ticketId)
    sendTicketEvent(ticketId, { type: 'RETRY' })
  } catch (err) {
    logTicketOperationError(ticketId, 'Failed to send RETRY to ticket', err)
    return c.json({ error: 'Failed to retry ticket', details: getErrorMessage(err) }, 500)
  }

  return respondWithState(c, ticketId, 'Retry action accepted')
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

  requestSessionContinuation({
    ticketId,
    phase: resolveStoredWorkflowPhase(continuation.previousStatus),
    sessionId: continuation.sessionId,
  })

  try {
    ensureActorForTicket(ticketId)
    sendTicketEvent(ticketId, { type: 'CONTINUE' })
  } catch (err) {
    clearSessionContinuation(continuation.sessionId)
    logTicketOperationError(ticketId, 'Failed to send CONTINUE to ticket', err)
    return c.json({ error: 'Failed to continue ticket', details: getErrorMessage(err) }, 500)
  }

  return respondWithState(c, ticketId, 'Continue action accepted')
}
