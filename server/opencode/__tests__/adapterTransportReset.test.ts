import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeSDKAdapter } from '../adapter'
import { getOpenCodeAdapter, resetOpenCodeAdapter, resetOpenCodeAdapterTransport } from '../factory'
import { configureOpenCodeRuntime, resetOpenCodeRuntimeConfig } from '../runtimeConfig'
import type { OpenCodeTransport, OpenCodeTransportEventEnvelope } from '../transport'
import type { Message } from '../types'

function makeEventSource() {
  const queue: OpenCodeTransportEventEnvelope[] = []
  let done = false
  let wake: (() => void) | undefined

  return {
    push(...events: OpenCodeTransportEventEnvelope[]) {
      queue.push(...events)
      if (events.some(({ event }) => event?.type === 'execution_terminal')) done = true
      wake?.()
    },
    async *events(signal?: AbortSignal): AsyncGenerator<OpenCodeTransportEventEnvelope> {
      const onAbort = () => wake?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        while (!signal?.aborted) {
          const event = queue.shift()
          if (event) {
            yield event
            continue
          }
          if (done) return
          await new Promise<void>(resolve => { wake = resolve })
          wake = undefined
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}

function assistantMessage(id: string, content: string): Message {
  return {
    id,
    role: 'assistant',
    content,
    parts: [{ id: `${id}-part`, messageID: id, sessionID: 'session-1', type: 'text', text: content }],
  }
}

function transport(protocol: 'v1' | 'v2', overrides: Partial<OpenCodeTransport> = {}): OpenCodeTransport {
  return {
    protocol,
    createSession: vi.fn(),
    updateSession: vi.fn(async () => undefined),
    getSession: vi.fn(async () => ({ id: 'session-1', directory: '/worktree' })),
    listSessions: vi.fn(async () => []),
    getSessionMessages: vi.fn(async () => []),
    subscribeToEvents: vi.fn(async () => ({ events: (async function* () {})(), cursor: 0 })),
    waitForIdle: vi.fn(async () => undefined),
    readSessionLog: vi.fn(async () => ({ events: [], cursor: 0 })),
    dispatchPrompt: vi.fn(async () => ({ kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } })),
    listPendingQuestions: vi.fn(async () => []),
    replyQuestion: vi.fn(async () => undefined),
    rejectQuestion: vi.fn(async () => undefined),
    replyPermission: vi.fn(async () => undefined),
    interruptSession: vi.fn(async () => true),
    checkHealth: vi.fn(async () => ({ available: true, protocol, models: [] })),
    ...overrides,
  } as unknown as OpenCodeTransport
}

describe('OpenCode adapter transport refresh', () => {
  afterEach(() => {
    resetOpenCodeAdapter()
    resetOpenCodeRuntimeConfig()
    vi.restoreAllMocks()
  })

  it('keeps the selected transport through a prompt, permission reply, and snapshot, then resolves again', async () => {
    const source = makeEventSource()
    let dispatched = false
    const oldTransport = transport('v2', {
      getSessionMessages: vi.fn(async () => dispatched ? [assistantMessage('new-answer', 'current answer')] : []),
      subscribeToEvents: vi.fn(async () => ({ events: source.events(), cursor: 0 })),
      readSessionLog: vi.fn(async () => ({ events: [], cursor: 5 })),
    })
    const restartedTransport = transport('v1')
    let resolutions = 0
    const resolver = vi.fn(async () => {
      resolutions += 1
      return resolutions === 1 ? oldTransport : restartedTransport
    })
    const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:4096', undefined, resolver)

    vi.mocked(oldTransport.dispatchPrompt).mockImplementation(async () => {
      dispatched = true
      adapter.resetTransportForFutureOperations()
      source.push(
        { cursor: 1, event: { type: 'inbox_enqueued', sessionId: 'session-1', inboxID: 'inbox-own' } },
        { cursor: 2, event: { type: 'execution_started', sessionId: 'session-1' } },
        { cursor: 3, event: { type: 'permission', sessionId: 'session-1', action: 'asked', permissionId: 'permission-1', permission: 'read' } },
        { cursor: 4, event: { type: 'inbox_delivered', sessionId: 'session-1', inboxID: 'inbox-own' } },
        { cursor: 5, event: { type: 'execution_terminal', sessionId: 'session-1', outcome: 'succeeded' } },
      )
      return { kind: 'accepted', receipt: { inboxID: 'inbox-own' } }
    })

    await expect(adapter.promptSession(
      'session-1',
      [{ type: 'text', content: 'prompt' }],
      undefined,
      { autoApprovePermissions: true },
    )).resolves.toBe('current answer')

    expect(oldTransport.replyPermission).toHaveBeenCalledWith('session-1', 'permission-1', 'always', '/worktree', undefined)
    expect(oldTransport.getSessionMessages).toHaveBeenCalledTimes(2)
    expect(restartedTransport.getSessionMessages).not.toHaveBeenCalled()
    expect(resolutions).toBe(1)

    await adapter.listSessions()
    expect(resolutions).toBe(2)
    expect(restartedTransport.listSessions).toHaveBeenCalledTimes(1)
  })

  it('does not let a stale initialization overwrite a transport reset', async () => {
    let resolveOld: ((value: OpenCodeTransport) => void) | undefined
    const oldInitialization = new Promise<OpenCodeTransport>(resolve => { resolveOld = resolve })
    const oldTransport = transport('v2')
    const freshTransport = transport('v1')
    const resolver = vi.fn()
      .mockImplementationOnce(() => oldInitialization)
      .mockResolvedValueOnce(freshTransport)
    const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:4096', undefined, resolver)

    const oldRequest = adapter.listSessions()
    adapter.resetTransportForFutureOperations()
    await expect(adapter.listSessions()).resolves.toEqual([])
    resolveOld?.(oldTransport)
    await expect(oldRequest).resolves.toEqual([])

    await adapter.listSessions()
    expect(resolver).toHaveBeenCalledTimes(2)
    expect(freshTransport.listSessions).toHaveBeenCalledTimes(2)
    expect(oldTransport.listSessions).toHaveBeenCalledTimes(1)
  })

  it('isolates shared initialization from each caller cancellation', async () => {
    let resolveInitialization: ((value: OpenCodeTransport) => void) | undefined
    const initialization = new Promise<OpenCodeTransport>(resolve => { resolveInitialization = resolve })
    const resolvedTransport = transport('v2')
    const resolver = vi.fn(() => initialization)
    const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:4096', undefined, resolver)
    const cancelled = new AbortController()

    const cancelledRequest = adapter.listSessions(cancelled.signal)
    const survivingRequest = adapter.listSessions()
    cancelled.abort()

    await expect(cancelledRequest).rejects.toMatchObject({ name: 'AbortError' })
    resolveInitialization?.(resolvedTransport)
    await expect(survivingRequest).resolves.toEqual([])

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith('http://127.0.0.1:4096')
    expect(resolvedTransport.listSessions).toHaveBeenCalledTimes(1)
  })

  it('refreshes the singleton transport without replacing the adapter instance', () => {
    configureOpenCodeRuntime({ opencodeBaseUrl: 'http://127.0.0.1:4096', opencodeMode: 'live' })
    const adapter = getOpenCodeAdapter() as OpenCodeSDKAdapter
    const refresh = vi.spyOn(adapter, 'resetTransportForFutureOperations')

    resetOpenCodeAdapterTransport()

    expect(getOpenCodeAdapter()).toBe(adapter)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
