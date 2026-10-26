import { useEffect, useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AssistantSession, AssistantSessionSummary } from '@shared/assistant'
import { UIContext, type UIState } from '@/context/uiContextDef'
import { AssistantWidget } from '../AssistantWidget'

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ data: { chatModel: 'provider/model' }, isLoading: false }),
}))
vi.mock('@/hooks/useTickets', () => ({
  useTickets: () => ({ data: [{ id: 'project/17:LT-6', externalId: 'LT-6' }] }),
}))

const createdAt = '2026-10-01T12:00:00.000Z'
const baseUiState: UIState = {
  selectedTicketId: null,
  selectedTicketExternalId: null,
  sidebarOpen: true,
  activeView: 'kanban',
  logPanelHeight: 300,
  filters: {
    projectId: 44,
    status: ['CODING'],
    phase: ['implementation'],
    search: 'filtered from tickets assistant scope',
    priority: [1],
    stuckDays: 7,
    errorState: 'blocked',
    sortBy: 'updatedAt_desc',
    showMocks: false,
  },
  presetsByProject: {},
  theme: 'system',
  showTriageBar: true,
}

function summary(overrides: Partial<AssistantSessionSummary> = {}): AssistantSessionSummary {
  return {
    id: 'session-1',
    mode: 'help',
    ticketId: null,
    title: 'Current chat',
    archived: false,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  }
}

function detail(overrides: Partial<AssistantSession> = {}): AssistantSession {
  return {
    ...summary(),
    messages: [],
    canResume: true,
    saved: true,
    ...overrides,
  }
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function widget(state = baseUiState, open = true, onDismiss = vi.fn(), dispatch = vi.fn()) {
  return (
    <UIContext.Provider value={{ state, dispatch }}>
      <AssistantWidget open={open} launcherVisible onOpen={vi.fn()} onDismiss={onDismiss} onOpenConfiguration={vi.fn()} />
    </UIContext.Provider>
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('uses every ticket on the dashboard, then scopes the ticket mode to the selected ticket only', async () => {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])))
  vi.stubGlobal('fetch', fetchMock)
  const view = render(widget())
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions?mode=help', expect.any(Object)))

  fireEvent.click(screen.getByRole('button', { name: 'Tickets' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions?mode=tickets', expect.any(Object)))

  const ticketUi = {
    ...baseUiState,
    activeView: 'ticket' as const,
    selectedTicketId: 'project/17:LT-6',
    selectedTicketExternalId: 'LT-6',
  }
  view.rerender(widget(ticketUi))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions?mode=tickets&ticketId=project%2F17%3ALT-6', expect.any(Object)))
  expect(fetchMock.mock.calls.map(call => String(call[0])).filter(url => url.includes('mode=tickets'))).toEqual([
    '/api/chat/sessions?mode=tickets',
    '/api/chat/sessions?mode=tickets&ticketId=project%2F17%3ALT-6',
  ])
})

it('navigates to the ticket named by global history before loading its chat', async () => {
  const ticketChat = summary({ id: 'ticket-session', mode: 'tickets', ticketId: 'project/17:LT-6', title: 'Ticket questions', archived: true })
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && !url.search) return jsonResponse([ticketChat])
    if (url.pathname === `/api/chat/sessions/${ticketChat.id}`) return jsonResponse(detail({ ...ticketChat, canResume: false }))
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  const dispatch = vi.fn()
  const view = render(widget(baseUiState, true, vi.fn(), dispatch))

  fireEvent.click(await screen.findByRole('button', { name: 'Conversation history' }))
  fireEvent.click(await screen.findByRole('button', { name: /Open Ticket questions — Tickets · LT-6/ }))
  expect(dispatch).toHaveBeenCalledWith({ type: 'SELECT_TICKET', ticketId: 'project/17:LT-6', externalId: 'LT-6' })

  view.rerender(widget({
    ...baseUiState,
    activeView: 'ticket',
    selectedTicketId: 'project/17:LT-6',
    selectedTicketExternalId: 'LT-6',
  }, true, vi.fn(), dispatch))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions/ticket-session?mode=tickets&ticketId=project%2F17%3ALT-6', expect.any(Object)))
  expect(await screen.findByRole('button', { name: 'Ticket questions', pressed: true })).toBeInTheDocument()
})

it('opens help history from a ticket view without navigating away from the ticket', async () => {
  const helpChat = summary({ id: 'help-session', title: 'How do I configure this?', archived: true })
  const ticketState = { ...baseUiState, activeView: 'ticket' as const, selectedTicketId: 'project/17:LT-6', selectedTicketExternalId: 'LT-6' }
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && !url.search) return jsonResponse([helpChat])
    if (url.pathname === `/api/chat/sessions/${helpChat.id}`) return jsonResponse(detail({ ...helpChat, canResume: false }))
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  const dispatch = vi.fn()
  render(widget(ticketState, true, vi.fn(), dispatch))

  fireEvent.click(await screen.findByRole('button', { name: 'Conversation history' }))
  fireEvent.click(await screen.findByRole('button', { name: /Open How do I configure this\? — Help · All views/ }))
  expect(await screen.findByRole('button', { name: 'How do I configure this?', pressed: true })).toBeInTheDocument()
  expect(dispatch).not.toHaveBeenCalled()
  expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions/help-session?mode=help', expect.any(Object))
})

