import { useQuery } from '@tanstack/react-query'

export type TicketAiDetailsScope = 'phase' | 'lifecycle'

export interface TicketAiDetailsRequest {
  scope: TicketAiDetailsScope
  phase?: string
  phaseAttempt?: number
  modelId?: string
}

export interface TicketAiDetailsSummary {
  turns: number
  sessions: number
  costUsd: number | null
  tokens: {
    total: number | null
    input: number | null
    output: number | null
    reasoning: number | null
    cacheRead: number | null
    cacheWrite: number | null
  }
  timingMs: {
    total: number | null
    average: number | null
    longest: number | null
  }
  coverage: {
    costTurns: number
    tokenTurns: number
    timingTurns: number
  }
}

export interface TicketAiDetails {
  scope: TicketAiDetailsScope
  phase: string | null
  phaseAttempt: number | null
  modelId: string | null
  summary: TicketAiDetailsSummary
  updatedAt: string | null
}

export function getTicketAiDetailsQueryKey(ticketId: string, request?: TicketAiDetailsRequest) {
  if (!request) return ['ticket-ai-details', ticketId] as const
  return [
    'ticket-ai-details',
    ticketId,
    request.scope,
    request.phase ?? '',
    request.phaseAttempt ?? '',
    request.modelId ?? '',
  ] as const
}

function getTicketAiDetailsUrl(ticketId: string, request: TicketAiDetailsRequest): string {
  const params = new URLSearchParams({ scope: request.scope })
  if (request.phase) params.set('phase', request.phase)
  if (typeof request.phaseAttempt === 'number') params.set('phaseAttempt', String(request.phaseAttempt))
  if (request.modelId) params.set('modelId', request.modelId)
  return `/api/tickets/${encodeURIComponent(ticketId)}/ai-details?${params.toString()}`
}

async function fetchTicketAiDetails(
  ticketId: string,
  request: TicketAiDetailsRequest,
  signal?: AbortSignal,
): Promise<TicketAiDetails> {
  const response = await fetch(getTicketAiDetailsUrl(ticketId, request), { signal })
  if (!response.ok) throw new Error(`Unable to load AI details (${response.status})`)
  return response.json() as Promise<TicketAiDetails>
}

export function useTicketAiDetails(
  ticketId: string | undefined,
  request: TicketAiDetailsRequest,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ticketId
      ? getTicketAiDetailsQueryKey(ticketId, request)
      : ['ticket-ai-details', '__missing__'] as const,
    queryFn: ({ signal }) => fetchTicketAiDetails(ticketId!, request, signal),
    enabled: Boolean(ticketId) && enabled,
    staleTime: 30_000,
  })
}
