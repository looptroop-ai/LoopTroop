import { useEffect, useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AssistantSession, AssistantSessionSummary } from '@shared/assistant'
import { UIContext, type UIState } from '@/context/uiContextDef'
import { AssistantWidget } from '../AssistantWidget'

const mockProfile = vi.hoisted(() => ({ data: { chatModel: 'provider/model' as string | null }, isLoading: false }))
const mockProjects = vi.hoisted(() => ({ data: [{ id: 17, color: '#336699' }] }))
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => mockProfile,
}))
vi.mock('@/hooks/useTickets', () => ({
  useTickets: () => ({ data: [{ id: 'project/17:LT-6', externalId: 'LT-6', projectId: 17 }] }),
}))
vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ data: mockProjects.data }),
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
  Reflect.deleteProperty(navigator, 'clipboard')
})

it('keeps the launcher in the same fixed position on the dashboard and in a ticket', () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([]))))
  const view = render(widget(baseUiState, false))
  expect(screen.getByRole('button', { name: 'Open LoopTroop assistant' })).toHaveClass('fixed', 'bottom-9', 'right-[72px]')

  view.rerender(widget({ ...baseUiState, activeView: 'ticket', selectedTicketId: 'project/17:LT-6' }, false))
  expect(screen.getByRole('button', { name: 'Open LoopTroop assistant' })).toHaveClass('fixed', 'bottom-9', 'right-[72px]')
})

it('disables the composer while the assistant model is missing or loading', async () => {
  mockProfile.data.chatModel = null
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])))
  vi.stubGlobal('fetch', fetchMock)
  const view = render(widget())

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  expect(composer).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalledWith('/api/chat/sessions', expect.objectContaining({ method: 'POST' }))

  mockProfile.data.chatModel = 'provider/model'
  mockProfile.isLoading = true
  view.rerender(widget())
  expect(composer).toBeDisabled()
})

it('refreshes global conversations when the app scope changes', async () => {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])))
  vi.stubGlobal('fetch', fetchMock)
  const view = render(widget())
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions', expect.any(Object)))
  expect(screen.getByText('All tickets')).toBeInTheDocument()

  const ticketUi = {
    ...baseUiState,
    activeView: 'ticket' as const,
    selectedTicketId: 'project/17:LT-6',
    selectedTicketExternalId: 'LT-6',
  }
  view.rerender(widget(ticketUi))
  expect(screen.getByText('Ticket LT-6')).toBeInTheDocument()
  await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/chat/sessions')).toHaveLength(2))
})

