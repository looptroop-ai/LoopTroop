import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AssistantScope, AssistantSession, AssistantSessionSummary } from '@shared/assistant'
import { describeQueryError } from '@/lib/fetchError'
import {
  closeAssistantSession,
  createAssistantSession,
  fetchAssistantSession,
  fetchAssistantHistory,
  renameAssistantSession,
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
    ...(scope.ticketId ? { ticketId: scope.ticketId } : {}),
  }), [scope.ticketId])
  const scopeKey = stableScope.ticketId ? `ticket:${stableScope.ticketId}` : 'dashboard'
  const [state, setState] = useState<AssistantScopeState>(EMPTY_SCOPE_STATE)
  const stateRef = useRef(state)
  stateRef.current = state
  const [newDrafts, setNewDrafts] = useState<Record<string, string>>({})
  const [details, setDetails] = useState<Record<string, AssistantSession>>({})
  const [pendingReplies, setPendingReplies] = useState<Record<string, {
    sessionId: string
    message: string
    startedAt: number
    reply: string
    reasoning: string
    reasoningStarted: boolean
    phase: 'preparing' | 'responding'
    modelId?: string
    variant?: string
  }>>({})
  const pendingRepliesRef = useRef(pendingReplies)
  pendingRepliesRef.current = pendingReplies
  const [sendingIds, setSendingIds] = useState<string[]>([])
  const [globalRefresh, setGlobalRefresh] = useState(0)
  const [detailRefresh, setDetailRefresh] = useState(0)
  const controllers = useRef(new Set<AbortController>())
  const detailRequests = useRef(new Map<string, AbortController>())
  const activeStreams = useRef(new Map<string, { controller: AbortController; message: string }>())
  const closingSessions = useRef(new Set<string>())
  const draftsAfterCloseFailure = useRef(new Map<string, string>())
  const current = state
  const activeId = current.activeId
  const activeDetail = activeId ? details[activeId] ?? null : null
  const activeSummary = activeId ? current.sessions.find(session => session.id === activeId) : undefined
  const activeScope = useMemo<AssistantScope>(() => activeSummary?.ticketId
    ? { ticketId: activeSummary.ticketId }
    : {}, [activeSummary?.ticketId])

  const updateState = useCallback((update: (state: AssistantScopeState) => AssistantScopeState) => {
    setState(previous => update(previous))
  }, [])

  const scopeForSession = useCallback((id: string): AssistantScope => {
    const ticketId = details[id]?.ticketId ?? current.sessions.find(session => session.id === id)?.ticketId
    return ticketId ? { ticketId } : {}
  }, [current.sessions, details])

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
    if (!enabled) return
    const openIdsAtRequestStart = new Set(stateRef.current.openIds)
    const openGenerationAtRequestStart = stateRef.current.openGeneration
    const controller = beginRequest()
    updateState(state => ({ ...state, loading: true, error: null }))
    void fetchAssistantHistory(controller.signal).then(nextSessions => {
      if (controller.signal.aborted) return
      const knownIds = new Set(nextSessions.map(session => session.id))
      const currentState = stateRef.current
      const evictedIds = [...openIdsAtRequestStart].filter(id => (
        !knownIds.has(id) && (currentState.openedAt[id] ?? 0) <= openGenerationAtRequestStart
      ))
      for (const id of evictedIds) {
        detailRequests.current.get(id)?.abort()
        activeStreams.current.get(id)?.controller.abort()
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
      updateState(state => {
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
      if (!controller.signal.aborted) updateState(state => ({
        ...state,
        error: describeQueryError(caught) ?? 'Could not load assistant conversations.',
      }))
    }).finally(() => {
      endRequest(controller)
      if (!controller.signal.aborted) updateState(state => ({ ...state, loading: false }))
    })
    return () => {
      controller.abort()
      endRequest(controller)
      updateState(state => ({ ...state, loading: false }))
    }
  }, [beginRequest, enabled, endRequest, globalRefresh, updateState])

  useEffect(() => {
    if (!enabled || !activeId || activeDetail) return
    const controller = beginRequest()
    const requests = detailRequests.current
    requests.set(activeId, controller)
    updateState(state => ({ ...state, openingId: activeId, error: null }))
    void fetchAssistantSession(activeId, activeScope, controller.signal).then(session => {
      if (controller.signal.aborted) return
      setDetails(previous => ({ ...previous, [session.id]: session }))
      updateState(state => ({
        ...state,
        sessions: [summaryOf(session), ...state.sessions.filter(item => item.id !== session.id)],
      }))
    }).catch(caught => {
      if (!controller.signal.aborted) updateState(state => ({
        ...state,
        error: describeQueryError(caught) ?? 'Could not open assistant conversation.',
      }))
    }).finally(() => {
      endRequest(controller)
      if (requests.get(activeId) === controller) requests.delete(activeId)
      if (!controller.signal.aborted) updateState(state => ({
        ...state,
        openingId: state.openingId === activeId ? null : state.openingId,
      }))
    })
    return () => {
      controller.abort()
      endRequest(controller)
      if (requests.get(activeId) === controller) requests.delete(activeId)
      updateState(state => ({
        ...state,
        openingId: state.openingId === activeId ? null : state.openingId,
      }))
    }
  }, [activeDetail, activeId, activeScope, beginRequest, detailRefresh, enabled, endRequest, updateState])

  const setError = useCallback((error: string | null) => {
    updateState(state => ({ ...state, error }))
  }, [updateState])

  const selectSession = useCallback((id: string, summary?: AssistantSessionSummary) => {
    if (!details[id] && !detailRequests.current.has(id)) setDetailRefresh(value => value + 1)
    updateState(state => {
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
  }, [details, updateState])

  const setDraft = useCallback((id: string | null, value: string) => {
    if (!id) {
      setNewDrafts(previous => {
        const next = { ...previous }
        if (value) next[scopeKey] = value
        else delete next[scopeKey]
        return next
      })
      return
    }
    updateState(state => {
      if (!state.openIds.includes(id)) return state
      const drafts = { ...state.drafts }
      if (value) drafts[id] = value
      else delete drafts[id]
      return { ...state, drafts }
    })
  }, [scopeKey, updateState])

  const createSession = useCallback(async (): Promise<AssistantSession | null> => {
    const controller = beginRequest()
    updateState(state => ({ ...state, creating: true, error: null }))
    try {
      const session = await createAssistantSession(stableScope, controller.signal)
      if (controller.signal.aborted) return null
      updateState(state => ({
        ...state,
        sessions: [summaryOf(session), ...state.sessions.filter(item => item.id !== session.id)],
        openIds: [session.id, ...state.openIds.filter(id => id !== session.id)],
        openedAt: { ...state.openedAt, [session.id]: state.openGeneration + 1 },
        openGeneration: state.openGeneration + 1,
        activeId: session.id,
        creating: false,
      }))
      setNewDrafts(previous => {
        const next = { ...previous }
        delete next[scopeKey]
        return next
      })
      setDetails(previous => ({ ...previous, [session.id]: session }))
      return session
    } catch (caught) {
      if (!controller.signal.aborted) updateState(state => ({
        ...state,
        error: describeQueryError(caught) ?? 'Could not start an assistant conversation.',
      }))
      return null
    } finally {
      endRequest(controller)
      if (!controller.signal.aborted) updateState(state => ({ ...state, creating: false }))
    }
  }, [beginRequest, endRequest, scopeKey, stableScope, updateState])

  const renameSession = useCallback(async (id: string, title: string): Promise<boolean> => {
    const controller = beginRequest()
    updateState(state => ({ ...state, error: null }))
    try {
      const session = await renameAssistantSession(id, title, scopeForSession(id), controller.signal)
      if (controller.signal.aborted) return false
      updateState(state => ({
        ...state,
        sessions: [session, ...state.sessions.filter(item => item.id !== id)],
      }))
      setDetails(previous => previous[id] ? { ...previous, [id]: { ...previous[id], ...session } } : previous)
      return true
    } catch (caught) {
      if (!controller.signal.aborted) updateState(state => ({
        ...state,
        error: describeQueryError(caught) ?? 'Could not rename assistant conversation.',
      }))
      return false
    } finally {
      endRequest(controller)
    }
  }, [beginRequest, endRequest, scopeForSession, updateState])

  const getConversation = useCallback(async (id: string): Promise<AssistantSession | null> => {
    const controller = beginRequest()
    try {
      const session = await fetchAssistantSession(id, scopeForSession(id), controller.signal)
      if (controller.signal.aborted) return null
      const pending = pendingRepliesRef.current[id]
      if (!pending) return session
      const messages = [...session.messages]
      const lastUserIndex = messages.findLastIndex(message => message.role === 'user')
      const lastUser = messages[lastUserIndex]
      const lastUserCreatedAt = lastUser ? Date.parse(lastUser.createdAt) : Number.NaN
      const pendingUserIsPresent = lastUser?.content === pending.message
        && (lastUserIndex === messages.length - 1 || lastUserCreatedAt >= pending.startedAt)
      const answerAfterLastUser = lastUserIndex < 0
        ? undefined
        : messages.slice(lastUserIndex + 1).findLast(message => message.role === 'assistant')
      if (!pendingUserIsPresent) {
        messages.push({ id: `pending-${id}`, role: 'user', content: pending.message, createdAt: '' })
      }
      const answerAlreadyPresent = pendingUserIsPresent && answerAfterLastUser && (
        Date.parse(answerAfterLastUser.createdAt) >= pending.startedAt
        || (pending.reply !== '' && answerAfterLastUser.content.startsWith(pending.reply))
      )
      if (pending.reply && !answerAlreadyPresent) {
        messages.push({
          id: `pending-reply-${id}`,
          role: 'assistant',
          content: pending.reply,
          createdAt: '',
          ...(pending.reasoning ? { reasoning: pending.reasoning } : {}),
          ...(pending.modelId ? { modelId: pending.modelId } : {}),
          ...(pending.variant ? { variant: pending.variant } : {}),
        })
      }
      return { ...session, messages }
    } catch {
      return null
    } finally {
      endRequest(controller)
    }
  }, [beginRequest, endRequest, scopeForSession])

  const closeSession = useCallback(async (id: string): Promise<boolean> => {
    const sessionScope = scopeForSession(id)
    closingSessions.current.add(id)
    detailRequests.current.get(id)?.abort()
    detailRequests.current.delete(id)
    const activeStream = activeStreams.current.get(id)
    if (activeStream) draftsAfterCloseFailure.current.set(id, activeStream.message)
    activeStream?.controller.abort()
    activeStreams.current.delete(id)
    setSendingIds(previous => previous.filter(sessionId => sessionId !== id))
    setPendingReplies(previous => {
      const next = { ...previous }
      delete next[id]
      return next
    })
    const controller = beginRequest()
    updateState(state => ({
      ...state,
      closingIds: state.closingIds.includes(id) ? state.closingIds : [...state.closingIds, id],
      error: null,
    }))
    try {
      try {
        await closeAssistantSession(id, sessionScope, controller.signal)
      } catch (caught) {
        if (!(caught instanceof Error && /\(HTTP 404(?:[:)])/.test(caught.message))) {
          if (!controller.signal.aborted) {
            const pendingDraft = draftsAfterCloseFailure.current.get(id)
            draftsAfterCloseFailure.current.delete(id)
            updateState(state => ({
              ...state,
              error: describeQueryError(caught) ?? 'Could not close assistant conversation.',
            }))
            if (pendingDraft) updateState(state => {
              if (!state.openIds.includes(id) || state.drafts[id]) return state
              return { ...state, drafts: { ...state.drafts, [id]: pendingDraft } }
            })
            detailRequests.current.get(id)?.abort()
            const refreshController = beginRequest()
            detailRequests.current.set(id, refreshController)
            void fetchAssistantSession(id, sessionScope, refreshController.signal).then(session => {
              if (refreshController.signal.aborted) return
              setDetails(previous => ({ ...previous, [id]: session }))
              updateState(state => state.openIds.includes(id)
                ? { ...state, sessions: [summaryOf(session), ...state.sessions.filter(item => item.id !== id)] }
                : state)
            }).catch(() => {
              // Keep the previous transcript when the post-close refresh is unavailable.
            }).finally(() => {
              endRequest(refreshController)
              if (detailRequests.current.get(id) === refreshController) detailRequests.current.delete(id)
            })
          }
          return false
        }
      }
      if (controller.signal.aborted) return false
      draftsAfterCloseFailure.current.delete(id)
      activeStreams.current.get(id)?.controller.abort()
      activeStreams.current.delete(id)
      setSendingIds(previous => previous.filter(sessionId => sessionId !== id))
      setPendingReplies(previous => {
        const next = { ...previous }
        delete next[id]
        return next
      })
      updateState(state => {
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
          openingId: state.openingId === id ? null : state.openingId,
          error: null,
        }
      })
      setDetails(previous => {
        const next = { ...previous }
        delete next[id]
        return next
      })
      setGlobalRefresh(value => value + 1)
      return true
    } finally {
      closingSessions.current.delete(id)
      endRequest(controller)
      if (!controller.signal.aborted) updateState(state => ({
        ...state,
        closingIds: state.closingIds.filter(sessionId => sessionId !== id),
      }))
    }
  }, [beginRequest, endRequest, scopeForSession, updateState])

  const sendMessage = useCallback(async (message: string, sessionOverride?: AssistantSession): Promise<boolean> => {
    const session = sessionOverride ?? (activeId ? details[activeId] : null)
    const normalizedMessage = message.trim()
    if (!session?.canResume || !normalizedMessage || closingSessions.current.has(session.id) || current.closingIds.includes(session.id) || activeStreams.current.has(session.id)) return false
    const sessionScope: AssistantScope = session.ticketId ? { ticketId: session.ticketId } : {}
    const controller = beginRequest()
    activeStreams.current.set(session.id, { controller, message: normalizedMessage })
    updateState(state => {
      if (!state.openIds.includes(session.id)) return state
      const drafts = { ...state.drafts }
      delete drafts[session.id]
      return { ...state, drafts }
    })
    setSendingIds(previous => previous.includes(session.id) ? previous : [...previous, session.id])
    setPendingReplies(previous => ({
      ...previous,
      [session.id]: { sessionId: session.id, message: normalizedMessage, startedAt: Date.now(), reply: '', reasoning: '', reasoningStarted: false, phase: 'preparing' },
    }))
    setError(null)
    let accepted = false
    try {
      const response = await sendAssistantMessage(session.id, normalizedMessage, sessionScope, controller.signal)
      accepted = true
      let finished = false
      for await (const event of readAssistantEvents(response, controller.signal)) {
        if (controller.signal.aborted) return false
        if (event.type === 'status') {
          setPendingReplies(previous => {
            const pending = previous[session.id]
            return pending ? { ...previous, [session.id]: {
              ...pending, phase: event.phase,
              ...(event.modelId !== undefined ? { modelId: event.modelId } : {}),
              ...(event.variant !== undefined ? { variant: event.variant } : {}),
            } } : previous
          })
        } else if (event.type === 'delta') {
          setPendingReplies(previous => {
            const pending = previous[session.id]
            return pending ? { ...previous, [session.id]: { ...pending, reply: pending.reply + event.text, phase: 'responding' } } : previous
          })
        } else if (event.type === 'reasoning') {
          setPendingReplies(previous => {
            const pending = previous[session.id]
            return pending ? { ...previous, [session.id]: {
              ...pending,
              reasoning: event.text,
              phase: 'responding',
              reasoningStarted: true,
              ...(event.modelId !== undefined ? { modelId: event.modelId } : {}),
              ...(event.variant !== undefined ? { variant: event.variant } : {}),
            } } : previous
          })
        } else if (event.type === 'error') {
          throw new Error(event.error)
        } else {
          finished = true
          setDetails(previous => ({ ...previous, [event.session.id]: event.session }))
          updateState(state => ({
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
        if (closingSessions.current.has(session.id)) draftsAfterCloseFailure.current.set(session.id, normalizedMessage)
        else updateState(state => {
          if (!state.openIds.includes(session.id) || state.drafts[session.id]) return state
          return { ...state, drafts: { ...state.drafts, [session.id]: normalizedMessage } }
        })
        if (accepted) {
          try {
            const refreshed = await fetchAssistantSession(session.id, sessionScope, controller.signal)
            if (!controller.signal.aborted && stateRef.current.openIds.includes(session.id)) {
              setDetails(previous => ({ ...previous, [session.id]: refreshed }))
              updateState(state => state.openIds.includes(session.id)
                ? { ...state, sessions: [summaryOf(refreshed), ...state.sessions.filter(item => item.id !== session.id)] }
                : state)
            }
          } catch {
            // Keep the previous transcript when the post-send refresh is unavailable.
          }
        }
      }
      return false
    } finally {
      endRequest(controller)
      if (activeStreams.current.get(session.id)?.controller === controller) {
        activeStreams.current.delete(session.id)
        setSendingIds(previous => previous.filter(id => id !== session.id))
      }
    }
  }, [activeId, beginRequest, current.closingIds, details, endRequest, setError, updateState])

  return {
    sessions: current.sessions,
    openIds: current.openIds,
    drafts: current.drafts,
    newDraft: newDrafts[scopeKey] ?? '',
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
    renameSession,
    getConversation,
    closeSession,
    sendMessage,
  }
}
