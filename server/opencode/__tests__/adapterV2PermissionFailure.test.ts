import { describe, expect, it, vi } from 'vitest'
import { OpenCodeSDKAdapter } from '../adapter'
import type { Message } from '../types'
import type { OpenCodeTransport, OpenCodeTransportEvent, OpenCodeTransportEventEnvelope } from '../transport'

async function* emptyEventStream(): AsyncGenerator<OpenCodeTransportEventEnvelope> {}

function createAdapter(updateSession: OpenCodeTransport['updateSession']) {
  const transport = {
    protocol: 'v2' as const,
    getSession: vi.fn(async (id: string) => ({ id, directory: '/worktree' })),
    getSessionMessages: vi.fn(async () => []),
    readSessionLog: vi.fn(async (_id: string, after?: number) => after === undefined
      ? { events: [], cursor: 1, coverageComplete: true }
      : { events: [], cursor: after, coverageComplete: false }),
    subscribeToEvents: vi.fn(async () => ({
      events: emptyEventStream(),
      cursor: 1,
      coverageComplete: true,
    })),
    waitForIdle: vi.fn(async () => undefined),
    listPendingInboxes: vi.fn(async () => []),
    updateSession,
  } as unknown as OpenCodeTransport

  return {
    adapter: new OpenCodeSDKAdapter('http://127.0.0.1:4096', undefined, async () => transport),
    transport,
  }
}

function createLifecycleAdapter(
  eventsOnDispatch: OpenCodeTransportEventEnvelope[],
  snapshotMessages: Message[] = [],
) {
  let dispatched = false
  let releaseEvents!: () => void
  const eventsReady = new Promise<void>((resolve) => { releaseEvents = resolve })
  const eventStream = (async function* () {
    await eventsReady
    yield* eventsOnDispatch
  })()
  const transport = {
    protocol: 'v2' as const,
    getSession: vi.fn(async (id: string) => ({ id, directory: '/worktree' })),
    getSessionMessages: vi.fn(async () => dispatched ? snapshotMessages : []),
    readSessionLog: vi.fn(async (_id: string, after?: number) => after === undefined
      ? { events: [], cursor: 0, coverageComplete: true }
      : { events: [], cursor: after, coverageComplete: false }),
    subscribeToEvents: vi.fn(async () => ({ events: eventStream, cursor: 0, coverageComplete: true })),
    waitForIdle: vi.fn(async () => undefined),
    listPendingInboxes: vi.fn(async () => []),
    updateSession: vi.fn(async () => undefined),
    dispatchPrompt: vi.fn(async () => {
      dispatched = true
      releaseEvents()
      return { kind: 'accepted' as const, receipt: { inboxID: 'inbox-own' } }
    }),
  } as unknown as OpenCodeTransport

  return new OpenCodeSDKAdapter('http://127.0.0.1:4096', undefined, async () => transport)
}

const permissions = [{ permission: 'read', pattern: '*', action: 'allow' as const }]

describe('OpenCode v2 session permission updates', () => {
  it('explains when the v2 server cannot apply requested permissions', async () => {
    const updateSession = vi.fn(async () => {
      throw new Error('permission update rejected')
    })
    const { adapter } = createAdapter(updateSession)

    await expect(adapter.promptSession(
      'session-1',
      [{ type: 'text', content: 'Read the ticket.' }],
      undefined,
      { permission: permissions },
    )).rejects.toThrow(/Failed to prompt OpenCode session: Failed to apply OpenCode session permissions: permission update rejected.*upgrade OpenCode/is)
    expect(updateSession).toHaveBeenCalledOnce()
  })

  it('preserves an abort raised while applying v2 permissions', async () => {
    const abort = new DOMException('permission update cancelled', 'AbortError')
    const controller = new AbortController()
    const updateSession = vi.fn(async () => {
      controller.abort(abort)
      throw abort
    })
    const { adapter } = createAdapter(updateSession)

    await expect(adapter.promptSession(
      'session-1',
      [{ type: 'text', content: 'Read the ticket.' }],
      controller.signal,
      { permission: permissions },
    )).rejects.toBe(abort)
    expect(updateSession).toHaveBeenCalledOnce()
  })
})

describe('OpenCode v2 accepted prompt failures', () => {
  const lifecycle = (terminal: Extract<OpenCodeTransportEvent, { type: 'execution_terminal' }>) => [
    { cursor: 1, event: { type: 'inbox_enqueued', sessionId: 'session-1', inboxID: 'inbox-own' } },
    { cursor: 2, event: { type: 'execution_started', sessionId: 'session-1' } },
    { cursor: 3, event: { type: 'inbox_delivered', sessionId: 'session-1', inboxID: 'inbox-own' } },
    { cursor: 4, event: terminal },
  ] satisfies OpenCodeTransportEventEnvelope[]

  it('turns a failed execution terminal into a typed session error', async () => {
    const adapter = createLifecycleAdapter(lifecycle({
      type: 'execution_terminal',
      sessionId: 'session-1',
      outcome: 'failed',
      error: 'provider rejected the request',
    }))

    await expect(adapter.promptSession('session-1', [{ type: 'text', content: 'Run the prompt.' }]))
      .rejects.toMatchObject({
        name: 'OpenCodeSessionError',
        sessionError: 'provider rejected the request',
      })
  })

  it('surfaces an assistant snapshot error even after the execution terminal succeeded', async () => {
    const adapter = createLifecycleAdapter(
      lifecycle({ type: 'execution_terminal', sessionId: 'session-1', outcome: 'succeeded' }),
      [{
        id: 'assistant-error',
        role: 'assistant',
        info: { id: 'assistant-error', sessionID: 'session-1', role: 'assistant', error: { message: 'provider quota exhausted' } },
      }],
    )

    await expect(adapter.promptSession('session-1', [{ type: 'text', content: 'Run the prompt.' }]))
      .rejects.toMatchObject({
        name: 'OpenCodeSessionError',
        message: expect.stringContaining('provider quota exhausted'),
      })
  })

  it('rejects a cancellation event without its matching enqueue evidence', async () => {
    const adapter = createLifecycleAdapter([
      { cursor: 1, event: { type: 'inbox_cancelled', sessionId: 'session-1', inboxID: 'orphan-inbox' } },
      ...lifecycle({ type: 'execution_terminal', sessionId: 'session-1', outcome: 'succeeded' }).map((envelope) => ({
        ...envelope,
        cursor: envelope.cursor! + 1,
      })),
    ])

    await expect(adapter.promptSession('session-1', [{ type: 'text', content: 'Run the prompt.' }]))
      .rejects.toThrow('OpenCode v2 observed an inbox cancellation without its enqueue event')
  })
})
