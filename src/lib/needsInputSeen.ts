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
  pendingQuestions?: { requestCount: number } | null
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
 * is exactly when we want to re-flash. The question token is a count rather
 * than the request ids, which the DTO does not expose — the count moves
 * whenever the set of open requests does, which is the same signal for this
 * purpose. It deliberately is *not* `deadlineAt`: every model that joins the
 * step resets the shared clock, and keying on that would re-alert the card on
 * every reset rather than on a genuinely new question.
 *
 * The count is always in the signature, so a wait that changes kind — an
 * interview wait that a model then interrupts with a question — reads as a new
 * wait instead of inheriting the old acknowledgment.
 */
export function getNeedsInputSignature(ticket: NeedsInputTicketSnapshot): string | null {
  if (ticket.status === 'BLOCKED_ERROR') return null
  const pendingRequestCount = ticket.pendingQuestions?.requestCount ?? 0
  const phase = resolveKanbanPhase(ticket.status, { hasPendingQuestion: pendingRequestCount > 0 })
  if (phase !== 'needs_input') return null
  return `${ticket.status}|${ticket.updatedAt}|${pendingRequestCount}`
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
    const seen = stored === signature || stored === '1'
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
