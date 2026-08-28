/**
 * Skip reason auditability — the shared contract.
 *
 * Two stores, one direction:
 *   - the domain artifact (interview.yaml, the Manual QA summary, merge_report,
 *     tickets.cancel_reason) carries the *current* reason and is what the UI
 *     rehydrates from;
 *   - the receipt is append-only *history* — who skipped what, when, from which
 *     surface, and what the reason said at that moment.
 *
 * Surface names are an interface the moment anything reads them: they are the
 * `skip_receipt:<surface>` artifact namespace and they are matched by the audit
 * read path. Renaming one silently orphans every receipt already written under
 * the old name, so pick them once.
 */

export type SkipSurface =
  | 'interview_question'
  | 'interview_all'
  | 'interview_approval_mark_skipped'
  | 'approval_with_gaps'
  | 'manual_qa'
  | 'manual_qa_item'
  | 'close_unmerged'
  | 'cancel_ticket'
  | 'opencode_question'

export type SkipItemType =
  | 'interview_question'
  | 'interview_batch'
  | 'approval'
  | 'manual_qa_round'
  | 'manual_qa_item'
  | 'ticket'
  | 'opencode_question_request'
  | 'opencode_question'

/**
 * Who decided.
 *
 * Until AI questions there was only one answer, and the field was a literal.
 * A question that ran out its wait was refused by nobody, and filing that under
 * a person's name would be a lie the trail cannot walk back.
 *
 *  - `user` — a person pressed Skip.
 *  - `timeout` — the wait ran out and the question refused itself.
 *  - `system` — LoopTroop refused it for a reason of its own: the daemon
 *    restarted and could not re-attach the request, or the ticket was cancelled.
 */
export type SkipActor = 'user' | 'timeout' | 'system'

export const SKIP_ACTORS: readonly SkipActor[] = ['user', 'timeout', 'system']

export const SKIP_ACTOR_LABELS: Record<SkipActor, string> = {
  user: 'You',
  timeout: 'The wait ran out',
  system: 'LoopTroop',
}

/**
 * What was on screen, and what the clock was doing, when a question was refused.
 *
 * Recorded on the receipt because the request itself is gone the moment
 * OpenCode is told: the artifact holds current state, the receipt holds history,
 * and after a rejection there is no current state left to read.
 */
export interface SkipQuestionContext {
  request_id: string
  session_id: string
  member_id: string | null
  question_count: number
  window_ms: number
  /**
   * Null when there was no clock to record.
   *
   * A question orphaned by a daemon restart is refused without one: the timer
   * died with the process that armed it, and inventing a plausible-looking pair
   * of timestamps would make the trail read as though a wait had been measured
   * when none was.
   */
  armed_at: string | null
  deadline_at: string | null
  /** How many times another model arriving pushed the shared clock back to full. */
  reset_count: number
  stopped_at: string | null
  stopped_by: string | null
  elapsed_wall_ms: number
  /** Wall time minus what the wait credited back. What the model actually spent. */
  elapsed_active_ms: number
  /** The other requests the same expiry covered. One clock, many requests. */
  sibling_request_ids: string[]
  expiry_reason: 'window_elapsed' | 'user_skipped' | 'ticket_canceled' | 'session_lost' | 'daemon_restart'
  /** Set when the refusal cost a council round its quorum. */
  quorum_impact: string | null
}

export const SKIP_RECEIPT_SCHEMA_VERSION = 2

export const SKIP_RECEIPT_ARTIFACT_PREFIX = 'skip_receipt:'

/** What a stored reason may hold. Generous: reasons are operator prose. */
export const SKIP_REASON_MAX_LENGTH = 20_000

/**
 * What a reason may contribute to a prompt.
 *
 * Forty skipped questions at the storage cap is a token bomb, so the side
 * channel truncates and records that it did.
 */
export const SKIP_REASON_PROMPT_MAX_LENGTH = 500

/** What a reason may contribute to a plain-text phase log line. */
export const SKIP_REASON_LOG_MAX_LENGTH = 200

export const SKIP_SURFACES: readonly SkipSurface[] = [
  'interview_question',
  'interview_all',
  'interview_approval_mark_skipped',
  'approval_with_gaps',
  'manual_qa',
  'manual_qa_item',
  'close_unmerged',
  'cancel_ticket',
  'opencode_question',
]

export function isSkipSurface(value: unknown): value is SkipSurface {
  return typeof value === 'string' && (SKIP_SURFACES as readonly string[]).includes(value)
}

export function buildSkipReceiptArtifactType(surface: SkipSurface): string {
  return `${SKIP_RECEIPT_ARTIFACT_PREFIX}${surface}`
}