it('starts the first chat on send and keeps New chat for opening another', async () => {
  const first = detail({ id: 'first-chat', title: 'First chat' })
  const second = detail({ id: 'second-chat', title: 'Second chat' })
  const finished = detail({
    ...first,
    messages: [
      { id: 'question', role: 'user', content: 'First question', createdAt },
      { id: 'answer', role: 'assistant', content: 'First answer', createdAt },
    ],
  })
  const createBodies: unknown[] = []
  let createCount = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') {
      createBodies.push(JSON.parse(String(init.body)))
      return jsonResponse(createCount++ === 0 ? first : second)
    }
    if (url.pathname.endsWith('/messages')) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'done', session: finished })}\n\n`))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeEnabled())
  expect(screen.queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument()
  fireEvent.change(composer, { target: { value: 'First question' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

  expect(await screen.findByText('First answer')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument()
  expect(createBodies).toEqual([{}])
  expect(JSON.parse(String(fetchMock.mock.calls.find(([input]) => String(input).endsWith('/messages'))?.[1]?.body))).toEqual({ message: 'First question' })

  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  expect(await screen.findByRole('button', { name: 'Second chat', pressed: true })).toBeInTheDocument()
  expect(createBodies).toEqual([{}, {}])
})

it('sends an initial message using the scope where creation began', async () => {
  const createRequest: { resolve: ((response: Response) => void) | null } = { resolve: null }
  let created = false
  const dashboardChat = detail({ id: 'dashboard-new-chat', title: 'Dashboard chat' })
  const finished = detail({
    ...dashboardChat,
    messages: [
      { id: 'question', role: 'user', content: 'Keep this on dashboard', createdAt },
      { id: 'answer', role: 'assistant', content: 'Dashboard answer', createdAt },
    ],
  })
  const createBodies: unknown[] = []
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') {
      createBodies.push(JSON.parse(String(init.body)))
      return new Promise(resolve => { createRequest.resolve = resolve })
    }
    if (url.pathname.endsWith('/messages')) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'done', session: finished })}\n\n`))
          controller.close()
        },
      })
      return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))
    }
    if (url.pathname === '/api/chat/sessions') {
      return Promise.resolve(jsonResponse(created ? [finished] : []))
    }
    return Promise.resolve(jsonResponse([]))
  })
  vi.stubGlobal('fetch', fetchMock)
  const view = render(widget())

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeEnabled())
  fireEvent.change(composer, { target: { value: 'Keep this on dashboard' } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  await waitFor(() => expect(createRequest.resolve).toBeTypeOf('function'))

  view.rerender(widget({ ...baseUiState, activeView: 'ticket', selectedTicketId: 'project/17:LT-6', selectedTicketExternalId: 'LT-6' }))
  expect(screen.getByText('Ticket LT-6')).toBeInTheDocument()
  const finishCreation = createRequest.resolve
  if (!finishCreation) throw new Error('Expected the pending assistant session creation')
  created = true
  finishCreation(jsonResponse(dashboardChat))

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/chat/sessions/${dashboardChat.id}/messages`, expect.any(Object)))
  expect(createBodies).toEqual([{}])
  const sendRequest = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/messages'))
  expect(JSON.parse(String(sendRequest?.[1]?.body))).toEqual({ message: 'Keep this on dashboard' })

  view.rerender(widget())
  expect(await screen.findByText('Dashboard answer')).toBeInTheDocument()
})

it('opens a ticket conversation from global history without changing the current screen', async () => {
  const ticketChat = summary({ id: 'ticket-session', ticketId: 'project/17:LT-6', title: 'Ticket questions', archived: true })
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && !url.search) return jsonResponse([ticketChat])
    if (url.pathname === `/api/chat/sessions/${ticketChat.id}`) return jsonResponse(detail({ ...ticketChat, canResume: false }))
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  const dispatch = vi.fn()
  render(widget(baseUiState, true, vi.fn(), dispatch))

  fireEvent.click(await screen.findByRole('button', { name: 'Conversation history' }))
  fireEvent.click(await screen.findByRole('button', { name: /Open Ticket questions — Ticket LT-6/ }))
  expect(dispatch).not.toHaveBeenCalled()
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions/ticket-session?ticketId=project%2F17%3ALT-6', expect.any(Object)))
  expect(await screen.findByRole('button', { name: 'Ticket questions', pressed: true })).toBeInTheDocument()
  expect(screen.getByText('Ticket LT-6')).toBeInTheDocument()
})

it('opens a dashboard conversation from ticket view without leaving the selected ticket', async () => {
  const helpChat = summary({ id: 'dashboard-session', title: 'How do I configure this?', archived: true })
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
  fireEvent.click(await screen.findByRole('button', { name: /Open How do I configure this\? — Dashboard · All tickets/ }))
  expect(dispatch).not.toHaveBeenCalled()
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions/dashboard-session', expect.any(Object)))
  expect(await screen.findByRole('button', { name: 'How do I configure this?', pressed: true })).toBeInTheDocument()
  expect(screen.getByText('All tickets')).toBeInTheDocument()
  expect(dispatch).not.toHaveBeenCalled()
})

it('switches ticket conversation tabs without changing the current screen or focus', async () => {
  const ticket6 = summary({ id: 'ticket-6-chat', ticketId: 'project/17:LT-6', title: 'LT-6 chat' })
  const ticket7 = summary({ id: 'ticket-7-chat', ticketId: 'project/17:LT-7', title: 'LT-7 chat' })
  const ticketState = (id: string, externalId: string) => ({
    ...baseUiState,
    activeView: 'ticket' as const,
    selectedTicketId: id,
    selectedTicketExternalId: externalId,
  })
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === `/api/chat/sessions/${ticket6.id}`) return jsonResponse(detail(ticket6))
    if (url.pathname === `/api/chat/sessions/${ticket7.id}`) return jsonResponse(detail(ticket7))
    if (url.pathname === '/api/chat/sessions') return jsonResponse([ticket6, ticket7])
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  const dispatch = vi.fn()
  const answerInput = <input aria-label="Ticket answer" />
  render(<>{answerInput}{widget(ticketState('project/17:LT-6', 'LT-6'), true, vi.fn(), dispatch)}</>)

  expect(await screen.findByRole('button', { name: 'LT-6 chat', pressed: true })).toBeInTheDocument()
  const focusedInput = screen.getByRole('textbox', { name: 'Ticket answer' })
  focusedInput.focus()

  fireEvent.click(screen.getByRole('button', { name: 'LT-7 chat', pressed: false }))
  expect(await screen.findByRole('button', { name: 'LT-7 chat', pressed: true })).toBeInTheDocument()
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    `/api/chat/sessions/${ticket7.id}?ticketId=project%2F17%3ALT-7`,
    expect.any(Object),
  ))
  expect(focusedInput).toHaveFocus()
  expect(screen.getByRole('textbox', { name: 'Ticket answer' })).toBeInTheDocument()
  expect(dispatch).not.toHaveBeenCalled()
})

it('keeps same-runtime temporary tabs open when app scope changes', async () => {
  const temporary = summary({ id: 'temporary-session', title: 'Unsaved notes' })
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === `/api/chat/sessions/${temporary.id}`) return jsonResponse(detail({ ...temporary, saved: false }))
    if (url.pathname === '/api/chat/sessions') return jsonResponse([temporary])
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  const view = render(widget())

  expect(await screen.findByRole('button', { name: 'Unsaved notes', pressed: true })).toBeInTheDocument()
  view.rerender(widget({ ...baseUiState, activeView: 'ticket', selectedTicketId: 'project/17:LT-6', selectedTicketExternalId: 'LT-6' }))
  expect(screen.getByRole('button', { name: 'Unsaved notes', pressed: true })).toBeInTheDocument()
  await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/chat/sessions')).toHaveLength(2))
  view.rerender(widget())
  expect(await screen.findByRole('button', { name: 'Unsaved notes', pressed: true })).toBeInTheDocument()
  await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/chat/sessions')).toHaveLength(3))
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/\/close$/), expect.anything())
})

it('evicts an open chat when a refreshed session list no longer contains it', async () => {
  const chat = detail({
    id: 'deleted-ticket-chat',
    ticketId: 'project/17:LT-6',
    title: 'Deleted ticket chat',
    messages: [{ id: 'old-answer', role: 'assistant', content: 'Old ticket context.', createdAt }],
  })
  let listedSessions: AssistantSessionSummary[] = [chat]
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === `/api/chat/sessions/${chat.id}`) return jsonResponse(chat)
    return url.pathname === '/api/chat/sessions' ? jsonResponse(listedSessions) : jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  const ticketUi = { ...baseUiState, activeView: 'ticket' as const, selectedTicketId: 'project/17:LT-6', selectedTicketExternalId: 'LT-6' }
  const view = render(widget(ticketUi))

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
    return url.pathname === '/api/chat/sessions' ? jsonResponse([chat]) : jsonResponse([])
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
    return url.pathname === '/api/chat/sessions' ? jsonResponse(closed ? [] : [chat]) : jsonResponse([])
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
    return url.pathname === '/api/chat/sessions' ? jsonResponse(created ? [chat] : []) : jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeEnabled())
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

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeEnabled())
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
  await waitFor(() => expect(composer).toBeEnabled())
  fireEvent.change(composer, { target: { value: 'Draft for first chat' } })
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Second chat', pressed: true })).toBeInTheDocument())
  expect(composer).toHaveValue('')
  fireEvent.change(composer, { target: { value: 'Draft for second chat' } })

  fireEvent.click(screen.getByRole('button', { name: 'First chat', pressed: false }))
  await waitFor(() => expect(composer).toBeEnabled())
  expect(composer).toHaveValue('Draft for first chat')
  fireEvent.click(screen.getByRole('button', { name: 'Second chat', pressed: false }))
  await waitFor(() => expect(composer).toBeEnabled())
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
  await waitFor(() => expect(composer).toBeEnabled())
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

it('keeps a newer draft in the active conversation when its reply fails across app scopes', async () => {
  const stream: { fail: (() => void) | null } = { fail: null }
  let created = false
  const dashboardChat = detail({ id: 'dashboard-scope-session', title: 'Dashboard chat' })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chat/sessions' && init?.method === 'POST') {
      created = true
      return jsonResponse(dashboardChat)
    }
    if (url.pathname.endsWith('/messages')) {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"delta","text":"working"}\n\n'))
          stream.fail = () => {
            controller.enqueue(encoder.encode('data: {"type":"error","error":"Provider rejected the message"}\n\n'))
            controller.close()
          }
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.pathname === '/api/chat/sessions') return jsonResponse(created ? [dashboardChat] : [])
    if (url.pathname === `/api/chat/sessions/${dashboardChat.id}`) return jsonResponse(dashboardChat)
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  const view = render(widget())

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeEnabled())
  const dashboardMessage = 'Keep the dashboard draft.'
  fireEvent.change(composer, { target: { value: dashboardMessage } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(await screen.findByText('working')).toBeInTheDocument()

  view.rerender(widget({ ...baseUiState, activeView: 'ticket', selectedTicketId: 'project/17:LT-6', selectedTicketExternalId: 'LT-6' }))
  expect(screen.getByText('All tickets')).toBeInTheDocument()
  await waitFor(() => expect(composer).toBeEnabled())
  const ticketDraft = 'Keep the ticket draft.'
  fireEvent.change(composer, { target: { value: ticketDraft } })
  const fail = stream.fail
  if (!fail) throw new Error('Expected the dashboard response stream')
  await act(async () => {
    fail()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/chat/sessions/${dashboardChat.id}`, expect.any(Object)))

  await waitFor(() => expect(composer).toHaveValue(ticketDraft))
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

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeEnabled())
  const message = 'Keep this message for retry.'
  fireEvent.change(composer, { target: { value: message } })
  fireEvent.keyDown(composer, { key: 'Enter' })

  expect(await screen.findByText('Saved before the connection dropped.')).toBeInTheDocument()
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection dropped')
  expect(composer).toHaveValue(message)
  expect(fetchMock).toHaveBeenCalledWith(`/api/chat/sessions/${chat.id}`, expect.any(Object))
})

