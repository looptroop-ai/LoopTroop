/**
 * Append-only history for every user action that skips something.
 *
 * Modelled on {@link ../workflow/artifactEditReceipts.ts}, with three
 * differences that came out of verification:
 *
 *  - **`actionId` is required.** `insertPhaseArtifact` always appends and
 *    always broadcasts, so without an idempotency key a client retry or a
 *    journal replay doubles the count.
 *  - **No `item_prompt`.** It duplicates the domain artifact and goes stale the
 *    moment a question is edited at approval. Store `item_id`; resolve the
 *    prompt at render time.
 *  - **Rows are written in one transaction**, bulk summary first, so a
 *    forty-question Skip All can never be read half-written.
 *
 * Receipts are history. The reason a surface acts on *now* lives on the domain
 * artifact — `interview.yaml`, the Manual QA summary, `merge_report`,
 * `tickets.cancel_reason`. The two are never inverted.
 */

import { createHash } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import {
  buildSkipReceiptArtifactType,
  describeSkipSurface,
  normalizeSkipReason,
  SKIP_REASON_LOG_MAX_LENGTH,
  SKIP_REASON_MAX_LENGTH,
  SKIP_REASON_PROMPT_MAX_LENGTH,
  SKIP_ACTORS,
  SKIP_RECEIPT_SCHEMA_VERSION,
  SKIP_SURFACES,
  truncateSkipReason,
  type SkipActor,
  type SkipEvent,
  type SkipItemType,
  type SkipQuestionContext,
  type SkipReceipt,
  type SkipSurface,
} from '@shared/skipReceipt'
import { phaseArtifacts } from '../db/schema'
import { broadcaster } from '../sse/broadcaster'
import { getTicketContext } from '../storage/ticketQueries'
import { toArtifactManifestEntry } from '../storage/ticketArtifacts'
import { assertCurrentEditablePhaseAttempt, resolvePhaseAttempt } from '../storage/ticketPhaseAttempts'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

/** Manual QA wrote its own skip records long before this module existed. */
const MANUAL_QA_SKIP_RECEIPT_ARTIFACT = 'manual_qa_skip_receipt'
const MANUAL_QA_SUMMARY_ARTIFACT = 'manual_qa_summary'

const SKIP_RECEIPT_ARTIFACT_TYPES = SKIP_SURFACES.map(buildSkipReceiptArtifactType)

const READABLE_SKIP_ARTIFACT_TYPES = [
  ...SKIP_RECEIPT_ARTIFACT_TYPES,
  MANUAL_QA_SKIP_RECEIPT_ARTIFACT,
  MANUAL_QA_SUMMARY_ARTIFACT,
]

/**
 * A resolution says an item that was skipped no longer is.
 *
 * Without one, the trail keeps reporting a skip that has since been answered as
 * the current state. It is written as an ordinary receipt so it supersedes the
 * skip by the same rule everything else does, and carries `resolves: true` so a
 * reader can tell "answered after all" from "skipped again for a new reason".
 */
const skipItemTypeSchema = z.enum([
  'interview_question',
  'interview_batch',
  'approval',
  'manual_qa_round',
  'manual_qa_item',
  'ticket',
  'opencode_question_request',
  'opencode_question',
])

const skipQuestionContextSchema = z.object({
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  member_id: z.string().min(1).nullable(),
  question_count: z.number().int().nonnegative(),
  window_ms: z.number().int().nonnegative(),
  armed_at: z.string().min(1).nullable(),
  deadline_at: z.string().min(1).nullable(),
  reset_count: z.number().int().nonnegative(),
  stopped_at: z.string().min(1).nullable(),
  stopped_by: z.string().min(1).nullable(),
  elapsed_wall_ms: z.number().int().nonnegative(),
  elapsed_active_ms: z.number().int().nonnegative(),
  sibling_request_ids: z.array(z.string().min(1)),
  expiry_reason: z.enum(['window_elapsed', 'user_skipped', 'ticket_canceled', 'session_lost', 'daemon_restart']),
  quorum_impact: z.string().min(1).nullable(),
})

/**
 * Versioned discriminated union.
 *
 * A TypeScript union describes what this build writes; it does nothing for what
 * an older build already wrote into the database. Parsing at the read boundary
 * is the only thing that protects a stored record.
 */
const V1_SURFACES = SKIP_SURFACES.filter((surface) => surface !== 'opencode_question')

