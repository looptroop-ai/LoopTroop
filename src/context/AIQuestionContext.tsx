import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { HelpCircle, X } from 'lucide-react'
import { QUESTION_RECOVERY_INTERVAL_MS } from '@/lib/constants'
import { queryClient } from '@/lib/queryClient'
import { cn } from '@/lib/utils'
import type { Ticket } from '@/hooks/useTickets'
import { useUI } from '@/context/useUI'
import type { AiQuestionTimerState } from '@shared/aiQuestions'
import { getErrorMessage } from '@shared/typeGuards'
import { isTerminalWorkflowStatus } from '@shared/workflowMeta'
import {
  AIQuestionContext,
  type AIQuestionContextValue,
  type AiQuestionInfo,
  type AiQuestionRequest,
} from './aiQuestionContextDef'
import { apiTicketPath } from '@/lib/apiPaths'

interface AiQuestionPayload {
  type: 'opencode_question' | 'opencode_question_resolved' | 'opencode_question_updated'
  action?: 'asked' | 'replied' | 'rejected'
  ticketId: string
  ticketExternalId?: string
  ticketTitle?: string
  status?: string
  phase?: string
  phaseAttempt?: number
  modelId?: string
  sessionId?: string
  requestId?: string
  questions?: AiQuestionInfo[]
  timer?: AiQuestionTimerState
  requests?: Array<Record<string, unknown>>
  timestamp?: string
}

function normalizeQuestion(question: AiQuestionInfo): AiQuestionInfo {
  return {
    question: question.question || question.header || 'AI question',
    header: question.header || 'AI question',
    options: Array.isArray(question.options) ? question.options : [],
    ...(typeof question.multiple === 'boolean' ? { multiple: question.multiple } : {}),
    ...(typeof question.custom === 'boolean' ? { custom: question.custom } : {}),
  }
}

function parseTimer(value: unknown): AiQuestionTimerState | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.timerKey !== 'string' || typeof record.deadlineAt !== 'string') return null
  return {
    timerKey: record.timerKey,
    generation: typeof record.generation === 'number' ? record.generation : 0,
    windowMs: typeof record.windowMs === 'number' ? record.windowMs : 0,
    armedAt: typeof record.armedAt === 'string' ? record.armedAt : record.deadlineAt,
    deadlineAt: record.deadlineAt,
    stoppedAt: typeof record.stoppedAt === 'string' ? record.stoppedAt : null,
    stoppedBy: typeof record.stoppedBy === 'string' ? record.stoppedBy : null,
    resetCount: typeof record.resetCount === 'number' ? record.resetCount : 0,
    revision: typeof record.revision === 'number' ? record.revision : 0,
    serverNow: typeof record.serverNow === 'string' ? record.serverNow : new Date().toISOString(),
  }
}

