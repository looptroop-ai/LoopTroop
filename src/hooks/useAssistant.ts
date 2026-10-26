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

function summaryOf(session: AssistantSession): AssistantSessionSummary {
  const { messages: _messages, canResume: _canResume, saved: _saved, ...summary } = session
  return summary
}

export function useAssistant(scope: AssistantScope, enabled: boolean) {
  const stableScope = useMemo(() => ({ ...scope }), [scope.mode, scope.ticketId])
  const [sessions, setSessions] = useState<AssistantSessionSummary[]>([])
  const [openIds, setOpenIds] = useState<string[]>([])
  const [details, setDetails] = useState<Record<string, AssistantSession>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [closingId, setClosingId] = useState<string | null>(null)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [pendingReply, setPendingReply] = useState<{ sessionId: string; message: string; reply: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const controllers = useRef(new Set<AbortController>())
  const openIdsRef = useRef(openIds)
  const activeIdRef = useRef(activeId)
  openIdsRef.current = openIds
  activeIdRef.current = activeId

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
  }, [])

  useEffect(() => {
    if (!enabled) return
    const controller = beginRequest()
    setLoading(true)
    setError(null)
    void fetchAssistantSessions(stableScope, controller.signal).then(nextSessions => {
      if (controller.signal.aborted) return
      setSessions(nextSessions)
      const knownIds = new Set(nextSessions.map(session => session.id))
      const nextOpenIds = [
        ...openIdsRef.current.filter(id => knownIds.has(id)),
        ...nextSessions.filter(session => !session.archived && !openIdsRef.current.includes(session.id)).map(session => session.id),
      ]
      setOpenIds(nextOpenIds)
      if (!nextOpenIds.includes(activeIdRef.current ?? '')) setActiveId(nextOpenIds[0] ?? null)
    }).catch(caught => {
      if (!controller.signal.aborted) setError(describeQueryError(caught) ?? 'Could not load assistant conversations.')
    }).finally(() => {
      endRequest(controller)
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => {
      controller.abort()
      endRequest(controller)
    }
  }, [beginRequest, endRequest, enabled, refreshToken, stableScope])

  useEffect(() => {
    if (!enabled || !activeId || details[activeId]) return
    const controller = beginRequest()
    setOpeningId(activeId)
    void fetchAssistantSession(activeId, stableScope, controller.signal).then(session => {
      if (controller.signal.aborted) return
      setDetails(current => ({ ...current, [session.id]: session }))
      setSessions(current => [summaryOf(session), ...current.filter(item => item.id !== session.id)])
    }).catch(caught => {
      if (!controller.signal.aborted) setError(describeQueryError(caught) ?? 'Could not open assistant conversation.')
    }).finally(() => {
      endRequest(controller)
      if (!controller.signal.aborted) setOpeningId(current => current === activeId ? null : current)
    })
    return () => {
      controller.abort()
      endRequest(controller)
    }
  }, [activeId, beginRequest, details, enabled, endRequest, stableScope])

  const selectSession = useCallback((id: string) => {
    setError(null)
    setOpenIds(current => current.includes(id) ? current : [id, ...current])
    setActiveId(id)
  }, [])

  const createSession = useCallback(async () => {
    const controller = beginRequest()
    setCreating(true)
    setError(null)
    try {
      const session = await createAssistantSession(stableScope, controller.signal)
      if (controller.signal.aborted) return
      setSessions(current => [summaryOf(session), ...current.filter(item => item.id !== session.id)])
      setDetails(current => ({ ...current, [session.id]: session }))
      setOpenIds(current => [session.id, ...current.filter(id => id !== session.id)])
      setActiveId(session.id)
    } catch (caught) {
      if (!controller.signal.aborted) setError(describeQueryError(caught) ?? 'Could not start an assistant conversation.')
    } finally {
      endRequest(controller)
      if (!controller.signal.aborted) setCreating(false)
    }
  }, [beginRequest, endRequest, stableScope])

  const closeSession = useCallback(async (id: string) => {
    const controller = beginRequest()
    setClosingId(id)
    setError(null)
    try {
      await closeAssistantSession(id, stableScope, controller.signal)
      if (controller.signal.aborted) return
      const nextOpenIds = openIdsRef.current.filter(openId => openId !== id)
      setOpenIds(nextOpenIds)
      setDetails(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
      if (activeIdRef.current === id) setActiveId(nextOpenIds[0] ?? null)
      setRefreshToken(token => token + 1)
    } catch (caught) {
      if (!controller.signal.aborted) setError(describeQueryError(caught) ?? 'Could not close assistant conversation.')
    } finally {
      endRequest(controller)
      if (!controller.signal.aborted) setClosingId(current => current === id ? null : current)
    }
  }, [beginRequest, endRequest, stableScope])

  const sendMessage = useCallback(async (message: string) => {
    const session = activeId ? details[activeId] : null
    if (!session?.canResume || !message.trim() || sendingId) return
    const controller = beginRequest()
    setSendingId(session.id)
    setPendingReply({ sessionId: session.id, message: message.trim(), reply: '' })
    setError(null)
    try {
      const response = await sendAssistantMessage(session.id, message.trim(), stableScope, controller.signal)
      let finished = false
      for await (const event of readAssistantEvents(response, controller.signal)) {
        if (controller.signal.aborted) return
        if (event.type === 'delta') {
          setPendingReply(current => current?.sessionId === session.id ? { ...current, reply: current.reply + event.text } : current)
        } else if (event.type === 'error') {
          throw new Error(event.error)
        } else {
          finished = true
          setDetails(current => ({ ...current, [event.session.id]: event.session }))
          setSessions(current => [summaryOf(event.session), ...current.filter(item => item.id !== event.session.id)])
          setPendingReply(null)
        }
      }
      if (!finished && !controller.signal.aborted) throw new Error('The assistant response ended before it was complete.')
    } catch (caught) {
      if (!controller.signal.aborted) {
        setPendingReply(null)
        setError(describeQueryError(caught) ?? 'Could not send the assistant message.')
        setDetails(current => {
          const next = { ...current }
          delete next[session.id]
          return next
        })
      }
    } finally {
      endRequest(controller)
      if (!controller.signal.aborted) setSendingId(current => current === session.id ? null : current)
    }
  }, [activeId, beginRequest, details, endRequest, sendingId, stableScope])

  return {
    sessions,
    openIds,
    activeId,
    activeSession: activeId ? details[activeId] ?? null : null,
    loading,
    opening: openingId === activeId && activeId !== null,
    creating,
    closingId,
    sending: sendingId !== null,
    pendingReply: pendingReply?.sessionId === activeId ? pendingReply : null,
    error,
    setError,
    selectSession,
    createSession,
    closeSession,
    sendMessage,
  }
}