export const skipReceiptSchema = z.discriminatedUnion('schema_version', [
  /**
   * Frozen. This is what is already in people's databases.
   *
   * Its surface and item-type lists are pinned to what v1 could actually write.
   * Widening the shared enums inside this branch would let a v1 row claim a
   * surface that did not exist when it was written, which is exactly the drift
   * versioning is here to prevent.
   */
  z.object({
    schema_version: z.literal(1),
    artifact: z.literal('skip_receipt'),
    receipt_id: z.string().min(1),
    action_id: z.string().min(1),
    parent_action_id: z.string().min(1).nullable(),
    surface: z.enum(V1_SURFACES as unknown as [SkipSurface, ...SkipSurface[]]),
    item_id: z.string().min(1).nullable(),
    item_type: z.enum([
      'interview_question',
      'interview_batch',
      'approval',
      'manual_qa_round',
      'manual_qa_item',
      'ticket',
    ]),
    is_action_summary: z.boolean(),
    phase: z.string().min(1),
    phase_attempt: z.number().int().positive().nullable(),
    ticket_status_before: z.string().min(1),
    skipped_by: z.literal('user'),
    actor_ref: z.string().min(1).nullable(),
    skipped_at: z.string().min(1),
    reason: z.string().max(SKIP_REASON_MAX_LENGTH).nullable(),
    truncated_for_prompt: z.boolean(),
    supersedes: z.string().min(1).nullable(),
    /** True when this row records an item that stopped being skipped. */
    resolves: z.boolean().default(false),
  }),
  /**
   * v2 adds the actor and the question context.
   *
   * `skipped_by` was a literal because a person was the only thing that could
   * skip. A question that ran out its wait was refused by nobody, and filing
   * that under a person's name would be a lie the trail cannot walk back.
   */
  z.object({
    schema_version: z.literal(2),
    artifact: z.literal('skip_receipt'),
    receipt_id: z.string().min(1),
    action_id: z.string().min(1),
    parent_action_id: z.string().min(1).nullable(),
    surface: z.enum(SKIP_SURFACES as unknown as [SkipSurface, ...SkipSurface[]]),
    item_id: z.string().min(1).nullable(),
    item_type: skipItemTypeSchema,
    is_action_summary: z.boolean(),
    phase: z.string().min(1),
    phase_attempt: z.number().int().positive().nullable(),
    ticket_status_before: z.string().min(1),
    skipped_by: z.enum(SKIP_ACTORS as unknown as [SkipActor, ...SkipActor[]]),
    actor_ref: z.string().min(1).nullable(),
    skipped_at: z.string().min(1),
    reason: z.string().max(SKIP_REASON_MAX_LENGTH).nullable(),
    truncated_for_prompt: z.boolean(),
    supersedes: z.string().min(1).nullable(),
    resolves: z.boolean().default(false),
    question_context: skipQuestionContextSchema.nullable().default(null),
  }),
])

export interface SkipReceiptItemInput {
  itemId: string | null
  reason: string | null
  supersedes?: string | null
  /** Set for an item that is no longer skipped. Carries no reason. */
  resolves?: boolean
}

/** Sanitises whatever a caller claims about who acted. */
function normalizeSkipActor(actor: SkipActor | undefined): SkipActor {
  return actor && SKIP_ACTORS.includes(actor) ? actor : 'user'
}

export interface WriteSkipReceiptsInput {
  ticketId: string
  surface: SkipSurface
  itemType: SkipItemType
  phase: WorkflowPhaseId
  /** Snapshot this *before* firing any event: `CANCEL` moves the ticket first. */
  ticketStatusBefore: string
  phaseAttempt?: number | null
  actionId: string
  parentActionId?: string | null
  items: SkipReceiptItemInput[]
  /** Written first, in the same transaction, when the action skipped many items. */
  summary?: {
    itemType: SkipItemType
    reason: string | null
  } | null
  skippedAt?: string
  /**
   * Who decided. Defaults to `user`.
   *
   * Routes must never pass this through from a request body: a client claiming
   * `timeout` would be forging a machine decision into the audit trail.
   */
  skippedBy?: SkipActor
  /** Recorded on every row of an `opencode_question` action. */
  questionContext?: SkipQuestionContext | null
  /**
   * Write against a phase attempt that is no longer the current one.
   *
   * A question timer can fire in the instant a phase attempt is archived. The
   * rejection has already reached OpenCode by then, so refusing the receipt
   * would lose the only record of a side effect that really happened. Only
   * machine actors get this: a person's skip always belongs to the live attempt.
   */
  allowArchivedPhaseAttempt?: boolean
}