it('returns to the dashboard before opening global ticket history', async () => {
  const boardChat = summary({ id: 'board-session', mode: 'tickets', title: 'All tickets chat', archived: true })
  const ticketState = { ...baseUiState, activeView: 'ticket' as const, selectedTicketId: 'project/17:LT-6', selectedTicketExternalId: 'LT-6' }
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && !url.search) return jsonResponse([boardChat])
    if (url.pathname === `/api/chat/sessions/${boardChat.id}`) return jsonResponse(detail({ ...boardChat, canResume: false }))
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  const dispatch = vi.fn()
  const view = render(widget(ticketState, true, vi.fn(), dispatch))

  fireEvent.click(await screen.findByRole('button', { name: 'Conversation history' }))
  fireEvent.click(await screen.findByRole('button', { name: /Open All tickets chat — Tickets · All tickets/ }))
  expect(dispatch).toHaveBeenCalledWith({ type: 'CLOSE_TICKET' })

  view.rerender(widget(baseUiState, true, vi.fn(), dispatch))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions/board-session?mode=tickets', expect.any(Object)))
  expect(screen.getByRole('button', { name: 'All tickets chat', pressed: true })).toBeInTheDocument()
})

it('restores same-runtime temporary tabs when switching away from and back to their scope', async () => {
  const temporary = summary({ id: 'temporary-session', title: 'Unsaved notes' })
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === `/api/chat/sessions/${temporary.id}`) return jsonResponse(detail({ ...temporary, saved: false }))
    if (url.searchParams.get('mode') === 'help') return jsonResponse([temporary])
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  expect(await screen.findByRole('button', { name: 'Unsaved notes', pressed: true })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Tickets' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions?mode=tickets', expect.any(Object)))
  fireEvent.click(screen.getByRole('button', { name: 'Help' }))
  expect(await screen.findByRole('button', { name: 'Unsaved notes', pressed: true })).toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/\/close$/), expect.anything())
})

it('restores the composer draft when the send request fails before the assistant accepts it', async () => {
  const chat = detail({ id: 'failed-send-session', title: 'Retry chat' })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') return jsonResponse(chat)
    if (url.pathname.endsWith('/messages')) return jsonResponse({ error: 'Model unavailable' }, 503)
    if (url.pathname === `/api/chat/sessions/${chat.id}`) return jsonResponse(chat)
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  const message = 'Please keep this draft if sending fails.'
  fireEvent.change(composer, { target: { value: message } })
  fireEvent.keyDown(composer, { key: 'Enter' })

  expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503: Model unavailable')
  await waitFor(() => expect(composer).toHaveValue(message))
})

