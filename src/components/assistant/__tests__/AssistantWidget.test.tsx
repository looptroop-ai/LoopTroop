import { useEffect, useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AssistantSession, AssistantSessionSummary } from '@shared/assistant'
import { UIContext, type UIState } from '@/context/uiContextDef'
import { AssistantWidget } from '../AssistantWidget'

const mockProfile = vi.hoisted(() => ({ data: { chatModel: 'provider/model' as string | null }, isLoading: false }))
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => mockProfile,
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
  mockProfile.data.chatModel = 'provider/model'
  mockProfile.isLoading = false
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('disables new conversations while the assistant model is missing or loading', async () => {
  mockProfile.data.chatModel = null
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])))
  vi.stubGlobal('fetch', fetchMock)
  const view = render(widget())

  const newChat = await screen.findByRole('button', { name: 'New chat' })
  expect(newChat).toBeDisabled()
  expect(fetchMock).not.toHaveBeenCalledWith('/api/chat/sessions', expect.objectContaining({ method: 'POST' }))

  mockProfile.data.chatModel = 'provider/model'
  mockProfile.isLoading = true
  view.rerender(widget())
  expect(newChat).toBeDisabled()
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
  expect(await screen.findByRole('textbox', { name: 'Search conversation history' })).toHaveFocus()
  fireEvent.click(await screen.findByRole('button', { name: /Open How do I configure this\? — Help · All views/ }))
  expect(await screen.findByRole('button', { name: 'How do I configure this?', pressed: true })).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('log').parentElement).toHaveFocus())
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

it('evicts an open chat when a refreshed session list no longer contains it', async () => {
  const chat = detail({
    id: 'deleted-ticket-chat',
    mode: 'tickets',
    ticketId: 'project/17:LT-6',
    title: 'Deleted ticket chat',
    messages: [{ id: 'old-answer', role: 'assistant', content: 'Old ticket context.', createdAt }],
  })
  let listedSessions: AssistantSessionSummary[] = [chat]
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === `/api/chat/sessions/${chat.id}`) return jsonResponse(chat)
    return url.searchParams.get('mode') === 'tickets' ? jsonResponse(listedSessions) : jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  const ticketUi = { ...baseUiState, activeView: 'ticket' as const, selectedTicketId: 'project/17:LT-6', selectedTicketExternalId: 'LT-6' }
  const view = render(widget(ticketUi))

  fireEvent.click(screen.getByRole('button', { name: 'Tickets' }))
  expect(await screen.findByRole('button', { name: 'Deleted ticket chat', pressed: true })).toBeInTheDocument()
  expect(await screen.findByText('Old ticket context.')).toBeInTheDocument()

  view.rerender(widget(ticketUi, false))
  listedSessions = []
  view.rerender(widget(ticketUi, true))

  await waitFor(() => expect(screen.queryByRole('button', { name: 'Deleted ticket chat' })).not.toBeInTheDocument())
  await waitFor(() => expect(screen.queryByText('Old ticket context.')).not.toBeInTheDocument())
  expect(await screen.findByText('Ask LoopTroop')).toBeInTheDocument()
})

it('retries loading a conversation when its active tab is selected again', async () => {
  const chat = summary({ id: 'retry-detail-session', title: 'Retry detail chat' })
  let detailCalls = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === `/api/chat/sessions/${chat.id}`) {
      detailCalls += 1
      return detailCalls === 1
        ? jsonResponse({ error: 'Temporary failure' }, 503)
        : jsonResponse(detail({ ...chat, messages: [{ id: 'reloaded', role: 'assistant', content: 'Loaded on retry.', createdAt }] }))
    }
    return url.searchParams.get('mode') === 'help' ? jsonResponse([chat]) : jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  const tab = await screen.findByRole('button', { name: 'Retry detail chat', pressed: true })
  expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503: Temporary failure')
  fireEvent.click(tab)

  expect(await screen.findByText('Loaded on retry.')).toBeInTheDocument()
  expect(detailCalls).toBe(2)
})

