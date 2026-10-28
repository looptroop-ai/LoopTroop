import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantScope } from '@shared/assistant'
import type { Message, StreamEvent } from '../../opencode/types'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

const { mockGetOpenCodeAdapter, mockPrepareAssistantEvidence } = vi.hoisted(() => ({
  mockGetOpenCodeAdapter: vi.fn(),
  mockPrepareAssistantEvidence: vi.fn<typeof import('../evidence').prepareAssistantEvidence>(async () => ({
    prompt: 'test evidence',
    permission: [{ permission: '*', pattern: '*', action: 'deny' as const }],
  })),
}))

vi.mock('../../opencode/factory', () => ({ getOpenCodeAdapter: mockGetOpenCodeAdapter }))
vi.mock('../evidence', () => ({ prepareAssistantEvidence: mockPrepareAssistantEvidence }))

const previousConfigDir = process.env.LOOPTROOP_CONFIG_DIR
const configDir = makeTempDir('looptroop-assistant-sessions-')
process.env.LOOPTROOP_CONFIG_DIR = configDir

const [{ APP_CONFIG_DIR, closeDatabase, db, sqlite }, { appMeta, profiles }, { MockOpenCodeAdapter }, integration, sessions] = await Promise.all([
  import('../../db/index'),
  import('../../db/schema'),
  import('../../opencode/mockAdapter'),
  import('../../test/integration'),
  import('../sessions'),
])

const { createTestRepoManager, createUninitializedTestTicket, resetTestDb } = integration
const repoManager = createTestRepoManager('assistant-sessions-')
let adapter: InstanceType<typeof MockOpenCodeAdapter>

function configureProfile(options: { chatModel?: string | null; chatModelVariant?: string | null; saveChatSessions?: boolean } = {}): void {
  db.insert(profiles).values({
    chatModel: options.chatModel === undefined ? 'provider/model' : options.chatModel,
    chatModelVariant: options.chatModelVariant ?? null,
    ...(options.saveChatSessions === undefined ? {} : { saveChatSessions: options.saveChatSessions }),
  }).run()
}

function makeTicketScope(): AssistantScope {
  const { ticket } = createUninitializedTestTicket(repoManager)
  return { ticketId: ticket.id }
}

function storedRecord(id: string): Record<string, unknown> | undefined {
  const row = db.select().from(appMeta).all().find(entry => entry.key === `assistant.session.${id}`)
  return row ? JSON.parse(row.value) as Record<string, unknown> : undefined
}

function remoteSessionId(id: string): string {
  return storedRecord(id)?.openCodeSessionId as string
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  vi.restoreAllMocks()
  await rm(join(APP_CONFIG_DIR, 'assistant'), { recursive: true, force: true })
  resetTestDb()
  db.delete(appMeta).run()
  adapter = new MockOpenCodeAdapter()
  mockGetOpenCodeAdapter.mockReset().mockReturnValue(adapter)
  mockPrepareAssistantEvidence.mockReset().mockResolvedValue({
    prompt: 'test evidence',
    permission: [{ permission: '*', pattern: '*', action: 'deny' }],
  })
})

