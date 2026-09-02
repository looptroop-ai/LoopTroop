import { useCallback, useEffect, useRef, useState } from 'react'
import { queryClient } from '@/lib/queryClient'
import { getApiUrl, waitForDevBackend } from '@/lib/devApi'
import { SSE_RECONNECT_DELAY_MS } from '@/lib/constants'
import { getBeadDiffQueryKey } from '@/lib/beadDiffQuery'
import { SERVER_LOG_REFRESH_EVENT } from '@/context/logUtils'
import { probeSessionAfterStreamFailure } from '@/lib/sessionState'
import { patchTicketStatusInCache } from './ticketStatusCache'
import { getTicketArtifactsQueryKey } from './useTicketArtifacts'
import { getTicketAiDetailsQueryKey } from './useTicketAiDetails'

interface SSEOptions {
  ticketId: string | null
  onEvent?: (event: { type: string; data: Record<string, unknown> }) => void
}

export type SSEConnectionState = 'connecting' | 'connected' | 'reconnecting'

const LAST_EVENT_ID_STORAGE_PREFIX = 'looptroop-sse-last-event-id:'
const AI_DETAILS_INVALIDATION_DELAY_MS = 400
const aiDetailsInvalidationTimers = new Map<string, ReturnType<typeof setTimeout>>()

function getLastEventIdStorageKey(ticketId: string) {
  return `${LAST_EVENT_ID_STORAGE_PREFIX}${ticketId}`
}

function readPersistedLastEventId(ticketId: string): string {
  if (typeof window === 'undefined') return '0'
  try {
    const stored = localStorage.getItem(getLastEventIdStorageKey(ticketId))
    return stored && stored !== '0' ? stored : '0'
  } catch {
    return '0'
  }
}

function persistLastEventId(ticketId: string, lastEventId: string) {
  if (!lastEventId || lastEventId === '0' || typeof window === 'undefined') return
  try {
    localStorage.setItem(getLastEventIdStorageKey(ticketId), lastEventId)
  } catch {
    // Best-effort only.
  }
}

function invalidateBeadDiffQuery(ticketId: string, beadId: unknown) {
  if (typeof beadId !== 'string' || beadId.length === 0) return
  queryClient.invalidateQueries({ queryKey: getBeadDiffQueryKey(ticketId, beadId), exact: true })
}

function getBeadIdFromArtifactType(artifactType: unknown): string | null {
  if (typeof artifactType !== 'string' || !artifactType.startsWith('bead_diff:')) return null
  const beadId = artifactType.slice('bead_diff:'.length)
  return beadId.length > 0 ? beadId : null
}

function dispatchServerLogRefresh(ticketId: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SERVER_LOG_REFRESH_EVENT, { detail: { ticketId } }))
}

function invalidateManualQaQueries(ticketId: string) {
  queryClient.invalidateQueries({ queryKey: ['manual-qa', ticketId] })
}

function recoverTicketAfterStreamGap(ticketId: string) {
  queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] })
  queryClient.invalidateQueries({ queryKey: ['tickets'] })
  queryClient.invalidateQueries({ queryKey: ['ticket-artifacts', ticketId] })
  queryClient.invalidateQueries({ queryKey: ['interview', ticketId] })
  queryClient.invalidateQueries({ queryKey: ['artifact', ticketId, 'interview'] })
  queryClient.invalidateQueries({ queryKey: ['artifact', ticketId, 'execution-setup-plan'] })
  queryClient.invalidateQueries({ queryKey: ['ticket-beads', ticketId] })
  queryClient.invalidateQueries({ queryKey: ['artifact', ticketId, 'beads'] })
  invalidateManualQaQueries(ticketId)
  queryClient.invalidateQueries({ queryKey: getTicketAiDetailsQueryKey(ticketId) })
  dispatchServerLogRefresh(ticketId)
}