it('treats a close 404 as already closed and ignores an in-flight detail response', async () => {
  const chat = summary({ id: 'late-detail-session', title: 'Late detail chat' })
  const pendingDetail: { resolve: ((response: Response) => void) | null; signal: AbortSignal | null } = { resolve: null, signal: null }
  let closed = false
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === `/api/chat/sessions/${chat.id}`) {
      pendingDetail.signal = init?.signal ?? null
      return new Promise<Response>(resolve => { pendingDetail.resolve = resolve })
    }
    if (url.pathname.endsWith('/close')) {
      closed = true
      return jsonResponse({ error: 'Conversation not found' }, 404)
    }
    return url.searchParams.get('mode') === 'help' ? jsonResponse(closed ? [] : [chat]) : jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  expect(await screen.findByRole('button', { name: 'Close Late detail chat conversation' })).toBeInTheDocument()
  await waitFor(() => expect(pendingDetail.resolve).toBeTypeOf('function'))
  fireEvent.click(screen.getByRole('button', { name: 'Close Late detail chat conversation' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Late detail chat' })).not.toBeInTheDocument())
  expect(pendingDetail.signal?.aborted).toBe(true)

  const resolveDetail = pendingDetail.resolve
  if (!resolveDetail) throw new Error('Expected the pending detail response')
  resolveDetail(jsonResponse(detail({ ...chat, messages: [{ id: 'late', role: 'assistant', content: 'Must stay closed.', createdAt }] })))
  await waitFor(() => expect(screen.queryByText('Must stay closed.')).not.toBeInTheDocument())
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('keeps the jump control visible when a reply finishes after the user scrolls up', async () => {
  const activeStream: { controller: ReadableStreamDefaultController<Uint8Array> | null } = { controller: null }
  let created = false
  const chat = detail({ id: 'scroll-session', title: 'Scroll chat' })
  const finished = detail({
    ...chat,
    messages: [
      { id: 'saved-question', role: 'user', content: 'Question while reading', createdAt },
      { id: 'saved-answer', role: 'assistant', content: 'The saved reply.', createdAt },
    ],
  })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') {
      created = true
      return jsonResponse(chat)
    }
    if (url.pathname.endsWith('/messages')) {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          activeStream.controller = controller
          controller.enqueue(encoder.encode('data: {"type":"delta","text":"partial reply"}\n\n'))
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    return created && url.searchParams.get('mode') === 'help' ? jsonResponse([chat]) : jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  fireEvent.change(composer, { target: { value: 'Question while reading' } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(await screen.findByText('partial reply')).toBeInTheDocument()
  const pendingQuestion = screen.getByText('Question while reading').closest('article')
  expect(pendingQuestion).toHaveClass('ml-6', 'bg-muted')

  const viewport = screen.getByRole('log')
  let scrollTop = 500
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 500 },
    scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value } },
  })
  scrollTop = 100
  fireEvent.scroll(viewport)
  const jumpButton = screen.getByRole('button', { name: 'Back to bottom' })
  expect(jumpButton.parentElement).toBe(viewport.parentElement)

  const encoder = new TextEncoder()
  if (!activeStream.controller) throw new Error('Expected the assistant response stream')
  activeStream.controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', session: finished })}\n\n`))
  activeStream.controller.close()
  expect(await screen.findByText('The saved reply.')).toBeInTheDocument()
  expect(jumpButton).toBeInTheDocument()
})

it('does not send Enter while an IME composition is active', async () => {
  const chat = detail({ id: 'ime-session', title: 'IME chat' })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') return jsonResponse(chat)
    if (url.pathname.endsWith('/messages')) return jsonResponse({ error: 'Model unavailable' }, 503)
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  fireEvent.change(composer, { target: { value: 'Composed text' } })
  fireEvent.keyDown(composer, { key: 'Enter', isComposing: true })
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/messages'))).toHaveLength(0)
  expect(composer).toHaveValue('Composed text')

  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503: Model unavailable')
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/messages'))).toHaveLength(1)
})

it('switches between open conversation tabs without creating or closing a session', async () => {
  const first = summary({ id: 'first-session', title: 'First chat' })
  const second = detail({ id: 'second-session', title: 'Second chat' })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') return jsonResponse(second)
    if (url.pathname === `/api/chat/sessions/${first.id}`) return jsonResponse(detail(first))
    return jsonResponse([first])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  expect(await screen.findByRole('button', { name: 'First chat', pressed: true })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  expect(await screen.findByRole('button', { name: 'Second chat', pressed: true })).toBeInTheDocument()
  await waitFor(() => expect(composer).toHaveFocus())
  fireEvent.click(screen.getByRole('button', { name: 'First chat', pressed: false }))
  expect(screen.getByRole('button', { name: 'First chat', pressed: true })).toBeInTheDocument()
})

it('keeps a separate composer draft for each open conversation', async () => {
  const first = summary({ id: 'first-session', title: 'First chat' })
  const second = detail({ id: 'second-session', title: 'Second chat' })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') return jsonResponse(second)
    if (url.pathname === `/api/chat/sessions/${first.id}`) return jsonResponse(detail(first))
    return jsonResponse([first])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  fireEvent.change(composer, { target: { value: 'Draft for first chat' } })
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Second chat', pressed: true })).toBeInTheDocument())
  expect(composer).toHaveValue('')
  fireEvent.change(composer, { target: { value: 'Draft for second chat' } })

  fireEvent.click(screen.getByRole('button', { name: 'First chat', pressed: false }))
  expect(composer).toHaveValue('Draft for first chat')
  fireEvent.click(screen.getByRole('button', { name: 'Second chat', pressed: false }))
  expect(composer).toHaveValue('Draft for second chat')
})

it('restores a failed send to its conversation after switching tabs', async () => {
  const streams: { controllers: ReadableStreamDefaultController<Uint8Array>[] } = { controllers: [] }
  const first = detail({ id: 'first-session', title: 'First chat' })
  const second = detail({ id: 'second-session', title: 'Second chat' })
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/messages')) {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.controllers.push(controller)
          controller.enqueue(encoder.encode('data: {"type":"delta","text":"working"}\n\n'))
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.pathname === `/api/chat/sessions/${first.id}`) return jsonResponse(first)
    if (url.pathname === `/api/chat/sessions/${second.id}`) return jsonResponse(second)
    return jsonResponse([first, second])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeEnabled())
  const firstMessage = 'Keep this with the first chat.'
  fireEvent.change(composer, { target: { value: firstMessage } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(await screen.findByText('working')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Second chat', pressed: false }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Second chat', pressed: true })).toBeInTheDocument())
  fireEvent.change(composer, { target: { value: 'Draft for the second chat.' } })
  const encoder = new TextEncoder()
  const streamController = streams.controllers[0]
  if (!streamController) throw new Error('Expected the first assistant stream')
  streamController.enqueue(encoder.encode('data: {"type":"error","error":"Provider rejected the message"}\n\n'))
  streamController.close()
  expect(await screen.findByRole('alert')).toHaveTextContent('Provider rejected the message')

  fireEvent.click(screen.getByRole('button', { name: 'First chat', pressed: false }))
  expect(composer).toHaveValue(firstMessage)
  fireEvent.click(screen.getByRole('button', { name: 'Second chat', pressed: false }))
  expect(composer).toHaveValue('Draft for the second chat.')
})

