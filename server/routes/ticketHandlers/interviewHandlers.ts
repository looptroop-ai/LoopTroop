import type { Context } from 'hono'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureActorForTicket, sendTicketEvent } from '../../machines/persistence'
import { abortTicketSessions } from '../../opencode/sessionManager'
import { isMockOpenCodeMode } from '../../opencode/factory'
import { broadcaster } from '../../sse/broadcaster'
import {
  handleInterviewQABatch,
  processInterviewBatchAsync,
  skipAllInterviewQuestionsToApproval,
} from '../../workflow/runner'
import { abortTicketWork } from '../../workflow/phases/state'
import {
  getLatestPhaseArtifact,
  getTicketByRef,
  getTicketPaths,
  upsertLatestPhaseArtifact,
} from '../../storage/tickets'
import { parseCompiledInterviewArtifact } from '../../phases/interview/compiled'
import {
  buildInterviewQuestionViews,
  INTERVIEW_SESSION_ARTIFACT,
  isBatchAnswerSkipped,
  parseInterviewSessionSnapshot,
  resolveSkippedQuestionIdsForSkipAll,
  serializeInterviewSessionSnapshot,
  updateInterviewAnswer,
} from '../../phases/interview/sessionState'
import type { InterviewDocument } from '@shared/interviewArtifact'
import {
  buildDraftInterviewDocumentFromAnswerUpdates,
  buildDraftInterviewDocumentFromRawContent,
  readInterviewDocument,
  saveApprovedInterviewDocument,
  saveInterviewDocument,
} from '../../phases/interview/finalDocument'
import { isBeforeExecution, isStatusAtOrPast } from '@shared/workflowMeta'
import { getErrorMessage } from '@shared/typeGuards'
import { contentSha256 } from '../../lib/contentHash'
import { writeUserEditReceipt } from '../../workflow/artifactEditReceipts'
import { deriveSkipActionId, writeSkipReceipts } from '../../workflow/skipReceipts'
import {
  buildRouteStatePayload,
  emitRoutePhaseLog,
  getTicketParam,
  preparePlanningRestart,
  rejectDisplayOnlyMockTicket,
  respondWithState,
} from './routeUtils'
import {
  editAnswerSchema,
  interviewApprovalAnswerSchema,
  interviewBatchAnswerPayloadSchema,
  interviewSkipAllPayloadSchema,
  rawInterviewSaveSchema,
} from './schemas'

/**
 * A reason only means something attached to a skip.
 *
 * Accepting one for a question the person answered would put a reason into the
 * audit trail explaining a decision that was never made, and there is no later
 * point at which that could be noticed.
 */
function findReasonsForAnsweredQuestions(
  skipReasons: Record<string, string>,
  skippedQuestionIds: Set<string>,
): string[] {
  return Object.keys(skipReasons).filter((questionId) => !skippedQuestionIds.has(questionId))
}

/**
 * Records what an approval-time edit changed about skipping.
 *
 * Both the structured editor and the raw YAML tab land here, because both can
 * flip an answer to skipped and both can rewrite a reason. It records only what
 * actually changed: re-saving a document untouched is not a decision, and would
 * otherwise stamp a receipt on every question that happened to be skipped
 * already.
 */
function recordInterviewApprovalSkips(input: {
  ticketId: string
  ticketStatusBefore: string
  before: InterviewDocument | null
  after: InterviewDocument
}): void {
  const beforeById = new Map((input.before?.questions ?? []).map((question) => [question.id, question.answer]))
  const items = input.after.questions.flatMap((question) => {
    if (!question.answer.skipped) return []
    const previous = beforeById.get(question.id)
    const newlySkipped = !previous?.skipped
    const reasonChanged = previous?.skip_reason !== question.answer.skip_reason
    if (!newlySkipped && !reasonChanged) return []
    return [{ itemId: question.id, reason: question.answer.skip_reason }]
  })
  if (items.length === 0) return

  writeSkipReceipts({
    ticketId: input.ticketId,
    surface: 'interview_approval_mark_skipped',
    itemType: 'interview_question',
    phase: 'WAITING_INTERVIEW_APPROVAL',
    ticketStatusBefore: input.ticketStatusBefore,
    actionId: deriveSkipActionId('interview_approval_mark_skipped', [
      input.ticketId,
      ...items.flatMap((item) => [item.itemId, item.reason]),
    ]),
    items,
  })
}

