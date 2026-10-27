import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AssistantScope, AssistantSession, AssistantSessionSummary } from '@shared/assistant'
import { describeQueryError } from '@/lib/fetchError'
import {
  closeAssistantSession,
  createAssistantSession,
  fetchAssistantSession,
  fetchAssistantSessions,
  readAssistantEvents,
  sendAssistantMessage,
} from '@/components/assistant/assistantApi'

interface AssistantScopeState {
  sessions: AssistantSessionSummary[]
  openIds: string[]
  openedAt: Record<string, number>
  openGeneration: number
  activeId: string | null
  drafts: Record<string, string>
  loading: boolean
  openingId: string | null
  creating: boolean
  closingIds: string[]
  error: string | null
}

const EMPTY_SCOPE_STATE: AssistantScopeState = {
  sessions: [],
  openIds: [],
  openedAt: {},
  openGeneration: 0,
  activeId: null,
  drafts: {},
  loading: false,
  openingId: null,
  creating: false,
  closingIds: [],
  error: null,
}

function summaryOf(session: AssistantSession): AssistantSessionSummary {
  const { messages: _messages, canResume: _canResume, saved: _saved, ...summary } = session
  return summary
}

export function useAssistant(scope: AssistantScope, enabled: boolean) {
  const stableScope = useMemo<AssistantScope>(() => ({
    mode: scope.mode,
    ...(scope.ticketId ? { ticketId: scope.ticketId } : {}),
  }), [scope.mode, scope.ticketId])
  const scopeKey = `${stableScope.mode}:${stableScope.ticketId ?? ''}`
  const currentScopeKeyRef = useRef(scopeKey)
  currentScopeKeyRef.current = scopeKey
  const [scopes, setScopes] = useState<Record<string, AssistantScopeState>>({})
  const scopesRef = useRef(scopes)
  scopesRef.current = scopes
  const [details, setDetails] = useState<Record<string, AssistantSession>>({})
  const [pendingReplies, setPendingReplies] = useState<Record<string, { sessionId: string; message: string; reply: string }>>({})
  const [sendingIds, setSendingIds] = useState<string[]>([])
  const [scopedRefresh, setScopedRefresh] = useState(0)
  const controllers = useRef(new Set<AbortController>())
  const detailRequests = useRef(new Map<string, AbortController>())
  const activeStreams = useRef(new Map<string, AbortController>())
  const current = scopes[scopeKey] ?? EMPTY_SCOPE_STATE
  const activeId = current.activeId
  const activeDetail = activeId ? details[activeId] ?? null : null

  const updateScope = useCallback((key: string, update: (state: AssistantScopeState) => AssistantScopeState) => {
    setScopes(previous => {
      const nextState = update(previous[key] ?? EMPTY_SCOPE_STATE)
      const next = { ...previous }
      if (key !== currentScopeKeyRef.current && nextState.openIds.length === 0 && !nextState.loading && !nextState.creating && nextState.closingIds.length === 0) {
        delete next[key]
      } else {
        next[key] = nextState
      }
      return next
    })
  }, [])

  const beginRequest = useCallback(() => {
    const controller = new AbortController()
    controllers.current.add(controller)
    return controller
  }, [])
  const endRequest = useCallback((controller: AbortController) => {
    controllers.current.delete(controller)
  }, [])

  useEffect(() => () => {
    for (const controller of controllers.current) controller.abort()
    controllers.current.clear()
    detailRequests.current.clear()
    activeStreams.current.clear()
  }, [])

  useEffect(() => {
    setScopes(previous => {
      let changed = false
      const next = { ...previous }
      for (const [key, state] of Object.entries(previous)) {
        if (key === scopeKey) continue
        if (state.openIds.length === 0 && !state.loading && !state.creating && state.closingIds.length === 0) {
          delete next[key]
          changed = true
          continue
        }
        const openIds = new Set(state.openIds)
        const sessions = state.sessions.filter(session => openIds.has(session.id))
        if (sessions.length !== state.sessions.length) {
          next[key] = { ...state, sessions }
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [scopeKey])

  useEffect(() => {
    if (!enabled) return
    const scopeAtRequestStart = scopesRef.current[scopeKey] ?? EMPTY_SCOPE_STATE
    const openIdsAtRequestStart = new Set(scopeAtRequestStart.openIds)
    const openGenerationAtRequestStart = scopeAtRequestStart.openGeneration
    const controller = beginRequest()
    updateScope(scopeKey, state => ({ ...state, loading: true, error: null }))
    void fetchAssistantSessions(stableScope, controller.signal).then(nextSessions => {
      if (controller.signal.aborted) return
      const knownIds = new Set(nextSessions.map(session => session.id))
      const currentState = scopesRef.current[scopeKey] ?? EMPTY_SCOPE_STATE
      const evictedIds = [...openIdsAtRequestStart].filter(id => (
        !knownIds.has(id) && (currentState.openedAt[id] ?? 0) <= openGenerationAtRequestStart
      ))
      for (const id of evictedIds) {
        detailRequests.current.get(id)?.abort()
        activeStreams.current.get(id)?.abort()
        activeStreams.current.delete(id)
      }
      if (evictedIds.length > 0) {
        const evicted = new Set(evictedIds)
        setDetails(previous => {
          const next = { ...previous }
          for (const id of evicted) delete next[id]
          return next
        })
        setPendingReplies(previous => {
          const next = { ...previous }
          for (const id of evicted) delete next[id]
          return next
        })
        setSendingIds(previous => previous.filter(id => !evicted.has(id)))
      }
      updateScope(scopeKey, state => {
        const carriedSessions = state.sessions.filter(session => {
          const openedDuringRequest = (state.openedAt[session.id] ?? 0) > openGenerationAtRequestStart
          return state.openIds.includes(session.id) && openedDuringRequest && !knownIds.has(session.id)
        })
        const carriedIds = new Set(carriedSessions.map(session => session.id))
        const remainingOpenIds = state.openIds.filter(id => knownIds.has(id) || carriedIds.has(id))
        const remainingOpenIdSet = new Set(remainingOpenIds)
        const openIds = [
          ...remainingOpenIds,
          ...nextSessions.filter(session => !session.archived && !remainingOpenIdSet.has(session.id)).map(session => session.id),
        ]
        const keptOpenIds = new Set(openIds)
        const openedAt = { ...state.openedAt }
        for (const id of Object.keys(openedAt)) {
          if (!keptOpenIds.has(id)) delete openedAt[id]
        }
        let openGeneration = state.openGeneration
        for (const id of openIds) {
          if (openedAt[id] !== undefined) continue
          openGeneration += 1
          openedAt[id] = openGeneration
        }
        return {
          ...state,
          sessions: [...nextSessions, ...carriedSessions],
          openIds,
          openedAt,
          openGeneration,
          drafts: Object.fromEntries(Object.entries(state.drafts).filter(([id]) => keptOpenIds.has(id))),
          activeId: openIds.includes(state.activeId ?? '') ? state.activeId : openIds[0] ?? null,
          loading: false,
        }
      })
    }).catch(caught => {
      if (!controller.signal.aborted) updateScope(scopeKey, state => ({
        ...state,
        error: describeQueryError(caught) ?? 'Could not load assistant conversations.',
      }))
    }).finally(() => {
      endRequest(controller)
      if (!controller.signal.aborted) updateScope(scopeKey, state => ({ ...state, loading: false }))
    })
    return () => {
      controller.abort()
      endRequest(controller)
      updateScope(scopeKey, state => ({ ...state, loading: false }))
    }
  }, [beginRequest, enabled, endRequest, scopeKey, scopedRefresh, stableScope, updateScope])

  useEffect(() => {
    if (!enabled || !activeId || activeDetail) return
    const controller = beginRequest()
    const requests = detailRequests.current
    requests.set(activeId, controller)
    updateScope(scopeKey, state => ({ ...state, openingId: activeId, error: null }))
    void fetchAssistantSession(activeId, stableScope, controller.signal).then(session => {
      if (controller.signal.aborted) return
      setDetails(previous => ({ ...previous, [session.id]: session }))
      updateScope(scopeKey, state => ({
        ...state,
        sessions: [summaryOf(session), ...state.sessions.filter(item => item.id !== session.id)],
      }))
    }).catch(caught => {
      if (!controller.signal.aborted) updateScope(scopeKey, state => ({
        ...state,
        error: describeQueryError(caught) ?? 'Could not open assistant conversation.',
      }))
    }).finally(() => {
      endRequest(controller)
      if (requests.get(activeId) === controller) requests.delete(activeId)
      if (!controller.signal.aborted) updateScope(scopeKey, state => ({
        ...state,
        openingId: state.openingId === activeId ? null : state.openingId,
      }))
    })
    return () => {
      controller.abort()
      endRequest(controller)
      if (requests.get(activeId) === controller) requests.delete(activeId)
      updateScope(scopeKey, state => ({
        ...state,
        openingId: state.openingId === activeId ? null : state.openingId,
      }))
    }
  }, [activeDetail, activeId, beginRequest, enabled, endRequest, scopeKey, stableScope, updateScope])

  const setError = useCallback((error: string | null) => {
    updateScope(scopeKey, state => ({ ...state, error }))
  }, [scopeKey, updateScope])

  const selectSession = useCallback((id: string, summary?: AssistantSessionSummary) => {
    updateScope(scopeKey, state => {
      const alreadyOpen = state.openIds.includes(id)
      const openGeneration = alreadyOpen ? state.openGeneration : state.openGeneration + 1
      return {
        ...state,
        error: null,
        sessions: summary ? [summary, ...state.sessions.filter(item => item.id !== summary.id)] : state.sessions,
        openIds: alreadyOpen ? state.openIds : [id, ...state.openIds],
        openedAt: alreadyOpen ? state.openedAt : { ...state.openedAt, [id]: openGeneration },
        openGeneration,
        activeId: id,
      }
    })
  }, [scopeKey, updateScope])

  const setDraft = useCallback((id: string, value: string) => {
    updateScope(scopeKey, state => {
      if (!state.openIds.includes(id)) return state
      const drafts = { ...state.drafts }
      if (value) drafts[id] = value
      else delete drafts[id]
      return { ...state, drafts }
    })
  }, [scopeKey, updateScope])

  const createSession = useCallback(async () => {
    const controller = beginRequest()
    updateScope(scopeKey, state => ({ ...state, creating: true, error: null }))
    try {
      const session = await createAssistantSession(stableScope, controller.signal)
      if (controller.signal.aborted) return
      updateScope(scopeKey, state => ({
        ...state,
        sessions: [summaryOf(session), ...state.sessions.filter(item => item.id !== session.id)],
        openIds: [session.id, ...state.openIds.filter(id => id !== session.id)],
        openedAt: { ...state.openedAt, [session.id]: state.openGeneration + 1 },
        openGeneration: state.openGeneration + 1,
        activeId: session.id,
        creating: false,
      }))
      setDetails(previous => ({ ...previous, [session.id]: session }))
    } catch (caught) {
      if (!controller.signal.aborted) updateScope(scopeKey, state => ({
        ...state,
        error: describeQueryError(caught) ?? 'Could not start an assistant conversation.',
      }))
    } finally {
      endRequest(controller)
      if (!controller.signal.aborted) updateScope(scopeKey, state => ({ ...state, creating: false }))
    }
  }, [beginRequest, endRequest, scopeKey, stableScope, updateScope])

  const closeSession = useCallback(async (id: string): Promise<boolean> => {
    const controller = beginRequest()
    updateScope(scopeKey, state => ({
      ...state,
      closingIds: state.closingIds.includes(id) ? state.closingIds : [...state.closingIds, id],
      error: null,
    }))
    try {
      await closeAssistantSession(id, stableScope, controller.signal)
      if (controller.signal.aborted) return false
      activeStreams.current.get(id)?.abort()
      activeStreams.current.delete(id)
      setSendingIds(previous => previous.filter(sessionId => sessionId !== id))
      setPendingReplies(previous => {
        const next = { ...previous }
        delete next[id]
        return next
      })
      updateScope(scopeKey, state => {
        const openIds = state.openIds.filter(openId => openId !== id)
        const openedAt = { ...state.openedAt }
        delete openedAt[id]
        const drafts = { ...state.drafts }
        delete drafts[id]
        return {
          ...state,
          sessions: state.sessions.filter(session => session.id !== id),
          openIds,
          openedAt,
          drafts,
          activeId: state.activeId === id ? openIds[0] ?? null : state.activeId,
          error: null,
        }
      })
      setDetails(previous => {
        const next = { ...previous }
        delete next[id]
        return next
      })
      setScopedRefresh(value => value + 1)
      return true
    } catch (caught) {
      if (!controller.signal.aborted) updateScope(scopeKey, state => ({
        ...state,
        error: describeQueryError(caught) ?? 'Could not close assistant conversation.',
      }))
      return false
    } finally {
      endRequest(controller)
      if (!controller.signal.aborted) updateScope(scopeKey, state => ({
        ...state,
        closingIds: state.closingIds.filter(sessionId => sessionId !== id),
      }))
    }
  }, [beginRequest, endRequest, scopeKey, stableScope, updateScope])

  const sendMessage = useCallback(async (message: string): Promise<boolean> => {
    const session = activeId ? details[activeId] : null
    if (!session?.canResume || !message.trim() || activeStreams.current.has(session.id)) return false
    const controller = beginRequest()
    activeStreams.current.set(session.id, controller)
    setSendingIds(previous => previous.includes(session.id) ? previous : [...previous, session.id])
    setPendingReplies(previous => ({
      ...previous,
      [session.id]: { sessionId: session.id, message: message.trim(), reply: '' },
    }))
    setError(null)
    try {
      const response = await sendAssistantMessage(session.id, message.trim(), stableScope, controller.signal)
      let finished = false
      for await (const event of readAssistantEvents(response, controller.signal)) {
        if (controller.signal.aborted) return false
        if (event.type === 'delta') {
          setPendingReplies(previous => {
            const pending = previous[session.id]
            return pending ? { ...previous, [session.id]: { ...pending, reply: pending.reply + event.text } } : previous
          })
        } else if (event.type === 'error') {
          throw new Error(event.error)
        } else {
          finished = true
          setDetails(previous => ({ ...previous, [event.session.id]: event.session }))
          updateScope(scopeKey, state => ({
            ...state,
            sessions: [summaryOf(event.session), ...state.sessions.filter(item => item.id !== event.session.id)],
            error: null,
          }))
          setPendingReplies(previous => {
            const next = { ...previous }
            delete next[session.id]
            return next
          })
        }
      }
      if (!finished && !controller.signal.aborted) throw new Error('The assistant response ended before it was complete.')
      return finished
    } catch (caught) {
      if (!controller.signal.aborted) {
        setPendingReplies(previous => {
          const next = { ...previous }
          delete next[session.id]
          return next
        })
        setError(describeQueryError(caught) ?? 'Could not send the assistant message.')
      }
      return false
    } finally {
      endRequest(controller)
      if (activeStreams.current.get(session.id) === controller) activeStreams.current.delete(session.id)
      setSendingIds(previous => previous.filter(id => id !== session.id))
    }
  }, [activeId, beginRequest, details, endRequest, scopeKey, setError, stableScope, updateScope])

  return {
    sessions: current.sessions,
    openIds: current.openIds,
    drafts: current.drafts,
    activeId,
    activeSession: activeDetail,
    loading: current.loading,
    opening: current.openingId === activeId && activeId !== null,
    creating: current.creating,
    closingIds: current.closingIds,
    sending: activeId !== null && sendingIds.includes(activeId),
    pendingReply: activeId ? pendingReplies[activeId] ?? null : null,
    error: current.error,
    setError,
    setDraft,
    selectSession,
    createSession,
    closeSession,
    sendMessage,
  }
}
