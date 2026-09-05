import type { TicketContext, TicketEvent } from '../../machines/types'
import type { DraftResult, MemberOutcome, Vote, VotePresentationOrder } from '../../council/types'
import { CancelledError, throwIfAborted, VOTING_RUBRIC_INTERVIEW } from '../../council/types'
import { conductVoting, selectWinner } from '../../council/voter'
import { refineDraft } from '../../council/refiner'
import { requireWinnerDraft } from '../../council/draftUtils'
import { checkMemberResponseQuorum, checkQuorum } from '../../council/quorum'
import { deliberateInterview } from '../../phases/interview/deliberate'
import { startInterviewSession, submitBatchToSession, type BatchResponse } from '../../phases/interview/qa'
import { buildCompiledInterviewArtifact, requireCompiledInterviewArtifact } from '../../phases/interview/compiled'
import {
  buildCanonicalInterviewYaml,
  buildInterviewQuestionViews,
  buildPersistedBatch,
  completeInterviewBySkippingRemaining,
  resolveSkippedQuestionIdsForSkipAll,
  countCoverageFollowUpQuestions,
  createInterviewSessionSnapshot,
  INTERVIEW_QA_SESSION_ARTIFACT,
  INTERVIEW_SESSION_ARTIFACT,
  markInterviewSessionComplete,
  parseInterviewSessionSnapshot,
  recordBatchAnswers,
  recordPreparedBatch,
  serializeInterviewSessionSnapshot,
} from '../../phases/interview/sessionState'
import { buildMinimalContext, type TicketState } from '../../opencode/contextBuilder'
import { buildPromptFromTemplate, PROM2, PROM3 } from '../../prompts/index'
import { randomUUID } from 'node:crypto'
import { and, eq, lte } from 'drizzle-orm'
import { interviewBatchClaims } from '../../db/schema'
import { getLatestPhaseArtifact, getTicketByRef, getTicketContext, getTicketPaths, insertPhaseArtifact, upsertLatestPhaseArtifact, countPhaseArtifacts } from '../../storage/tickets'
import { isMockOpenCodeMode } from '../../opencode/factory'
import { safeAtomicWrite } from '../../io/atomicWrite'
import { broadcaster } from '../../sse/broadcaster'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import * as jsYaml from 'js-yaml'
import { normalizeInterviewQuestionsOutput, normalizeInterviewRefinementOutput } from '../../structuredOutput'
import type { InterviewQuestionChange } from '@shared/interviewQuestions'
import type { InterviewSessionSnapshot } from '@shared/interviewSession'
import {
  buildInterviewUiRefinementDiffArtifact,
  buildInterviewUiRefinementDiffArtifactFromChanges,
} from '@shared/refinementDiffArtifacts'
import { calculateFollowUpLimit } from '../../phases/interview/followUpBudget'
import {
  deleteSkipReceiptsForAction,
  deriveSkipActionId,
  formatSkipReceiptLogLines,
  writeSkipReceipts,
} from '../skipReceipts'
import { raceWithCancel, throwIfCancelled } from '../../lib/abort'
import { PROFILE_DEFAULTS } from '../../db/defaults'
import { persistUiRefinementDiffArtifact } from '../refinementDiffArtifacts'
import { persistUiArtifactCompanionArtifact } from '../artifactCompanions'
import { withStructuredRetryDiagnosticAttempt } from '@shared/structuredRetryDiagnostics'
import { getErrorMessage } from '@shared/typeGuards'

import { adapter, interviewQASessions, phaseIntermediate, SKIP_ALL_INTERVIEW_COVERAGE_RESPONSE, getOrCreateAbortSignal } from './state'
import {
  emitPhaseLog,
  emitModelSystemLog,
  emitAiMilestone,
  emitOpenCodeSessionLogs,
  emitOpenCodeStreamEvent,
  emitOpenCodePromptLog,
  emitDraftProgressInfoLog,
  createOpenCodeStreamState,
  resolveInterviewDraftSettings,
  resolveCouncilRuntimeSettings,
  resolveAiResponseTimeoutForTicket,
  resolveStructuredRetryRuntimeSettings,
  resolveStructuredRetryCountForTicket,
  resolveCouncilMembers,
  loadTicketDirContext,
  formatCouncilResolutionLog,
  formatDraftRoundSummary,
  summarizeDraftOutcomes,
  createPendingDrafts,
  upsertCouncilDraftArtifact,
  upsertCouncilVoteArtifact,
  emitCouncilDecisionLogs,
  buildCouncilQuorumErrorWithDiagnostics,
  buildStructuredMetadata,
  mapCouncilStageToStatus,
} from './helpers'
import type { OpenCodeStreamState } from './types'

export function readInterviewQASessionArtifact(ticketId: string): { sessionId: string; winnerId: string } | null {
  const artifact = getLatestPhaseArtifact(ticketId, INTERVIEW_QA_SESSION_ARTIFACT)
  if (!artifact) return null

  try {
    const parsed = JSON.parse(artifact.content) as { sessionId?: unknown; winnerId?: unknown }
    if (typeof parsed.sessionId !== 'string' || typeof parsed.winnerId !== 'string') {
      return null
    }
    return { sessionId: parsed.sessionId, winnerId: parsed.winnerId }
  } catch {
    return null
  }
}

export function readInterviewSessionSnapshotArtifact(ticketId: string): InterviewSessionSnapshot | null {
  const artifact = getLatestPhaseArtifact(ticketId, INTERVIEW_SESSION_ARTIFACT)
  return parseInterviewSessionSnapshot(artifact?.content)
}

export function writeInterviewSessionSnapshotArtifact(ticketId: string, snapshot: InterviewSessionSnapshot) {
  upsertLatestPhaseArtifact(
    ticketId,
    INTERVIEW_SESSION_ARTIFACT,
    'WAITING_INTERVIEW_ANSWERS',
    serializeInterviewSessionSnapshot(snapshot),
  )
}

export function persistInterviewSession(ticketId: string, snapshot: InterviewSessionSnapshot) {
  writeInterviewSessionSnapshotArtifact(ticketId, snapshot)
}

export function loadCanonicalInterview(ticketDir: string): string | undefined {
  const interviewPath = resolve(ticketDir, 'interview.yaml')
  if (!existsSync(interviewPath)) return undefined
  try {
    return readFileSync(interviewPath, 'utf-8')
  } catch {
    return undefined
  }
}

export function writeCanonicalInterview(ticketId: string, ticketDir: string, snapshot: InterviewSessionSnapshot) {
  const interviewPath = resolve(ticketDir, 'interview.yaml')
  safeAtomicWrite(interviewPath, buildCanonicalInterviewYaml(ticketId, snapshot))
  return interviewPath
}

export function buildInterviewAnswerSummary(snapshot: InterviewSessionSnapshot | null): string {
  if (!snapshot) return ''
  const views = buildInterviewQuestionViews(snapshot)
  const answered = views
    .filter((question) => question.status === 'answered' || question.status === 'skipped')
    .map((question) => [
      `${question.id}: ${question.question}`,
      question.status === 'skipped'
        ? 'Answer: [SKIPPED]'
        : `Answer: ${question.answer ?? ''}`,
    ].join('\n'))
  return answered.join('\n\n')
}

export function buildFormattedBatchAnswers(
  questions: Array<{ id: string; answerType?: string; options?: Array<{ id: string; label: string }> }>,
  batchAnswers: Record<string, string>,
  selectedOptions: Record<string, string[]> = {},
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const question of questions) {
    const freeText = batchAnswers[question.id] ?? ''
    const selectedIds = selectedOptions[question.id] ?? []
    const isChoiceQ = question.answerType === 'single_choice' || question.answerType === 'multiple_choice'
    if (isChoiceQ && selectedIds.length > 0) {
      const labelMap = new Map((question.options ?? []).map((opt) => [opt.id, opt.label]))
      const selectedLabels = selectedIds.map((id) => labelMap.get(id) ?? id).map((label) => `"${label}"`).join(', ')
      result[question.id] = freeText.trim()
        ? `Selected: ${selectedLabels}. Notes: ${freeText}`
        : `Selected: ${selectedLabels}`
    } else {
      result[question.id] = freeText
    }
  }
  return result
}

/**
 * Records what a committed interview action skipped.
 *
 * Called at the commit point rather than on click: a reason typed against a
 * question the person then answered must never become history, and a skip that
 * was never submitted is not a decision.
 */
function recordInterviewSkipReceipts(input: {
  ticketId: string
  externalId: string
  ticketStatusBefore: string
  surface: 'interview_question' | 'interview_all'
  snapshot: InterviewSessionSnapshot
  questionIds: string[]
  /** Passed in: `recordBatchAnswers` clears `currentBatch` as it commits. */
  batchNumber: number | null
  bulkReason?: string | null
}): string | null {
  const skipped = input.questionIds
    .map((questionId) => ({ questionId, answer: input.snapshot.answers[questionId] }))
    .filter((entry) => entry.answer?.skipped === true)
  if (skipped.length === 0) return null

  const items = skipped.map((entry) => ({
    itemId: entry.questionId,
    reason: entry.answer?.skipReason ?? null,
  }))
  const actionId = deriveSkipActionId(input.surface, [
    input.ticketId,
    input.batchNumber,
    ...items.flatMap((item) => [item.itemId, item.reason]),
    input.bulkReason ?? null,
  ])

  const receipts = writeSkipReceipts({
    ticketId: input.ticketId,
    surface: input.surface,
    itemType: 'interview_question',
    phase: 'WAITING_INTERVIEW_ANSWERS',
    ticketStatusBefore: input.ticketStatusBefore,
    actionId,
    items,
    // Only the bulk action gets a summary row. Skipping three questions inside a
    // batch you then submit is three decisions, not a fourth one about the batch.
    summary: input.surface === 'interview_all'
      ? { itemType: 'interview_batch', reason: input.bulkReason ?? null }
      : null,
  })

  for (const line of formatSkipReceiptLogLines(receipts)) {
    emitPhaseLog(input.ticketId, input.externalId, 'WAITING_INTERVIEW_ANSWERS', 'info', line)
  }
  return actionId
}

