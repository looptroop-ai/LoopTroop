import { useQuery } from '@tanstack/react-query'
import type { SkipEvent, SkipEventCounts } from '@shared/skipReceipt'

export interface TicketSkips {
  ticketId: string
  events: SkipEvent[]
  counts: SkipEventCounts
}

export function getTicketSkipsQueryKey(ticketId: string) {
  return ['ticket-skips', ticketId] as const
}

async function fetchTicketSkips(ticketId: string, signal?: AbortSignal): Promise<TicketSkips> {
  const response = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/skips`, { signal })
  if (!response.ok) throw new Error(`Unable to load skips (${response.status})`)
  return response.json() as Promise<TicketSkips>
}

export function useTicketSkips(ticketId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ticketId ? getTicketSkipsQueryKey(ticketId) : ['ticket-skips', '__missing__'] as const,
    queryFn: ({ signal }) => fetchTicketSkips(ticketId!, signal),
    enabled: Boolean(ticketId) && enabled,
    staleTime: 30_000,
  })
}