function scheduleAiDetailsInvalidation(ticketId: string) {
  const currentTimer = aiDetailsInvalidationTimers.get(ticketId)
  if (currentTimer) clearTimeout(currentTimer)
  const timer = setTimeout(() => {
    // Act only while this timer still owns the slot. After a reschedule the slot belongs to a newer
    // timer: retiring its entry would leave it untracked, and invalidating here would hit a ticket
    // that has since been left or reused. Both halves of the callback are behind the same check.
    if (aiDetailsInvalidationTimers.get(ticketId) !== timer) return
    aiDetailsInvalidationTimers.delete(ticketId)
    queryClient.invalidateQueries({ queryKey: getTicketAiDetailsQueryKey(ticketId) })
  }, AI_DETAILS_INVALIDATION_DELAY_MS)
  aiDetailsInvalidationTimers.set(ticketId, timer)
}

/**
 * The timer map is module scope, so a pending invalidation outlives the hook that scheduled it.
 * Leaving a ticket therefore has to settle the debounce rather than abandon it: the handle is
 * cleared so nothing fires against an unmounted ticket, and the invalidation the stream had already
 * earned runs immediately instead. Dropping it would not be free — `useTicketAiDetails` holds its
 * data for 30s, so returning inside that window would show metrics from before the event.
 */
function flushAiDetailsInvalidation(ticketId: string) {
  const timer = aiDetailsInvalidationTimers.get(ticketId)
  if (!timer) return
  clearTimeout(timer)
  aiDetailsInvalidationTimers.delete(ticketId)
  queryClient.invalidateQueries({ queryKey: getTicketAiDetailsQueryKey(ticketId) })
}