/**
 * Where one batch reports the skip receipt it wrote, for the caller that may
 * have to undo it.
 *
 * `processInterviewBatchAsync` restores the previous snapshot when the AI call
 * fails, which un-does the skips; the receipts have to go with them. This was a
 * ticket-keyed module map, which made the record shared mutable state between
 * requests: any other submission for the same ticket — a coverage batch on the
 * synchronous path, a duplicate, a retry — overwrote or deleted the in-flight
 * batch's entry on its way through, and the rollback then found nothing to
 * remove. Per call, there is nothing to collide with.
 */
export interface InterviewBatchSkipReceipt {
  actionId?: string
  /**
   * `updatedAt` of the last session this call persisted.
   *
   * The revert below compares it against what is on disk. Reverting to a
   * snapshot that predates somebody else's write is how a stuck task undoes a
   * completed skip-all, and a revert cannot be taken back.
   */
  persistedUpdatedAt?: string
}

/**
 * How long a claim stays valid when the caller names no budget of its own.
 *
 * Only a backstop for the crash case: the route derives its own expiry from the
 * batch timeout, and every path releases explicitly. This is what stops a
 * daemon that died mid-batch from wedging the ticket forever.
 */
const DEFAULT_BATCH_CLAIM_TTL_MS = 60 * 60 * 1000

/**
 * Claims the answer batch for a ticket, in the project database.
 *
 * The route accepted a second submission whenever a session existed, even after
 * the first had cleared `currentBatch`. The second then deleted the first's
 * skip-receipt entry, failed with no active batch, and left the first's
 * rollback with nothing to remove — so a failed AI call reverted the snapshot
 * while its receipts stayed behind, describing skips the ticket no longer had.
 *
 * Held by both submission paths, not just the asynchronous one: a coverage
 * batch and a mock-mode batch run synchronously, and one of those arriving
 * during an in-flight AI batch walked into the same race from the other side.
 *
 * **Durable and cross-process, because a `Set` in one daemon is neither.** Two
 * daemons opened on one project share nothing but these files, and both would
 * have accepted the same batch; a restart mid-batch dropped the claim entirely.
 * The row's primary key is the ticket, so the exclusion is the table's
 * constraint rather than a check the reader has to remember, and the decision
 * is a conditional write rather than a read taken before one. SQLite is
 * synchronous here, so no caller had to become async for this.
 *
 * Returns the acquisition's token, or null when someone else holds it.
 */
export function claimInterviewBatch(ticketId: string, ttlMs = DEFAULT_BATCH_CLAIM_TTL_MS): string | null {
  const context = getTicketContext(ticketId)
  if (!context) return null

  const token = `${process.pid}:${randomUUID()}`
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const claim = {
    ticketId: context.localTicketId,
    token,
    claimedAt: nowIso,
    // Clamped at zero, not one: a zero-length lease is a claim that is expired
    // the instant it is written, which is exactly what the takeover tests need
    // to assert without waiting on the wall clock. A negative TTL is nonsense
    // and lands on the same instant rather than in the past.
    expiresAt: new Date(now + Math.max(0, ttlMs)).toISOString(),
  }

  return context.projectDb.transaction((tx): string | null => {
    // **The write is the guard.** Deciding from a `SELECT` first and writing
    // after would be exactly as unsafe as the `Set` this replaced: the shim
    // opens transactions with a plain `BEGIN`, so in WAL two daemons both read
    // a snapshot with no live claim, both pass the check, and the second's
    // unconditional upsert overwrites the first's live row — two winners, which
    // is the one case this table exists to prevent.
    //
    // With the condition on the conflict update, a live row is never touched:
    // SQLite applies `DO UPDATE … WHERE false` as zero rows changed, not an
    // error. Reading our own token back is how we learn whether we won, and it
    // is the same statement's outcome rather than a second opinion.
    //
    // `expires_at` is a fixed-width ISO-8601 UTC string, so comparing it as
    // text is comparing it as time.
    tx.insert(interviewBatchClaims)
      .values(claim)
      .onConflictDoUpdate({
        target: interviewBatchClaims.ticketId,
        set: claim,
        // A claim past its expiry belonged to a run that is gone. Taking it
        // over is the recovery path: nothing else would ever release it.
        //
        // `lte`, not `lt`, and the boundary is the whole reason. A claim is
        // live while `expires_at > now` — the test `hasInFlightInterviewBatch`
        // applies, and the one `sessionAuth` and `fileLock` already used. With
        // `lt` here the instant `expires_at === now` satisfied neither side:
        // the claim was not live, and no one could take it over, so the ticket
        // was wedged for that millisecond with no holder to release it. The two
        // conditions have to be exact complements, not merely opposite.
        where: lte(interviewBatchClaims.expiresAt, nowIso),
      })
      .run()

    const held = tx
      .select({ token: interviewBatchClaims.token })
      .from(interviewBatchClaims)
      .where(eq(interviewBatchClaims.ticketId, context.localTicketId))
      .get()
    return held?.token === token ? token : null
  })
}

/**
 * Gives the claim back, but only while this acquisition still holds it.
 *
 * Without the token an expired claim that someone else had already taken over
 * would be released by whoever held it before — the same fault
 * `server/io/fileLock.ts` carries a token to prevent.
 *
 * `token` is optional so a caller that only knows the ticket — the cleanup that
 * runs when a ticket reaches a terminal state — can drop the claim outright.
 * **Omitting it anywhere else is a bug**: an untokened release deletes whatever
 * claim the ticket currently has, including one a later submission is holding.
 */
export function releaseInterviewBatch(ticketId: string, token?: string): void {
  // Best effort by design. This runs from a route's error path and from the
  // cleanup that follows a ticket reaching a terminal state, neither of which
  // may throw — and the claim's expiry already covers a release that never
  // happens, which is the same reason a crashed daemon does not wedge a ticket.
  try {
    const context = getTicketContext(ticketId)
    if (!context) return
    context.projectDb
      .delete(interviewBatchClaims)
      .where(token
        ? and(eq(interviewBatchClaims.ticketId, context.localTicketId), eq(interviewBatchClaims.token, token))
        : eq(interviewBatchClaims.ticketId, context.localTicketId))
      .run()
  } catch (error) {
    console.warn(`[interview] Could not release the answer-batch claim for ${ticketId}; it expires on its own.`, error)
  }
}

/** True when a live claim exists for this ticket. */
export function hasInFlightInterviewBatch(ticketId: string): boolean {
  const context = getTicketContext(ticketId)
  if (!context) return false
  const existing = context.projectDb
    .select()
    .from(interviewBatchClaims)
    .where(eq(interviewBatchClaims.ticketId, context.localTicketId))
    .get()
  return Boolean(existing && Date.parse(existing.expiresAt) > Date.now())
}

