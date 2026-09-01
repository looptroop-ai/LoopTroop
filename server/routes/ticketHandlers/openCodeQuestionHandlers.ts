import type { Context } from 'hono'
import { buildOpenCodeQuestionLogIdentity, type OpenCodeQuestionLogAction } from '@shared/logIdentity'
import { listOpenCodeSessionsForTicket } from '../../opencode/sessionManager'
import { getOpenCodeAdapter } from '../../opencode/factory'
import { broadcaster } from '../../sse/broadcaster'
import { appendLogEvent, createLogEvent, shouldSkipLogEmission } from '../../log/executionLog'
import {
  getTicketByRef,
  getTicketContext,
  listNonTerminalTickets,
} from '../../storage/tickets'
import { getErrorMessage } from '@shared/typeGuards'
import {
  emitRoutePhaseLog,
  getRequiredRouteParam,
  getTicketParam,
} from './routeUtils'
import {
  opencodeQuestionReplySchema,
  opencodeQuestionSkipSchema,
  opencodeQuestionTimerStopSchema,
} from './schemas'
import { normalizeSkipReason } from '@shared/skipReceipt'
import type { AiQuestionTimerState } from '@shared/aiQuestions'
import {
  attachRequest,
  claimRequestForReply,
  getTicketQuestionState,
  markRequestReplied,
  markRequestSkipped,
  reconcileAgainstPending,
  releaseRequestClaim,
  stopTicketTimers,
} from '../../workflow/questionWindows'
import { resolveAiQuestionSettings } from '../../workflow/phases/helpers'
import { resolveStoredWorkflowPhase, type WorkflowPhaseId } from '@shared/workflowMeta'

function emitOpenCodeQuestionLog(
  ticketId: string,
  phase: WorkflowPhaseId,
  content: string,
  data: {
    requestId: string
    sessionId?: string
    modelId?: string
    phaseAttempt?: number
    kind?: 'session' | 'error'
    type?: 'info' | 'error'
    action: OpenCodeQuestionLogAction
  },
) {
  const timestamp = new Date().toISOString()
  const logType = data.type ?? (data.kind === 'error' ? 'error' : 'info')
  const source = data.kind === 'error' ? 'error' : data.modelId ? `model:${data.modelId}` as const : 'opencode'
  const identity = buildOpenCodeQuestionLogIdentity({
    sessionId: data.sessionId,
    requestId: data.requestId,
    action: data.action,
  })
  const structuredExtra = {
    audience: 'ai' as const,
    kind: data.kind ?? 'session',
    op: 'append' as const,
    streaming: false,
    entryId: identity.entryId,
    fingerprint: identity.fingerprint,
    ...(data.modelId ? { modelId: data.modelId } : {}),
    ...(data.sessionId ? { sessionId: data.sessionId } : {}),
    ...(typeof data.phaseAttempt === 'number' && Number.isFinite(data.phaseAttempt) ? { phaseAttempt: data.phaseAttempt } : {}),
  }
  const emissionData = {
    ticketId,
    requestId: data.requestId,
    fingerprint: identity.fingerprint,
    timestamp,
    ...(typeof data.phaseAttempt === 'number' && Number.isFinite(data.phaseAttempt) ? { phaseAttempt: data.phaseAttempt } : {}),
  }
  if (shouldSkipLogEmission(ticketId, logType, phase, content, emissionData, source, phase, structuredExtra)) {
    return
  }

  const event = createLogEvent(
    ticketId,
    logType,
    phase,
    content,
    emissionData,
    source,
    phase,
    structuredExtra,
  )
  broadcaster.broadcast(ticketId, 'log', { ...event })
  appendLogEvent(
    ticketId,
    logType,
    phase,
    content,
    emissionData,
    source,
    phase,
    structuredExtra,
  )
}

/**
 * What is outstanding for a ticket, reconciled against OpenCode.
 *
 * The window store is the live record and the adapter is the authority. A poll
 * that succeeds is allowed to prune: anything OpenCode no longer lists was
 * resolved somewhere this process could not see, and showing it would leave a
 * question on screen that nobody can answer. A poll that *fails* prunes nothing
 * — an unreachable server is not evidence that a question went away.
 */