export function useSSE({ ticketId, onEvent }: SSEOptions) {
  const eventSourceRef = useRef<EventSource | null>(null)
  const lastEventIdRef = useRef<string>('0')
  const recoverOnOpenRef = useRef(false)
  const reconnectRef = useRef<(() => void) | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connectAbortControllerRef = useRef<AbortController | null>(null)
  const connectTokenRef = useRef(0)
  // `connect` is queued as a microtask, so it can still run after the cleanup that was
  // meant to stop it. Without this it would open an EventSource nobody closes.
  const mountedRef = useRef(true)
  const ticketIdRef = useRef(ticketId)
  ticketIdRef.current = ticketId
  // Keep the connection stable per ticket while always dispatching to the latest callback.
  const onEventRef = useRef(onEvent)
  const [connectionState, setConnectionState] = useState<SSEConnectionState>(ticketId ? 'connecting' : 'connected')

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    queueMicrotask(() => setConnectionState(ticketId ? 'connecting' : 'connected'))
  }, [ticketId])

  /**
   * Whether this subscription has already asked about the session; see `onerror`.
   *
   * Cleared when a stream actually opens, and when the ticket changes — not when
   * a new `EventSource` is constructed, which happens on every retry.
   */
  const sessionProbedRef = useRef(false)

  useEffect(() => {
    if (!ticketId) {
      lastEventIdRef.current = '0'
      recoverOnOpenRef.current = false
      return
    }

    const persistedLastEventId = readPersistedLastEventId(ticketId)
    lastEventIdRef.current = persistedLastEventId
    recoverOnOpenRef.current = persistedLastEventId !== '0'
    sessionProbedRef.current = false
  }, [ticketId])

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = setTimeout(() => reconnectRef.current?.(), SSE_RECONNECT_DELAY_MS)
  }, [])

  const connect = useCallback(() => {
    if (!ticketId || !mountedRef.current) return
    const connectToken = ++connectTokenRef.current
    const connectAbortController = new AbortController()
    connectAbortControllerRef.current?.abort()
    connectAbortControllerRef.current = connectAbortController
    setConnectionState((current) => (current === 'reconnecting' ? current : 'connecting'))

    void (async () => {
      try {
        await waitForDevBackend(connectAbortController.signal)
      } catch {
        if (connectToken !== connectTokenRef.current || connectAbortController.signal.aborted) return
        setConnectionState('reconnecting')
        scheduleReconnect()
        return
      } finally {
        if (connectAbortControllerRef.current === connectAbortController) {
          connectAbortControllerRef.current = null
        }
      }

      if (connectToken !== connectTokenRef.current) return
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }

      const url = new URL(getApiUrl('/api/stream'))
      url.searchParams.set('ticketId', String(ticketId))
      if (lastEventIdRef.current && lastEventIdRef.current !== '0') {
        url.searchParams.set('lastEventId', lastEventIdRef.current)
      }

      const es = new EventSource(url.toString())
      eventSourceRef.current = es

      /**
       * Every callback below can fire after this connection stopped being the current
       * one. A closing `EventSource` still dispatches what is already queued, and a
       * reconnect or a ticket switch installs a second set of listeners over a second
       * stream — so a late `open`, message or error would invalidate, patch, or start
       * reconnecting on behalf of whichever ticket is on screen now. That is not the
       * ticket it was listening for. The token settles which connection is current; the
       * reference settles which `EventSource` the ref is holding.
       */
      const isCurrentConnection = () => mountedRef.current
        && es === eventSourceRef.current
        && connectToken === connectTokenRef.current

      es.addEventListener('open', () => {
        if (!isCurrentConnection()) return
        setConnectionState('connected')
        // A stream that opened proves the session is good, so the *next* failure
        // deserves a fresh question. Re-arming per `EventSource` instead meant
        // every scheduled reconnect re-armed it, and a daemon that was simply
        // down was asked about the session every three seconds for as long as
        // the tab stayed open.
        sessionProbedRef.current = false
        if (recoverOnOpenRef.current) {
          recoverOnOpenRef.current = false
          const tid = ticketIdRef.current
          if (tid) recoverTicketAfterStreamGap(tid)
        }
      })

      es.addEventListener('state_change', (e) => {
        if (!isCurrentConnection()) return
        lastEventIdRef.current = e.lastEventId || lastEventIdRef.current
        persistLastEventId(ticketId, lastEventIdRef.current)
        try {
          const data = JSON.parse(e.data) as Record<string, unknown>
          if (ticketId && typeof data.to === 'string' && data.to.length > 0) {
            patchTicketStatusInCache(
              queryClient,
              ticketId,
              data.to,
              typeof data.previousStatus === 'string'
                ? data.previousStatus
                : (typeof data.from === 'string' ? data.from : undefined),
            )
          }
          queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] })
          if (
            data.from === 'GENERATING_QA_CHECKLIST'
            || data.from === 'WAITING_MANUAL_QA'
            || data.previousStatus === 'GENERATING_QA_CHECKLIST'
            || data.previousStatus === 'WAITING_MANUAL_QA'
            || data.to === 'GENERATING_QA_CHECKLIST'
            || data.to === 'WAITING_MANUAL_QA'
          ) {
            invalidateManualQaQueries(ticketId)
          }
          if (data.to === 'WAITING_INTERVIEW_ANSWERS' || data.to === 'WAITING_INTERVIEW_APPROVAL') {
            queryClient.invalidateQueries({ queryKey: ['interview', ticketId] })
          }
          onEventRef.current?.({ type: 'state_change', data })
        } catch {
          // ignore parse errors
        }
      })

      es.addEventListener('progress', (e) => {
        if (!isCurrentConnection()) return
        lastEventIdRef.current = e.lastEventId || lastEventIdRef.current
        persistLastEventId(ticketId, lastEventIdRef.current)
        try {
          const data = JSON.parse(e.data) as Record<string, unknown>
          onEventRef.current?.({ type: 'progress', data })
        } catch {
          // ignore parse errors
        }
      })

      es.addEventListener('log', (e) => {
        if (!isCurrentConnection()) return
        lastEventIdRef.current = e.lastEventId || lastEventIdRef.current
        persistLastEventId(ticketId, lastEventIdRef.current)
        try {
          const data = JSON.parse(e.data) as Record<string, unknown>
          const phase = typeof data.phase === 'string' ? data.phase : ''
          const beadId = typeof data.beadId === 'string' ? data.beadId : ''
          const source = typeof data.source === 'string' ? data.source : ''
          const kind = typeof data.kind === 'string' ? data.kind : ''
          const isStreaming = data.streaming === true

          if (
            ticketId
            && phase === 'CODING'
            && beadId.length > 0
            && !isStreaming
            && (source === 'system' || kind === 'milestone')
          ) {
            queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] })
            queryClient.invalidateQueries({ queryKey: ['ticket-beads', ticketId] })
          }
          onEventRef.current?.({ type: 'log', data })
        } catch {
          // ignore parse errors
        }
      })

      es.addEventListener('app_error', (e) => {
        if (!isCurrentConnection()) return
        lastEventIdRef.current = e.lastEventId || lastEventIdRef.current
        persistLastEventId(ticketId, lastEventIdRef.current)
        try {
          const data = JSON.parse(e.data) as Record<string, unknown>
          onEventRef.current?.({ type: 'app_error', data })
        } catch {
          // ignore parse errors
        }
      })

      es.addEventListener('bead_complete', (e) => {
        if (!isCurrentConnection()) return
        lastEventIdRef.current = e.lastEventId || lastEventIdRef.current
        persistLastEventId(ticketId, lastEventIdRef.current)
        try {
          const data = JSON.parse(e.data) as Record<string, unknown>
          queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] })
          queryClient.invalidateQueries({ queryKey: ['ticket-beads', ticketId] })
          invalidateBeadDiffQuery(ticketId, data.beadId)
          onEventRef.current?.({ type: 'bead_complete', data })
        } catch {
          // ignore parse errors
        }
      })

      es.addEventListener('needs_input', (e) => {
        if (!isCurrentConnection()) return
        lastEventIdRef.current = e.lastEventId || lastEventIdRef.current
        persistLastEventId(ticketId, lastEventIdRef.current)
        try {
          const data = JSON.parse(e.data) as Record<string, unknown>
          queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] })
          if ((data.type === 'interview_batch' || data.type === 'interview_error') && ticketId) {
            queryClient.invalidateQueries({ queryKey: ['interview', ticketId] })
          }
          onEventRef.current?.({ type: 'needs_input', data })
        } catch {
          // ignore parse errors
        }
      })

      es.addEventListener('artifact_change', (e) => {
        if (!isCurrentConnection()) return
        lastEventIdRef.current = e.lastEventId || lastEventIdRef.current
        persistLastEventId(ticketId, lastEventIdRef.current)
        try {
          const data = JSON.parse(e.data) as Record<string, unknown>
          const artifact = data.artifact && typeof data.artifact === 'object'
            ? data.artifact as Record<string, unknown>
            : null
          const artifactTicketId = typeof data.ticketId === 'string'
            ? data.ticketId
            : typeof artifact?.ticketId === 'string'
              ? artifact.ticketId
              : null

          if (ticketId && (!artifactTicketId || artifactTicketId === ticketId)) {
            // artifact_change carries manifest metadata only. Never merge it into
            // body caches, because absent content would temporarily erase a
            // successfully loaded artifact while the API refetch is in flight.
            void queryClient.invalidateQueries({
              queryKey: getTicketArtifactsQueryKey(ticketId),
              exact: true,
            })

            const phases = new Set<string>()
            if (typeof data.phase === 'string') phases.add(data.phase)
            if (typeof artifact?.phase === 'string') phases.add(artifact.phase)
            if (Array.isArray(data.invalidatedPhases)) {
              for (const phase of data.invalidatedPhases) {
                if (typeof phase === 'string') phases.add(phase)
              }
            }
            for (const phase of phases) {
              void queryClient.invalidateQueries({
                queryKey: getTicketArtifactsQueryKey(ticketId, { phase }),
                exact: true,
              })
            }

            const phaseAttempt = typeof artifact?.phaseAttempt === 'number'
              ? artifact.phaseAttempt
              : Number(artifact?.phaseAttempt)
            const artifactPhase = typeof artifact?.phase === 'string'
              ? artifact.phase
              : typeof data.phase === 'string'
                ? data.phase
                : null
            if (artifactPhase && Number.isFinite(phaseAttempt) && phaseAttempt > 0) {
              void queryClient.invalidateQueries({
                queryKey: getTicketArtifactsQueryKey(ticketId, { phase: artifactPhase, phaseAttempt }),
                exact: true,
              })
            }

            const beadId = getBeadIdFromArtifactType(
              typeof data.artifactType === 'string'
                ? data.artifactType
                : typeof artifact?.artifactType === 'string'
                  ? artifact.artifactType
                  : undefined,
            )
            if (beadId) {
              invalidateBeadDiffQuery(ticketId, beadId)
            }

            const artifactType = typeof data.artifactType === 'string'
              ? data.artifactType
              : typeof artifact?.artifactType === 'string'
                ? artifact.artifactType
                : undefined
            if (artifactType?.startsWith('manual_qa_')) {
              invalidateManualQaQueries(ticketId)
            }
          }
          onEventRef.current?.({ type: 'artifact_change', data })
        } catch {
          // ignore parse errors
        }
      })

      es.addEventListener('ai_metrics', (e) => {
        if (!isCurrentConnection()) return
        lastEventIdRef.current = e.lastEventId || lastEventIdRef.current
        persistLastEventId(ticketId, lastEventIdRef.current)
        try {
          const data = JSON.parse(e.data) as Record<string, unknown>
          const metricsTicketId = typeof data.ticketId === 'string' ? data.ticketId : ticketId
          if (metricsTicketId === ticketId) scheduleAiDetailsInvalidation(ticketId)
          onEventRef.current?.({ type: 'ai_metrics', data })
        } catch {
          // ignore parse errors
        }
      })

      es.onerror = () => {
        if (!isCurrentConnection()) return
        es.close()
        eventSourceRef.current = null
        recoverOnOpenRef.current = true
        setConnectionState('reconnecting')
        // The stream cannot report a 401 — `onerror` carries no status — so the
        // first failure of a connection asks an ordinary route instead. Only
        // that answer latches signed-out; a dropped connection does not. Once
        // per connection, not per retry: the reconnect loop would otherwise ask
        // every few seconds forever.
        if (!sessionProbedRef.current) {
          sessionProbedRef.current = true
          void probeSessionAfterStreamFailure()
        }
        const currentTicketId = ticketIdRef.current
        if (currentTicketId) {
          queryClient.invalidateQueries({ queryKey: ['ticket', currentTicketId] })
        }
        queryClient.invalidateQueries({ queryKey: ['tickets'] })
        scheduleReconnect()
      }
    })()
  }, [scheduleReconnect, ticketId])

  useEffect(() => {
    reconnectRef.current = connect
  }, [connect])

  // Deliberately keyed on the ticket rather than folded into the connect cleanup below: that one
  // also runs on every reconnect, and settling a pending invalidation there would turn every
  // reconnect into a refetch. This fires only when the ticket changes or the hook unmounts.
  useEffect(() => {
    if (!ticketId) return
    return () => flushAiDetailsInvalidation(ticketId)
  }, [ticketId])

  useEffect(() => {
    mountedRef.current = true
    queueMicrotask(connect)
    return () => {
      mountedRef.current = false
      connectTokenRef.current += 1
      connectAbortControllerRef.current?.abort()
      connectAbortControllerRef.current = null
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      eventSourceRef.current?.close()
      eventSourceRef.current = null
    }
  }, [connect])

  return { lastEventIdRef, connectionState }
}
