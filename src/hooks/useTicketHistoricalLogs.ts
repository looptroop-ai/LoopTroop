import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isCancelledError, skipToken, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getLogEntryAliases,
  INITIAL_LOG_PAGE_LIMIT,
  normalizeLogRecord,
  OLDER_LOG_PAGE_LIMIT,
  SERVER_LOG_REFRESH_EVENT,
  compareTimestamps,
  type LogEntry,
} from '@/context/logUtils'
import { throwIfNotOk } from '@/lib/fetchError'
import { apiTicketPath } from '@/lib/apiPaths'
import { QUERY_STALE_TIME_30S } from '@/lib/constants'

export type HistoricalLogView = 'overview' | 'system' | 'command' | 'ai' | 'error' | 'debug'

export interface HistoricalLogScope {
  scope: 'phase' | 'lifecycle'
  phase?: string
  phaseAttempt?: number
  view: HistoricalLogView
  modelId?: string
  beadId?: string
}

export interface HistoricalLogPage {
  entries: LogEntry[]
  olderCursor: string | null
  hasOlder: boolean
  totalEntries: number | null
  totalTextLines: number | null
  modelIds: string[] | null
  /** Context for a delimiter that begins before this page. */
  boundary?: Record<string, unknown>
}

export interface HistoricalLogFoldStats {
  pagesVisited: number
  entriesVisited: number
  comparatorCalls: number
  nodeCopies?: number
  materializedEntries?: number
  aliasRegistrations?: number
}

interface HistoricalLogNode {
  entry: LogEntry
}

export interface HistoricalLogFoldCache {
  view: HistoricalLogView
  pages: HistoricalLogPage[]
  nodes: HistoricalLogNode[]
  aliases: Map<string, HistoricalLogNode>
  entries: LogEntry[]
}

export const HISTORICAL_LOG_CURSOR_EXPIRED_CODE = 'LOG_CURSOR_EXPIRED'

export class HistoricalLogCursorExpiredError extends Error {
  readonly code = HISTORICAL_LOG_CURSOR_EXPIRED_CODE

  constructor() {
    super('The log history changed while it was loading. Retry to start a fresh history walk.')
    this.name = 'HistoricalLogCursorExpiredError'
  }
}

export function isHistoricalLogCursorExpiredError(error: unknown): error is HistoricalLogCursorExpiredError {
  return error instanceof HistoricalLogCursorExpiredError
    || (Boolean(error) && typeof error === 'object'
      && (error as { code?: unknown }).code === HISTORICAL_LOG_CURSOR_EXPIRED_CODE)
}

async function throwIfHistoricalCursorExpired(response: Response): Promise<void> {
  if (response.status !== 409) return
  try {
    const payload = await response.clone().json() as { code?: unknown }
    if (payload.code === HISTORICAL_LOG_CURSOR_EXPIRED_CODE) {
      throw new HistoricalLogCursorExpiredError()
    }
  } catch (error) {
    if (isHistoricalLogCursorExpiredError(error)) throw error
  }
}

function compareStableStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The server's AI order is timestamp, mirror identity, then occurrence. */
export function compareHistoricalLogEntries(a: LogEntry, b: LogEntry, view: HistoricalLogView): number {
  if (view !== 'ai') return 0
  return compareTimestamps(a.timestamp, b.timestamp)
    || compareStableStrings(
      a._logMirrorKey ?? (a.op === 'append' && a.fingerprint
        ? `fingerprint:${a.status}:${a.phaseAttempt ?? 1}:${a.fingerprint}`
        : `entry:${a.status}:${a.phaseAttempt ?? 1}:${a.entryId}`),
      b._logMirrorKey ?? (b.op === 'append' && b.fingerprint
        ? `fingerprint:${b.status}:${b.phaseAttempt ?? 1}:${b.fingerprint}`
        : `entry:${b.status}:${b.phaseAttempt ?? 1}:${b.entryId}`),
    )
    || (a._logMirrorOccurrence ?? 0) - (b._logMirrorOccurrence ?? 0)
    || compareStableStrings(a.entryId, b.entryId)
}

