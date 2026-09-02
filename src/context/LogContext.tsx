import { startTransition, useCallback, useEffect, useMemo, useState, useRef, type ReactNode } from 'react'
import { LogActionsContext, LogStateContext } from './logContextDef'
import {
  type LogActionsValue,
  type LogEntry,
  type LogChannel,
  type LogStateValue,
  type PlainLogOptions,
  type ServerLogScope,
  serverLogCache,
  getServerLogCacheKey,
  getServerLogsUrl,
  normalizeLogRecord,
  isDebugLogEntry,
  compareTimestamps,
  mergeEntry,
  clearPersistedTicketLogs,
  clearServerLogCache,
} from './logUtils'
import { throwIfNotOk } from '@/lib/fetchError'

export type { LogEntry }

interface LogProviderProps {
  ticketId?: string | null
  currentStatus?: string
  visiblePhase?: string | null
  fullLogOpen?: boolean
  children: ReactNode
}

const MAX_LIVE_ROWS_PER_PHASE = 1_000

function mergeLogBuckets(
  current: Record<string, LogEntry[]>,
  entriesByStatus: Record<string, LogEntry[]>,
): { logsByPhase: Record<string, LogEntry[]>; hasChanges: boolean } {
  let merged = current
  let hasChanges = false

  for (const [status, entries] of Object.entries(entriesByStatus)) {
    if (entries.length === 0) continue

    const currentBucket = merged[status] ?? []
    let nextBucket = currentBucket
    for (const entry of entries) {
      nextBucket = mergeEntry(nextBucket, entry)
    }

    if (nextBucket !== currentBucket) {
      if (!hasChanges) {
        merged = { ...current }
      }
      merged[status] = nextBucket
      hasChanges = true
    }
  }

  return { logsByPhase: merged, hasChanges }
}

function normalizeScope(scope: ServerLogScope = {}): ServerLogScope {
  const normalized: ServerLogScope = {
    channel: scope.channel === 'debug' || scope.channel === 'ai' || scope.channel === 'all'
      ? scope.channel
      : 'normal',
  }

  if (scope.status) {
    normalized.status = scope.status
  } else if (scope.phase) {
    normalized.phase = scope.phase
  } else {
    normalized.lifecycle = true
  }

  if (typeof scope.phaseAttempt === 'number' && Number.isFinite(scope.phaseAttempt)) {
    normalized.phaseAttempt = scope.phaseAttempt
  }

  return normalized
}

function getRawPhaseAttempt(rawEntry: Record<string, unknown>): number | null {
  const phaseAttempt = typeof rawEntry.phaseAttempt === 'number' && Number.isFinite(rawEntry.phaseAttempt)
    ? rawEntry.phaseAttempt
    : Number(rawEntry.phaseAttempt)
  return Number.isFinite(phaseAttempt) ? phaseAttempt : null
}

function entryMatchesScope(rawEntry: Record<string, unknown>, entry: LogEntry, scope: ServerLogScope): boolean {
  if (scope.status && entry.status !== scope.status) return false
  if (scope.phase) {
    const entryPhase = typeof rawEntry.phase === 'string' ? rawEntry.phase : entry.status
    if (entryPhase !== scope.phase) return false
  }
  if (typeof scope.phaseAttempt === 'number' && Number.isFinite(scope.phaseAttempt)) {
    const rawPhaseAttempt = getRawPhaseAttempt(rawEntry) ?? entry.phaseAttempt ?? null
    if (rawPhaseAttempt !== scope.phaseAttempt) return false
  }
  return true
}

function entryMatchesPhaseAttempt(entry: LogEntry, phaseAttempt?: number): boolean {
  if (typeof phaseAttempt !== 'number' || !Number.isFinite(phaseAttempt)) return true
  return entry.phaseAttempt === phaseAttempt
}

function shouldIncludeEntryForScope(entry: LogEntry, scope: ServerLogScope): boolean {
  const isDebug = isDebugLogEntry(entry)
  if (scope.channel === 'all') return true
  if (scope.channel === 'debug') return isDebug
  if (scope.channel === 'ai') return !isDebug && entry.audience === 'ai'
  return !isDebug
}

