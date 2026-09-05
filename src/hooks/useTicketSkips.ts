import { useQuery } from '@tanstack/react-query'
import type { SkipEvent, SkipEventCounts } from '@shared/skipReceipt'
import { throwIfNotOk } from '@/lib/fetchError'
import { apiTicketPath } from '@/lib/apiPaths'

export interface TicketSkips {
  ticketId: string
  events: SkipEvent[]
  counts: SkipEventCounts
}

// Exported so any module that needs to read or invalidate this cache names
// the key rather than repeating the literal — a second copy that drifts
// silently stops invalidating anything.
export function getTicketSkipsQueryKey(ticketId: string) {
  return ['ticket-skips', ticketId] as const
}

async function fetchTicketSkips(ticketId: string, signal?: AbortSignal): Promise<TicketSkips> {
  const response = await fetch(apiTicketPath(ticketId, 'skips'), { signal })
  await throwIfNotOk(response, 'Unable to load skips')
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
