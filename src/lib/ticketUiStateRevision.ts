const revisions = new Map<string, number>()

function getRevisionKey(ticketId: string, scope: string): string {
  return `${ticketId}\u0000${scope}`
}

export function getTicketUiStateRevision(ticketId: string, scope: string): number {
  return revisions.get(getRevisionKey(ticketId, scope)) ?? 0
}

export function createTicketUiStateActionId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function rememberTicketUiStateRevision(ticketId: string, scope: string, revision: number | null | undefined): void {
  if (typeof revision !== 'number' || !Number.isFinite(revision)) return
  const key = getRevisionKey(ticketId, scope)
  revisions.set(key, Math.max(revisions.get(key) ?? 0, revision))
}

/**
 * Forgets every scope's revision for one ticket.
 *
 * This map only ever climbs — `Math.max` is what stops a stale read lowering a
 * revision a save has already moved past. That makes it wrong to carry across
 * identities: a ticket id can be issued again, and the new ticket starts at
 * revision 0 while this still remembers 4, so its first autosave claims to be
 * replacing a revision that never existed and the server refuses it as a
 * conflict. Deletion is the one moment the identity is known to be gone.
 */
export function clearTicketUiStateRevisions(ticketId: string): void {
  const prefix = getRevisionKey(ticketId, '')
  for (const key of revisions.keys()) {
    if (key.startsWith(prefix)) revisions.delete(key)
  }
}