export function skipAllInterviewQuestionsToApproval(
  ticketId: string,
  batchAnswers: Record<string, string>,
  options: {
    selectedOptions?: Record<string, string[]>
    skipReasons?: Record<string, string>
    bulkReason?: string | null
  } = {},
): { snapshot: InterviewSessionSnapshot; canonicalInterview: string } {
  const snapshot = readInterviewSessionSnapshotArtifact(ticketId)
  if (!snapshot) {
    throw new Error('No normalized interview session snapshot found for this ticket')
  }

  const ticket = getTicketByRef(ticketId)
  const externalId = ticket?.externalId ?? ticketId
  const coverageFollowUpBudgetPercent = ticket?.lockedCoverageFollowUpBudgetPercent
    ?? PROFILE_DEFAULTS.coverageFollowUpBudgetPercent
  const maxCoveragePasses = ticket?.lockedMaxCoveragePasses
    ?? PROFILE_DEFAULTS.maxCoveragePasses
  const paths = getTicketPaths(ticketId)
  if (!paths) {
    throw new Error(`Ticket workspace not initialized: missing ticket paths for ${externalId}`)
  }

  // Exactly the questions *this* action skips. Passing every finalized question
  // would re-record a question skipped in an earlier batch under the bulk
  // surface, superseding its original receipt with a decision the user did not
  // make here.
  const skippedByThisAction = resolveSkippedQuestionIdsForSkipAll(
    snapshot,
    batchAnswers,
    options.selectedOptions ?? {},
  )
  const finalizedSnapshot = completeInterviewBySkippingRemaining(snapshot, batchAnswers, {
    selectedOptions: options.selectedOptions,
    skipReasons: options.skipReasons,
    bulkReason: options.bulkReason,
  })
  const canonicalInterview = buildCanonicalInterviewYaml(externalId, finalizedSnapshot)
  const interviewPath = resolve(paths.ticketDir, 'interview.yaml')

  safeAtomicWrite(interviewPath, canonicalInterview)
  persistInterviewSession(ticketId, finalizedSnapshot)
  recordInterviewSkipReceipts({
    ticketId,
    externalId,
    ticketStatusBefore: ticket?.status ?? 'WAITING_INTERVIEW_ANSWERS',
    surface: 'interview_all',
    snapshot: finalizedSnapshot,
    questionIds: [...skippedByThisAction],
    batchNumber: snapshot.currentBatch?.batchNumber ?? null,
    bulkReason: options.bulkReason ?? null,
  })
  interviewQASessions.delete(ticketId)

  const userAnswers = buildInterviewAnswerSummary(finalizedSnapshot)
  const coverageRunNumber = Math.max(1, countPhaseArtifacts(ticketId, 'interview_coverage', 'VERIFYING_INTERVIEW_COVERAGE') || 1)
  const followUpBudgetTotal = calculateFollowUpLimit(finalizedSnapshot.maxInitialQuestions, coverageFollowUpBudgetPercent)
  const followUpBudgetUsed = countCoverageFollowUpQuestions(finalizedSnapshot)
  persistUiArtifactCompanionArtifact(ticketId, 'VERIFYING_INTERVIEW_COVERAGE', 'interview_coverage_input', {
    interview: canonicalInterview,
    userAnswers,
  })
  upsertLatestPhaseArtifact(
    ticketId,
    'interview_coverage',
    'VERIFYING_INTERVIEW_COVERAGE',
    JSON.stringify({
      winnerId: finalizedSnapshot.winnerId,
      hasGaps: false,
      coverageRunNumber,
      maxCoveragePasses,
      limitReached: false,
      terminationReason: 'clean',
    }),
  )
  persistUiArtifactCompanionArtifact(ticketId, 'VERIFYING_INTERVIEW_COVERAGE', 'interview_coverage', {
    response: SKIP_ALL_INTERVIEW_COVERAGE_RESPONSE,
    normalizedContent: [
      'status: clean',
      'gaps: []',
      'follow_up_questions: []',
    ].join('\n'),
    parsed: {
      status: 'clean',
      gaps: [],
      followUpQuestions: [],
    },
    followUpBudgetPercent: coverageFollowUpBudgetPercent,
    followUpBudgetTotal,
    followUpBudgetUsed,
    followUpBudgetRemaining: Math.max(0, followUpBudgetTotal - followUpBudgetUsed),
    structuredOutput: {
      repairApplied: false,
      repairWarnings: [],
      autoRetryCount: 0,
    },
  })

  emitPhaseLog(
    ticketId,
    externalId,
    'WAITING_INTERVIEW_ANSWERS',
    'info',
    'User skipped all remaining interview questions. Preserving existing answers and finalizing the normalized interview state.',
  )
  emitPhaseLog(
    ticketId,
    externalId,
    'VERIFYING_INTERVIEW_COVERAGE',
    'info',
    `${SKIP_ALL_INTERVIEW_COVERAGE_RESPONSE} Canonical interview.yaml refreshed at ${interviewPath}.`,
  )

  return {
    snapshot: finalizedSnapshot,
    canonicalInterview,
  }
}

export function buildCoverageFollowUpCommentary(response: string): string {
  const firstMeaningfulLine = response
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstMeaningfulLine
    ? `Coverage follow-up needed: ${firstMeaningfulLine}`
    : 'Coverage follow-up questions generated to close remaining gaps.'
}

export async function restoreInterviewQASession(ticketId: string) {
  const cached = interviewQASessions.get(ticketId)
  if (cached) return cached

  // After server restart the in-memory map is empty. Reload from DB and trust
  // the persisted session ID — adapter.listSessions() silently returns [] on
  // transient errors, causing valid sessions to be abandoned. The actual
  // OpenCode prompt call will surface a real error if the session is gone.
  const persisted = readInterviewQASessionArtifact(ticketId)
  if (!persisted) return null

  interviewQASessions.set(ticketId, persisted)
  return persisted
}

export function buildInterviewVotePrompt(
  ticketState: TicketState,
  anonymizedDrafts: string[],
  rubric: Array<{ category: string; weight: number; description: string }>,
) {
  const voteContext = [
    ...buildMinimalContext('interview_vote', {
      ...ticketState,
      drafts: anonymizedDrafts,
    }),
    {
      type: 'text' as const,
      source: 'vote_rubric',
      content: [
        'Detailed scoring rubric:',
        ...rubric.map(item => `- ${item.category} (${item.weight}pts): ${item.description}`),
        '',
        'Use the exact PROM2 `draft_scores` YAML schema. Keep the exact draft labels, include only rubric integer fields plus `total_score`, and do not add prose or extra keys.',
      ].join('\n'),
    },
  ]
  return [{ type: 'text' as const, content: buildPromptFromTemplate(PROM2, voteContext) }]
}

export function buildInterviewRefinePrompt(
  ticketState: TicketState,
  winnerDraft: DraftResult,
  losingDrafts: DraftResult[],
) {
  const refineContext = buildMinimalContext('interview_refine', {
    ...ticketState,
    drafts: [
      ['## Winning Draft', winnerDraft.content].join('\n'),
      ...losingDrafts.map((draft, index) => [
        `## Alternative Draft ${index + 1} (model: ${draft.memberId})`,
        draft.content,
      ].join('\n')),
    ],
  })
  return [{ type: 'text' as const, content: buildPromptFromTemplate(PROM3, refineContext) }]
}

export async function handleInterviewDeliberate(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  const phase = 'COUNCIL_DELIBERATING' as const
  const { worktreePath, ticket, relevantFiles } = loadTicketDirContext(context)

  emitPhaseLog(
    ticketId,
    context.externalId,
    phase,
    'info',
    `Ticket workspace ready for council drafting at ${worktreePath}.`,
  )

  // Step 1: Health-check OpenCode before doing any work
  throwIfAborted(signal, ticketId)
  try {
    const health = await raceWithCancel(adapter.checkHealth(signal), signal, ticketId)
    throwIfAborted(signal, ticketId)
    if (!health.available) {
      const msg = `OpenCode server is not running. Start it with \`opencode serve\`. (${health.error ?? 'connection refused'})`
      emitPhaseLog(ticketId, context.externalId, phase, 'error', msg)
      throw new Error(msg)
    }
    emitPhaseLog(
      ticketId,
      context.externalId,
      phase,
      'info',
      `OpenCode health check passed${health.version ? ` (version=${health.version})` : ''}.`,
    )
  } catch (err) {
    throwIfCancelled(err, signal, ticketId)
    // Re-throw if we already formatted the message
    if (err instanceof Error && err.message.startsWith('OpenCode server is not running')) throw err
    const msg = `OpenCode server is not running. Start it with \`opencode serve\`. (${getErrorMessage(err)})`
    emitPhaseLog(ticketId, context.externalId, phase, 'error', msg)
    throw new Error(msg)
  }

  // Step 2: Resolve council members from locked config (frozen at ticket start)
  const council = resolveCouncilMembers(context)
  const members = council.members
  emitPhaseLog(
    ticketId,
    context.externalId,
    phase,
    'info',
    formatCouncilResolutionLog(context, council),
  )

  const ticketDescription = ticket?.description ?? ''
  emitPhaseLog(ticketId, context.externalId, phase, 'info', `Loaded relevant files artifact (${relevantFiles?.length ?? 0} chars).`)
  const draftSettings = resolveInterviewDraftSettings(context)

  // Build context via buildMinimalContext with full ticket state
  const ticketState: TicketState = {
    ticketId: context.externalId,
    title: context.title,
    description: ticketDescription,
    relevantFiles,
  }
  const ticketContext = buildMinimalContext('interview_draft', ticketState)

  emitPhaseLog(ticketId, context.externalId, phase, 'info', `Interview council drafting started. Context: ${ticketContext.length} parts, description=${ticketDescription.length > 0 ? 'present' : 'missing'}, relevantFiles=${relevantFiles ? 'loaded' : 'missing'}.`)
  emitPhaseLog(
    ticketId,
    context.externalId,
    phase,
    'info',
    `Interview draft settings: max_initial_questions=${draftSettings.maxInitialQuestions}, ai_response_timeout=${draftSettings.draftTimeoutMs}ms, min_council_quorum=${draftSettings.minQuorum}.`,
  )
  emitPhaseLog(ticketId, context.externalId, phase, 'info', `Dispatching interview draft requests to ${members.length} council members.`)

  if (signal.aborted) throw new CancelledError(ticketId)
  const startedAt = Date.now()
  const streamStates = new Map<string, OpenCodeStreamState>()
  const liveDrafts = createPendingDrafts(members)
  upsertCouncilDraftArtifact(ticketId, phase, 'interview_drafts', liveDrafts)
  const result = await deliberateInterview(
    adapter,
    members,
    ticketContext,
    worktreePath,
    {
      ...draftSettings,
      maxStructuredRetries: resolveStructuredRetryRuntimeSettings(context).structuredRetryCount,
      ticketId,
    },
    signal,
    (entry) => {
      const targetStatus = mapCouncilStageToStatus('interview', entry.stage)
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeSessionLogs(
        ticketId,
        context.externalId,
        targetStatus,
        entry.memberId,
        entry.sessionId,
        entry.stage,
        entry.response,
        entry.messages,
        streamState,
      )
    },
    (entry) => {
      const targetStatus = mapCouncilStageToStatus('interview', entry.stage)
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeStreamEvent(
        ticketId,
        context.externalId,
        targetStatus,
        entry.memberId,
        entry.sessionId,
        entry.event,
        streamState,
      )
    },
    (entry) => {
      const targetStatus = mapCouncilStageToStatus('interview', entry.stage)
      emitOpenCodePromptLog(
        ticketId,
        context.externalId,
        targetStatus,
        entry.memberId,
        entry.event,
      )
    },
    (entry) => {
      emitDraftProgressInfoLog(ticketId, context.externalId, phase, 'Interview', entry)
      if (entry.status !== 'finished' || !entry.outcome) return
      const draftIndex = liveDrafts.findIndex(draft => draft.memberId === entry.memberId)
      if (draftIndex < 0) return
      liveDrafts[draftIndex] = {
        ...liveDrafts[draftIndex]!,
        content: entry.content ?? liveDrafts[draftIndex]!.content,
        outcome: entry.outcome,
        duration: entry.duration ?? liveDrafts[draftIndex]!.duration,
        error: entry.error,
        questionCount: entry.questionCount,
        structuredOutput: entry.structuredOutput,
        ...(typeof entry.rawResponse === 'string' ? { rawResponse: entry.rawResponse } : {}),
        ...(typeof entry.normalizedResponse === 'string' ? { normalizedResponse: entry.normalizedResponse } : {}),
        ...(entry.rawAttempts ? { rawAttempts: entry.rawAttempts } : {}),
        ...(entry.skippedReason ? { skippedReason: entry.skippedReason } : {}),
      }
      if (entry.structuredOutput?.repairWarnings.length) {
        emitPhaseLog(
          ticketId,
          context.externalId,
          phase,
          'info',
          `${entry.memberId} Interview draft normalization applied repairs: ${entry.structuredOutput.repairWarnings.join(' ')}`,
          { source: 'system', modelId: entry.memberId },
        )
      }
      if (entry.structuredOutput?.validationError && entry.structuredOutput.autoRetryCount > 0) {
        emitPhaseLog(
          ticketId,
          context.externalId,
          phase,
          'info',
          `${entry.memberId} Interview draft required ${entry.structuredOutput.autoRetryCount} structured retry attempt(s): ${entry.structuredOutput.validationError}`,
          { source: 'system', modelId: entry.memberId },
        )
      }
      upsertCouncilDraftArtifact(ticketId, phase, 'interview_drafts', liveDrafts)
    },
  )

  const draftSummary = summarizeDraftOutcomes(result.drafts)
  emitPhaseLog(
    ticketId,
    context.externalId,
    phase,
    'info',
    formatDraftRoundSummary(
      'Interview draft round',
      Date.now() - startedAt,
      draftSettings.draftTimeoutMs,
      Boolean(result.deadlineReached),
      draftSummary,
    ),
  )
  const quorum = checkQuorum(result.drafts, draftSettings.minQuorum)
  const nextStatus = quorum.passed ? 'COUNCIL_VOTING_INTERVIEW' : 'BLOCKED_ERROR'
  emitCouncilDecisionLogs(
    ticketId,
    context.externalId,
    phase,
    draftSettings.draftTimeoutMs,
    Boolean(result.deadlineReached),
    result.memberOutcomes,
    quorum,
    nextStatus,
  )

  upsertCouncilDraftArtifact(ticketId, phase, 'interview_drafts', result.drafts, result.memberOutcomes, true)
  emitPhaseLog(
    ticketId,
    context.externalId,
    phase,
    'info',
    `Saved interview draft artifact with ${Object.keys(result.memberOutcomes).length} member outcomes.`,
  )

  if (!quorum.passed) {
    throw buildCouncilQuorumErrorWithDiagnostics(
      `Council quorum not met for interview_draft: ${quorum.message}`,
      result.drafts,
    )
  }

  // Store intermediate data for vote/refine steps
  phaseIntermediate.set(`${ticketId}:interview`, {
    drafts: result.drafts,
    memberOutcomes: result.memberOutcomes,
    worktreePath,
    phase: result.phase,
    ticketState,
  })

  // DraftPhaseResult → Record<string, unknown>: structurally compatible but lacks index signature
  sendEvent({ type: 'QUESTIONS_READY', result: { ...result } })
}

