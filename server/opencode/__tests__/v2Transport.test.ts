import { describe, expect, it, vi } from 'vitest'
import { OpenCodePromptReceiptUnavailableError, type OpenCodePromptRequest } from '../transport'
import { V2OpenCodeHttpError, V2OpenCodeTransport } from '../v2Transport'
import { invalidateOpenCodeConnection } from '../connection'

interface CapturedRequest {
  url: URL
  method: string
  body?: unknown
  accept?: string
  redirect?: RequestRedirect
}

type FetchHandler = (request: CapturedRequest, init: RequestInit) => Response | Promise<Response>

function createTransport(handler: FetchHandler, baseUrl = 'http://127.0.0.1:4096') {
  const requests: CapturedRequest[] = []
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
    const headers = new Headers(init.headers)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    const request = {
      url,
      method: init.method ?? 'GET',
      body,
      accept: headers.get('accept') ?? undefined,
      redirect: init.redirect,
    }
    requests.push(request)
    return handler(request, init)
  }
  return { transport: new V2OpenCodeTransport(baseUrl, { fetch: fetcher }), requests }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status })
}

function eventStream(events: unknown[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

function hangingEventStream(signal?: AbortSignal | null): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true })
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

function promptRequest(overrides: Partial<OpenCodePromptRequest> = {}): OpenCodePromptRequest {
  return {
    sessionId: 'session/1',
    directory: '/workspace',
    parts: [
      { type: 'system', content: 'Be precise.' },
      { type: 'text', content: 'Review the file.' },
      { type: 'file', content: '', url: 'file:///workspace/input.ts', filename: 'input.ts' },
    ],
    model: { providerID: 'provider-1', modelID: 'model-1' },
    agent: 'build',
    variant: 'high',
    noReply: true,
    ...overrides,
  }
}