function buildInterviewPayload(ticketId: string): {
  winnerId: string | null
  raw: string | null
  contentSha256: string | null
  document: InterviewDocument | null
  session: ReturnType<typeof parseInterviewSessionSnapshot>
  questions: ReturnType<typeof buildInterviewQuestionViews>
} {
  const sessionArtifact = getLatestPhaseArtifact(ticketId, INTERVIEW_SESSION_ARTIFACT)
  const session = parseInterviewSessionSnapshot(sessionArtifact?.content)
  const questions = session ? buildInterviewQuestionViews(session) : []

  let document: InterviewDocument | null = null
  let raw: string | null = null
  try {
    const parsed = readInterviewDocument(ticketId)
    document = parsed.document
    raw = parsed.raw
  } catch {
    raw = null
  }

  if (!raw) {
    const ticketPaths = getTicketPaths(ticketId)
    const canonicalInterviewPath = ticketPaths ? resolve(ticketPaths.ticketDir, 'interview.yaml') : null
    if (canonicalInterviewPath && existsSync(canonicalInterviewPath)) {
      try {
        raw = readFileSync(canonicalInterviewPath, 'utf-8')
      } catch {
        raw = null
      }
    }
  }

  const artifact = getLatestPhaseArtifact(ticketId, 'interview_compiled')
  if (!artifact) {
    return {
      winnerId: session?.winnerId ?? null,
      raw,
      contentSha256: raw ? contentSha256(raw) : null,
      document,
      session,
      questions,
    }
  }

  try {
    const parsed = parseCompiledInterviewArtifact(artifact.content)
    return {
      raw: raw ?? parsed.refinedContent,
      contentSha256: contentSha256(raw ?? parsed.refinedContent),
      document,
      winnerId: session?.winnerId ?? parsed.winnerId,
      session,
      questions,
    }
  } catch {
    return {
      raw: raw ?? artifact.content,
      contentSha256: contentSha256(raw ?? artifact.content),
      document,
      winnerId: session?.winnerId ?? null,
      session,
      questions,
    }
  }
}

export async function handleAnswerTicket(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  return c.json({
    error: 'Direct interview answer submission is no longer supported. Use /answer-batch instead.',
    ticketId,
    status: ticket.status,
  }, 410)
}

export async function handleSkipTicket(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (ticket.status !== 'WAITING_INTERVIEW_ANSWERS') {
    return c.json({ error: 'Ticket is not waiting for interview answers' }, 409)
  }

  const body = await c.req.json().catch(() => ({}))
  const parsed = interviewSkipAllPayloadSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid answers payload', details: parsed.error.flatten() }, 400)
  }

  const skipAllSession = parseInterviewSessionSnapshot(
    getLatestPhaseArtifact(ticketId, INTERVIEW_SESSION_ARTIFACT)?.content,
  )
  if (!skipAllSession) {
    return c.json({ error: 'No interview session found' }, 404)
  }
  const skipAllSkippedIds = resolveSkippedQuestionIdsForSkipAll(
    skipAllSession,
    parsed.data.answers,
    parsed.data.selectedOptions,
  )
  const answeredWithReasons = findReasonsForAnsweredQuestions(parsed.data.skipReasons, skipAllSkippedIds)
  if (answeredWithReasons.length > 0) {
    return c.json({
      error: 'A skip reason was sent for a question that is not being skipped',
      questionIds: answeredWithReasons,
    }, 400)
  }

  try {
    ensureActorForTicket(ticketId)
    skipAllInterviewQuestionsToApproval(ticketId, parsed.data.answers, {
      selectedOptions: parsed.data.selectedOptions,
      skipReasons: parsed.data.skipReasons,
      bulkReason: parsed.data.bulkSkipReason ?? null,
    })

    try {
      await abortTicketSessions(ticketId)
    } catch (err) {
      console.warn(`[tickets] Failed to abort interview sessions for ${ticketId} after skip-all:`, err)
    }

    sendTicketEvent(ticketId, { type: 'SKIP_ALL_TO_APPROVAL' })
  } catch (err) {
    console.error(`[tickets] Failed to skip remaining interview questions for ticket ${ticketId}:`, err)
    return c.json({ error: 'Failed to skip remaining interview questions', details: String(err) }, 500)
  }

  return respondWithState(c, ticketId, 'Remaining interview questions skipped')
}