afterAll(() => {
  closeDatabase()
  repoManager.cleanup()
  if (previousConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
  else process.env.LOOPTROOP_CONFIG_DIR = previousConfigDir
  removeTempDir(configDir)
})

describe('assistant session persistence', () => {
  it('uses the default saved-session setting from the real profile schema', async () => {
    configureProfile()

    expect(db.select().from(profiles).get()?.saveChatSessions).toBe(true)
    await expect(sessions.createAssistantSession({})).resolves.toMatchObject({
      ticketId: null, saved: true, canResume: true, messages: [],
    })
  })

  it('rejects missing chat models and unsupported cleanup before creating an OpenCode session', async () => {
    await expect(sessions.createAssistantSession({})).rejects.toMatchObject({ status: 409 })
    configureProfile({ chatModel: null })
    await expect(sessions.createAssistantSession({})).rejects.toMatchObject({ status: 409 })
    expect(adapter.sessionCreateCalls).toHaveLength(0)

    db.delete(profiles).run()
    configureProfile()
    Object.defineProperty(adapter, 'deleteSession', { value: undefined, configurable: true })
    await expect(sessions.createAssistantSession({})).rejects.toMatchObject({ status: 503 })
    expect(adapter.sessionCreateCalls).toHaveLength(0)
    expect(existsSync(join(APP_CONFIG_DIR, 'assistant'))).toBe(false)
  })

  it('removes the temporary workspace when OpenCode session creation fails', async () => {
    configureProfile({ saveChatSessions: false })
    adapter.mockSessionCreateFailures.push(new Error('OpenCode unavailable'))

    await expect(sessions.createAssistantSession({})).rejects.toThrow('OpenCode unavailable')
    expect(db.select().from(appMeta).all()).toEqual([])
    expect(await readdir(join(APP_CONFIG_DIR, 'assistant'))).toEqual([])
  })

  it('queues cleanup when a rejected remote session could not be deleted', async () => {
    configureProfile()
    const rejected = Object.assign(new Error('Permission confirmation failed'), { openCodeSessionId: 'ses-rejected' })
    adapter.mockSessionCreateFailures.push(new Error('OpenCode creation failed', { cause: rejected }))
    vi.spyOn(adapter, 'deleteSession').mockRejectedValue(new Error('OpenCode unavailable'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(sessions.createAssistantSession({})).rejects.toThrow('cleanup has been queued for retry')
    await vi.waitFor(() => expect(db.select().from(appMeta).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: expect.stringMatching(/^assistant\.cleanup\./), value: expect.stringContaining('ses-rejected') }),
    ])))
    await vi.waitFor(() => expect(warning).toHaveBeenCalled())
  })

  it.each([true, false])('removes a failed creation workspace and reports whether remote cleanup was queued (%s)', async (canQueue) => {
    configureProfile()
    sqlite.exec(`CREATE TEMP TRIGGER fail_assistant_save BEFORE INSERT ON app_meta
      WHEN NEW.key LIKE 'assistant.session.%' ${canQueue ? '' : "OR NEW.key LIKE 'assistant.cleanup.%'"}
      BEGIN SELECT RAISE(FAIL, 'Local save failed'); END`)
    vi.spyOn(adapter, 'deleteSession').mockRejectedValue(new Error('OpenCode offline'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await expect(sessions.createAssistantSession({})).rejects.toThrow(canQueue
        ? 'cleanup has been queued for retry'
        : 'cleanup could not be queued')
      expect(await readdir(join(APP_CONFIG_DIR, 'assistant'))).toEqual([])
      await vi.waitFor(() => expect(db.select().from(appMeta).all().filter(row => row.key.startsWith('assistant.cleanup.'))).toHaveLength(canQueue ? 1 : 0))
      if (canQueue) await vi.waitFor(() => expect(warning).toHaveBeenCalled())
    } finally {
      sqlite.exec('DROP TRIGGER fail_assistant_save')
    }
  })

  it('keeps Help unscoped and rejects invalid or stale ticket scopes', async () => {
    expect(() => sessions.assertAssistantScope({})).not.toThrow()
    expect(() => sessions.assertAssistantScope({ ticketId: randomUUID() })).toThrow(/Ticket not found/)
    await expect(sessions.listAssistantSessions({ ticketId: randomUUID() })).rejects.toMatchObject({ status: 404 })
  })

  it('lists all ticket conversations on the dashboard and filters the current ticket history', async () => {
    configureProfile({ saveChatSessions: true })
    const firstScope = makeTicketScope()
    const secondScope = makeTicketScope()
    const first = await sessions.createAssistantSession(firstScope)
    const second = await sessions.createAssistantSession(secondScope)
    const help = await sessions.createAssistantSession({})
    const helpRecord = storedRecord(help.id)
    if (!helpRecord) throw new Error('Test conversation metadata was not stored')
    db.update(appMeta).set({ value: JSON.stringify({ ...helpRecord, mode: 'help' }) })
      .where(eq(appMeta.key, `assistant.session.${help.id}`)).run()

    expect((await sessions.listAssistantSessions()).map(entry => entry.id).sort())
      .toEqual([first.id, second.id, help.id].sort())
    expect(await sessions.listAssistantSessions({})).toMatchObject([{ id: help.id, ticketId: null }])
    expect(await sessions.listAssistantSessions(firstScope)).toMatchObject([{ id: first.id, ticketId: firstScope.ticketId }])
    await expect(sessions.getAssistantSession(help.id, {})).resolves.toMatchObject({ id: help.id })
    await expect(sessions.getAssistantSession(help.id, firstScope)).rejects.toMatchObject({ status: 404 })
    await expect(sessions.promptAssistant(help.id, {}, 'Ask about docs and dashboard tickets', new AbortController().signal, () => undefined))
      .resolves.toMatchObject({ id: help.id })
    expect(mockPrepareAssistantEvidence).toHaveBeenLastCalledWith(
      {}, expect.any(String), expect.any(AbortSignal), expect.stringContaining('Ask about docs and dashboard tickets'),
    )
  })

  it('hides a session when its scope does not exactly match', async () => {
    configureProfile()
    const firstScope = makeTicketScope()
    const otherScope = makeTicketScope()
    const session = await sessions.createAssistantSession(firstScope)

    await expect(sessions.getAssistantSession(session.id, otherScope)).rejects.toMatchObject({ status: 404 })
    await expect(sessions.getAssistantSession(session.id, {})).rejects.toMatchObject({ status: 404 })
    await expect(sessions.getAssistantSession(`${session.id}-invalid`, firstScope)).rejects.toMatchObject({ status: 404 })
    await expect(sessions.getAssistantSession(randomUUID(), firstScope)).rejects.toMatchObject({ status: 404 })
    await expect(sessions.getAssistantSession(session.id, firstScope)).resolves.toMatchObject({ id: session.id })
  })

  it('isolates malformed session metadata instead of breaking other history', async () => {
    configureProfile()
    const valid = await sessions.createAssistantSession({})
    const corruptId = randomUUID()
    const corruptKey = `assistant.session.${corruptId}`
    db.insert(appMeta).values({ key: corruptKey, value: '{' }).run()

    await expect(sessions.listAssistantSessions({})).resolves.toMatchObject([{ id: valid.id }])
    await expect(sessions.getAssistantSession(corruptId, {})).rejects.toMatchObject({ status: 404 })
    expect(db.select().from(appMeta).all().some(row => row.key === corruptKey)).toBe(true)
  })

  it('binds a ticket conversation to the project that owned its ticket reference', async () => {
    configureProfile()
    const scope = makeTicketScope()
    const session = await sessions.createAssistantSession(scope)
    const record = storedRecord(session.id)
    if (!record) throw new Error('Test conversation metadata was not stored')
    expect(record.projectId).toBe(Number(scope.ticketId?.split(':')[0]))
    db.update(appMeta).set({ value: JSON.stringify({ ...record, projectId: Number(record.projectId) + 1 }) })
      .where(eq(appMeta.key, `assistant.session.${session.id}`)).run()

    await expect(sessions.getAssistantSession(session.id, scope)).rejects.toMatchObject({ status: 404 })
    await expect(sessions.listAssistantSessions(scope)).resolves.toEqual([])
  })

  it('cleans stale temporary sessions without listing or persisting their transcript', async () => {
    configureProfile({ saveChatSessions: false })
    const session = await sessions.createAssistantSession({})
    const remoteId = remoteSessionId(session.id)
    adapter.messages.set(remoteId, [{ id: randomUUID(), role: 'user', content: 'private temporary question' }])
    const record = storedRecord(session.id)!
    db.update(appMeta).set({ value: JSON.stringify({ ...record, owner: 'previous-runtime' }) })
      .where(eq(appMeta.key, `assistant.session.${session.id}`)).run()

    expect(await sessions.listAssistantSessions({})).toEqual([])
    await vi.waitFor(() => {
      expect(adapter.sessions.some(entry => entry.id === remoteId)).toBe(false)
      expect(storedRecord(session.id)).toBeUndefined()
    })
    expect(JSON.stringify(adapter.promptCalls)).not.toContain('private temporary question')
  })

  it('does not block saved history or creation on stale cleanup and retries a failed remote delete', async () => {
    configureProfile({ saveChatSessions: true })
    const saved = await sessions.createAssistantSession({})
    db.update(profiles).set({ saveChatSessions: false }).run()
    const stale = await sessions.createAssistantSession({})
    const remoteId = remoteSessionId(stale.id)
    const record = storedRecord(stale.id)!
    db.update(appMeta).set({ value: JSON.stringify({ ...record, owner: 'previous-runtime' }) })
      .where(eq(appMeta.key, `assistant.session.${stale.id}`)).run()

    const deletion = deferred<void>()
    const removeRemote = vi.spyOn(adapter, 'deleteSession').mockImplementation(() => deletion.promise)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect((await sessions.listAssistantSessions()).map(entry => entry.id)).toEqual([saved.id])
    await vi.waitFor(() => expect(removeRemote).toHaveBeenCalledWith(remoteId, expect.any(AbortSignal)))
    expect(storedRecord(stale.id)).toBeDefined()

    await expect(sessions.createAssistantSession({})).resolves.toMatchObject({ saved: false })
    expect(removeRemote).toHaveBeenCalledTimes(1)
    deletion.reject(new Error('Authorization: Bearer sensitive-token'))
    await vi.waitFor(() => expect(warning).toHaveBeenCalled())
    const warningText = warning.mock.calls.flat().join(' ')
    expect(warningText).toContain('[redacted]')
    expect(warningText).not.toContain('sensitive-token')
    expect(storedRecord(stale.id)).toBeDefined()

    removeRemote.mockResolvedValue()
    await vi.waitFor(async () => {
      await sessions.listAssistantSessions()
      expect(removeRemote).toHaveBeenCalledTimes(2)
      expect(storedRecord(stale.id)).toBeUndefined()
    })
  })

  it('keeps a current temporary conversation visible while its title and transcript stay out of app metadata', async () => {
    configureProfile({ saveChatSessions: false })
    const session = await sessions.createAssistantSession({})
    const remoteId = remoteSessionId(session.id)

    await sessions.promptAssistant(session.id, {}, 'Private temporary title', new AbortController().signal, () => undefined)

    expect(await sessions.listAssistantSessions({})).toMatchObject([{ id: session.id, title: 'Private temporary title' }])
    expect(storedRecord(session.id)).toMatchObject({ saved: false, title: 'New chat' })
    expect(JSON.stringify(storedRecord(session.id))).not.toContain('Private temporary title')
    expect(adapter.messages.get(remoteId)?.some(message => message.content === 'Private temporary title')).toBe(true)
  })

  it('expires a stale temporary session when it is opened directly', async () => {
    configureProfile({ saveChatSessions: false })
    const session = await sessions.createAssistantSession({})
    const record = storedRecord(session.id)!
    db.update(appMeta).set({ value: JSON.stringify({ ...record, owner: 'previous-runtime' }) })
      .where(eq(appMeta.key, `assistant.session.${session.id}`)).run()

    await expect(sessions.getAssistantSession(session.id, {})).rejects.toMatchObject({ status: 404 })
    expect(storedRecord(session.id)).toBeUndefined()
    expect(adapter.sessions.some(entry => entry.id === remoteSessionId(session.id))).toBe(false)
  })

  it('keeps remote saved sessions when closing and archives their metadata', async () => {
    configureProfile({ saveChatSessions: true })
    const session = await sessions.createAssistantSession({})
    const remoteId = remoteSessionId(session.id)
    const directory = join(APP_CONFIG_DIR, 'assistant', session.id)
    const removeRemote = vi.spyOn(adapter, 'deleteSession')

    await sessions.closeAssistantSession(session.id, {})

    expect(storedRecord(session.id)).toMatchObject({ saved: true, archived: true })
    expect(adapter.sessions.some(entry => entry.id === remoteId)).toBe(true)
    expect(removeRemote).not.toHaveBeenCalled()
    expect(existsSync(directory)).toBe(false)
    await sessions.getAssistantSession(session.id, {})
    expect(existsSync(directory)).toBe(false)
  })

  it('archives an idle saved conversation while OpenCode is unavailable', async () => {
    configureProfile({ saveChatSessions: true })
    const session = await sessions.createAssistantSession({})
    const abort = vi.spyOn(adapter, 'abortSession').mockRejectedValue(new Error('OpenCode is offline'))

    await expect(sessions.closeAssistantSession(session.id, {})).resolves.toBeUndefined()
    expect(abort).not.toHaveBeenCalled()
    expect(storedRecord(session.id)).toMatchObject({ saved: true, archived: true })
  })

  it('retains temporary metadata after a remote delete failure so close can be retried', async () => {
    configureProfile({ saveChatSessions: false })
    const session = await sessions.createAssistantSession({})
    const directory = join(APP_CONFIG_DIR, 'assistant', session.id)
    const removeRemote = vi.spyOn(adapter, 'deleteSession')
      .mockRejectedValueOnce(new Error('remote unavailable'))
      .mockResolvedValueOnce()

    await expect(sessions.closeAssistantSession(session.id, {})).rejects.toThrow('remote unavailable')
    expect(storedRecord(session.id)).toBeDefined()
    expect(existsSync(directory)).toBe(true)

    await sessions.closeAssistantSession(session.id, {})
    expect(removeRemote).toHaveBeenCalledTimes(2)
    expect(storedRecord(session.id)).toBeUndefined()
    expect(existsSync(directory)).toBe(false)
  })

  it('retires a confirmed missing OpenCode session without reading messages', async () => {
    configureProfile()
    const session = await sessions.createAssistantSession({})
    const getMessages = vi.spyOn(adapter, 'getSessionMessages')
    vi.spyOn(adapter, 'getSession').mockResolvedValue(null)

    await expect(sessions.getAssistantSession(session.id, {})).resolves.toMatchObject({
      id: session.id, canResume: false, messages: [],
    })
    expect(getMessages).not.toHaveBeenCalled()
    expect(storedRecord(session.id)).toBeUndefined()
    expect(await sessions.listAssistantSessions({})).toEqual([])
  })

  it('keeps saved metadata when OpenCode session lookup fails without a confirmed 404', async () => {
    configureProfile()
    const session = await sessions.createAssistantSession({})
    vi.spyOn(adapter, 'getSession').mockRejectedValue(new Error('OpenCode is offline'))

    await expect(sessions.getAssistantSession(session.id, {})).rejects.toThrow('OpenCode is offline')
    expect(storedRecord(session.id)).toBeDefined()
  })

  it('extracts only visible user and assistant text from OpenCode messages', () => {
    const messages: Message[] = [
      {
        id: 'user-message', info: { id: 'user-message', sessionID: 'session', role: 'user', time: { created: 1_000 } },
        parts: [
          { id: 'visible', sessionID: 'session', messageID: 'user-message', type: 'text', text: 'question' },
          { id: 'synthetic', sessionID: 'session', messageID: 'user-message', type: 'text', text: 'synthetic', synthetic: true },
          { id: 'ignored', sessionID: 'session', messageID: 'user-message', type: 'text', text: 'ignored', ignored: true },
          { id: 'reasoning', sessionID: 'session', messageID: 'user-message', type: 'reasoning', text: 'private reasoning' },
        ],
      },
      {
        id: 'assistant-message', role: 'assistant', timestamp: '2026-01-01T00:00:00.000Z',
        parts: [
          { id: 'answer-1', sessionID: 'session', messageID: 'assistant-message', type: 'text', text: 'answer' },
          { id: 'answer-2', sessionID: 'session', messageID: 'assistant-message', type: 'text', text: 'details' },
          { id: 'reasoning-2', sessionID: 'session', messageID: 'assistant-message', type: 'reasoning', text: 'hidden thoughts' },
        ],
      },
      { id: 'system-message', role: 'system', content: 'not visible' },
      { id: 'empty-message', role: 'assistant', parts: [{ id: 'empty', sessionID: 'session', messageID: 'empty-message', type: 'text', text: '  ' }] },
      { id: 'raw-message', role: 'assistant', content: '[config](https://example.test/docs?page=2#assistant) Authorization: Bearer abc.def' },
    ]

    expect(sessions.assistantMessages(messages)).toEqual([
      { id: 'user-message', role: 'user', content: 'question', createdAt: new Date(1_000).toISOString() },
      { id: 'assistant-message', role: 'assistant', content: 'answer\ndetails', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'raw-message', role: 'assistant', content: '[config](https://example.test/docs?page=2#assistant) Authorization: Bearer [redacted]', createdAt: '' },
    ])
  })
})