export async function handleInterviewVote(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  const intermediate = phaseIntermediate.get(`${ticketId}:interview`)
  if (!intermediate) {
    throw new Error('No interview drafts found — cannot vote')
  }

  const { members } = resolveCouncilMembers(context)
  const councilSettings = resolveCouncilRuntimeSettings(context)
  const interviewTicketState = intermediate.ticketState ?? (() => {
    const { ticket, relevantFiles } = loadTicketDirContext(context)
    return {
      ticketId: context.externalId,
      title: context.title,
      description: ticket?.description ?? '',
      relevantFiles,
    } satisfies TicketState
  })()
  const streamStates = new Map<string, OpenCodeStreamState>()
  const liveVotes: Vote[] = []
  const liveVoterOutcomes = members.reduce<Record<string, MemberOutcome>>((acc, member) => {
    acc[member.modelId] = 'pending'
    return acc
  }, {})
  const liveVoterDetails = new Map<string, { voterId: string; error?: string; rawResponse?: string; normalizedResponse?: string; structuredOutput?: NonNullable<typeof intermediate.drafts[number]['structuredOutput']>; rawAttempts?: NonNullable<typeof intermediate.drafts[number]['rawAttempts']> }>()

  emitPhaseLog(ticketId, context.externalId, 'COUNCIL_VOTING_INTERVIEW', 'info',
    `Interview voting started with ${members.length} council members on ${intermediate.drafts.filter(d => d.outcome === 'completed').length} drafts.`)
  upsertCouncilVoteArtifact(ticketId, 'COUNCIL_VOTING_INTERVIEW', 'interview_votes', intermediate.drafts, [], liveVoterOutcomes, [...liveVoterDetails.values()])

  if (signal.aborted) throw new CancelledError(ticketId)
  const voteRun = await conductVoting(
    adapter,
    members,
    intermediate.drafts,
    [],
    intermediate.worktreePath,
    intermediate.phase,
    councilSettings.draftTimeoutMs,
    signal,
    (entry) => {
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeSessionLogs(
        ticketId,
        context.externalId,
        'COUNCIL_VOTING_INTERVIEW',
        entry.memberId,
        entry.sessionId,
        entry.stage,
        entry.response,
        entry.messages,
        streamState,
      )
    },
    (entry) => {
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeStreamEvent(
        ticketId,
        context.externalId,
        'COUNCIL_VOTING_INTERVIEW',
        entry.memberId,
        entry.sessionId,
        entry.event,
        streamState,
      )
    },
    (entry) => {
      emitOpenCodePromptLog(
        ticketId,
        context.externalId,
        'COUNCIL_VOTING_INTERVIEW',
        entry.memberId,
        entry.event,
      )
    },
    (entry) => {
      liveVoterOutcomes[entry.memberId] = entry.outcome
      if (entry.votes.length > 0) liveVotes.push(...entry.votes)
      liveVoterDetails.set(entry.memberId, {
        voterId: entry.memberId,
        ...(entry.error ? { error: entry.error } : {}),
        ...(typeof entry.rawResponse === 'string' ? { rawResponse: entry.rawResponse } : {}),
        ...(typeof entry.normalizedResponse === 'string' ? { normalizedResponse: entry.normalizedResponse } : {}),
        ...(entry.structuredOutput ? { structuredOutput: entry.structuredOutput } : {}),
        ...(entry.rawAttempts ? { rawAttempts: entry.rawAttempts } : {}),
      })
      upsertCouncilVoteArtifact(ticketId, 'COUNCIL_VOTING_INTERVIEW', 'interview_votes', intermediate.drafts, liveVotes, liveVoterOutcomes, [...liveVoterDetails.values()])
    },
    ({ anonymizedDrafts, rubric }) => buildInterviewVotePrompt(
      interviewTicketState,
      anonymizedDrafts.map(draft => draft.content),
      rubric,
    ),
    {
      ticketId,
      phase: 'COUNCIL_VOTING_INTERVIEW',
    },
    PROM2.toolPolicy,
    resolveStructuredRetryRuntimeSettings(context).structuredRetryCount,
  )

  const voteQuorum = checkMemberResponseQuorum(voteRun.memberOutcomes, councilSettings.minQuorum)
  const nextVoteStatus = voteQuorum.passed ? 'COMPILING_INTERVIEW' : 'BLOCKED_ERROR'
  emitCouncilDecisionLogs(
    ticketId,
    context.externalId,
    'COUNCIL_VOTING_INTERVIEW',
    councilSettings.draftTimeoutMs,
    voteRun.deadlineReached,
    voteRun.memberOutcomes,
    voteQuorum,
    nextVoteStatus,
  )

  if (!voteQuorum.passed) {
    upsertCouncilVoteArtifact(
      ticketId,
      'COUNCIL_VOTING_INTERVIEW',
      'interview_votes',
      intermediate.drafts,
      voteRun.votes,
      voteRun.memberOutcomes,
      voteRun.voterDetails,
      voteRun.presentationOrders,
      undefined,
      undefined,
      true,
    )
    throw buildCouncilQuorumErrorWithDiagnostics(
      `Interview voting quorum not met: ${voteQuorum.message}`,
      voteRun.voterDetails,
    )
  }

  if (voteRun.votes.length === 0) {
    throw new Error('Interview voting failed: no valid vote responses received')
  }

  const { winnerId, totalScore } = selectWinner(voteRun.votes, members)

  // Store vote results for refine step
  intermediate.votes = voteRun.votes
  intermediate.presentationOrders = voteRun.presentationOrders
  intermediate.winnerId = winnerId

  upsertCouncilVoteArtifact(
    ticketId,
    'COUNCIL_VOTING_INTERVIEW',
    'interview_votes',
    intermediate.drafts,
    voteRun.votes,
    voteRun.memberOutcomes,
    voteRun.voterDetails,
    voteRun.presentationOrders,
    winnerId,
    totalScore,
    true,
  )
  emitPhaseLog(
    ticketId,
    context.externalId,
    'COUNCIL_VOTING_INTERVIEW',
    'info',
    `Interview voting selected winner: ${winnerId} (score: ${totalScore}).`,
    { source: 'system', modelId: winnerId },
  )
  sendEvent({ type: 'WINNER_SELECTED', winner: winnerId })
}

