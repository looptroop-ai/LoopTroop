import type { Context } from 'hono'

/** Room for the bookkeeping around the AI call itself, not for the call. */
const BATCH_PROCESSING_MARGIN_MS = 60_000
import { readFileNoFollowSync } from '../../io/readFile'
import { ensureActorForTicket, sendTicketEvent } from '../../machines/persistence'
import { abortTicketSessions } from '../../opencode/sessionManager'
import { isMockOpenCodeMode } from '../../opencode/factory'
import { broadcaster } from '../../sse/broadcaster'
import {
  claimInterviewBatch,
  handleInterviewQABatch,
  processInterviewBatchAsync,
  releaseInterviewBatch,
  skipAllInterviewQuestionsToApproval,
} from '../../workflow/runner'
import {
  claimInterviewBatchAfterConfirmedStop,
  getPendingInterviewBatchStop,
  getPendingInterviewBatchStopToken,
  InterviewBatchChangedError,
  markInterviewBatchStopPending,
  restoreInterviewBatchAfterFailure,
  snapshotFingerprint,
  type InterviewBatchSkipReceipt,
} from '../../workflow/phases/interviewPhase'
import { abortTicketWork } from '../../workflow/phases/state'
import {
  resolveAiResponseTimeoutForTicket,
  resolveStructuredRetryCountForTicket,
} from '../../workflow/phases/helpers'
import {
  getLatestPhaseArtifact,
  getTicketByRef,
  resolveTicketContainedPath,
} from '../../storage/tickets'
import { parseCompiledInterviewArtifact } from '../../phases/interview/compiled'
import {
  buildInterviewQuestionViews,
  INTERVIEW_SESSION_ARTIFACT,
  collectBatchSelectionErrors,
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
import { compareAndSetLatestPhaseArtifact } from '../../storage/ticketArtifacts'
import { assertExpectedContentSha256, StaleArtifactApprovalError } from '../../lib/artifactApproval'
import { contentSha256 } from '../../lib/contentHash'
import { writeUserEditReceipt } from '../../workflow/artifactEditReceipts'
import {
  deriveSkipActionId,
  formatSkipReceiptLogLines,
  writeSkipReceipts,
  type SkipReceiptItemInput,
} from '../../workflow/skipReceipts'
import {
  buildRouteStatePayload,
  assertPlanningEditClaim,
  claimPlanningEdit,
  emitRoutePhaseLog,
  getTicketParam,
  logTicketOperationError,
  PlanningEditClaimLostError,
  preparePlanningRestart,
  readJsonBody,
  rejectDisplayOnlyMockTicket,
  releasePlanningEdit,
  respondWithState,
} from './routeUtils'
import {
  editAnswerSchema,
  interviewApprovalAnswerSchema,
  interviewBatchAnswerPayloadSchema,
  interviewSkipAllPayloadSchema,
  rawInterviewSaveSchema,
} from './schemas'

class MissingArtifactSavePreconditionError extends Error {}

function staleInterviewSaveResponse(c: Context, err: StaleArtifactApprovalError) {
  return c.json({
    error: 'Stale approval',
    artifactType: err.artifactType,
    expectedContentSha256: err.expectedContentSha256,
    currentContentSha256: err.currentContentSha256,
  }, 409)
}

function readInterviewSaveBaseline(ticketId: string, expectedContentSha256: string | undefined) {
  if (!expectedContentSha256) {
    throw new MissingArtifactSavePreconditionError('Interview save requires the hash of the loaded document')
  }
  const current = readInterviewDocument(ticketId)
  assertExpectedContentSha256({
    artifactType: 'interview',
    currentContent: current.raw,
    expectedContentSha256,
  })
  return current
}

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

function findUnknownBatchQuestionIds(
  questions: ReadonlyArray<{ id: string }>,
  ...records: Array<Record<string, unknown>>
): string[] {
  const allowedIds = new Set(questions.map((question) => question.id))
  return [...new Set(records.flatMap((record) => Object.keys(record).filter((questionId) => !allowedIds.has(questionId))))]
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
  const items: SkipReceiptItemInput[] = input.after.questions.flatMap((question) => {
    const previous = beforeById.get(question.id)

    // An answer that used to be skipped and no longer is. Recording this is what
    // stops the trail reporting a decision the operator has since reversed.
    if (!question.answer.skipped) {
      return previous?.skipped
        ? [{ itemId: question.id, reason: null, resolves: true }]
        : []
    }

    const newlySkipped = !previous?.skipped
    const reasonChanged = previous?.skip_reason !== question.answer.skip_reason
    if (!newlySkipped && !reasonChanged) return []
    return [{ itemId: question.id, reason: question.answer.skip_reason }]
  })
  if (items.length === 0) return

  try {
    recordApprovalSkipReceipts(input, items)
  } catch (err) {
    // The document is already saved and the restart may already have fired.
    // Failing here would report a save failure for a save that succeeded, and
    // the retry would run the whole planning restart a second time.
    logTicketOperationError(input.ticketId, 'Failed to record approval skip receipts for', err)
  }
}

function recordApprovalSkipReceipts(
  input: { ticketId: string; ticketStatusBefore: string },
  items: SkipReceiptItemInput[],
): void {
  const receipts = writeSkipReceipts({
    ticketId: input.ticketId,
    surface: 'interview_approval_mark_skipped',
    itemType: 'interview_question',
    phase: 'WAITING_INTERVIEW_APPROVAL',
    ticketStatusBefore: input.ticketStatusBefore,
    actionId: deriveSkipActionId('interview_approval_mark_skipped', [
      input.ticketId,
      ...items.flatMap((item) => [item.itemId, item.reason, item.resolves === true ? 'resolved' : 'skipped']),
    ]),
    items,
  })
  for (const line of formatSkipReceiptLogLines(receipts)) {
    emitRoutePhaseLog(input.ticketId, 'WAITING_INTERVIEW_APPROVAL', 'info', line)
  }
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
    try {
      const canonicalInterviewPath = resolveTicketContainedPath(ticketId, 'interview.yaml')
      raw = canonicalInterviewPath ? readFileNoFollowSync(canonicalInterviewPath) : null
    } catch {
      raw = null
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

  const rawBody = await readJsonBody(c)
  if (!rawBody.ok) {
    return c.json({ error: 'Skip request body must be valid JSON' }, 400)
  }
  const parsed = interviewSkipAllPayloadSchema.safeParse(rawBody.body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid answers payload', details: parsed.error.flatten() }, 400)
  }

  const skipAllSession = parseInterviewSessionSnapshot(
    getLatestPhaseArtifact(ticketId, INTERVIEW_SESSION_ARTIFACT)?.content,
  )
  if (!skipAllSession) {
    return c.json({ error: 'No interview session found' }, 404)
  }
  const skipAllBatch = skipAllSession.currentBatch
  if (!skipAllBatch || parsed.data.batchNumber !== skipAllBatch.batchNumber) {
    return c.json({ error: 'Interview batch is stale; refresh before submitting' }, 409)
  }
  const unknownSkipQuestionIds = findUnknownBatchQuestionIds(
    skipAllBatch.questions,
    parsed.data.answers,
    parsed.data.selectedOptions,
    parsed.data.skipReasons,
  )
  if (unknownSkipQuestionIds.length > 0) {
    return c.json({ error: 'Invalid answers payload', questionIds: unknownSkipQuestionIds }, 400)
  }
  const skipAllSelectionErrors = collectBatchSelectionErrors(
    skipAllBatch.questions,
    parsed.data.selectedOptions,
  )
  if (skipAllSelectionErrors.length > 0) {
    return c.json({ error: 'Invalid answers payload', details: skipAllSelectionErrors }, 400)
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

  // The same claim the answer-batch route takes, for the same reason. A
  // failed remote stop becomes a durable marker. The retry confirms the stop
  // before promoting that marker, so an expired lease can never let a second
  // operation race an old remote worker.
  const pendingStop = getPendingInterviewBatchStop(ticketId)
  if (pendingStop === 'answer') {
    return c.json({ error: 'An answer batch stop is awaiting confirmation; try again shortly' }, 409)
  }

  let skipClaimToken: string | null = null
  let retainedPendingStop = false
  if (pendingStop === 'skip') {
    // Capture the exact marker before awaiting the remote stop. A concurrent
    // retry may create a new generation with the same kind while this request
    // is paused; confirming that newer marker would let this older caller
    // release work it never stopped.
    const pendingStopToken = getPendingInterviewBatchStopToken(ticketId, 'skip')
    if (!pendingStopToken) {
      return c.json({ error: 'The interview stop changed while retrying; try again shortly' }, 409)
    }
    let sessionsStopped = false
    try {
      sessionsStopped = await abortTicketSessions(ticketId)
    } catch (err) {
      console.warn(`[tickets] Failed to retry abort for ${ticketId} before skip-all:`, err)
    }
    if (!sessionsStopped) {
      return c.json({ error: 'Could not confirm the interview stopped; try again shortly' }, 409)
    }
    skipClaimToken = claimInterviewBatchAfterConfirmedStop(ticketId, 'skip', pendingStopToken)
    if (!skipClaimToken) {
      return c.json({ error: 'The interview stop changed while retrying; try again shortly' }, 409)
    }
  } else {
    skipClaimToken = claimInterviewBatch(ticketId)
    if (!skipClaimToken) {
      return c.json({ error: 'An answer batch for this ticket is already being processed' }, 409)
    }
  }

  try {
    ensureActorForTicket(ticketId)
    if (!pendingStop) {
      const initialClaimToken = skipClaimToken
      if (!initialClaimToken || !markInterviewBatchStopPending(ticketId, initialClaimToken, 'skip')) {
        retainedPendingStop = true
        return c.json({ error: 'Could not retain the interview stop for retry' }, 409)
      }
      retainedPendingStop = true
      const pendingStopToken = getPendingInterviewBatchStopToken(ticketId, 'skip')
      if (!pendingStopToken) {
        return c.json({ error: 'Could not retain the interview stop for retry' }, 409)
      }
      let sessionsStopped = false
      try {
        sessionsStopped = await abortTicketSessions(ticketId)
      } catch (err) {
        console.warn(`[tickets] Failed to abort interview sessions for ${ticketId} after skip-all:`, err)
      }
      if (!sessionsStopped) {
        return c.json({ error: 'Could not confirm the interview stopped; try again shortly' }, 409)
      }
      const confirmedClaim = claimInterviewBatchAfterConfirmedStop(ticketId, 'skip', pendingStopToken)
      if (!confirmedClaim) {
        return c.json({ error: 'The interview stop changed while retrying; try again shortly' }, 409)
      }
      skipClaimToken = confirmedClaim
      retainedPendingStop = false
    }

    skipAllInterviewQuestionsToApproval(ticketId, parsed.data.answers, {
      selectedOptions: parsed.data.selectedOptions,
      skipReasons: parsed.data.skipReasons,
      bulkReason: parsed.data.bulkSkipReason ?? null,
      claimToken: skipClaimToken ?? undefined,
      expectedSnapshotFingerprint: snapshotFingerprint(skipAllSession),
    })

    sendTicketEvent(ticketId, { type: 'SKIP_ALL_TO_APPROVAL' })
  } catch (err) {
    if (err instanceof InterviewBatchChangedError) {
      return c.json({ error: err.message }, 409)
    }
    logTicketOperationError(ticketId, 'Failed to skip remaining interview questions for ticket', err)
    return c.json({ error: 'Failed to skip remaining interview questions', details: getErrorMessage(err) }, 500)
  } finally {
    if (!retainedPendingStop && skipClaimToken) releaseInterviewBatch(ticketId, skipClaimToken)
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

  const rawBody = await readJsonBody(c)
  if (!rawBody.ok) {
    return c.json({ error: 'Answer batch request body must be valid JSON' }, 400)
  }
  const parsed = interviewBatchAnswerPayloadSchema.safeParse(rawBody.body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid answers payload', details: parsed.error.flatten() }, 400)
  }

  // Determine if the batch needs a slow AI call (PROM4) or can be handled fast
  const sessionArt = getLatestPhaseArtifact(ticketId, INTERVIEW_SESSION_ARTIFACT)
  const session = parseInterviewSessionSnapshot(sessionArt?.content)
  const currentBatch = session?.currentBatch
  if (!currentBatch || parsed.data.batchNumber !== currentBatch.batchNumber) {
    return c.json({ error: 'Interview batch is stale; refresh before submitting' }, 409)
  }
  const unknownAnswerQuestionIds = findUnknownBatchQuestionIds(
    currentBatch.questions,
    parsed.data.answers,
    parsed.data.selectedOptions,
    parsed.data.skipReasons,
  )
  if (unknownAnswerQuestionIds.length > 0) {
    return c.json({ error: 'Invalid answers payload', questionIds: unknownAnswerQuestionIds }, 400)
  }

  // The schema accepts any array of strings; only the question knows whether the
  // ids in it exist, and how many of them it takes.
  const selectionErrors = collectBatchSelectionErrors(
    currentBatch.questions,
    parsed.data.selectedOptions,
  )
  if (selectionErrors.length > 0) {
    return c.json({ error: 'Invalid answers payload', details: selectionErrors }, 400)
  }

  const batchSkippedIds = new Set(
    currentBatch.questions
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

  const isCoverageBatch = currentBatch.source === 'coverage'
  // Non-null only on the asynchronous path, which hands the snapshot to the
  // background task as the state to revert to. The synchronous path does not
  // revert, so it needs no snapshot — and a missing session on the asynchronous
  // path is a 404 below, not a silent fall-through to the synchronous one.
  const asyncSession = !isMockOpenCodeMode() && !isCoverageBatch ? session : null
  const needsAsyncProcessing = asyncSession !== null
  if (!isMockOpenCodeMode() && !isCoverageBatch && !asyncSession) {
    return c.json({ error: 'No interview session found' }, 404)
  }

  // Derived from the ticket's own budget rather than a flat ten minutes. The
  // configured AI response timeout is 20 minutes by default, so a turn that was
  // slow but well inside its budget was aborted and surfaced to the operator as
  // `interview_error`. One attempt plus its structured retries, and a margin
  // for the surrounding bookkeeping.
  const aiTimeoutMs = resolveAiResponseTimeoutForTicket(ticketId)
  const structuredRetries = resolveStructuredRetryCountForTicket(ticketId)
  const batchTimeoutMs = aiTimeoutMs * (1 + Math.max(0, structuredRetries)) + BATCH_PROCESSING_MARGIN_MS

  // Claimed before anything is dispatched, on both paths. A session existing is
  // not the same as a batch being available: the first request clears
  // `currentBatch`, and a second one accepted after that used to delete the
  // first request's skip-receipt entry on its way to failing. The synchronous
  // path — coverage batches and mock mode — reaches the same code and so takes
  // the same claim.
  //
  // The claim's own expiry is the batch's budget plus a margin: every path here
  // releases it explicitly, so the expiry only matters when a daemon dies
  // holding one, and it has to outlast the work it is guarding.
  const pendingStop = getPendingInterviewBatchStop(ticketId)
  if (pendingStop === 'skip') {
    return c.json({ error: 'A skip-all stop is awaiting confirmation; try again shortly' }, 409)
  }

  let claimToken: string | null
  if (pendingStop === 'answer') {
    // The first timeout already stopped local work. Repeat it here because the
    // durable marker may be retried by another daemon, and only a confirmed
    // remote stop may promote the marker back to an ordinary claim.
    const pendingStopToken = getPendingInterviewBatchStopToken(ticketId, 'answer')
    if (!pendingStopToken) {
      return c.json({ error: 'The interview stop changed while retrying; try again shortly' }, 409)
    }
    abortTicketWork(ticketId)
    let sessionsStopped = false
    try {
      sessionsStopped = await abortTicketSessions(ticketId)
    } catch (err) {
      console.warn(`[tickets] Failed to retry abort for ${ticketId} before answer-batch retry:`, err)
    }
    if (!sessionsStopped) {
      return c.json({ error: 'Could not confirm the interview stopped; try again shortly' }, 409)
    }
    claimToken = claimInterviewBatchAfterConfirmedStop(
      ticketId,
      'answer',
      pendingStopToken,
      batchTimeoutMs + BATCH_PROCESSING_MARGIN_MS,
    )
  } else {
    claimToken = claimInterviewBatch(ticketId, batchTimeoutMs + BATCH_PROCESSING_MARGIN_MS)
  }
  if (!claimToken) {
    return c.json({ error: pendingStop
      ? 'The interview stop changed while retrying; try again shortly'
      : 'An answer batch for this ticket is already being processed' }, 409)
  }

  try {
    if (needsAsyncProcessing) {
      // ASYNC path: return 202 immediately, process AI call in background.
      // handleInterviewQABatch persists the intermediate state (answers saved,
      // currentBatch cleared) synchronously before its first await, so the
      // snapshot is consistent by the time we return.
      ensureActorForTicket(ticketId)
      sendTicketEvent(ticketId, { type: 'BATCH_ANSWERED', batchAnswers: parsed.data.answers, selectedOptions: parsed.data.selectedOptions })

      let timeoutId: ReturnType<typeof setTimeout> | null = null
      let timeoutTriggered = false
      let remoteStopConfirmed = false
      let persistedReceipt: InterviewBatchSkipReceipt | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timeoutTriggered = true
          abortTicketWork(ticketId)
          let restored = false
          try {
            restored = persistedReceipt
              ? restoreInterviewBatchAfterFailure(ticketId, asyncSession, persistedReceipt, claimToken)
              : false
          } catch (error) {
            console.warn(`[tickets] Failed to restore the interview batch for ${ticketId} after timeout:`, error)
          }
          const markedPending = markInterviewBatchStopPending(ticketId, claimToken, 'answer')
          const pendingStopToken = markedPending
            ? getPendingInterviewBatchStopToken(ticketId, 'answer')
            : null
          if (!markedPending || !pendingStopToken) {
            reject(new Error('Could not retain the interview stop for retry'))
            return
          }
          // If the callback was delayed past the lease, the first restore is
          // correctly rejected by the live-claim guard. The marker is an
          // exact-token hand-off, so retry the same CAS now that it carries a
          // non-expiring stop lease. A takeover would have made the marker
          // write fail above; it can never be overwritten here.
          if (!restored) {
            try {
              restored = persistedReceipt
                ? restoreInterviewBatchAfterFailure(ticketId, asyncSession, persistedReceipt, pendingStopToken)
                : false
            } catch (error) {
              console.warn(`[tickets] Failed to restore the interview batch for ${ticketId} after retaining its stop:`, error)
            }
          }
          if (!restored) {
            reject(new Error('Could not restore the submitted batch; retry after confirmation'))
            return
          }
          void abortTicketSessions(ticketId)
            .then((stopped) => {
              if (!stopped) {
                reject(new Error('Could not confirm the interview stopped; the batch remains locked for retry'))
                return
              }
              const confirmedClaim = claimInterviewBatchAfterConfirmedStop(
                ticketId,
                'answer',
                pendingStopToken,
                batchTimeoutMs + BATCH_PROCESSING_MARGIN_MS,
              )
              if (!confirmedClaim) {
                reject(new Error('Could not retain the interview stop for retry'))
                return
              }
              remoteStopConfirmed = true
              releaseInterviewBatch(ticketId, confirmedClaim)
              reject(new Error('Async batch processing timed out'))
            })
            .catch((error) => {
              console.warn(`[tickets] Failed to confirm interview stop for ${ticketId} after timeout:`, error)
              reject(new Error('Could not confirm the interview stopped; the batch remains locked for retry'))
            })
        }, batchTimeoutMs)
      })

      Promise.race([
        processInterviewBatchAsync(
          ticketId,
          parsed.data.answers,
          asyncSession,
          parsed.data.selectedOptions,
          parsed.data.skipReasons,
          claimToken,
          () => !timeoutTriggered || remoteStopConfirmed,
          (receipt) => {
            persistedReceipt = receipt
          },
        ),
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
          logTicketOperationError(ticketId, 'Async batch processing failed for', err)
          broadcaster.broadcast(ticketId, 'needs_input', {
            ticketId,
            type: 'interview_error',
            error: getErrorMessage(err),
          })
        })

      return c.json({ accepted: true }, 202)
    }

    // SYNC path: mock mode or coverage batches (fast, no AI call). Nothing to
    // roll back here — the caller gets the failure directly and the snapshot is
    // left as the batch found it — so no skip receipt is collected.
    const result = await handleInterviewQABatch(
      ticketId,
      parsed.data.answers,
      parsed.data.selectedOptions,
      parsed.data.skipReasons,
      undefined,
      claimToken,
    )
    releaseInterviewBatch(ticketId, claimToken)
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
    // The claim is normally released when the background work settles. If
    // anything threw between taking it and dispatching, nothing would.
    releaseInterviewBatch(ticketId, claimToken)
    logTicketOperationError(ticketId, 'Failed to process answer-batch for ticket', err)
    return c.json({ error: 'Failed to process batch', details: getErrorMessage(err) }, 500)
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

  let editClaimToken: string | null = null
  try {
    const body = await c.req.json().catch(() => ({}))
    const parsed = editAnswerSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Invalid payload', details: parsed.error.flatten() }, 400)
    }

    editClaimToken = claimInterviewBatch(ticketId)
    if (!editClaimToken) {
      return c.json({ error: 'An interview batch is being processed; try editing again when it finishes' }, 409)
    }

    // Read only after taking the durable claim. The content CAS below then
    // fences an edit that raced another owner even if both read the same draft.
    const sessionArt = getLatestPhaseArtifact(ticketId, INTERVIEW_SESSION_ARTIFACT, 'WAITING_INTERVIEW_ANSWERS')
    const session = parseInterviewSessionSnapshot(sessionArt?.content)
    if (!session) {
      return c.json({ error: 'No interview session found' }, 404)
    }

    const { batchNumber, questionId, answer, skipReason } = parsed.data
    if (!session.currentBatch || session.currentBatch.batchNumber !== batchNumber) {
      return c.json({ error: 'Interview batch is stale; refresh before editing' }, 409)
    }
    const previous = session.answers[questionId]
    if (!previous) {
      return c.json({ error: `No existing answer for question ${questionId}` }, 404)
    }

    const updated = updateInterviewAnswer(session, questionId, answer, skipReason)
    const saved = sessionArt && compareAndSetLatestPhaseArtifact(
      ticketId,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      sessionArt.content,
      serializeInterviewSessionSnapshot(updated),
    )
    if (!saved) return c.json({ error: 'Interview answers changed while editing; refresh before trying again' }, 409)

    // Clearing an answer here is a real skip, and answering a skipped one
    // reverses a real skip. Neither used to reach the trail at all.
    const nextAnswer = updated.answers[questionId]
    const nowSkipped = nextAnswer?.skipped === true
    if (nowSkipped !== previous.skipped || (nowSkipped && nextAnswer?.skipReason !== previous.skipReason)) {
      try {
      const receipts = writeSkipReceipts({
        ticketId,
        surface: 'interview_question',
        itemType: 'interview_question',
        phase: 'WAITING_INTERVIEW_ANSWERS',
        ticketStatusBefore: ticket.status,
        actionId: deriveSkipActionId('interview_question_edit', [
          ticketId,
          questionId,
          nowSkipped ? 'skipped' : 'resolved',
          nextAnswer?.skipReason ?? null,
        ]),
        items: [{
          itemId: questionId,
          reason: nowSkipped ? nextAnswer?.skipReason ?? null : null,
          resolves: !nowSkipped,
        }],
      })
      for (const line of formatSkipReceiptLogLines(receipts)) {
        emitRoutePhaseLog(ticketId, 'WAITING_INTERVIEW_ANSWERS', 'info', line)
      }
      } catch (err) {
        // The edited answer is already persisted; the trail is not worth
        // failing the edit over.
        logTicketOperationError(ticketId, 'Failed to record the edit-answer skip for', err)
      }
    }

    const questions = buildInterviewQuestionViews(updated)
    return c.json({ success: true, questions })
  } catch (err) {
    logTicketOperationError(ticketId, 'Failed to edit interview answer for ticket', err)
    return c.json({ error: 'Failed to edit answer', details: getErrorMessage(err) }, 500)
  } finally {
    if (editClaimToken) releaseInterviewBatch(ticketId, editClaimToken)
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

  const planningLock = claimPlanningEdit(ticketId)
  if (!planningLock) {
    return c.json({ error: 'A planning edit is already being processed; try again when it finishes' }, 409)
  }

  try {
    let beforeRaw: string | null = null
    let beforeItemCount: number | null = null
    let beforeDocument: InterviewDocument | null = null
    try {
      const before = readInterviewSaveBaseline(ticketId, parsed.data.expectedContentSha256)
      beforeRaw = before.raw
      beforeDocument = before.document
      beforeItemCount = before.document.questions.length
    } catch (err) {
      if (err instanceof MissingArtifactSavePreconditionError) {
        return c.json({ error: err.message, artifactType: 'interview' }, 428)
      }
      if (err instanceof StaleArtifactApprovalError) return staleInterviewSaveResponse(c, err)
      return c.json({ error: 'Failed to read interview document', details: getErrorMessage(err) }, 400)
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
        restart = await preparePlanningRestart(ticketId, 'WAITING_INTERVIEW_APPROVAL', planningLock, () => {
          const current = readInterviewDocument(ticketId)
          assertExpectedContentSha256({
            artifactType: 'interview',
            currentContent: current.raw,
            expectedContentSha256: parsed.data.expectedContentSha256!,
          })
        })
        assertPlanningEditClaim(ticketId, planningLock)
        // The baseline hash was checked before the stop. The durable content
        // CAS happens only after the restart has confirmed that remote work
        // stopped, so a failed stop never mutates the reviewed document.
        result = saveApprovedInterviewDocument(ticketId, document, parsed.data.expectedContentSha256!)
        emitRoutePhaseLog(ticketId, 'WAITING_INTERVIEW_APPROVAL', 'info', 'Interview edit saved and approved. Restarting PRD planning from the edited interview.')
        sendTicketEvent(ticketId, { type: 'APPROVE' })
      } else {
        result = saveInterviewDocument(ticketId, document, parsed.data.expectedContentSha256!)
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
      if (err instanceof PlanningEditClaimLostError) return c.json({ error: err.message }, 409)
      if (err instanceof StaleArtifactApprovalError) return staleInterviewSaveResponse(c, err)
      return c.json({
        error: 'Failed to save interview answers',
        details: getErrorMessage(err),
      }, 400)
    }
  } finally {
    releasePlanningEdit(ticketId, planningLock)
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

  const planningLock = claimPlanningEdit(ticketId)
  if (!planningLock) {
    return c.json({ error: 'A planning edit is already being processed; try again when it finishes' }, 409)
  }

  try {
    let beforeRaw: string | null = null
    let beforeItemCount: number | null = null
    let beforeDocument: InterviewDocument | null = null
    try {
      const before = readInterviewSaveBaseline(ticketId, parsed.data.expectedContentSha256)
      beforeRaw = before.raw
      beforeDocument = before.document
      beforeItemCount = before.document.questions.length
    } catch (err) {
      if (err instanceof MissingArtifactSavePreconditionError) {
        return c.json({ error: err.message, artifactType: 'interview' }, 428)
      }
      if (err instanceof StaleArtifactApprovalError) return staleInterviewSaveResponse(c, err)
      return c.json({ error: 'Failed to read interview document', details: getErrorMessage(err) }, 400)
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
        restart = await preparePlanningRestart(ticketId, 'WAITING_INTERVIEW_APPROVAL', planningLock, () => {
          const current = readInterviewDocument(ticketId)
          assertExpectedContentSha256({
            artifactType: 'interview',
            currentContent: current.raw,
            expectedContentSha256: parsed.data.expectedContentSha256!,
          })
        })
        assertPlanningEditClaim(ticketId, planningLock)
        result = saveApprovedInterviewDocument(ticketId, document, parsed.data.expectedContentSha256!)
        emitRoutePhaseLog(ticketId, 'WAITING_INTERVIEW_APPROVAL', 'info', 'Interview edit saved and approved. Restarting PRD planning from the edited interview.')
        sendTicketEvent(ticketId, { type: 'APPROVE' })
      } else {
        result = saveInterviewDocument(ticketId, document, parsed.data.expectedContentSha256!)
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
      if (err instanceof PlanningEditClaimLostError) return c.json({ error: err.message }, 409)
      if (err instanceof StaleArtifactApprovalError) return staleInterviewSaveResponse(c, err)
      return c.json({
        error: 'Failed to save interview document',
        details: getErrorMessage(err),
      }, 400)
    }
  } finally {
    releasePlanningEdit(ticketId, planningLock)
  }
}

export function handleGetInterview(c: Context) {
  const ticketId = getTicketParam(c)
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)
  return c.json(buildInterviewPayload(ticketId))
}
