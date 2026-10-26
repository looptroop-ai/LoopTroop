import { afterEach, expect, it, vi } from 'vitest'
import { fetchAssistantHistory, fetchAssistantSessions, readAssistantEvents } from '../assistantApi'

afterEach(() => vi.unstubAllGlobals())

it('keeps dashboard ticket history unfiltered and scopes a ticket session by encoded id', async () => {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('[]')))
  vi.stubGlobal('fetch', fetchMock)
  const signal = new AbortController().signal

  await fetchAssistantSessions({ mode: 'tickets' }, signal)
  await fetchAssistantSessions({ mode: 'tickets', ticketId: 'project/T-4 ?' }, signal)

  const dashboardUrl = new URL(fetchMock.mock.calls[0]![0] as string, 'http://localhost')
  const ticketUrl = new URL(fetchMock.mock.calls[1]![0] as string, 'http://localhost')
  expect([...dashboardUrl.searchParams.entries()]).toEqual([['mode', 'tickets']])
  expect([...ticketUrl.searchParams.entries()]).toEqual([['mode', 'tickets'], ['ticketId', 'project/T-4 ?']])
})

it('loads global history without a mode or ticket filter', async () => {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('[]')))
  vi.stubGlobal('fetch', fetchMock)
  await fetchAssistantHistory(new AbortController().signal)
  expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions', expect.any(Object))
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

it('rejects malformed assistant events instead of silently dropping them', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(reader) {
      reader.enqueue(new TextEncoder().encode('data: {"type":"delta","text":4}\n\n'))
      reader.close()
    },
  })
  const events = readAssistantEvents(new Response(stream), new AbortController().signal)
  await expect(events.next()).rejects.toThrow('Invalid assistant response event')
})
