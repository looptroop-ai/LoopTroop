import { useCallback, useEffect, useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  getLogEntryAliases,
  INITIAL_LOG_PAGE_LIMIT,
  normalizeLogRecord,
  OLDER_LOG_PAGE_LIMIT,
  SERVER_LOG_REFRESH_EVENT,
  type LogEntry,
} from '@/context/logUtils'
import { throwIfNotOk } from '@/lib/fetchError'
import { apiTicketPath } from '@/lib/apiPaths'

export type HistoricalLogView = 'overview' | 'system' | 'command' | 'ai' | 'error' | 'debug'

export interface HistoricalLogScope {
  scope: 'phase' | 'lifecycle'
  phase?: string
  phaseAttempt?: number
  view: HistoricalLogView
  modelId?: string
  beadId?: string
}

interface HistoricalLogPage {
  entries: LogEntry[]
  olderCursor: string | null
  hasOlder: boolean
  totalEntries: number | null
  totalTextLines: number | null
  /** Context for a delimiter that begins before this page. */
  boundary?: Record<string, unknown>
}

function normalizeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function getQuery(ticketId: string, scope: HistoricalLogScope, before?: string): string {
  const params = new URLSearchParams({
    scope: scope.scope,
    view: scope.view,
    limit: String(before ? OLDER_LOG_PAGE_LIMIT : INITIAL_LOG_PAGE_LIMIT),
  })
  if (scope.phase) params.set('phase', scope.phase)
  if (typeof scope.phaseAttempt === 'number') params.set('phaseAttempt', String(scope.phaseAttempt))
  if (scope.modelId) params.set('modelId', scope.modelId)
  if (scope.beadId) params.set('beadId', scope.beadId)
  if (before) params.set('before', before)
  return `${apiTicketPath(ticketId, 'logs')}?${params.toString()}`
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
    totalEntries: normalizeCount(data.totalEntries),
    totalTextLines: normalizeCount(data.totalTextLines),
    boundary: data.boundary && typeof data.boundary === 'object' ? data.boundary as Record<string, unknown> : undefined,
  }
}

/**
 * Newest-first, cursor-paginated durable log history.  Live SSE rows are kept
 * outside this query; callers can overlay them by stable entry identity.
 */
