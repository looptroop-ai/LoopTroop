import { resolveKanbanPhase } from '@shared/kanbanPhase'

/**
 * Acknowledgment store for the "Needs Input" kanban column.
 *
 * Mirrors `errorTicketSeen.ts` but covers every wait that lands a ticket in
 * `kanbanPhase === 'needs_input'` — the statuses that mean it (interview
 * answers, approvals, PR review) and a model's pending question on a ticket
 * that is otherwise still working. `BLOCKED_ERROR` is intentionally excluded —
 * it keeps its own red error-flashing acknowledgment.
 *
 * When a ticket enters a needs-input wait, its dashboard card flashes. The
 * moment the user opens the ticket, the flashing stops and the border reverts
 * to the static project color, even if the required action was not performed.
 * A *new* wait (different status, re-entry with a fresh `updatedAt`, or a new
 * question) produces a new signature and flashes again.
 */

const seenNeedsInputTickets = new Map<string, string>()

interface NeedsInputTicketSnapshot {
  id: string
  status: string
  updatedAt: string
  pendingQuestions?: { requestCount: number; requestIds?: string[] } | null
}

function getNeedsInputSeenStorageKey(ticketId: string): string {
  return `needs-input-seen-${ticketId}`
}

/**
 * Returns a stable signature for the current needs-input wait, or `null` when
 * the ticket is not waiting on the user (or when it is in `BLOCKED_ERROR`,
 * which is owned by the error-attention store).
 *
 * Reason tokens = `updatedAt` plus the number of models asking. WAITING_*
 * states are paused, so `updatedAt` only advances when the wait reason
 * genuinely changes (e.g. PRD approval → beads approval) or on re-entry, which
 * is exactly when we want to re-flash. The question token is the sorted request
 * ids rather than their count: one question being answered and another arriving
 * leaves the count identical, and `updatedAt` does not move either, so a count
 * would have said nothing changed when the thing being waited on had been
 * replaced outright. It deliberately is *not* `deadlineAt`: every model that joins the
 * step resets the shared clock, and keying on that would re-alert the card on
 * every reset rather than on a genuinely new question.
 *
 * The question token is always in the signature, so a wait that changes kind —
 * an interview wait that a model then interrupts with a question — reads as a
 * new wait instead of inheriting the old acknowledgment.
 */
export function getNeedsInputSignature(ticket: NeedsInputTicketSnapshot): string | null {
  if (ticket.status === 'BLOCKED_ERROR') return null
  const pending = ticket.pendingQuestions
  const pendingRequestCount = pending?.requestCount ?? 0
  const phase = resolveKanbanPhase(ticket.status, { hasPendingQuestion: pendingRequestCount > 0 })
  if (phase !== 'needs_input') return null
  // Sorted by code unit, not by locale: this string is compared for equality
  // against one the browser stored earlier, so the ordering has to be identical
  // every time it is computed — which is the one thing `localeCompare` does not
  // promise. The server sorts the same way before sending them.
  const questionToken = pending?.requestIds?.length
    ? [...pending.requestIds].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)).join(',')
    : String(pendingRequestCount)
  return `${ticket.status}|${ticket.updatedAt}|${questionToken}`
}

export function readNeedsInputSeen(
  ticketId: string,
  signature: string | null,
  persistedSignature?: string | null,
): boolean {
  if (!signature) return false
  if (seenNeedsInputTickets.get(ticketId) === signature) return true
  if (persistedSignature === signature) {
    seenNeedsInputTickets.set(ticketId, signature)
    return true
  }
  if (typeof window === 'undefined') return false
  try {
    const stored = localStorage.getItem(getNeedsInputSeenStorageKey(ticketId))
    // Compared against this exact signature and nothing else. A bare '1' used to
    // count as "seen" for *any* signature, so a recycled `projectId:SHORT-n` id
    // inherited the previous ticket's acknowledgment and never flashed again.
    // Nothing writes '1' any more.
    const seen = stored === signature
    if (seen) seenNeedsInputTickets.set(ticketId, signature)
    return seen
  } catch {
    return false
  }
}

export function markNeedsInputSeen(ticketId: string, signature: string | null): void {
  if (!signature) return
  seenNeedsInputTickets.set(ticketId, signature)
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(getNeedsInputSeenStorageKey(ticketId), signature)
  } catch {
    // Storage failures should not block ticket navigation.
  }
}

export function clearNeedsInputSeen(ticketId: string): void {
  seenNeedsInputTickets.delete(ticketId)
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(getNeedsInputSeenStorageKey(ticketId))
  } catch {
    // Ignore storage cleanup failures.
  }
}
