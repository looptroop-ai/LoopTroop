/**
 * Which tickets have already rendered with data in this tab.
 *
 * `useRecoveryAutoReload` uses this to tell a ticket that is still loading for the first time from
 * one that rendered and then lost its data — only the second is a recovery episode worth reloading
 * for. The record therefore has to outlive a single dashboard mount: `App` keys `TicketDashboard`
 * by ticket id, so component state here would be recreated empty on every switch, and returning to
 * a ticket whose query data had been dropped would look like a first load and never arm the reload.
 *
 * Module scope for the lifetime of the tab. Ticket ids only, so nothing here is worth persisting.
 */
const renderedTicketIds = new Set<string>()
const LAST_EVENT_ID_STORAGE_PREFIX = 'looptroop-sse-last-event-id:'
const AI_QUESTIONS_COLLAPSED_STORAGE_PREFIX = 'ai-questions-collapsed-'
export const TICKET_STATE_CLEARED_EVENT = 'looptroop:ticket-state-cleared'
const ticketSseCursorGenerations = new Map<string, number>()

export function markTicketRendered(ticketId: string): void {
  renderedTicketIds.add(ticketId)
}

export function hasTicketRendered(ticketId: string): boolean {
  return renderedTicketIds.has(ticketId)
}

export function clearTicketRendered(ticketId: string): void {
  renderedTicketIds.delete(ticketId)
}

export function getTicketSseLastEventIdStorageKey(ticketId: string): string {
  return `${LAST_EVENT_ID_STORAGE_PREFIX}${ticketId}`
}

export function getTicketQuestionsCollapsedStorageKey(ticketId: string): string {
  return `${AI_QUESTIONS_COLLAPSED_STORAGE_PREFIX}${ticketId}`
}

export function getTicketSseCursorGeneration(ticketId: string): number {
  return ticketSseCursorGenerations.get(ticketId) ?? 0
}

export function clearTicketPersistentState(ticketId: string): void {
  clearTicketRendered(ticketId)
  ticketSseCursorGenerations.set(ticketId, getTicketSseCursorGeneration(ticketId) + 1)
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(getTicketSseLastEventIdStorageKey(ticketId))
      window.localStorage.removeItem(getTicketQuestionsCollapsedStorageKey(ticketId))
    } catch {
      // Storage failures should not block deletion cleanup.
    }
    window.dispatchEvent(new CustomEvent(TICKET_STATE_CLEARED_EVENT, { detail: { ticketId } }))
  }
}

export const __renderedTicketsForTests = {
  reset() {
    renderedTicketIds.clear()
    ticketSseCursorGenerations.clear()
  },
}