it('reopens archived conversations from searchable history and lets the server decide close behavior', async () => {
  const open = summary({ id: 'session-open', title: 'Current chat' })
  const archived = summary({ id: 'session-archived', title: 'Old planning chat', archived: true })
  const closeRequests: Array<{ url: string; init?: RequestInit }> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') return jsonResponse(detail({ ...open, messages: [] }))
    if (url.pathname === `/api/chat/sessions/${archived.id}`) return jsonResponse(detail({ ...archived, canResume: true }))
    if (url.pathname === `/api/chat/sessions/${open.id}`) return jsonResponse(detail(open))
    if (url.pathname.endsWith('/close')) {
      closeRequests.push({ url: url.pathname, init })
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/api/chat/sessions') return jsonResponse(url.search ? [open] : [open, archived])
    throw new Error(`Unexpected assistant request: ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const view = render(widget())

  const historyButton = await screen.findByRole('button', { name: 'Conversation history' })
  fireEvent.click(historyButton)
  fireEvent.change(screen.getByRole('textbox', { name: 'Search conversation history' }), { target: { value: 'planning' } })
  fireEvent.click(await screen.findByRole('button', { name: /Open Old planning chat/ }))
  expect(await screen.findByRole('button', { name: 'Old planning chat', pressed: true })).toBeInTheDocument()

  view.rerender(widget(baseUiState, false))
  view.rerender(widget())
  expect(await screen.findByRole('button', { name: 'Old planning chat', pressed: true })).toBeInTheDocument()
  await waitFor(() => expect(screen.queryByText('Opening conversation…')).not.toBeInTheDocument())

  fireEvent.click(screen.getByRole('button', { name: 'Close Old planning chat conversation' }))
  await waitFor(() => expect(closeRequests).toHaveLength(1))
  const closeRequest = closeRequests[0]
  if (!closeRequest) throw new Error('Expected assistant close request')
  expect(closeRequest.url).toBe(`/api/chat/sessions/${archived.id}/close`)
  expect(JSON.parse(String(closeRequest.init?.body))).toEqual({ mode: 'help' })

  fireEvent.click(historyButton)
  expect(await screen.findByRole('button', { name: /Open Old planning chat/ })).toBeInTheDocument()
})

it('aborts an in-flight reply when the assistant scope changes', async () => {
  let sentSignal: AbortSignal | null = null
  const newSession = detail({ id: 'new-session', title: 'New conversation' })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') return jsonResponse(newSession)
    if (url.pathname.endsWith('/messages')) {
      sentSignal = init?.signal ?? null
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"delta","text":"stale reply"}\n\n'))
          sentSignal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.pathname === '/api/chat/sessions') return jsonResponse([])
    throw new Error(`Unexpected assistant request: ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  fireEvent.change(composer, { target: { value: 'Question before switching modes' } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(await screen.findByText('stale reply')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Tickets' }))
  await waitFor(() => expect(sentSignal?.aborted).toBe(true))
  expect(screen.queryByText('stale reply')).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toHaveValue('')
})

it('lets closing the active tab stop and archive a running reply', async () => {
  let sentSignal: AbortSignal | null = null
  let closeCalled = false
  const chat = detail({ id: 'running-session', title: 'Running chat' })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') return jsonResponse(chat)
    if (url.pathname.endsWith('/messages')) {
      sentSignal = init?.signal ?? null
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"delta","text":"working"}\n\n'))
          sentSignal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.pathname.endsWith('/close')) {
      closeCalled = true
      return new Response(null, { status: 204 })
    }
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  fireEvent.change(composer, { target: { value: 'Stop when I close this tab' } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(await screen.findByText('working')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Close Running chat conversation' }))
  await waitFor(() => expect(closeCalled).toBe(true))
  await waitFor(() => expect(sentSignal?.aborted).toBe(true))
  expect(screen.queryByText('working')).not.toBeInTheDocument()
  expect(composer).toHaveValue('')
})

it('renders model image markdown as a user-activated link without loading the image', async () => {
  const chat = detail({
    id: 'image-session',
    messages: [{ id: 'assistant-message', role: 'assistant', content: '![A flow diagram](https://example.com/diagram.png)', createdAt }],
  })
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    return url.pathname === `/api/chat/sessions/${chat.id}`
      ? jsonResponse(chat)
      : jsonResponse([summary({ id: chat.id, title: chat.title })])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  const imageLink = await screen.findByRole('link', { name: 'A flow diagram' })
  expect(imageLink).toHaveAttribute('href', 'https://example.com/diagram.png')
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

it('keeps a fixed accessible size across modes and Escape dismisses the window back to its launcher', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([]))))
  const onDismiss = vi.fn()
  const dashboardDismiss = vi.fn()
  function DashboardEscapeListener() {
    useEffect(() => {
      const handle = (event: KeyboardEvent) => { if (event.key === 'Escape') dashboardDismiss() }
      document.addEventListener('keydown', handle)
      return () => document.removeEventListener('keydown', handle)
    }, [])
    return <div>Ticket dashboard</div>
  }
  function Controlled() {
    const [open, setOpen] = useState(true)
    return (
      <UIContext.Provider value={{ state: baseUiState, dispatch: vi.fn() }}>
        <DashboardEscapeListener />
        <AssistantWidget open={open} launcherVisible onOpen={() => setOpen(true)} onDismiss={() => { onDismiss(); setOpen(false) }} onOpenConfiguration={vi.fn()} />
      </UIContext.Provider>
    )
  }
  render(<Controlled />)

  const panel = screen.getByRole('dialog', { name: 'LoopTroop assistant' })
  expect(panel).toHaveClass('h-[min(620px,calc(100dvh-10rem))]', 'w-[min(420px,calc(100vw-2rem))]')
  expect(screen.getByRole('button', { name: 'Open LoopTroop assistant' })).toHaveClass('h-8', 'w-8')
  fireEvent.click(screen.getByRole('button', { name: 'Tickets' }))
  expect(screen.getByRole('dialog', { name: 'LoopTroop assistant' })).toHaveClass('h-[min(620px,calc(100dvh-10rem))]', 'w-[min(420px,calc(100vw-2rem))]')

  fireEvent.keyDown(panel, { key: 'Escape' })
  expect(onDismiss).toHaveBeenCalledOnce()
  expect(dashboardDismiss).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open LoopTroop assistant' })).toHaveFocus())
  expect(panel).toHaveAttribute('hidden')
})