it('closes history on outside click and Escape, and reports conversations for deleted tickets', async () => {
  const missingTicketChat = summary({ id: 'missing-ticket-session', ticketId: 'project/19:LT-9', title: 'Deleted ticket chat', archived: true })
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
  expect(deletedTicket).toHaveAccessibleName(/Ticket LT-9/)
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

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeEnabled())
  const message = 'Please keep this draft if sending fails.'
  fireEvent.change(composer, { target: { value: message } })
  fireEvent.keyDown(composer, { key: 'Enter' })

  expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503: Model unavailable')
  expect(screen.getByText('Previous answer stays visible.')).toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalledWith(`/api/chat/sessions/${chat.id}`, expect.any(Object))
  await waitFor(() => expect(composer).toHaveValue(message))
})

it('keeps an archived conversation tab open across app scopes and lets the server close it', async () => {
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

  view.rerender(widget({ ...baseUiState, activeView: 'ticket', selectedTicketId: 'project/17:LT-6', selectedTicketExternalId: 'LT-6' }))
  expect(screen.getByRole('button', { name: 'Old planning chat', pressed: true })).toBeInTheDocument()
  expect(screen.getByText('All tickets')).toBeInTheDocument()
  await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/chat/sessions')).toHaveLength(3))
  view.rerender(widget())
  expect(await screen.findByRole('button', { name: 'Old planning chat', pressed: true })).toBeInTheDocument()
  await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/chat/sessions')).toHaveLength(4))

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
  expect(JSON.parse(String(closeRequest.init?.body))).toEqual({})

  fireEvent.click(historyButton)
  expect(await screen.findByRole('button', { name: /Open Old planning chat/ })).toBeInTheDocument()
})

