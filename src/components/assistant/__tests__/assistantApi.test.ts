import { afterEach, expect, it, vi } from 'vitest'
import { createAssistantSession, fetchAssistantHistory, fetchAssistantSessions, readAssistantEvents, sendAssistantMessage } from '../assistantApi'

afterEach(() => vi.unstubAllGlobals())

it('lists dashboard chats separately from global history and scopes a ticket by encoded id', async () => {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('[]')))
  vi.stubGlobal('fetch', fetchMock)
  const signal = new AbortController().signal

  await fetchAssistantSessions({}, signal)
  await fetchAssistantSessions({ ticketId: 'project/T-4 ?' }, signal)

  const dashboardUrl = new URL(fetchMock.mock.calls[0]![0] as string, 'http://localhost')
  const ticketUrl = new URL(fetchMock.mock.calls[1]![0] as string, 'http://localhost')
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    '/api/chat/sessions?scope=dashboard',
    '/api/chat/sessions?ticketId=project%2FT-4+%3F',
  ])
  expect([...dashboardUrl.searchParams.entries()]).toEqual([['scope', 'dashboard']])
  expect([...ticketUrl.searchParams.entries()]).toEqual([['ticketId', 'project/T-4 ?']])
})

it('loads global history without a mode or ticket filter', async () => {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('[]')))
  vi.stubGlobal('fetch', fetchMock)
  await fetchAssistantHistory(new AbortController().signal)
  expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions', expect.any(Object))
})

it('sends only the selected ticket as assistant session context', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response('{}'))
    .mockResolvedValueOnce(new Response(new ReadableStream()))
  vi.stubGlobal('fetch', fetchMock)
  const signal = new AbortController().signal

  await createAssistantSession({ ticketId: 'project/T-4' }, signal)
  await sendAssistantMessage('session-id', 'Question', { ticketId: 'project/T-4' }, signal)

  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ ticketId: 'project/T-4' })
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ ticketId: 'project/T-4', message: 'Question' })
})

it('parses SSE events split across arbitrary network chunks', async () => {
  const controller = new AbortController()
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(reader) {
      reader.enqueue(encoder.encode('data: {"type":"del'))
      reader.enqueue(encoder.encode('ta","text":"Hi"}\r\n\r\ndata: {"type":"error","error":"stop"}\n\n'))
      reader.close()
    },
  })

  const events = []
  for await (const event of readAssistantEvents(new Response(stream), controller.signal)) events.push(event)
  expect(events).toEqual([{ type: 'delta', text: 'Hi' }, { type: 'error', error: 'stop' }])
})

it('joins multiple SSE data lines into one event payload', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(reader) {
      reader.enqueue(new TextEncoder().encode('data: {"type":"delta",\ndata: "text":"joined"}\n\n'))
      reader.close()
    },
  })
  const events = []
  for await (const event of readAssistantEvents(new Response(stream), new AbortController().signal)) events.push(event)
  expect(events).toEqual([{ type: 'delta', text: 'joined' }])
})

it('rejects malformed assistant events instead of silently dropping them', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(reader) {
      reader.enqueue(new TextEncoder().encode('data: {"type":"delta","text":4}\n\n'))
    },
    cancel() { cancelled = true },
  })
  const events = readAssistantEvents(new Response(stream), new AbortController().signal)
  await expect(events.next()).rejects.toThrow('Invalid assistant response event')
  expect(cancelled).toBe(true)
})