/** The stored record, in the snake_case shape it is serialised with. */
export interface SkipReceipt {
  schema_version: typeof SKIP_RECEIPT_SCHEMA_VERSION
  artifact: 'skip_receipt'
  receipt_id: string
  action_id: string
  parent_action_id: string | null
  surface: SkipSurface
  item_id: string | null
  item_type: SkipItemType
  /**
   * True for the single header row a bulk action writes.
   *
   * Without it a forty-question Skip All reads as forty unrelated decisions,
   * and a count of "skips" has no honest answer.
   */
  is_action_summary: boolean
  /**
   * True when this row records an item that stopped being skipped.
   *
   * Answering a question that was skipped changes the domain artifact, and the
   * trail has to say so or it keeps reporting a decision that was reversed.
   * A resolution carries no reason: there is nothing left to explain.
   */
  resolves: boolean
  phase: string
  phase_attempt: number | null
  ticket_status_before: string
  skipped_by: SkipActor
  /**
   * Deliberately null today. `ensureActorForTicket` is a state-machine
   * singleton, not a human identity; the slot exists for when multi-operator
   * does.
   */
  actor_ref: string | null
  skipped_at: string
  reason: string | null
  truncated_for_prompt: boolean
  supersedes: string | null
  /** Present only on `opencode_question` rows. */
  question_context?: SkipQuestionContext | null
}

/** The camelCase read view the audit surfaces and the client work with. */
export interface SkipEvent {
  receiptId: string
  actionId: string
  parentActionId: string | null
  surface: SkipSurface
  itemId: string | null
  itemType: SkipItemType
  isActionSummary: boolean
  resolves: boolean
  phase: string
  phaseAttempt: number | null
  /** Ticket status at the moment the action fired, recorded for audit. */
  ticketStatusBefore: string
  /** True when a prompt reading this reason will see a shortened copy. */
  truncatedForPrompt: boolean
  skippedAt: string
  /**
   * Who decided.
   *
   * Rows written before this field existed report `user`, which is what they
   * meant: a person was the only actor there was.
   */
  skippedBy: SkipActor
  reason: string | null
  supersedes: string | null
  /** True once a later event on the same item replaced this one. */
  superseded: boolean
  /** Present only on `opencode_question` rows. */
  questionContext?: SkipQuestionContext | null
}

export interface SkipEventCounts {
  /** Distinct user actions. A 40-question Skip All is one action. */
  actions: number
  /** Individual items those actions skipped. */
  items: number
  itemsWithReason: number
  itemsWithoutReason: number
}

export const SKIP_SURFACE_LABELS: Record<SkipSurface, string> = {
  interview_question: 'Interview question',
  interview_all: 'Remaining interview questions',
  interview_approval_mark_skipped: 'Interview answer, at approval',
  approval_with_gaps: 'Approved with known gaps',
  manual_qa: 'Manual QA',
  manual_qa_item: 'Manual QA check',
  close_unmerged: 'Finished without merging',
  cancel_ticket: 'Ticket canceled',
  opencode_question: 'AI question',
}

export function describeSkipSurface(surface: SkipSurface): string {
  return SKIP_SURFACE_LABELS[surface]
}

/**
 * Trims a reason for somewhere that cannot take the whole thing — a prompt, a
 * log line — and says whether it had to.
 */
export function truncateSkipReason(
  reason: string | null,
  maxLength: number,
): { text: string | null; truncated: boolean } {
  if (reason === null) return { text: null, truncated: false }
  const trimmed = reason.trim()
  if (!trimmed) return { text: null, truncated: false }
  if (trimmed.length <= maxLength) return { text: trimmed, truncated: false }
  return { text: `${trimmed.slice(0, maxLength).trimEnd()}…`, truncated: true }
}

/** Empty and whitespace-only reasons are stored as null, never as `''`. */
export function normalizeSkipReason(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null
  const trimmed = reason.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * One bulk action counts as 1 action and N items — never N + 1 skips, which is
 * what summing rows would say.
 */
export function countSkipEvents(events: SkipEvent[]): SkipEventCounts {
  const actions = new Set<string>()
  let items = 0
  let itemsWithReason = 0
  for (const event of events) {
    // A resolution records an item that stopped being skipped. Counting it as a
    // skip would make undoing one look like performing another.
    if (event.resolves) continue
    actions.add(event.parentActionId ?? event.actionId)
    if (event.isActionSummary) continue
    items += 1
    if (event.reason !== null) itemsWithReason += 1
  }
  return {
    actions: actions.size,
    items,
    itemsWithReason,
    itemsWithoutReason: items - itemsWithReason,
  }
}