export async function handleAnswerBatch(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (ticket.status !== 'WAITING_INTERVIEW_ANSWERS') {
    return c.json({ error: 'Ticket is not waiting for interview answers' }, 409)
  }

  const body = await c.req.json().catch(() => ({}))
  const parsed = interviewBatchAnswerPayloadSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid answers payload', details: parsed.error.flatten() }, 400)
  }

  // Determine if the batch needs a slow AI call (PROM4) or can be handled fast
  const sessionArt = getLatestPhaseArtifact(ticketId, INTERVIEW_SESSION_ARTIFACT)
  const session = parseInterviewSessionSnapshot(sessionArt?.content)

  const batchSkippedIds = new Set(
    (session?.currentBatch?.questions ?? [])
      .filter((question) => isBatchAnswerSkipped(
        question,
        parsed.data.answers[question.id] ?? '',
        parsed.data.selectedOptions[question.id] ?? [],
      ))
      .map((question) => question.id),
  )
  const batchAnsweredWithReasons = findReasonsForAnsweredQuestions(parsed.data.skipReasons, batchSkippedIds)
  if (batchAnsweredWithReasons.length > 0) {
    return c.json({
      error: 'A skip reason was sent for a question that is not being skipped',
      questionIds: batchAnsweredWithReasons,
    }, 400)
  }

  try {
    const isCoverageBatch = session?.currentBatch?.source === 'coverage'
    const needsAsyncProcessing = !isMockOpenCodeMode() && !isCoverageBatch

    if (needsAsyncProcessing) {
      if (!session) {
        return c.json({ error: 'No interview session found' }, 404)
      }
      // ASYNC path: return 202 immediately, process AI call in background.
      // handleInterviewQABatch persists the intermediate state (answers saved,
      // currentBatch cleared) synchronously before its first await, so the
      // snapshot is consistent by the time we return.
      ensureActorForTicket(ticketId)
      sendTicketEvent(ticketId, { type: 'BATCH_ANSWERED', batchAnswers: parsed.data.answers, selectedOptions: parsed.data.selectedOptions })

      const batchTimeoutMs = 10 * 60 * 1000
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          abortTicketWork(ticketId)
          reject(new Error('Async batch processing timed out'))
        }, batchTimeoutMs)
      })

      Promise.race([
        processInterviewBatchAsync(ticketId, parsed.data.answers, session, parsed.data.selectedOptions, parsed.data.skipReasons),
        timeoutPromise,
      ])
        .finally(() => {
          if (timeoutId) clearTimeout(timeoutId)
        })
        .then(result => {
          ensureActorForTicket(ticketId)
          if (result.isComplete) {
            sendTicketEvent(ticketId, { type: 'INTERVIEW_COMPLETE' })
          } else {
            broadcaster.broadcast(ticketId, 'needs_input', {
              ticketId,
              type: 'interview_batch',
              batch: result,
            })
          }
        })
        .catch(err => {
          console.error(`[tickets] Async batch processing failed for ${ticketId}:`, err)
          broadcaster.broadcast(ticketId, 'needs_input', {
            ticketId,
            type: 'interview_error',
            error: getErrorMessage(err),
          })
        })

      return c.json({ accepted: true }, 202)
    }

    // SYNC path: mock mode or coverage batches (fast, no AI call)
    const result = await handleInterviewQABatch(ticketId, parsed.data.answers, parsed.data.selectedOptions, parsed.data.skipReasons)
    ensureActorForTicket(ticketId)
    if (result.isComplete) {
      sendTicketEvent(ticketId, { type: 'INTERVIEW_COMPLETE' })
    } else {
      sendTicketEvent(ticketId, { type: 'BATCH_ANSWERED', batchAnswers: parsed.data.answers, selectedOptions: parsed.data.selectedOptions })
    }

    return c.json({
      questions: result.questions,
      progress: result.progress,
      isComplete: result.isComplete,
      isFinalFreeForm: result.isFinalFreeForm,
      aiCommentary: result.aiCommentary,
      batchNumber: result.batchNumber,
      ...('source' in result && typeof result.source === 'string' ? { source: result.source } : {}),
      ...('roundNumber' in result && typeof result.roundNumber === 'number' ? { roundNumber: result.roundNumber } : {}),
    })
  } catch (err) {
    console.error(`[tickets] Failed to process answer-batch for ticket ${ticketId}:`, err)
    return c.json({ error: 'Failed to process batch', details: String(err) }, 500)
  }
}