function parseQuestionPayload(data: Record<string, unknown>): AiQuestionPayload | null {
  const type = data.type
  if (type !== 'opencode_question' && type !== 'opencode_question_resolved' && type !== 'opencode_question_updated') {
    return null
  }
  if (typeof data.ticketId !== 'string') return null
  const questions = Array.isArray(data.questions)
    ? data.questions
        .filter((question): question is AiQuestionInfo => Boolean(question) && typeof question === 'object')
        .map(normalizeQuestion)
    : undefined
  const timer = parseTimer(data.timer)
  return {
    type,
    action: data.action === 'replied' || data.action === 'rejected' || data.action === 'asked' ? data.action : undefined,
    ticketId: data.ticketId,
    ...(typeof data.requestId === 'string' ? { requestId: data.requestId } : {}),
    ...(typeof data.ticketExternalId === 'string' ? { ticketExternalId: data.ticketExternalId } : {}),
    ...(typeof data.ticketTitle === 'string' ? { ticketTitle: data.ticketTitle } : {}),
    ...(typeof data.status === 'string' ? { status: data.status } : {}),
    ...(typeof data.phase === 'string' ? { phase: data.phase } : {}),
    ...(typeof data.phaseAttempt === 'number' ? { phaseAttempt: data.phaseAttempt } : {}),
    ...(typeof data.modelId === 'string' ? { modelId: data.modelId } : {}),
    ...(typeof data.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
    ...(questions ? { questions } : {}),
    ...(timer ? { timer } : {}),
    ...(Array.isArray(data.requests) ? { requests: data.requests as Array<Record<string, unknown>> } : {}),
    ...(typeof data.timestamp === 'string' ? { timestamp: data.timestamp } : {}),
  }
}

function requestKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`
}

function stopKeyTicketId(stopKey: string): string {
  return stopKey.slice(0, stopKey.lastIndexOf(':'))
}

/**
 * Forgets stop receipts for clocks this ticket has moved past.
 *
 * A non-numeric generation is a stop posted before any timer frame arrived; it
 * has no ordering, so it is kept until the ticket itself goes away.
 */
function pruneSupersededStopKeys(stopKeys: Set<string>, ticketId: string, currentGeneration: number): void {
  const prefix = `${ticketId}:`
  for (const stopKey of stopKeys) {
    if (!stopKey.startsWith(prefix)) continue
    const generation = Number(stopKey.slice(prefix.length))
    if (Number.isFinite(generation) && generation < currentGeneration) stopKeys.delete(stopKey)
  }
}

/** Drops this ticket's requests that the authoritative `live` set does not name. */
function pruneTicketRequests(
  setRequests: Dispatch<SetStateAction<Record<string, AiQuestionRequest>>>,
  ticketId: string,
  live: Set<string>,
): void {
  setRequests((current) => {
    const stale = Object.keys(current).filter((key) => current[key]?.ticketId === ticketId && !live.has(key))
    if (stale.length === 0) return current
    const next = { ...current }
    for (const key of stale) delete next[key]
    return next
  })
}

export function AIQuestionProvider({ tickets, children }: { tickets: Ticket[]; children: ReactNode }) {
  const { state: uiState } = useUI()
  const selectedTicketId = uiState.selectedTicketId
  const [requests, setRequests] = useState<Record<string, AiQuestionRequest>>({})
  const [timers, setTimers] = useState<Record<string, AiQuestionTimerState>>({})
  const [dismissedTickets, setDismissedTickets] = useState<Set<string>>(new Set())
  /**
   * How far this browser's clock is ahead of the server's.
   *
   * The deadline is the server's, always. Correcting for skew once means the
   * countdown a viewer sees matches the one that will actually fire, on a
   * machine whose clock is minutes out.
   */
  const clockOffsetRef = useRef(0)
  /**
   * Clocks whose stop has already been posted, so typing does not re-post.
   *
   * Keyed by the clock's `generation`, not by the ticket and not by `timerKey`.
   * Once a question on CODING was stopped, keying on the ticket made every later
   * clock look already-stopped and the browser never sent Stop again; keying on
   * `timerKey` fixed that only until the *same* step asked a second time, which
   * reuses the key.
   */
  const stoppedTimersRef = useRef(new Set<string>())
  /**
   * The newest `refreshTicket` call per ticket.
   *
   * A snapshot is authoritative — it prunes anything it does not list — so an
   * older response landing after a newer one deletes questions that are still
   * live. Only the current generation is allowed to apply.
   */
  const refreshGenerationsRef = useRef(new Map<string, number>())

  const ticketsById = useMemo(() => new Map(tickets.map((ticket) => [ticket.id, ticket])), [tickets])
  const activeTickets = useMemo(() => tickets.filter((ticket) => !isTerminalWorkflowStatus(ticket.status)), [tickets])
  const activeTicketIds = useMemo(() => new Set(activeTickets.map((ticket) => ticket.id)), [activeTickets])
  const activeTicketKey = useMemo(() => activeTickets.map((ticket) => ticket.id).sort().join('|'), [activeTickets])
  /**
   * The active set, for the poll to read without depending on it.
   *
   * `activeTicketIds` is a fresh `Set` on every tickets refetch — ten seconds
   * apart — so listing it in the poll's dependencies tore the interval down and
   * fired a fresh `/api/opencode/questions` each time, whichever tickets were
   * active. `activeTicketKey` changes only when the membership does. Written in
   * an effect declared before the poll's, so it is current when `recover` runs.
   */
  const activeTicketIdsRef = useRef(activeTicketIds)
  useEffect(() => {
    activeTicketIdsRef.current = activeTicketIds
  }, [activeTicketIds])

  const noteServerClock = useCallback((timer: AiQuestionTimerState | null | undefined) => {
    if (!timer?.serverNow) return
    const serverNow = Date.parse(timer.serverNow)
    if (Number.isNaN(serverNow)) return
    clockOffsetRef.current = Date.now() - serverNow
  }, [])

  const applyTimer = useCallback((ticketId: string, timer: AiQuestionTimerState | null) => {
    noteServerClock(timer)
    setTimers((current) => {
      if (!timer) {
        if (!current[ticketId]) return current
        const next = { ...current }
        delete next[ticketId]
        return next
      }
      const existing = current[ticketId]
      // A late frame must never undo a newer one. The server bumps `revision`
      // on every transition precisely so an out-of-order delivery is detectable
      // — but only within one clock, and revisions restart at 1 for each new
      // one. `timerKey` cannot separate them either: a step that asks, is
      // answered, and asks again arms a second clock under the same key, so a
      // key-scoped comparison would read the new countdown as a stale frame and
      // keep showing one that has already gone. `generation` is what actually
      // identifies the clock.
      if (existing && (
        existing.generation > timer.generation
        || (existing.generation === timer.generation && existing.revision > timer.revision)
      )) {
        return current
      }
      return { ...current, [ticketId]: timer }
    })
    if (timer?.stoppedAt) stoppedTimersRef.current.add(`${ticketId}:${timer.generation}`)
    // A clock that has been superseded can never be stopped again, so its entry
    // is dead weight in a set that otherwise grows for the life of the tab. The
    // current generation's entry stays: that is what stops a burst of keystrokes
    // posting Stop more than once.
    if (timer) pruneSupersededStopKeys(stoppedTimersRef.current, ticketId, timer.generation)
  }, [noteServerClock])

  const removeRequest = useCallback((sessionId: string, requestId: string) => {
    setRequests((current) => {
      const key = requestKey(sessionId, requestId)
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }, [])

  const upsertRequest = useCallback((payload: AiQuestionPayload) => {
    if (!payload.requestId || !payload.sessionId || !payload.questions?.length) return
    const { requestId, sessionId, questions } = payload
    const ticket = ticketsById.get(payload.ticketId)
    setRequests((current) => {
      const key = requestKey(sessionId, requestId)
      // Never clobber a draft the operator is part-way through typing.
      if (current[key]) return current
      return {
        ...current,
        [key]: {
          ticketId: payload.ticketId,
          ticketExternalId: payload.ticketExternalId ?? ticket?.externalId ?? payload.ticketId,
          ticketTitle: payload.ticketTitle ?? ticket?.title ?? 'Ticket',
          status: payload.status ?? ticket?.status ?? payload.phase ?? 'UNKNOWN',
          phase: payload.phase ?? payload.status ?? ticket?.status ?? 'UNKNOWN',
          ...(typeof payload.phaseAttempt === 'number' ? { phaseAttempt: payload.phaseAttempt } : {}),
          ...(payload.modelId ? { modelId: payload.modelId } : {}),
          sessionId,
          requestId,
          questions: questions.map(normalizeQuestion),
          receivedAt: payload.timestamp ?? new Date().toISOString(),
          submitting: false,
        },
      }
    })
  }, [ticketsById])

  const ingestPayload = useCallback((payload: AiQuestionPayload) => {
    if (payload.type === 'opencode_question_resolved') {
      if (payload.sessionId && payload.requestId) removeRequest(payload.sessionId, payload.requestId)
      // The card has to leave Needs Input too. Without this a question refused
      // by its own timer, or answered in another tab, left the board showing a
      // ticket waiting on input that nothing was waiting on.
      void queryClient.invalidateQueries({ queryKey: ['tickets'] })
      return
    }
    if (payload.type === 'opencode_question_updated') {
      applyTimer(payload.ticketId, payload.timer ?? null)
      // Carries the step's whole pending set, so it is also how this client
      // learns a request went away — which moves the card.
      void queryClient.invalidateQueries({ queryKey: ['tickets'] })
      // The update carries the full pending set for the step, so it is also the
      // signal that a request this client never saw arrive is now outstanding.
      // Its rows use the server's own vocabulary (`memberId`) and omit the
      // ticket fields that sit on the envelope, so both are mapped across —
      // `upsertRequest` never overwrites an existing row, which would otherwise
      // leave the first arrival permanently unlabelled.
      const live = new Set<string>()
      for (const raw of payload.requests ?? []) {
        const parsed = parseQuestionPayload({
          ...raw,
          type: 'opencode_question',
          ticketId: payload.ticketId,
          ...(typeof raw.memberId === 'string' ? { modelId: raw.memberId } : {}),
          ...(payload.ticketExternalId ? { ticketExternalId: payload.ticketExternalId } : {}),
          ...(payload.ticketTitle ? { ticketTitle: payload.ticketTitle } : {}),
          ...(payload.status ? { status: payload.status } : {}),
        })
        if (!parsed?.sessionId || !parsed.requestId) continue
        live.add(requestKey(parsed.sessionId, parsed.requestId))
        upsertRequest(parsed)
      }
      // The set is the step's whole pending list, so it also says what is gone.
      // Only upserting meant a request dropped without an explicit `resolved`
      // event stayed answerable until the 30-second poll noticed. An update that
      // carries no `requests` array is not a statement about the set, and prunes
      // nothing.
      if (Array.isArray(payload.requests)) pruneTicketRequests(setRequests, payload.ticketId, live)
      return
    }
    upsertRequest(payload)
    if (payload.timer) applyTimer(payload.ticketId, payload.timer)
    // Without this the card never moves into Needs Input, however live the panel is.
    void queryClient.invalidateQueries({ queryKey: ['tickets'] })
  }, [applyTimer, removeRequest, upsertRequest])

  const ingestSseEvent = useCallback((data: Record<string, unknown>) => {
    const payload = parseQuestionPayload(data)
    if (payload) ingestPayload(payload)
  }, [ingestPayload])

  const applyTicketSnapshot = useCallback((
    ticketId: string,
    rawQuestions: Array<Record<string, unknown>>,
    timer: AiQuestionTimerState | null,
  ) => {
    const live = new Set<string>()
    for (const raw of rawQuestions) {
      const payload = parseQuestionPayload(raw)
      if (!payload?.sessionId || !payload.requestId) continue
      live.add(requestKey(payload.sessionId, payload.requestId))
      upsertRequest(payload)
    }
    // A successful fetch is authoritative for this ticket: anything it does not
    // list was resolved elsewhere, and leaving it on screen would show a
    // question nobody can answer. A *failed* fetch prunes nothing.
    pruneTicketRequests(setRequests, ticketId, live)
    applyTimer(ticketId, timer)
  }, [applyTimer, upsertRequest])

  const refreshTicket = useCallback((ticketId: string) => {
    const generation = (refreshGenerationsRef.current.get(ticketId) ?? 0) + 1
    refreshGenerationsRef.current.set(ticketId, generation)
    void (async () => {
      try {
        const res = await fetch(apiTicketPath(ticketId, 'opencode', 'questions'))
        if (!res.ok) return
        const body = await res.json() as { questions?: Array<Record<string, unknown>>; timer?: unknown }
        // The snapshot prunes, so applying an older one deletes questions that
        // are still live.
        if (refreshGenerationsRef.current.get(ticketId) !== generation) return
        applyTicketSnapshot(ticketId, Array.isArray(body.questions) ? body.questions : [], parseTimer(body.timer))
      } catch {
        // Best-effort; the aggregate poll is the backstop.
      }
    })()
  }, [applyTicketSnapshot])

  /**
   * The aggregate poll.
   *
   * SSE is per-ticket and capped at a handful of connections, so the provider
   * cannot subscribe to every ticket at once. The open ticket gets real-time
   * updates forwarded from its dashboard stream; every *other* ticket is
   * discovered here. Latency only affects how quickly the slide-in bar appears
   * — the countdown it leads to is the server's, so it is right on arrival
   * however late the discovery was.
   */
  useEffect(() => {
    let cancelled = false

    const recover = async () => {
      const activeIds = activeTicketIdsRef.current
      if (activeIds.size === 0) return
      try {
        const res = await fetch('/api/opencode/questions')
        if (!res.ok) return
        const body = await res.json() as {
          questions?: Array<Record<string, unknown>>
          timers?: Record<string, unknown>
        }
        if (cancelled || !Array.isArray(body.questions)) return

        const byTicket = new Map<string, Array<Record<string, unknown>>>()
        for (const raw of body.questions) {
          const ticketId = typeof raw.ticketId === 'string' ? raw.ticketId : null
          if (!ticketId || !activeIds.has(ticketId)) continue
          const bucket = byTicket.get(ticketId) ?? []
          bucket.push(raw)
          byTicket.set(ticketId, bucket)
        }
        for (const ticketId of activeIds) {
          applyTicketSnapshot(ticketId, byTicket.get(ticketId) ?? [], parseTimer(body.timers?.[ticketId]))
        }
      } catch {
        // Leave what is already known standing; an unreachable server is not
        // evidence that a question went away.
      }
    }

    void recover()
    const interval = setInterval(() => void recover(), QUESTION_RECOVERY_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [activeTicketKey, applyTicketSnapshot])

  /**
   * Everything belonging to a ticket that is finished or no longer listed.
   *
   * Requests were retained for the life of the tab, so a cancelled or completed
   * ticket kept an answer-and-skip affordance for a step nothing is waiting on,
   * and `dismissedTickets` and the stop-receipt set grew without bound behind
   * it. Membership is what this keys on, not the ticket objects, so it runs when
   * a ticket arrives or leaves rather than on every ten-second refetch.
   */
  useEffect(() => {
    const activeIds = activeTicketIdsRef.current

    setRequests((current) => {
      const stale = Object.keys(current).filter((key) => !activeIds.has(current[key]!.ticketId))
      if (stale.length === 0) return current
      const next = { ...current }
      for (const key of stale) delete next[key]
      return next
    })

    setTimers((current) => {
      const stale = Object.keys(current).filter((ticketId) => !activeIds.has(ticketId))
      if (stale.length === 0) return current
      const next = { ...current }
      for (const ticketId of stale) delete next[ticketId]
      return next
    })

    setDismissedTickets((current) => {
      const stale = [...current].filter((ticketId) => !activeIds.has(ticketId))
      if (stale.length === 0) return current
      const next = new Set(current)
      for (const ticketId of stale) next.delete(ticketId)
      return next
    })

    for (const stopKey of stoppedTimersRef.current) {
      if (!activeIds.has(stopKeyTicketId(stopKey))) stoppedTimersRef.current.delete(stopKey)
    }
    for (const ticketId of refreshGenerationsRef.current.keys()) {
      if (!activeIds.has(ticketId)) refreshGenerationsRef.current.delete(ticketId)
    }
  }, [activeTicketKey])

  const ticketRequests = useCallback((ticketId: string) => Object.values(requests)
    .filter((request) => request.ticketId === ticketId)
    .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt)), [requests])

  const getPendingCount = useCallback((ticketId: string) => ticketRequests(ticketId)
    .reduce((total, request) => total + request.questions.length, 0), [ticketRequests])

  const getRequestCount = useCallback((ticketId: string) => ticketRequests(ticketId).length, [ticketRequests])

  const getTimer = useCallback((ticketId: string) => timers[ticketId] ?? null, [timers])

  const getRemainingMs = useCallback((ticketId: string) => {
    const timer = timers[ticketId]
    if (!timer || timer.stoppedAt) return null
    const deadline = Date.parse(timer.deadlineAt)
    if (Number.isNaN(deadline)) return null
    return Math.max(0, deadline + clockOffsetRef.current - Date.now())
  }, [timers])

  const setSubmitting = useCallback((sessionId: string, requestId: string, submitting: boolean, error?: string) => {
    setRequests((current) => {
      const key = requestKey(sessionId, requestId)
      const existing = current[key]
      if (!existing) return current
      return { ...current, [key]: { ...existing, submitting, ...(error ? { error } : { error: undefined }) } }
    })
  }, [])

  const stopTimer = useCallback((ticketId: string) => {
    const stopKey = `${ticketId}:${timers[ticketId]?.generation ?? 'unknown'}`
    if (stoppedTimersRef.current.has(stopKey)) return
    // Marked before the request lands so a burst of keystrokes posts once.
    stoppedTimersRef.current.add(stopKey)
    void (async () => {
      try {
        const res = await fetch(apiTicketPath(ticketId, 'opencode', 'question-timer', 'stop'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        if (!res.ok) {
          stoppedTimersRef.current.delete(stopKey)
          return
        }
        const body = await res.json() as { timer?: unknown }
        const timer = parseTimer(body.timer)
        if (timer) applyTimer(ticketId, timer)
      } catch {
        stoppedTimersRef.current.delete(stopKey)
      }
    })()
  }, [applyTimer, timers])

  const submitToRoute = useCallback((
    ticketId: string,
    requestId: string,
    path: string,
    body: unknown,
    failureMessage: string,
  ) => {
    const request = Object.values(requests).find((candidate) => (
      candidate.ticketId === ticketId && candidate.requestId === requestId
    ))
    if (!request) return
    setSubmitting(request.sessionId, requestId, true)
    void fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (res) => {
      if (!res.ok) {
        const detail = await res.json().catch(() => ({})) as { error?: string; details?: string }
        throw new Error(detail.details ?? detail.error ?? failureMessage)
      }
      removeRequest(request.sessionId, requestId)
      void queryClient.invalidateQueries({ queryKey: ['tickets'] })
    }).catch((error: unknown) => {
      setSubmitting(request.sessionId, requestId, false, getErrorMessage(error))
    })
  }, [removeRequest, requests, setSubmitting])

  const answerRequest = useCallback((ticketId: string, requestId: string, answers: string[][]) => {
    submitToRoute(
      ticketId,
      requestId,
      apiTicketPath(ticketId, 'opencode', 'questions', requestId, 'reply'),
      { answers },
      'Could not send that answer',
    )
  }, [submitToRoute])

  const skipRequest = useCallback((ticketId: string, requestId: string, reason: string | null) => {
    submitToRoute(
      ticketId,
      requestId,
      apiTicketPath(ticketId, 'opencode', 'questions', requestId, 'reject'),
      reason ? { reason } : {},
      'Could not skip that question',
    )
  }, [submitToRoute])

  const value = useMemo<AIQuestionContextValue>(() => ({
    getPendingCount,
    getRequestCount,
    getTicketRequests: ticketRequests,
    getTimer,
    getRemainingMs,
    answerRequest,
    skipRequest,
    stopTimer,
    ingestSseEvent,
    refreshTicket,
  }), [
    answerRequest,
    getPendingCount,
    getRemainingMs,
    getRequestCount,
    getTimer,
    ingestSseEvent,
    refreshTicket,
    skipRequest,
    stopTimer,
    ticketRequests,
  ])

  const waitingTickets = useMemo(() => {
    const seen = new Map<string, AiQuestionRequest>()
    for (const request of Object.values(requests)) {
      // A finished or removed ticket is not waiting on anybody, whatever this
      // provider is still holding for it.
      if (!activeTicketIds.has(request.ticketId)) continue
      if (!seen.has(request.ticketId)) seen.set(request.ticketId, request)
    }
    return [...seen.values()].filter((request) => !dismissedTickets.has(request.ticketId))
  }, [activeTicketIds, dismissedTickets, requests])

  return (
    <AIQuestionContext.Provider value={value}>
      {children}
      <AiQuestionSlideInBar
        waiting={waitingTickets}
        selectedTicketId={selectedTicketId}
        onDismiss={(ticketId) => setDismissedTickets((current) => new Set(current).add(ticketId))}
      />
    </AIQuestionContext.Provider>
  )
}

/**
 * The strip that slides down when a question is waiting somewhere you cannot see.
 *
 * Fixed to the top rather than a row in the layout, and that is a compromise
 * worth naming: the ticket dashboard is `fixed inset-0 z-[60]` and Configuration
 * is a modal route, so a bar in normal flow would be painted over by exactly the
 * screens you need it on. The cost is that it covers the app header while it is
 * up. It is dismissible for the session, and only ever names tickets other than
 * the one on screen — the ticket you are looking at already has the panel.
 *
 */
function AiQuestionSlideInBar({
  waiting,
  selectedTicketId,
  onDismiss,
}: {
  waiting: AiQuestionRequest[]
  selectedTicketId: string | null
  onDismiss: (ticketId: string) => void
}) {
  const { dispatch } = useUI()
  // The ticket on screen already shows the panel; naming it here would be noise.
  const elsewhere = waiting.filter((request) => request.ticketId !== selectedTicketId)
  const first = elsewhere[0]

  if (!first) return null

  const others = elsewhere.length - 1
  const label = others > 0
    ? `${first.ticketExternalId} and ${others} other ticket${others === 1 ? '' : 's'} are waiting on a question`
    : `${first.ticketExternalId} is waiting on a question`

  return (
    <div
      className={cn(
        'fixed inset-x-0 top-0 z-[70] flex items-center gap-3 border-b border-sky-200 bg-sky-50/95 px-4 py-2',
        'shadow-sm backdrop-blur lt-slide-in-top',
        'dark:border-sky-900/60 dark:bg-sky-950/90',
      )}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm text-sky-900 hover:underline dark:text-sky-100"
        onClick={() => {
          dispatch({ type: 'SELECT_TICKET', ticketId: first.ticketId, externalId: first.ticketExternalId })
        }}
      >
        <HelpCircle className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        className="rounded p-1 text-sky-900/70 hover:bg-sky-100 hover:text-sky-900 dark:text-sky-200/70 dark:hover:bg-sky-900/50 dark:hover:text-sky-100"
        onClick={() => onDismiss(first.ticketId)}
        aria-label={`Dismiss the notice for ${first.ticketExternalId}`}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
