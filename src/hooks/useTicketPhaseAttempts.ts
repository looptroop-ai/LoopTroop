import { useQuery } from '@tanstack/react-query'
import { apiTicketPath } from '@/lib/apiPaths'
import { throwIfNotOk } from '@/lib/fetchError'
import { isRecord } from '@shared/typeGuards'

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
  return payload
    .map(normalizePhaseAttempt)
    .filter((attempt): attempt is TicketPhaseAttempt => attempt !== null)
}

/**
 * One attempt record, or `null` when it cannot drive a selector.
 *
 * `attemptNumber` is what the version selector is keyed on and what scopes
 * artifacts and logs, and `state` decides whether an attempt reads as archived.
 * Casting the array element let a record with either of those missing pick the
 * wrong version silently, so a malformed entry is dropped instead.
 */
function normalizePhaseAttempt(value: unknown): TicketPhaseAttempt | null {
  if (!isRecord(value)) return null
  const { ticketId, phase, attemptNumber, state } = value
  if (typeof ticketId !== 'string' || typeof phase !== 'string') return null
  if (typeof attemptNumber !== 'number' || !Number.isInteger(attemptNumber) || attemptNumber < 1) return null
  if (state !== 'active' && state !== 'archived') return null

  return {
    ticketId,
    phase,
    attemptNumber,
    state,
    archivedReason: typeof value.archivedReason === 'string' ? value.archivedReason : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    archivedAt: typeof value.archivedAt === 'string' ? value.archivedAt : null,
  }
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
