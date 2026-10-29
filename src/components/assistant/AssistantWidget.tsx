import { memo, useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowDownToLine, Copy, Ellipsis, History, LoaderCircle, MessageCircle, Pencil, Plus, Search, Send, Settings, X } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import type { AssistantMessage, AssistantScope, AssistantSession, AssistantSessionSummary } from '@shared/assistant'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAssistant } from '@/hooks/useAssistant'
import { useLogScrollAnchor } from '@/hooks/useLogScrollAnchor'
import { useProfile } from '@/hooks/useProfile'
import { useUI } from '@/context/useUI'
import { useTickets } from '@/hooks/useTickets'
import { useProjects } from '@/hooks/useProjects'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { fetchAssistantHistory } from './assistantApi'

interface AssistantWidgetProps {
  open: boolean
  launcherVisible: boolean
  onOpen: () => void
  onDismiss: () => void
  onOpenConfiguration: () => void
}

interface AssistantWindowPosition {
  left: number
  top: number
}

const ASSISTANT_WINDOW_POSITION_KEY = 'looptroop.assistant.window-position'

function readAssistantWindowPosition(): AssistantWindowPosition | null {
  try {
    const stored = window.sessionStorage.getItem(ASSISTANT_WINDOW_POSITION_KEY)
    if (!stored) return null
    const position = JSON.parse(stored) as Partial<AssistantWindowPosition>
    if (typeof position.left !== 'number' || !Number.isFinite(position.left)
      || typeof position.top !== 'number' || !Number.isFinite(position.top)) return null
    return { left: position.left, top: position.top }
  } catch {
    return null
  }
}

function clampAssistantWindowPosition(position: AssistantWindowPosition, width: number, height: number): AssistantWindowPosition {
  return {
    left: Math.min(Math.max(4, position.left), Math.max(4, window.innerWidth - width - 4)),
    top: Math.min(Math.max(4, position.top), Math.max(4, window.innerHeight - height - 4)),
  }
}

