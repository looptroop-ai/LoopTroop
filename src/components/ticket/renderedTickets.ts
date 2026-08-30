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

export function markTicketRendered(ticketId: string): void {
  renderedTicketIds.add(ticketId)
}

export function hasTicketRendered(ticketId: string): boolean {
  return renderedTicketIds.has(ticketId)
}

export const __renderedTicketsForTests = {
  reset() {
    renderedTicketIds.clear()
  },
}