async function getTicketPendingOpenCodeQuestions(ticketId: string) {
  const ticketContext = getTicketContext(ticketId)
  if (!ticketContext) return null

  const sessions = listOpenCodeSessionsForTicket(ticketId, ['active'])
  const sessionsById = new Map(sessions.map((session) => [session.sessionId, session]))

  try {
    const pending = await getOpenCodeAdapter().listPendingQuestions(ticketContext.projectRoot)
    const live = pending.filter((request) => sessionsById.has(request.sessionID))
    reconcileAgainstPending(ticketId, new Set(live.map((request) => request.id)))

    // Anything OpenCode has that no window covers arrived while this process was
    // not listening — a restart, or a stream frame that never landed. Arm it now
    // rather than leaving a question with no clock on it.
    const known = new Set(getTicketQuestionState(ticketId).requests.map((request) => request.requestId))
    for (const request of live) {
      if (known.has(request.id)) continue
      const session = sessionsById.get(request.sessionID)
      attachRequest({
        ticketId,
        sessionId: request.sessionID,
        requestId: request.id,
        memberId: session?.memberId ?? null,
        // A session row stores its phase as free text, so one written by an
        // older build can name a status that no longer exists. The ticket's own
        // status is the fallback rather than dropping the question: an unclocked
        // question waits forever, which is the failure this path exists to stop.
        phase: resolveStoredWorkflowPhase(session?.phase, ticketContext.localTicket.status),
        phaseAttempt: session?.phaseAttempt ?? 1,
        windowMs: resolveAiQuestionSettings(ticketId).windowMs,
        questions: request.questions,
        tool: request.tool,
      })
    }
  } catch {
    // Fall through to whatever the window store already knows.
  }

  const state = getTicketQuestionState(ticketId)
  return state.requests.map((request) => ({
    type: 'opencode_question' as const,
    action: 'asked' as const,
    ticketId,
    ticketExternalId: ticketContext.externalId,
    ticketTitle: ticketContext.localTicket.title,
    status: ticketContext.localTicket.status,
    phase: request.phase,
    phaseAttempt: request.phaseAttempt,
    modelId: request.memberId ?? undefined,
    sessionId: request.sessionId,
    requestId: request.requestId,
    questions: request.questions,
    questionCount: request.questionCount,
    tool: request.tool,
    timerKey: request.timerKey,
    timestamp: request.receivedAt,
  }))
}

async function findPendingOpenCodeQuestionForTicket(ticketId: string, requestId: string) {
  const questions = await getTicketPendingOpenCodeQuestions(ticketId)
  if (!questions) return null
  return questions.find((request) => request.requestId === requestId) ?? null
}

export async function handleListOpenCodeQuestions(c: Context) {
  const ticketId = getTicketParam(c)
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)

  try {
    const questions = await getTicketPendingOpenCodeQuestions(ticketId)
    if (!questions) return c.json({ error: 'Ticket not found' }, 404)
    return c.json({ questions, timer: getTicketQuestionState(ticketId).timer })
  } catch (err) {
    const message = getErrorMessage(err)
    // The ticket may have gone, or hold a status this build no longer declares.
    // The failure still has to be logged against something real.
    emitRoutePhaseLog(ticketId, resolveStoredWorkflowPhase(getTicketByRef(ticketId)?.status), 'error', `Failed to list OpenCode questions: ${message}`)
    return c.json({ error: 'Failed to list OpenCode questions', details: message }, 500)
  }
}

export async function handleListAllOpenCodeQuestions(c: Context) {
  const questions: NonNullable<Awaited<ReturnType<typeof getTicketPendingOpenCodeQuestions>>> = []
  const timers: Record<string, AiQuestionTimerState> = {}
  const errors: Array<{ ticketId: string; message: string }> = []

  for (const ticket of listNonTerminalTickets()) {
    try {
      const ticketQuestions = await getTicketPendingOpenCodeQuestions(ticket.id)
      if (ticketQuestions?.length) {
        questions.push(...ticketQuestions)
        const timer = getTicketQuestionState(ticket.id).timer
        if (timer) timers[ticket.id] = timer
      }
    } catch (err) {
      errors.push({ ticketId: ticket.id, message: getErrorMessage(err) })
    }
  }

  return c.json({
    questions,
    timers,
    ...(errors.length > 0 ? { errors } : {}),
  })
}