it('keeps a reply running when app scope changes away from the active conversation', async () => {
  const sentSignals: AbortSignal[] = []
  const streams: { controllers: ReadableStreamDefaultController<Uint8Array>[] } = { controllers: [] }
  let sessionCreated = false
  const newSession = detail({ id: 'new-session', title: 'New conversation' })
  const finishedSession = detail({
    ...newSession,
    messages: [
      { id: 'user-message', role: 'user', content: 'Question before switching tickets', createdAt },
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
      return jsonResponse(sessionCreated ? [newSession] : [])
    }
    throw new Error(`Unexpected assistant request: ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const view = render(widget())

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeEnabled())
  fireEvent.change(composer, { target: { value: 'Question before switching tickets' } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(await screen.findByText('streaming reply')).toBeInTheDocument()

  view.rerender(widget({ ...baseUiState, activeView: 'ticket', selectedTicketId: 'project/17:LT-6', selectedTicketExternalId: 'LT-6' }))
  expect(sentSignals).toHaveLength(1)
  expect(sentSignals.at(0)?.aborted).toBe(false)
  expect(screen.getByText('streaming reply')).toBeInTheDocument()
  expect(screen.getByText('All tickets')).toBeInTheDocument()

  const encoder = new TextEncoder()
  const streamController = streams.controllers[0]
  if (!streamController) throw new Error('Expected the background assistant stream')
  streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', session: finishedSession })}\n\n`))
  streamController.close()
  view.rerender(widget())
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

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeEnabled())
  fireEvent.change(composer, { target: { value: 'Stop when I close this tab' } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(await screen.findByText('working')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Close Running chat conversation' }))
  await waitFor(() => expect(requests.resolveClose).toBeTypeOf('function'))
  await waitFor(() => expect(requests.sentSignal?.aborted).toBe(true))
  expect(screen.getByRole('button', { name: 'Close Running chat conversation' })).toBeDisabled()
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
  const message = 'Keep this draft if closing fails.'
  const chat = detail({ id: 'close-failure-session', title: 'Close failure chat' })
  const refreshedChat = detail({
    ...chat,
    messages: [
      { id: 'saved-question', role: 'user', content: message, createdAt },
      { id: 'saved-answer', role: 'assistant', content: 'Saved before the close failed.', createdAt },
    ],
  })
  const requests: { sentSignal: AbortSignal | null; resolveClose: ((response: Response) => void) | null } = { sentSignal: null, resolveClose: null }
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
    if (url.pathname.endsWith('/close')) return new Promise<Response>(resolve => { requests.resolveClose = resolve })
    if (url.pathname === `/api/chat/sessions/${chat.id}`) return jsonResponse(refreshedChat)
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeEnabled())
  fireEvent.change(composer, { target: { value: message } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(await screen.findByText('working')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Close Close failure chat conversation' }))
  await waitFor(() => expect(requests.resolveClose).toBeTypeOf('function'))
  await waitFor(() => expect(requests.sentSignal?.aborted).toBe(true))
  expect(composer).toHaveValue('')
  expect(composer).toBeDisabled()
  const resolveClose = requests.resolveClose
  if (!resolveClose) throw new Error('Expected pending assistant close request')
  resolveClose(jsonResponse({ error: 'Close unavailable' }, 503))

  await waitFor(() => expect(composer).toHaveValue(message))
  expect(await screen.findByText('Saved before the close failed.')).toBeInTheDocument()
  expect(await screen.findByRole('alert')).toHaveTextContent('Close unavailable')
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

it('moves focus to the composer after the initial conversation list finishes loading', async () => {
  const listRequest: { resolve: ((response: Response) => void) | null } = { resolve: null }
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { listRequest.resolve = resolve })))
  render(widget())

  const composer = screen.getByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeDisabled())
  const conversation = screen.getByRole('log').parentElement
  const resolveList = listRequest.resolve
  if (!resolveList) throw new Error('Expected the pending conversation list request')
  await act(async () => {
    resolveList(jsonResponse([]))
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  await waitFor(() => expect(composer).toBeEnabled())
  await waitFor(() => expect(composer).toHaveFocus())
  expect(conversation).not.toHaveFocus()
})

it('keeps focus outside the assistant when its initial list finishes loading', async () => {
  const listRequest: { resolve: ((response: Response) => void) | null } = { resolve: null }
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { listRequest.resolve = resolve })))
  render(<><input aria-label="Dashboard search" />{widget()}</>)

  const composer = screen.getByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeDisabled())
  const outsideInput = screen.getByRole('textbox', { name: 'Dashboard search' })
  outsideInput.focus()
  const resolveList = listRequest.resolve
  if (!resolveList) throw new Error('Expected the pending conversation list request')
  await act(async () => {
    resolveList(jsonResponse([]))
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  await waitFor(() => expect(composer).toBeEnabled())
  expect(outsideInput).toHaveFocus()
})

it('keeps a fixed accessible size and Escape dismisses the window back to its launcher', async () => {
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
  expect(panel).toHaveClass('bottom-1', 'right-1')
  const launcher = screen.getByRole('button', { name: 'Open LoopTroop assistant' })
  expect(launcher).toHaveClass('p-2', 'bottom-9', 'right-[72px]', 'bg-primary-foreground', 'text-primary', 'opacity-70', 'hover:opacity-100')
  expect(launcher.querySelector('svg')).toHaveClass('h-4', 'w-4')
  expect(screen.queryByRole('button', { name: 'Help' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Tickets' })).not.toBeInTheDocument()
  const composer = screen.getByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeEnabled(), { timeout: 5000 })
  await waitFor(() => expect(composer).toHaveFocus(), { timeout: 5000 })

  fireEvent.keyDown(panel, { key: 'Escape' })
  expect(onDismiss).toHaveBeenCalledOnce()
  expect(dashboardDismiss).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open LoopTroop assistant' })).toHaveFocus())
  expect(panel).toHaveAttribute('hidden')
})

it('drags the assistant window, clamps it to the viewport, and restores its position for the tab session', () => {
  window.sessionStorage.clear()
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([]))))
  const view = render(widget())
  const panel = screen.getByRole('dialog', { name: 'LoopTroop assistant' })
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
    x: 100,
    y: 100,
    left: 100,
    top: 100,
    right: 400,
    bottom: 400,
    width: 300,
    height: 300,
    toJSON: () => ({}),
  } as DOMRect)

  act(() => fireEvent.pointerDown(panel.querySelector('header')!, { button: 0, pointerId: 7, clientX: 110, clientY: 110 }))
  act(() => fireEvent.pointerMove(window, { pointerId: 7, clientX: 310, clientY: 310 }))
  expect(panel).toHaveStyle({ left: '300px', top: '300px' })

  act(() => {
    fireEvent.pointerMove(window, { pointerId: 7, clientX: -20, clientY: -20 })
    fireEvent.pointerUp(window, { pointerId: 7 })
  })
  expect(panel).toHaveStyle({ left: '4px', top: '4px' })
  expect(JSON.parse(window.sessionStorage.getItem('looptroop.assistant.window-position')!)).toEqual({ left: 4, top: 4 })
  view.unmount()

  render(widget())
  const restoredPanel = screen.getByRole('dialog', { name: 'LoopTroop assistant' })
  vi.spyOn(restoredPanel, 'getBoundingClientRect').mockReturnValue({
    x: 4,
    y: 4,
    left: 4,
    top: 4,
    right: 304,
    bottom: 304,
    width: 300,
    height: 300,
    toJSON: () => ({}),
  } as DOMRect)
  const moveHandle = restoredPanel.querySelector('header')!
  fireEvent.keyDown(moveHandle, { key: 'ArrowRight' })
  expect(restoredPanel).toHaveStyle({ left: '20px', top: '4px' })
})