function buildReceiptId(actionId: string, itemId: string | null): string {
  return `skip-${createHash('sha256').update(`${actionId} ${itemId ?? ''}`).digest('hex').slice(0, 16)}`
}

/**
 * An action id derived from what the action actually did.
 *
 * A surface that submits through a background job can have its work reverted and
 * retried by the operator. A random id would record the reverted attempt and the
 * successful one as two separate decisions; a fixed id per batch would swallow a
 * genuine second submission carrying different reasons. Deriving it from the
 * content gets both right: an identical resubmission is the same action, an
 * edited one is a new action that supersedes the first.
 */
export function deriveSkipActionId(prefix: string, parts: Array<string | number | null>): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(parts.map((part) => part ?? null)))
    .digest('hex')
  return `${prefix}-${digest.slice(0, 16)}`
}

function readSkipReceiptRows(ticketRef: string): Array<{
  id: number
  /** As stored. A row written by an older build can name a status that is gone. */
  phase: string
  phaseAttempt: number
  artifactType: string
  content: string
}> {
  const context = getTicketContext(ticketRef)
  if (!context) return []
  return context.projectDb
    .select()
    .from(phaseArtifacts)
    .where(and(
      eq(phaseArtifacts.ticketId, context.localTicketId),
      inArray(phaseArtifacts.artifactType, READABLE_SKIP_ARTIFACT_TYPES),
    ))
    .orderBy(asc(phaseArtifacts.id))
    .all()
    .map((row) => ({
      id: row.id,
      phase: row.phase,
      phaseAttempt: row.phaseAttempt ?? 1,
      artifactType: row.artifactType ?? '',
      content: row.content,
    }))
}

/**
 * True when this exact user action already left receipts on this ticket.
 *
 * Parsed rather than pattern-matched. The substring test this replaces looked
 * for `"action_id":"<id>"` anywhere in the serialised row — which, checked
 * against the schema, no reason or question context can actually produce: the
 * only unescaped `action_id` key is the receipt's own, and a reason quoting
 * that text is escaped by `JSON.stringify`. So this is not a bug fix; it is a
 * check that holds because of what it reads rather than because of what the
 * schema currently happens to allow.
 */
export function hasSkipReceiptsForAction(ticketRef: string, actionId: string): boolean {
  return readSkipReceiptRows(ticketRef).some((row) => (
    SKIP_RECEIPT_ARTIFACT_TYPES.includes(row.artifactType)
    && parseStoredReceipt(row.content)?.action_id === actionId
  ))
}

/**
 * Writes one receipt per skipped item, plus an optional action summary, in a
 * single transaction. Returns what it wrote; an empty array means the action
 * had already been recorded.
 */
