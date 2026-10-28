import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantStreamEvent } from '@shared/assistant'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

const { mockGetOpenCodeAdapter, mockPrepareAssistantEvidence } = vi.hoisted(() => ({
  mockGetOpenCodeAdapter: vi.fn(),
  mockPrepareAssistantEvidence: vi.fn(async () => ({
    prompt: 'test evidence',
    permission: [{ permission: '*', pattern: '*', action: 'deny' as const }],
  })),
}))

vi.mock('../../opencode/factory', () => ({ getOpenCodeAdapter: mockGetOpenCodeAdapter }))
vi.mock('../../assistant/evidence', () => ({ prepareAssistantEvidence: mockPrepareAssistantEvidence }))

const previousConfigDir = process.env.LOOPTROOP_CONFIG_DIR
const configDir = makeTempDir('looptroop-chat-route-')
process.env.LOOPTROOP_CONFIG_DIR = configDir

const [{ APP_CONFIG_DIR, closeDatabase, db }, { initializeDatabase }, { appMeta, profiles }, { MockOpenCodeAdapter }, { chatRouter }, { createAssistantSession }] = await Promise.all([
  import('../../db/index'),
  import('../../db/init'),
  import('../../db/schema'),
  import('../../opencode/mockAdapter'),
  import('../chat'),
  import('../../assistant/sessions'),
])

const app = new Hono()
app.route('/api', chatRouter)
let adapter: InstanceType<typeof MockOpenCodeAdapter>

function configureProfile(): void {
  db.insert(profiles).values({ chatModel: 'provider/model', chatModelVariant: 'balanced' }).run()
}