it('copies each message as plain text and reports clipboard failures', async () => {
  const chat = detail({
    id: 'copy-session',
    title: 'Copy chat',
    messages: [
      { id: 'copy-question', role: 'user', content: 'Question with **literal markdown**', createdAt },
      { id: 'copy-answer', role: 'assistant', content: '**Bold answer**', createdAt },
    ],
  })
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    return url.pathname === `/api/chat/sessions/${chat.id}`
      ? jsonResponse(chat)
      : jsonResponse([summary({ id: chat.id, title: chat.title })])
  })
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  const question = (await screen.findByText('Question with **literal markdown**')).closest('article')!
  fireEvent.click(within(question).getByRole('button', { name: 'Copy your message' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('Question with **literal markdown**'))

  const answer = (await screen.findByText('Bold answer')).closest('article')!
  fireEvent.click(within(answer).getByRole('button', { name: 'Copy assistant message' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('**Bold answer**'))

  writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'))
  fireEvent.click(within(answer).getByRole('button', { name: 'Copy assistant message' }))
  expect(await within(answer).findByRole('alert')).toHaveTextContent('Copy failed')
})

it('validates, cancels, and retries conversation renames without losing the entered title', async () => {
  const chat = summary({ id: 'rename-session', ticketId: 'project/17:LT-6', title: 'Ticket questions' })
  const renamed = summary({ ...chat, title: 'Renamed ticket chat' })
  const renameBodies: unknown[] = []
  let renameAttempts = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === `/api/chat/sessions/${chat.id}/title` && init?.method === 'PATCH') {
      renameBodies.push(JSON.parse(String(init.body)))
      return renameAttempts++ === 0
        ? jsonResponse({ error: 'Rename unavailable' }, 503)
        : jsonResponse(renamed)
    }
    if (url.pathname === `/api/chat/sessions/${chat.id}`) return jsonResponse(detail(chat))
    if (url.pathname === '/api/chat/sessions') return jsonResponse([chat])
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(widget())

  const options = await screen.findByRole('button', { name: 'More options for Ticket questions conversation' })
  fireEvent.pointerDown(options, { button: 0 })
  expect(await screen.findByRole('menu')).toHaveClass('z-[70]')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
  const firstDialog = await screen.findByRole('dialog', { name: 'Rename conversation' })
  expect(within(firstDialog).getByRole('textbox', { name: 'Conversation name' })).toHaveAttribute('maxLength', '100')
  fireEvent.click(within(firstDialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog', { name: 'Rename conversation' })).not.toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalledWith(`/api/chat/sessions/${chat.id}/title`, expect.anything())

  fireEvent.pointerDown(options, { button: 0 })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
  const renameDialog = await screen.findByRole('dialog', { name: 'Rename conversation' })
  const input = within(renameDialog).getByRole('textbox', { name: 'Conversation name' })
  fireEvent.change(input, { target: { value: '   ' } })
  fireEvent.click(within(renameDialog).getByRole('button', { name: 'Save' }))
  expect(within(renameDialog).getByRole('alert')).toHaveTextContent('Enter a conversation name.')
  expect(renameBodies).toHaveLength(0)

  fireEvent.change(input, { target: { value: 'Renamed ticket chat' } })
  fireEvent.click(within(renameDialog).getByRole('button', { name: 'Save' }))
  expect(await within(renameDialog).findByRole('alert')).toHaveTextContent('Could not rename this conversation.')
  expect(input).toHaveValue('Renamed ticket chat')
  expect(renameBodies[0]).toEqual({ ticketId: 'project/17:LT-6', title: 'Renamed ticket chat' })

  fireEvent.click(within(renameDialog).getByRole('button', { name: 'Save' }))
  expect(await screen.findByRole('button', { name: 'Renamed ticket chat', pressed: true })).toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: 'Rename conversation' })).not.toBeInTheDocument()
  expect(renameBodies).toEqual([
    { ticketId: 'project/17:LT-6', title: 'Renamed ticket chat' },
    { ticketId: 'project/17:LT-6', title: 'Renamed ticket chat' },
  ])
})