export async function handleInterviewCompile(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  const intermediate = phaseIntermediate.get(`${ticketId}:interview`)
  if (!intermediate || !intermediate.winnerId) {
    throw new Error('No interview vote results found — cannot refine')
  }

  const winnerDraft = requireWinnerDraft(intermediate.drafts, intermediate.winnerId, 'Interview')
  const losingDrafts = intermediate.drafts.filter(d => d.memberId !== intermediate.winnerId && d.outcome === 'completed')
  const councilSettings = resolveCouncilRuntimeSettings(context)
  const interviewTicketState = intermediate.ticketState ?? (() => {
    const { ticket, relevantFiles } = loadTicketDirContext(context)
    return {
      ticketId: context.externalId,
      title: context.title,
      description: ticket?.description ?? '',
      relevantFiles,
    } satisfies TicketState
  })()
  const streamStates = new Map<string, OpenCodeStreamState>()

  emitPhaseLog(ticketId, context.externalId, 'COMPILING_INTERVIEW', 'info',
    `Interview refinement started. Winner: ${intermediate.winnerId}, incorporating ideas from ${losingDrafts.length} alternative drafts.`,
    { source: 'system', modelId: intermediate.winnerId })

  if (signal.aborted) throw new CancelledError(ticketId)

  // Refinement cross-validates against the winning draft, so an unparseable
  // winner fails every attempt identically: the retry prompt asks the model to
  // rewrite its refinement, and the input that actually broke is not the one it
  // can change. The beads and PRD phases check this up front; so does this one.
  // Cap of 0 — uncapped — because that is what the refinement validator parses
  // the same winner with. Passing the live cap here made the pre-check stricter
  // than the guard it stands in front of, so a winner the refinement would have
  // accepted could be refused as unparseable.
  const interviewWinnerCheck = normalizeInterviewQuestionsOutput(winnerDraft.content, 0)
  if (!interviewWinnerCheck.ok) {
    throw new Error(
      `Winning interview draft from ${winnerDraft.memberId} could not be parsed, so refinement cannot cross-validate against it: ${interviewWinnerCheck.error}`,
    )
  }

  let structuredMeta = buildStructuredMetadata({ autoRetryCount: 0, repairApplied: false, repairWarnings: [] })
  let parsedRefinementChanges: InterviewQuestionChange[] = []
  const refinementRun = await refineDraft(
    adapter,
    winnerDraft,
    losingDrafts,
    [],
    intermediate.worktreePath,
    councilSettings.draftTimeoutMs,
    signal,
    (entry) => {
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeSessionLogs(
        ticketId,
        context.externalId,
        'COMPILING_INTERVIEW',
        entry.memberId,
        entry.sessionId,
        entry.stage,
        entry.response,
        entry.messages,
        streamState,
      )
    },
    (entry) => {
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeStreamEvent(
        ticketId,
        context.externalId,
        'COMPILING_INTERVIEW',
        entry.memberId,
        entry.sessionId,
        entry.event,
        streamState,
      )
    },
    (entry) => {
      emitOpenCodePromptLog(
        ticketId,
        context.externalId,
        'COMPILING_INTERVIEW',
        entry.memberId,
        entry.event,
      )
    },
    {
      ticketId,
      phase: 'COMPILING_INTERVIEW',
    },
    (activeWinnerDraft, activeLosingDrafts) => buildInterviewRefinePrompt(
      interviewTicketState,
      activeWinnerDraft,
      activeLosingDrafts,
    ),
    (content) => {
      const losingDraftMeta = losingDrafts.map((d) => ({ memberId: d.memberId, content: d.content }))
      const result = normalizeInterviewRefinementOutput(
        content,
        winnerDraft.content,
        resolveInterviewDraftSettings(context).maxInitialQuestions,
        losingDraftMeta,
      )
      if (!result.ok) {
        const retryAttempt = (structuredMeta.autoRetryCount ?? 0) + 1
        structuredMeta = buildStructuredMetadata(structuredMeta, {
          autoRetryCount: retryAttempt,
          validationError: result.error,
          ...(result.retryDiagnostic
            ? { retryDiagnostics: [withStructuredRetryDiagnosticAttempt(result.retryDiagnostic, retryAttempt)!] }
            : {}),
        })
        throw new Error(result.error)
      }
      structuredMeta = buildStructuredMetadata(structuredMeta, {
        repairApplied: result.repairApplied,
        repairWarnings: result.repairWarnings,
        autoRetryCount: structuredMeta.autoRetryCount,
      })
      parsedRefinementChanges = result.value.changes
      return { normalizedContent: result.normalizedContent }
    },
    PROM3.outputFormat,
    undefined,
    PROM3.toolPolicy,
    resolveStructuredRetryRuntimeSettings(context).structuredRetryCount,
  )
  const refinedContent = refinementRun.content

  // Clean up intermediate data
  phaseIntermediate.delete(`${ticketId}:interview`)

  try {
    const paths = getTicketPaths(ticketId)
    if (!paths) {
      throw new Error(`Ticket workspace not initialized: missing ticket paths for ${context.externalId}`)
    }
    const losingDraftMeta = losingDrafts.map((d) => ({ memberId: d.memberId, content: d.content }))
    const compiledArtifact = buildCompiledInterviewArtifact(
      intermediate.winnerId,
      refinedContent,
      winnerDraft.content,
      resolveInterviewDraftSettings(context).maxInitialQuestions,
      losingDraftMeta,
    )
    const uiDiffArtifact = parsedRefinementChanges.length > 0
      ? buildInterviewUiRefinementDiffArtifactFromChanges({
          winnerId: intermediate.winnerId,
          changes: parsedRefinementChanges,
        })
      : buildInterviewUiRefinementDiffArtifact({
          winnerId: intermediate.winnerId,
          winnerDraftContent: winnerDraft.content,
          refinedContent: compiledArtifact.refinedContent,
          losingDrafts: losingDrafts.map((draft) => ({ memberId: draft.memberId, content: draft.content })),
        })

    insertPhaseArtifact(ticketId, {
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'interview_compiled',
      content: JSON.stringify({
        refinedContent: compiledArtifact.refinedContent,
        ...(refinementRun.rawAttempts.length > 0 ? { rawAttempts: refinementRun.rawAttempts } : {}),
      }),
    })
    persistUiArtifactCompanionArtifact(ticketId, 'COMPILING_INTERVIEW', 'interview_compiled', {
      winnerId: compiledArtifact.winnerId,
      questions: compiledArtifact.questions,
      questionCount: compiledArtifact.questionCount,
      structuredOutput: structuredMeta,
      ...(refinementRun.rawAttempts.length > 0 ? { rawAttempts: refinementRun.rawAttempts } : {}),
    })

    // Persist winnerId separately so it survives server restarts and is available
    // for VERIFYING_INTERVIEW_COVERAGE and downstream phases (PROM4/PROM5 wiring)
    insertPhaseArtifact(ticketId, {
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'interview_winner',
      content: JSON.stringify({ winnerId: intermediate.winnerId }),
    })
    persistUiRefinementDiffArtifact(ticketId, 'COMPILING_INTERVIEW', paths.ticketDir, uiDiffArtifact)

    emitModelSystemLog(
      ticketId,
      context.externalId,
      'COMPILING_INTERVIEW',
      'info',
      `Compiled final interview from winner ${intermediate.winnerId}. Validated ${compiledArtifact.questionCount} normalized questions.`,
      intermediate.winnerId,
    )

    sendEvent({ type: 'READY' })
    broadcaster.broadcast(ticketId, 'needs_input', {
      ticketId,
      type: 'interview_questions',
      context: {
        questions: compiledArtifact.refinedContent,
        parsedQuestions: compiledArtifact.questions,
        winnerId: intermediate.winnerId,
      },
    })
  } catch (error) {
    const message = getErrorMessage(error)
    throw new Error(`PROM3 refinement output failed validation: ${message}`)
  }
}

