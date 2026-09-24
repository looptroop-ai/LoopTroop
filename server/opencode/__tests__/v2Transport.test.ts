import { describe, expect, it } from 'vitest'
import type { OpenCodePromptRequest } from '../transport'
import { V2OpenCodeHttpError, V2OpenCodeTransport } from '../v2Transport'

interface CapturedRequest {
  url: URL
  method: string
  body?: unknown
  accept?: string
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
    await expect(transport.readSessionLog('session-1', 4)).resolves.toMatchObject({
      events: [],
      cursor: 4,
      coverageComplete: true,
    })
  })

  it('does not certify a numeric cursor when the log omits its watermark', async () => {
    const { transport } = createTransport(request => {
      if (!request.url.pathname.endsWith('/log')) throw new Error(`Unexpected ${request.method} ${request.url}`)
      return eventStream([{ type: 'log.synced', aggregateID: 'session-1' }])
    })

    await expect(transport.readSessionLog('session-1', 4)).resolves.toMatchObject({
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
          return eventStream([{ type: 'log.synced', aggregateID: 'session-1', seq: 4 }])
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
      received.push(next.value.event.type)
      if (next.value.event.type === 'execution_terminal') break
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

  it('keeps reconnect history gaps sticky on later live events', async () => {
    let eventConnections = 0
    const { transport } = createTransport(request => {
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
        return after === '4'
          ? eventStream([{ type: 'log.synced', aggregateID: 'session-1', seq: 6 }])
          : eventStream([{ type: 'log.synced', aggregateID: 'session-1', seq: after === '6' ? 6 : 4 }])
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
            type: 'session.future.event',
            data: { sessionID: 'session-1' },
            durable: { aggregateID: 'session-1', seq: 6 },
          },
          {
            type: 'session.execution.succeeded',
            data: { sessionID: 'session-1' },
            durable: { aggregateID: 'session-1', seq: 7 },
          },
          { type: 'log.synced', aggregateID: 'session-1', seq: 7 },
        ])
      }
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    await expect(transport.readSessionLog('session-1', 4)).resolves.toMatchObject({
      cursor: 7,
      coverageComplete: false,
      events: [
        { cursor: 5, event: { type: 'inbox_enqueued' } },
        { cursor: 7, event: { type: 'execution_terminal' } },
      ],
    })
  })

  it('maps session, message pages, and health responses from v2 envelopes', async () => {
    const { transport, requests } = createTransport(request => {
      if (request.url.pathname === '/api/session' && request.method === 'POST') {
        return jsonResponse({ data: { id: 'session-1', slug: 'work', title: 'Review', location: { directory: '/workspace' }, time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 } } })
      }
      if (request.url.pathname === '/api/session/session-1/message') {
        if (request.url.searchParams.has('cursor')) {
          return jsonResponse({ data: [{ id: 'assistant-1', type: 'assistant', sessionID: 'session-1', content: [{ type: 'text', text: 'Done.' }], finish: 'stop' }], cursor: {} })
        }
        return jsonResponse({ data: [{ id: 'user-1', type: 'user', text: 'Review' }], cursor: { next: 'page-2' } })
      }
      if (request.url.pathname === '/api/info') return jsonResponse({ version: '2.0.15', pid: 1, urls: [], paths: { tmp: '/tmp' } })
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    const session = await transport.createSession('/workspace')
    const messages = await transport.getSessionMessages('session-1')
    const health = await transport.checkHealth()

    expect(session).toMatchObject({ id: 'session-1', projectPath: '/workspace', directory: '/workspace', title: 'Review' })
    expect(messages.map(message => [message.id, message.role])).toEqual([['user-1', 'user'], ['assistant-1', 'assistant']])
    expect(messages[1]?.parts).toContainEqual(expect.objectContaining({ type: 'step-finish', reason: 'stop' }))
    expect(health).toEqual({ available: true, protocol: 'v2', version: '2.0.15' })
    expect(requests[0]?.body).toEqual({ location: { directory: '/workspace' } })
    expect(requests[1]?.url.searchParams.get('order')).toBe('asc')
    expect(requests[2]?.url.searchParams.get('cursor')).toBe('page-2')
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
      if (request.url.pathname.endsWith('/form') && request.method === 'GET') return jsonResponse({ data: [form] })
      if (request.url.pathname.endsWith('/form/form-1') && request.method === 'GET') return jsonResponse({ data: form })
      if (request.url.pathname.endsWith('/form/form-1/reply')) return emptyResponse()
      if (request.url.pathname.endsWith('/permission/permission-1/reply')) return emptyResponse()
      if (request.url.pathname.endsWith('/form/form-1') && request.method === 'DELETE') return emptyResponse()
      throw new Error(`Unexpected ${request.method} ${request.url}`)
    })

    await expect(transport.listPendingQuestions(undefined, 'session-1'))
      .resolves.toMatchObject([{ id: 'form-1', sessionID: 'session-1', questions: [{ options: [{ label: 'Production', value: 'prod' }] }] }])
    await transport.replyQuestion('session-1', 'form-1', [['prod']], '/workspace')
    await transport.rejectQuestion('session-1', 'form-1', '/workspace')
    await transport.replyPermission('session-1', 'permission-1', 'always', '/workspace')

    expect(requests.map(request => `${request.method} ${request.url.pathname}`)).toEqual([
      'GET /api/session/session-1/form',
      'GET /api/session/session-1/form/form-1',
      'POST /api/session/session-1/form/form-1/reply',
      'GET /api/session/session-1/form/form-1',
      'DELETE /api/session/session-1/form/form-1',
      'POST /api/session/session-1/permission/permission-1/reply',
    ])
    expect(requests[2]?.body).toEqual({ answer: { q0: 'prod' } })
    expect(requests[5]?.body).toEqual({ decision: 'always' })
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
})