export async function handleEditAnswer(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (ticket.status !== 'WAITING_INTERVIEW_ANSWERS') {
    return c.json({ error: 'Ticket is not waiting for interview answers' }, 409)
  }

  try {
    const body = await c.req.json().catch(() => ({}))
    const parsed = editAnswerSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Invalid payload', details: parsed.error.flatten() }, 400)
    }

    const sessionArt = getLatestPhaseArtifact(ticketId, INTERVIEW_SESSION_ARTIFACT)
    const session = parseInterviewSessionSnapshot(sessionArt?.content)
    if (!session) {
      return c.json({ error: 'No interview session found' }, 404)
    }

    const { questionId, answer } = parsed.data
    if (!session.answers[questionId]) {
      return c.json({ error: `No existing answer for question ${questionId}` }, 404)
    }

    const updated = updateInterviewAnswer(session, questionId, answer)
    upsertLatestPhaseArtifact(
      ticketId,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(updated),
    )

    const questions = buildInterviewQuestionViews(updated)
    return c.json({ success: true, questions })
  } catch (err) {
    console.error(`[tickets] Failed to edit interview answer for ticket ${ticketId}:`, err)
    return c.json({ error: 'Failed to edit answer', details: String(err) }, 500)
  }
}

export async function handlePutInterviewAnswers(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (!isStatusAtOrPast(ticket.status, 'WAITING_INTERVIEW_APPROVAL') || !isBeforeExecution(ticket.status, ticket.previousStatus)) {
    return c.json({ error: 'Ticket is not in a state where interview can be edited' }, 409)
  }

  const body = await c.req.json().catch(() => ({}))
  const parsed = interviewApprovalAnswerSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid interview answer payload', details: parsed.error.flatten() }, 400)
  }

  let beforeRaw: string | null = null
  let beforeItemCount: number | null = null
  let beforeDocument: InterviewDocument | null = null
  try {
    const before = readInterviewDocument(ticketId)
    beforeRaw = before.raw
    beforeDocument = before.document
    beforeItemCount = before.document.questions.length
  } catch {
    beforeRaw = null
  }

  let document: InterviewDocument
  try {
    document = buildDraftInterviewDocumentFromAnswerUpdates(ticketId, parsed.data.questions)
  } catch (err) {
    return c.json({
      error: 'Failed to save interview answers',
      details: getErrorMessage(err),
    }, 400)
  }

  try {
    const shouldRestart = ticket.status !== 'WAITING_INTERVIEW_APPROVAL'
    let restart: Awaited<ReturnType<typeof preparePlanningRestart>> | null = null
    let result: ReturnType<typeof saveInterviewDocument>
    if (ticket.status !== 'WAITING_INTERVIEW_APPROVAL') {
      restart = await preparePlanningRestart(ticketId, 'WAITING_INTERVIEW_APPROVAL')
      result = saveApprovedInterviewDocument(ticketId, document)
      emitRoutePhaseLog(ticketId, 'WAITING_INTERVIEW_APPROVAL', 'info', 'Interview edit saved and approved. Restarting PRD planning from the edited interview.')
      sendTicketEvent(ticketId, { type: 'APPROVE' })
    } else {
      result = saveInterviewDocument(ticketId, document)
    }
    writeUserEditReceipt({
      ticketId,
      artifactType: 'interview',
      phase: 'WAITING_INTERVIEW_APPROVAL',
      action: shouldRestart ? 'save_and_restart' : 'save',
      editSurface: 'answers',
      statusBeforeEdit: ticket.status,
      statusAfterEdit: getTicketByRef(ticketId)?.status ?? null,
      beforeRaw,
      afterRaw: result.raw,
      beforeItemCount,
      afterItemCount: result.document.questions.length,
      restart,
      invalidation: result.invalidation,
    })
    recordInterviewApprovalSkips({
      ticketId,
      ticketStatusBefore: ticket.status,
      before: beforeDocument,
      after: result.document,
    })
    return c.json({
      success: true,
      ...buildInterviewPayload(ticketId),
      ...buildRouteStatePayload(ticketId),
    })
  } catch (err) {
    return c.json({
      error: 'Failed to save interview answers',
      details: getErrorMessage(err),
    }, 400)
  }
}