export function AssistantWidget({ open, launcherVisible, onOpen, onDismiss, onOpenConfiguration }: AssistantWidgetProps) {
  const { state } = useUI()
  const { data: tickets = [], isLoading: ticketsLoading } = useTickets()
  const { data: projects = [] } = useProjects()
  const profile = useProfile()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historySessions, setHistorySessions] = useState<AssistantSessionSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [pendingHistorySession, setPendingHistorySession] = useState<AssistantSessionSummary | null>(null)
  const [windowPosition, setWindowPosition] = useState<AssistantWindowPosition | null>(readAssistantWindowPosition)
  const [isDraggingWindow, setIsDraggingWindow] = useState(false)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null)
  const previousOpen = useRef(open)
  const panelId = useId()
  const titleId = useId()
  const ticketScope = state.activeView === 'ticket' && state.selectedTicketId
    ? state.selectedTicketId
    : undefined
  const scope: AssistantScope = { ...(ticketScope ? { ticketId: ticketScope } : {}) }
  const assistant = useAssistant(scope, open)
  const activeConversation = assistant.sessions.find(session => session.id === assistant.activeId)
  const conversationTicket = activeConversation ? activeConversation.ticketId : ticketScope
  const scopeLabel = conversationTicket
    ? `Ticket ${tickets.find(ticket => ticket.id === conversationTicket)?.externalId ?? externalTicketId(conversationTicket)}`
    : 'All tickets'
  const chatModelConfigured = Boolean(profile.data?.chatModel?.trim())

  const handleWindowPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button, a, input, textarea, select, [role="button"]'))) return
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
    setIsDraggingWindow(true)
  }

  const handleWindowKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return
    const movement = {
      ArrowLeft: { left: -16, top: 0 },
      ArrowRight: { left: 16, top: 0 },
      ArrowUp: { left: 0, top: -16 },
      ArrowDown: { left: 0, top: 16 },
    }[event.key]
    if (!movement) return
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    event.preventDefault()
    setWindowPosition(clampAssistantWindowPosition({
      left: (windowPosition?.left ?? rect.left) + movement.left,
      top: (windowPosition?.top ?? rect.top) + movement.top,
    }, rect.width, rect.height))
  }

  useEffect(() => {
    if (!isDraggingWindow) return
    const move = (event: PointerEvent) => {
      const drag = dragRef.current
      const panel = panelRef.current
      if (!drag || event.pointerId !== drag.pointerId || !panel) return
      const rect = panel.getBoundingClientRect()
      setWindowPosition(clampAssistantWindowPosition({
        left: event.clientX - drag.offsetX,
        top: event.clientY - drag.offsetY,
      }, rect.width, rect.height))
    }
    const stop = (event: PointerEvent) => {
      if (event.pointerId !== dragRef.current?.pointerId) return
      dragRef.current = null
      setIsDraggingWindow(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [isDraggingWindow])

  useEffect(() => {
    if (!open || !windowPosition || !panelRef.current) return
    const clampPosition = () => {
      const rect = panelRef.current?.getBoundingClientRect()
      if (!rect?.width || !rect.height) return
      setWindowPosition(current => {
        if (!current) return current
        const next = clampAssistantWindowPosition(current, rect.width, rect.height)
        return next.left === current.left && next.top === current.top ? current : next
      })
    }
    clampPosition()
    window.addEventListener('resize', clampPosition)
    return () => window.removeEventListener('resize', clampPosition)
  }, [open, windowPosition])

  useEffect(() => {
    if (!windowPosition) return
    try {
      window.sessionStorage.setItem(ASSISTANT_WINDOW_POSITION_KEY, JSON.stringify(windowPosition))
    } catch {
      // The moved position is optional when browser storage is unavailable.
    }
  }, [windowPosition])

  useEffect(() => {
    if (!open || !historyOpen) return
    const controller = new AbortController()
    setHistoryLoading(true)
    setHistoryError(null)
    void fetchAssistantHistory(controller.signal).then(setHistorySessions).catch(caught => {
      if (!controller.signal.aborted) setHistoryError(caught instanceof Error ? caught.message : 'Could not load conversation history.')
    }).finally(() => {
      if (!controller.signal.aborted) setHistoryLoading(false)
    })
    return () => controller.abort()
  }, [historyOpen, open])

  const handleHistorySelect = (session: AssistantSessionSummary) => {
    if (session.ticketId) {
      const ticket = tickets.find(item => item.id === session.ticketId)
      if (!ticket) {
        setHistoryError(ticketsLoading
          ? 'The ticket list is still loading. Try opening this conversation again in a moment.'
          : `Ticket ${externalTicketId(session.ticketId)} is no longer available, so this conversation can’t be opened.`)
        return
      }
    }
    setPendingHistorySession(session)
    setHistoryOpen(false)
  }

  const historyLoaded = useCallback((id: string) => {
    setPendingHistorySession(current => current?.id === id ? null : current)
  }, [])
  useEffect(() => {
    if (previousOpen.current && !open) launcherRef.current?.focus()
    previousOpen.current = open
  }, [open])

  const launcher = launcherVisible && (
    <button
      ref={launcherRef}
      type="button"
      aria-label="Open LoopTroop assistant"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={onOpen}
      title="Open assistant"
      className="fixed bottom-9 right-[72px] z-[60] flex items-center justify-center rounded-full border border-border bg-primary-foreground p-2 text-primary shadow-md opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <MessageCircle className="h-4 w-4" aria-hidden="true" />
    </button>
  )

  return (
    <>
      {launcher}

      <section
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        hidden={!open}
        style={{
          display: open ? 'flex' : 'none',
          ...(windowPosition ? { left: windowPosition.left, top: windowPosition.top, right: 'auto', bottom: 'auto' } : {}),
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          onDismiss()
        }}
        className={`fixed z-[60] flex h-[min(620px,calc(100dvh-10rem))] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-2xl ${windowPosition ? '' : 'bottom-1 right-1'}`}
      >
        <header
          onPointerDown={handleWindowPointerDown}
          onKeyDown={handleWindowKeyDown}
          role="group"
          aria-label="Move assistant window with arrow keys"
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
          tabIndex={0}
          className={`touch-none select-none border-b border-border p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${isDraggingWindow ? 'cursor-grabbing' : 'cursor-move'}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id={titleId} className="text-sm font-semibold">LoopTroop assistant</h2>
              <p className="text-xs text-muted-foreground">{scopeLabel}</p>
            </div>
            <button type="button" aria-label="Close assistant window" title="Close assistant window" onClick={onDismiss} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <AssistantConversation
          scope={scope}
          assistant={assistant}
          open={open}
          historySessions={historySessions}
          historyOpen={historyOpen}
          historyLoading={historyLoading}
          historyError={historyError}
          pendingHistorySession={pendingHistorySession}
          tickets={tickets}
          projects={projects}
          onHistoryOpenChange={setHistoryOpen}
          onHistorySelect={handleHistorySelect}
          onPendingHistoryLoaded={historyLoaded}
          chatModelConfigured={chatModelConfigured}
          profileLoading={profile.isLoading}
          onOpenConfiguration={onOpenConfiguration}
        />
      </section>
    </>
  )
}

function AssistantConversation({
  scope,
  assistant,
  open,
  historySessions,
  historyOpen,
  historyLoading,
  historyError,
  pendingHistorySession,
  tickets,
  projects,
  onHistoryOpenChange,
  onHistorySelect,
  onPendingHistoryLoaded,
  chatModelConfigured,
  profileLoading,
  onOpenConfiguration,
}: {
  scope: AssistantScope
  assistant: ReturnType<typeof useAssistant>
  open: boolean
  historySessions: AssistantSessionSummary[]
  historyOpen: boolean
  historyLoading: boolean
  historyError: string | null
  pendingHistorySession: AssistantSessionSummary | null
  tickets: Array<{ id: string; externalId: string; projectId: number }>
  projects: Array<{ id: number; color: string }>
  onHistoryOpenChange: (open: boolean) => void
  onHistorySelect: (session: AssistantSessionSummary) => void
  onPendingHistoryLoaded: (id: string) => void
  chatModelConfigured: boolean
  profileLoading: boolean
  onOpenConfiguration: () => void
}) {
  const { selectSession } = assistant
  const [completedSessionId, setCompletedSessionId] = useState<string | null>(null)
  const historySearchRef = useRef<HTMLInputElement>(null)
  const [historySearch, setHistorySearch] = useState('')
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [conversationCopyError, setConversationCopyError] = useState(false)
  const [conversationCopied, copyConversationToClipboard, conversationCopyFailed, conversationCopyFailureCount] = useCopyToClipboard()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const conversationRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const historyButtonRef = useRef<HTMLButtonElement>(null)
  const panelWasOpen = useRef(false)
  const listId = useId()
  const activeSession = assistant.activeSession
  const draft = assistant.activeId ? assistant.drafts[assistant.activeId] ?? '' : assistant.newDraft
  const activeClosing = assistant.activeId !== null && assistant.closingIds.includes(assistant.activeId)
  const cannotCompose = (assistant.activeId !== null && !activeSession?.canResume)
    || (assistant.activeId === null && assistant.loading)
  const {
    setViewportRef,
    setContentRef,
    autoScrollEnabledRef,
    isAutoScroll,
    scheduleScrollToBottom,
    enableAutoScroll,
  } = useLogScrollAnchor()
  const history = historySessions.map(session => ({ session, scope: historyScopeLabel(session, tickets) }))
    .filter(({ session, scope: label }) => `${session.title} ${label}`.toLowerCase().includes(historySearch.trim().toLowerCase()))

  const copyConversation = (id: string) => {
    setConversationCopyError(false)
    void assistant.getConversation(id).then(session => {
      if (!session) {
        setConversationCopyError(true)
        return
      }
      void copyConversationToClipboard(formatConversationText(session))
    }).catch(() => setConversationCopyError(true))
  }

  const startRename = (id: string, title: string) => {
    setRenameSessionId(id)
    setRenameTitle(title)
    setRenameError(null)
  }

  const cancelRename = () => {
    if (renaming) return
    setRenameSessionId(null)
    setRenameError(null)
  }

  const saveRename = async (event: FormEvent) => {
    event.preventDefault()
    if (!renameSessionId || renaming) return
    const title = renameTitle.trim()
    if (!title) {
      setRenameError('Enter a conversation name.')
      return
    }
    setRenaming(true)
    setRenameError(null)
    try {
      if (!await assistant.renameSession(renameSessionId, title)) {
        setRenameError('Could not rename this conversation.')
        return
      }
      setRenameSessionId(null)
    } catch {
      setRenameError('Could not rename this conversation.')
    } finally {
      setRenaming(false)
    }
  }

  useEffect(() => {
    if (!pendingHistorySession) return
    selectSession(pendingHistorySession.id, pendingHistorySession)
    onPendingHistoryLoaded(pendingHistorySession.id)
  }, [onPendingHistoryLoaded, pendingHistorySession, selectSession])

  useEffect(() => {
    if (!historyOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!historyRef.current?.contains(event.target as Node)) {
        onHistoryOpenChange(false)
        setHistorySearch('')
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [historyOpen, onHistoryOpenChange])

  useEffect(() => {
    if (historyOpen) historySearchRef.current?.focus()
  }, [historyOpen])

  useEffect(() => {
    if (!open) {
      panelWasOpen.current = false
      return
    }
    if (historyOpen) return
    const justOpened = !panelWasOpen.current
    panelWasOpen.current = true
    const panel = textareaRef.current?.closest('[role="dialog"]')
    if (document.activeElement === historyButtonRef.current) return
    if (!justOpened && document.activeElement !== document.body && !panel?.contains(document.activeElement)) return
    const focusedElement = document.activeElement
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== focusedElement) return
      if (textareaRef.current && !textareaRef.current.disabled) textareaRef.current.focus()
      else conversationRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [activeClosing, activeSession?.canResume, assistant.activeId, assistant.loading, assistant.openIds, assistant.opening, chatModelConfigured, historyOpen, open, profileLoading])

  useEffect(() => {
    if (!assistant.activeId) return
    enableAutoScroll()
    scheduleScrollToBottom('auto')
  }, [assistant.activeId, enableAutoScroll, scheduleScrollToBottom])

  useEffect(() => {
    if (autoScrollEnabledRef.current) scheduleScrollToBottom('auto')
  }, [activeSession?.messages.length, autoScrollEnabledRef, scheduleScrollToBottom])

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (!draft.trim() || assistant.sending || activeClosing || assistant.creating || cannotCompose || !chatModelConfigured || profileLoading) return
    const message = draft
    setCompletedSessionId(null)
    if (!assistant.activeId) {
      void assistant.createSession().then(session => {
        if (!session) return
        enableAutoScroll()
        scheduleScrollToBottom('smooth')
        return assistant.sendMessage(message, session).then(sent => {
          if (sent) setCompletedSessionId(session.id)
        })
      })
      return
    }
    if (!activeSession?.canResume) return
    const sessionId = assistant.activeId
    enableAutoScroll()
    scheduleScrollToBottom('smooth')
    void assistant.sendMessage(message).then(sent => {
      if (sent) setCompletedSessionId(sessionId)
    })
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const closeConversation = (id: string) => {
    void assistant.closeSession(id).then(closed => {
      if (closed) setCompletedSessionId(current => current === id ? null : current)
    })
  }

  const selectHistory = (session: AssistantSessionSummary) => {
    onHistorySelect(session)
    setHistorySearch('')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="toolbar" aria-label="Open conversations">
          {assistant.openIds.map(id => {
            const conversation = assistant.sessions.find(session => session.id === id)
            const title = conversation?.title.trim() || 'New conversation'
            const ticket = tickets.find(item => item.id === conversation?.ticketId)
            const color = ticket ? projects.find(project => project.id === ticket.projectId)?.color : undefined
            return (
              <div key={id} className="flex shrink-0 items-center rounded-md border border-border bg-muted/40" style={color ? { borderColor: color, backgroundColor: `${color}1a` } : undefined}>
                <button
                  type="button"
                  aria-pressed={assistant.activeId === id}
                  onClick={() => assistant.selectSession(id)}
                  title={title}
                  className={`max-w-28 truncate rounded-l-md px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${assistant.activeId === id ? `${color ? '' : 'bg-accent'} text-foreground` : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {title}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`More options for ${title} conversation`}
                      title={`More options for ${title}`}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Ellipsis className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="z-[70]">
                    <DropdownMenuItem onSelect={() => copyConversation(id)}>
                      <Copy className="mr-2 h-3.5 w-3.5" aria-hidden="true" />Copy conversation
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => startRename(id, title)}>
                      <Pencil className="mr-2 h-3.5 w-3.5" aria-hidden="true" />Rename
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  type="button"
                  aria-label={`Close ${title} conversation`}
                  title={`Close ${title}`}
                  disabled={assistant.closingIds.includes(id)}
                  onClick={() => closeConversation(id)}
                  className="rounded-r-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {assistant.closingIds.includes(id) ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> : <X className="h-3 w-3" aria-hidden="true" />}
                </button>
              </div>
            )
          })}
        </div>
        {(conversationCopyFailed || conversationCopyError) && <span key={conversationCopyFailureCount} role="alert" className="px-2 text-xs text-destructive">{conversationCopyError ? 'Could not copy conversation' : 'Copy failed'}</span>}
        {conversationCopied && <span role="status" className="sr-only">Conversation copied.</span>}
        {assistant.openIds.length > 0 && (
          <button type="button" aria-label="New chat" title="New chat" disabled={assistant.creating || profileLoading || !chatModelConfigured} onClick={() => void assistant.createSession()} className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {assistant.creating ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
          </button>
        )}
        <div ref={historyRef} className="relative shrink-0">
          <button ref={historyButtonRef} type="button" aria-expanded={historyOpen} aria-controls={listId} onClick={() => { onHistoryOpenChange(!historyOpen); setHistorySearch('') }} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title="Conversation history">
            <History className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Conversation history</span>
          </button>
          {historyOpen && (
            <div
              id={listId}
              role="dialog"
              aria-label="Conversation history"
              className="absolute right-0 top-full z-[70] mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl"
              onKeyDown={event => {
                if (event.key !== 'Escape') return
                event.stopPropagation()
                onHistoryOpenChange(false)
                setHistorySearch('')
                historyButtonRef.current?.focus()
              }}
            >
              <label className="flex items-center gap-2 rounded-md border border-input px-2">
                <Search className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                <input ref={historySearchRef} value={historySearch} onChange={event => setHistorySearch(event.target.value)} placeholder="Search titles and scopes" aria-label="Search conversation history" className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
              </label>
              {historyError && <p role="alert" className="mt-2 rounded-md bg-destructive/5 px-2 py-1.5 text-xs text-destructive">{historyError}</p>}
              <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                {history.map(({ session, scope: label }) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      aria-label={`Open ${session.title || 'Untitled conversation'} — ${label} — ${new Date(session.updatedAt).toLocaleString()}`}
                      onClick={() => selectHistory(session)}
                      className="w-full rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="block truncate text-sm">{session.title || 'Untitled conversation'}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">{label} · {session.archived ? 'Archived' : 'Open'} · {new Date(session.updatedAt).toLocaleString()}</span>
                    </button>
                  </li>
                ))}
                {history.length === 0 && <li className="px-2 py-3 text-sm text-muted-foreground">{historyLoading ? 'Loading history…' : 'No conversations found.'}</li>}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={conversationRef} tabIndex={-1} className="relative min-h-0 flex-1">
          <div ref={setViewportRef} className="h-full min-h-0 overflow-y-auto px-3 py-3" role="log" aria-label="Conversation messages" aria-live="off">
            <div ref={setContentRef}>
              {assistant.loading && assistant.openIds.length === 0 && <p className="text-sm text-muted-foreground">Loading conversations…</p>}
              {assistant.opening && <p className="text-sm text-muted-foreground">Opening conversation…</p>}
              {!assistant.opening && !activeSession && assistant.openIds.length === 0 && !assistant.loading && (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                  <MessageCircle className="h-8 w-8 text-muted-foreground/70" aria-hidden="true" />
                  <p className="text-sm font-medium">Ask LoopTroop</p>
                  <p className="max-w-64 text-xs text-muted-foreground">Ask about LoopTroop or {scope.ticketId ? 'this ticket.' : 'any ticket.'}</p>
                </div>
              )}
              {open && groupAssistantReplies(activeSession?.messages ?? []).map(message => (
                <article key={message.id} className={`mb-3 rounded-lg px-3 py-2 text-sm ${message.role === 'user' ? 'ml-6 bg-muted' : 'mr-2 bg-accent/50'}`}>
                  <div className="mb-1 flex items-center gap-1">
                    <p className="text-[11px] font-semibold text-muted-foreground">{message.role === 'user' ? 'You' : 'Assistant'}</p>
                    {message.content && <CopyMessageButton role={message.role} content={message.content} />}
                  </div>
                  {message.role === 'assistant' && <ThinkingSection reasoning={message.reasoning} modelId={message.modelId} variant={message.variant} />}
                  {message.role === 'assistant'
                    ? <AssistantMarkdown>{message.content}</AssistantMarkdown>
                    : <p className="whitespace-pre-wrap break-words">{message.content}</p>}
                </article>
              ))}
              {open && assistant.pendingReply && (
                <>
                  <article className="mb-3 ml-6 rounded-lg bg-muted px-3 py-2 text-sm">
                    <div className="mb-1 flex items-center gap-1">
                      <p className="text-[11px] font-semibold text-muted-foreground">You</p>
                      <CopyMessageButton role="user" content={assistant.pendingReply.message} />
                    </div>
                    <p className="whitespace-pre-wrap break-words">{assistant.pendingReply.message}</p>
                  </article>
                  <article className="mb-3 mr-2 rounded-lg bg-accent/50 px-3 py-2 text-sm">
                    <div className="mb-1 flex items-center gap-1">
                      <p className="text-[11px] font-semibold text-muted-foreground">Assistant</p>
                      {assistant.pendingReply.reply && <CopyMessageButton role="assistant" content={assistant.pendingReply.reply} />}
                    </div>
                    {assistant.pendingReply.phase === 'preparing'
                      ? <p className="mb-1 text-xs text-muted-foreground">Preparing context…</p>
                      : <ThinkingSection pending reasoning={assistant.pendingReply.reasoning} modelId={assistant.pendingReply.modelId} variant={assistant.pendingReply.variant} />}
                    {assistant.pendingReply.reply
                      ? <AssistantMarkdown>{assistant.pendingReply.reply}</AssistantMarkdown>
                      : <span className="sr-only" role="status">Assistant is responding</span>}
                    <LoaderCircle className="mt-2 h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
                  </article>
                </>
              )}
            </div>
          </div>
          {!isAutoScroll && (
            <button
              type="button"
              aria-label="Back to bottom"
              title="Back to bottom"
              onClick={() => {
                enableAutoScroll()
                scheduleScrollToBottom('auto')
                requestAnimationFrame(() => scheduleScrollToBottom('auto'))
              }}
              className="absolute bottom-4 right-5 rounded-full border border-border bg-background/90 p-2 text-muted-foreground shadow-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowDownToLine className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <p className="sr-only" role="status">{completedSessionId && completedSessionId === assistant.activeId ? 'Assistant response complete.' : ''}</p>

        {assistant.error && (
          <div role="alert" className="mx-3 mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
            {assistant.error}
          </div>
        )}

        {activeSession && !activeSession.canResume && (
          <p className="mx-3 mb-2 rounded-md bg-muted px-2.5 py-2 text-xs text-muted-foreground">This conversation is available to read, but it can’t be resumed.</p>
        )}

        {!chatModelConfigured && (
          <div className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-2">
            <p className="text-xs text-muted-foreground">{profileLoading ? 'Checking assistant model…' : 'Choose a chat model in Configuration to send messages.'}</p>
            <button type="button" onClick={onOpenConfiguration} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Settings className="h-3.5 w-3.5" aria-hidden="true" /> Configuration
            </button>
          </div>
        )}

        <form onSubmit={submit} className="border-t border-border p-2.5">
          <label className="sr-only" htmlFor="assistant-message">Message the assistant</label>
          <div className="flex items-end gap-2 rounded-lg border border-input bg-background p-1.5 focus-within:ring-2 focus-within:ring-ring">
            <textarea
              ref={textareaRef}
              id="assistant-message"
              value={draft}
              onChange={event => {
                assistant.setDraft(assistant.activeId, event.target.value)
                assistant.setError(null)
              }}
              onKeyDown={handleComposerKeyDown}
              placeholder={activeSession && !activeSession.canResume ? 'Start a new chat to send a message' : 'Ask a question…'}
              disabled={cannotCompose || !chatModelConfigured || profileLoading || assistant.creating || activeClosing}
              rows={1}
              className="max-h-28 min-h-9 flex-1 resize-y bg-transparent px-1.5 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="submit"
              aria-label="Send message"
              title="Send message"
              disabled={!draft.trim() || cannotCompose || !chatModelConfigured || profileLoading || assistant.sending || assistant.creating || activeClosing}
              className="mb-0.5 rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {assistant.sending ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
            </button>
          </div>
          <p className="mt-1.5 px-1 text-[10px] text-muted-foreground">Enter to send · Shift+Enter for a new line</p>
        </form>
      </div>
      <Dialog
        open={renameSessionId !== null}
        onOpenChange={open => { if (!open) cancelRename() }}
      >
        <DialogContent className="max-w-md" onEscapeKeyDown={event => { if (renaming) event.preventDefault() }}>
          <DialogHeader>
            <DialogTitle className="text-sm">Rename conversation</DialogTitle>
            <DialogDescription>Choose a name for this conversation.</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveRename} className="space-y-3">
            <label htmlFor="assistant-conversation-title" className="text-sm font-medium">Conversation name</label>
            <input
              id="assistant-conversation-title"
              autoFocus
              maxLength={100}
              value={renameTitle}
              onChange={event => { setRenameTitle(event.target.value); setRenameError(null) }}
              aria-invalid={Boolean(renameError)}
              aria-describedby={renameError ? 'assistant-rename-error' : undefined}
              disabled={renaming}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            />
            {renameError && <p id="assistant-rename-error" role="alert" className="text-xs text-destructive">{renameError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={cancelRename} disabled={renaming} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50">Cancel</button>
              <button type="submit" disabled={renaming} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">{renaming ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ThinkingSection({ reasoning, modelId, variant, pending = false }: { reasoning?: string; modelId?: string; variant?: string; pending?: boolean }) {
  if (!pending && !reasoning?.trim()) {
    return <p className="mb-1 text-xs text-muted-foreground">Thinking unavailable.</p>
  }
  return (
    <details className="mb-2 rounded-md border border-purple-500/20 bg-purple-500/5 px-2 py-1 text-xs text-purple-600 dark:text-purple-400">
      <summary className="cursor-pointer font-medium">{pending ? 'Thinking…' : 'Thinking'}</summary>
      <p className="mt-1 text-muted-foreground">Model: {modelId || 'Not reported'} · Effort: {variant || 'Not reported'}</p>
      <p className="mt-1 whitespace-pre-wrap break-words">{reasoning || 'Waiting for model thinking.'}</p>
    </details>
  )
}

function CopyMessageButton({ role, content }: { role: 'user' | 'assistant'; content: string }) {
  const [copied, copyToClipboard, copyFailed, copyFailureCount] = useCopyToClipboard(undefined, content)
  const label = role === 'user' ? 'your' : 'assistant'
  return (
    <>
      <button
        type="button"
        aria-label={`Copy ${label} message`}
        title={copied ? 'Message copied' : `Copy ${label} message`}
        onClick={() => { void copyToClipboard(content) }}
        className="rounded px-0.5 text-[10px] leading-none text-muted-foreground hover:bg-background/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {copied && <span role="status" className="sr-only">Message copied.</span>}
      {copyFailed && <span key={copyFailureCount} role="alert" className="text-[10px] text-destructive">Copy failed</span>}
    </>
  )
}

function groupAssistantReplies(messages: AssistantMessage[]): AssistantMessage[] {
  const grouped: AssistantMessage[] = []
  for (const message of messages) {
    const previous = grouped.at(-1)
    if (message.role !== 'assistant' || previous?.role !== 'assistant') {
      grouped.push({ ...message })
      continue
    }
    previous.content = [previous.content, message.content].filter(Boolean).join('\n\n')
    previous.reasoning = [previous.reasoning, message.reasoning].filter(Boolean).join('\n\n') || undefined
    previous.modelId = message.modelId || previous.modelId
    previous.variant = message.variant || previous.variant
  }
  return grouped
}

function formatConversationText(session: AssistantSession): string {
  return groupAssistantReplies(session.messages).filter(message => message.content.trim()).map(({ role, content }) => `${role === 'user' ? 'You' : 'Assistant'}:\n${content}`).join('\n\n')
}

const assistantMarkdownComponents: Components = {
  a: ({ href, children }) => href && /^https?:\/\//i.test(href)
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : href && !/^[a-z][a-z\d+.-]*:/i.test(href)
      ? <code>{href}</code>
      : <code>{children}</code>,
  img: ({ src, alt }) => src && /^https?:\/\//i.test(src)
    ? <a href={src} target="_blank" rel="noopener noreferrer" aria-label={alt || 'Open image link'}>{alt || 'View image'}</a>
    : <span>{alt || 'Image'}</span>,
}

const AssistantMarkdown = memo(function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="assistant-markdown break-words text-sm leading-relaxed [&_a]:text-brand-600 [&_a]:underline dark:[&_a]:text-brand-400 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
      <ReactMarkdown components={assistantMarkdownComponents}>{children}</ReactMarkdown>
    </div>
  )
})

function historyScopeLabel(session: AssistantSessionSummary, tickets: Array<{ id: string; externalId: string }>): string {
  if (!session.ticketId) return 'Dashboard · All tickets'
  const ticket = tickets.find(item => item.id === session.ticketId)
  return `Ticket ${ticket?.externalId ?? externalTicketId(session.ticketId)}`
}

function externalTicketId(ticketId: string): string {
  const separator = ticketId.indexOf(':')
  return separator < 0 ? ticketId : ticketId.slice(separator + 1)
}
