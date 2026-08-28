/**
 * One countdown per workflow step, shared by every model asking inside it.
 *
 * OpenCode's `question` tool blocks a run until someone replies or rejects. Left
 * alone that is an unbounded stop, which is the opposite of what LoopTroop is
 * for. This module gives the wait an end: a timer per `(ticket, phase, attempt)`
 * that refuses every question attached to it when it runs out.
 *
 * The countdown is deliberately coarser than a question, and coarser than a
 * request. It cannot be per question — OpenCode's reply carries every answer in
 * one payload, so expiring question 2 would discard the answers already typed
 * into 1 and 3. And a council seats several models in one step, so one clock per
 * request would put three countdowns on screen for one decision. There is one
 * clock, it resets to full whenever another model arrives, and any human
 * interaction stops it for good.
 *
 * Two stores, one direction: this module holds live state, and the phase
 * artifacts hold the durable copy. RAM is the cache. A daemon restart rebuilds
 * from the artifacts, or refuses what it cannot rebuild.
 */

import type { OpenCodeQuestionInfo, OpenCodeQuestionTool } from '../opencode/types'
import { getOpenCodeAdapter } from '../opencode/factory'
import { onOpenCodeSessionEnded } from '../opencode/sessionEvents'
import { getTicketContext } from '../storage/ticketQueries'
import { getLatestPhaseArtifact, upsertLatestPhaseArtifact } from '../storage/ticketArtifacts'
import { broadcaster } from '../sse/broadcaster'
import { getErrorMessage } from '@shared/typeGuards'
import {
  buildAiQuestionTimerKey,
  clampAiQuestionWindowMs,
  isCouncilQuorumPhase,
  type AiQuestionTimerState,
} from '@shared/aiQuestions'
import type { SkipActor, SkipQuestionContext } from '@shared/skipReceipt'
import { deriveSkipActionId, writeSkipReceipts } from './skipReceipts'
import { getTicketWaitingMs, resumeTicketWork, suspendTicketWork } from './workBudget'
import { closeQuestionWait, openQuestionWait } from '../storage/questionWaits'

/** Attempts to tell OpenCode a question is refused before giving up on it. */
const REJECT_ATTEMPTS = 3
const REJECT_RETRY_DELAY_MS = 500

export const QUESTION_REQUEST_ARTIFACT_PREFIX = 'opencode_question:'
export const QUESTION_TIMER_ARTIFACT_PREFIX = 'opencode_question_timer:'

export type QuestionResolution =
  | 'replied'
  | 'user_skipped'
  | 'window_elapsed'
  | 'ticket_canceled'
  | 'session_lost'
  | 'daemon_restart'

/** What a request is doing right now. Only `pending` can be claimed. */
type RequestState = 'pending' | 'resolving' | 'resolved'

interface QuestionRequestRecord {
  ticketId: string
  sessionId: string
  requestId: string
  memberId: string | null
  phase: string
  phaseAttempt: number
  questions: OpenCodeQuestionInfo[]
  tool: OpenCodeQuestionTool | undefined
  receivedAt: number
  /** Ticket wait credit at attach, so the receipt can say what the step spent. */
  waitingAtAttach: number
  state: RequestState
  /** Who holds the claim while `resolving`. Only they may complete it. */
  claimId: string | null
  /** Bumped on every transition so a late frame cannot undo a newer one. */
  revision: number
}

let claimSequence = 0

/** Monotonic across every clock this process arms. See `generation` above. */
let timerGeneration = 0

/**
 * How long a resolved request is remembered.
 *
 * Long enough that a duplicate `asked` arriving after the answer cannot open a
 * second window for a question OpenCode has already been told about — which
 * would suspend the ticket's clocks again with nothing left to resolve it.
 */
const RESOLVED_TOMBSTONE_TTL_MS = 15 * 60_000

interface QuestionTimer {
  ticketId: string
  phase: string
  phaseAttempt: number
  timerKey: string
  /** Distinguishes this clock from the next one the same step arms. */
  generation: number
  windowMs: number
  armedAt: number
  deadlineAt: number
  stoppedAt: number | null
  stoppedBy: SkipActor | null
  resetCount: number
  revision: number
  handle: ReturnType<typeof setTimeout> | null
  requests: Map<string, QuestionRequestRecord>
}

/** ticketId → timerKey → timer. */
const timersByTicket = new Map<string, Map<string, QuestionTimer>>()

/** ticketId → requestKey → when it resolved. Guards against a replayed `asked`. */
const resolvedRecently = new Map<string, Map<string, number>>()

/**
 * ticketId → when this ticket's current wait began.
 *
 * Opened when the ticket goes from nothing pending to something, closed when the
 * last request resolves, so two overlapping questions record one interval rather
 * than two that double-count the same minutes.
 */
const waitStartedAt = new Map<string, number>()

function ticketHasPendingRequests(ticketId: string): boolean {
  const timers = timersByTicket.get(ticketId)
  if (!timers) return false
  for (const timer of timers.values()) {
    if (pendingRequests(timer).length > 0) return true
  }
  return false
}

function openWaitInterval(ticketId: string): void {
  if (waitStartedAt.has(ticketId)) return
  const startedAt = Date.now()
  waitStartedAt.set(ticketId, startedAt)
  // Written now rather than on resolution, so the wait counts while it is
  // happening and survives a restart that lands in the middle of it.
  openQuestionWait(ticketId, startedAt)
}

function closeWaitInterval(ticketId: string): void {
  waitStartedAt.delete(ticketId)
  closeQuestionWait(ticketId, Date.now())
}

function requestKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`
}

function rememberResolved(ticketId: string, key: string): void {
  let tombstones = resolvedRecently.get(ticketId)
  if (!tombstones) {
    tombstones = new Map()
    resolvedRecently.set(ticketId, tombstones)
  }
  tombstones.set(key, Date.now())
}

function wasResolvedRecently(ticketId: string, key: string): boolean {
  const tombstones = resolvedRecently.get(ticketId)
  if (!tombstones) return false
  const cutoff = Date.now() - RESOLVED_TOMBSTONE_TTL_MS
  for (const [candidate, at] of tombstones) {
    if (at < cutoff) tombstones.delete(candidate)
  }
  if (tombstones.size === 0) resolvedRecently.delete(ticketId)
  return (tombstones.get(key) ?? 0) >= cutoff
}

function ticketTimers(ticketId: string): Map<string, QuestionTimer> {
  let timers = timersByTicket.get(ticketId)
  if (!timers) {
    timers = new Map()
    timersByTicket.set(ticketId, timers)
  }
  return timers
}

function pendingRequests(timer: QuestionTimer): QuestionRequestRecord[] {
  return [...timer.requests.values()].filter((record) => record.state !== 'resolved')
}

// ── Serialisation ────────────────────────────────────────────────────────────

export function toTimerState(timer: QuestionTimer): AiQuestionTimerState {
  return {
    timerKey: timer.timerKey,
    generation: timer.generation,
    windowMs: timer.windowMs,
    armedAt: new Date(timer.armedAt).toISOString(),
    deadlineAt: new Date(timer.deadlineAt).toISOString(),
    stoppedAt: timer.stoppedAt === null ? null : new Date(timer.stoppedAt).toISOString(),
    stoppedBy: timer.stoppedBy,
    resetCount: timer.resetCount,
    revision: timer.revision,
    serverNow: new Date().toISOString(),
  }
}

/**
 * What one asking model shows in its tab.
 *
 * The timer travels alongside rather than inside: every request in a step shares
 * one, and repeating it per request would invite a client to render several
 * countdowns for a single clock.
 */
export interface PendingQuestionView {
  ticketId: string
  sessionId: string
  requestId: string
  memberId: string | null
  phase: string
  phaseAttempt: number
  questions: OpenCodeQuestionInfo[]
  questionCount: number
  tool: OpenCodeQuestionTool | undefined
  receivedAt: string
  timerKey: string
}

function toRequestView(record: QuestionRequestRecord, timer: QuestionTimer): PendingQuestionView {
  return {
    ticketId: record.ticketId,
    sessionId: record.sessionId,
    requestId: record.requestId,
    memberId: record.memberId,
    phase: record.phase,
    phaseAttempt: record.phaseAttempt,
    questions: record.questions,
    questionCount: record.questions.length,
    tool: record.tool,
    receivedAt: new Date(record.receivedAt).toISOString(),
    timerKey: timer.timerKey,
  }
}

// ── Durable copy ─────────────────────────────────────────────────────────────

function persistTimer(timer: QuestionTimer): void {
  try {
    upsertLatestPhaseArtifact(
      timer.ticketId,
      `${QUESTION_TIMER_ARTIFACT_PREFIX}${timer.timerKey}`,
      timer.phase,
      JSON.stringify({
        artifact: 'opencode_question_timer',
        ...toTimerState(timer),
        pendingRequestIds: pendingRequests(timer).map((record) => record.requestId),
      }),
      timer.phaseAttempt,
    )
  } catch {
    // The live timer is still armed; losing the durable copy costs a restart's
    // worth of recovery, not the wait itself.
  }
}

/** A window rebuilt from its artifact, as the previous process left it. */
export interface RestoredTimerState {
  windowMs: number
  armedAt: number
  deadlineAt: number
  stoppedAt: number | null
  stoppedBy: SkipActor | null
  resetCount: number
  revision: number
  receivedAt?: number
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function parseActor(value: unknown): SkipActor | null {
  return value === 'user' || value === 'timeout' || value === 'system' ? value : null
}

/**
 * Reads back the window a stopped daemon left behind.
 *
 * Returns null for anything it cannot fully trust — a missing artifact, an
 * unparseable one, a deadline that is not a date. The caller then starts a fresh
 * window, which is the safe direction: a question with a new clock is bounded,
 * and a question with a clock rebuilt from nonsense might not be.
 */
export function readTimerArtifact(
  ticketId: string,
  phase: string,
  phaseAttempt: number,
): RestoredTimerState | null {
  const timerKey = buildAiQuestionTimerKey(phase, phaseAttempt)
  try {
    const artifact = getLatestPhaseArtifact(
      ticketId,
      `${QUESTION_TIMER_ARTIFACT_PREFIX}${timerKey}`,
      phase,
      phaseAttempt,
    )
    if (!artifact?.content) return null
    const parsed = JSON.parse(artifact.content) as Record<string, unknown>
    const armedAt = parseTimestamp(parsed.armedAt)
    const deadlineAt = parseTimestamp(parsed.deadlineAt)
    if (armedAt === null || deadlineAt === null) return null
    return {
      windowMs: typeof parsed.windowMs === 'number' ? parsed.windowMs : deadlineAt - armedAt,
      armedAt,
      deadlineAt,
      stoppedAt: parseTimestamp(parsed.stoppedAt),
      stoppedBy: parseActor(parsed.stoppedBy),
      resetCount: typeof parsed.resetCount === 'number' ? parsed.resetCount : 0,
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
    }
  } catch {
    return null
  }
}

function persistRequest(record: QuestionRequestRecord, timerKey: string): void {
  try {
    upsertLatestPhaseArtifact(
      record.ticketId,
      `${QUESTION_REQUEST_ARTIFACT_PREFIX}${requestKey(record.sessionId, record.requestId)}`,
      record.phase,
      JSON.stringify({
        artifact: 'opencode_question_request',
        sessionId: record.sessionId,
        requestId: record.requestId,
        memberId: record.memberId,
        phase: record.phase,
        phaseAttempt: record.phaseAttempt,
        questionCount: record.questions.length,
        questions: record.questions,
        receivedAt: new Date(record.receivedAt).toISOString(),
        state: record.state,
        revision: record.revision,
        timerKey,
      }),
      record.phaseAttempt,
    )
  } catch {
    // Same trade as the timer: best-effort durability, never a blocked run.
  }
}

// ── Broadcast ────────────────────────────────────────────────────────────────

function broadcastTimer(timer: QuestionTimer): void {
  const context = getTicketContext(timer.ticketId)
  broadcaster.broadcast(timer.ticketId, 'needs_input', {
    type: 'opencode_question_updated',
    ticketId: timer.ticketId,
    ticketExternalId: context?.externalId,
    ticketTitle: context?.localTicket.title,
    status: context?.localTicket.status,
    phase: timer.phase,
    phaseAttempt: timer.phaseAttempt,
    timer: toTimerState(timer),
    requests: pendingRequests(timer).map((record) => toRequestView(record, timer)),
    timestamp: new Date().toISOString(),
  })
}

// ── Timer lifecycle ──────────────────────────────────────────────────────────

function disarm(timer: QuestionTimer): void {
  if (timer.handle) {
    clearTimeout(timer.handle)
    timer.handle = null
  }
}

function arm(timer: QuestionTimer): void {
  disarm(timer)
  if (timer.stoppedAt !== null) return
  const remaining = Math.max(0, timer.deadlineAt - Date.now())
  timer.handle = setTimeout(() => {
    // Everything inside is caught: an uncaught throw here would take the daemon
    // down and leave the question pending forever, which is the exact failure
    // this module exists to prevent.
    void expireTimer(timer).catch(() => {})
  }, remaining)
  // A timer whose deadline already passed must not keep the daemon alive.
  timer.handle.unref?.()
}

/**
 * Starts the countdown for a step, or pushes a running one back to full.
 *
 * A **running** timer resets: one minute left and a second council member asks,
 * and it is five minutes again, because the person now has two things to read.
 * A **stopped** timer does not restart. Stopping is a promise that the run waits
 * for a person, and a model arriving later must not quietly break it — the new
 * request simply joins the queue.
 */
export function armOrResetTimer(input: {
  ticketId: string
  phase: string
  phaseAttempt: number
  windowMs: number
  restore?: RestoredTimerState | undefined
}): QuestionTimer {
  const timerKey = buildAiQuestionTimerKey(input.phase, input.phaseAttempt)
  const timers = ticketTimers(input.ticketId)
  const existing = timers.get(timerKey)
  const windowMs = clampAiQuestionWindowMs(input.restore?.windowMs ?? input.windowMs)
  const now = Date.now()

  if (existing) {
    if (existing.stoppedAt === null && !input.restore) {
      existing.windowMs = windowMs
      existing.armedAt = now
      existing.deadlineAt = now + windowMs
      existing.resetCount += 1
      existing.revision += 1
      arm(existing)
    }
    return existing
  }

  // A restored window keeps the clock the previous process was running. The
  // artifact is authoritative: a timer someone stopped stays stopped, one still
  // inside its window keeps the time it has left, and one whose deadline passed
  // while the daemon was down fires as soon as it is armed. Handing back a fresh
  // full window instead would quietly undo a Stop, and let a restart loop
  // postpone an expiry indefinitely.
  const timer: QuestionTimer = {
    ticketId: input.ticketId,
    phase: input.phase,
    phaseAttempt: input.phaseAttempt,
    timerKey,
    generation: (timerGeneration += 1),
    windowMs,
    armedAt: input.restore?.armedAt ?? now,
    deadlineAt: input.restore?.deadlineAt ?? now + windowMs,
    stoppedAt: input.restore?.stoppedAt ?? null,
    stoppedBy: input.restore?.stoppedBy ?? null,
    resetCount: input.restore?.resetCount ?? 0,
    revision: (input.restore?.revision ?? 0) + 1,
    handle: null,
    requests: new Map(),
  }
  timers.set(timerKey, timer)
  arm(timer)
  return timer
}

/**
 * Files a question under its step's timer.
 *
 * Suspends the ticket's work budgets as a side effect: from here until the
 * request resolves, the model is waiting on a person and the phase timeout must
 * not run. Returns false when the request was already known, so a duplicate
 * `asked` event cannot suspend the budget twice.
 */
export function attachRequest(input: {
  ticketId: string
  sessionId: string
  requestId: string
  memberId: string | null
  phase: string
  phaseAttempt: number
  windowMs: number
  questions: OpenCodeQuestionInfo[]
  tool?: OpenCodeQuestionTool | undefined
  /** Restores a window rebuilt from its artifact instead of starting a new one. */
  restore?: RestoredTimerState | undefined
}): boolean {
  const key = requestKey(input.sessionId, input.requestId)

  // Identity is settled before the timer is touched. A duplicate or replayed
  // `asked` is not new activity, and treating it as such would push the deadline
  // out by another full window — repeat that and the bounded wait is unbounded.
  const timerKey = buildAiQuestionTimerKey(input.phase, input.phaseAttempt)
  const existing = timersByTicket.get(input.ticketId)?.get(timerKey)
  if (existing?.requests.has(key)) return false
  // Same for one that arrives after its own answer: OpenCode has been told, and
  // a second window would suspend the ticket's clocks with nothing to lift it.
  if (wasResolvedRecently(input.ticketId, key)) return false

  const timer = armOrResetTimer(input)

  const record: QuestionRequestRecord = {
    ticketId: input.ticketId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    memberId: input.memberId,
    phase: input.phase,
    phaseAttempt: input.phaseAttempt,
    questions: input.questions,
    tool: input.tool,
    receivedAt: input.restore?.receivedAt ?? Date.now(),
    waitingAtAttach: getTicketWaitingMs(input.ticketId),
    state: 'pending',
    claimId: null,
    revision: 1,
  }
  openWaitInterval(input.ticketId)
  timer.requests.set(key, record)
  suspendTicketWork(input.ticketId)
  persistRequest(record, timer.timerKey)
  persistTimer(timer)
  broadcastTimer(timer)
  return true
}

/**
 * Stops the countdown for every step of a ticket that still has one running.
 *
 * Every way a person can engage funnels here — switching model tabs, moving
 * between questions, focusing an answer field, pressing Stop timer. They are one
 * event, not four: once someone is dealing with this, the run waits. Idempotent,
 * and there is no resume; the ways out are answering and skipping.
 */
export function stopTicketTimers(ticketId: string, actor: SkipActor = 'user'): AiQuestionTimerState[] {
  const timers = timersByTicket.get(ticketId)
  if (!timers) return []
  const stopped: AiQuestionTimerState[] = []
  for (const timer of timers.values()) {
    if (timer.stoppedAt === null) {
      timer.stoppedAt = Date.now()
      timer.stoppedBy = actor
      timer.revision += 1
      disarm(timer)
      persistTimer(timer)
      // Rebroadcast so every open tab converges, rather than one of them
      // carrying on counting down against a clock that has stopped.
      broadcastTimer(timer)
    }
    stopped.push(toTimerState(timer))
  }
  return stopped
}

/**
 * Takes a request for exactly one resolver. Losers get null, never an error.
 *
 * Claiming and completing are two steps because a route has to call OpenCode in
 * between: it claims so expiry cannot send a second verdict for the same
 * question, awaits the reply, then completes the claim it still holds. Passing
 * the id back is what proves it is still the owner — without it a late stream
 * echo could resolve a request another caller is part-way through, and the first
 * cut of this module simply re-claimed, found the request no longer `pending`,
 * and silently never finished it at all.
 */
function claim(timer: QuestionTimer, key: string, claimId?: string): QuestionRequestRecord | null {
  const record = timer.requests.get(key)
  if (!record) return null
  if (claimId !== undefined) {
    if (record.state !== 'resolving' || record.claimId !== claimId) return null
    return record
  }
  if (record.state !== 'pending') return null
  record.state = 'resolving'
  record.claimId = null
  record.revision += 1
  return record
}

/** Claims a request and hands back the id its owner completes it with. */
function claimAndIssueId(timer: QuestionTimer, key: string): string | null {
  const record = timer.requests.get(key)
  if (!record || record.state !== 'pending') return null
  claimSequence += 1
  record.state = 'resolving'
  record.claimId = `clm_${claimSequence}`
  record.revision += 1
  return record.claimId
}

function findTimerFor(ticketId: string, sessionId: string, requestId: string): {
  timer: QuestionTimer
  key: string
} | null {
  const timers = timersByTicket.get(ticketId)
  if (!timers) return null
  const key = requestKey(sessionId, requestId)
  for (const timer of timers.values()) {
    if (timer.requests.has(key)) return { timer, key }
  }
  return null
}

function finish(timer: QuestionTimer, record: QuestionRequestRecord): void {
  record.state = 'resolved'
  record.claimId = null
  record.revision += 1
  persistRequest(record, timer.timerKey)
  const key = requestKey(record.sessionId, record.requestId)
  timer.requests.delete(key)
  rememberResolved(record.ticketId, key)
  // The model can go back to working. One resume per attach, so a step with two
  // questions outstanding stays suspended until the second is dealt with.
  resumeTicketWork(record.ticketId)

  if (pendingRequests(timer).length === 0) {
    disarm(timer)
    timersByTicket.get(timer.ticketId)?.delete(timer.timerKey)
    if (timersByTicket.get(timer.ticketId)?.size === 0) timersByTicket.delete(timer.ticketId)
  }
  // Closed only once nothing on the ticket is still waiting, so two overlapping
  // questions bank one stretch of wall time rather than each banking all of it.
  if (!ticketHasPendingRequests(record.ticketId)) closeWaitInterval(record.ticketId)
  persistTimer(timer)
  broadcastTimer(timer)
}

/**
 * What a refusal here might cost the round.
 *
 * Evidence, not machinery: the existing below-quorum check already routes to
 * `BLOCKED_ERROR`. Recording it on the receipt is what lets someone reading a
 * blocked council round later see that a question went unanswered inside it,
 * instead of finding only a quorum failure with no cause attached.
 */
function describeQuorumImpact(record: QuestionRequestRecord): string | null {
  if (!isCouncilQuorumPhase(record.phase)) return null
  const who = record.memberId ?? 'a council member'
  return `${who} was refused mid-round in ${record.phase}; its contribution may be missing from the quorum count.`
}

function buildQuestionContext(
  timer: QuestionTimer,
  record: QuestionRequestRecord,
  resolution: Exclude<QuestionResolution, 'replied'>,
  quorumImpact: string | null,
  /**
   * Everything the same expiry took down, captured before any of it was.
   *
   * Read live it shrinks as the batch is refused one by one, so the first
   * receipt named two siblings and the last named none — the reader most in
   * need of the context getting the least of it. The caller snapshots the set
   * once and passes it in.
   */
  siblingIds?: string[],
): SkipQuestionContext {
  const now = Date.now()
  const elapsedWallMs = Math.max(0, now - record.receivedAt)
  // Wall time minus the wait the budget credited back is what the step actually
  // spent. For a question that ran its full window that is zero, and saying so
  // is the point: the wait cost the step nothing. Read from the ledger rather
  // than inferred from `stoppedAt`, which measures how long the *clock* ran and
  // so reported a whole unattended window as active work.
  const creditedWaitMs = Math.max(0, getTicketWaitingMs(record.ticketId) - record.waitingAtAttach)
  return {
    request_id: record.requestId,
    session_id: record.sessionId,
    member_id: record.memberId,
    question_count: record.questions.length,
    window_ms: timer.windowMs,
    armed_at: new Date(timer.armedAt).toISOString(),
    deadline_at: new Date(timer.deadlineAt).toISOString(),
    reset_count: timer.resetCount,
    stopped_at: timer.stoppedAt === null ? null : new Date(timer.stoppedAt).toISOString(),
    stopped_by: timer.stoppedBy,
    elapsed_wall_ms: elapsedWallMs,
    elapsed_active_ms: Math.max(0, elapsedWallMs - creditedWaitMs),
    sibling_request_ids: (siblingIds ?? pendingRequests(timer).map((other) => other.requestId))
      .filter((requestId) => requestId !== record.requestId),
    expiry_reason: resolution,
    quorum_impact: quorumImpact ?? describeQuorumImpact(record),
  }
}

/**
 * Records a refusal against whoever is responsible for it.
 *
 * A question that ran out its wait was refused by nobody. Filing that under a
 * person's name would be a lie the trail cannot walk back, so the actor says
 * what actually happened.
 */
function writeQuestionReceipt(input: {
  timer: QuestionTimer
  record: QuestionRequestRecord
  actor: SkipActor
  /** Never `replied`: an answer is not a skip, and has no receipt to write. */
  resolution: Exclude<QuestionResolution, 'replied'>
  reason: string | null
  quorumImpact?: string | null
  /** The batch this refusal belonged to, snapshotted before any of it resolved. */
  siblingIds?: string[]
}): void {
  const { timer, record, actor, resolution } = input
  const context = getTicketContext(record.ticketId)
  if (!context) return
  const actionId = deriveSkipActionId('opencode-question', [record.sessionId, record.requestId, resolution])
  try {
    writeSkipReceipts({
      ticketId: record.ticketId,
      surface: 'opencode_question',
      // One summary row for the request, one child per unanswered question. A
      // single row plus a count could not say what the rejection actually
      // covered, and would make the existing per-item skip counts wrong.
      itemType: 'opencode_question',
      phase: record.phase,
      phaseAttempt: record.phaseAttempt,
      ticketStatusBefore: context.localTicket.status,
      actionId,
      skippedBy: actor,
      questionContext: buildQuestionContext(
        timer,
        record,
        resolution,
        input.quorumImpact ?? null,
        input.siblingIds,
      ),
      allowArchivedPhaseAttempt: actor !== 'user',
      summary: { itemType: 'opencode_question_request', reason: input.reason },
      items: record.questions.map((_question, index) => ({
        itemId: `${record.requestId}:${index}`,
        reason: input.reason,
      })),
    })
  } catch {
    // The rejection has already reached OpenCode. A receipt that cannot be
    // written is a lost audit row, not a reason to leave the run blocked.
  }
}

async function rejectWithRetries(requestId: string, projectRoot: string): Promise<string | null> {
  let lastError: unknown
  for (let attempt = 1; attempt <= REJECT_ATTEMPTS; attempt += 1) {
    try {
      await getOpenCodeAdapter().rejectQuestion(requestId, projectRoot)
      return null
    } catch (error) {
      lastError = error
      if (attempt < REJECT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, REJECT_RETRY_DELAY_MS * attempt))
      }
    }
  }
  return getErrorMessage(lastError)
}

/**
 * Refuses one request and closes it out locally either way.
 *
 * "Expiry that cannot reject" is the failure that recreates the original hang,
 * so a transport failure does not leave the record pending: the session is
 * abandoned, the failure is recorded, and the existing quorum and error paths
 * take it from there.
 */
async function rejectRecord(
  timer: QuestionTimer,
  record: QuestionRequestRecord,
  actor: SkipActor,
  resolution: Exclude<QuestionResolution, 'replied'>,
  reason: string | null,
  siblingIds?: string[],
): Promise<void> {
  const context = getTicketContext(record.ticketId)
  const failure = context
    ? await rejectWithRetries(record.requestId, context.projectRoot)
    : 'Ticket is no longer available'

  if (failure) {
    await getOpenCodeAdapter().abortSession(record.sessionId).catch(() => false)
  }
  writeQuestionReceipt({
    timer,
    record,
    actor,
    resolution,
    reason: failure ? [reason, `Could not tell OpenCode: ${failure}`].filter(Boolean).join(' — ') : reason,
    ...(siblingIds ? { siblingIds } : {}),
  })
  broadcaster.broadcast(record.ticketId, 'needs_input', {
    type: 'opencode_question_resolved',
    action: 'rejected',
    ticketId: record.ticketId,
    requestId: record.requestId,
    sessionId: record.sessionId,
    resolution,
    ...(failure ? { rejectFailed: failure } : {}),
    timestamp: new Date().toISOString(),
  })
  finish(timer, record)
}

/**
 * The clock ran out.
 *
 * Every request on this timer is refused, because there is one clock for all of
 * them, and each gets its own receipt naming the others it went down with.
 */
async function expireTimer(timer: QuestionTimer): Promise<void> {
  if (timer.stoppedAt !== null) return
  // Every claim is taken before the first `await`, so nothing else can take one
  // part-way through the batch, and the sibling list is the same on every
  // receipt rather than shrinking as the batch is worked through.
  const doomed = pendingRequests(timer)
    .map((record) => claim(timer, requestKey(record.sessionId, record.requestId)))
    .filter((record): record is QuestionRequestRecord => record !== null)
  const siblingIds = doomed.map((record) => record.requestId)
  for (const record of doomed) {
    await rejectRecord(
      timer,
      record,
      'timeout',
      'window_elapsed',
      'The wait ran out before anyone answered.',
      siblingIds,
    )
  }
}

// ── Resolution entry points ──────────────────────────────────────────────────

/**
 * A person answered. Clears the request without a receipt: nothing was skipped.
 *
 * `claimId` is the id from `claimRequestForReply`, which the route takes
 * before calling OpenCode. Omitting it claims here instead, for callers that
 * resolve a request without a round trip to defend against.
 */
export function markRequestReplied(
  ticketId: string,
  sessionId: string,
  requestId: string,
  claimId?: string,
): boolean {
  const found = findTimerFor(ticketId, sessionId, requestId)
  if (!found) return false
  const record = claim(found.timer, found.key, claimId)
  if (!record) return false
  rememberAnswered(record)
  finish(found.timer, record)
  return true
}

/**
 * Which models in a step were given a human answer.
 *
 * A council member that asked and got an answer drafts with steering the others
 * never saw, and is then judged by voters who did not see it either — so a draft
 * that followed the operator's instruction looks like the odd one out and gets
 * marked down for it. The vote is told, without being told *which* model it was.
 */
const answeredByStep = new Map<string, Set<string>>()

function stepKey(ticketId: string, phase: string, phaseAttempt: number): string {
  return `${ticketId}|${phase}|${phaseAttempt}`
}

function rememberAnswered(record: QuestionRequestRecord): void {
  if (!record.memberId) return
  const key = stepKey(record.ticketId, record.phase, record.phaseAttempt)
  const members = answeredByStep.get(key) ?? new Set<string>()
  members.add(record.memberId)
  answeredByStep.set(key, members)
}

export function wasMemberAnswered(
  ticketId: string | undefined,
  phase: string | undefined,
  phaseAttempt: number,
  memberId: string,
): boolean {
  if (!ticketId || !phase) return false
  return answeredByStep.get(stepKey(ticketId, phase, phaseAttempt))?.has(memberId) ?? false
}

/** A person pressed Skip. The reason is optional and goes on the receipt. */
export function markRequestSkipped(
  ticketId: string,
  sessionId: string,
  requestId: string,
  reason: string | null,
  claimId?: string,
): boolean {
  const found = findTimerFor(ticketId, sessionId, requestId)
  if (!found) return false
  const record = claim(found.timer, found.key, claimId)
  if (!record) return false
  writeQuestionReceipt({
    timer: found.timer,
    record,
    actor: 'user',
    resolution: 'user_skipped',
    reason,
  })
  finish(found.timer, record)
  return true
}

/**
 * Something outside LoopTroop refused it.
 *
 * Usually our own route, whose record is already gone by the time the stream
 * echoes the rejection back — so this is a no-op in the common case. When it is
 * not, another client or OpenCode itself refused the question, and closing the
 * record without a receipt is honest: we do not know why they did it.
 */
export function markRequestRejectedExternally(ticketId: string, sessionId: string, requestId: string): boolean {
  const found = findTimerFor(ticketId, sessionId, requestId)
  if (!found) return false
  const record = claim(found.timer, found.key)
  if (!record) return false
  finish(found.timer, record)
  return true
}

/**
 * Claims a request so a route can call OpenCode without racing the timer.
 *
 * Returns the id to complete the claim with, or null when someone else got
 * there first. A request with no window at all (reconciled away, or never
 * tracked) returns the sentinel id: there is no clock to race, and refusing
 * would block an answer OpenCode would still accept.
 */
export const UNTRACKED_CLAIM_ID = 'untracked'

export function claimRequestForReply(
  ticketId: string,
  sessionId: string,
  requestId: string,
): string | null {
  const found = findTimerFor(ticketId, sessionId, requestId)
  if (!found) return UNTRACKED_CLAIM_ID
  return claimAndIssueId(found.timer, found.key)
}

/**
 * Hands a claim back when the call the claim was taken for failed.
 *
 * The deadline may have passed while the claim was held — expiry looked at this
 * request, saw `resolving`, and left it alone. Returning it to `pending` under a
 * timer that has already fired would leave a question with no clock on it, which
 * is the unbounded wait this module exists to prevent. So the timer is either
 * re-armed or run right now. A *stopped* timer is the exception: stopping is a
 * promise that the run waits for a person, and that promise outlives a failed
 * send.
 */
export function releaseRequestClaim(
  ticketId: string,
  sessionId: string,
  requestId: string,
  claimId?: string,
): void {
  const found = findTimerFor(ticketId, sessionId, requestId)
  if (!found) return
  const record = found.timer.requests.get(found.key)
  if (!record || record.state !== 'resolving') return
  if (claimId !== undefined && record.claimId !== claimId) return
  record.state = 'pending'
  record.claimId = null
  record.revision += 1
  if (found.timer.stoppedAt !== null) return
  if (found.timer.deadlineAt <= Date.now()) {
    void expireTimer(found.timer).catch(() => {})
    return
  }
  arm(found.timer)
}

/**
 * Tears down every window a ticket holds.
 *
 * Called wherever a session dies — abandon, abort, terminal transition,
 * `BLOCKED_ERROR` — because a timer that outlives its session would later
 * reject a request OpenCode no longer has, and the suspended work budget would
 * hold the next run's clocks still.
 */
export async function clearTicketWindows(
  ticketId: string,
  resolution: Exclude<QuestionResolution, 'replied' | 'user_skipped' | 'window_elapsed'>,
  reason: string,
): Promise<void> {
  const timers = timersByTicket.get(ticketId)
  if (!timers) return
  for (const timer of [...timers.values()]) {
    disarm(timer)
    const doomed = pendingRequests(timer)
      .map((record) => claim(timer, requestKey(record.sessionId, record.requestId)))
      .filter((record): record is QuestionRequestRecord => record !== null)
    const siblingIds = doomed.map((record) => record.requestId)
    for (const record of doomed) {
      await rejectRecord(timer, record, 'system', resolution, reason, siblingIds)
    }
  }
  timersByTicket.delete(ticketId)
  forgetTicketMemory(ticketId)
}

/**
 * Drops the per-ticket bookkeeping that outlives the timers themselves.
 *
 * Tombstones expire on their own and the wait interval closes on resolution, but
 * `answeredByStep` only ever grows — one entry per (ticket, step, attempt,
 * member) for the life of the process. Cleared with the windows, which is the
 * one place that already knows a ticket is finished with.
 */
function forgetTicketMemory(ticketId: string): void {
  resolvedRecently.delete(ticketId)
  waitStartedAt.delete(ticketId)
  for (const key of [...answeredByStep.keys()]) {
    if (key.startsWith(`${ticketId}|`)) answeredByStep.delete(key)
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface TicketQuestionState {
  requests: PendingQuestionView[]
  timer: AiQuestionTimerState | null
}

export function getTicketQuestionState(ticketId: string): TicketQuestionState {
  const timers = timersByTicket.get(ticketId)
  if (!timers || timers.size === 0) return { requests: [], timer: null }
  const requests: PendingQuestionView[] = []
  let liveTimer: QuestionTimer | null = null
  for (const timer of timers.values()) {
    const pending = pendingRequests(timer)
    if (pending.length === 0) continue
    liveTimer = liveTimer ?? timer
    for (const record of pending) requests.push(toRequestView(record, timer))
  }
  requests.sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt))
  return { requests, timer: liveTimer ? toTimerState(liveTimer) : null }
}

/**
 * The summary the Kanban card and ticket list read.
 *
 * Both counts are named because they answer different questions and disagree:
 * a council of three asking two things each is 3 requests and 6 questions.
 */
export interface PendingQuestionSummary {
  requestCount: number
  questionCount: number
  deadlineAt: string | null
  stoppedAt: string | null
  requestIds: string[]
}

export function getPendingQuestionSummary(ticketId: string): PendingQuestionSummary | null {
  const state = getTicketQuestionState(ticketId)
  if (state.requests.length === 0) return null
  return {
    requestCount: state.requests.length,
    questionCount: state.requests.reduce((total, request) => total + request.questionCount, 0),
    deadlineAt: state.timer?.deadlineAt ?? null,
    stoppedAt: state.timer?.stoppedAt ?? null,
    // Sorted by code unit, not by locale. These ids are opaque handles and this
    // list is compared for equality to decide whether the board's card changed,
    // so the ordering has to be the same on every machine that computes it —
    // which is the one thing `localeCompare` does not promise.
    requestIds: state.requests
      .map((request) => request.requestId)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  }
}

/**
 * Drops records for questions OpenCode no longer has.
 *
 * The adapter is the authority on what is still outstanding. A record it does
 * not list was answered or rejected somewhere else — another client, a restart,
 * OpenCode itself — and keeping it would show a question nobody can resolve.
 */
export function reconcileAgainstPending(ticketId: string, liveRequestIds: Set<string>): void {
  const timers = timersByTicket.get(ticketId)
  if (!timers) return
  for (const timer of [...timers.values()]) {
    for (const record of pendingRequests(timer)) {
      if (liveRequestIds.has(record.requestId)) continue
      if (record.state !== 'pending') continue
      record.state = 'resolving'
      finish(timer, record)
    }
  }
}

/**
 * Re-attaches or refuses everything left pending by a daemon that stopped.
 *
 * `reconcileOpenCodeSessions` has already decided which sessions came back. A
 * request whose session reconnected is put back on a timer rebuilt from its
 * artifact — a reconnected session with no timer is a permanent hang. One whose
 * session did not is refused under the `system` actor, because nothing will ever
 * answer it.
 */
export interface RestartSessionOwner {
  sessionId: string
  ticketId: string
  memberId: string | null
  phase: string
  phaseAttempt: number
  /**
   * Whether the session came back.
   *
   * Dead sessions are listed too, and deliberately. `reconcileOpenCodeSessions`
   * runs first and marks everything that failed to reconnect as abandoned, so by
   * the time questions are reconciled the *most* interesting requests — the ones
   * nothing will ever answer — are exactly the ones whose owner is no longer
   * active. Dropping them from the map would leave them anonymous, and an
   * anonymous refusal is one nobody can explain later.
   */
  active: boolean
}

export async function reconcilePendingQuestionsAfterRestart(input: {
  projectRoot: string
  /** Every active session in the project, whichever ticket owns it. */
  owners: RestartSessionOwner[]
  /** Per-ticket window, for a request whose artifact could not be rebuilt. */
  windowMsFor: (ticketId: string) => number
}): Promise<{ reattached: number; rejected: number }> {
  const adapter = getOpenCodeAdapter()
  let pending: Awaited<ReturnType<typeof adapter.listPendingQuestions>>
  try {
    pending = await adapter.listPendingQuestions(input.projectRoot)
  } catch {
    return { reattached: 0, rejected: 0 }
  }
  if (pending.length === 0) return { reattached: 0, rejected: 0 }

  // Keyed by session, across the whole project. `listPendingQuestions` is
  // project-scoped, so reconciling one ticket at a time meant every request
  // belonging to a *sibling* ticket looked ownerless — and got rejected. Two
  // active tickets in one project were enough to kill one of them on restart.
  const owners = new Map(input.owners.map((owner) => [owner.sessionId, owner]))
  let reattached = 0
  let rejected = 0

  for (const request of pending) {
    const owner = owners.get(request.sessionID)
    if (owner?.active) {
      // The artifact is authoritative: a stopped clock stays stopped, and one
      // whose deadline passed while the daemon was down fires immediately
      // instead of buying itself another full window.
      const restore = readTimerArtifact(owner.ticketId, owner.phase, owner.phaseAttempt)
      if (attachRequest({
        ticketId: owner.ticketId,
        sessionId: request.sessionID,
        requestId: request.id,
        memberId: owner.memberId,
        phase: owner.phase,
        phaseAttempt: owner.phaseAttempt,
        windowMs: input.windowMsFor(owner.ticketId),
        questions: request.questions,
        tool: request.tool,
        ...(restore ? { restore } : {}),
      })) reattached += 1
      continue
    }
    // No live session owns it, so nothing will ever answer it. Refuse it and
    // leave a receipt: an orphan question that vanishes without a trail is how
    // a blocked round becomes unexplainable weeks later.
    const failure = await rejectWithRetries(request.id, input.projectRoot)
    if (owner) writeOrphanReceipt(owner, request, failure)
    rejected += 1
  }
  return { reattached, rejected }
}

/**
 * Files the refusal of a question whose session never came back.
 *
 * There is no live record to hang it on — the timer and its requests died with
 * the process — so the receipt is written straight from what the adapter and the
 * session row still know. Filed under `system`, because a daemon restart is not
 * a person's decision.
 */
function writeOrphanReceipt(
  owner: RestartSessionOwner,
  request: { id: string; questions: OpenCodeQuestionInfo[] },
  failure: string | null,
): void {
  const context = getTicketContext(owner.ticketId)
  if (!context) return
  const reason = failure
    ? `The daemon restarted and this session did not come back — Could not tell OpenCode: ${failure}`
    : 'The daemon restarted and this session did not come back.'
  try {
    writeSkipReceipts({
      ticketId: owner.ticketId,
      surface: 'opencode_question',
      itemType: 'opencode_question',
      phase: owner.phase,
      phaseAttempt: owner.phaseAttempt,
      ticketStatusBefore: context.localTicket.status,
      actionId: deriveSkipActionId('opencode-question', [owner.sessionId, request.id, 'daemon_restart']),
      skippedBy: 'system',
      allowArchivedPhaseAttempt: true,
      questionContext: {
        request_id: request.id,
        session_id: owner.sessionId,
        member_id: owner.memberId,
        question_count: request.questions.length,
        window_ms: 0,
        armed_at: null,
        deadline_at: null,
        reset_count: 0,
        stopped_at: null,
        stopped_by: null,
        elapsed_wall_ms: 0,
        elapsed_active_ms: 0,
        sibling_request_ids: [],
        expiry_reason: 'daemon_restart',
        quorum_impact: isCouncilQuorumPhase(owner.phase)
          ? `${owner.memberId ?? 'a council member'} was refused mid-round in ${owner.phase} after a daemon restart; its contribution may be missing from the quorum count.`
          : null,
      },
      summary: { itemType: 'opencode_question_request', reason },
      items: request.questions.map((_question, index) => ({
        itemId: `${request.id}:${index}`,
        reason,
      })),
    })
  } catch {
    // The rejection has already reached OpenCode; a lost audit row is not a
    // reason to leave the rest of the restart unreconciled.
  }
}

/**
 * Closes out the questions of a session that just died.
 *
 * Subscribed once, at module load, rather than added to each of the twenty-odd
 * places that abandon a session — coding reset, setup retry, PR draft, context
 * wipe, force-fresh. Missing one would leave a timer that later rejects a
 * request OpenCode no longer has, and a work budget suspended forever.
 *
 * OpenCode is not told: it has just been aborted, and the session it would be
 * told about is gone. The receipt records that, under `system`.
 */
onOpenCodeSessionEnded((event) => {
  if (!event.ticketId) return
  const timers = timersByTicket.get(event.ticketId)
  if (!timers) return
  for (const timer of [...timers.values()]) {
    for (const record of pendingRequests(timer)) {
      if (record.sessionId !== event.sessionId) continue
      const claimed = claim(timer, requestKey(record.sessionId, record.requestId))
      if (!claimed) continue
      writeQuestionReceipt({
        timer,
        record: claimed,
        actor: 'system',
        resolution: 'session_lost',
        reason: 'The session ended before anyone answered.',
      })
      finish(timer, claimed)
    }
  }
})

/** Test seam. Never called from production paths. */
export function resetAllQuestionWindows(): void {
  for (const timers of timersByTicket.values()) {
    for (const timer of timers.values()) disarm(timer)
  }
  timersByTicket.clear()
  resolvedRecently.clear()
  waitStartedAt.clear()
  answeredByStep.clear()
}
