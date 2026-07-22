import { useCallback, useEffect, useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { normalizeLogRecord, type LogEntry } from '@/context/logUtils'
import { SERVER_LOG_REFRESH_EVENT } from '@/context/logUtils'

export type HistoricalLogView = 'overview' | 'system' | 'command' | 'ai' | 'error' | 'debug'

export interface HistoricalLogScope {
  scope: 'phase' | 'lifecycle'
  phase?: string
  phaseAttempt?: number
  view: HistoricalLogView
  modelId?: string
}

interface HistoricalLogPage {
  entries: LogEntry[]
  olderCursor: string | null
  hasOlder: boolean
  /** Context for a delimiter that begins before this page. */
  boundary?: Record<string, unknown>
}

function getQuery(ticketId: string, scope: HistoricalLogScope, before?: string): string {
  const params = new URLSearchParams({
    scope: scope.scope,
    view: scope.view,
    limit: '250',
  })
  if (scope.phase) params.set('phase', scope.phase)
  if (typeof scope.phaseAttempt === 'number') params.set('phaseAttempt', String(scope.phaseAttempt))
  if (scope.modelId) params.set('modelId', scope.modelId)
  if (before) params.set('before', before)
  return `/api/tickets/${encodeURIComponent(ticketId)}/logs?${params.toString()}`
}

function normalizePage(payload: unknown, fallbackPhase?: string): HistoricalLogPage {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const records = Array.isArray(data.entries) ? data.entries : []
  return {
    entries: records
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map(entry => normalizeLogRecord(entry, fallbackPhase ?? String(entry.phase ?? entry.status ?? 'unknown'))),
    olderCursor: typeof data.olderCursor === 'string' ? data.olderCursor : null,
    hasOlder: data.hasOlder === true,
    boundary: data.boundary && typeof data.boundary === 'object' ? data.boundary as Record<string, unknown> : undefined,
  }
}

/**
 * Newest-first, cursor-paginated durable log history.  Live SSE rows are kept
 * outside this query; callers can overlay them by stable entry identity.
 */
export function useTicketHistoricalLogs(ticketId: string | undefined, scope: HistoricalLogScope, enabled = true) {
  const queryKey = useMemo(() => [
    'ticket-log-history', ticketId ?? '__missing__', scope.scope, scope.phase ?? '', scope.phaseAttempt ?? '', scope.view, scope.modelId ?? '',
  ], [scope.modelId, scope.phase, scope.phaseAttempt, scope.scope, scope.view, ticketId])

  const query = useInfiniteQuery({
    queryKey,
    enabled: Boolean(ticketId) && enabled,
    // React Query v5 requires a concrete initial parameter for an infinite
    // query; `null` represents the newest page and is omitted from the URL.
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const response = await fetch(getQuery(ticketId!, scope, pageParam ?? undefined), { signal })
      if (!response.ok) throw new Error(`Unable to load logs (${response.status})`)
      return normalizePage(await response.json(), scope.phase)
    },
    // History is only fetched toward older cursors via fetchPreviousPage.
    // React Query still requires this callback to calculate result metadata.
    getNextPageParam: () => undefined,
    getPreviousPageParam: firstPage => firstPage.hasOlder ? firstPage.olderCursor ?? undefined : undefined,
    staleTime: 30_000,
  })

  const entries = useMemo(() => {
    // Pages are stored newest -> oldest. Restore chronological order, then use
    // a Map so a canonical upsert/finalize never creates a duplicate row.
    const byId = new Map<string, LogEntry>()
    for (const page of [...(query.data?.pages ?? [])].reverse()) {
      for (const entry of page.entries) byId.set(entry.entryId, entry)
    }
    return [...byId.values()].sort((a, b) => {
      const aTime = a.timestamp ? Date.parse(a.timestamp) : Number.NaN
      const bTime = b.timestamp ? Date.parse(b.timestamp) : Number.NaN
      if (Number.isNaN(aTime) || Number.isNaN(bTime)) return 0
      return aTime - bTime
    })
  }, [query.data?.pages])
  const refetch = query.refetch

  const exportLogs = useCallback(async (signal?: AbortSignal): Promise<string> => {
    if (!ticketId) return ''
    const params = new URLSearchParams({ scope: scope.scope, view: scope.view })
    if (scope.phase) params.set('phase', scope.phase)
    if (typeof scope.phaseAttempt === 'number') params.set('phaseAttempt', String(scope.phaseAttempt))
    if (scope.modelId) params.set('modelId', scope.modelId)
    const response = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/logs/export?${params.toString()}`, { signal })
    if (!response.ok) throw new Error(`Unable to export logs (${response.status})`)
    return response.text()
  }, [scope, ticketId])

  useEffect(() => {
    if (!ticketId || !enabled) return
    const handleRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ ticketId?: string | null }>).detail
      if (String(detail?.ticketId ?? '') !== String(ticketId)) return
      void refetch()
    }
    window.addEventListener(SERVER_LOG_REFRESH_EVENT, handleRefresh)
    return () => window.removeEventListener(SERVER_LOG_REFRESH_EVENT, handleRefresh)
  }, [enabled, refetch, ticketId])

  return {
    ...query,
    entries,
    fetchOlder: query.fetchPreviousPage,
    hasOlder: query.hasPreviousPage,
    isFetchingOlder: query.isFetchingPreviousPage,
    exportLogs,
  }
}
