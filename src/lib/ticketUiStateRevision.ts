const revisions = new Map<string, number>()
let nextTicketUiStateActionId = 0

function getRevisionKey(ticketId: string, scope: string): string {
  return `${ticketId}\u0000${scope}`
}

export function getTicketUiStateRevision(ticketId: string, scope: string): number {
  return revisions.get(getRevisionKey(ticketId, scope)) ?? 0
}

export function createTicketUiStateActionId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `ticket-ui-${++nextTicketUiStateActionId}`
}

export function rememberTicketUiStateRevision(ticketId: string, scope: string, revision: number | null | undefined): void {
  if (typeof revision !== 'number' || !Number.isFinite(revision)) return
  const key = getRevisionKey(ticketId, scope)
  revisions.set(key, Math.max(revisions.get(key) ?? 0, revision))
}