export function useTicketHistoricalLogs(ticketId: string | undefined, scope: HistoricalLogScope, enabled = true) {
  const queryKey = useMemo(() => [
    'ticket-log-history', ticketId ?? '__missing__', scope.scope, scope.phase ?? '', scope.phaseAttempt ?? '', scope.view, scope.modelId ?? '', scope.beadId ?? '',
  ], [scope.beadId, scope.modelId, scope.phase, scope.phaseAttempt, scope.scope, scope.view, ticketId])

  const query = useInfiniteQuery({
    queryKey,
    enabled: Boolean(ticketId) && enabled,
    // React Query v5 requires a concrete initial parameter for an infinite
    // query; `null` represents the newest page and is omitted from the URL.
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const response = await fetch(getQuery(ticketId!, scope, pageParam ?? undefined), { signal })
      await throwIfNotOk(response, 'Unable to load logs')
      return normalizePage(await response.json(), scope.phase)
    },
    // History is only fetched toward older cursors via fetchPreviousPage.
    // React Query still requires this callback to calculate result metadata.
    getNextPageParam: () => undefined,
    getPreviousPageParam: firstPage => firstPage.hasOlder ? firstPage.olderCursor ?? undefined : undefined,
    staleTime: 30_000,
  })

  const entries = useMemo(() => {
    // Folded on every key the live overlay folds on — attempt-scoped id and
    // fingerprint. Entry ids are unique only within one attempt, so a retried phase
    // re-emitting `milestone:<phase>:started` used to collapse two archived attempts
    // into one row; and a row re-emitted under a fresh id is still the same row.
    //
    // Read in the order React Query holds the pages, which is oldest page first:
    // `fetchPreviousPage` prepends. Walking them backwards let an older page's copy
    // overwrite the newer one, so an entry whose append and later finalize fell on
    // opposite sides of a page boundary showed the unfinished text.
    // One slot per row, with every alias pointing at the slot rather than at the row, so
    // a row that arrives under a second alias updates the slot instead of leaving the
    // first alias holding the copy from before the merge.
    const rows: LogEntry[] = []
    const slotByAlias = new Map<string, number>()
    for (const page of query.data?.pages ?? []) {
      for (const entry of page.entries) {
        const aliases = getLogEntryAliases(entry)
        const slot = aliases.map(alias => slotByAlias.get(alias)).find((value): value is number => value !== undefined)
        if (slot === undefined) {
          const nextSlot = rows.length
          rows.push(entry)
          for (const alias of aliases) slotByAlias.set(alias, nextSlot)
          continue
        }
        // Merged on the live overlay's terms, which is the point of sharing the identity:
        // a row is shown from when it first appeared, not from when its last delivery
        // landed, and a finalize ends the streaming state. Taking the newer timestamp
        // would move a row that streamed for a minute to the moment it finished, past
        // everything that happened while it was running.
        const existing = rows[slot]!
        rows[slot] = {
          ...existing,
          ...entry,
          timestamp: existing.timestamp ?? entry.timestamp,
          streaming: entry.op === 'finalize' ? false : entry.streaming,
        }
        for (const alias of getLogEntryAliases(rows[slot]!)) slotByAlias.set(alias, slot)
      }
    }
    return rows.sort((a, b) => {
      const aTime = a.timestamp ? Date.parse(a.timestamp) : Number.NaN
      const bTime = b.timestamp ? Date.parse(b.timestamp) : Number.NaN
      if (Number.isNaN(aTime) || Number.isNaN(bTime)) return 0
      return aTime - bTime
    })
  }, [query.data?.pages])
  const refetch = query.refetch
  const countPage = query.data?.pages.find(page => page.totalEntries !== null || page.totalTextLines !== null)

  const exportLogs = useCallback(async (signal?: AbortSignal): Promise<string> => {
    if (!ticketId) return ''
    const params = new URLSearchParams({ scope: scope.scope, view: scope.view })
    if (scope.phase) params.set('phase', scope.phase)
    if (typeof scope.phaseAttempt === 'number') params.set('phaseAttempt', String(scope.phaseAttempt))
    if (scope.modelId) params.set('modelId', scope.modelId)
    if (scope.beadId) params.set('beadId', scope.beadId)
    const response = await fetch(`${apiTicketPath(ticketId, 'logs', 'export')}?${params.toString()}`, { signal })
    await throwIfNotOk(response, 'Unable to export logs')
    return response.text()
  }, [scope, ticketId])

  const fetchPreviousPage = query.fetchPreviousPage
  /**
   * Walks every older page in one go. Callers pass `isCancelled` and flip it when the
   * scope they started the walk for is gone — a different bead, a different attempt, an
   * unmounted panel — because the loop otherwise keeps paging into a query that is no
   * longer on screen, and the last page to land wins.
   *
   * Depends on `fetchPreviousPage` alone so it keeps one identity for the life of the
   * query. Listing `hasPreviousPage` rebuilt it on every page, and a caller that holds
   * it in an effect dependency then cancels and restarts its own walk mid-flight — which
   * is how a failure ends up looking like a cancellation and never latches. The entry
   * condition is gone with it: `fetchPreviousPage` on a query with no older page is a
   * no-op that reports `hasPreviousPage: false`, and both callers already gate on it.
   */
  const fetchAllOlder = useCallback(async (isCancelled?: () => boolean): Promise<void> => {
    for (;;) {
      if (isCancelled?.()) return
      const result = await fetchPreviousPage()
      if (result.isError) throw result.error
      if (isCancelled?.() || !result.hasPreviousPage) return
    }
  }, [fetchPreviousPage])

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
    totalEntries: countPage?.totalEntries ?? null,
    totalTextLines: countPage?.totalTextLines ?? null,
    fetchOlder: query.fetchPreviousPage,
    fetchAllOlder,
    hasOlder: query.hasPreviousPage,
    isFetchingOlder: query.isFetchingPreviousPage,
    exportLogs,
  }
}