export async function handleInterviewQAStart(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  const persistedSnapshot = readInterviewSessionSnapshotArtifact(ticketId)
  if (persistedSnapshot?.currentBatch) {
    emitPhaseLog(
      ticketId,
      context.externalId,
      'WAITING_INTERVIEW_ANSWERS',
      'info',
      `Resuming persisted interview batch ${persistedSnapshot.currentBatch.batchNumber}.`,
    )
    broadcaster.broadcast(ticketId, 'needs_input', {
      ticketId,
      type: 'interview_batch',
      batch: persistedSnapshot.currentBatch,
    })
    return
  }

  const restoredSession = await restoreInterviewQASession(ticketId)
  if (restoredSession) {
    emitModelSystemLog(
      ticketId,
      context.externalId,
      'WAITING_INTERVIEW_ANSWERS',
      'info',
      `Reattached PROM4 session ${restoredSession.sessionId} for ${restoredSession.winnerId}.`,
      restoredSession.winnerId,
    )
    return
  }

  const { worktreePath, ticket, relevantFiles } = loadTicketDirContext(context)
  const interviewSettings = resolveInterviewDraftSettings(context)

  // Resolve winnerId from persisted artifact
  const winnerArtifact = getLatestPhaseArtifact(ticketId, 'interview_winner')

  let winnerId = ''
  if (winnerArtifact) {
    try {
      const parsed = JSON.parse(winnerArtifact.content) as { winnerId?: string }
      winnerId = parsed.winnerId ?? ''
    } catch { /* ignore */ }
  }
  if (!winnerId) {
    const msg = 'No interview winner found — cannot start PROM4 session'
    emitPhaseLog(ticketId, context.externalId, 'WAITING_INTERVIEW_ANSWERS', 'error', msg)
    sendEvent({ type: 'ERROR', message: msg, codes: ['PROM4_NO_WINNER'] })
    return
  }

  const compiledArtifact = getLatestPhaseArtifact(ticketId, 'interview_compiled')

  let compiledInterview: ReturnType<typeof requireCompiledInterviewArtifact>
  try {
    compiledInterview = requireCompiledInterviewArtifact(compiledArtifact?.content)
  } catch (error) {
    const details = getErrorMessage(error)
    const code = compiledArtifact ? 'PROM4_INVALID_COMPILED_INTERVIEW' : 'PROM4_NO_COMPILED_INTERVIEW'
    const msg = compiledArtifact
      ? `Compiled interview artifact invalid — cannot start PROM4 session: ${details}`
      : 'No validated compiled interview found — cannot start PROM4 session'
    emitPhaseLog(ticketId, context.externalId, 'WAITING_INTERVIEW_ANSWERS', 'error', msg)
    sendEvent({ type: 'ERROR', message: msg, codes: [code] })
    return
  }

  const ticketState: TicketState = {
    ticketId: context.externalId,
    title: context.title,
    description: ticket?.description ?? '',
    relevantFiles,
    interview: compiledInterview.refinedContent,
  }

  const baseSnapshot = persistedSnapshot ?? createInterviewSessionSnapshot({
    winnerId,
    compiledQuestions: compiledInterview.questions,
    maxInitialQuestions: interviewSettings.maxInitialQuestions,
    followUpBudgetPercent: interviewSettings.coverageFollowUpBudgetPercent,
  })

  emitModelSystemLog(
    ticketId,
    context.externalId,
    'WAITING_INTERVIEW_ANSWERS',
    'info',
    `Starting PROM4 interview session with winning model: ${winnerId}`,
    winnerId,
  )

  if (signal.aborted) throw new CancelledError(ticketId)
  const streamState = createOpenCodeStreamState()

  const { sessionId, firstBatch } = await startInterviewSession(
    adapter,
    worktreePath,
    winnerId,
    compiledInterview.refinedContent,
    ticketState,
    interviewSettings.maxInitialQuestions,
    interviewSettings.coverageFollowUpBudgetPercent,
    signal,
    (entry) => {
      emitOpenCodeStreamEvent(
        ticketId,
        context.externalId,
        'WAITING_INTERVIEW_ANSWERS',
        winnerId,
        entry.sessionId,
        entry.event,
        streamState,
      )
    },
    (entry) => {
      emitOpenCodePromptLog(
        ticketId,
        context.externalId,
        'WAITING_INTERVIEW_ANSWERS',
        winnerId,
        entry.event,
      )
    },
    ticketId,
    interviewSettings.draftTimeoutMs,
    resolveStructuredRetryRuntimeSettings(context).structuredRetryCount,
  )
  throwIfAborted(signal, ticketId)

  // Store session info
  interviewQASessions.set(ticketId, { sessionId, winnerId })
  insertPhaseArtifact(ticketId, {
    phase: 'WAITING_INTERVIEW_ANSWERS',
    artifactType: INTERVIEW_QA_SESSION_ARTIFACT,
    content: JSON.stringify({ sessionId, winnerId }),
  })

  const persistedBatch = buildPersistedBatch(firstBatch, 'prom4', baseSnapshot)
  const updatedSnapshot = recordPreparedBatch(baseSnapshot, persistedBatch)
  persistInterviewSession(ticketId, updatedSnapshot)

  emitModelSystemLog(
    ticketId,
    context.externalId,
    'WAITING_INTERVIEW_ANSWERS',
    'info',
    `PROM4 session started (session=${sessionId}). First batch: ${persistedBatch.questions.length} questions.`,
    winnerId,
  )
  emitAiMilestone(
    ticketId,
    context.externalId,
    'WAITING_INTERVIEW_ANSWERS',
    `PROM4 session created for ${winnerId} (session=${sessionId}).`,
    `${sessionId}:prom4-created`,
    {
      modelId: winnerId,
      sessionId,
      source: `model:${winnerId}`,
    },
  )

  // Broadcast first batch to frontend via SSE
  broadcaster.broadcast(ticketId, 'needs_input', {
    ticketId,
    type: 'interview_batch',
    batch: persistedBatch,
  })
}

/**
 * Handle a batch of user answers submitted during the PROM4 interview loop.
 * Called by the API route, not the state machine subscriber.
 */
export async function handleInterviewQABatch(
  ticketId: string,
  batchAnswers: Record<string, string>,
  selectedOptions: Record<string, string[]> = {},
  skipReasons: Record<string, string> = {},
  skipReceipt?: InterviewBatchSkipReceipt,
): Promise<BatchResponse> {
  const snapshot = readInterviewSessionSnapshotArtifact(ticketId)
  if (!snapshot?.currentBatch) {
    throw new Error('No active interview batch for this ticket')
  }

  const ticket = getTicketByRef(ticketId)
  const externalId = ticket?.externalId ?? ticketId
  const currentBatch = snapshot.currentBatch
  const answeredSnapshot = recordBatchAnswers(snapshot, batchAnswers, selectedOptions, skipReasons)

  // The batch is committed the moment its answers land in the snapshot, so this
  // is where the skips become history — including the implicit ones, where the
  // person submitted a question blank rather than clicking Skip.
  const batchSkipActionId = recordInterviewSkipReceipts({
    ticketId,
    externalId,
    ticketStatusBefore: ticket?.status ?? 'WAITING_INTERVIEW_ANSWERS',
    surface: 'interview_question',
    snapshot: answeredSnapshot,
    questionIds: currentBatch.questions.map((question) => question.id),
    batchNumber: currentBatch.batchNumber,
  })
  if (skipReceipt) {
    if (batchSkipActionId) skipReceipt.actionId = batchSkipActionId
    else delete skipReceipt.actionId
  }

  if (isMockOpenCodeMode()) {
    if (currentBatch.source === 'prom4' && currentBatch.batchNumber === 1) {
      const followUpBatch = buildPersistedBatch(
        {
          questions: buildMockInterviewFollowUpQuestions().map(({ id, question, phase, priority, rationale }) => ({
            id,
            question,
            phase,
            priority,
            rationale,
          })),
          progress: { current: 2, total: 2 },
          isComplete: false,
          isFinalFreeForm: false,
          aiCommentary: 'Mock follow-up batch ready.',
          batchNumber: 2,
        },
        'prom4',
        answeredSnapshot,
      )
      const updatedSnapshot = recordPreparedBatch(answeredSnapshot, followUpBatch)
      persistInterviewSession(ticketId, updatedSnapshot)
      return followUpBatch
    }

    const completedSnapshot = markInterviewSessionComplete(answeredSnapshot)
    const paths = getTicketPaths(ticketId)
    if (paths) {
      writeCanonicalInterview(ticket?.externalId ?? ticketId, paths.ticketDir, completedSnapshot)
    }
    persistInterviewSession(ticketId, completedSnapshot)
    return {
      questions: [],
      progress: currentBatch.progress,
      isComplete: true,
      isFinalFreeForm: currentBatch.isFinalFreeForm,
      aiCommentary: 'Mock interview complete.',
      batchNumber: currentBatch.batchNumber,
    }
  }

  if (currentBatch.source === 'coverage') {
    const paths = getTicketPaths(ticketId)
    if (!paths) {
      throw new Error(`Ticket workspace not initialized: missing ticket paths for ${externalId}`)
    }
    const completedSnapshot = markInterviewSessionComplete(answeredSnapshot)
    writeCanonicalInterview(externalId, paths.ticketDir, completedSnapshot)
    persistInterviewSession(ticketId, completedSnapshot)
    // Clean up stale PROM4 session for the coverage loop re-entry
    interviewQASessions.delete(ticketId)
    emitPhaseLog(
      ticketId,
      externalId,
      'WAITING_INTERVIEW_ANSWERS',
      'info',
      `Coverage follow-up batch ${currentBatch.batchNumber} captured. Returning to interview coverage verification.`,
    )
    return {
      questions: [],
      progress: currentBatch.progress,
      isComplete: true,
      isFinalFreeForm: false,
      aiCommentary: 'Coverage follow-up answers captured. Re-running coverage.',
      batchNumber: currentBatch.batchNumber,
    }
  }

  // Persist intermediate state immediately: answers saved, currentBatch cleared.
  // This ensures GET /interview returns the correct state while the AI processes
  // the next batch, and answers are not lost if the OpenCode call fails.
  persistInterviewSession(ticketId, answeredSnapshot)
  if (skipReceipt) skipReceipt.persistedUpdatedAt = answeredSnapshot.updatedAt

  // Get session info from memory or reload from DB
  const sessionInfo = await restoreInterviewQASession(ticketId)
  if (!sessionInfo) {
    const persistedSessionInfo = readInterviewQASessionArtifact(ticketId)
    if (persistedSessionInfo?.sessionId === 'mock-session') {
      const paths = getTicketPaths(ticketId)
      if (!paths) {
        throw new Error(`Ticket workspace not initialized: missing ticket paths for ${externalId}`)
      }

      const nextMockBatch = buildPersistedMockInterviewBatch(answeredSnapshot)
      if (!nextMockBatch) {
        const rawFinalYaml = buildCanonicalInterviewYaml(externalId, answeredSnapshot)
        const completedSnapshot = markInterviewSessionComplete(answeredSnapshot, rawFinalYaml)
        writeCanonicalInterview(externalId, paths.ticketDir, completedSnapshot)
        persistInterviewSession(ticketId, completedSnapshot)

        emitPhaseLog(
          ticketId,
          externalId,
          'WAITING_INTERVIEW_ANSWERS',
          'info',
          'Persisted mock interview completed after restart-safe batch replay.',
        )

        return {
          questions: [],
          progress: currentBatch.progress,
          isComplete: true,
          isFinalFreeForm: currentBatch.isFinalFreeForm,
          aiCommentary: 'Mock interview complete.',
          batchNumber: currentBatch.batchNumber,
        }
      }

      const persistedNextBatch = buildPersistedBatch(nextMockBatch, 'prom4', answeredSnapshot)
      const updatedSnapshot = recordPreparedBatch(answeredSnapshot, persistedNextBatch)
      persistInterviewSession(ticketId, updatedSnapshot)

      emitPhaseLog(
        ticketId,
        externalId,
        'WAITING_INTERVIEW_ANSWERS',
        'info',
        `Persisted mock interview advanced to batch ${persistedNextBatch.batchNumber}.`,
      )

      return persistedNextBatch
    }

    throw new Error('No active PROM4 session for this ticket')
  }

  const signal = getOrCreateAbortSignal(ticketId)
  const streamState = createOpenCodeStreamState()
  const formattedAnswers = buildFormattedBatchAnswers(currentBatch.questions, batchAnswers, selectedOptions)
  const paths = getTicketPaths(ticketId)
  let restartOptions: Parameters<typeof submitBatchToSession>[9] | undefined
  if (paths) {
    restartOptions = {
      projectPath: paths.worktreePath,
      ticketState: {
        ticketId: externalId,
        title: ticket?.title ?? '',
        description: ticket?.description ?? '',
      },
      snapshot: answeredSnapshot,
    }
  }
  const result = await submitBatchToSession(
    adapter,
    sessionInfo.sessionId,
    formattedAnswers,
    signal,
    sessionInfo.winnerId,
    (entry) => {
      emitOpenCodeStreamEvent(
        ticketId,
        externalId,
        'WAITING_INTERVIEW_ANSWERS',
        sessionInfo.winnerId,
        entry.sessionId,
        entry.event,
        streamState,
      )
    },
    (entry) => {
      emitOpenCodePromptLog(
        ticketId,
        externalId,
        'WAITING_INTERVIEW_ANSWERS',
        sessionInfo.winnerId,
        entry.event,
      )
    },
    ticketId,
    resolveAiResponseTimeoutForTicket(ticketId),
    restartOptions,
    resolveStructuredRetryCountForTicket(ticketId),
  )
  throwIfAborted(signal, ticketId)

  if (result.sessionId && result.sessionId !== sessionInfo.sessionId) {
    interviewQASessions.set(ticketId, { sessionId: result.sessionId, winnerId: sessionInfo.winnerId })
    upsertLatestPhaseArtifact(
      ticketId,
      INTERVIEW_QA_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      JSON.stringify({ sessionId: result.sessionId, winnerId: sessionInfo.winnerId }),
    )
    emitPhaseLog(
      ticketId,
      externalId,
      'WAITING_INTERVIEW_ANSWERS',
      'info',
      `PROM4 session restarted after structured-output failure (old=${sessionInfo.sessionId}, new=${result.sessionId}).`,
    )
  }

  if (result.isComplete) {
    if (!paths) {
      throw new Error(`Ticket workspace not initialized: missing ticket paths for ${externalId}`)
    }

    const completedSnapshot = markInterviewSessionComplete(answeredSnapshot, result.finalYaml)
    writeCanonicalInterview(externalId, paths.ticketDir, completedSnapshot)
    persistInterviewSession(ticketId, completedSnapshot)

    emitPhaseLog(
      ticketId,
      externalId,
      'WAITING_INTERVIEW_ANSWERS',
      'info',
      `PROM4 interview complete. Canonical interview.yaml regenerated from normalized session state.`,
    )

    return {
      ...result,
      batchNumber: currentBatch.batchNumber,
    }
  }

  const persistedNextBatch = buildPersistedBatch(result, 'prom4', answeredSnapshot)
  const updatedSnapshot = recordPreparedBatch(answeredSnapshot, persistedNextBatch)
  persistInterviewSession(ticketId, updatedSnapshot)

  emitPhaseLog(ticketId, externalId, 'WAITING_INTERVIEW_ANSWERS', 'info',
    `PROM4 batch ${persistedNextBatch.batchNumber}: ${persistedNextBatch.questions.length} questions. Progress: ${persistedNextBatch.progress.current}/${persistedNextBatch.progress.total}.`)

  return persistedNextBatch
}

