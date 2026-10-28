import { afterEach, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { randomUUID } from 'node:crypto'
import type { AssistantSession, AssistantSessionSummary } from '@shared/assistant'
import { useAssistant } from '../useAssistant'

const api = vi.hoisted(() => ({
  fetchAssistantHistory: vi.fn(),
  fetchAssistantSession: vi.fn(),
  createAssistantSession: vi.fn(),
  renameAssistantSession: vi.fn(),
  closeAssistantSession: vi.fn(),
  sendAssistantMessage: vi.fn(),
  readAssistantEvents: vi.fn(),
}))

vi.mock('@/components/assistant/assistantApi', () => api)

afterEach(() => vi.resetAllMocks())

function summary(ticketId: string | null, overrides: Partial<AssistantSessionSummary> = {}): AssistantSessionSummary {
  const createdAt = '2026-10-01T12:00:00.000Z'
  return {
    id: randomUUID(),
    ticketId,
    title: 'Assistant chat',
    archived: false,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  }
}

function detail(item: AssistantSessionSummary, messages: AssistantSession['messages'] = []): AssistantSession {
  return { ...item, messages, canResume: true, saved: true }
}

it('loads all live sessions once and keeps their tabs and original scope across view changes', async () => {
  const ticketId = randomUUID()
  const ticketChat = summary(ticketId)
  const dashboardChat = summary(null)
  const archivedChat = summary(randomUUID(), { archived: true })
  api.fetchAssistantHistory.mockResolvedValue([ticketChat, dashboardChat, archivedChat])
  api.fetchAssistantSession.mockImplementation(async (id: string) => detail(
    [ticketChat, dashboardChat, archivedChat].find(item => item.id === id) ?? dashboardChat,
  ))

  const hook = renderHook(({ currentTicketId }: { currentTicketId?: string }) => useAssistant(
    currentTicketId ? { ticketId: currentTicketId } : {}, true,
  ), { initialProps: { currentTicketId: undefined as string | undefined } })

  await waitFor(() => expect(hook.result.current.openIds).toEqual([ticketChat.id, dashboardChat.id]))
  expect(hook.result.current.sessions.map(item => item.id)).toEqual([ticketChat.id, dashboardChat.id, archivedChat.id])
  await waitFor(() => expect(api.fetchAssistantSession).toHaveBeenCalledWith(ticketChat.id, { ticketId }, expect.any(AbortSignal)))

  hook.rerender({ currentTicketId: randomUUID() })
  expect(hook.result.current.activeId).toBe(ticketChat.id)
  expect(hook.result.current.openIds).toEqual([ticketChat.id, dashboardChat.id])
  expect(api.fetchAssistantHistory).toHaveBeenCalledTimes(1)

  act(() => hook.result.current.selectSession(dashboardChat.id))
  await waitFor(() => expect(api.fetchAssistantSession).toHaveBeenCalledWith(dashboardChat.id, {}, expect.any(AbortSignal)))
  expect(hook.result.current.activeId).toBe(dashboardChat.id)
})

it('uses each conversation scope for send, rename, close and copy while new chats use the current view', async () => {
  const originalTicketId = randomUUID()
  const currentTicketId = randomUUID()
  const ticketChat = summary(originalTicketId)
  const currentChat = summary(currentTicketId, { title: 'New in current view' })
  const finished = detail(ticketChat, [
    { id: randomUUID(), role: 'user', content: 'Question', createdAt: '' },
    { id: randomUUID(), role: 'assistant', content: 'Complete reply', createdAt: '' },
  ])
  api.fetchAssistantHistory.mockResolvedValueOnce([ticketChat]).mockResolvedValueOnce([{ ...ticketChat, archived: true }])
  api.fetchAssistantSession.mockResolvedValue(detail(ticketChat, [
    { id: randomUUID(), role: 'user', content: 'Question', createdAt: new Date(0).toISOString() },
    { id: randomUUID(), role: 'assistant', content: 'Earlier reply', createdAt: new Date(0).toISOString() },
  ]))
  api.sendAssistantMessage.mockResolvedValue(new Response(''))
  api.renameAssistantSession.mockResolvedValue({ ...ticketChat, title: 'Renamed' })
  api.closeAssistantSession.mockResolvedValue(undefined)
  api.createAssistantSession.mockResolvedValue(detail(currentChat))

  let finishStream!: () => void
  const streamGate = new Promise<void>(resolve => { finishStream = resolve })
  api.readAssistantEvents.mockImplementation(async function* () {
    yield { type: 'reasoning', text: '', streaming: true, modelId: 'model-id', variant: 'high' }
    yield { type: 'reasoning', text: 'Working through the evidence', streaming: true }
    yield { type: 'delta', text: 'Partial reply' }
    await streamGate
    yield { type: 'done', session: finished }
  })

  const hook = renderHook(({ currentTicketId: ticketId }: { currentTicketId: string }) => useAssistant(
    { ticketId }, true,
  ), { initialProps: { currentTicketId } })
  await waitFor(() => expect(hook.result.current.activeSession?.id).toBe(ticketChat.id))

  let send!: Promise<boolean>
  act(() => { send = hook.result.current.sendMessage('Question') })
  await waitFor(() => expect(hook.result.current.pendingReply).toMatchObject({
    message: 'Question',
    reply: 'Partial reply',
    reasoningStarted: true,
    reasoning: 'Working through the evidence',
    modelId: 'model-id',
    variant: 'high',
  }))
  expect(api.sendAssistantMessage).toHaveBeenCalledWith(ticketChat.id, 'Question', { ticketId: originalTicketId }, expect.any(AbortSignal))

  const copied = await hook.result.current.getConversation(ticketChat.id)
  expect(api.fetchAssistantSession).toHaveBeenLastCalledWith(ticketChat.id, { ticketId: originalTicketId }, expect.any(AbortSignal))
  expect(copied?.messages.slice(-2).map(message => [message.role, message.content])).toEqual([
    ['user', 'Question'],
    ['assistant', 'Partial reply'],
  ])
  expect(copied?.messages.at(-1)).toMatchObject({ modelId: 'model-id', variant: 'high' })

  expect(await hook.result.current.renameSession(ticketChat.id, 'Renamed')).toBe(true)
  expect(api.renameAssistantSession).toHaveBeenCalledWith(ticketChat.id, 'Renamed', { ticketId: originalTicketId }, expect.any(AbortSignal))

  const created = await hook.result.current.createSession()
  expect(created?.id).toBe(currentChat.id)
  expect(api.createAssistantSession).toHaveBeenCalledWith({ ticketId: currentTicketId }, expect.any(AbortSignal))

  await act(async () => {
    finishStream()
    await expect(send).resolves.toBe(true)
  })
  expect(await hook.result.current.closeSession(ticketChat.id)).toBe(true)
  expect(api.closeAssistantSession).toHaveBeenCalledWith(ticketChat.id, { ticketId: originalTicketId }, expect.any(AbortSignal))
})