describe('assistant prompts', () => {
  it('keeps source citations from the previous answer available to follow-up selection', async () => {
    configureProfile()
    const session = await sessions.createAssistantSession({})
    const path = 'server/workflow/questionWindows.ts'
    adapter.messages.set(remoteSessionId(session.id), [{
      id: 'previous-answer', role: 'assistant', content: `See https://github.com/looptroop-ai/LoopTroop/blob/main/${path}#L20`,
    }])

    await sessions.promptAssistant(session.id, {}, 'Explain that line', new AbortController().signal, () => undefined)

    expect(mockPrepareAssistantEvidence).toHaveBeenCalledWith(
      {}, expect.any(String), expect.any(AbortSignal), expect.stringContaining(path),
    )
    const questionContext = mockPrepareAssistantEvidence.mock.lastCall?.[3] ?? ''
    expect(questionContext).not.toContain('Current question:')
    expect(questionContext).not.toContain('Earlier reply:')
  })

  it('returns the streamed answer when OpenCode loses the conversation after finishing', async () => {
    configureProfile()
    const session = await sessions.createAssistantSession({})
    adapter.promptSession = async (remoteId, _parts, _signal, options) => {
      options?.onEvent?.({ type: 'text', sessionId: remoteId, messageId: 'answer', partId: 'body', text: 'Completed answer', delta: 'Completed answer', streaming: false, complete: true })
      adapter.sessions = adapter.sessions.filter(item => item.id !== remoteId)
      return 'Completed answer'
    }
    const deltas: string[] = []

    const result = await sessions.promptAssistant(session.id, {}, 'Question', new AbortController().signal, delta => deltas.push(delta))

    expect(deltas).toEqual(['Completed answer'])
    expect(result).toMatchObject({ canResume: false, messages: [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Completed answer' },
    ] })
    expect(storedRecord(session.id)).toBeUndefined()
  })

  it('uses the configured model and variant with read-only permissions and no auto-approval', async () => {
    configureProfile({ chatModelVariant: 'balanced', saveChatSessions: true })
    const session = await sessions.createAssistantSession({})
    const createPermissions = adapter.sessionCreateCalls[0]?.options?.permission ?? []
    const expectedPrefix = `${adapter.sessionCreateCalls[0]?.projectPath?.replaceAll('\\', '/')}/evidence/`
    expect(createPermissions[0]).toEqual({ permission: '*', pattern: '*', action: 'deny' })
    expect(createPermissions).toContainEqual({ permission: 'read', pattern: `${expectedPrefix}**`, action: 'allow' })
    expect(createPermissions).toContainEqual({ permission: 'read', pattern: 'evidence/**', action: 'allow' })
    expect(createPermissions).toContainEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
    expect(createPermissions).not.toContainEqual({ permission: 'read', pattern: '*', action: 'allow' })

    const answer = await sessions.promptAssistant(session.id, {}, 'Explain the configuration', new AbortController().signal, () => undefined)
    const options = adapter.promptCalls[0]?.options
    expect(answer.title).toBe('Explain the configuration')
    expect(options).toMatchObject({
      modelRef: 'provider/model', variant: 'balanced', autoApprovePermissions: false,
      permission: [{ permission: '*', pattern: '*', action: 'deny' }],
    })
    expect(options?.system).toContain('never approve plans, edit files, run shell commands, or control tickets')
    expect(mockPrepareAssistantEvidence).toHaveBeenCalledWith(
      {}, expect.stringContaining(session.id), expect.any(AbortSignal), expect.stringContaining('Explain the configuration'),
    )
  })

  it('gives evidence preparation and the answer separate deadlines', async () => {
    configureProfile()
    const session = await sessions.createAssistantSession({})
    const preparationStarted = deferred<void>()
    const preparationRelease = deferred<void>()
    const prepDeadline = new AbortController()
    const answerDeadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(prepDeadline.signal)
      .mockReturnValueOnce(answerDeadline.signal)
    mockPrepareAssistantEvidence.mockImplementation(async (_scope, _directory, _signal, question) => {
      preparationStarted.resolve()
      await preparationRelease.promise
      expect(question).toContain('Find the login flow')
      return { prompt: 'test evidence', permission: [{ permission: '*', pattern: '*', action: 'deny' }] }
    })
    const prompt = sessions.promptAssistant(session.id, {}, 'Find the login flow', new AbortController().signal, () => undefined)
    await preparationStarted.promise

    expect(timeout).toHaveBeenCalledTimes(1)
    preparationRelease.resolve()
    await expect(prompt).resolves.toMatchObject({ id: session.id })
    expect(timeout).toHaveBeenNthCalledWith(1, 180_000)
    expect(timeout).toHaveBeenNthCalledWith(2, 180_000)
  })

  it('rejects a missing remote session and releases the session lock', async () => {
    configureProfile()
    const session = await sessions.createAssistantSession({})
    const remoteId = remoteSessionId(session.id)
    vi.spyOn(adapter, 'getSession').mockResolvedValue(null)
    const signal = new AbortController().signal

    await expect(sessions.promptAssistant(session.id, {}, 'Question', signal, () => undefined))
      .rejects.toMatchObject({ status: 409 })
    vi.spyOn(adapter, 'getSession').mockResolvedValue({ id: remoteId })
    await expect(sessions.promptAssistant(session.id, {}, 'Try again', signal, () => undefined))
      .resolves.toMatchObject({ id: session.id })
  })

  it('does not read history or prompt while a previous remote answer may still be running', async () => {
    configureProfile()
    const session = await sessions.createAssistantSession({})
    const getMessages = vi.spyOn(adapter, 'getSessionMessages')
    const stop = vi.spyOn(adapter, 'abortSession').mockResolvedValue(false)

    await expect(sessions.promptAssistant(session.id, {}, 'Question', new AbortController().signal, () => undefined))
      .rejects.toMatchObject({ status: 503 })
    expect(getMessages).not.toHaveBeenCalled()
    expect(adapter.promptCalls).toHaveLength(0)
    stop.mockResolvedValue(true)
  })

  it('deduplicates cumulative text snapshots and ignores reasoning events', async () => {
    configureProfile()
    const session = await sessions.createAssistantSession({})
    const remoteId = remoteSessionId(session.id)
    const event = (fields: Partial<Extract<StreamEvent, { type: 'text' }>>): StreamEvent => ({
      type: 'text', sessionId: remoteId, messageId: 'assistant', partId: 'answer', text: '', streaming: true, complete: false, ...fields,
    })
    adapter.mockStreamEvents.set(remoteId, [
      { type: 'reasoning', sessionId: remoteId, messageId: 'assistant', partId: 'thought', text: 'hidden', streaming: true, complete: false },
      event({ text: 'Hello', delta: 'Hello' }),
      event({ text: 'Hello' }),
      event({ text: 'Hello world' }),
      event({ text: 'Hello world!', delta: '!' }),
      event({ partId: 'answer-2', text: 'Found it.', delta: 'Found it.' }),
    ])
    adapter.mockResponses.set(remoteId, '')
    const emitted: string[] = []

    await sessions.promptAssistant(session.id, {}, 'Question', new AbortController().signal, text => emitted.push(text))

    expect(emitted).toEqual(['Hello', ' world', '!', '\n', 'Found it.'])
    expect(emitted.join('')).toBe('Hello world!\nFound it.')
  })

  it('rejects a second prompt for a conversation while the first answer is running', async () => {
    configureProfile()
    const session = await sessions.createAssistantSession({})
    const started = deferred<void>()
    adapter.promptSession = async (_id, _parts, signal) => {
      started.resolve()
      return await new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason)
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const first = sessions.promptAssistant(session.id, {}, 'First', new AbortController().signal, () => undefined)
      .then(() => undefined, error => error)
    await started.promise

    await expect(sessions.promptAssistant(session.id, {}, 'Second', new AbortController().signal, () => undefined))
      .rejects.toMatchObject({ status: 409 })
    await expect(sessions.closeAssistantSession(session.id, {})).resolves.toBeUndefined()
    expect(await first).toMatchObject({ name: 'AbortError' })
  })

  it('does not resurrect a temporary session or its directory when close aborts an active prompt', async () => {
    configureProfile({ saveChatSessions: false })
    const session = await sessions.createAssistantSession({})
    const directory = join(APP_CONFIG_DIR, 'assistant', session.id)
    const started = deferred<void>()
    adapter.promptSession = async (_id, _parts, signal) => {
      started.resolve()
      return await new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason)
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const answer = sessions.promptAssistant(session.id, {}, 'Do not retain this', new AbortController().signal, () => undefined)
      .then(() => undefined, error => error)
    await started.promise

    await sessions.closeAssistantSession(session.id, {})
    expect(await answer).toMatchObject({ name: 'AbortError' })
    expect(storedRecord(session.id)).toBeUndefined()
    expect(existsSync(directory)).toBe(false)
  })

  it('aborts a prompt when its timeout signal fires and clears the busy state', async () => {
    configureProfile()
    const session = await sessions.createAssistantSession({})
    const remoteId = remoteSessionId(session.id)
    const prepTimeout = new AbortController()
    const answerTimeout = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(prepTimeout.signal).mockReturnValueOnce(answerTimeout.signal)
    const abortSession = vi.spyOn(adapter, 'abortSession')
    const started = deferred<void>()
    adapter.promptSession = async (_id, _parts, signal) => {
      started.resolve()
      return await new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason)
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const prompt = sessions.promptAssistant(session.id, {}, 'Wait', new AbortController().signal, () => undefined)
      .then(() => undefined, error => error)
    await started.promise
    answerTimeout.abort(new DOMException('Prompt timed out', 'TimeoutError'))

    expect(await prompt).toMatchObject({ name: 'TimeoutError' })
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 180_000)
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 180_000)
    expect(abortSession).toHaveBeenCalledWith(remoteId)
    timeoutSpy.mockRestore()
    adapter.promptSession = async () => 'retry response'
    await expect(sessions.promptAssistant(session.id, {}, 'Retry', new AbortController().signal, () => undefined))
      .resolves.toMatchObject({ id: session.id })
  })

  it('preserves the session when OpenCode cannot confirm an active prompt stopped', async () => {
    configureProfile({ saveChatSessions: true })
    const session = await sessions.createAssistantSession({})
    const started = deferred<void>()
    adapter.promptSession = async (_id, _parts, signal) => {
      started.resolve()
      return await new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason)
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const stop = vi.spyOn(adapter, 'abortSession').mockResolvedValueOnce(true).mockResolvedValue(false)
    const prompt = sessions.promptAssistant(session.id, {}, 'Question', new AbortController().signal, () => undefined)
      .then(() => undefined, error => error)
    await started.promise

    await expect(sessions.closeAssistantSession(session.id, {})).rejects.toMatchObject({ status: 503 })
    expect(await prompt).toMatchObject({ name: 'AbortError' })
    expect(storedRecord(session.id)).toMatchObject({ archived: false, saved: true })
    await expect(sessions.closeAssistantSession(session.id, {})).rejects.toMatchObject({ status: 503 })
    expect(storedRecord(session.id)).toMatchObject({ archived: false, saved: true })
    stop.mockResolvedValue(true)
    await sessions.closeAssistantSession(session.id, {})
    expect(storedRecord(session.id)).toMatchObject({ archived: true })
  })

  it('confirms an older runtime has stopped before archiving its saved conversation', async () => {
    configureProfile()
    const session = await sessions.createAssistantSession({})
    const row = db.select().from(appMeta).all().find(entry => entry.key === `assistant.session.${session.id}`)
    if (!row) throw new Error('Test conversation metadata was not stored')
    db.update(appMeta).set({ value: JSON.stringify({ ...JSON.parse(row.value), owner: 'previous-runtime' }) })
      .where(eq(appMeta.key, row.key)).run()
    const stop = vi.spyOn(adapter, 'abortSession').mockResolvedValue(false)

    await expect(sessions.closeAssistantSession(session.id, {})).rejects.toMatchObject({ status: 503 })
    expect(storedRecord(session.id)).toMatchObject({ archived: false })
    stop.mockResolvedValue(true)
    await sessions.closeAssistantSession(session.id, {})
    expect(stop).toHaveBeenCalledWith(remoteSessionId(session.id))
    expect(storedRecord(session.id)).toMatchObject({ archived: true })
  })
})