export function LogProvider({
  ticketId,
  currentStatus,
  children,
}: LogProviderProps) {
  const [logsByPhase, setLogsByPhase] = useState<Record<string, LogEntry[]>>({})
  const [loadingScopeKeys, setLoadingScopeKeys] = useState<Set<string>>(() => new Set())
  const [manualActivePhase, setManualActivePhase] = useState<string | null>(null)
  const activePhase = manualActivePhase ?? currentStatus ?? null
  const isLoadingLogs = loadingScopeKeys.size > 0
  const currentStatusRef = useRef(currentStatus)
  const loadedScopeKeysRef = useRef<Set<string>>(new Set())
  const loadingScopeKeysRef = useRef<Set<string>>(new Set())
  const logsByPhaseRef = useRef<Record<string, LogEntry[]>>({})
  const activePhaseRef = useRef(activePhase)
  // Bumped whenever this provider stops owning `ticketId`, so a fetch that outlives it can tell.
  const generationRef = useRef(0)

  useEffect(() => {
    currentStatusRef.current = currentStatus
  }, [currentStatus])

  // Written after commit, like `currentStatusRef` above. A render can be thrown away, and
  // `getActivePhase` is what a phase-less SSE event is filed under — so a ref written
  // during render can hand a dispatcher a phase from a render that never happened.
  useEffect(() => {
    activePhaseRef.current = activePhase
  }, [activePhase])

  useEffect(() => {
    setLogsByPhase({})
    setLoadingScopeKeys(new Set())
    setManualActivePhase(null)
    loadedScopeKeysRef.current = new Set()
    loadingScopeKeysRef.current = new Set()
    logsByPhaseRef.current = {}

    // `serverLogCache` is module scope, so it outlives this provider. Nothing forces a refetch of
    // a scope it already holds, so leaving the departing ticket's entries behind means coming back
    // to that ticket replays the snapshot taken on the way out — every line that arrived over SSE
    // in between is missing, and the map grows for every ticket visited in the tab. Only the
    // ticket being left is dropped; entries for other tickets belong to their own providers.
    return () => {
      generationRef.current += 1
      if (ticketId) clearServerLogCache(ticketId)
    }
  }, [ticketId])

  const mergeLiveEntry = useCallback((entry: LogEntry) => {
    const { logsByPhase: merged, hasChanges } = mergeLogBuckets(logsByPhaseRef.current, {
      [entry.status]: [entry],
    })
    if (!hasChanges) return

    const bucket = merged[entry.status]
    if (bucket && bucket.length > MAX_LIVE_ROWS_PER_PHASE) {
      merged[entry.status] = bucket.slice(-MAX_LIVE_ROWS_PER_PHASE)
    }
    logsByPhaseRef.current = merged
    setLogsByPhase(merged)
  }, [])

  const setScopeLoading = useCallback((scopeKey: string, isLoading: boolean) => {
    const loading = loadingScopeKeysRef.current
    const alreadyLoading = loading.has(scopeKey)
    if (isLoading === alreadyLoading) return

    if (isLoading) {
      loading.add(scopeKey)
    } else {
      loading.delete(scopeKey)
    }
    setLoadingScopeKeys(new Set(loading))
  }, [])

  const applyServerLogs = useCallback((serverLogs: Array<Record<string, unknown>>, scope: ServerLogScope) => {
    if (!ticketId) return

    startTransition(() => {
      setLogsByPhase(prev => {
        const merged = { ...prev }
        let hasChanges = false
        for (const rawEntry of serverLogs) {
          const phase = String(rawEntry.phase ?? rawEntry.status ?? 'unknown')
          const entry = normalizeLogRecord(rawEntry, phase)
          if (!entryMatchesScope(rawEntry, entry, scope)) continue
          if (!shouldIncludeEntryForScope(entry, scope)) continue

          const bucket = merged[entry.status] ?? []
          const nextBucket = mergeEntry(bucket, entry)
          if (nextBucket !== bucket) {
            merged[entry.status] = nextBucket
            hasChanges = true
          }
        }

        const syntheticStatus = scope.channel === 'normal'
          && (
            scope.lifecycle
              ? currentStatusRef.current
              : scope.status === currentStatusRef.current
                ? scope.status
                : null
          )
        if (syntheticStatus) {
          const bucket = merged[syntheticStatus] ?? []
          const hasNormalEntry = bucket.some(entry => !isDebugLogEntry(entry))
          if (!hasNormalEntry) {
            const synthetic = normalizeLogRecord({
              type: 'info',
              phase: syntheticStatus,
              status: syntheticStatus,
              source: 'system',
              audience: 'all',
              kind: 'milestone',
              content: `[SYS] Status ${syntheticStatus} is active.`,
              timestamp: new Date().toISOString(),
              ...(typeof scope.phaseAttempt === 'number' && Number.isFinite(scope.phaseAttempt) ? { phaseAttempt: scope.phaseAttempt } : {}),
            }, syntheticStatus)
            const nextBucket = mergeEntry(bucket, synthetic)
            if (nextBucket !== bucket) {
              merged[syntheticStatus] = nextBucket
              hasChanges = true
            }
          }
        }

        if (!hasChanges) return prev
        logsByPhaseRef.current = merged
        return merged
      })
    })
  }, [ticketId])

  const requestServerLogs = useCallback((
    scope: ServerLogScope,
    options: { showLoading?: boolean; force?: boolean } = {},
  ) => {
    if (!ticketId) return

    const normalizedScope = normalizeScope(scope)
    const scopeKey = getServerLogCacheKey(ticketId, normalizedScope)
    if (!options.force && loadedScopeKeysRef.current.has(scopeKey)) {
      const cached = serverLogCache.get(scopeKey)
      if (cached) applyServerLogs(cached, normalizedScope)
      return
    }

    if (!options.force && serverLogCache.has(scopeKey)) {
      const cached = serverLogCache.get(scopeKey) ?? []
      loadedScopeKeysRef.current.add(scopeKey)
      applyServerLogs(cached, normalizedScope)
      return
    }

    if (loadingScopeKeysRef.current.has(scopeKey)) return

    if (options.showLoading !== false) setScopeLoading(scopeKey, true)
    const generation = generationRef.current
    fetch(getServerLogsUrl(ticketId, normalizedScope))
      .then(async (res) => {
        // A 500 used to be read as "this scope has no rows", which then went into
        // the module cache and the loaded-scope set — so the panel showed an empty
        // log, and every later request for it was served from that empty snapshot
        // instead of retrying. Failing here leaves both untouched.
        await throwIfNotOk(res, 'Failed to load logs')
        return res.json()
      })
      .then((raw: unknown) => {
        // A fetch can outlive the provider that started it. Writing to the module-scope cache here
        // would put back the entries the cleanup above just dropped, and returning to the ticket
        // would then serve that stale snapshot instead of fetching again — the leak this whole
        // effect exists to close, reopened for any ticket left mid-request.
        if (generationRef.current !== generation) return
        const payload = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
        const serverLogs = Array.isArray(raw)
          ? raw as Array<Record<string, unknown>>
          : Array.isArray(payload.entries) ? payload.entries as Array<Record<string, unknown>> : []
        serverLogCache.set(scopeKey, serverLogs)
        loadedScopeKeysRef.current.add(scopeKey)
        applyServerLogs(serverLogs, normalizedScope)
      })
      .catch(() => {
        // Ignore the failure here; cached rows stay on screen and the scope is
        // left unloaded, so the next request for it actually asks the server
        // again. The panel's own error surface is the historical-log query.
      })
      .finally(() => {
        if (generationRef.current !== generation) return
        setScopeLoading(scopeKey, false)
      })
  }, [applyServerLogs, setScopeLoading, ticketId])

  const addLog = useCallback((phase: string, line: string, options?: PlainLogOptions) => {
    if (!phase) return

    const raw: Record<string, unknown> = {
      type: options?.kind === 'error' ? 'error' : options?.audience === 'debug' ? 'debug' : 'info',
      phase,
      status: options?.status ?? phase,
      source: options?.source ?? 'system',
      audience: options?.audience ?? ((options?.source ?? 'system') === 'debug' ? 'debug' : 'all'),
      kind: options?.kind ?? 'milestone',
      content: line,
      ...(options?.timestamp ? { timestamp: options.timestamp } : {}),
      ...(options?.entryId ? { entryId: options.entryId } : {}),
      ...(options?.fingerprint ? { fingerprint: options.fingerprint } : {}),
      ...(options?.op ? { op: options.op } : {}),
      ...(options?.modelId ? { modelId: options.modelId } : {}),
      ...(options?.variant ? { variant: options.variant } : {}),
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options?.beadId ? { beadId: options.beadId } : {}),
      ...(typeof options?.beadIteration === 'number' && Number.isFinite(options.beadIteration) ? { beadIteration: options.beadIteration } : {}),
      ...(typeof options?.phaseAttempt === 'number' && Number.isFinite(options.phaseAttempt) ? { phaseAttempt: options.phaseAttempt } : {}),
      ...(typeof options?.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
      ...(options?.timeoutKind ? { timeoutKind: options.timeoutKind } : {}),
      ...(typeof options?.streaming === 'boolean' ? { streaming: options.streaming } : {}),
    }
    const entry = normalizeLogRecord(raw, phase)

    mergeLiveEntry(entry)
  }, [mergeLiveEntry])

  const addLogRecord = useCallback((phase: string, data: Record<string, unknown>) => {
    if (!phase) return
    const entry = normalizeLogRecord(data, phase)

    mergeLiveEntry(entry)
  }, [mergeLiveEntry])

  // Deliberately bound to `logsByPhase` and published with it: a caller memoising over a
  // reader wants to recompute when the rows change, and only then. The loaders below are
  // the opposite — identity-stable, so an effect can ask for a page without asking again
  // for every line the page then streams.
  const getLogsForPhase = useCallback(
    (phase: string, options?: { phaseAttempt?: number }) => (logsByPhase[phase] ?? [])
      .filter((entry) => entryMatchesPhaseAttempt(entry, options?.phaseAttempt))
      .slice()
      .sort((a, b) => compareTimestamps(a.timestamp, b.timestamp)),
    [logsByPhase],
  )

  const getAllLogs = useCallback(() => {
    return Object.values(logsByPhase)
      .flatMap(entries => entries)
      .sort((a, b) => compareTimestamps(a.timestamp, b.timestamp))
  }, [logsByPhase])

  const getActivePhase = useCallback(() => activePhaseRef.current, [])

  const loadLogsForPhase = useCallback((phase: string, options?: { channel?: LogChannel; phaseAttempt?: number }) => {
    if (!phase) return
    requestServerLogs({ status: phase, channel: options?.channel, phaseAttempt: options?.phaseAttempt })
  }, [requestServerLogs])

  const loadAllLogs = useCallback((options?: { channel?: LogChannel }) => {
    requestServerLogs({ lifecycle: true, channel: options?.channel })
  }, [requestServerLogs])

  const isLoadingLogScope = useCallback((scope: ServerLogScope) => {
    if (!ticketId) return false
    return loadingScopeKeys.has(getServerLogCacheKey(ticketId, normalizeScope(scope)))
  }, [loadingScopeKeys, ticketId])

  const clearLogs = useCallback(() => {
    if (ticketId) clearPersistedTicketLogs(ticketId)

    loadedScopeKeysRef.current.clear()
    loadingScopeKeysRef.current.clear()
    logsByPhaseRef.current = {}
    setLoadingScopeKeys(new Set())

    startTransition(() => {
      setLogsByPhase({})
      setManualActivePhase(null)
    })
  }, [ticketId])

  const state = useMemo<LogStateValue>(
    () => ({ logsByPhase, activePhase, isLoadingLogs, getLogsForPhase, getAllLogs, isLoadingLogScope }),
    [activePhase, getAllLogs, getLogsForPhase, isLoadingLogScope, isLoadingLogs, logsByPhase],
  )

  // Every member below is already identity-stable, so this memo settles once per ticket
  // and never invalidates as rows arrive. That is the point: an effect may depend on the
  // whole actions object without re-running when a line arrives.
  const actions = useMemo<LogActionsValue>(
    () => ({
      addLog,
      addLogRecord,
      getActivePhase,
      setActivePhase: setManualActivePhase,
      loadLogsForPhase,
      loadAllLogs,
      clearLogs,
    }),
    [addLog, addLogRecord, clearLogs, getActivePhase, loadAllLogs, loadLogsForPhase],
  )

  return (
    <LogActionsContext.Provider value={actions}>
      <LogStateContext.Provider value={state}>
        {children}
      </LogStateContext.Provider>
    </LogActionsContext.Provider>
  )
}