function addHistoricalEntry(
  entry: LogEntry,
  nodes: HistoricalLogNode[],
  aliases: Map<string, HistoricalLogNode>,
  mergeExisting: boolean,
  stats?: HistoricalLogFoldStats,
): HistoricalLogNode | null {
  if (stats) stats.entriesVisited += 1
  const entryAliases = getLogEntryAliases(entry)
  const existing = entryAliases.map(alias => aliases.get(alias)).find(Boolean)
  if (existing) {
    if (mergeExisting || nodes.includes(existing)) {
      existing.entry = {
        ...existing.entry,
        ...entry,
        timestamp: existing.entry.timestamp ?? entry.timestamp,
        streaming: entry.op === 'finalize' ? false : entry.streaming,
      }
      for (const alias of getLogEntryAliases(existing.entry)) {
        aliases.set(alias, existing)
        if (stats) stats.aliasRegistrations = (stats.aliasRegistrations ?? 0) + 1
      }
    } else if (compareTimestamps(entry.timestamp, existing.entry.timestamp) < 0 || existing.entry.op === 'finalize') {
      // An older page can carry the original append for a newer-page finalize.
      // Keep the newer payload, but retain the true start time for the row.
      existing.entry = {
        ...existing.entry,
        timestamp: entry.timestamp,
        streaming: existing.entry.op === 'finalize' ? false : existing.entry.streaming,
      }
    }
    // A page can introduce the fingerprint only after a newer finalize has
    // already won the payload. Keep every incoming alias in the graph even
    // when that payload is deliberately retained; otherwise an oldest-first
    // fold and an incremental fold disagree about whether this is one row.
    for (const alias of entryAliases) {
      aliases.set(alias, existing)
      if (stats) stats.aliasRegistrations = (stats.aliasRegistrations ?? 0) + 1
    }
    return null
  }
  const node = { entry }
  nodes.push(node)
  for (const alias of entryAliases) {
    aliases.set(alias, node)
    if (stats) stats.aliasRegistrations = (stats.aliasRegistrations ?? 0) + 1
  }
  return node
}

function compareNodes(
  a: HistoricalLogNode,
  b: HistoricalLogNode,
  view: HistoricalLogView,
  stats?: HistoricalLogFoldStats,
): number {
  if (stats) stats.comparatorCalls += 1
  return compareHistoricalLogEntries(a.entry, b.entry, view)
}

function insertSortedNode(
  nodes: HistoricalLogNode[],
  node: HistoricalLogNode,
  view: HistoricalLogView,
  stats?: HistoricalLogFoldStats,
) {
  let low = 0
  let high = nodes.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareNodes(nodes[middle]!, node, view, stats) <= 0) low = middle + 1
    else high = middle
  }
  nodes.splice(low, 0, node)
}

/**
 * Folds page-immutable query data incrementally. Older pages are prepended, so a
 * full drain visits each newly arrived row once instead of rebuilding and sorting
 * the complete archive after every request.
 */