describe('OpenCode v2 fetch transport', () => {
  it('uses the v2 routes and returns prompt acceptance with its inbox receipt', async () => {
    const { transport, requests } = createTransport(request => {
      if (request.url.pathname.endsWith('/model') || request.url.pathname.endsWith('/agent')) return emptyResponse()
      if (request.url.pathname.endsWith('/instructions/entries/looptroop')) return emptyResponse()
      if (request.url.pathname.endsWith('/prompt')) return jsonResponse({ data: { id: 'inbox-1', sessionID: 'session/1' } })
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    const dispatched = await transport.dispatchPrompt(promptRequest())

    expect(dispatched).toEqual({ kind: 'accepted', receipt: { inboxID: 'inbox-1' } })
    expect(requests.map(request => `${request.method} ${request.url.pathname}`)).toEqual([
      'POST /api/session/session%2F1/model',
      'POST /api/session/session%2F1/agent',
      'PUT /api/experimental/session/session%2F1/instructions/entries/looptroop',
      'POST /api/session/session%2F1/prompt',
    ])
    expect(requests[0]?.body).toEqual({ model: { id: 'model-1', providerID: 'provider-1', variant: 'high' } })
    expect(requests[2]?.body).toEqual({ value: 'Be precise.' })
    expect(requests[3]?.body).toEqual({
      text: 'Review the file.',
      files: [{ uri: 'file:///workspace/input.ts', name: 'input.ts' }],
      resume: false,
    })
  })

  it('classifies an aborted v2 prompt POST as receipt-unavailable', async () => {
    const controller = new AbortController()
    let markPromptStarted: (() => void) | undefined
    const promptStarted = new Promise<void>(resolve => { markPromptStarted = resolve })
    const { transport } = createTransport((request, init) => {
      if (request.url.pathname.endsWith('/model') || request.url.pathname.endsWith('/agent')) return emptyResponse()
      if (request.url.pathname.endsWith('/instructions/entries/looptroop')) return emptyResponse()
      if (request.url.pathname.endsWith('/prompt')) {
        markPromptStarted?.()
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    const dispatch = transport.dispatchPrompt(promptRequest(), controller.signal)
    await promptStarted
    controller.abort(new DOMException('caller cancelled', 'AbortError'))

    const error = await dispatch.catch(value => value)
    expect(error).toMatchObject({
      name: 'OpenCodePromptReceiptUnavailableError',
      cause: { name: 'AbortError', message: 'caller cancelled' },
    })
    expect(error).toBeInstanceOf(OpenCodePromptReceiptUnavailableError)
  })

  it('preserves explicit v2 prompt rejections instead of classifying them as receipt-unknown', async () => {
    const { transport } = createTransport(request => {
      if (request.url.pathname.endsWith('/model') || request.url.pathname.endsWith('/agent')) return emptyResponse()
      if (request.url.pathname.endsWith('/instructions/entries/looptroop')) return emptyResponse()
      if (request.url.pathname.endsWith('/prompt')) return jsonResponse({ error: { message: 'payment required' } }, 402)
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    await expect(transport.dispatchPrompt(promptRequest())).rejects.toMatchObject({
      name: 'V2OpenCodeHttpError',
      status: 402,
    })
  })

  it('classifies a prompt response without an inbox id as receipt-unavailable', async () => {
    const { transport } = createTransport(request => {
      if (request.url.pathname.endsWith('/model') || request.url.pathname.endsWith('/agent')) return emptyResponse()
      if (request.url.pathname.endsWith('/instructions/entries/looptroop')) return emptyResponse()
      if (request.url.pathname.endsWith('/prompt')) return jsonResponse({ data: { sessionID: 'session/1' } })
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    await expect(transport.dispatchPrompt(promptRequest())).rejects.toBeInstanceOf(OpenCodePromptReceiptUnavailableError)
  })

  it('removes prior instructions when the next prompt has none and rejects unsupported tool overrides', async () => {
    const { transport, requests } = createTransport(request => {
      if (request.url.pathname.endsWith('/instructions/entries/looptroop')) return emptyResponse()
      if (request.url.pathname.endsWith('/prompt')) return jsonResponse({ data: { id: 'inbox-2' } })
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })
    await transport.dispatchPrompt(promptRequest({ parts: [{ type: 'text', content: 'Next turn' }], model: undefined, agent: undefined, variant: undefined, noReply: false }))
    expect(requests[0]).toMatchObject({ method: 'DELETE', url: expect.objectContaining({ pathname: '/api/experimental/session/session%2F1/instructions/entries/looptroop' }) })
    expect(requests[1]?.body).toEqual({ text: 'Next turn', resume: true })

    const before = requests.length
    await expect(transport.dispatchPrompt(promptRequest({ tools: { bash: false } })))
      .rejects.toThrow('does not support per-prompt tool overrides')
    expect(requests).toHaveLength(before)
  })

  it('waits for the durable log watermark and returns only events after the requested cursor', async () => {
    const { transport, requests } = createTransport(request => {
      if (request.url.pathname === '/api/event') return eventStream([{ type: 'server.connected' }])
      if (request.url.pathname.endsWith('/log')) {
        expect(request.url.searchParams.get('follow')).toBe('false')
        expect(request.url.searchParams.get('after')).toBe('4')
        return eventStream([
          {
            type: 'session.inbox.delivered',
            data: { sessionID: 'session-1', inboxID: 'inbox-1' },
            durable: { aggregateID: 'session-1', seq: 5 },
          },
          { type: 'log.synced', aggregateID: 'session-1', seq: 5 },
        ])
      }
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    const subscription = await transport.subscribeToEvents('session-1', '/workspace', undefined, undefined, 4)
    expect(subscription.cursor).toBe(5)
    const iterator = subscription.events[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { cursor: 5, event: { type: 'inbox_delivered', sessionId: 'session-1', inboxID: 'inbox-1' } },
    })
    await iterator.return?.(undefined)
    expect(requests.map(request => request.url.pathname)).toEqual([
      '/api/event',
      '/api/experimental/session/session-1/log',
    ])
    expect(requests[0]?.accept).toBe('text/event-stream')
  })

  it('does not replay historical terminal events to subscribers without a cursor', async () => {
    const terminal = (seq: number) => ({
      type: 'session.execution.succeeded',
      data: { sessionID: 'session-1' },
      durable: { aggregateID: 'session-1', seq },
    })
    const { transport } = createTransport(request => {
      if (request.url.pathname === '/api/event') return eventStream([
        { type: 'server.connected' },
        terminal(5),
        terminal(6),
      ])
      if (request.url.pathname.endsWith('/log')) return eventStream([terminal(5), { type: 'log.synced', aggregateID: 'session-1', seq: 5 }])
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    const subscription = await transport.subscribeToEvents('session-1', '/workspace')
    const iterator = subscription.events[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { cursor: 6, event: { type: 'execution_terminal', outcome: 'succeeded' } },
    })
    await iterator.return?.(undefined)
  })

  it('reports complete coverage for unchanged numeric cursors and contiguous history', async () => {
    let zeroCursorReads = 0
    const { transport } = createTransport(request => {
      if (!request.url.pathname.endsWith('/log')) throw new Error(`Unexpected ${request.method} ${request.url}`)
      const after = request.url.searchParams.get('after')
      if (after === '0' && zeroCursorReads++ === 1) {
        return eventStream([
          {
            type: 'session.inbox.enqueued',
            data: { sessionID: 'session-1', inboxID: 'inbox-1' },
            durable: { aggregateID: 'session-1', seq: 1 },
          },
          { type: 'log.synced', aggregateID: 'session-1', seq: 1 },
        ])
      }
      const cursor = after === null ? 0 : Number(after)
      return eventStream([{ type: 'log.synced', aggregateID: 'session-1', seq: cursor }])
    })

    await expect(transport.readSessionLog('session-1', 0)).resolves.toMatchObject({
      events: [],
      cursor: 0,
      coverageComplete: true,
    })
    await expect(transport.readSessionLog('session-1', 0)).resolves.toMatchObject({
      events: [{ cursor: 1, event: { type: 'inbox_enqueued', inboxID: 'inbox-1' } }],
      cursor: 1,
      coverageComplete: true,
    })
    await expect(transport.readSessionLog('session-1', 4)).resolves.toEqual({
      events: [],
      cursor: 4,
      coverageComplete: true,
    })
  })

  it('does not treat a positive watermark as proof that an unpersisted history was replayed', async () => {
    const { transport } = createTransport(request => {
      if (!request.url.pathname.endsWith('/log')) throw new Error(`Unexpected ${request.method} ${request.url}`)
      return eventStream([{ type: 'log.synced', aggregateID: 'session-1', seq: 73 }])
    })

    await expect(transport.readSessionLog('session-1')).resolves.toMatchObject({
      events: [],
      cursor: 73,
      coverageComplete: false,
    })
  })

  it('detects both a missing history prefix and a missing watermark tail', async () => {
    let reads = 0
    const { transport } = createTransport(request => {
      if (!request.url.pathname.endsWith('/log')) throw new Error(`Unexpected ${request.method} ${request.url}`)
      reads++
      if (reads === 1) {
        return eventStream([
          {
            type: 'session.execution.succeeded',
            data: { sessionID: 'session-1' },
            durable: { aggregateID: 'session-1', seq: 1 },
          },
          { type: 'log.synced', aggregateID: 'session-1', seq: 1 },
        ])
      }
      return eventStream([
        {
          type: 'session.execution.succeeded',
          data: { sessionID: 'session-1' },
          durable: { aggregateID: 'session-1', seq: 0 },
        },
        { type: 'log.synced', aggregateID: 'session-1', seq: 1 },
      ])
    })

    await expect(transport.readSessionLog('session-1')).resolves.toMatchObject({ cursor: 1, coverageComplete: false })
    await expect(transport.readSessionLog('session-1')).resolves.toMatchObject({ cursor: 1, coverageComplete: false })
  })

  it('preserves known durable no-op cursors in logs and live events', async () => {
    const { transport } = createTransport(request => {
      if (request.url.pathname === '/api/event') {
        return eventStream([
          { type: 'server.connected' },
          { type: 'session.instructions.updated', data: { sessionID: 'session-1', delta: {} }, durable: { aggregateID: 'session-1', seq: 7 } },
          { type: 'session.execution.succeeded', data: { sessionID: 'session-1' }, durable: { aggregateID: 'session-1', seq: 8 } },
        ])
      }
      if (request.url.pathname.endsWith('/log')) {
        return eventStream([
          { type: 'session.instructions.updated', data: { sessionID: 'session-1', delta: {} }, durable: { aggregateID: 'session-1', seq: 5 } },
          { type: 'session.inbox.enqueued', data: { sessionID: 'session-1', inboxID: 'inbox-1' }, durable: { aggregateID: 'session-1', seq: 6 } },
          { type: 'log.synced', aggregateID: 'session-1', seq: 6 },
        ])
      }
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    await expect(transport.readSessionLog('session-1', 4)).resolves.toMatchObject({
      cursor: 6,
      coverageComplete: true,
      events: [
        { cursor: 5 },
        { cursor: 6, event: { type: 'inbox_enqueued' } },
      ],
    })

    const subscription = await transport.subscribeToEvents('session-1', '/workspace', undefined, undefined, 4)
    const iterator = subscription.events[Symbol.asyncIterator]()
    const envelopes = [await iterator.next(), await iterator.next(), await iterator.next(), await iterator.next()]
    await iterator.return?.(undefined)

    expect(envelopes.map(next => next.value)).toEqual([
      { cursor: 5 },
      { cursor: 6, event: { type: 'inbox_enqueued', sessionId: 'session-1', inboxID: 'inbox-1' } },
      { cursor: 7 },
      { cursor: 8, event: { type: 'execution_terminal', sessionId: 'session-1', outcome: 'succeeded' } },
    ])
  })

  it('maps cancellation and delivery changes while covering pinned durable no-op events', async () => {
    const { transport } = createTransport(request => {
      if (!request.url.pathname.endsWith('/log')) throw new Error(`Unexpected ${request.method} ${request.url}`)
      return eventStream([
        { type: 'session.inbox.cancelled', data: { sessionID: 'session-1', inboxID: 'inbox-1' }, durable: { aggregateID: 'session-1', seq: 5 } },
        { type: 'session.inbox.delivery.changed', data: { sessionID: 'session-1', inboxID: 'inbox-2', delivery: 'queue' }, durable: { aggregateID: 'session-1', seq: 6 } },
        { type: 'session.moved', data: { sessionID: 'session-1' }, durable: { aggregateID: 'session-1', seq: 7 } },
        { type: 'session.compaction.started', data: { sessionID: 'session-1' }, durable: { aggregateID: 'session-1', seq: 8 } },
        { type: 'session.revert.committed', data: { sessionID: 'session-1' }, durable: { aggregateID: 'session-1', seq: 9 } },
        { type: 'log.synced', aggregateID: 'session-1', seq: 9 },
      ])
    })

    await expect(transport.readSessionLog('session-1', 4)).resolves.toMatchObject({
      cursor: 9,
      coverageComplete: true,
      events: [
        { cursor: 5, event: { type: 'inbox_cancelled', inboxID: 'inbox-1' } },
        { cursor: 6, event: { type: 'inbox_delivery_changed', inboxID: 'inbox-2', delivery: 'queue' } },
        { cursor: 7 },
        { cursor: 8 },
        { cursor: 9 },
      ],
    })
  })

  it('does not certify a numeric cursor when the log omits its watermark', async () => {
    const { transport } = createTransport(request => {
      if (!request.url.pathname.endsWith('/log')) throw new Error(`Unexpected ${request.method} ${request.url}`)
      return eventStream([{ type: 'log.synced', aggregateID: 'session-1' }])
    })

    await expect(transport.readSessionLog('session-1', 4)).resolves.toEqual({
      events: [],
      cursor: 4,
      coverageComplete: false,
    })
  })

  it('closes an opened event stream when the consumer returns before its first next', async () => {
    const eventSignals: AbortSignal[] = []
    const { transport } = createTransport((request, init) => {
      if (request.url.pathname === '/api/event') {
        if (init.signal) eventSignals.push(init.signal)
        return eventStream([{ type: 'server.connected' }])
      }
      if (request.url.pathname.endsWith('/log')) {
        return eventStream([{ type: 'log.synced', aggregateID: 'session-1', seq: 0 }])
      }
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    const subscription = await transport.subscribeToEvents('session-1', '/workspace')
    const iterator = subscription.events[Symbol.asyncIterator]()
    await iterator.return?.(undefined)

    expect(eventSignals).toHaveLength(1)
    expect(eventSignals[0]?.aborted).toBe(true)
  })

  it('replays a disconnected accepted turn from its durable cursor without posting the prompt again', async () => {
    let initialLogRead = true
    const eventSignals: AbortSignal[] = []
    const { transport, requests } = createTransport((request, init) => {
      if (request.url.pathname === '/api/event') {
        if (init.signal) eventSignals.push(init.signal)
        return eventStream([{ type: 'server.connected' }])
      }
      if (request.url.pathname.endsWith('/log')) {
        if (initialLogRead) {
          initialLogRead = false
          return eventStream([
            ...Array.from({ length: 5 }, (_, seq) => ({
              type: 'session.instructions.updated',
              data: { sessionID: 'session-1', delta: {} },
              durable: { aggregateID: 'session-1', seq },
            })),
            { type: 'log.synced', aggregateID: 'session-1', seq: 4 },
          ])
        }
        expect(request.url.searchParams.get('after')).toBe('4')
        return eventStream([
          { type: 'session.inbox.enqueued', data: { sessionID: 'session-1', inboxID: 'inbox-1', item: {} }, durable: { aggregateID: 'session-1', seq: 5 } },
          { type: 'session.execution.started', data: { sessionID: 'session-1' }, durable: { aggregateID: 'session-1', seq: 6 } },
          { type: 'session.inbox.delivered', data: { sessionID: 'session-1', inboxID: 'inbox-1' }, durable: { aggregateID: 'session-1', seq: 7 } },
          { type: 'session.execution.succeeded', data: { sessionID: 'session-1' }, durable: { aggregateID: 'session-1', seq: 8 } },
          { type: 'log.synced', aggregateID: 'session-1', seq: 8 },
        ])
      }
      if (request.url.pathname === '/api/session/session-1/permission') return jsonResponse({ data: [] })
      if (request.url.pathname.endsWith('/instructions/entries/looptroop')) return emptyResponse()
      if (request.url.pathname.endsWith('/prompt')) return jsonResponse({ data: { id: 'inbox-1' } })
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    const subscription = await transport.subscribeToEvents('session-1', '/workspace')
    const dispatch = await transport.dispatchPrompt({
      sessionId: 'session-1',
      directory: '/workspace',
      parts: [{ type: 'text', content: 'Run once' }],
    })
    expect(dispatch).toEqual({ kind: 'accepted', receipt: { inboxID: 'inbox-1' } })
    const iterator = subscription.events[Symbol.asyncIterator]()
    const received: string[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      const event = next.value.event
      if (!event) continue
      received.push(event.type)
      if (event.type === 'execution_terminal') break
    }
    await iterator.return?.(undefined)

    expect(received).toEqual(['inbox_enqueued', 'execution_started', 'inbox_delivered', 'execution_terminal'])
    expect(requests.filter(request => request.url.pathname.endsWith('/prompt'))).toHaveLength(1)
    expect(requests.some(request => request.url.pathname.endsWith('/log') && request.url.searchParams.get('after') === '4')).toBe(true)
    expect(eventSignals).toHaveLength(2)
    expect(eventSignals.every(eventSignal => eventSignal.aborted)).toBe(true)
    const reconnectEventIndex = requests.findIndex((request, index) => index > 0 && request.url.pathname === '/api/event')
    const replayLogIndex = requests.findIndex(request => request.url.pathname.endsWith('/log') && request.url.searchParams.get('after') === '4')
    expect(reconnectEventIndex).toBeLessThan(replayLogIndex)
  })

  it('fetches lost ephemeral permission asks before final replay and yields them after covered competitors', async () => {
    let initialLogRead = true
    let startPermissionList!: () => void
    const permissionListStarted = new Promise<void>(resolve => { startPermissionList = resolve })
    let finishPermissionList!: () => void
    const permissionListGate = new Promise<void>(resolve => { finishPermissionList = resolve })
    let competitorEnqueuedDuringPermissionList = false
    const { transport, requests } = createTransport(async request => {
      if (request.url.pathname === '/api/event') return eventStream([{ type: 'server.connected' }])
      if (request.url.pathname === '/api/session/session-1/permission') {
        startPermissionList()
        await permissionListGate
        return jsonResponse({ data: [{
          id: 'per-1',
          sessionID: 'session-1',
          action: 'read',
          resources: ['/workspace/file.ts'],
          message: 'Read file.ts',
        }] })
      }
      if (request.url.pathname.endsWith('/log')) {
        if (initialLogRead) {
          initialLogRead = false
          return eventStream([
            ...Array.from({ length: 5 }, (_, seq) => ({
              type: 'session.instructions.updated',
              data: { sessionID: 'session-1', delta: {} },
              durable: { aggregateID: 'session-1', seq },
            })),
            { type: 'log.synced', aggregateID: 'session-1', seq: 4 },
          ])
        }
        expect(request.url.searchParams.get('after')).toBe('4')
        expect(competitorEnqueuedDuringPermissionList).toBe(true)
        return eventStream([
          { type: 'session.inbox.enqueued', data: { sessionID: 'session-1', inboxID: 'inbox-external' }, durable: { aggregateID: 'session-1', seq: 5 } },
          { type: 'session.execution.started', data: { sessionID: 'session-1' }, durable: { aggregateID: 'session-1', seq: 6 } },
          { type: 'log.synced', aggregateID: 'session-1', seq: 6 },
        ])
      }
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    const subscription = await transport.subscribeToEvents('session-1', '/workspace')
    const iterator = subscription.events[Symbol.asyncIterator]()
    const first = iterator.next()
    await permissionListStarted
    competitorEnqueuedDuringPermissionList = true
    finishPermissionList()
    const received = [await first, await iterator.next(), await iterator.next()]
    await iterator.return?.(undefined)

    expect(received.map(next => next.value)).toEqual([
      { cursor: 5, event: { type: 'inbox_enqueued', sessionId: 'session-1', inboxID: 'inbox-external' } },
      { cursor: 6, event: { type: 'execution_started', sessionId: 'session-1' } },
      { event: { type: 'permission', sessionId: 'session-1', action: 'asked', permissionId: 'per-1', permission: 'read', patterns: ['/workspace/file.ts'], details: { message: 'Read file.ts' } } },
    ])
    const replayLogIndex = requests.findIndex(request => request.url.pathname.endsWith('/log') && request.url.searchParams.get('after') === '4')
    const permissionListIndex = requests.findIndex(request => request.url.pathname === '/api/session/session-1/permission')
    expect(permissionListIndex).toBeLessThan(replayLogIndex)
  })

  it('keeps reconnect history gaps sticky on later live events', async () => {
    let eventConnections = 0
    const { transport, requests } = createTransport(request => {
      if (request.url.pathname === '/api/event') {
        eventConnections += 1
        return eventConnections < 3
          ? eventStream([{ type: 'server.connected' }])
          : eventStream([
              { type: 'server.connected' },
              {
                type: 'session.execution.succeeded',
                data: { sessionID: 'session-1' },
                durable: { aggregateID: 'session-1', seq: 7 },
              },
            ])
      }
      if (request.url.pathname.endsWith('/log')) {
        const after = request.url.searchParams.get('after')
        if (after === '4') return eventStream([{ type: 'log.synced', aggregateID: 'session-1', seq: 6 }])
        return eventStream([
          ...Array.from({ length: 5 }, (_, seq) => ({
            type: 'session.instructions.updated',
            data: { sessionID: 'session-1', delta: {} },
            durable: { aggregateID: 'session-1', seq },
          })),
          { type: 'log.synced', aggregateID: 'session-1', seq: after === '6' ? 6 : 4 },
        ])
      }
      if (request.url.pathname === '/api/session/session-1/permission') {
        return jsonResponse({ data: [{
          id: 'per-1',
          sessionID: 'session-1',
          action: 'read',
          resources: ['/workspace/file.ts'],
        }] })
      }
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    const subscription = await transport.subscribeToEvents('session-1', '/workspace')
    const iterator = subscription.events[Symbol.asyncIterator]()
    const next = await iterator.next()

    expect(next).toMatchObject({
      done: false,
      value: {
        cursor: 7,
        coverageGap: true,
        event: { type: 'execution_terminal', outcome: 'succeeded' },
      },
    })
    await iterator.return?.(undefined)
    expect(requests.some(request => request.url.pathname === '/api/session/session-1/permission')).toBe(true)
  })

  it('marks session history incomplete when a durable event cannot be mapped', async () => {
    const { transport } = createTransport(request => {
      if (request.url.pathname.endsWith('/log')) {
        return eventStream([
          {
            type: 'session.inbox.enqueued',
            data: { sessionID: 'session-1', inboxID: 'inbox-1' },
            durable: { aggregateID: 'session-1', seq: 5 },
          },
          {
            type: 'session.instructions.updated',
            data: { sessionID: 'session-1', delta: {} },
            durable: { aggregateID: 'session-1', seq: 6 },
          },
          {
            type: 'session.future.event',
            data: { sessionID: 'session-1' },
            durable: { aggregateID: 'session-1', seq: 7 },
          },
          {
            type: 'session.execution.succeeded',
            data: { sessionID: 'session-1' },
            durable: { aggregateID: 'session-1', seq: 8 },
          },
          { type: 'log.synced', aggregateID: 'session-1', seq: 8 },
        ])
      }
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    await expect(transport.readSessionLog('session-1', 4)).resolves.toMatchObject({
      cursor: 8,
      coverageComplete: false,
      events: [
        { cursor: 5, event: { type: 'inbox_enqueued' } },
        { cursor: 6 },
        { cursor: 8, event: { type: 'execution_terminal' } },
      ],
    })
  })

  it('marks every initial backlog event when the initial log scan is incomplete', async () => {
    const { transport } = createTransport(request => {
      if (request.url.pathname === '/api/event') return eventStream([{ type: 'server.connected' }])
      if (request.url.pathname.endsWith('/log')) {
        return eventStream([
          {
            type: 'session.inbox.enqueued',
            data: { sessionID: 'session-1', inboxID: 'inbox-1' },
            durable: { aggregateID: 'session-1', seq: 5 },
          },
          {
            type: 'session.future.event',
            data: { sessionID: 'session-1' },
            durable: { aggregateID: 'session-1', seq: 7 },
          },
          {
            type: 'session.execution.succeeded',
            data: { sessionID: 'session-1' },
            durable: { aggregateID: 'session-1', seq: 8 },
          },
          { type: 'log.synced', aggregateID: 'session-1', seq: 8 },
        ])
      }
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    const subscription = await transport.subscribeToEvents('session-1', '/workspace', undefined, undefined, 4)
    expect(subscription.coverageComplete).toBe(false)
    const iterator = subscription.events[Symbol.asyncIterator]()
    const events = [await iterator.next(), await iterator.next()]
    await iterator.return?.(undefined)

    expect(events.map(next => next.value)).toEqual([
      { cursor: 5, coverageGap: true, event: { type: 'inbox_enqueued', sessionId: 'session-1', inboxID: 'inbox-1' } },
      { cursor: 8, coverageGap: true, event: { type: 'execution_terminal', sessionId: 'session-1', outcome: 'succeeded' } },
    ])
  })

  it.each([
    {
      cause: 'a missing durable sequence',
      logEvents: [
        { type: 'session.inbox.enqueued', data: { sessionID: 'session-1', inboxID: 'inbox-own' }, durable: { aggregateID: 'session-1', seq: 5 } },
        { type: 'session.inbox.delivered', data: { sessionID: 'session-1', inboxID: 'inbox-own' }, durable: { aggregateID: 'session-1', seq: 7 } },
        { type: 'session.execution.succeeded', data: { sessionID: 'session-1' }, durable: { aggregateID: 'session-1', seq: 8 } },
      ],
    },
    {
      cause: 'an unknown durable event',
      logEvents: [
        { type: 'session.inbox.enqueued', data: { sessionID: 'session-1', inboxID: 'inbox-own' }, durable: { aggregateID: 'session-1', seq: 5 } },
        { type: 'session.future.event', data: { sessionID: 'session-1' }, durable: { aggregateID: 'session-1', seq: 6 } },
        { type: 'session.inbox.delivered', data: { sessionID: 'session-1', inboxID: 'inbox-own' }, durable: { aggregateID: 'session-1', seq: 7 } },
        { type: 'session.execution.succeeded', data: { sessionID: 'session-1' }, durable: { aggregateID: 'session-1', seq: 8 } },
      ],
    },
  ])('never certifies delivery and success after $cause in an after-cursor scan', async ({ logEvents }) => {
    const { transport } = createTransport(request => {
      if (request.url.pathname === '/api/event') return eventStream([{ type: 'server.connected' }])
      if (request.url.pathname.endsWith('/log')) {
        return eventStream([
          ...logEvents,
          { type: 'log.synced', aggregateID: 'session-1', seq: 8 },
        ])
      }
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    const subscription = await transport.subscribeToEvents('session-1', '/workspace', undefined, undefined, 4)
    expect(subscription.coverageComplete).toBe(false)
    const iterator = subscription.events[Symbol.asyncIterator]()
    const events = [await iterator.next(), await iterator.next(), await iterator.next()]
    await iterator.return?.(undefined)

    expect(events.map(next => next.value?.coverageGap)).toEqual([true, true, true])
    expect(events.map(next => next.value?.event?.type)).toEqual(['inbox_enqueued', 'inbox_delivered', 'execution_terminal'])
  })

  it('maps session, message pages, and health responses from v2 envelopes', async () => {
    const { transport, requests } = createTransport(request => {
      if (request.url.pathname === '/api/session' && request.method === 'POST') {
        return jsonResponse({ data: { id: 'session-1', slug: 'work', title: 'Review', location: { directory: '/workspace' }, time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 } } })
      }
      if (request.url.pathname === '/api/session' && request.method === 'GET') {
        const id = request.url.searchParams.has('cursor') ? 'session-2' : 'session-1'
        return jsonResponse({ data: [{ id, location: { directory: '/workspace' } }], cursor: id === 'session-1' ? { next: 'sessions-2' } : {} })
      }
      if (request.url.pathname === '/api/session/session-1/message') {
        if (request.url.searchParams.has('cursor')) {
          return jsonResponse({ data: [{ id: 'user-1', type: 'user', text: 'Review' }], cursor: {} })
        }
        return jsonResponse({ data: [{ id: 'assistant-1', type: 'assistant', sessionID: 'session-1', content: [{ type: 'text', text: 'Done.' }], finish: 'stop' }], cursor: { next: 'page-2' } })
      }
      if (request.url.pathname === '/api/info') return jsonResponse({ version: '2.0.15', pid: 1, urls: [], paths: { tmp: '/tmp' } })
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      const locationResponse = (data: unknown) => jsonResponse({ location: { directory: '/workspace' }, data })
      if (path === '/api/provider') return locationResponse([
        { id: 'anthropic', name: 'Anthropic' },
        { id: 'google', name: 'Google' },
        { id: 'openai', name: 'OpenAI' },
      ])
      if (path === '/api/model') return locationResponse([
        ['anthropic', 'claude-sonnet-4', 'Claude Sonnet 4'],
        ['google', 'gemini-2.5-pro', 'Gemini 2.5 Pro'],
        ['openai', 'codex-mini-latest', 'Codex Mini Latest'],
        ['openai', 'gpt-5.3-codex', 'GPT-5.3 Codex'],
      ].map(([providerID, id, name]) => ({
        providerID,
        id,
        modelID: id,
        name,
        enabled: true,
        capabilities: { input: ['text'], output: ['text'] },
        cost: [],
        limit: { context: 1_000_000 },
        variants: [],
      })))
      if (path === '/api/model/default') return locationResponse(null)
      throw new Error(`Unexpected catalog request ${path}`)
    })

    const session = await transport.createSession('/workspace')
    const sessions = await transport.listSessions()
    const messages = await transport.getSessionMessages('session-1')
    let health
    try {
      health = await transport.checkHealth()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(session).toMatchObject({ id: 'session-1', projectPath: '/workspace', directory: '/workspace', title: 'Review' })
    expect(sessions.map(value => value.id)).toEqual(['session-1', 'session-2'])
    expect(messages.map(message => [message.id, message.role])).toEqual([['user-1', 'user'], ['assistant-1', 'assistant']])
    expect(messages[1]?.parts).toContainEqual(expect.objectContaining({ type: 'step-finish', reason: 'stop' }))
    expect(health).toEqual({
      available: true,
      protocol: 'v2',
      version: '2.0.15',
      models: [
        'anthropic/claude-sonnet-4',
        'google/gemini-2.5-pro',
        'openai/codex-mini-latest',
        'openai/gpt-5.3-codex',
      ],
    })
    expect(requests[0]?.body).toEqual({ location: { directory: '/workspace' } })
    expect(requests[1]?.url.searchParams.get('order')).toBe('desc')
    expect(requests[2]?.url.searchParams.get('cursor')).toBe('sessions-2')
    expect(requests[2]?.url.searchParams.has('order')).toBe(false)
    expect(requests[3]?.url.searchParams.get('order')).toBe('desc')
    expect(requests[4]?.url.searchParams.get('cursor')).toBe('page-2')
    expect(requests[4]?.url.searchParams.has('order')).toBe(false)
  })

  it('uses manual redirects and classifies forbidden health responses as authentication failures', async () => {
    const redirected = createTransport(() => new Response(null, {
      status: 302,
      headers: { location: 'https://other.example/session' },
    }))
    await expect(redirected.transport.getSession('session-1')).rejects.toMatchObject({ status: 302 })
    expect(redirected.requests).toHaveLength(1)
    expect(redirected.requests[0]?.redirect).toBe('manual')

    const forbidden = createTransport(() => jsonResponse({ message: 'forbidden' }, 403))
    await expect(forbidden.transport.checkHealth()).resolves.toMatchObject({
      available: false,
      failureKind: 'authentication',
    })
    expect(forbidden.requests[0]?.redirect).toBe('manual')

    const eventRedirect = createTransport(() => new Response(null, {
      status: 302,
      headers: { location: 'https://other.example/events' },
    }))
    await expect(eventRedirect.transport.subscribeToEvents('session-1', '/workspace')).rejects.toMatchObject({ status: 302 })
    expect(eventRedirect.requests).toHaveLength(1)
    expect(eventRedirect.requests[0]?.redirect).toBe('manual')
  })

  it('classifies a forbidden provider catalog as an authentication health failure', async () => {
    vi.stubEnv('LOOPTROOP_OPENCODE_MODE', 'live')
    vi.stubEnv('LOOPTROOP_OPENCODE_BASE_URL', 'http://127.0.0.1:4096')
    invalidateOpenCodeConnection()
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
      if (url.pathname === '/api/info') return jsonResponse({ version: '2.0.16', pid: 1 })
      return jsonResponse({ message: 'forbidden' }, 403)
    })
    try {
      const { transport } = createTransport(request => request.url.pathname === '/api/info'
        ? jsonResponse({ version: '2.0.16', pid: 1 })
        : jsonResponse({ message: 'forbidden' }, 403))

      await expect(transport.checkHealth()).resolves.toMatchObject({
        available: false,
        protocol: 'v2',
        version: '2.0.16',
        failureKind: 'authentication',
      })
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
      invalidateOpenCodeConnection()
    }
  })

  it('discovers health models using its own server URL and authentication headers', async () => {
    const catalogRequests: { url: URL; authorization: string | null }[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
      catalogRequests.push({ url, authorization: new Headers(init?.headers).get('authorization') })
      if (url.pathname.endsWith('/api/provider')) return jsonResponse({ location: '/providers', data: [] })
      if (url.pathname.endsWith('/api/model')) return jsonResponse({ location: '/models', data: [] })
      if (url.pathname.endsWith('/api/model/default')) return jsonResponse({ location: '/default', data: null })
      throw new Error(`Unexpected catalog request ${url}`)
    })
    try {
      const transport = new V2OpenCodeTransport('http://private-opencode.example:5111', {
        headers: { Authorization: 'Bearer transport-secret' },
        fetch: async input => {
          const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
          if (url.pathname === '/api/info') return jsonResponse({ version: '2.0.16' })
          throw new Error(`Unexpected transport request ${url}`)
        },
      })

      await expect(transport.checkHealth()).resolves.toMatchObject({ available: true, protocol: 'v2', version: '2.0.16', models: [] })
      expect(catalogRequests.map(request => request.url.origin)).toEqual([
        'http://private-opencode.example:5111',
        'http://private-opencode.example:5111',
        'http://private-opencode.example:5111',
      ])
      expect(catalogRequests.map(request => request.authorization)).toEqual(Array(3).fill('Bearer transport-secret'))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('updates v2 permission rules and confirms an interrupt only after the server is idle', async () => {
    const { transport, requests } = createTransport(request => {
      if (request.url.pathname === '/api/session/session-1') return emptyResponse()
      if (request.url.pathname.endsWith('/interrupt')) return jsonResponse({ interrupted: true })
      if (request.url.pathname.endsWith('/wait')) return emptyResponse()
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    await transport.updateSession('session-1', '/workspace', {
      permission: [{ permission: 'bash', pattern: 'git status', action: 'deny' }],
    })
    await expect(transport.interruptSession('session-1', '/workspace')).resolves.toBe(true)

    expect(requests.map(request => `${request.method} ${request.url.pathname}`)).toEqual([
      'PATCH /api/session/session-1',
      'POST /api/session/session-1/interrupt',
      'POST /api/experimental/session/session-1/wait',
    ])
    expect(requests[0]?.body).toEqual({ permissions: [{ action: 'shell', resource: 'git status', effect: 'deny' }] })
    expect(requests[1]?.url.searchParams.get('resume')).toBe('false')
  })

  it('keeps form and permission replies scoped to their session', async () => {
    const form = {
      id: 'form-1',
      sessionID: 'session-1',
      title: 'Choose a target',
      metadata: { kind: 'question' },
      fields: [{ key: 'q0', type: 'string', title: 'Target', options: [{ label: 'Production', value: 'prod' }] }],
    }
    const { transport, requests } = createTransport(request => {
      if (request.url.pathname === '/api/form') return jsonResponse({ data: [form] })
      if (request.url.pathname.endsWith('/form') && request.method === 'GET') return jsonResponse({ data: [form] })
      if (request.url.pathname.endsWith('/form/form-1') && request.method === 'GET') return jsonResponse({ data: form })
      if (request.url.pathname.endsWith('/form/form-1/reply')) return emptyResponse()
      if (request.url.pathname.endsWith('/permission/permission-1/reply')) return emptyResponse()
      if (request.url.pathname.endsWith('/form/form-1') && request.method === 'DELETE') return emptyResponse()
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    await expect(transport.listPendingQuestions('/project-root', undefined, '/workspace'))
      .resolves.toMatchObject([{ id: 'form-1', sessionID: 'session-1' }])
    await expect(transport.listPendingQuestions(undefined, 'session-1'))
      .resolves.toMatchObject([{ id: 'form-1', sessionID: 'session-1', questions: [{ options: [{ label: 'Production', value: 'prod' }] }] }])
    await transport.replyQuestion('session-1', 'form-1', [['prod']], '/workspace')
    await transport.rejectQuestion('session-1', 'form-1', '/workspace')
    await transport.replyPermission('session-1', 'permission-1', 'always', '/workspace')

    expect(requests.map(request => `${request.method} ${request.url.pathname}`)).toEqual([
      'GET /api/form',
      'GET /api/session/session-1/form',
      'GET /api/session/session-1/form/form-1',
      'POST /api/session/session-1/form/form-1/reply',
      'GET /api/session/session-1/form/form-1',
      'DELETE /api/session/session-1/form/form-1',
      'POST /api/session/session-1/permission/permission-1/reply',
    ])
    expect(requests[0]?.url.searchParams.get('location[directory]')).toBe('/workspace')
    expect(requests[3]?.body).toEqual({ answer: { q0: 'prod' } })
    expect(requests[6]?.body).toEqual({ decision: 'always' })
  })

  it('returns null only for the exact tagged session-not-found response', async () => {
    const { transport } = createTransport(request => {
      if (request.url.pathname.endsWith('/missing')) {
        return jsonResponse({ _tag: 'SessionNotFoundError', sessionID: 'missing', message: 'not found' }, 404)
      }
      return jsonResponse({ _tag: 'ValidationError', message: 'bad request' }, 404)
    })

    await expect(transport.getSession('missing')).resolves.toBeNull()
    await expect(transport.getSession('other')).rejects.toMatchObject({
      name: 'V2OpenCodeHttpError',
      status: 404,
    } satisfies Partial<V2OpenCodeHttpError>)
  })

  it('preserves caller cancellation and never resubmits an accepted prompt', async () => {
    const controller = new AbortController()
    const reason = new DOMException('cancelled by caller', 'AbortError')
    controller.abort(reason)
    const { transport, requests } = createTransport((_request, init) => Promise.reject(init.signal?.reason))
    await expect(transport.getSession('session-1', controller.signal)).rejects.toBe(reason)
    expect(requests).toHaveLength(1)
  })

  it('allows cold session creation longer than the standard request budget', async () => {
    vi.useFakeTimers()
    try {
      let requestSignal: AbortSignal | null | undefined
      const { transport } = createTransport((_request, init) => new Promise<Response>((_resolve, reject) => {
        requestSignal = init.signal
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }))
      const creation = transport.createSession('/workspace')
      const creationResult = expect(creation).rejects.toMatchObject({ name: 'TimeoutError' })

      await vi.advanceTimersByTimeAsync(120_000)
      expect(requestSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      await creationResult
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps connect, first-event, and log-watermark deadlines with caller signals', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const connecting = createTransport((_request, init) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }))
      const open = connecting.transport.subscribeToEvents('session-1', '/workspace', controller.signal)
      const openResult = expect(open).rejects.toMatchObject({ name: 'TimeoutError' })
      await vi.advanceTimersByTimeAsync(5_000)
      await openResult

      const waitingForFirstEvent = createTransport((request, init) => {
        if (request.url.pathname === '/api/event') return hangingEventStream(init.signal)
        throw new Error(`Unexpected ${request.method} ${request.url}`)
      })
      const firstEvent = waitingForFirstEvent.transport.subscribeToEvents('session-1', '/workspace', new AbortController().signal)
      const firstEventResult = expect(firstEvent).rejects.toMatchObject({ name: 'TimeoutError' })
      await vi.advanceTimersByTimeAsync(5_000)
      await firstEventResult

      const waitingForWatermark = createTransport((request, init) => {
        if (request.url.pathname === '/api/event') return eventStream([{ type: 'server.connected' }])
        if (request.url.pathname.endsWith('/log')) return hangingEventStream(init.signal)
        throw new Error(`Unexpected ${request.method} ${request.url}`)
      })
      const logSync = waitingForWatermark.transport.subscribeToEvents('session-1', '/workspace', new AbortController().signal)
      const logSyncResult = expect(logSync).rejects.toMatchObject({ name: 'TimeoutError' })
      await vi.advanceTimersByTimeAsync(30_000)
      await logSyncResult
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors a live caller signal beyond the fallback idle timeout and caller cancellation', async () => {
    vi.useFakeTimers()
    try {
      const caller = new AbortController()
      let requestSignal: AbortSignal | null | undefined
      const { transport } = createTransport((_request, init) => new Promise<Response>((_resolve, reject) => {
        requestSignal = init.signal
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }))
      const idle = transport.waitForIdle('session-1', '/workspace', caller.signal)
      const idleResult = expect(idle).rejects.toMatchObject({ name: 'AbortError' })

      await vi.advanceTimersByTimeAsync(60_001)
      expect(requestSignal).toBe(caller.signal)
      expect(requestSignal?.aborted).toBe(false)
      caller.abort()
      await idleResult
      expect(requestSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps idle waits bounded when no caller signal is supplied', async () => {
    vi.useFakeTimers()
    try {
      let requestSignal: AbortSignal | null | undefined
      const { transport } = createTransport((_request, init) => new Promise<Response>((_resolve, reject) => {
        requestSignal = init.signal
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }))
      const idle = transport.waitForIdle('session-1', '/workspace')
      const idleResult = expect(idle).rejects.toMatchObject({ name: 'TimeoutError' })

      await vi.advanceTimersByTimeAsync(60_000)
      await idleResult
      expect(requestSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