export async function handlePutInterview(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (!isStatusAtOrPast(ticket.status, 'WAITING_INTERVIEW_APPROVAL') || !isBeforeExecution(ticket.status, ticket.previousStatus)) {
    return c.json({ error: 'Ticket is not in a state where interview can be edited' }, 409)
  }

  const body = await c.req.json().catch(() => ({}))
  const parsed = rawInterviewSaveSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid interview document payload', details: parsed.error.flatten() }, 400)
  }

  let beforeRaw: string | null = null
  let beforeItemCount: number | null = null
  let beforeDocument: InterviewDocument | null = null
  try {
    const before = readInterviewDocument(ticketId)
    beforeRaw = before.raw
    beforeDocument = before.document
    beforeItemCount = before.document.questions.length
  } catch {
    beforeRaw = null
  }

  let document: InterviewDocument
  try {
    document = buildDraftInterviewDocumentFromRawContent(ticketId, parsed.data.content)
  } catch (err) {
    return c.json({
      error: 'Failed to save interview document',
      details: getErrorMessage(err),
    }, 400)
  }

  try {
    const shouldRestart = ticket.status !== 'WAITING_INTERVIEW_APPROVAL'
    let restart: Awaited<ReturnType<typeof preparePlanningRestart>> | null = null
    let result: ReturnType<typeof saveInterviewDocument>
    if (ticket.status !== 'WAITING_INTERVIEW_APPROVAL') {
      restart = await preparePlanningRestart(ticketId, 'WAITING_INTERVIEW_APPROVAL')
      result = saveApprovedInterviewDocument(ticketId, document)
      emitRoutePhaseLog(ticketId, 'WAITING_INTERVIEW_APPROVAL', 'info', 'Interview edit saved and approved. Restarting PRD planning from the edited interview.')
      sendTicketEvent(ticketId, { type: 'APPROVE' })
    } else {
      result = saveInterviewDocument(ticketId, document)
    }
    writeUserEditReceipt({
      ticketId,
      artifactType: 'interview',
      phase: 'WAITING_INTERVIEW_APPROVAL',
      action: shouldRestart ? 'save_and_restart' : 'save',
      editSurface: 'raw',
      statusBeforeEdit: ticket.status,
      statusAfterEdit: getTicketByRef(ticketId)?.status ?? null,
      beforeRaw,
      afterRaw: result.raw,
      beforeItemCount,
      afterItemCount: result.document.questions.length,
      restart,
      invalidation: result.invalidation,
    })
    recordInterviewApprovalSkips({
      ticketId,
      ticketStatusBefore: ticket.status,
      before: beforeDocument,
      after: result.document,
    })
    return c.json({
      success: true,
      ...buildInterviewPayload(ticketId),
      ...buildRouteStatePayload(ticketId),
    })
  } catch (err) {
    return c.json({
      error: 'Failed to save interview document',
      details: getErrorMessage(err),
    }, 400)
  }
}

export function handleGetInterview(c: Context) {
  const ticketId = getTicketParam(c)
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)
  return c.json(buildInterviewPayload(ticketId))
}
