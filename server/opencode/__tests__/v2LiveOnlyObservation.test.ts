import { describe, expect, it } from 'vitest'
import { OpenCodeSDKAdapter } from '../adapter'
import { V2OpenCodeTransport } from '../v2Transport'

const encoder = new TextEncoder()
const startCursor = 73

type LiveEvent = { type: string; seq: number; data: Record<string, unknown> }

interface LiveOnlyServerOptions {
  historicalEvents?: LiveEvent[]
  onConnect?: (emit: (event: LiveEvent) => void) => void
  onWait?: (emit: (event: LiveEvent) => void, setPending: (ids: string[]) => void) => void
  onPrompt?: (emit: (event: LiveEvent) => void) => void
  stallAfterCursorLog?: boolean
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

function emptyResponse(): Response {
  return new Response(null, { status: 204 })
}

function sseResponse(events: unknown[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encodeEvent(event))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

function encodeEvent(event: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`operation did not settle within ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function createLiveOnlyServer(options: LiveOnlyServerOptions = {}) {
  const requestOrder: string[] = []
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined
  let eventSignal: AbortSignal | undefined
  let eventSignalAborted = false
  let logSignalAborted = false
  let currentWatermark = startCursor
  let pendingInboxes: string[] = []
  let inboxReads = 0
  let promptPosted = false
  let promptPostCount = 0
  let logPayloadCount = 0
  const connected = deferred()
  const stalledLogOpened = deferred()
  const waitStarted = deferred()

  const emit = (event: LiveEvent) => {
    currentWatermark = Math.max(currentWatermark, event.seq)
    eventController?.enqueue(encodeEvent({
      type: event.type,
      data: event.data,
      durable: { aggregateID: 'session-1', seq: event.seq },
    }))
  }

  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
    const method = init.method ?? (input instanceof Request ? input.method : 'GET')

    if (url.pathname === '/api/session/session-1' && method === 'GET') {
      requestOrder.push('session')
      return jsonResponse({ data: { id: 'session-1', location: { directory: '/workspace' } } })
    }

    if (url.pathname === '/api/event' && method === 'GET') {
      requestOrder.push('event')
      eventSignal = init.signal ?? undefined
      eventSignal?.addEventListener('abort', () => { eventSignalAborted = true }, { once: true })
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          eventController = controller
          controller.enqueue(encodeEvent({ type: 'server.connected' }))
          connected.resolve()
          options.onConnect?.(emit)
          const failEventStream = () => {
            eventSignalAborted = true
            try { controller.error(eventSignal?.reason) } catch { /* already closed */ }
          }
          if (eventSignal?.aborted) failEventStream()
          else eventSignal?.addEventListener('abort', failEventStream, { once: true })
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    }

    if (url.pathname.endsWith('/log') && method === 'GET') {
      const after = url.searchParams.get('after')
      requestOrder.push(`log:${after ?? 'full'}`)
      if (after !== null && options.stallAfterCursorLog) {
        const signal = init.signal
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            stalledLogOpened.resolve()
            signal?.addEventListener('abort', () => {
              logSignalAborted = true
              try { controller.error(signal.reason) } catch { /* already closed */ }
            }, { once: true })
          },
        }), { headers: { 'content-type': 'text/event-stream' } })
      }
      const events: unknown[] = (options.historicalEvents ?? [])
        .filter(event => after === null || event.seq > Number(after))
        .map(event => ({
          type: event.type,
          data: event.data,
          durable: { aggregateID: 'session-1', seq: event.seq },
        }))
      logPayloadCount += events.length
      return sseResponse([
        ...events,
        { type: 'log.synced', aggregateID: 'session-1', seq: currentWatermark },
      ])
    }

    if (url.pathname.endsWith('/inbox') && method === 'GET') {
      requestOrder.push(`inbox:${inboxReads++}`)
      return jsonResponse({
        data: pendingInboxes.map(id => ({
          id,
          sessionID: 'session-1',
          type: 'prompt',
          delivery: 'queue',
        })),
      })
    }

    if (url.pathname.endsWith('/wait') && method === 'POST') {
      requestOrder.push('wait')
      waitStarted.resolve()
      options.onWait?.(emit, ids => { pendingInboxes = ids })
      return emptyResponse()
    }

    if (url.pathname === '/api/session/session-1/message' && method === 'GET') {
      requestOrder.push(`messages:${promptPosted ? 'after' : 'before'}`)
      return jsonResponse({ data: promptPosted ? [{
        id: 'assistant-own',
        type: 'assistant',
        sessionID: 'session-1',
        content: [{ type: 'text', text: 'live answer' }],
        finish: 'stop',
      }] : [] })
    }

    if (url.pathname.endsWith('/instructions/entries/looptroop')) return emptyResponse()

    if (url.pathname === '/api/session/session-1/prompt' && method === 'POST') {
      requestOrder.push('prompt')
      promptPosted = true
      promptPostCount++
      options.onPrompt?.(emit)
      return jsonResponse({ data: { id: 'inbox-own', sessionID: 'session-1' } })
    }

    throw new Error(`Unexpected ${method} ${url}`)
  }

  const transport = new V2OpenCodeTransport('http://127.0.0.1:4096', { fetch: fetcher })
  const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:4096', undefined, async () => transport)
  return {
    adapter,
    transport,
    requestOrder,
    connected: connected.promise,
    stalledLogOpened: stalledLogOpened.promise,
    waitStarted: waitStarted.promise,
    get eventSignalAborted() { return eventSignalAborted || Boolean(eventSignal?.aborted) },
    get logSignalAborted() { return logSignalAborted },
    get logPayloadCount() { return logPayloadCount },
    get promptPostCount() { return promptPostCount },
    get currentWatermark() { return currentWatermark },
  }
}

const promptParts = [{ type: 'text' as const, content: 'prompt' }]

describe('OpenCode v2 live-only event coverage', () => {
  it('uses contiguous live events through a positive watermark when a reused session has empty replay', async () => {
    const server = createLiveOnlyServer({
      onConnect(emit) {
        emit({ type: 'session.inbox.enqueued', seq: startCursor + 1, data: { sessionID: 'session-1', inboxID: 'inbox-old' } })
        emit({ type: 'session.execution.started', seq: startCursor + 2, data: { sessionID: 'session-1' } })
        emit({ type: 'session.inbox.delivered', seq: startCursor + 3, data: { sessionID: 'session-1', inboxID: 'inbox-old' } })
      },
      onWait(emit) {
        emit({ type: 'session.execution.succeeded', seq: startCursor + 4, data: { sessionID: 'session-1' } })
      },
      onPrompt(emit) {
        emit({ type: 'session.inbox.enqueued', seq: startCursor + 5, data: { sessionID: 'session-1', inboxID: 'inbox-own' } })
        emit({ type: 'session.execution.started', seq: startCursor + 6, data: { sessionID: 'session-1' } })
        emit({ type: 'session.inbox.delivered', seq: startCursor + 7, data: { sessionID: 'session-1', inboxID: 'inbox-own' } })
        emit({ type: 'session.execution.succeeded', seq: startCursor + 8, data: { sessionID: 'session-1' } })
      },
    })

    const historicalScan = await server.transport.readSessionLog('session-1')
    expect(historicalScan).toMatchObject({ events: [], cursor: startCursor, coverageComplete: false })

    await expect(server.adapter.promptSession('session-1', promptParts)).resolves.toBe('live answer')

    expect(server.promptPostCount).toBe(1)
    expect(server.logPayloadCount).toBe(0)
    expect(server.currentWatermark).toBe(startCursor + 8)
    expect(server.requestOrder.indexOf('event')).toBeLessThan(server.requestOrder.indexOf('wait'))
  })

  it('blocks a queued inbox observed before the idle baseline even when log replay is empty', async () => {
    const server = createLiveOnlyServer({
      onWait(emit, setPending) {
        setPending(['inbox-other'])
        emit({ type: 'session.inbox.enqueued', seq: startCursor + 1, data: { sessionID: 'session-1', inboxID: 'inbox-other' } })
      },
    })

    await expect(server.adapter.promptSession('session-1', promptParts)).rejects.toThrow()

    expect(server.promptPostCount).toBe(0)
    expect(server.requestOrder.indexOf('event')).toBeLessThan(server.requestOrder.indexOf('wait'))
    const waitIndex = server.requestOrder.indexOf('wait')
    const pendingCheckAfterWait = server.requestOrder.findIndex((item, index) => index > waitIndex && item.startsWith('inbox:'))
    expect(pendingCheckAfterWait).toBeGreaterThan(waitIndex)
    expect(server.requestOrder).not.toContain('prompt')
  })

  it('uses a nonempty reserved historical prefix only as a boundary before continuous live coverage', async () => {
    const server = createLiveOnlyServer({
      historicalEvents: [
        { type: 'session.inbox.enqueued', seq: 1, data: { sessionID: 'session-1', inboxID: 'inbox-old-1' } },
        { type: 'session.inbox.enqueued', seq: 3, data: { sessionID: 'session-1', inboxID: 'inbox-old-2' } },
      ],
      onConnect(emit) {
        emit({ type: 'session.inbox.enqueued', seq: startCursor + 1, data: { sessionID: 'session-1', inboxID: 'inbox-prior' } })
        emit({ type: 'session.execution.started', seq: startCursor + 2, data: { sessionID: 'session-1' } })
        emit({ type: 'session.inbox.delivered', seq: startCursor + 3, data: { sessionID: 'session-1', inboxID: 'inbox-prior' } })
      },
      onWait(emit) {
        emit({ type: 'session.execution.succeeded', seq: startCursor + 4, data: { sessionID: 'session-1' } })
      },
      onPrompt(emit) {
        emit({ type: 'session.inbox.enqueued', seq: startCursor + 5, data: { sessionID: 'session-1', inboxID: 'inbox-own' } })
        emit({ type: 'session.execution.started', seq: startCursor + 6, data: { sessionID: 'session-1' } })
        emit({ type: 'session.inbox.delivered', seq: startCursor + 7, data: { sessionID: 'session-1', inboxID: 'inbox-own' } })
        emit({ type: 'session.execution.succeeded', seq: startCursor + 8, data: { sessionID: 'session-1' } })
      },
    })

    await expect(server.adapter.promptSession('session-1', promptParts)).resolves.toBe('live answer')

    expect(server.requestOrder).toContain('log:full')
    expect(server.requestOrder).toContain(`log:${startCursor}`)
    expect(server.promptPostCount).toBe(1)
  })

  it('refuses a missing sequence after a nonempty reserved historical boundary', async () => {
    const server = createLiveOnlyServer({
      historicalEvents: [
        { type: 'session.inbox.enqueued', seq: 1, data: { sessionID: 'session-1', inboxID: 'inbox-old-1' } },
        { type: 'session.inbox.enqueued', seq: 3, data: { sessionID: 'session-1', inboxID: 'inbox-old-2' } },
      ],
      onConnect(emit) {
        emit({ type: 'session.inbox.enqueued', seq: startCursor + 2, data: { sessionID: 'session-1', inboxID: 'inbox-gap' } })
      },
    })

    await expect(server.adapter.promptSession('session-1', promptParts)).rejects.toThrow()

    expect(server.promptPostCount).toBe(0)
    expect(server.requestOrder).toContain(`log:${startCursor}`)
    expect(server.requestOrder).toContain('event')
    expect(server.requestOrder).not.toContain('prompt')
  })

  it('rejects a malformed post-boundary durable event before posting a prompt', async () => {
    const server = createLiveOnlyServer({
      onConnect(emit) {
        emit({ type: 'session.inbox.enqueued', seq: startCursor + 1, data: { sessionID: 'session-1' } })
      },
    })

    await expect(server.adapter.promptSession('session-1', promptParts)).rejects.toThrow()

    expect(server.promptPostCount).toBe(0)
    expect(server.requestOrder).not.toContain('prompt')
  })

  it('rejects unmapped old history instead of treating it as a trusted boundary', async () => {
    const server = createLiveOnlyServer({
      historicalEvents: [
        { type: 'session.unrecognized', seq: 1, data: { sessionID: 'session-1' } },
      ],
    })

    await expect(server.adapter.promptSession('session-1', promptParts)).rejects.toThrow()

    expect(server.promptPostCount).toBe(0)
    expect(server.requestOrder).not.toContain('event')
    expect(server.requestOrder).not.toContain('prompt')
  })

  it('settles caller cancellation while waiting for an empty-log live watermark', async () => {
    const server = createLiveOnlyServer({ stallAfterCursorLog: true })
    const controller = new AbortController()
    const prompt = server.adapter.promptSession('session-1', promptParts, controller.signal)

    await settleWithin(server.stalledLogOpened, 1000)
    controller.abort(new DOMException('caller cancelled', 'AbortError'))

    await expect(settleWithin(prompt, 500)).rejects.toMatchObject({ name: 'AbortError' })
    expect(server.promptPostCount).toBe(0)
    expect(server.logSignalAborted).toBe(true)
    expect(server.eventSignalAborted).toBe(true)
  })
})