it('restores failed drafts to their original scope without replacing the current scope draft', async () => {
  const helpStream: { fail: (() => void) | null } = { fail: null }
  const helpChat = detail({ id: 'help-scope-session', title: 'Help scope chat' })
  const ticketChat = detail({ id: 'ticket-scope-session', mode: 'tickets', title: 'Ticket scope chat' })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') {
      return jsonResponse(JSON.parse(String(init.body)).mode === 'help' ? helpChat : ticketChat)
    }
    if (url.pathname.endsWith('/messages')) {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"delta","text":"working"}\n\n'))
          helpStream.fail = () => {
            controller.enqueue(encoder.encode('data: {"type":"error","error":"Provider rejected the message"}\n\n'))
            controller.close()
          }
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.pathname === `/api/chat/sessions/${helpChat.id}`) return jsonResponse(helpChat)
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  const helpMessage = 'Keep the Help draft.'
  fireEvent.change(composer, { target: { value: helpMessage } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(await screen.findByText('working')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Tickets' }))
  fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Ticket scope chat', pressed: true })).toBeInTheDocument())
  const ticketDraft = 'Keep the Tickets draft.'
  fireEvent.change(composer, { target: { value: ticketDraft } })
  const fail = helpStream.fail
  if (!fail) throw new Error('Expected the Help response stream')
  fail()
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/chat/sessions/${helpChat.id}?mode=help`, expect.any(Object)))

  fireEvent.click(screen.getByRole('button', { name: 'Help' }))
  expect(composer).toHaveValue(helpMessage)
  fireEvent.click(screen.getByRole('button', { name: 'Tickets' }))
  expect(composer).toHaveValue(ticketDraft)
})

it('refreshes the saved transcript after an accepted stream fails and keeps the draft', async () => {
  const chat = detail({ id: 'partially-saved-session', title: 'Recovery chat' })
  const refreshed = detail({
    ...chat,
    messages: [
      { id: 'persisted-user', role: 'user', content: 'Question that was saved', createdAt },
      { id: 'persisted-answer', role: 'assistant', content: 'Saved before the connection dropped.', createdAt },
    ],
  })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') return jsonResponse(chat)
    if (url.pathname.endsWith('/messages')) {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"delta","text":"partial"}\n\n'))
          controller.enqueue(encoder.encode('data: {"type":"error","error":"Connection dropped"}\n\n'))
          controller.close()
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.pathname === `/api/chat/sessions/${chat.id}`) return jsonResponse(refreshed)
    return jsonResponse([chat])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  const message = 'Keep this message for retry.'
  fireEvent.change(composer, { target: { value: message } })
  fireEvent.keyDown(composer, { key: 'Enter' })

  expect(await screen.findByText('Saved before the connection dropped.')).toBeInTheDocument()
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection dropped')
  expect(composer).toHaveValue(message)
  expect(fetchMock).toHaveBeenCalledWith(`/api/chat/sessions/${chat.id}?mode=help`, expect.any(Object))
})

it('closes history on outside click and Escape, and reports conversations for deleted tickets', async () => {
  const missingTicketChat = summary({ id: 'missing-ticket-session', mode: 'tickets', ticketId: 'project/19:LT-9', title: 'Deleted ticket chat', archived: true })
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && !url.search) return jsonResponse([missingTicketChat])
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  const dispatch = vi.fn()
  render(widget(baseUiState, true, vi.fn(), dispatch))

  const historyButton = await screen.findByRole('button', { name: 'Conversation history' })
  fireEvent.click(historyButton)
  const deletedTicket = await screen.findByRole('button', { name: /Open Deleted ticket chat/ })
  expect(deletedTicket).toHaveAccessibleName(/Tickets · Ticket LT-9/)
  fireEvent.click(deletedTicket)
  expect(await screen.findByRole('alert')).toHaveTextContent('Ticket LT-9 is no longer available')
  expect(screen.getByRole('dialog', { name: 'Conversation history' })).toBeInTheDocument()
  expect(dispatch).not.toHaveBeenCalled()

  fireEvent.pointerDown(document.body)
  await waitFor(() => expect(historyButton).toHaveAttribute('aria-expanded', 'false'))
  fireEvent.click(historyButton)
  const search = await screen.findByRole('textbox', { name: 'Search conversation history' })
  fireEvent.keyDown(search, { key: 'Escape' })
  await waitFor(() => expect(historyButton).toHaveAttribute('aria-expanded', 'false'))
  expect(historyButton).toHaveFocus()
})

it('shows a useful error when global history cannot be loaded', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    return url.pathname === '/api/chat/sessions' && !url.search
      ? jsonResponse({ error: 'History unavailable' }, 503)
      : jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  fireEvent.click(await screen.findByRole('button', { name: 'Conversation history' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load conversation history (HTTP 503: History unavailable)')
})

it('restores the composer draft when the send request fails before the assistant accepts it', async () => {
  const chat = detail({
    id: 'failed-send-session',
    title: 'Retry chat',
    messages: [{ id: 'previous-answer', role: 'assistant', content: 'Previous answer stays visible.', createdAt }],
  })
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
  expect(screen.getByText('Previous answer stays visible.')).toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalledWith(`/api/chat/sessions/${chat.id}?mode=help`, expect.any(Object))
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
    if (url.pathname === '/api/chat/sessions') {
      if (url.searchParams.get('mode') === 'tickets') return jsonResponse([])
      if (url.searchParams.get('mode') === 'help') return jsonResponse([open, archived])
      return jsonResponse([open, archived])
    }
    throw new Error(`Unexpected assistant request: ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const view = render(widget())

  const historyButton = await screen.findByRole('button', { name: 'Conversation history' })
  fireEvent.click(historyButton)
  fireEvent.change(screen.getByRole('textbox', { name: 'Search conversation history' }), { target: { value: 'planning' } })
  fireEvent.click(await screen.findByRole('button', { name: /Open Old planning chat/ }))
  expect(await screen.findByRole('button', { name: 'Old planning chat', pressed: true })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Tickets' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions?mode=tickets', expect.any(Object)))
  expect(screen.queryByRole('button', { name: 'Old planning chat', pressed: true })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Help' }))
  expect(await screen.findByRole('button', { name: 'Old planning chat', pressed: true })).toBeInTheDocument()

  view.rerender(widget(baseUiState, false))
  expect(document.querySelector('.assistant-markdown')).not.toBeInTheDocument()
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

it('finishes a reply in the background when the assistant scope changes', async () => {
  const sentSignals: AbortSignal[] = []
  const streams: { controllers: ReadableStreamDefaultController<Uint8Array>[] } = { controllers: [] }
  let sessionCreated = false
  const newSession = detail({ id: 'new-session', title: 'New conversation' })
  const finishedSession = detail({
    ...newSession,
    messages: [
      { id: 'user-message', role: 'user', content: 'Question before switching modes', createdAt },
      { id: 'assistant-message', role: 'assistant', content: 'Finished in the background.', createdAt },
    ],
  })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') {
      sessionCreated = true
      return jsonResponse(newSession)
    }
    if (url.pathname.endsWith('/messages')) {
      if (init?.signal) sentSignals.push(init.signal)
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.controllers.push(controller)
          controller.enqueue(encoder.encode('data: {"type":"delta","text":"streaming reply"}\n\n'))
          sentSignals.at(0)?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.pathname === '/api/chat/sessions') {
      return jsonResponse(sessionCreated && url.searchParams.get('mode') === 'help' ? [newSession] : [])
    }
    throw new Error(`Unexpected assistant request: ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  fireEvent.change(composer, { target: { value: 'Question before switching modes' } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(await screen.findByText('streaming reply')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Tickets' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions?mode=tickets', expect.any(Object)))
  expect(sentSignals).toHaveLength(1)
  expect(sentSignals.at(0)?.aborted).toBe(false)
  expect(screen.queryByText('streaming reply')).not.toBeInTheDocument()

  const encoder = new TextEncoder()
  const streamController = streams.controllers[0]
  if (!streamController) throw new Error('Expected the background assistant stream')
  streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', session: finishedSession })}\n\n`))
  streamController.close()
  fireEvent.click(screen.getByRole('button', { name: 'Help' }))
  expect(await screen.findByText('Finished in the background.')).toBeInTheDocument()
  expect(await screen.findByRole('status')).toHaveTextContent('Assistant response complete.')
})

it('lets closing the active tab stop and archive a running reply', async () => {
  const requests: { sentSignal: AbortSignal | null; resolveClose: ((response: Response) => void) | null } = { sentSignal: null, resolveClose: null }
  const chat = detail({ id: 'running-session', title: 'Running chat' })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') return jsonResponse(chat)
    if (url.pathname.endsWith('/messages')) {
      requests.sentSignal = init?.signal ?? null
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"delta","text":"working"}\n\n'))
          requests.sentSignal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.pathname.endsWith('/close')) {
      return new Promise<Response>(resolve => { requests.resolveClose = resolve })
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
  await waitFor(() => expect(requests.resolveClose).toBeTypeOf('function'))
  expect(composer).toBeDisabled()
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/messages'))).toHaveLength(1)
  const resolveClose = requests.resolveClose
  if (!resolveClose) throw new Error('Expected the pending close request')
  resolveClose(new Response(null, { status: 204 }))
  await waitFor(() => expect(requests.sentSignal?.aborted).toBe(true))
  expect(screen.queryByText('working')).not.toBeInTheDocument()
  expect(composer).toHaveValue('')
})

it('restores a failed message after closing its tab fails', async () => {
  const chat = detail({ id: 'close-failure-session', title: 'Close failure chat' })
  const closeResolvers: Array<(response: Response) => void> = []
  const failStreams: Array<() => void> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') return jsonResponse(chat)
    if (url.pathname.endsWith('/messages')) {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"delta","text":"working"}\n\n'))
          failStreams.push(() => {
            controller.enqueue(encoder.encode('data: {"type":"error","error":"Provider rejected the message"}\n\n'))
            controller.close()
          })
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.pathname.endsWith('/close')) return new Promise<Response>(resolve => closeResolvers.push(resolve))
    if (url.pathname === `/api/chat/sessions/${chat.id}`) return jsonResponse(chat)
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  const message = 'Keep this draft if closing fails.'
  fireEvent.change(composer, { target: { value: message } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(await screen.findByText('working')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Close Close failure chat conversation' }))
  await waitFor(() => expect(closeResolvers).toHaveLength(1))

  const failStream = failStreams[0]
  if (!failStream) throw new Error('Expected the pending assistant response')
  failStream()
  await screen.findByRole('alert')
  expect(composer).toHaveValue('')
  const resolveClose = closeResolvers[0]
  if (!resolveClose) throw new Error('Expected pending assistant close request')
  resolveClose(jsonResponse({ error: 'Close unavailable' }, 503))

  await waitFor(() => expect(composer).toHaveValue(message))
})

it('renders model image markdown as a user-activated link without loading the image', async () => {
  const chat = detail({
    id: 'image-session',
    messages: [
      { id: 'assistant-message', role: 'assistant', content: '![A flow diagram](https://example.com/diagram.png)', createdAt },
      { id: 'unsafe-image', role: 'assistant', content: '![Unsafe image](javascript:alert(1))', createdAt },
    ],
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
  expect(imageLink).toHaveAttribute('target', '_blank')
  expect(imageLink).toHaveAttribute('rel', 'noopener noreferrer')
  expect(screen.getByText('Unsafe image')).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Unsafe image' })).not.toBeInTheDocument()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

it('opens web citations separately and renders local evidence paths as text', async () => {
  const chat = detail({
    id: 'links-session',
    messages: [{
      id: 'assistant-message',
      role: 'assistant',
      content: '[Documentation](https://docs.example.com/guide) · [source](projects/1/source/src/App.tsx) · [unsafe](javascript:alert(1))',
      createdAt,
    }],
  })
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    return url.pathname === `/api/chat/sessions/${chat.id}`
      ? jsonResponse(chat)
      : jsonResponse([summary({ id: chat.id, title: chat.title })])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  const documentationLink = await screen.findByRole('link', { name: 'Documentation' })
  expect(documentationLink).toHaveAttribute('target', '_blank')
  expect(documentationLink).toHaveAttribute('rel', 'noopener noreferrer')
  expect(screen.queryByRole('link', { name: 'source' })).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'unsafe' })).not.toBeInTheDocument()
  expect(screen.getByText('projects/1/source/src/App.tsx').closest('code')).toBeInTheDocument()
  expect(screen.getByText('unsafe').closest('code')).toBeInTheDocument()
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
  await waitFor(() => expect(screen.getByRole('log').parentElement).toHaveFocus())
  fireEvent.click(screen.getByRole('button', { name: 'Tickets' }))
  expect(screen.getByRole('dialog', { name: 'LoopTroop assistant' })).toHaveClass('h-[min(620px,calc(100dvh-10rem))]', 'w-[min(420px,calc(100vw-2rem))]')

  fireEvent.keyDown(panel, { key: 'Escape' })
  expect(onDismiss).toHaveBeenCalledOnce()
  expect(dashboardDismiss).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open LoopTroop assistant' })).toHaveFocus())
  expect(panel).toHaveAttribute('hidden')
})
