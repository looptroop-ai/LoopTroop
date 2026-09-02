import { getActiveErrorOccurrence, type TicketErrorOccurrence } from './errorOccurrences'

const seenErrorTickets = new Map<string, string>()

/**
 * What a signature is built from. Every caller passes a ticket out of the query
 * cache, which the boundary normaliser has already been through — hence a
 * `string` occurrence id here rather than the `string | number` that used to
 * absorb the wire's numeric form.
 */
interface ErrorTicketSnapshot {
  id: string
  status: string
  updatedAt: string
  errorMessage?: string | null | undefined
  activeErrorOccurrenceId?: string | null
  errorOccurrences?: TicketErrorOccurrence[]
  previousStatus?: string | null
}

function getErrorSeenStorageKey(ticketId: string): string {
  return `error-seen-${ticketId}`
}

export function getErrorTicketSignature(ticket: ErrorTicketSnapshot): string | null {
  if (ticket.status !== 'BLOCKED_ERROR') return null
  const activeOccurrence = getActiveErrorOccurrence({
    ...ticket,
    errorMessage: ticket.errorMessage ?? null,
    errorOccurrences: ticket.errorOccurrences ?? [],
    activeErrorOccurrenceId: ticket.activeErrorOccurrenceId ?? null,
  })
  if (activeOccurrence) {
    return [
      ticket.status,
      activeOccurrence.id,
      activeOccurrence.occurredAt,
      activeOccurrence.errorMessage ?? '',
    ].join('|')
  }
  return [ticket.status, ticket.updatedAt, ticket.errorMessage ?? ''].join('|')
}

export function readErrorTicketSeen(
  ticketId: string,
  errorSignature: string | null,
  persistedSignature?: string | null,
): boolean {
  if (!errorSignature) return false
  if (seenErrorTickets.get(ticketId) === errorSignature) return true
  if (persistedSignature === errorSignature) {
    seenErrorTickets.set(ticketId, errorSignature)
    return true
  }
  if (typeof window === 'undefined') return false
  try {
    const stored = localStorage.getItem(getErrorSeenStorageKey(ticketId))
    // Compared against this exact signature and nothing else. A bare '1' used to
    // count as "seen" for *any* signature, so a recycled `projectId:SHORT-n` id
    // inherited the previous ticket's acknowledgment and never flashed again.
    // Nothing writes '1' any more.
    const seen = stored === errorSignature
    if (seen) seenErrorTickets.set(ticketId, errorSignature)
    return seen
  } catch {
    return false
  }
}

export function markErrorTicketSeen(ticketId: string, errorSignature: string | null): void {
  if (!errorSignature) return
  seenErrorTickets.set(ticketId, errorSignature)
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(getErrorSeenStorageKey(ticketId), errorSignature)
  } catch {
    // Storage failures should not block ticket navigation.
  }
}

export function clearErrorTicketSeen(ticketId: string): void {
  seenErrorTickets.delete(ticketId)
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(getErrorSeenStorageKey(ticketId))
  } catch {
    // Ignore storage cleanup failures.
  }
}