/**
 * Fire-and-forget wrapper for handleInterviewQABatch.
 * Records answers synchronously (via handleInterviewQABatch's intermediate persist),
 * then processes the AI call in the background. On error, reverts to the original
 * snapshot so the user can retry.
 *
 * Returns a Promise that resolves with the BatchResponse (for .then()/.catch() chaining
 * in the route handler). Callers should NOT await this — call it fire-and-forget.
 */
export function processInterviewBatchAsync(
  ticketId: string,
  batchAnswers: Record<string, string>,
  originalSnapshot: InterviewSessionSnapshot,
  selectedOptions: Record<string, string[]> = {},
  skipReasons: Record<string, string> = {},
  /**
   * The claim this batch was dispatched under. Omitting it makes the release in
   * `finally` untokened, which would delete whatever claim the ticket holds by
   * then — including a later submission's.
   */
  claimToken?: string,
): Promise<BatchResponse> {
  // This call's own receipt, so the revert below can only ever undo the skips
  // this call wrote.
  const skipReceipt: InterviewBatchSkipReceipt = {}
  return handleInterviewQABatch(ticketId, batchAnswers, selectedOptions, skipReasons, skipReceipt)
    .catch((err) => {
      // Revert to original snapshot so the user can retry the submission —
      // but only while the session is still the one this call left behind.
      //
      // A task that outlived its own claim has no business rewriting a session
      // somebody else has moved on: skip-all completing the interview, or a
      // later batch being answered, would both be undone by a revert to a
      // snapshot from before either. The claim makes that rare; this makes it
      // impossible, because a revert is unrecoverable and a skipped revert is
      // not.
      try {
        const current = readInterviewSessionSnapshotArtifact(ticketId)
        const stillOurs = skipReceipt.persistedUpdatedAt === undefined
          || current?.updatedAt === skipReceipt.persistedUpdatedAt
        if (stillOurs) {
          persistInterviewSession(ticketId, originalSnapshot)
          // The skips in that snapshot are gone, so their receipts describe a
          // decision the ticket no longer carries.
          if (skipReceipt.actionId) deleteSkipReceiptsForAction(ticketId, skipReceipt.actionId)
        } else {
          console.warn(`[runner] Not reverting the interview session for ${ticketId}: it has moved on since this batch wrote it.`)
        }
      } catch (revertErr) {
        console.error(`[runner] Failed to revert interview snapshot for ${ticketId}:`, revertErr)
      }
      throw err
    })
    .finally(() => {
      // With the token, so a task that outlived its own claim cannot delete the
      // one a later submission is holding.
      releaseInterviewBatch(ticketId, claimToken)
    })
}

export function buildMockInterviewQuestions() {
  return [
    {
      id: 'goal',
      phase: 'foundation',
      question: 'What is the primary outcome this ticket should deliver?',
      priority: 'critical',
      rationale: 'Clarifies the core success criteria.',
    },
    {
      id: 'constraints',
      phase: 'structure',
      question: 'What implementation constraints or boundaries should the agent respect?',
      priority: 'high',
      rationale: 'Prevents invalid implementation choices.',
    },
    {
      id: 'verification',
      phase: 'assembly',
      question: 'How should success be verified once implementation is complete?',
      priority: 'high',
      rationale: 'Defines acceptance and testing expectations.',
    },
  ]
}

export function buildMockInterviewFollowUpQuestions() {
  return [
    {
      id: 'tradeoffs',
      phase: 'assembly',
      question: 'If scope or complexity has to move, which tradeoffs are acceptable and which are not?',
      priority: 'medium',
      rationale: 'Captures prioritization boundaries before implementation starts.',
    },
  ]
}

export function buildMockInterviewFinalQuestion() {
  return {
    id: 'final_notes',
    phase: 'assembly',
    question: 'What is the most important implementation note or edge case the agent should not miss?',
    priority: 'high',
    rationale: 'Captures the last high-signal guidance before implementation begins.',
  }
}