export function foldHistoricalLogPages(
  pages: readonly HistoricalLogPage[],
  view: HistoricalLogView,
  previous: HistoricalLogFoldCache | null = null,
  stats?: HistoricalLogFoldStats,
): HistoricalLogFoldCache {
  const oldestFirstPages = pages.toReversed()

  const samePages = previous?.view === view
    && previous.pages.length === oldestFirstPages.length
    && previous.pages.every((page, index) => page === oldestFirstPages[index])
  if (samePages) return previous!

  const canPrepend = previous?.view === view
    && previous.pages.length <= oldestFirstPages.length
    && previous.pages.every((page, index) => page === oldestFirstPages[oldestFirstPages.length - previous.pages.length + index])

  if (!canPrepend) {
    const nodes: HistoricalLogNode[] = []
    const aliases = new Map<string, HistoricalLogNode>()
    for (const page of oldestFirstPages) {
      if (stats) stats.pagesVisited += 1
      for (const entry of page.entries) addHistoricalEntry(entry, nodes, aliases, true, stats)
    }
    if (view === 'ai') nodes.sort((a, b) => compareNodes(a, b, view, stats))
    if (stats) stats.materializedEntries = (stats.materializedEntries ?? 0) + nodes.length
    return {
      view,
      pages: [...oldestFirstPages],
      nodes,
      aliases,
      entries: nodes.map(node => node.entry),
    }
  }

  const addedPages = oldestFirstPages.slice(0, oldestFirstPages.length - previous!.pages.length)
  const newNodes: HistoricalLogNode[] = []
  for (const page of addedPages) {
    if (stats) stats.pagesVisited += 1
    const pageNodes: HistoricalLogNode[] = []
    for (const entry of page.entries) {
      const existing = getLogEntryAliases(entry)
        .map(alias => previous!.aliases.get(alias))
        .find((node): node is HistoricalLogNode => Boolean(node))
      const node = addHistoricalEntry(entry, pageNodes, previous!.aliases, false, stats)
      if (node) newNodes.push(node)
      // An older append can supply the true start timestamp for a newer-page
      // finalize. Reinsert the canonical node after that update; leaving it in
      // place silently breaks the AI ordering invariant.
      if (view === 'ai' && existing) {
        const index = previous!.nodes.indexOf(existing)
        if (index >= 0) {
          previous!.nodes.splice(index, 1)
          insertSortedNode(previous!.nodes, existing, view, stats)
        }
      }
    }
  }

  if (newNodes.length > 0) {
    if (view === 'ai') {
      newNodes.sort((a, b) => compareNodes(a, b, view, stats))
      const currentFirst = previous!.nodes[0]
      const addedLast = newNodes.at(-1)
      if (!currentFirst || !addedLast || compareNodes(addedLast, currentFirst, view, stats) <= 0) {
        if (stats) stats.nodeCopies = (stats.nodeCopies ?? 0) + newNodes.length + previous!.nodes.length
        previous!.nodes = [...newNodes, ...previous!.nodes]
      } else {
        for (const node of newNodes) insertSortedNode(previous!.nodes, node, view, stats)
      }
    } else {
      if (stats) stats.nodeCopies = (stats.nodeCopies ?? 0) + newNodes.length + previous!.nodes.length
      previous!.nodes = [...newNodes, ...previous!.nodes]
    }
  }
  if (addedPages.length > 0) {
    if (stats) stats.materializedEntries = (stats.materializedEntries ?? 0) + previous!.nodes.length
    previous!.entries = previous!.nodes.map(node => node.entry)
  }
  previous!.pages = [...oldestFirstPages]
  return previous!
}

interface ModelCatalog {
  modelIds: string[] | null
  nextRevision: number
  appliedRevision: number
}

type DrainState = {
  key: string
  promise: Promise<void>
  cancellationChecks: Set<() => boolean>
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
    modelIds: Array.isArray(data.modelIds)
      ? data.modelIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : null,
    boundary: data.boundary && typeof data.boundary === 'object' ? data.boundary as Record<string, unknown> : undefined,
  }
}

/**
 * Newest-first, cursor-paginated durable log history.  Live SSE rows are kept
 * outside this query; callers can overlay them by stable entry identity.
 */