function remoteSessionId(id: string): string {
  const row = db.select().from(appMeta).all().find(entry => entry.key === `assistant.session.${id}`)
  return JSON.parse(row!.value).openCodeSessionId as string
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function eventsFromSse(body: string): AssistantStreamEvent[] {
  return body.split(/\r?\n/).flatMap(line => line.startsWith('data: ')
    ? [JSON.parse(line.slice('data: '.length)) as AssistantStreamEvent]
    : [])
}

beforeEach(async () => {
  await rm(join(APP_CONFIG_DIR, 'assistant'), { recursive: true, force: true })
  initializeDatabase()
  db.delete(appMeta).run()
  db.delete(profiles).run()
  adapter = new MockOpenCodeAdapter()
  mockGetOpenCodeAdapter.mockReset().mockReturnValue(adapter)
  mockPrepareAssistantEvidence.mockReset().mockResolvedValue({
    prompt: 'test evidence',
    permission: [{ permission: '*', pattern: '*', action: 'deny' }],
  })
})

afterAll(() => {
  closeDatabase()
  if (previousConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
  else process.env.LOOPTROOP_CONFIG_DIR = previousConfigDir
  removeTempDir(configDir)
})

describe('chat session routes', () => {
  it('returns global history without a query and validates scoped list queries strictly', async () => {
    expect((await app.request('/api/chat/sessions')).status).toBe(200)
    expect((await app.request('/api/chat/sessions?scope=dashboard')).status).toBe(200)
    expect((await app.request('/api/chat/sessions?scope=dashboard&extra=yes')).status).toBe(400)
    expect((await app.request('/api/chat/sessions?mode=help')).status).toBe(400)
    expect((await app.request(`/api/chat/sessions?ticketId=${randomUUID()}&extra=${randomUUID()}`)).status).toBe(400)
    expect((await app.request(`/api/chat/sessions?ticketId=${randomUUID()}`)).status).toBe(404)
  })

  it('rejects invalid and extra create fields before opening an OpenCode session', async () => {
    configureProfile()
    const invalidBodies = [
      { mode: 'help' },
      { mode: 'tickets', ticketId: randomUUID() },
      { unexpected: true },
    ]
    for (const body of invalidBodies) {
      const response = await app.request('/api/chat/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(adapter.sessionCreateCalls).toHaveLength(0)
  })

  it('returns 400 for malformed JSON request bodies', async () => {
    const response = await app.request('/api/chat/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    })

    expect(response.status).toBe(400)
  })

  it('creates a conversation with the public saved-session fields', async () => {
    configureProfile()
    const response = await app.request('/api/chat/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const session = await response.json() as Record<string, unknown>
    expect(session).toMatchObject({ ticketId: null, saved: true, canResume: true, messages: [], archived: false })
    expect(session).not.toHaveProperty('mode')
  })

  it('renames a scoped conversation and rejects invalid title or scope fields', async () => {
    configureProfile()
    const session = await createAssistantSession({})
    const invalidBodies = [
      {},
      { title: '   ' },
      { title: 'x'.repeat(101) },
      { title: 'Valid title', unexpected: true },
    ]
    for (const body of invalidBodies) {
      const response = await app.request(`/api/chat/sessions/${session.id}/title`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }

    const wrongScope = await app.request(`/api/chat/sessions/${session.id}/title`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Wrong scope', ticketId: randomUUID() }),
    })
    expect(wrongScope.status).toBe(404)

    const response = await app.request(`/api/chat/sessions/${session.id}/title`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed conversation' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: session.id, title: 'Renamed conversation', archived: false })
  })

  it('does not cache chat history responses', async () => {
    const response = await app.request('/api/chat/sessions')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })

  it('validates message bodies and stale ticket scope before opening an SSE response', async () => {
    configureProfile()
    const session = await createAssistantSession({})
    const getSession = vi.spyOn(adapter, 'getSession')
    const getMessages = vi.spyOn(adapter, 'getSessionMessages')
    const invalidBodies = [
      {},
      { message: '   ' },
      { message: 'question', extra: true },
      { message: 'x'.repeat(20_001) },
      { mode: 'help', message: 'question' },
    ]
    for (const body of invalidBodies) {
      const response = await app.request(`/api/chat/sessions/${session.id}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }

    const staleScope = await app.request(`/api/chat/sessions/${session.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketId: randomUUID(), message: 'question' }),
    })
    expect(staleScope.status).toBe(404)
    expect(getSession).not.toHaveBeenCalled()
    expect(getMessages).not.toHaveBeenCalled()
    expect(adapter.promptCalls).toHaveLength(0)
  })

  it('streams text deltas followed by a done event', async () => {
    configureProfile()
    const session = await createAssistantSession({})
    const remoteId = remoteSessionId(session.id)
    adapter.mockStreamEvents.set(remoteId, [{
      type: 'reasoning', sessionId: remoteId, messageId: 'assistant', partId: 'thought',
      text: 'private thought', streaming: true, complete: false,
    }])
    const getMessages = vi.spyOn(adapter, 'getSessionMessages')
    const response = await app.request(`/api/chat/sessions/${session.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Explain the project' }),
    })
    const body = await response.text()
    const events = eventsFromSse(body)

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(events.slice(0, 2)).toEqual([
      { type: 'status', phase: 'preparing', modelId: 'provider/model', variant: 'balanced' },
      { type: 'status', phase: 'responding', modelId: 'provider/model', variant: 'balanced' },
    ])
    expect(events[2]).toEqual({ type: 'reasoning', text: 'private thought', streaming: true, modelId: 'provider/model', variant: 'balanced' })
    expect(events[3]).toMatchObject({ type: 'delta' })
    expect(events.at(-1)).toMatchObject({ type: 'done', session: { id: session.id } })
    expect(events.some(event => event.type === 'error')).toBe(false)
    expect(getMessages).toHaveBeenCalledTimes(2)
  })

  it('sends prompt failures as SSE error events', async () => {
    configureProfile()
    const session = await createAssistantSession({})
    adapter.promptSession = async () => { throw new Error('provider rejected request') }
    const response = await app.request(`/api/chat/sessions/${session.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Explain the project' }),
    })
    const events = eventsFromSse(await response.text())

    expect(response.status).toBe(200)
    expect(events).toEqual([
      { type: 'status', phase: 'preparing', modelId: 'provider/model', variant: 'balanced' },
      { type: 'status', phase: 'responding', modelId: 'provider/model', variant: 'balanced' },
      { type: 'error', error: 'provider rejected request' },
    ])
  })

  it('aborts an active prompt when the client disconnects from SSE', async () => {
    configureProfile()
    const session = await createAssistantSession({})
    const remoteId = remoteSessionId(session.id)
    const started = deferred<void>()
    const abortSession = vi.spyOn(adapter, 'abortSession')
    adapter.promptSession = async (_id, _parts, signal) => {
      started.resolve()
      return await new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason)
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const client = new AbortController()
    const request = new Request(`http://localhost/api/chat/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Cancel this answer' }),
      signal: client.signal,
    })
    const response = await app.fetch(request)
    const body = response.text()
    await started.promise
    client.abort(new DOMException('Client disconnected', 'AbortError'))
    await body

    expect(abortSession).toHaveBeenCalledWith(remoteId)
    expect(adapter.promptCalls).toHaveLength(0)
  })

  it('rejects stale temporary sessions before opening an SSE response', async () => {
    configureProfile()
    db.update(profiles).set({ saveChatSessions: false }).run()
    const session = await createAssistantSession({})
    const row = db.select().from(appMeta).all().find(entry => entry.key === `assistant.session.${session.id}`)!
    db.update(appMeta).set({ value: JSON.stringify({ ...JSON.parse(row.value), owner: 'previous-runtime' }) })
      .where(eq(appMeta.key, row.key)).run()

    const response = await app.request(`/api/chat/sessions/${session.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Question from an old runtime' }),
    })

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).not.toContain('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(adapter.promptCalls).toHaveLength(0)
  })
})
