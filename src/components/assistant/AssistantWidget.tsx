import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { History, LoaderCircle, MessageCircle, Plus, Search, Send, Settings, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { AssistantMode, AssistantScope, AssistantSessionSummary } from '@shared/assistant'
import { useAssistant } from '@/hooks/useAssistant'
import { useProfile } from '@/hooks/useProfile'
import { useUI } from '@/context/useUI'
import { useTickets } from '@/hooks/useTickets'
import { fetchAssistantHistory } from './assistantApi'

interface AssistantWidgetProps {
  open: boolean
  launcherVisible: boolean
  onOpen: () => void
  onDismiss: () => void
  onOpenConfiguration: () => void
}

export function AssistantWidget({ open, launcherVisible, onOpen, onDismiss, onOpenConfiguration }: AssistantWidgetProps) {
  const { state, dispatch } = useUI()
  const { data: tickets = [], isLoading: ticketsLoading } = useTickets()
  const profile = useProfile()
  const [mode, setMode] = useState<AssistantMode>('help')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historySessions, setHistorySessions] = useState<AssistantSessionSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [pendingHistorySession, setPendingHistorySession] = useState<AssistantSessionSummary | null>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const previousOpen = useRef(open)
  const panelId = useId()
  const titleId = useId()
  const ticketModeScope = mode === 'tickets' && state.activeView === 'ticket' && state.selectedTicketId
    ? state.selectedTicketId
    : undefined
  const scope: AssistantScope = { mode, ...(ticketModeScope ? { ticketId: ticketModeScope } : {}) }
  const scopeKey = `${mode}:${ticketModeScope ?? ''}`
  const scopeLabel = mode === 'help'
    ? 'Help'
    : ticketModeScope
      ? `Ticket ${state.selectedTicketExternalId ?? ticketModeScope}`
      : 'All tickets'
  const chatModelConfigured = Boolean(profile.data?.chatModel?.trim())

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
    if (session.mode === 'tickets' && session.ticketId) {
      const ticket = tickets.find(item => item.id === session.ticketId)
      if (!ticket) {
        setHistoryError(ticketsLoading
          ? 'The ticket list is still loading. Try opening this conversation again in a moment.'
          : `Ticket ${session.ticketId} is no longer available, so this conversation can’t be opened.`)
        return
      }
      dispatch({ type: 'SELECT_TICKET', ticketId: ticket.id, externalId: ticket.externalId })
    } else if (session.mode === 'tickets' && state.activeView === 'ticket') {
      dispatch({ type: 'CLOSE_TICKET' })
    }
    setPendingHistorySession(session)
    setMode(session.mode)
    setHistoryOpen(false)
  }

  const historyLoaded = useCallback((id: string) => {
    setPendingHistorySession(current => current?.id === id ? null : current)
  }, [])
  const pendingMatchesScope = pendingHistorySession?.mode === mode
    && (mode === 'help' || (pendingHistorySession.ticketId ?? undefined) === ticketModeScope)

  useEffect(() => {
    if (previousOpen.current && !open) launcherRef.current?.focus()
    previousOpen.current = open
  }, [open])

  return (
    <>
      {launcherVisible && (
        <button
          ref={launcherRef}
          type="button"
          aria-label="Open LoopTroop assistant"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onOpen}
          title="Open assistant"
          className="fixed bottom-20 right-4 z-[60] flex h-8 w-8 items-center justify-center rounded-full border border-border bg-primary text-primary-foreground shadow-md transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <MessageCircle className="h-4 w-4" aria-hidden="true" />
        </button>
      )}

      <section
        id={panelId}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        hidden={!open}
        style={{ display: open ? 'flex' : 'none' }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          onDismiss()
        }}
        className="fixed bottom-36 right-4 z-[60] flex h-[min(620px,calc(100dvh-10rem))] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-2xl"
      >
        <header className="border-b border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id={titleId} className="text-sm font-semibold">LoopTroop assistant</h2>
              <p className="text-xs text-muted-foreground">{scopeLabel}</p>
            </div>
            <button type="button" aria-label="Close assistant window" title="Close assistant window" onClick={onDismiss} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Assistant mode">
            <ModeButton selected={mode === 'help'} onClick={() => setMode('help')}>Help</ModeButton>
            <ModeButton selected={mode === 'tickets'} onClick={() => setMode('tickets')}>Tickets</ModeButton>
          </div>
        </header>

        <AssistantConversation
          key={scopeKey}
          scope={scope}
          open={open}
          historySessions={historySessions}
          historyOpen={historyOpen}
          historyLoading={historyLoading}
          historyError={historyError}
          pendingHistorySession={pendingMatchesScope ? pendingHistorySession : null}
          tickets={tickets}
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

function ModeButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} className={`rounded-md px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
      {children}
    </button>
  )
}

function AssistantConversation({
  scope,
  open,
  historySessions,
  historyOpen,
  historyLoading,
  historyError,
  pendingHistorySession,
  tickets,
  onHistoryOpenChange,
  onHistorySelect,
  onPendingHistoryLoaded,
  chatModelConfigured,
  profileLoading,
  onOpenConfiguration,
}: {
  scope: AssistantScope
  open: boolean
  historySessions: AssistantSessionSummary[]
  historyOpen: boolean
  historyLoading: boolean
  historyError: string | null
  pendingHistorySession: AssistantSessionSummary | null
  tickets: Array<{ id: string; externalId: string }>
  onHistoryOpenChange: (open: boolean) => void
  onHistorySelect: (session: AssistantSessionSummary) => void
  onPendingHistoryLoaded: (id: string) => void
  chatModelConfigured: boolean
  profileLoading: boolean
  onOpenConfiguration: () => void
}) {
  const assistant = useAssistant(scope, open)
  const { selectSession } = assistant
  const [draft, setDraft] = useState('')
  const draftRef = useRef(draft)
  const activeSessionIdRef = useRef(assistant.activeId)
  const closingSessionIdsRef = useRef(new Set<string>())
  const closedSessionIdsRef = useRef(new Set<string>())
  const draftRestoreAfterCloseRef = useRef<{ sessionId: string; message: string } | null>(null)
  draftRef.current = draft
  activeSessionIdRef.current = assistant.activeId
  const [historySearch, setHistorySearch] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const historyButtonRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const activeSession = assistant.activeSession
  const history = historySessions.map(session => ({ session, scope: historyScopeLabel(session, tickets) }))
    .filter(({ session, scope: label }) => `${session.title} ${label}`.toLowerCase().includes(historySearch.trim().toLowerCase()))

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
    if (open) requestAnimationFrame(() => textareaRef.current?.focus())
  }, [open])

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (!draft.trim() || !activeSession?.canResume || assistant.sending || !chatModelConfigured) return
    const message = draft
    const sessionId = assistant.activeId
    draftRef.current = ''
    setDraft('')
    void assistant.sendMessage(message).then(sent => {
      if (sent || !sessionId || !textareaRef.current || activeSessionIdRef.current !== sessionId || draftRef.current || closedSessionIdsRef.current.has(sessionId)) return
      if (closingSessionIdsRef.current.has(sessionId)) draftRestoreAfterCloseRef.current = { sessionId, message }
      else {
        draftRef.current = message
        setDraft(message)
      }
    })
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const closeConversation = (id: string) => {
    closingSessionIdsRef.current.add(id)
    void assistant.closeSession(id).then(closed => {
      closingSessionIdsRef.current.delete(id)
      if (closed) closedSessionIdsRef.current.add(id)
      const pending = draftRestoreAfterCloseRef.current
      if (pending?.sessionId !== id) return
      draftRestoreAfterCloseRef.current = null
      if (!closed && textareaRef.current && activeSessionIdRef.current === id && !draftRef.current) {
        draftRef.current = pending.message
        setDraft(pending.message)
      }
    })
  }

  const selectHistory = (session: AssistantSessionSummary) => {
    closedSessionIdsRef.current.delete(session.id)
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
            return (
              <div key={id} className="flex shrink-0 items-center rounded-md border border-border bg-muted/40">
                <button
                  type="button"
                  aria-pressed={assistant.activeId === id}
                  onClick={() => assistant.selectSession(id)}
                  title={title}
                  className={`max-w-28 truncate rounded-l-md px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${assistant.activeId === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {title}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${title} conversation`}
                  title={`Close ${title}`}
                  disabled={assistant.closingId === id}
                  onClick={() => closeConversation(id)}
                  className="rounded-r-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {assistant.closingId === id ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> : <X className="h-3 w-3" aria-hidden="true" />}
                </button>
              </div>
            )
          })}
        </div>
        <button type="button" aria-label="New chat" title="New chat" disabled={assistant.creating} onClick={() => void assistant.createSession()} className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {assistant.creating ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
        </button>
        <div ref={historyRef} className="relative shrink-0">
          <button ref={historyButtonRef} type="button" aria-expanded={historyOpen} aria-controls={listId} onClick={() => { onHistoryOpenChange(!historyOpen); setHistorySearch('') }} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title="Conversation history">
            <History className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Conversation history</span>
          </button>
          {historyOpen && (
            <div
              id={listId}
              className="absolute right-0 top-full z-[70] mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl"
              aria-label="Archived conversations"
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
                <input autoFocus value={historySearch} onChange={event => setHistorySearch(event.target.value)} placeholder="Search history" aria-label="Search conversation history" className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
              </label>
              {historyError && <p role="alert" className="mt-2 rounded-md bg-destructive/5 px-2 py-1.5 text-xs text-destructive">{historyError}</p>}
              <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                {history.map(({ session, scope: label }) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      aria-label={`Open ${session.title || 'Untitled conversation'} — ${label} — ${new Date(session.updatedAt).toLocaleString()} — ${session.id}`}
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
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" role="log" aria-label="Conversation messages" aria-live="off">
          {assistant.loading && assistant.openIds.length === 0 && <p className="text-sm text-muted-foreground">Loading conversations…</p>}
          {assistant.opening && <p className="text-sm text-muted-foreground">Opening conversation…</p>}
          {!assistant.opening && !activeSession && assistant.openIds.length === 0 && !assistant.loading && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <MessageCircle className="h-8 w-8 text-muted-foreground/70" aria-hidden="true" />
              <p className="text-sm font-medium">Ask LoopTroop</p>
              <p className="max-w-64 text-xs text-muted-foreground">Start a chat for help with the app or questions about your tickets.</p>
            </div>
          )}
          {activeSession?.messages.map(message => (
            <article key={message.id} className={`mb-3 rounded-lg px-3 py-2 text-sm ${message.role === 'user' ? 'ml-6 bg-muted' : 'mr-2 bg-accent/50'}`}>
              <p className="mb-1 text-[11px] font-semibold text-muted-foreground">{message.role === 'user' ? 'You' : 'Assistant'}</p>
              {message.role === 'assistant'
                ? <AssistantMarkdown>{message.content}</AssistantMarkdown>
                : <p className="whitespace-pre-wrap break-words">{message.content}</p>}
            </article>
          ))}
          {assistant.pendingReply && (
            <article className="mb-3 mr-2 rounded-lg bg-accent/50 px-3 py-2 text-sm">
              <p className="mb-1 text-[11px] font-semibold text-muted-foreground">You</p>
              <p className="whitespace-pre-wrap break-words">{assistant.pendingReply.message}</p>
              <p className="mb-1 mt-3 text-[11px] font-semibold text-muted-foreground">Assistant</p>
              {assistant.pendingReply.reply
                ? <AssistantMarkdown>{assistant.pendingReply.reply}</AssistantMarkdown>
                : <span className="sr-only" role="status">Assistant is responding</span>}
              <LoaderCircle className="mt-2 h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
            </article>
          )}
        </div>

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
              onChange={event => { draftRef.current = event.target.value; setDraft(event.target.value); assistant.setError(null) }}
              onKeyDown={handleComposerKeyDown}
              placeholder={activeSession?.canResume ? 'Ask a question…' : 'Start a new chat to send a message'}
              disabled={!activeSession?.canResume || !chatModelConfigured || profileLoading || assistant.sending}
              rows={1}
              className="max-h-28 min-h-9 flex-1 resize-y bg-transparent px-1.5 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="submit"
              aria-label="Send message"
              title="Send message"
              disabled={!draft.trim() || !activeSession?.canResume || !chatModelConfigured || profileLoading || assistant.sending}
              className="mb-0.5 rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {assistant.sending ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
            </button>
          </div>
          <p className="mt-1.5 px-1 text-[10px] text-muted-foreground">Enter to send · Shift+Enter for a new line</p>
        </form>
      </div>
    </div>
  )
}

function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="assistant-markdown break-words text-sm leading-relaxed [&_a]:text-brand-600 [&_a]:underline dark:[&_a]:text-brand-400 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
      <ReactMarkdown components={{
        img: ({ src, alt }) => src ? <a href={src} aria-label={alt || 'Open image link'}>{alt || 'View image'}</a> : <span>{alt || 'Image'}</span>,
      }}>{children}</ReactMarkdown>
    </div>
  )
}

function historyScopeLabel(session: AssistantSessionSummary, tickets: Array<{ id: string; externalId: string }>): string {
  if (session.mode === 'help') return 'Help · All views'
  if (!session.ticketId) return 'Tickets · All tickets'
  const ticket = tickets.find(item => item.id === session.ticketId)
  return `Tickets · ${ticket?.externalId ?? `Ticket ${session.ticketId}`}`
}