export function useTicketHistoricalLogs(ticketId: string | undefined, scope: HistoricalLogScope, enabled = true) {
  const queryClient = useQueryClient()
  const modelQueryKey = ['ticket-log-models', ticketId ?? '__missing__', scope.scope, scope.phase ?? '', scope.phaseAttempt ?? '', scope.beadId ?? '']
  // Share the catalog across filter queries and remounts. Only a fresh response
  // updates it; reading or paging a cached filter cannot replay older metadata.
  const modelCatalog = useQuery<ModelCatalog, Error, string[] | null>({
    queryKey: modelQueryKey,
    queryFn: skipToken,
    select: catalog => catalog.modelIds,
  })
  const queryKey = useMemo(() => [
    'ticket-log-history', ticketId ?? '__missing__', scope.scope, scope.phase ?? '', scope.phaseAttempt ?? '', scope.view, scope.modelId ?? '', scope.beadId ?? '',
  ], [scope.beadId, scope.modelId, scope.phase, scope.phaseAttempt, scope.scope, scope.view, ticketId])
  const queryScopeKey = JSON.stringify(queryKey)

  const query = useInfiniteQuery({
    queryKey,
    enabled: Boolean(ticketId) && enabled,
    // React Query v5 requires a concrete initial parameter for an infinite
    // query; `null` represents the newest page and is omitted from the URL.
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      // Filter queries can overlap. Order successful catalogs by request start,
      // so a delayed older response cannot erase a newer response's model IDs.
      const revision = pageParam === null
        ? queryClient.setQueryData<ModelCatalog>(modelQueryKey, previous => ({
            modelIds: previous?.modelIds ?? null,
            nextRevision: (previous?.nextRevision ?? 0) + 1,
            appliedRevision: previous?.appliedRevision ?? 0,
          }))!.nextRevision
        : 0
      const response = await fetch(getQuery(ticketId!, scope, pageParam ?? undefined), { signal })
      await throwIfHistoricalCursorExpired(response)
      await throwIfNotOk(response, 'Unable to load logs')
      const page = normalizePage(await response.json(), scope.phase)
      if (pageParam === null && page.modelIds !== null && !signal.aborted) {
        queryClient.setQueryData<ModelCatalog>(modelQueryKey, previous => previous && revision > previous.appliedRevision
          ? { ...previous, modelIds: page.modelIds, appliedRevision: revision }
          : previous)
      }
      return page
    },
    // Keep the newest page first so native refetch starts there, then follows
    // fresh older cursors through the loaded page count.
    getNextPageParam: lastPage => lastPage.hasOlder ? lastPage.olderCursor ?? undefined : undefined,
    staleTime: QUERY_STALE_TIME_30S,
  })

  const foldCacheRef = useRef<HistoricalLogFoldCache | null>(null)
  const activeScopeKeyRef = useRef(queryScopeKey)
  activeScopeKeyRef.current = queryScopeKey
  const foldScopeKeyRef = useRef<string | null>(null)
  const drainStateRef = useRef<DrainState | null>(null)
  const mountedRef = useRef(true)
  const [foldRevision, setFoldRevision] = useState(0)
  const [drainError, setDrainError] = useState<unknown>(null)
  useEffect(() => {
    // StrictMode replays effects with a cleanup between setups. Re-arm the
    // guard during the second setup so a completed automatic drain can publish
    // its final fold instead of treating the replay as an unmount forever.
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const entries = useMemo(() => {
    void foldRevision
    if (foldScopeKeyRef.current !== queryScopeKey) {
      foldScopeKeyRef.current = queryScopeKey
      foldCacheRef.current = null
    }
    if (drainStateRef.current?.key === queryScopeKey && foldCacheRef.current) return foldCacheRef.current.entries
    const folded = foldHistoricalLogPages(query.data?.pages ?? [], scope.view, foldCacheRef.current)
    foldCacheRef.current = folded
    return folded.entries
  }, [foldRevision, query.data?.pages, queryScopeKey, scope.view])
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

  const fetchNextPage = query.fetchNextPage
  const queryDataRef = useRef(query.data)
  queryDataRef.current = query.data

  const olderRequestRef = useRef<{
    key: string
    promise: Promise<Awaited<ReturnType<typeof fetchNextPage>>>
  } | null>(null)
  const requestOlderPage = useCallback(() => {
    const existing = olderRequestRef.current
    if (existing?.key === queryScopeKey) return existing.promise
    const request = (async () => {
      // Native TanStack semantics keep a refresh alive when an older request
      // arrives. A fresh refresh may still supersede this request; the full
      // drain below sees the settled cursor and retries rather than truncating.
      return fetchNextPage({ cancelRefetch: false })
    })()
    const state = { key: queryScopeKey, promise: request }
    olderRequestRef.current = state
    void request.then(
      () => { if (olderRequestRef.current === state) olderRequestRef.current = null },
      () => { if (olderRequestRef.current === state) olderRequestRef.current = null },
    )
    return request
  }, [fetchNextPage, queryScopeKey])
  /**
   * Walks every older page in one go. Callers pass `isCancelled` and flip it when the
   * scope they started the walk for is gone — a different bead, a different attempt, an
   * unmounted panel — because the loop otherwise keeps paging into a query that is no
   * longer on screen, and the last page to land wins.
   *
   * Depends on `fetchNextPage` alone so it keeps one identity for the life of the
   * query. Listing `hasNextPage` rebuilt it on every page, and a caller that holds
   * it in an effect dependency then cancels and restarts its own walk mid-flight — which
   * is how a failure ends up looking like a cancellation and never latches. The entry
   * condition is gone with it: `fetchNextPage` on a query with no older page is a
   * no-op that reports `hasNextPage: false`, and both callers already gate on it.
  */
  const fetchAllOlder = useCallback((isCancelled?: () => boolean): Promise<void> => {
    const existing = drainStateRef.current
    if (existing?.key === queryScopeKey) {
      if (isCancelled) existing.cancellationChecks.add(isCancelled)
      return existing.promise
    }
    const cancellationChecks = new Set<() => boolean>()
    if (isCancelled) cancellationChecks.add(isCancelled)
    const state: DrainState = {
      key: queryScopeKey,
      promise: Promise.resolve(),
      cancellationChecks,
    }
    drainStateRef.current = state
    setDrainError(null)
    const runIsCancelled = () => activeScopeKeyRef.current !== state.key
      || (state.cancellationChecks.size > 0 && [...state.cancellationChecks].every(check => check()))
    let unchangedCursor: string | null | undefined
    let cursorRecoveryUsed = false
    const recoverExpiredCursor = async () => {
      await queryClient.resetQueries({ queryKey, exact: true })
      queryDataRef.current = queryClient.getQueryData(queryKey) as typeof queryDataRef.current
      unchangedCursor = undefined
    }
    const run = (async () => {
      for (;;) {
        if (runIsCancelled()) return
        const beforeCursor = queryDataRef.current?.pages.at(-1)?.olderCursor ?? null
        let result: Awaited<ReturnType<typeof fetchNextPage>>
        try {
          result = await requestOlderPage()
        } catch (error) {
          if (isCancelledError(error)) continue
          if (isHistoricalLogCursorExpiredError(error) && !cursorRecoveryUsed) {
            cursorRecoveryUsed = true
            await recoverExpiredCursor()
            continue
          }
          throw error
        }
        if (result.isError) {
          if (isCancelledError(result.error)) continue
          if (isHistoricalLogCursorExpiredError(result.error) && !cursorRecoveryUsed) {
            cursorRecoveryUsed = true
            await recoverExpiredCursor()
            continue
          }
          throw result.error
        }
        if (runIsCancelled() || !result.hasNextPage) return
        // A non-cancelling request may have shared a newest-page refresh. Never
        // silently stop on that unchanged cursor: retry once from the settled
        // query, then surface a broken server cursor instead of truncating.
        const nextCursor = result.data?.pages.at(-1)?.olderCursor ?? queryDataRef.current?.pages.at(-1)?.olderCursor ?? null
        if (nextCursor === beforeCursor) {
          if (unchangedCursor === beforeCursor) {
            throw new Error('Historical log cursor did not advance while loading older pages')
          }
          unchangedCursor = beforeCursor
          continue
        }
        unchangedCursor = undefined
      }
    })()
    state.promise = run
    const finish = (error?: unknown) => {
      if (drainStateRef.current !== state) return
      drainStateRef.current = null
      if (error && mountedRef.current && !runIsCancelled()) setDrainError(error)
      // A cancelled walk may still have received a page before it observed
      // cancellation. Publish that page for the scope that is still mounted;
      // otherwise the cache remains frozen until an unrelated render.
      if (mountedRef.current && activeScopeKeyRef.current === state.key) {
        setFoldRevision(revision => revision + 1)
      }
    }
    run.then(() => finish(), finish)
    return run
  }, [queryClient, queryKey, queryScopeKey, requestOlderPage])

  const retryHistoricalLogs = useCallback(async () => {
    if (drainError) {
      await queryClient.resetQueries({ queryKey, exact: true })
      queryDataRef.current = queryClient.getQueryData(queryKey) as typeof queryDataRef.current
      await fetchAllOlder()
      return
    }
    await refetch()
  }, [drainError, fetchAllOlder, queryClient, queryKey, refetch])

  useEffect(() => {
    setDrainError(null)
  }, [queryScopeKey])

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
    modelIds: modelCatalog.data ?? null,
    fetchOlder: requestOlderPage,
    fetchAllOlder,
    hasOlder: query.hasNextPage,
    isFetchingOlder: query.isFetchingNextPage,
    error: query.error ?? drainError,
    isError: query.isError || Boolean(drainError),
    retryHistoricalLogs,
    exportLogs,
  }
}
