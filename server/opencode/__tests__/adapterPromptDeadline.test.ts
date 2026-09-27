import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/constants', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/constants')>(),
  SDK_OPERATION_TIMEOUT_MS: 25,
}))

import { OpenCodeSDKAdapter } from '../adapter'
import type { OpenCodeV1Client } from '../v1Transport'
import { withProviderCatalogReload } from '../providerCatalogReload'

function createClient(
  promptDelayMs: number,
  overrides: {
    messageReadError?: Error
    sessionUpdateError?: Error
    streamEvents?: Array<{ type: string; properties?: Record<string, unknown> }>
  } = {},
): OpenCodeV1Client {
  return {
    session: {
      get: vi.fn(async () => ({ data: { id: 'session-1', directory: '/worktree' } })),
      messages: vi.fn(async () => {
        if (overrides.messageReadError) throw overrides.messageReadError
        return { data: [] }
      }),
      update: vi.fn(async () => {
        if (overrides.sessionUpdateError) throw overrides.sessionUpdateError
        return { data: { id: 'session-1' } }
      }),
      prompt: vi.fn(async (_request, options) => await new Promise((resolve, reject) => {
        const signal = options?.signal
        const cleanup = () => signal?.removeEventListener('abort', onAbort)
        const timer = setTimeout(() => {
          cleanup()
          resolve({
            data: {
              info: { id: 'assistant-1', sessionID: 'session-1', role: 'assistant' },
              parts: [{ type: 'text', text: 'completed after the short API timeout' }],
            },
          })
        }, promptDelayMs)
        const onAbort = () => {
          clearTimeout(timer)
          cleanup()
          reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
        }
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
      })),
    },
    global: {
      event: vi.fn(async options => ({
        stream: (async function* () {
          if (overrides.streamEvents) {
            yield* overrides.streamEvents
            return
          }
          const signal = options?.signal
          if (!signal) return
          await new Promise<void>(resolve => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', resolve, { once: true })
          })
          yield { type: 'test.noop' }
        })(),
      })),
    },
  } as unknown as OpenCodeV1Client
}

describe('OpenCode prompt deadlines', () => {
  it('lets v1 generation outlast the short SDK operation timeout', async () => {
    const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:4096', createClient(80))

    await expect(adapter.promptSession('session-1', [{ type: 'text', content: 'slow generation' }]))
      .resolves.toBe('completed after the short API timeout')
  })

  it('still honors the caller-provided workflow deadline', async () => {
    const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:4096', createClient(80))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10)

    try {
      await expect(adapter.promptSession(
        'session-1',
        [{ type: 'text', content: 'cancel slow generation' }],
        controller.signal,
      )).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      clearTimeout(timer)
    }
  })

  it('continues a v1 prompt when the optional assistant baseline cannot be read', async () => {
    const adapter = new OpenCodeSDKAdapter(
      'http://127.0.0.1:4096',
      createClient(1, { messageReadError: new Error('baseline read unavailable') }),
    )

    await expect(adapter.promptSession('session-1', [{ type: 'text', content: 'continue without baseline' }]))
      .resolves.toBe('completed after the short API timeout')
  })

  it('drops removed streamed text parts before returning the latest message text', async () => {
    const partUpdate = (id: string, messageID: string, text: string) => ({
      type: 'message.part.updated',
      properties: {
        part: { id, sessionID: 'session-1', messageID, type: 'text', text },
      },
    })
    const client = createClient(1000, {
      messageReadError: new Error('snapshot baseline unavailable'),
      streamEvents: [
        partUpdate('old-part-a', 'old-message', 'stale '),
        partUpdate('old-part-b', 'old-message', 'fragment'),
        { type: 'message.part.removed', properties: { sessionID: 'session-1', partID: 'old-part-a' } },
        { type: 'message.part.removed', properties: { sessionID: 'session-1', partID: 'old-part-b' } },
        partUpdate('current-part', 'current-message', 'latest answer'),
        { type: 'session.idle', properties: { sessionID: 'session-1' } },
      ],
    })
    const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:4096', client)

    await expect(adapter.promptSession('session-1', [{ type: 'text', content: 'get answer' }]))
      .resolves.toBe('latest answer')
  })

  it('explains when the v1 server cannot apply session permissions', async () => {
    const client = createClient(1, { sessionUpdateError: new Error('permission update rejected') })
    const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:4096', client)

    await expect(adapter.promptSession(
      'session-1',
      [{ type: 'text', content: 'apply permissions' }],
      undefined,
      { permission: [{ permission: 'bash', pattern: '*', action: 'allow' }] },
    )).rejects.toThrow(/Failed to apply OpenCode session permissions: permission update rejected.*upgrade OpenCode/is)

    expect(client.session.update).toHaveBeenCalledTimes(1)
    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  it('preserves cancellation from the v1 session permission update', async () => {
    const abort = Object.assign(new Error('permission update aborted'), { name: 'AbortError' })
    const client = createClient(1, { sessionUpdateError: abort })
    const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:4096', client)

    await expect(adapter.promptSession(
      'session-1',
      [{ type: 'text', content: 'cancel permission update' }],
      undefined,
      { permission: [{ permission: 'bash', pattern: '*', action: 'allow' }] },
    )).rejects.toBe(abort)

    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  it('waits for an in-progress catalog reload while holding the same-session prompt lock', async () => {
    let finishReload: (() => void) | undefined
    const reloadGate = new Promise<void>(resolve => { finishReload = resolve })
    let markReloadStarted: (() => void) | undefined
    const reloadStarted = new Promise<void>(resolve => { markReloadStarted = resolve })
    const reload = withProviderCatalogReload(async () => {
      markReloadStarted?.()
      await reloadGate
    }, async () => undefined)
    await reloadStarted

    const client = createClient(80)
    const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:4096', client)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 250)
    const prompt = adapter.promptSession(
      'session-1',
      [{ type: 'text', content: 'wait for catalog reload' }],
      controller.signal,
    )

    try {
      await expect(adapter.promptSession('session-1', [{ type: 'text', content: 'duplicate' }]))
        .rejects.toThrow('already has a prompt in progress')
      expect(client.session.prompt).not.toHaveBeenCalled()
      finishReload?.()
      await expect(reload).resolves.toBeUndefined()
      await expect(prompt).resolves.toBe('completed after the short API timeout')
      expect(client.session.prompt).toHaveBeenCalledTimes(1)
    } finally {
      finishReload?.()
      clearTimeout(timer)
    }
  })

  it('releases prompt and catalog leases when signal setup fails synchronously', async () => {
    const client = createClient(1)
    const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:4096', client)

    await expect(adapter.promptSession(
      'session-1',
      [{ type: 'text', content: 'invalid signal' }],
      undefined,
      { signal: {} as AbortSignal },
    )).rejects.toThrow()

    await expect(withProviderCatalogReload(async () => {}, async () => 'reloaded'))
      .resolves.toBe('reloaded')
    await expect(adapter.promptSession('session-1', [{ type: 'text', content: 'retry same session' }]))
      .resolves.toBe('completed after the short API timeout')
  })
})
