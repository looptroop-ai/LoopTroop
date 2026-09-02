import { useQueries, useQuery } from '@tanstack/react-query'
import { throwIfNotOk } from '@/lib/fetchError'
import { apiTicketPath } from '@/lib/apiPaths'
import { queryClient } from '@/lib/queryClient'

export interface DBartifact {
  id: number
  ticketId: string
  phase: string
  phaseAttempt: number
  artifactType: string
  filePath: string | null
  content: string | null
  createdAt: string
  updatedAt: string
}

export interface TicketArtifactQueryScope {
  phase?: string
  phaseAttempt?: number
}

export interface TicketArtifactCollectionState {
  artifacts: DBartifact[] | undefined
  status: 'idle' | 'loading' | 'success' | 'error'
  isLoading: boolean
  isFetching: boolean
  isError: boolean
  error: unknown
  refetch: () => Promise<unknown>
}

export function normalizeTicketArtifact(input: unknown, fallbackTicketId?: string): DBartifact | null {
  if (!input || typeof input !== 'object') return null

  const raw = input as Record<string, unknown>
  const id = typeof raw.id === 'number' ? raw.id : Number(raw.id)
  if (!Number.isFinite(id)) return null

  const phase = typeof raw.phase === 'string' ? raw.phase : null
  const phaseAttempt = typeof raw.phaseAttempt === 'number' && Number.isFinite(raw.phaseAttempt)
    ? raw.phaseAttempt
    : (() => {
        const parsed = Number(raw.phaseAttempt)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
      })()
  const artifactType = typeof raw.artifactType === 'string'
    ? raw.artifactType
    : raw.artifactType == null
      ? ''
      : null
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : null
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt
  if (!phase || !Number.isFinite(phaseAttempt) || phaseAttempt <= 0 || artifactType === null || !createdAt || !updatedAt) return null

  const ticketId = typeof raw.ticketId === 'string'
    ? raw.ticketId
    : fallbackTicketId ?? (raw.ticketId != null ? String(raw.ticketId) : '')

  return {
    id,
    ticketId,
    phase,
    phaseAttempt,
    artifactType,
    filePath: typeof raw.filePath === 'string' ? raw.filePath : null,
    content: typeof raw.content === 'string' ? raw.content : null,
    createdAt,
    updatedAt,
  }
}

export async function fetchTicketArtifacts(
  ticketId: string,
  options?: TicketArtifactQueryScope,
  signal?: AbortSignal,
): Promise<DBartifact[]> {
  const params = new URLSearchParams()
  if (options?.phase) params.set('phase', options.phase)
  if (typeof options?.phaseAttempt === 'number' && Number.isFinite(options.phaseAttempt) && options.phaseAttempt > 0) {
    params.set('phaseAttempt', String(options.phaseAttempt))
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  const res = await fetch(`${apiTicketPath(ticketId, 'artifacts')}${suffix}`, { signal })
  await throwIfNotOk(res, 'Failed to load ticket artifacts')

  const payload: unknown = await res.json()
  if (!Array.isArray(payload)) throw new Error('Failed to load ticket artifacts: invalid response')

  return payload.map((artifact) => {
    const normalized = normalizeTicketArtifact(artifact, ticketId)
    if (!normalized) throw new Error('Failed to load ticket artifacts: invalid artifact record')
    return normalized
  })
}

export function getTicketArtifactsQueryKey(ticketId: string, options?: TicketArtifactQueryScope) {
  return [
    'ticket-artifacts',
    ticketId,
    options?.phase ?? '__all__',
    typeof options?.phaseAttempt === 'number' && Number.isFinite(options.phaseAttempt) && options.phaseAttempt > 0
      ? options.phaseAttempt
      : 'active',
  ] as const
}

export function clearTicketArtifactsCache(ticketId: string) {
  queryClient.removeQueries({ queryKey: ['ticket-artifacts', ticketId] })
}

function queryStatus(
  enabled: boolean,
  isLoading: boolean,
  isError: boolean,
): TicketArtifactCollectionState['status'] {
  if (!enabled) return 'idle'
  if (isError) return 'error'
  if (isLoading) return 'loading'
  return 'success'
}

/** Fetches one exact artifact scope without erasing successful data during refreshes. */
export function useTicketArtifacts(
  ticketId?: string,
  opts?: TicketArtifactQueryScope & { skipFetch?: boolean },
): TicketArtifactCollectionState {
  const enabled = Boolean(ticketId && !opts?.skipFetch)
  const scope = { phase: opts?.phase, phaseAttempt: opts?.phaseAttempt }
  const query = useQuery({
    queryKey: ticketId
      ? getTicketArtifactsQueryKey(ticketId, scope)
      : ['ticket-artifacts', '__missing__'] as const,
    queryFn: ({ signal }) => fetchTicketArtifacts(ticketId!, scope, signal),
    enabled,
  })

  return {
    artifacts: enabled ? query.data : undefined,
    status: queryStatus(enabled, query.isLoading, query.isError),
    isLoading: enabled && query.isLoading,
    isFetching: enabled && query.isFetching,
    isError: enabled && query.isError,
    error: enabled ? query.error : null,
    refetch: query.refetch,
  }
}

function uniqueScopes(scopes: readonly TicketArtifactQueryScope[]): TicketArtifactQueryScope[] {
  const seen = new Set<string>()
  return scopes.filter((scope) => {
    const key = `${scope.phase ?? '__all__'}:${scope.phaseAttempt ?? 'active'}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Loads a phase and its explicitly declared dependencies as independently cached scopes. */
export function useTicketArtifactBundle(
  ticketId: string | undefined,
  requestedScopes: readonly TicketArtifactQueryScope[],
): TicketArtifactCollectionState {
  const scopes = uniqueScopes(requestedScopes)
  const enabled = Boolean(ticketId && scopes.length > 0)
  const queries = useQueries({
    queries: scopes.map((scope) => ({
      queryKey: ticketId
        ? getTicketArtifactsQueryKey(ticketId, scope)
        : ['ticket-artifacts', '__missing__', scope.phase ?? '__all__'] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchTicketArtifacts(ticketId!, scope, signal),
      enabled,
    })),
  })

  const isLoading = enabled && queries.some((query) => query.isLoading)
  const isFetching = enabled && queries.some((query) => query.isFetching)
  const failedQuery = queries.find((query) => query.isError)
  const hasCompleteData = enabled && queries.every((query) => query.data !== undefined)
  const artifacts = hasCompleteData
    ? Array.from(new Map(queries.flatMap((query) => query.data ?? []).map((artifact) => [artifact.id, artifact])).values())
    : undefined

  return {
    artifacts,
    status: queryStatus(enabled, isLoading, Boolean(failedQuery)),
    isLoading,
    isFetching,
    isError: Boolean(failedQuery),
    error: failedQuery?.error ?? null,
    refetch: () => Promise.all(queries.map((query) => query.refetch())),
  }
}
