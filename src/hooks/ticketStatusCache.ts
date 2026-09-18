import type { QueryClient } from '@tanstack/react-query'
import { isRecord } from '@shared/typeGuards'

interface TicketStatusRecord {
  id: string
  status: string
  previousStatus?: string | null
}

interface TicketRecord {
  id: string
  runtime?: unknown
  implementationTiming?: unknown
  pendingQuestions?: unknown
  manualQa?: unknown
}

/**
 * A server ticket on its way into the cache.
 *
 * Every key is optional except the id, and `runtime` is loosened on purpose: a
 * patch carries only the runtime fields the response actually had, and merging
 * it is what keeps the rest of the cached runtime alive.
 */
type IncomingTicket<T extends TicketRecord> =
  Partial<Omit<T, 'runtime' | 'implementationTiming' | 'pendingQuestions' | 'manualQa'>> & TicketRecord & {
    runtime?: Record<string, unknown>
    implementationTiming?: Record<string, unknown>
    pendingQuestions?: Record<string, unknown> | null
    manualQa?: Record<string, unknown> | null
  }

function patchTicketStatus<T extends TicketStatusRecord>(
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

function mergeTicket<T extends TicketRecord>(
  ticket: T,
  incomingTicket: IncomingTicket<T>,
): T {
  if (ticket.id !== incomingTicket.id) return ticket

  const merged = { ...ticket, ...incomingTicket }
  const mergePatchValue = (cached: unknown, incoming: unknown): unknown => {
    if (!isRecord(cached) || !isRecord(incoming)) return incoming
    const next: Record<string, unknown> = { ...cached }
    for (const [key, value] of Object.entries(incoming)) {
      next[key] = Object.hasOwn(cached, key)
        ? mergePatchValue(cached[key], value)
        : value
    }
    return next
  }
  for (const key of ['runtime', 'implementationTiming', 'pendingQuestions', 'manualQa'] as const) {
    const incomingValue = incomingTicket[key]
    if (incomingValue === undefined) continue
    const cachedValue = ticket[key]
    ;(merged as Record<string, unknown>)[key] = mergePatchValue(cachedValue, incomingValue)
  }
  return merged as T
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
  incomingTicket: IncomingTicket<T>,
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
