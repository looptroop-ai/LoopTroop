import type { QueryClient } from '@tanstack/react-query'

interface TicketStatusRecord {
  id: string
  status: string
  previousStatus?: string | null
}

interface TicketRecord {
  id: string
}

export function patchTicketStatus<T extends TicketStatusRecord>(
  ticket: T,
  ticketId: string,
  status: string,
  previousStatus?: string | null,
): T {
  if (ticket.id !== ticketId) return ticket
  if (ticket.status === status && ticket.previousStatus === previousStatus) return ticket
  return {
    ...ticket,
    status,
    ...(previousStatus !== undefined ? { previousStatus } : {}),
  }
}

export function mergeTicket<T extends TicketRecord>(
  ticket: T,
  incomingTicket: Partial<T> & TicketRecord,
): T {
  if (ticket.id !== incomingTicket.id) return ticket
  return { ...ticket, ...incomingTicket }
}

/**
 * Merges a server ticket over the cached one, and only over a cached one.
 *
 * The incoming payload is a *patch*: it has been through the normaliser, which
 * deliberately leaves out fields the response did not carry rather than filling
 * them with defaults. Seeding an absent entry from it would therefore install a
 * half-ticket; every caller invalidates `['ticket', id]` immediately after, so an
 * entry that is not there yet is fetched whole instead.
 */
export function mergeTicketInCache<T extends TicketRecord>(
  queryClient: QueryClient,
  incomingTicket: Partial<T> & TicketRecord,
) {
  queryClient.setQueryData<T | undefined>(['ticket', incomingTicket.id], (ticket) =>
    ticket ? mergeTicket(ticket, incomingTicket) : ticket,
  )

  queryClient.setQueriesData<T[]>({ queryKey: ['tickets'] }, (tickets) => {
    if (!tickets) return tickets

    let changed = false
    const nextTickets = tickets.map((ticket) => {
      const nextTicket = mergeTicket(ticket, incomingTicket)
      if (nextTicket !== ticket) changed = true
      return nextTicket
    })

    return changed ? nextTickets : tickets
  })
}

export function patchTicketStatusInCache<T extends TicketStatusRecord>(
  queryClient: QueryClient,
  ticketId: string,
  status: string,
  previousStatus?: string | null,
) {
  queryClient.setQueryData<T | undefined>(['ticket', ticketId], (ticket) =>
    ticket ? patchTicketStatus(ticket, ticketId, status, previousStatus) : ticket,
  )

  queryClient.setQueriesData<T[]>({ queryKey: ['tickets'] }, (tickets) => {
    if (!tickets) return tickets

    let changed = false
    const nextTickets = tickets.map((ticket) => {
      const nextTicket = patchTicketStatus(ticket, ticketId, status, previousStatus)
      if (nextTicket !== ticket) changed = true
      return nextTicket
    })

    return changed ? nextTickets : tickets
  })
}
