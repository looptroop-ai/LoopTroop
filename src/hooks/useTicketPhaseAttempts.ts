import { useQuery } from '@tanstack/react-query'
import { apiTicketPath } from '@/lib/apiPaths'

export interface TicketPhaseAttempt {
  ticketId: string
  phase: string
  attemptNumber: number
  state: 'active' | 'archived'
  archivedReason: string | null
  createdAt: string
  archivedAt: string | null
}

async function fetchTicketPhaseAttempts(ticketId: string, phase: string): Promise<TicketPhaseAttempt[]> {
  const response = await fetch(apiTicketPath(ticketId, 'phases', phase, 'attempts'))
  if (!response.ok) return []
  const payload = await response.json()
  return Array.isArray(payload) ? payload as TicketPhaseAttempt[] : []
}

export function getTicketPhaseAttemptsQueryKey(ticketId: string, phase: string) {
  return ['ticket-phase-attempts', ticketId, phase] as const
}

export function useTicketPhaseAttempts(ticketId?: string, phase?: string) {
  return useQuery({
    queryKey: ticketId && phase
      ? getTicketPhaseAttemptsQueryKey(ticketId, phase)
      : ['ticket-phase-attempts', '__missing__'] as const,
    queryFn: () => fetchTicketPhaseAttempts(ticketId!, phase!),
    enabled: Boolean(ticketId && phase),
  })
}