export function buildPersistedMockInterviewBatch(
  snapshot: InterviewSessionSnapshot,
): BatchResponse | null {
  const answeredBatchCount = snapshot.batchHistory.length

  if (answeredBatchCount === 1) {
    return {
      questions: buildMockInterviewFollowUpQuestions().map(({ id, question, phase, priority, rationale }) => ({
        id,
        question,
        phase,
        priority,
        rationale,
      })),
      progress: { current: 2, total: 3 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'One follow-up question to pin down acceptable tradeoffs.',
      batchNumber: 2,
    }
  }

  if (answeredBatchCount === 2) {
    const finalQuestion = buildMockInterviewFinalQuestion()
    return {
      questions: [{
        id: finalQuestion.id,
        question: finalQuestion.question,
        phase: finalQuestion.phase,
        priority: finalQuestion.priority,
        rationale: finalQuestion.rationale,
      }],
      progress: { current: 3, total: 3 },
      isComplete: false,
      isFinalFreeForm: true,
      aiCommentary: 'One final question before the interview artifact is finalized.',
      batchNumber: 3,
    }
  }

  return null
}

export function buildMockInterviewCompiledContent() {
  return jsYaml.dump({
    questions: buildMockInterviewQuestions().map(({ id, phase, question, priority, rationale }) => ({
      id,
      phase,
      question,
      priority,
      rationale,
    })),
  }, { lineWidth: 120, noRefs: true }) as string
}

export function buildMockInterviewDraftContent(variantIndex: number) {
  const questions = buildMockInterviewQuestions().map((question) => ({ ...question }))
  if (variantIndex > 0) {
    questions.push({
      id: `tradeoffs-${variantIndex + 1}`,
      phase: 'assembly',
      question: 'Which tradeoffs are acceptable if scope, timing, or implementation complexity conflict?',
      priority: 'medium',
      rationale: 'Surfaces prioritization decisions before implementation starts.',
    })
  }

  return jsYaml.dump({
    questions: questions.map(({ id, phase, question, priority, rationale }) => ({
      id,
      phase,
      question,
      priority,
      rationale,
    })),
  }, { lineWidth: 120, noRefs: true }) as string
}

export function buildMockInterviewDrafts(members: Array<{ modelId: string; name: string }>): DraftResult[] {
  return members.map((member, index) => ({
    memberId: member.modelId,
    content: index === 0 ? buildMockInterviewCompiledContent() : buildMockInterviewDraftContent(index),
    outcome: 'completed',
    duration: 1,
    questionCount: index === 0 ? buildMockInterviewQuestions().length : buildMockInterviewQuestions().length + 1,
  }))
}

export function buildMockInterviewVoteResult(
  members: Array<{ modelId: string; name: string }>,
  drafts: DraftResult[],
): {
  votes: Vote[]
  voterOutcomes: Record<string, MemberOutcome>
  presentationOrders: Record<string, VotePresentationOrder>
  winnerId: string
  totalScore: number
} {
  const winnerId = drafts[0]?.memberId ?? members[0]?.modelId ?? 'mock-model-1'
  const winnerScorecards = [
    [19, 19, 18, 18, 19],
    [18, 19, 19, 18, 18],
  ]
  const challengerScorecards = [
    [16, 15, 15, 16, 15],
    [15, 16, 15, 15, 16],
  ]

  const votes: Vote[] = []
  const voterOutcomes = members.reduce<Record<string, MemberOutcome>>((acc, member) => {
    acc[member.modelId] = 'completed'
    return acc
  }, {})
  const presentationOrders: Record<string, VotePresentationOrder> = {}

  members.forEach((member, memberIndex) => {
    const orderedDrafts = memberIndex % 2 === 0 ? drafts : [...drafts].reverse()
    presentationOrders[member.modelId] = {
      seed: `mock-seed-interview-${memberIndex + 1}`,
      order: orderedDrafts.map((draft) => draft.memberId),
    }

    orderedDrafts.forEach((draft) => {
      const scoreTemplate = draft.memberId === winnerId
        ? winnerScorecards[memberIndex % winnerScorecards.length]!
        : challengerScorecards[memberIndex % challengerScorecards.length]!
      const scores = VOTING_RUBRIC_INTERVIEW.map((criterion, scoreIndex) => ({
        category: criterion.category,
        score: scoreTemplate[scoreIndex] ?? 15,
        justification: draft.memberId === winnerId
          ? `Mock voter ${memberIndex + 1} preferred this draft on ${criterion.category.toLowerCase()}.`
          : `Mock voter ${memberIndex + 1} found this draft weaker on ${criterion.category.toLowerCase()}.`,
      }))
      const totalScore = scores.reduce((sum, score) => sum + score.score, 0)
      votes.push({
        voterId: member.modelId,
        draftId: draft.memberId,
        scores,
        totalScore,
      })
    })
  })

  const totalScore = votes
    .filter((vote) => vote.draftId === winnerId)
    .reduce((sum, vote) => sum + vote.totalScore, 0)

  return { votes, voterOutcomes, presentationOrders, winnerId, totalScore }
}

export function readMockInterviewWinnerId(ticketId: string, fallbackWinnerId: string): string {
  const voteArtifact = getLatestPhaseArtifact(ticketId, 'interview_votes')
  if (!voteArtifact) return fallbackWinnerId

  try {
    const parsed = JSON.parse(voteArtifact.content) as { winnerId?: unknown }
    return typeof parsed.winnerId === 'string' ? parsed.winnerId : fallbackWinnerId
  } catch {
    return fallbackWinnerId
  }
}

export async function handleMockCouncilDeliberate(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
) {
  const { members } = resolveCouncilMembers(context)
  const drafts = buildMockInterviewDrafts(members)
  const memberOutcomes = drafts.reduce<Record<string, MemberOutcome>>((acc, draft) => {
    acc[draft.memberId] = draft.outcome
    return acc
  }, {})
  upsertCouncilDraftArtifact(ticketId, 'COUNCIL_DELIBERATING', 'interview_drafts', drafts, memberOutcomes, true)
  emitPhaseLog(ticketId, context.externalId, 'COUNCIL_DELIBERATING', 'info', 'Mock interview drafting complete.')
  sendEvent({ type: 'QUESTIONS_READY', result: { winnerId: members[0]?.modelId } })
}

export async function handleMockInterviewVote(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
) {
  const { members } = resolveCouncilMembers(context)
  const drafts = buildMockInterviewDrafts(members)
  const voteResult = buildMockInterviewVoteResult(members, drafts)
  upsertCouncilVoteArtifact(
    ticketId,
    'COUNCIL_VOTING_INTERVIEW',
    'interview_votes',
    drafts,
    voteResult.votes,
    voteResult.voterOutcomes,
    undefined,
    voteResult.presentationOrders,
    voteResult.winnerId,
    voteResult.totalScore,
    true,
  )
  emitPhaseLog(ticketId, context.externalId, 'COUNCIL_VOTING_INTERVIEW', 'info', 'Mock interview winner selected.')
  sendEvent({ type: 'WINNER_SELECTED', winner: voteResult.winnerId })
}

export async function handleMockInterviewCompile(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
) {
  const paths = getTicketPaths(ticketId)
  if (!paths) throw new Error(`Ticket workspace not initialized: missing ticket paths for ${context.externalId}`)
  const { members } = resolveCouncilMembers(context)
  const winnerId = readMockInterviewWinnerId(ticketId, members[0]?.modelId ?? 'mock-model-1')
  const refinedContent = buildMockInterviewCompiledContent()
  const winnerDraftContent = buildMockInterviewDraftContent(0)
  const compiledArtifact = buildCompiledInterviewArtifact(
    winnerId,
    refinedContent,
    winnerDraftContent,
    buildMockInterviewQuestions().length,
  )
  const uiDiffArtifact = buildInterviewUiRefinementDiffArtifact({
    winnerId,
    winnerDraftContent,
    refinedContent: compiledArtifact.refinedContent,
  })
  insertPhaseArtifact(ticketId, {
    phase: 'COMPILING_INTERVIEW',
    artifactType: 'interview_compiled',
    content: JSON.stringify({
      refinedContent: compiledArtifact.refinedContent,
    }),
  })
  persistUiArtifactCompanionArtifact(ticketId, 'COMPILING_INTERVIEW', 'interview_compiled', {
    winnerId: compiledArtifact.winnerId,
    questions: compiledArtifact.questions,
    questionCount: compiledArtifact.questionCount,
  })
  insertPhaseArtifact(ticketId, {
    phase: 'COMPILING_INTERVIEW',
    artifactType: 'interview_winner',
    content: JSON.stringify({ winnerId }),
  })
  persistUiRefinementDiffArtifact(ticketId, 'COMPILING_INTERVIEW', paths.ticketDir, uiDiffArtifact)
  emitPhaseLog(ticketId, context.externalId, 'COMPILING_INTERVIEW', 'info', 'Mock interview compiled.')
  sendEvent({ type: 'READY' })
}

export async function handleMockInterviewQAStart(
  ticketId: string,
  context: TicketContext,
) {
  const { members } = resolveCouncilMembers(context)
  const winnerId = readMockInterviewWinnerId(ticketId, members[0]?.modelId ?? 'mock-model-1')
  const interviewSettings = resolveInterviewDraftSettings(context)
  const batch: BatchResponse = {
    questions: buildMockInterviewQuestions().map(({ id, question, phase, priority, rationale }) => ({
      id,
      question,
      phase,
      priority,
      rationale,
    })),
    progress: { current: 1, total: 2 },
    isComplete: false,
    isFinalFreeForm: false,
    aiCommentary: 'Mock interview batch ready.',
    batchNumber: 1,
  }

  const snapshot = createInterviewSessionSnapshot({
    winnerId,
    compiledQuestions: buildMockInterviewQuestions().map(({ id, phase, question }) => ({ id, phase, question })),
    maxInitialQuestions: interviewSettings.maxInitialQuestions,
    followUpBudgetPercent: interviewSettings.coverageFollowUpBudgetPercent,
  })
  const persistedBatch = buildPersistedBatch(batch, 'prom4', snapshot)
  const updatedSnapshot = recordPreparedBatch(snapshot, persistedBatch)

  interviewQASessions.set(ticketId, { sessionId: 'mock-session', winnerId })
  insertPhaseArtifact(ticketId, {
    phase: 'WAITING_INTERVIEW_ANSWERS',
    artifactType: INTERVIEW_QA_SESSION_ARTIFACT,
    content: JSON.stringify({ sessionId: 'mock-session', winnerId }),
  })
  persistInterviewSession(ticketId, updatedSnapshot)
  emitPhaseLog(ticketId, context.externalId, 'WAITING_INTERVIEW_ANSWERS', 'info', 'Mock interview questions ready for input.')
  broadcaster.broadcast(ticketId, 'needs_input', {
    ticketId,
    type: 'interview_batch',
    batch: persistedBatch,
  })
}
