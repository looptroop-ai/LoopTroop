import { useQuery } from '@tanstack/react-query'
import { apiTicketPath } from '@/lib/apiPaths'
import { throwIfNotOk } from '@/lib/fetchError'

export interface TicketPhaseAttempt {
  ticketId: string
  phase: string
  attemptNumber: number
  state: 'active' | 'archived'
  archivedReason: string | null
  createdAt: string
  archivedAt: string | null
}

async function fetchTicketPhaseAttempts(
  ticketId: string,
  phase: string,
  signal?: AbortSignal,
): Promise<TicketPhaseAttempt[]> {
  const response = await fetch(apiTicketPath(ticketId, 'phases', phase, 'attempts'), { signal })
  await throwIfNotOk(response, 'Unable to load phase attempts')
  const payload: unknown = await response.json()
  // An empty array is a real answer: a phase that has run once has no archived
  // attempts. Anything that is not an array is the endpoint answering something
  // else, and reading that as "no attempts" shows one attempt where there are four.
  if (!Array.isArray(payload)) throw new Error('Unable to load phase attempts: invalid response')
  return payload as TicketPhaseAttempt[]
}

export function getTicketPhaseAttemptsQueryKey(ticketId: string, phase: string) {
  return ['ticket-phase-attempts', ticketId, phase] as const
}

export function useTicketPhaseAttempts(ticketId?: string, phase?: string) {
  return useQuery({
    queryKey: ticketId && phase
      ? getTicketPhaseAttemptsQueryKey(ticketId, phase)
      : ['ticket-phase-attempts', '__missing__'] as const,
    queryFn: ({ signal }) => fetchTicketPhaseAttempts(ticketId!, phase!, signal),
    enabled: Boolean(ticketId && phase),
  })
}