export function writeSkipReceipts(input: WriteSkipReceiptsInput): SkipReceipt[] {
  const context = getTicketContext(input.ticketId)
  if (!context) throw new Error(`Ticket not found: ${input.ticketId}`)
  if (input.items.length === 0 && !input.summary) return []
  if (hasSkipReceiptsForAction(input.ticketId, input.actionId)) return []

  const skippedBy = normalizeSkipActor(input.skippedBy)
  if (!(input.allowArchivedPhaseAttempt === true && skippedBy !== 'user')) {
    assertCurrentEditablePhaseAttempt({
      ticketId: input.ticketId,
      phase: input.phase,
      requestedPhaseAttempt: input.phaseAttempt,
    })
  }
  const phaseAttempt = resolvePhaseAttempt(input.ticketId, input.phase, input.phaseAttempt)
  const skippedAt = input.skippedAt ?? new Date().toISOString()
  const artifactType = buildSkipReceiptArtifactType(input.surface)

  const base = {
    schema_version: SKIP_RECEIPT_SCHEMA_VERSION,
    artifact: 'skip_receipt',
    action_id: input.actionId,
    parent_action_id: input.parentActionId ?? null,
    surface: input.surface,
    phase: input.phase,
    phase_attempt: phaseAttempt,
    ticket_status_before: input.ticketStatusBefore,
    skipped_by: skippedBy,
    // Deliberately null. `ensureActorForTicket` is a state-machine singleton,
    // not a human identity; the slot exists for when multi-operator does.
    actor_ref: null,
    skipped_at: skippedAt,
    question_context: input.questionContext ?? null,
  } as const

  /**
   * Whether this reason will be shortened where a prompt reads it.
   *
   * Computed here rather than stamped on later by whichever prompt happened to
   * consume it: the receipt is append-only, and the reason does not change
   * between being recorded and being injected, so the answer is the same either
   * way and this one is not a mutation.
   */
  const willTruncateForPrompt = (reason: string | null): boolean => (
    truncateSkipReason(reason, SKIP_REASON_PROMPT_MAX_LENGTH).truncated
  )

  const receipts: SkipReceipt[] = []
  if (input.summary) {
    const reason = normalizeSkipReason(input.summary.reason)
    receipts.push({
      ...base,
      receipt_id: buildReceiptId(input.actionId, null),
      item_id: null,
      item_type: input.summary.itemType,
      is_action_summary: true,
      reason,
      truncated_for_prompt: willTruncateForPrompt(reason),
      supersedes: null,
      resolves: false,
    })
  }
  for (const item of input.items) {
    const reason = normalizeSkipReason(item.reason)
    receipts.push({
      ...base,
      receipt_id: buildReceiptId(input.actionId, item.itemId),
      item_id: item.itemId,
      item_type: input.itemType,
      // Children of a bulk action point at it. Counting already works from the
      // shared action id, but a null parent on a row that plainly has one is a
      // trap for the next reader.
      parent_action_id: input.parentActionId ?? (input.summary ? input.actionId : null),
      is_action_summary: false,
      reason,
      truncated_for_prompt: willTruncateForPrompt(reason),
      supersedes: item.supersedes ?? null,
      resolves: item.resolves === true,
    })
  }

  const now = new Date().toISOString()
  // The idempotency check runs again inside the write transaction, where the
  // read and the insert cannot be separated. Outside it — as it was — two
  // submissions of the same action could both see "not yet recorded" and both
  // write a full set of receipts.
  //
  // A unique index on (ticket_id, action_id) would enforce this in the database
  // instead, but that needs a migration; recorded as a follow-up rather than
  // shipped here.
  const inserted = context.projectDb.transaction((tx) => {
    if (hasSkipReceiptsForAction(input.ticketId, input.actionId)) return []
    return receipts.map((receipt) => tx
    .insert(phaseArtifacts)
    .values({
      ticketId: context.localTicketId,
      phase: input.phase,
      phaseAttempt,
      artifactType,
      content: JSON.stringify(skipReceiptSchema.parse(receipt)),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get())
  })
  if (inserted.length === 0) return []

  // One broadcast per action, after the transaction commits. Never inside it: a
  // subscriber that refetched mid-write would see a half-recorded bulk skip.
  // Never one per row either — a forty-question Skip All would fire forty
  // artifact refetches for a single decision.
  const lastInserted = inserted[inserted.length - 1]
  if (lastInserted) {
    broadcaster.broadcast(input.ticketId, 'artifact_change', {
      ticketId: input.ticketId,
      phase: input.phase,
      artifactType,
      artifact: toArtifactManifestEntry(input.ticketId, lastInserted),
    })
  }

  return receipts
}

/**
 * Removes the receipts written by one action.
 *
 * The trail is append-only for decisions that happened. A batch whose
 * background processing failed is rolled back to the previous snapshot, so its
 * skips did not happen: leaving the receipts behind would report a skip the
 * ticket does not have, and the operator's retry with different answers would
 * never contradict it.
 */
export function deleteSkipReceiptsForAction(ticketRef: string, actionId: string): number {
  const context = getTicketContext(ticketRef)
  if (!context) return 0
  const doomed = readSkipReceiptRows(ticketRef).filter((row) => (
    SKIP_RECEIPT_ARTIFACT_TYPES.includes(row.artifactType)
    && parseStoredReceipt(row.content)?.action_id === actionId
  ))
  if (doomed.length === 0) return 0

  context.projectDb.transaction((tx) => {
    for (const row of doomed) {
      tx.delete(phaseArtifacts).where(eq(phaseArtifacts.id, row.id)).run()
    }
  })
  return doomed.length
}

/**
 * One phase-log line per receipt.
 *
 * The log export is plain text, so a 20,000-character multiline reason would
 * break its format outright — and the export is deleted by `deleteLog`, which
 * makes it the wrong home for the record anyway. The line carries a short
 * summary and the receipt id, so the full reason is always one lookup away.
 */
export function formatSkipReceiptLogLines(receipts: SkipReceipt[]): string[] {
  return receipts.map((receipt) => {
    if (receipt.resolves) {
      return `No longer skipped: ${describeSkipSurface(receipt.surface)} ${receipt.item_id ?? ''}`.trimEnd()
    }
    const what = receipt.is_action_summary
      ? describeSkipSurface(receipt.surface)
      : [describeSkipSurface(receipt.surface), receipt.item_id].filter(Boolean).join(' ')
    const { text } = truncateSkipReason(receipt.reason, SKIP_REASON_LOG_MAX_LENGTH)
    const reason = text ? text.replace(/\s*\n\s*/g, ' ⏎ ') : 'no reason given'
    return `Skipped: ${what} — ${reason} [${receipt.receipt_id}]`
  })
}

function toSkipEvent(receipt: SkipReceipt): SkipEvent {
  return {
    receiptId: receipt.receipt_id,
    actionId: receipt.action_id,
    parentActionId: receipt.parent_action_id,
    surface: receipt.surface,
    itemId: receipt.item_id,
    itemType: receipt.item_type,
    isActionSummary: receipt.is_action_summary,
    resolves: receipt.resolves,
    phase: receipt.phase,
    phaseAttempt: receipt.phase_attempt,
    ticketStatusBefore: receipt.ticket_status_before,
    truncatedForPrompt: receipt.truncated_for_prompt,
    skippedAt: receipt.skipped_at,
    // A v1 row has no actor field. It was written when a person was the only
    // thing that could skip, so `user` is what it meant, not a guess.
    skippedBy: receipt.skipped_by ?? 'user',
    reason: receipt.reason,
    supersedes: receipt.supersedes,
    superseded: false,
    ...(receipt.question_context ? { questionContext: receipt.question_context } : {}),
  }
}

function parseStoredReceipt(content: string): SkipReceipt | null {
  try {
    const parsed = skipReceiptSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data as SkipReceipt : null
  } catch {
    return null
  }
}

/**
 * Read-side adapter for Manual QA.
 *
 * Manual QA already writes five records for one skip. Rather than add a sixth,
 * its existing artifacts are projected into the shared shape here. The canonical
 * `skip-receipt.yaml` and `events.jsonl` stay exactly as they are — they are its
 * crash-recovery contract, not an audit surface.
 */
function adaptManualQaArtifact(row: {
  id: number
  phase: string
  phaseAttempt: number
  artifactType: string
  content: string
}): SkipEvent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.content)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const record = parsed as Record<string, unknown>

  if (row.artifactType === MANUAL_QA_SKIP_RECEIPT_ARTIFACT) {
    const actionId = typeof record.actionId === 'string' ? record.actionId : null
    if (!actionId) return []
    return [{
      receiptId: buildReceiptId(actionId, null),
      actionId,
      parentActionId: null,
      surface: 'manual_qa',
      itemId: null,
      itemType: 'manual_qa_round',
      isActionSummary: false,
      resolves: false,
      phase: row.phase,
      phaseAttempt: row.phaseAttempt,
      ticketStatusBefore: row.phase,
      truncatedForPrompt: false,
      skippedAt: typeof record.createdAt === 'string' ? record.createdAt : '',
      skippedBy: 'user',
      reason: normalizeSkipReason(typeof record.reason === 'string' ? record.reason : null),
      supersedes: null,
      superseded: false,
    }]
  }

  // Per-item waivers already carry an optional reason. Surface them through the
  // same read API rather than opening a second channel for the same fact.
  const waivedItems = Array.isArray(record.waivedItems) ? record.waivedItems : []
  const actionId = typeof record.idempotencyKey === 'string'
    ? record.idempotencyKey
    : `manual-qa-summary-v${String(record.version ?? '1')}`
  const completedAt = typeof record.completedAt === 'string' ? record.completedAt : ''
  return waivedItems.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const waived = item as Record<string, unknown>
    const itemId = typeof waived.itemId === 'string' ? waived.itemId : null
    if (!itemId) return []
    return [{
      receiptId: buildReceiptId(actionId, itemId),
      actionId,
      parentActionId: null,
      surface: 'manual_qa_item' as const,
      itemId,
      itemType: 'manual_qa_item' as const,
      isActionSummary: false,
      resolves: false,
      ticketStatusBefore: row.phase,
      truncatedForPrompt: false,
      phase: row.phase,
      phaseAttempt: row.phaseAttempt,
      skippedAt: completedAt,
      skippedBy: 'user' as const,
      reason: normalizeSkipReason(typeof waived.reason === 'string' ? waived.reason : null),
      supersedes: null,
      superseded: false,
    }]
  })
}