export async function handleReplyOpenCodeQuestion(c: Context) {
  const ticketId = getTicketParam(c)
  const requestId = getRequiredRouteParam(c, 'requestId')
  const ticketContext = getTicketContext(ticketId)
  if (!ticketContext) return c.json({ error: 'Ticket not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const parsed = opencodeQuestionReplySchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid question reply payload', details: parsed.error.flatten() }, 400)
  }

  const question = await findPendingOpenCodeQuestionForTicket(ticketId, requestId)
  if (!question) return c.json({ error: 'OpenCode question request not found for ticket' }, 404)

  // Claim before calling OpenCode. Expiry, cancellation and this answer all race
  // for the same request, and whoever loses must do nothing at all rather than
  // send a second verdict for a question that already has one. The id is what
  // completes the claim afterwards — resolving it by claiming a second time
  // could never succeed, because the request is no longer pending.
  const claimId = claimRequestForReply(ticketId, question.sessionId, requestId)
  if (!claimId) {
    return c.json({ error: 'That question was already resolved' }, 409)
  }

  try {
    await getOpenCodeAdapter().replyQuestion(requestId, parsed.data.answers, ticketContext.projectRoot)
    markRequestReplied(ticketId, question.sessionId, requestId, claimId)
    emitOpenCodeQuestionLog(ticketId, question.phase, '[QUESTION] AI question answered.', {
      requestId,
      sessionId: question.sessionId,
      modelId: question.modelId,
      phaseAttempt: question.phaseAttempt,
      action: 'replied',
    })
    broadcaster.broadcast(ticketId, 'needs_input', {
      type: 'opencode_question_resolved',
      action: 'replied',
      ticketId,
      requestId,
      sessionId: question.sessionId,
      timestamp: new Date().toISOString(),
    })
    return c.json({ success: true })
  } catch (err) {
    releaseRequestClaim(ticketId, question.sessionId, requestId, claimId)
    const message = getErrorMessage(err)
    emitOpenCodeQuestionLog(ticketId, question.phase, `[ERROR] Failed to answer OpenCode question: ${message}`, {
      requestId,
      sessionId: question.sessionId,
      modelId: question.modelId,
      phaseAttempt: question.phaseAttempt,
      kind: 'error',
      type: 'error',
      action: 'reply_failed',
    })
    return c.json({ error: 'Failed to answer OpenCode question', details: message }, 500)
  }
}

export async function handleRejectOpenCodeQuestion(c: Context) {
  const ticketId = getTicketParam(c)
  const requestId = getRequiredRouteParam(c, 'requestId')
  const ticketContext = getTicketContext(ticketId)
  if (!ticketContext) return c.json({ error: 'Ticket not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const parsed = opencodeQuestionSkipSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid question skip payload', details: parsed.error.flatten() }, 400)
  }
  const reason = normalizeSkipReason(parsed.data.reason ?? null)

  const question = await findPendingOpenCodeQuestionForTicket(ticketId, requestId)
  if (!question) return c.json({ error: 'OpenCode question request not found for ticket' }, 404)

  const claimId = claimRequestForReply(ticketId, question.sessionId, requestId)
  if (!claimId) {
    return c.json({ error: 'That question was already resolved' }, 409)
  }

  try {
    await getOpenCodeAdapter().rejectQuestion(requestId, ticketContext.projectRoot)
    // Written after the rejection lands, so the trail never records a decision
    // OpenCode was never told about.
    markRequestSkipped(ticketId, question.sessionId, requestId, reason, claimId)
    const receiptLine = reason ? ` Reason: ${reason}` : ''
    emitOpenCodeQuestionLog(ticketId, question.phase, `[QUESTION] AI question skipped.${receiptLine}`, {
      requestId,
      sessionId: question.sessionId,
      modelId: question.modelId,
      phaseAttempt: question.phaseAttempt,
      action: 'rejected',
    })
    broadcaster.broadcast(ticketId, 'needs_input', {
      type: 'opencode_question_resolved',
      action: 'rejected',
      ticketId,
      requestId,
      sessionId: question.sessionId,
      resolution: 'user_skipped',
      timestamp: new Date().toISOString(),
    })
    return c.json({ success: true })
  } catch (err) {
    releaseRequestClaim(ticketId, question.sessionId, requestId, claimId)
    const message = getErrorMessage(err)
    emitOpenCodeQuestionLog(ticketId, question.phase, `[ERROR] Failed to skip OpenCode question: ${message}`, {
      requestId,
      sessionId: question.sessionId,
      modelId: question.modelId,
      phaseAttempt: question.phaseAttempt,
      kind: 'error',
      type: 'error',
      action: 'reject_failed',
    })
    return c.json({ error: 'Failed to skip OpenCode question', details: message }, 500)
  }
}

/**
 * A person is dealing with this, so the clock stops.
 *
 * Every way of engaging arrives here — switching model tabs, moving between
 * questions, focusing an answer field, pressing Stop timer. The client fires it
 * once and remembers it did; a second call returns the same state rather than an
 * error, because a keystroke is not a failure.
 *
 * There is no matching resume. Stopping is a statement that a human has this,
 * and the ways out of it are answering and skipping.
 */
export async function handleStopOpenCodeQuestionTimer(c: Context) {
  const ticketId = getTicketParam(c)
  const ticketContext = getTicketContext(ticketId)
  if (!ticketContext) return c.json({ error: 'Ticket not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const parsed = opencodeQuestionTimerStopSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid stop payload', details: parsed.error.flatten() }, 400)
  }

  const timers = stopTicketTimers(ticketId, 'user')
  return c.json({ success: true, timers, timer: getTicketQuestionState(ticketId).timer })
}
