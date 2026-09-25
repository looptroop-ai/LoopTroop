import { describe, expect, it, vi } from 'vitest'
import { OpenCodeSDKAdapter } from '../adapter'
import type { OpenCodeTransport, OpenCodeTransportEventEnvelope } from '../transport'
import type { Message, StreamEvent } from '../types'
import { OpenCodeV1Transport, type OpenCodeV1Client } from '../v1Transport'
import { V2OpenCodeTransport } from '../v2Transport'

function message(id: string, content: string): Message {
  return {
    id,
    role: 'assistant',
    content,
    parts: [{ id: `${id}-part`, messageID: id, sessionID: 'session-1', type: 'text', text: content }],
  }
}

function v1Message(id: string, content: string) {
  return {
    info: { id, role: 'assistant', sessionID: 'session-1' },
    parts: [{ id: `${id}-part`, messageID: id, sessionID: 'session-1', type: 'text', text: content }],
  }
}

function createEventSource() {
  const queue: OpenCodeTransportEventEnvelope[] = []
  let failure: unknown
  let closed = false
  let wake: (() => void) | undefined

  return {
    push(...events: OpenCodeTransportEventEnvelope[]) {
      queue.push(...events)
      wake?.()
    },
    fail(error: unknown) {
      failure = error
      wake?.()
    },
    async *events(signal?: AbortSignal): AsyncGenerator<OpenCodeTransportEventEnvelope> {
      const onAbort = () => {
        closed = true
        wake?.()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        while (!closed && !signal?.aborted) {
          const next = queue.shift()
          if (next) {
            yield next
            continue
          }
          if (failure) throw failure
          await new Promise<void>(resolve => { wake = resolve })
          wake = undefined
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}

function createV2Transport(overrides: Partial<OpenCodeTransport> = {}) {
  const source = createEventSource()
  let dispatched = false
  const baseline = [message('old-assistant', 'stale answer')]
  const transport = {
    protocol: 'v2' as const,
    createSession: vi.fn(),
    updateSession: vi.fn(async () => undefined),
    getSession: vi.fn(async () => ({ id: 'session-1', directory: '/worktree' })),
    listSessions: vi.fn(async () => []),
    getSessionMessages: vi.fn(async () => dispatched ? [ ...baseline, message('new-assistant', 'current answer') ] : baseline),
    subscribeToEvents: vi.fn(async (_sessionId, _directory, signal) => ({ events: source.events(signal), cursor: 50 })),
    waitForIdle: vi.fn(async () => undefined),
    readSessionLog: vi.fn(async (_sessionId, after = 50) => ({ events: [], cursor: after })),
    dispatchPrompt: vi.fn(async () => {
      dispatched = true
      return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
    }),
    listPendingQuestions: vi.fn(async () => []),
    replyQuestion: vi.fn(async () => undefined),
    rejectQuestion: vi.fn(async () => undefined),
    replyPermission: vi.fn(async () => undefined),
    interruptSession: vi.fn(async () => true),
    checkHealth: vi.fn(async () => ({ available: true, protocol: 'v2' as const, models: [] })),
    ...overrides,
  } as unknown as OpenCodeTransport
  return { transport, source, markDispatched: () => { dispatched = true } }
}

function createV1Transport(overrides: Partial<OpenCodeTransport> = {}): OpenCodeTransport {
  return {
    ...createV2Transport().transport,
    protocol: 'v1' as const,
    getSessionMessages: vi.fn(async () => []),
    subscribeToEvents: vi.fn(async () => ({ events: (async function* () {})() })),
    dispatchPrompt: vi.fn(async () => ({ kind: 'completed' as const, message: message('assistant-1', '') })),
    ...overrides,
  } as unknown as OpenCodeTransport
}

function createAdapter(transport: OpenCodeTransport): OpenCodeSDKAdapter {
  return new OpenCodeSDKAdapter('http://127.0.0.1:4096', undefined, async () => transport)
}

const inboxEvent = (type: 'inbox_enqueued' | 'inbox_delivered', inboxID: string, cursor: number): OpenCodeTransportEventEnvelope => ({
  cursor,
  event: { type, sessionId: 'session-1', inboxID },
})

const executionEvent = (type: 'execution_started' | 'execution_terminal', cursor: number): OpenCodeTransportEventEnvelope => ({
  cursor,
  event: type === 'execution_started'
    ? { type, sessionId: 'session-1' }
    : { type, sessionId: 'session-1', outcome: 'succeeded' },
})

describe('OpenCode adapter transport orchestration', () => {
  it('accepts a stock v2 live turn through the HTTP transport when post-snapshot history is empty', async () => {
    const encoder = new TextEncoder()
    let eventController: ReadableStreamDefaultController<Uint8Array> | undefined
    let promptPosted = false
    let promptPostCount = 0
    const eventSignals: AbortSignal[] = []
    const logCursors: Array<string | null> = []
    const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })
    const emptyResponse = () => new Response(null, { status: 204 })
    const sseResponse = (events: unknown[]) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        controller.close()
      },
    }), { headers: { 'content-type': 'text/event-stream' } })
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
      if (url.pathname === '/api/session/session-1') {
        return jsonResponse({ data: { id: 'session-1', location: { directory: '/workspace' } } })
      }
      if (url.pathname.endsWith('/wait')) return emptyResponse()
      if (url.pathname === '/api/event') {
        if (init.signal) eventSignals.push(init.signal)
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            eventController = controller
            controller.enqueue(encoder.encode('data: {"type":"server.connected"}\n\n'))
          },
        }), { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.pathname.endsWith('/log')) {
        logCursors.push(url.searchParams.get('after'))
        const seq = Number(url.searchParams.get('after') ?? 40)
        return sseResponse([{ type: 'log.synced', aggregateID: 'session-1', seq }])
      }
      if (url.pathname === '/api/session/session-1/message') {
        return jsonResponse({ data: promptPosted ? [{
          id: 'assistant-own',
          type: 'assistant',
          sessionID: 'session-1',
          content: [{ type: 'text', text: 'real v2 answer' }],
          finish: 'stop',
        }] : [] })
      }
      if (url.pathname.endsWith('/instructions/entries/looptroop')) return emptyResponse()
      if (url.pathname === '/api/session/session-1/prompt') {
        promptPosted = true
        promptPostCount += 1
        const events = [
          ['session.inbox.enqueued', 41, { sessionID: 'session-1', inboxID: 'inbox-own' }],
          ['session.execution.started', 42, { sessionID: 'session-1' }],
          ['session.inbox.delivered', 43, { sessionID: 'session-1', inboxID: 'inbox-own' }],
          ['session.execution.succeeded', 44, { sessionID: 'session-1' }],
        ] as const
        for (const [type, seq, data] of events) {
          eventController?.enqueue(encoder.encode(`data: ${JSON.stringify({
            type,
            data,
            durable: { aggregateID: 'session-1', seq },
          })}\n\n`))
        }
        return jsonResponse({ data: { id: 'inbox-own', sessionID: 'session-1' } })
      }
      throw new Error(`Unexpected ${init.method ?? 'GET'} ${url}`)
    }
    const transport = new V2OpenCodeTransport('http://127.0.0.1:4096', { fetch: fetcher })
    const adapter = createAdapter(transport)

    await expect(adapter.promptSession('session-1', [{ type: 'text', content: 'prompt' }]))
      .resolves.toBe('real v2 answer')
    expect(promptPostCount).toBe(1)
    expect(logCursors).toEqual([null, '40', '44'])
    expect(eventSignals).toHaveLength(1)
    expect(eventSignals[0]?.aborted).toBe(true)
  })

  it('accepts a normally observed v2 turn when the empty log watermark has no gap', async () => {
    const { transport, source, markDispatched } = createV2Transport({
      dispatchPrompt: vi.fn(async () => {
        markDispatched()
        source.push(
          inboxEvent('inbox_enqueued', 'inbox-own', 51),
          executionEvent('execution_started', 52),
          inboxEvent('inbox_delivered', 'inbox-own', 53),
          executionEvent('execution_terminal', 54),
        )
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
    })

    await expect(createAdapter(transport).promptSession('session-1', [{ type: 'text', content: 'prompt' }]))
      .resolves.toBe('current answer')
    expect(transport.readSessionLog).toHaveBeenCalledWith('session-1', 54, undefined)
  })

  it('captures a v2 cursor before waiting idle and subscribes from that cursor', async () => {
    const { transport, source, markDispatched } = createV2Transport()
    const order: string[] = []
    vi.mocked(transport.readSessionLog).mockImplementation(async (_sessionId, after) => {
      if (after === undefined) {
        order.push('cursor')
        return { events: [], cursor: 50 }
      }
      return { events: [], cursor: after }
    })
    vi.mocked(transport.waitForIdle).mockImplementation(async () => { order.push('idle') })
    vi.mocked(transport.subscribeToEvents).mockImplementation(async (_sessionId, _directory, signal, _safetyMs, afterCursor) => {
      order.push(`subscribe:${afterCursor}`)
      return { events: source.events(signal), cursor: afterCursor, coverageComplete: true }
    })
    vi.mocked(transport.dispatchPrompt).mockImplementation(async () => {
      order.push('dispatch')
      markDispatched()
      source.push(
        inboxEvent('inbox_enqueued', 'inbox-own', 51),
        executionEvent('execution_started', 52),
        inboxEvent('inbox_delivered', 'inbox-own', 53),
        executionEvent('execution_terminal', 54),
      )
      return { kind: 'accepted', receipt: { inboxID: 'inbox-own' } }
    })

    await expect(createAdapter(transport).promptSession('session-1', [{ type: 'text', content: 'prompt' }]))
      .resolves.toBe('current answer')

    expect(order.slice(0, 4)).toEqual(['cursor', 'idle', 'subscribe:50', 'dispatch'])
  })

  it('opens v2 event coverage before changing permissions and consumes its cursor-only update', async () => {
    const { transport, source, markDispatched } = createV2Transport()
    const order: string[] = []
    vi.mocked(transport.readSessionLog).mockImplementation(async (_sessionId, after) => {
      order.push(after === undefined ? 'cursor' : `history:${after}`)
      return { events: [], cursor: after ?? 50, coverageComplete: true }
    })
    vi.mocked(transport.waitForIdle).mockImplementation(async () => { order.push('idle') })
    vi.mocked(transport.subscribeToEvents).mockImplementation(async (_sessionId, _directory, signal, _safetyMs, afterCursor) => {
      order.push(`subscribe:${afterCursor}`)
      return { events: source.events(signal), cursor: afterCursor, coverageComplete: true }
    })
    vi.mocked(transport.updateSession).mockImplementation(async () => {
      order.push('permissions')
      source.push({ cursor: 51 })
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    vi.mocked(transport.dispatchPrompt).mockImplementation(async () => {
      order.push('dispatch')
      markDispatched()
      source.push(
        inboxEvent('inbox_enqueued', 'inbox-own', 52),
        executionEvent('execution_started', 53),
        inboxEvent('inbox_delivered', 'inbox-own', 54),
        executionEvent('execution_terminal', 55),
      )
      return { kind: 'accepted', receipt: { inboxID: 'inbox-own' } }
    })

    await expect(createAdapter(transport).promptSession(
      'session-1',
      [{ type: 'text', content: 'prompt' }],
      undefined,
      { permission: [{ permission: 'read', pattern: '*', action: 'allow' }] },
    )).resolves.toBe('current answer')

    expect(order.slice(0, 5)).toEqual(['cursor', 'idle', 'subscribe:50', 'permissions', 'dispatch'])
    expect(transport.readSessionLog).toHaveBeenCalledWith('session-1', 55, undefined)
  })

  it('does not finish a new prompt from an earlier execution start and terminal', async () => {
    const { transport, source } = createV2Transport()
    source.push(
      executionEvent('execution_started', 51),
      executionEvent('execution_terminal', 52),
    )
    vi.mocked(transport.dispatchPrompt).mockImplementation(async () => {
      source.push(
        inboxEvent('inbox_enqueued', 'inbox-own', 53),
        inboxEvent('inbox_delivered', 'inbox-own', 54),
      )
      return { kind: 'accepted', receipt: { inboxID: 'inbox-own' } }
    })
    const controller = new AbortController()
    const prompt = createAdapter(transport).promptSession(
      'session-1',
      [{ type: 'text', content: 'new prompt' }],
      controller.signal,
    )
    let settled = false
    void prompt.finally(() => { settled = true }).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    controller.abort()
    await expect(prompt).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('refuses to dispatch when the v2 subscription cannot certify its history cursor', async () => {
    const { transport } = createV2Transport({
      subscribeToEvents: vi.fn(async () => ({
        events: (async function* () {})(),
        cursor: 51,
        coverageComplete: false,
      })),
    })

    await expect(createAdapter(transport).promptSession('session-1', [{ type: 'text', content: 'prompt' }]))
      .rejects.toThrow('history is unavailable or incomplete')
    expect(transport.dispatchPrompt).not.toHaveBeenCalled()
    expect(transport.getSessionMessages).not.toHaveBeenCalled()
  })

  it('reports unavailable v2 history before waiting idle when it has no trusted cursor', async () => {
    const { transport } = createV2Transport({
      readSessionLog: vi.fn(async () => ({ events: [] })),
    })

    await expect(createAdapter(transport).promptSession('session-1', [{ type: 'text', content: 'prompt' }]))
      .rejects.toThrow('OpenCode v2 history is unavailable')
    expect(transport.waitForIdle).not.toHaveBeenCalled()
    expect(transport.subscribeToEvents).not.toHaveBeenCalled()
    expect(transport.dispatchPrompt).not.toHaveBeenCalled()
  })

  it('does not retry durable recovery after an automatic permission reply fails', async () => {
    const { transport, source } = createV2Transport({
      replyPermission: vi.fn(async () => { throw new Error('permission endpoint unavailable') }),
      dispatchPrompt: vi.fn(async () => {
        source.push(
          inboxEvent('inbox_enqueued', 'inbox-own', 51),
          {
            event: {
              type: 'permission',
              sessionId: 'session-1',
              action: 'asked',
              permissionId: 'permission-1',
              permission: 'read',
            },
          },
        )
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
    })

    await expect(createAdapter(transport).promptSession(
      'session-1',
      [{ type: 'text', content: 'prompt' }],
      undefined,
      { autoApprovePermissions: true },
    )).rejects.toThrow('Failed to auto-approve OpenCode permission read: permission endpoint unavailable')
    expect(transport.readSessionLog).toHaveBeenCalledTimes(1)
  })

  it('reconciles an ephemeral permission ask after its inbox was accepted', async () => {
    const { transport, source, markDispatched } = createV2Transport({
      dispatchPrompt: vi.fn(async () => {
        markDispatched()
        source.push(
          inboxEvent('inbox_enqueued', 'inbox-own', 51),
          {
            event: {
              type: 'permission',
              sessionId: 'session-1',
              action: 'asked',
              permissionId: 'permission-1',
              permission: 'read',
            },
          },
        )
        source.fail(new Error('SSE disconnected'))
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
      readSessionLog: vi.fn(async (_sessionId, after) => {
        if (after === undefined) return { events: [], cursor: 50, coverageComplete: true }
        if (after === 51) return {
          events: [
            executionEvent('execution_started', 52),
            inboxEvent('inbox_delivered', 'inbox-own', 53),
            executionEvent('execution_terminal', 54),
          ],
          cursor: 54,
          coverageComplete: true,
        }
        return { events: [], cursor: after, coverageComplete: true }
      }),
    })

    await expect(createAdapter(transport).promptSession(
      'session-1',
      [{ type: 'text', content: 'prompt' }],
      undefined,
      { autoApprovePermissions: true },
    )).resolves.toBe('current answer')
    expect(transport.replyPermission).toHaveBeenCalledWith('session-1', 'permission-1', 'always', '/worktree', undefined)
  })

  it('does not auto-approve a pending ask after replay finds a competing inbox', async () => {
    const { transport, source } = createV2Transport({
      dispatchPrompt: vi.fn(async () => {
        source.push({
          event: {
            type: 'permission',
            sessionId: 'session-1',
            action: 'asked',
            permissionId: 'permission-1',
            permission: 'read',
          },
        })
        source.fail(new Error('SSE disconnected'))
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
      readSessionLog: vi.fn(async (_sessionId, after) => {
        if (after === undefined) return { events: [], cursor: 50, coverageComplete: true }
        if (after === 50) return {
          events: [
            inboxEvent('inbox_enqueued', 'inbox-external', 51),
            executionEvent('execution_started', 52),
            inboxEvent('inbox_delivered', 'inbox-external', 53),
            executionEvent('execution_terminal', 54),
          ],
          cursor: 54,
          coverageComplete: true,
        }
        return { events: [], cursor: after, coverageComplete: true }
      }),
    })

    await expect(createAdapter(transport).promptSession(
      'session-1',
      [{ type: 'text', content: 'prompt' }],
      undefined,
      { autoApprovePermissions: true },
    )).rejects.toThrow('Another prompt entered the OpenCode session during result attribution')
    expect(transport.replyPermission).not.toHaveBeenCalled()
  })

  it.each([
    { outcome: 'succeeded' as const, expected: { type: 'done' } },
    { outcome: 'failed' as const, error: 'provider failed', expected: { type: 'session_error', error: 'provider failed' } },
    { outcome: 'interrupted' as const, expected: { type: 'session_error', error: 'OpenCode execution was interrupted' } },
  ])('maps v2 $outcome terminals for public event subscribers', async ({ outcome, error, expected }) => {
    const transport = createV2Transport({
      subscribeToEvents: vi.fn(async () => ({
        events: (async function* () {
          yield {
            event: {
              type: 'execution_terminal' as const,
              sessionId: 'session-1',
              outcome,
              ...(error ? { error } : {}),
            },
          }
        })(),
      })),
    }).transport
    const events: StreamEvent[] = []
    for await (const event of createAdapter(transport).subscribeToEvents('session-1')) events.push(event)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject(expected)
  })

  it('reports a v1 event stream failure as a session error after a completed empty dispatch', async () => {
    const transport = createV1Transport({
      subscribeToEvents: vi.fn(async () => ({
        events: (async function* () {
          yield { event: { type: 'session_status' as const, sessionId: 'session-1', status: 'idle' as const } }
          throw new Error('SSE disconnected')
        })(),
      })),
    })

    await expect(createAdapter(transport).promptSession('session-1', [{ type: 'text', content: 'prompt' }]))
      .rejects.toMatchObject({
        name: 'OpenCodeSessionError',
        sessionError: 'SSE disconnected',
      })
  })

  it('keeps streamed v1 text when echo recovery cannot read the message snapshot', async () => {
    const echoedPrompt = 'CRITICAL OUTPUT RULE:\nCONTEXT REFRESH:\nwork the task'
    const transport = createV1Transport({
      subscribeToEvents: vi.fn(async () => ({
        events: (async function* () {
          yield {
            event: {
              type: 'text' as const,
              sessionId: 'session-1',
              messageId: 'assistant-1',
              partId: 'part-1',
              text: 'actual streamed answer',
              streaming: false,
              complete: true,
            },
          }
        })(),
      })),
      getSessionMessages: vi.fn(async () => { throw new Error('message snapshot unavailable') }),
      dispatchPrompt: vi.fn(async () => ({
        kind: 'completed' as const,
        message: message('assistant-1', echoedPrompt),
      })),
    })

    await expect(createAdapter(transport).promptSession('session-1', [{ type: 'text', content: echoedPrompt }]))
      .resolves.toBe('actual streamed answer')
  })

  it('keeps provider diagnostics when cancellation races with a provider error', async () => {
    const controller = new AbortController()
    const transport = createV2Transport({
      dispatchPrompt: vi.fn(async () => {
        controller.abort()
        throw new Error('Provider returned error')
      }),
    }).transport

    await expect(createAdapter(transport).promptSession(
      'session-diagnostic-abort',
      [{ type: 'text', content: 'prompt' }],
      controller.signal,
    )).rejects.toMatchObject({
      message: expect.stringContaining('LOOPTROOP_OPENCODE_LOG_DIR'),
    })
  })

  it('emits synthetic v1 completion after event-stream EOF and cleans up the iterator and timer', async () => {
    vi.useFakeTimers()
    let iteratorClosed = false
    let streamSignal: AbortSignal | undefined
    const client = {
      global: {
        event: vi.fn(async (options?: { signal?: AbortSignal }) => {
          streamSignal = options?.signal
          return {
            stream: (async function* () {
              try {
                yield {
                  type: 'message.part.updated',
                  properties: {
                    part: {
                      id: 'step-1',
                      type: 'step-finish',
                      reason: 'stop',
                      sessionID: 'session-1',
                      messageID: 'message-1',
                    },
                  },
                }
              } finally {
                iteratorClosed = true
              }
            })(),
          }
        }),
      },
    } as unknown as OpenCodeV1Client
    const transport = new OpenCodeV1Transport('http://127.0.0.1:4096', client)

    try {
      const subscription = await transport.subscribeToEvents('session-1', undefined, undefined, 1_000)
      const events: NonNullable<OpenCodeTransportEventEnvelope['event']>[] = []
      for await (const envelope of subscription.events) {
        if (envelope.event) events.push(envelope.event)
      }

      expect(events.map(event => event.type)).toEqual(['step', 'done'])
      expect(iteratorClosed).toBe(true)
      expect(streamSignal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits synthetic v1 completion when the safety timer expires and closes the pending iterator', async () => {
    vi.useFakeTimers()
    let iteratorClosed = false
    let streamSignal: AbortSignal | undefined
    let startSecondNext!: () => void
    const secondNextStarted = new Promise<void>(resolve => { startSecondNext = resolve })
    let nextCalls = 0
    const stepFinish = {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'step-1',
          type: 'step-finish',
          reason: 'stop',
          sessionID: 'session-1',
          messageID: 'message-1',
        },
      },
    }
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (nextCalls++ === 0) return Promise.resolve({ value: stepFinish, done: false } as const)
            startSecondNext()
            return new Promise<IteratorResult<typeof stepFinish>>(resolve => {
              streamSignal?.addEventListener('abort', () => resolve({ value: undefined, done: true }), { once: true })
            })
          },
          async return() {
            iteratorClosed = true
            return { value: undefined, done: true } as const
          },
        }
      },
    }
    const client = {
      global: {
        event: vi.fn(async (options?: { signal?: AbortSignal }) => {
          streamSignal = options?.signal
          return { stream }
        }),
      },
    } as unknown as OpenCodeV1Client
    const transport = new OpenCodeV1Transport('http://127.0.0.1:4096', client)

    try {
      const subscription = await transport.subscribeToEvents('session-1', undefined, undefined, 1_000)
      const collectedEvents = (async () => {
        const events = []
        for await (const envelope of subscription.events) events.push(envelope.event)
        return events
      })()
      await secondNextStarted
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(collectedEvents).resolves.toEqual([
        expect.objectContaining({ type: 'step', step: 'finish' }),
        { type: 'done', sessionId: 'session-1' },
      ])
      expect(iteratorClosed).toBe(true)
      expect(streamSignal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves caller cancellation when cleanup aborts the v1 stream signal', async () => {
    vi.useFakeTimers()
    let iteratorClosed = false
    let streamSignal: AbortSignal | undefined
    let startSecondNext!: () => void
    const secondNextStarted = new Promise<void>(resolve => { startSecondNext = resolve })
    let nextCalls = 0
    const stepFinish = {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'step-1',
          type: 'step-finish',
          reason: 'stop',
          sessionID: 'session-1',
          messageID: 'message-1',
        },
      },
    }
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (nextCalls++ === 0) return Promise.resolve({ value: stepFinish, done: false } as const)
            startSecondNext()
            return new Promise<IteratorResult<typeof stepFinish>>(resolve => {
              streamSignal?.addEventListener('abort', () => resolve({ value: undefined, done: true }), { once: true })
            })
          },
          async return() {
            iteratorClosed = true
            return { value: undefined, done: true } as const
          },
        }
      },
    }
    const client = {
      global: {
        event: vi.fn(async (options?: { signal?: AbortSignal }) => {
          streamSignal = options?.signal
          return { stream }
        }),
      },
    } as unknown as OpenCodeV1Client
    const transport = new OpenCodeV1Transport('http://127.0.0.1:4096', client)
    const caller = new AbortController()

    try {
      const subscription = await transport.subscribeToEvents('session-1', undefined, caller.signal, 1_000)
      const collectedEvents = (async () => {
        const events = []
        for await (const envelope of subscription.events) events.push(envelope.event)
        return events
      })()
      await secondNextStarted
      expect(vi.getTimerCount()).toBe(1)
      caller.abort()

      await expect(collectedEvents).resolves.toEqual([
        expect.objectContaining({ type: 'step', step: 'finish' }),
      ])
      expect(iteratorClosed).toBe(true)
      expect(streamSignal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not treat idle status or stale streamed output as completion of an accepted prompt', async () => {
    const { transport, source } = createV2Transport({
      dispatchPrompt: vi.fn(async () => {
        source.push(
          { event: { type: 'session_status', sessionId: 'session-1', status: 'idle' } },
          { event: { type: 'text', sessionId: 'session-1', messageId: 'old-assistant', partId: 'old-part', text: 'stale answer', streaming: false, complete: true } },
        )
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
    })
    const controller = new AbortController()
    const prompt = createAdapter(transport).promptSession('session-1', [{ type: 'text', content: 'new prompt' }], controller.signal)
    let settled = false
    void prompt.finally(() => { settled = true }).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    controller.abort()
    await expect(prompt).rejects.toMatchObject({ name: 'AbortError' })
    expect(transport.dispatchPrompt).toHaveBeenCalledTimes(1)
  })

  it('recovers an accepted prompt from the durable log without resubmitting it', async () => {
    const { transport, source, markDispatched } = createV2Transport({
      dispatchPrompt: vi.fn(async () => {
        markDispatched()
        source.fail(new Error('SSE disconnected'))
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
      readSessionLog: vi.fn(async (_sessionId, after) => after === undefined ? ({ events: [], cursor: 50 }) : after < 54 ? ({
        events: [
          inboxEvent('inbox_enqueued', 'inbox-own', 51),
          executionEvent('execution_started', 52),
          inboxEvent('inbox_delivered', 'inbox-own', 53),
          executionEvent('execution_terminal', 54),
        ],
        cursor: 54,
      }) : ({ events: [], cursor: after })),
    })
    await expect(createAdapter(transport).promptSession('session-1', [{ type: 'text', content: 'prompt' }]))
      .resolves.toBe('current answer')
    expect(transport.readSessionLog).toHaveBeenCalledWith('session-1', 50, undefined)
    expect(transport.dispatchPrompt).toHaveBeenCalledTimes(1)
  })

  it('rejects a terminal snapshot if another prompt arrives while that snapshot is loading', async () => {
    let reads = 0
    let markSnapshotStarted: (() => void) | undefined
    let releaseSnapshot: (() => void) | undefined
    const snapshotStarted = new Promise<void>(resolve => { markSnapshotStarted = resolve })
    const delayedSnapshot = new Promise<void>(resolve => { releaseSnapshot = resolve })
    const { transport, source } = createV2Transport({
      getSessionMessages: vi.fn(async () => {
        reads += 1
        if (reads === 1) return [message('old-assistant', 'stale answer')]
        markSnapshotStarted?.()
        await delayedSnapshot
        return [
          message('own-assistant', 'own answer'),
          message('external-assistant', 'external answer'),
        ]
      }),
      dispatchPrompt: vi.fn(async () => {
        source.push(
          inboxEvent('inbox_enqueued', 'inbox-own', 51),
          executionEvent('execution_started', 52),
          inboxEvent('inbox_delivered', 'inbox-own', 53),
          executionEvent('execution_terminal', 54),
        )
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
    })

    const prompt = createAdapter(transport).promptSession('session-1', [{ type: 'text', content: 'prompt' }])
    await snapshotStarted
    source.push(inboxEvent('inbox_enqueued', 'inbox-external', 55))
    await new Promise(resolve => setTimeout(resolve, 0))
    releaseSnapshot?.()

    await expect(prompt).rejects.toThrow('Another prompt entered the OpenCode session during result attribution')
  })

  it('replays the durable log after a recovered snapshot when SSE closed during that snapshot', async () => {
    let reads = 0
    let logReads = 0
    let snapshotReturned = false
    let markSnapshotStarted: (() => void) | undefined
    let releaseSnapshot: (() => void) | undefined
    const snapshotStarted = new Promise<void>(resolve => { markSnapshotStarted = resolve })
    const delayedSnapshot = new Promise<void>(resolve => { releaseSnapshot = resolve })
    const { transport, source } = createV2Transport({
      getSessionMessages: vi.fn(async () => {
        reads += 1
        if (reads === 1) return []
        markSnapshotStarted?.()
        await delayedSnapshot
        snapshotReturned = true
        return [
          message('own-answer', 'own answer'),
          message('external-answer', 'external answer'),
        ]
      }),
      dispatchPrompt: vi.fn(async () => {
        source.fail(new Error('SSE disconnected'))
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
      readSessionLog: vi.fn(async (_sessionId, cursor) => {
        if (cursor === undefined) return { events: [], cursor: 50 }
        logReads += 1
        if (logReads === 1) {
          return {
            events: [
              inboxEvent('inbox_enqueued', 'inbox-own', 51),
              executionEvent('execution_started', 52),
              inboxEvent('inbox_delivered', 'inbox-own', 53),
              executionEvent('execution_terminal', 54),
            ],
            cursor: 54,
          }
        }
        expect(snapshotReturned).toBe(true)
        expect(cursor).toBe(54)
        return { events: [inboxEvent('inbox_enqueued', 'inbox-external', 55)], cursor: 55 }
      }),
    })

    const prompt = createAdapter(transport).promptSession('session-1', [{ type: 'text', content: 'own prompt' }])
    await snapshotStarted
    releaseSnapshot?.()

    await expect(prompt).rejects.toThrow('Another prompt entered the OpenCode session during result attribution')
    expect(transport.dispatchPrompt).toHaveBeenCalledTimes(1)
    expect(logReads).toBe(2)
  })

  it('rejects a stable snapshot when the v2 watermark advanced without replayable history', async () => {
    let reads = 0
    const { transport, source } = createV2Transport({
      getSessionMessages: vi.fn(async () => {
        reads += 1
        return reads === 1
          ? [message('old-assistant', 'stale answer')]
          : [message('own-answer', 'own answer'), message('external-answer', 'external answer')]
      }),
      dispatchPrompt: vi.fn(async () => {
        source.push(
          inboxEvent('inbox_enqueued', 'inbox-own', 51),
          executionEvent('execution_started', 52),
          inboxEvent('inbox_delivered', 'inbox-own', 53),
          executionEvent('execution_terminal', 54),
        )
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
      readSessionLog: vi.fn(async (_sessionId, after = 50) => ({ events: [], cursor: after + 1 })),
    })

    await expect(createAdapter(transport).promptSession('session-1', [{ type: 'text', content: 'own prompt' }]))
      .rejects.toThrow('history is incomplete')
    expect(reads).toBe(2)
  })

  it('rejects a terminal event after reconnect replay advanced across a missing history gap', async () => {
    const { transport, source } = createV2Transport({
      dispatchPrompt: vi.fn(async () => {
        source.push(
          inboxEvent('inbox_enqueued', 'inbox-own', 51),
          executionEvent('execution_started', 52),
          inboxEvent('inbox_delivered', 'inbox-own', 53),
          { ...executionEvent('execution_terminal', 55), coverageGap: true },
        )
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
    })

    await expect(createAdapter(transport).promptSession('session-1', [{ type: 'text', content: 'prompt' }]))
      .rejects.toThrow('unaccounted durable sequence gap')
  })

  it('fails closed if an echo-refresh snapshot cannot be certified by durable replay', async () => {
    let reads = 0
    let logReads = 0
    const { transport, source } = createV2Transport({
      getSessionMessages: vi.fn(async () => {
        reads += 1
        if (reads === 1) return []
        if (reads === 2) {
          return [message('echo', 'CRITICAL OUTPUT RULE:\n## Task\nRepeat the user prompt.')]
        }
        return [message('refreshed', 'refreshed answer')]
      }),
      dispatchPrompt: vi.fn(async () => {
        source.push(
          inboxEvent('inbox_enqueued', 'inbox-own', 51),
          executionEvent('execution_started', 52),
          inboxEvent('inbox_delivered', 'inbox-own', 53),
          executionEvent('execution_terminal', 54),
        )
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
      readSessionLog: vi.fn(async (_sessionId, cursor) => {
        if (cursor === undefined) return { events: [], cursor: 50 }
        logReads += 1
        if (logReads === 1) return { events: [], cursor }
        throw new Error('session log unavailable')
      }),
    })

    await expect(createAdapter(transport).promptSession(
      'session-1',
      [{ type: 'text', content: 'own prompt' }],
    )).rejects.toThrow('history is unavailable for accepted prompt certification: session log unavailable')
    expect(reads).toBe(3)
    expect(logReads).toBe(2)
  })

  it('fails closed if an echo-refresh snapshot advances past missing durable history', async () => {
    let reads = 0
    let logReads = 0
    const { transport, source } = createV2Transport({
      getSessionMessages: vi.fn(async () => {
        reads += 1
        if (reads === 1) return []
        if (reads === 2) return [message('echo', 'CRITICAL OUTPUT RULE:\n## Task\nRepeat the user prompt.')]
        return [message('refreshed', 'refreshed answer')]
      }),
      dispatchPrompt: vi.fn(async () => {
        source.push(
          inboxEvent('inbox_enqueued', 'inbox-own', 51),
          executionEvent('execution_started', 52),
          inboxEvent('inbox_delivered', 'inbox-own', 53),
          executionEvent('execution_terminal', 54),
        )
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
      readSessionLog: vi.fn(async (_sessionId, after) => {
        if (after === undefined) return { events: [], cursor: 50 }
        logReads += 1
        return { events: [], cursor: after + (logReads === 1 ? 0 : 1) }
      }),
    })

    await expect(createAdapter(transport).promptSession(
      'session-1',
      [{ type: 'text', content: 'own prompt' }],
    )).rejects.toThrow('history is incomplete')
    expect(reads).toBe(3)
    expect(logReads).toBe(2)
  })

  it('rejects a result when another inbox was coalesced into the same execution', async () => {
    const { transport, source } = createV2Transport({
      dispatchPrompt: vi.fn(async () => {
        source.push(
          inboxEvent('inbox_enqueued', 'inbox-external', 51),
          executionEvent('execution_started', 52),
          inboxEvent('inbox_enqueued', 'inbox-own', 53),
          inboxEvent('inbox_delivered', 'inbox-own', 54),
          executionEvent('execution_terminal', 55),
        )
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
    })
    await expect(createAdapter(transport).promptSession('session-1', [{ type: 'text', content: 'prompt' }]))
      .rejects.toThrow('Another prompt entered the OpenCode session during result attribution')
    expect(transport.dispatchPrompt).toHaveBeenCalledTimes(1)
  })

  it('reports confirmed interruption instead of returning an assistant snapshot', async () => {
    const { transport, source } = createV2Transport({
      dispatchPrompt: vi.fn(async () => {
        source.push(
          inboxEvent('inbox_enqueued', 'inbox-own', 50),
          executionEvent('execution_started', 51),
          inboxEvent('inbox_delivered', 'inbox-own', 52),
          { cursor: 53, event: { type: 'execution_terminal', sessionId: 'session-1', outcome: 'interrupted' } },
        )
        return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
      }),
    })
    await expect(createAdapter(transport).promptSession('session-1', [{ type: 'text', content: 'prompt' }]))
      .rejects.toMatchObject({ name: 'OpenCodeSessionInterrupted' })
  })

  it('rejects overlapping local prompts for one session while the first waits for idle', async () => {
    let releaseIdle: (() => void) | undefined
    let signalIdleStarted: (() => void) | undefined
    const idleStarted = new Promise<void>(resolve => { signalIdleStarted = resolve })
    const transport = {
      protocol: 'v1' as const,
      createSession: vi.fn(),
      updateSession: vi.fn(async () => undefined),
      getSession: vi.fn(async () => ({ id: 'session-1', directory: '/worktree' })),
      listSessions: vi.fn(async () => []),
      getSessionMessages: vi.fn(async () => []),
      subscribeToEvents: vi.fn(async (_sessionId, _directory, signal) => ({ events: createEventSource().events(signal) })),
      waitForIdle: vi.fn(() => new Promise<void>(resolve => {
        releaseIdle = resolve
        signalIdleStarted?.()
      })),
      readSessionLog: vi.fn(async () => ({ events: [] })),
      dispatchPrompt: vi.fn(async () => ({ kind: 'completed' as const, message: message('fresh', 'done') })),
      listPendingQuestions: vi.fn(async () => []),
      replyQuestion: vi.fn(async () => undefined),
      rejectQuestion: vi.fn(async () => undefined),
      replyPermission: vi.fn(async () => undefined),
      interruptSession: vi.fn(async () => true),
      checkHealth: vi.fn(async () => ({ available: true, protocol: 'v1' as const, models: [] })),
    } as unknown as OpenCodeTransport
    const adapter = createAdapter(transport)
    const first = adapter.promptSession('session-1', [{ type: 'text', content: 'first' }])
    await idleStarted
    await expect(adapter.promptSession('session-1', [{ type: 'text', content: 'second' }]))
      .rejects.toThrow('already has a prompt in progress')
    releaseIdle?.()
    await expect(first).resolves.toBe('done')
  })

  it('keeps v1 synchronous prompts and worktree-scoped permissions and questions', async () => {
    let resolvePermission: (() => void) | undefined
    const permissionSettled = new Promise<void>(resolve => { resolvePermission = resolve })
    const permissionReply = vi.fn(async () => {
      resolvePermission?.()
      return { data: true }
    })
    const client = {
      session: {
        get: vi.fn(async () => ({ data: { id: 'session-1', directory: '/worktree' } })),
        update: vi.fn(async () => ({ data: { id: 'session-1' } })),
        messages: vi.fn(async () => ({ data: [v1Message('old-assistant', 'stale answer')] })),
        prompt: vi.fn(async () => {
          await permissionSettled
          return { data: { info: { id: 'new-assistant', sessionID: 'session-1', role: 'assistant' }, parts: [{ type: 'text', text: 'v1 answer' }] } }
        }),
      },
      global: {
        event: vi.fn(async () => ({
          stream: (async function* () {
            yield { type: 'permission.asked', properties: { sessionID: 'session-1', id: 'permission-1', permission: 'read' } }
          })(),
        })),
      },
      permission: { reply: permissionReply },
      question: {
        list: vi.fn(async () => ({ data: [{ id: 'question-1', sessionID: 'session-1', questions: [{ question: 'Choose', header: 'Choice', options: [{ label: 'A', value: 'a' }] }] }] })),
        reply: vi.fn(async () => ({ data: true })),
        reject: vi.fn(async () => ({ data: true })),
      },
    } as unknown as OpenCodeV1Client
    const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:4096', client)
    await expect(adapter.promptSession(
      'session-1',
      [{ type: 'text', content: 'hello' }],
      undefined,
      { permission: [{ permission: 'read', pattern: '*', action: 'allow' }], autoApprovePermissions: true },
    )).resolves.toBe('v1 answer')
    expect(client.session.update).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'session-1',
      directory: '/worktree',
      permission: [{ permission: 'read', pattern: '*', action: 'allow' }],
    }), expect.anything())
    expect(permissionReply).toHaveBeenCalledWith(expect.objectContaining({
      requestID: 'permission-1',
      directory: '/worktree',
      reply: 'always',
    }), expect.anything())

    const questions = await adapter.listPendingQuestions(undefined, undefined, 'session-1')
    expect(questions[0]?.questions[0]?.options[0]).toMatchObject({ label: 'A', value: 'a' })
    await adapter.replyQuestion('question-1', [['a']], undefined, undefined, 'session-1')
    expect(client.question.reply).toHaveBeenCalledWith(expect.objectContaining({
      requestID: 'question-1',
      directory: '/worktree',
      answers: [['a']],
    }), expect.anything())
  })
})