export interface ListSkipEventsOptions {
  /**
   * Restrict to one phase. Omit for the whole ticket, every attempt.
   *
   * A read filter, matched against the phase as stored, so it stays `string`:
   * the audit view can legitimately be asked about a status that no longer
   * exists, and the honest answer is an empty list rather than a rejection.
   */
  phase?: string
  /**
   * Restrict to one attempt. Omitted by design for the audit view: a receipt
   * from an archived attempt is still what happened.
   */
  phaseAttempt?: number
  surfaces?: SkipSurface[]
  /** Drop events a later action on the same item replaced. */
  activeOnly?: boolean
}

/**
 * Every skip recorded for a ticket, oldest first, across all phase attempts.
 *
 * Deliberately not attempt-filtered: `selectVisibleArtifacts` hides archived
 * attempts, which is right for artifacts a phase is working from and wrong for
 * an audit trail.
 */
export function listSkipEvents(ticketRef: string, options?: ListSkipEventsOptions): SkipEvent[] {
  const events: SkipEvent[] = []
  for (const row of readSkipReceiptRows(ticketRef)) {
    if (options?.phase && row.phase !== options.phase) continue
    if (options?.phaseAttempt != null && row.phaseAttempt !== options.phaseAttempt) continue

    if (row.artifactType === MANUAL_QA_SKIP_RECEIPT_ARTIFACT || row.artifactType === MANUAL_QA_SUMMARY_ARTIFACT) {
      events.push(...adaptManualQaArtifact(row))
      continue
    }
    const receipt = parseStoredReceipt(row.content)
    if (receipt) events.push(toSkipEvent(receipt))
  }

  // Manual QA replays its own artifacts during recovery, so the same action can
  // appear twice with identical content. Collapse on receipt id, keeping the
  // first occurrence and its ordering.
  const seen = new Set<string>()
  const deduped = events.filter((event) => {
    const key = `${event.receiptId}:${event.itemId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Keyed by item *type*, not surface: an interview question skipped while
  // answering and skipped again at approval is the same item deciding twice, but
  // a Manual QA check that happens to share an id is not.
  const latestByItem = new Map<string, string>()
  for (const event of deduped) {
    if (event.itemId === null) continue
    latestByItem.set(`${event.itemType}:${event.itemId}`, event.receiptId)
  }
  for (const event of deduped) {
    if (event.itemId === null) continue
    event.superseded = latestByItem.get(`${event.itemType}:${event.itemId}`) !== event.receiptId
  }

  const filtered = options?.surfaces
    ? deduped.filter((event) => options.surfaces!.includes(event.surface))
    : deduped
  return options?.activeOnly ? filtered.filter((event) => !event.superseded) : filtered
}

/**
 * The reason currently in force for each item, keyed by `itemType:itemId`.
 *
 * Keyed the same way `superseded` is computed. Keying on the bare item id would
 * let a Manual QA check called `Q01` and an interview question called `Q01`
 * overwrite one another.
 *
 * Whether an item is skipped is the domain artifact's answer, never the
 * receipt's — pass `itemIds` and a reason left behind by an item that has since
 * been answered cannot re-attach itself. A resolution receipt also removes the
 * entry, so the two agree even when the caller passes nothing.
 */
export function getActiveSkipReasons(
  ticketRef: string,
  options?: ListSkipEventsOptions & { itemIds?: string[] },
): Map<string, string | null> {
  const allowed = options?.itemIds ? new Set(options.itemIds) : null
  const reasons = new Map<string, string | null>()
  for (const event of listSkipEvents(ticketRef, { ...options, activeOnly: true })) {
    if (event.itemId === null) continue
    if (allowed && !allowed.has(event.itemId)) continue
    const key = `${event.itemType}:${event.itemId}`
    if (event.resolves) {
      reasons.delete(key)
      continue
    }
    reasons.set(key, event.reason)
  }
  return reasons
}