it('copies the selected conversation with an in-progress user message and assistant reply', async () => {
  const chat = detail({
    id: 'copy-live-session',
    title: 'Live copy chat',
    messages: [
      { id: 'saved-question', role: 'user', content: 'Earlier question', createdAt },
      { id: 'saved-answer', role: 'assistant', content: 'Earlier answer', createdAt },
    ],
  })
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === `/api/chat/sessions/${chat.id}`) return jsonResponse(chat)
    if (url.pathname.endsWith('/messages')) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([
            `data: ${JSON.stringify({ type: 'reasoning', text: 'Live reasoning', streaming: true, modelId: 'provider/model', variant: 'high' })}\n\n`,
            `data: ${JSON.stringify({ type: 'delta', text: 'Partial answer' })}\n\n`,
          ].join('')))
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    return jsonResponse([summary({ id: chat.id, title: chat.title })])
  }))
  render(widget())

  const composer = await screen.findByRole('textbox', { name: 'Message the assistant' })
  await waitFor(() => expect(composer).toBeEnabled())
  fireEvent.change(composer, { target: { value: 'Current question' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  expect(await screen.findByText('Partial answer')).toBeInTheDocument()
  const pendingThinking = screen.getByText('Thinking…', { selector: 'summary' })
  fireEvent.click(pendingThinking)
  expect(screen.getByText('Model: provider/model · Effort: high')).toBeVisible()
  expect(screen.getByText('Live reasoning')).toBeVisible()

  fireEvent.pointerDown(screen.getByRole('button', { name: 'More options for Live copy chat conversation' }), { button: 0 })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy conversation' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(
    'You:\nEarlier question\n\nAssistant:\nEarlier answer\n\nYou:\nCurrent question\n\nAssistant:\nPartial answer',
  ))
})

it('shows completed reasoning with its model details and labels missing reasoning', async () => {
  const chat = detail({
    id: 'thinking-session',
    title: 'Thinking chat',
    messages: [
      { id: 'thoughtful-answer', role: 'assistant', content: 'Answer with reasoning', reasoning: 'Completed reasoning text', modelId: 'provider/model', variant: 'balanced', createdAt },
      { id: 'next-question', role: 'user', content: 'Another question', createdAt },
      { id: 'unavailable-answer', role: 'assistant', content: 'Answer without reasoning', createdAt },
    ],
  })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    return url.pathname === `/api/chat/sessions/${chat.id}`
      ? jsonResponse(chat)
      : jsonResponse([summary({ id: chat.id, title: chat.title })])
  }))
  render(widget())

  const answer = (await screen.findByText('Answer with reasoning')).closest('article')!
  fireEvent.click(within(answer).getByText('Thinking', { selector: 'summary' }))
  expect(within(answer).getByText('Model: provider/model · Effort: balanced')).toBeVisible()
  expect(within(answer).getByText('Completed reasoning text')).toBeVisible()
  const unavailable = screen.getByText('Answer without reasoning').closest('article')!
  expect(within(unavailable).getByText('Thinking unavailable.')).toBeVisible()
})

it('shows one thinking section for multiple assistant steps in one answer', async () => {
  const chat = detail({ id: 'multi-step', title: 'Multi-step chat', messages: [
    { id: 'question', role: 'user', content: 'Question', createdAt },
    { id: 'step-1', role: 'assistant', content: '', reasoning: 'First thought', modelId: 'provider/model', variant: 'high', createdAt },
    { id: 'step-2', role: 'assistant', content: 'Final answer', reasoning: 'Second thought', modelId: 'provider/model', variant: 'high', createdAt },
    { id: 'next-question', role: 'user', content: 'Next question', createdAt },
    { id: 'next-answer', role: 'assistant', content: 'Next answer', reasoning: 'Next thought', createdAt },
  ] })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    return url.pathname === `/api/chat/sessions/${chat.id}`
      ? jsonResponse(chat)
      : jsonResponse([summary({ id: chat.id, title: chat.title })])
  }))
  render(widget())
  const answer = (await screen.findByText('Final answer')).closest('article')!
  expect(within(answer).getAllByText('Thinking', { selector: 'summary' })).toHaveLength(1)
  fireEvent.click(within(answer).getByText('Thinking', { selector: 'summary' }))
  expect(within(answer).getByText(/First thought/)).toHaveTextContent('Second thought')
  expect(screen.getAllByText('Thinking', { selector: 'summary' })).toHaveLength(2)
})

it('tints ticket conversation tabs with their project color and leaves dashboard tabs untinted', async () => {
  const ticketChat = summary({ id: 'colored-ticket-chat', ticketId: 'project/17:LT-6', title: 'Ticket chat' })
  const dashboardChat = summary({ id: 'dashboard-chat', title: 'Dashboard chat' })
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === `/api/chat/sessions/${ticketChat.id}`) return jsonResponse(detail(ticketChat))
    if (url.pathname === `/api/chat/sessions/${dashboardChat.id}`) return jsonResponse(detail(dashboardChat))
    if (url.pathname === '/api/chat/sessions') return jsonResponse([ticketChat, dashboardChat])
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetchMock)
  const ticketState = { ...baseUiState, activeView: 'ticket' as const, selectedTicketId: 'project/17:LT-6', selectedTicketExternalId: 'LT-6' }
  render(widget(ticketState))

  const ticketTab = await screen.findByRole('button', { name: 'Ticket chat', pressed: true })
  expect(ticketTab.parentElement).toHaveStyle({ borderColor: '#336699', backgroundColor: '#3366991a' })
  const dashboardTab = await screen.findByRole('button', { name: 'Dashboard chat' })
  expect(dashboardTab.parentElement).not.toHaveAttribute('style')
})
