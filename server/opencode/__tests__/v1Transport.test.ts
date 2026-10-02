import { describe, expect, it, vi } from 'vitest'
import { OpenCodeV1Transport, type OpenCodeV1Client } from '../v1Transport'
import type { GenericMessagePart } from '../types'

function transport(client: Record<string, unknown>): OpenCodeV1Transport {
  return new OpenCodeV1Transport('http://127.0.0.1:4096', client as unknown as OpenCodeV1Client)
}

function eventState() {
  return {
    parts: new Map<string, GenericMessagePart>(),
    finalized: new Set<string>(),
    roles: new Map<string, string>(),
  }
}

function stepFinishEvent(sessionId = 'session-1') {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'step-finish-1',
        sessionID: sessionId,
        messageID: 'assistant-1',
        type: 'step-finish',
        reason: 'stop',
      },
    },
  }
}

describe('OpenCode v1 transport direct behavior', () => {
  it('maps session and message responses and reports malformed SDK results', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        data: {
          id: 'session-1',
          slug: 'work',
          directory: '/workspace',
          time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
          title: 'Work session',
          version: 'v1',
        },
      })
      .mockResolvedValueOnce({})
    const update = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-1' } })
      .mockResolvedValueOnce({})
    const get = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-1', directory: '/workspace' } })
      .mockResolvedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ error: { response: { status: 404 } } })
      .mockResolvedValueOnce({})
    const list = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: 'session-1', directory: '/workspace' }] })
      .mockResolvedValueOnce({ data: null })
    const messages = vi.fn()
      .mockResolvedValueOnce({ data: [{ info: { id: 'message-1', role: 'assistant', time: { created: 1_700_000_000_000 } }, parts: [{ type: 'text', text: 'Hello' }] }] })
      .mockResolvedValueOnce({ data: {} })
    const client = {
      session: { create, update, get, list, messages },
    }
    const sdk = transport(client)

    await expect(sdk.createSession('/workspace', { permission: [{ permission: 'read', pattern: '*', action: 'allow' }] }))
      .resolves.toMatchObject({ id: 'session-1', directory: '/workspace', projectPath: '/workspace', slug: 'work', title: 'Work session' })
    expect(create).toHaveBeenCalledWith({
      directory: '/workspace',
      permission: [{ permission: 'read', pattern: '*', action: 'allow' }],
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    await expect(sdk.createSession('/workspace')).rejects.toThrow('no session payload')
    await expect(sdk.updateSession('session-1', '/workspace', { permission: [{ permission: 'write', pattern: 'src/**', action: 'deny' }] }))
      .resolves.toBeUndefined()
    expect(update).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: '/workspace',
      permission: [{ permission: 'write', pattern: 'src/**', action: 'deny' }],
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    await expect(sdk.updateSession('session-1', undefined, {})).rejects.toThrow('no updated session payload')
    await expect(sdk.getSession('session-1')).resolves.toMatchObject({ id: 'session-1', directory: '/workspace' })
    await expect(sdk.getSession('missing')).resolves.toBeNull()
    await expect(sdk.getSession('unavailable')).rejects.toThrow('HTTP 503')
    await expect(sdk.getSession('wrapped-missing')).resolves.toBeNull()
    await expect(sdk.getSession('empty')).rejects.toThrow('no session payload')
    await expect(sdk.listSessions()).resolves.toMatchObject([{ id: 'session-1', projectPath: '/workspace' }])
    await expect(sdk.listSessions()).resolves.toEqual([])
    await expect(sdk.getSessionMessages('session-1', '/workspace')).resolves.toMatchObject([
      { id: 'message-1', role: 'assistant', content: 'Hello', timestamp: '2023-11-14T22:13:20.000Z' },
    ])
    await expect(sdk.getSessionMessages('session-1')).resolves.toEqual([])
    expect(messages).toHaveBeenCalledWith({ sessionID: 'session-1', directory: '/workspace', limit: expect.any(Number) }, expect.any(Object))
  })

  it('partitions prompts, forwards request options, and rejects unconfirmed SDK responses', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce({ data: { info: { id: 'assistant-1', role: 'assistant' }, parts: [{ type: 'text', text: 'answer' }] } })
      .mockResolvedValueOnce({})
    const sdk = transport({ session: { prompt } })

    await expect(sdk.dispatchPrompt({
      sessionId: 'session-1',
      directory: '/workspace',
      model: { providerID: 'acme', modelID: 'model-1' },
      agent: 'build',
      variant: 'high',
      noReply: false,
      tools: { bash: false },
      system: 'option system',
      parts: [
        { type: 'system', content: ' part system ' },
        { type: 'text', content: 'first' },
        { type: 'file', content: '', mime: 'image/png', filename: 'screen.png', url: 'file:///workspace/screen.png' },
        { type: 'file', content: '', mime: 'text/plain', filename: 'notes.txt', url: 'file:///workspace/notes.txt' },
      ],
    })).resolves.toMatchObject({ kind: 'completed', message: { id: 'assistant-1', content: 'answer' } })
    expect(prompt).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: '/workspace',
      model: { providerID: 'acme', modelID: 'model-1' },
      agent: 'build',
      variant: 'high',
      system: 'option system\n\npart system',
      noReply: false,
      tools: { bash: false },
      parts: [
        { type: 'text', text: 'first' },
        { type: 'file', mime: 'image/png', filename: 'screen.png', url: 'file:///workspace/screen.png' },
      ],
    }, undefined)
    await expect(sdk.dispatchPrompt({ sessionId: 'session-1', parts: [] })).rejects.toThrow('no prompt response')
  })

  it('does not provide durable v1 logs', async () => {
    await expect(transport({}).readSessionLog('session-1')).rejects.toThrow('does not expose a durable session log')
  })

  it('checks health through SDK health, status fallback, and connected model discovery', async () => {
    const healthy = transport({
      global: { health: vi.fn(async () => ({ data: { version: 1.2 } })) },
      config: { providers: vi.fn(async () => ({ data: { providers: [
        null,
        { id: 'openai', models: { 'gpt-1': {}, 'gpt-2': {} } },
        { id: 'empty' },
        { models: { ignored: {} } },
      ] } })) },
    })
    await expect(healthy.checkHealth()).resolves.toMatchObject({
      available: true,
      protocol: 'v1',
      version: '1.2',
      models: ['openai/gpt-1', 'openai/gpt-2'],
    })

    const authentication = Object.assign(new Error('credentials rejected'), { statusCode: 401 })
    const authGlobal = { health: vi.fn(async () => { throw authentication }) }
    const authStatus = vi.fn()
    await expect(transport({
      global: authGlobal,
      session: { status: authStatus },
    }).checkHealth()).resolves.toMatchObject({ available: false, failureKind: 'authentication', error: 'credentials rejected' })
    expect(authStatus).not.toHaveBeenCalled()

    // Whether a password went out decides the wording of what to do next.
    const rejectingClient = { global: { health: vi.fn(async () => { throw authentication }) } } as unknown as OpenCodeV1Client
    await expect(new OpenCodeV1Transport('http://127.0.0.1:4096', rejectingClient, { Authorization: 'Basic x' }).checkHealth())
      .resolves.toMatchObject({ failureKind: 'authentication', credentialsSent: true })
    await expect(new OpenCodeV1Transport('http://127.0.0.1:4096', rejectingClient, {}).checkHealth())
      .resolves.toMatchObject({ failureKind: 'authentication', credentialsSent: false })

    const healthNetworkError = Object.assign(new Error('health endpoint unavailable'), { statusCode: 500 })
    const unsupported = Object.assign(new Error('v1 status route missing'), { statusCode: 404 })
    await expect(transport({
      global: { health: vi.fn(async () => { throw healthNetworkError }) },
      session: { status: vi.fn(async () => { throw unsupported }) },
    }).checkHealth()).resolves.toMatchObject({ available: false, failureKind: 'unsupported_protocol', error: 'v1 status route missing' })

    const reachable = transport({
      global: { health: vi.fn(async () => { throw healthNetworkError }) },
      session: { status: vi.fn(async () => ({ data: {} })) },
      config: { providers: vi.fn(async () => ({ data: { providers: [{ id: 'anthropic', models: { sonnet: {} } }] } })) },
    })
    await expect(reachable.checkHealth()).resolves.toMatchObject({ available: true, version: 'unknown', models: ['anthropic/sonnet'] })

    const modelAuthError = Object.assign(new Error('providers require authentication'), { statusCode: 403 })
    await expect(transport({
      global: { health: vi.fn(async () => ({ data: { version: 'ready' } })) },
      config: { providers: vi.fn(async () => { throw modelAuthError }) },
    }).checkHealth()).resolves.toMatchObject({ available: false, failureKind: 'authentication', version: 'ready' })

    const modelNetworkError = new Error('provider route failed')
    await expect(transport({
      global: { health: vi.fn(async () => ({ data: {} })) },
      config: { providers: vi.fn(async () => { throw modelNetworkError }) },
    }).checkHealth()).resolves.toMatchObject({ available: true, failureKind: 'model_discovery', error: expect.stringContaining('provider route failed') })
  })

  it('maps questions, permissions, and interrupt confirmations from v1 responses', async () => {
    const questionRows = [
      null,
      { id: 'missing-session', questions: [] },
      {
        id: 'question-1', sessionID: 'session-1',
        tool: { messageID: 'assistant-1', callID: 'call-1' },
        questions: [null, {}, { question: 'Choose', multiple: true, options: [null, { label: 'valid', value: 'v', description: 'description' }, { label: 'no value' }] }],
      },
      { id: 'question-2', sessionID: 'session-2', questions: [] },
    ]
    const questions = vi.fn(async (): Promise<{ data: unknown[] | null }> => ({ data: [] }))
      .mockResolvedValueOnce({ data: questionRows })
      .mockResolvedValueOnce({ data: questionRows })
      .mockResolvedValueOnce({ data: null })
    const reply = vi.fn()
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ data: false })
    const reject = vi.fn()
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ data: false })
    const permissionReply = vi.fn()
      .mockResolvedValueOnce({ data: { success: true } })
      .mockResolvedValueOnce({ data: null })
    const abort = vi.fn()
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ data: false, response: { status: 404 } })
      .mockRejectedValueOnce(Object.assign(new Error('already gone'), { response: { status: 404 } }))
      .mockRejectedValueOnce(new Error('server unavailable'))
    const sdk = transport({
      question: { list: questions, reply, reject },
      permission: { reply: permissionReply },
      session: { abort },
    })

    await expect(sdk.listPendingQuestions(undefined, 'session-1')).resolves.toMatchObject([
      { id: 'question-1', sessionID: 'session-1', tool: { messageID: 'assistant-1', callID: 'call-1' }, questions: [{ header: 'Question', options: [] }, { question: 'Choose', multiple: true, options: [{ label: 'valid', value: 'v', description: 'description' }, { label: 'no value' }] }] },
    ])
    await expect(sdk.listPendingQuestions('/project')).resolves.toHaveLength(2)
    await expect(sdk.listPendingQuestions()).resolves.toEqual([])
    expect(questions).toHaveBeenNthCalledWith(1, undefined, expect.any(Object))
    expect(questions).toHaveBeenNthCalledWith(2, { directory: '/project' }, expect.any(Object))
    await expect(sdk.replyQuestion('session-1', 'question-1', [['v']], '/workspace')).resolves.toBeUndefined()
    await expect(sdk.replyQuestion('session-1', 'question-1', [], '/workspace')).rejects.toThrow('did not confirm reply')
    await expect(sdk.rejectQuestion('session-1', 'question-1', '/workspace')).resolves.toBeUndefined()
    await expect(sdk.rejectQuestion('session-1', 'question-1', '/workspace')).rejects.toThrow('did not confirm rejection')
    await expect(sdk.replyPermission('session-1', 'permission-1', 'always')).resolves.toBeUndefined()
    await expect(sdk.replyPermission('session-1', 'permission-2', 'reject')).rejects.toThrow('did not confirm the permission reply')
    await expect(sdk.interruptSession('session-1', '/workspace')).resolves.toBe(true)
    await expect(sdk.interruptSession('missing')).resolves.toBe(true)
    await expect(sdk.interruptSession('gone')).resolves.toBe(true)
    await expect(sdk.interruptSession('unavailable')).resolves.toBe(false)
  })

  it('normalizes text parts and session events while suppressing duplicate or foreign updates', () => {
    const sdk = transport({})
    const state = eventState()
    const normalize = (type: string, properties?: Record<string, unknown>) => sdk.normalizeStreamEvent(
      { type, properties }, 'session-1', state.parts, state.finalized, state.roles,
    )

    expect(normalize('message.updated', { info: { id: 'user-message', role: 'user' } })).toBeNull()
    expect(normalize('message.part.updated', { part: { id: 'user-part', sessionID: 'session-1', messageID: 'user-message', type: 'text', text: 'hidden' } })).toBeNull()
    expect(normalize('message.part.updated', { part: { type: 'text' } })).toBeNull()
    expect(normalize('message.part.updated', { part: { id: 'text-1', sessionID: 'session-1', messageID: 'assistant-1', type: 'text', text: 'Hello' } }))
      .toMatchObject({ type: 'text', text: 'Hello', streaming: true, complete: false })
    expect(normalize('message.part.updated', { part: { id: 'text-1', sessionID: 'session-1', messageID: 'assistant-1', type: 'text', text: 'Hello' } })).toBeNull()
    expect(normalize('message.part.delta', { partID: 'text-1', delta: ' there' })).toMatchObject({ type: 'text', text: 'Hello there', delta: ' there' })
    expect(normalize('message.part.updated', { part: { id: 'text-1', sessionID: 'session-1', messageID: 'assistant-1', type: 'text', text: 'Hello there', time: { end: 4 } } }))
      .toMatchObject({ type: 'text', complete: true })
    expect(normalize('message.part.delta', { partID: 'text-1', delta: ' late' })).toBeNull()
    expect(normalize('message.part.removed', {})).toMatchObject({ type: 'part_removed', partId: undefined })
    expect(normalize('message.part.removed', { partID: 'text-1' })).toMatchObject({ type: 'part_removed', partId: 'text-1' })
    expect(normalize('message.part.delta', { partID: 'unknown', delta: 'ignored' })).toBeNull()
    expect(normalize('message.part.delta', { partID: 'unknown', delta: '' })).toBeNull()

    expect(normalize('session.status', { status: { type: 'retry', attempt: 2, message: 'retry', next: 10, action: { provider: 'acme', link: 'not a URL' } } }))
      .toMatchObject({ type: 'session_status', status: 'retry', attempt: 2, message: 'retry', next: 10, action: { provider: 'acme' } })
    expect(normalize('session.error', { error: 'plain failure' })).toMatchObject({ type: 'session_error', error: 'plain failure', details: 'plain failure' })
    expect(normalize('question.asked', { id: 'form-1', sessionID: 'session-1', questions: [{ question: 'Choose', options: [{ label: 'Yes', value: 'yes' }] }] }))
      .toMatchObject({ type: 'question', action: 'asked', requestId: 'form-1', questions: [{ question: 'Choose' }] })
    expect(normalize('question.asked', { id: 'incomplete' })).toBeNull()
    expect(normalize('question.replied', { requestID: 'form-1', answers: [['yes', 1], null] })).toMatchObject({ answers: [['yes']] })
    expect(normalize('question.rejected', {})).toMatchObject({ action: 'rejected', requestId: '' })
    expect(normalize('todo.updated', { todos: [null, { content: 'Implement', status: 'in_progress', priority: 'high' }, { content: 'Review' }] }))
      .toMatchObject({ type: 'todo', todos: [{ status: 'in_progress' }, { status: 'pending', priority: 'medium' }] })
    expect(normalize('todo.updated', { todos: [null, { content: 1 }] })).toBeNull()
    expect(normalize('permission.asked', { id: 'permission-1', permission: 'read', patterns: ['src/**', 1] }))
      .toMatchObject({ type: 'permission', action: 'asked', permissionId: 'permission-1', patterns: ['src/**'] })
    expect(normalize('permission.replied', { id: 'permission-1' })).toMatchObject({ action: 'replied' })
    expect(normalize('permission.updated', {})).toMatchObject({ action: 'updated', permissionId: '' })
    expect(normalize('file.edited', { file: '/workspace/file.ts' })).toMatchObject({ type: 'file_edited', file: '/workspace/file.ts' })
    expect(normalize('file.edited', {})).toBeNull()
    expect(normalize('unknown.event', {})).toBeNull()
  })

  it('scopes subscribed events to their session and suppresses repeated statuses', async () => {
    const event = vi.fn(async (_options: unknown) => ({
      stream: (async function* () {
        yield {
          payload: { type: 'workspace.ready', properties: { sessionID: 'session-1', name: 'workspace' } },
          directory: '/workspace',
        }
        yield { type: 'session.status', properties: { sessionID: 'other-session', status: { type: 'busy' } } }
        yield { type: 'server.connected', properties: {} }
        yield { type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'busy' } } }
        yield { type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'busy' } } }
        yield { type: 'session.idle', properties: { sessionID: 'session-1' } }
        yield { type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'idle' } } }
      })(),
    }))
    const sdk = transport({ global: { event } })
    const subscription = await sdk.subscribeToEvents('session-1', '/workspace')
    const emitted = []
    for await (const { event: normalized } of subscription.events) emitted.push(normalized)

    expect(emitted).toMatchObject([
      { type: 'debug_event', eventName: 'workspace.ready', summary: 'Workspace ready: workspace.' },
      { type: 'session_status', status: 'busy' },
      { type: 'done', sessionId: 'session-1' },
    ])
    expect(emitted).toHaveLength(3)
    expect(event).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect((event.mock.calls[0]?.[0] as { signal: AbortSignal }).signal.aborted).toBe(true)
  })

  it('synthesizes completion after a finished step when the stream ends or stalls', async () => {
    const ended = transport({
      global: {
        event: vi.fn(async () => ({ stream: (async function* () { yield stepFinishEvent() })() })),
      },
    })
    const completed = []
    const endedSubscription = await ended.subscribeToEvents('session-1', undefined, undefined, 100)
    for await (const { event } of endedSubscription.events) completed.push(event)
    expect(completed.map((event) => event?.type)).toEqual(['step', 'done'])

    const pendingNext = new Promise<IteratorResult<unknown>>(() => undefined)
    const returnIterator = vi.fn(async () => ({ done: true as const, value: undefined }))
    const rawIterator = {
      next: vi.fn()
        .mockResolvedValueOnce({ done: false, value: stepFinishEvent() })
        .mockReturnValue(pendingNext),
      return: returnIterator,
    }
    const stalled = transport({
      global: { event: vi.fn(async () => ({ stream: { [Symbol.asyncIterator]: () => rawIterator as unknown as AsyncIterator<never> } })) },
    })
    const stalledSubscription = await stalled.subscribeToEvents('session-1', undefined, undefined, 1)
    const stalledEvents = []
    for await (const { event } of stalledSubscription.events) stalledEvents.push(event)

    expect(stalledEvents.map((event) => event?.type)).toEqual(['step', 'done'])
    expect(returnIterator).toHaveBeenCalledOnce()
  })

  it('does not synthesize completion after the caller aborts the stream', async () => {
    const caller = new AbortController()
    const sdk = transport({
      global: {
        event: vi.fn(async () => ({
          stream: (async function* () {
            yield stepFinishEvent()
            yield { type: 'session.idle', properties: { sessionID: 'session-1' } }
          })(),
        })),
      },
    })
    const subscription = await sdk.subscribeToEvents('session-1', undefined, caller.signal, 100)
    const receivedEventTypes: string[] = []

    for await (const { event } of subscription.events) {
      if (event) receivedEventTypes.push(event.type)
      caller.abort()
    }
    expect(receivedEventTypes).toEqual(['step'])
  })

  it('summarizes tool and compact message parts without exposing unrelated event payloads', () => {
    const sdk = transport({})
    const common = { sessionID: 'session-1', messageID: 'assistant-1' }
    expect(sdk.mapPartUpdate({ ...common, id: 'tool-missing', type: 'tool' } as GenericMessagePart)).toBeNull()
    expect(sdk.mapPartUpdate({
      ...common,
      id: 'tool-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'pwd' },
        output: 'done',
        time: { start: 10, end: 14, compacted: 20 },
        attachments: [null, {}, { filename: 'screen.png', mime: 'image/png' }, { name: 'log.txt', mediaType: 'text/plain' }],
      },
    } as GenericMessagePart)).toMatchObject({ type: 'tool', durationMs: 4, compactedAt: 20, attachments: [{ filename: 'screen.png', mime: 'image/png' }, { filename: 'log.txt', mime: 'text/plain' }] })

    const summaries = [
      { type: 'file', source: { path: '/workspace/source.ts' } },
      { type: 'patch', hash: '1234567890abcdef', files: ['one.ts', 'two.ts', 'three.ts', 'four.ts', 'five.ts', 'six.ts', 'seven.ts', 1] },
      { type: 'snapshot', snapshot: '1234567890abcdefghijkl' },
      { type: 'agent' },
      { type: 'subtask', agent: 'reviewer', description: 'a'.repeat(170), command: 'check '.repeat(40) },
      { type: 'retry', attempt: 2, error: { data: { message: 'temporary issue' } } },
      { type: 'compaction', auto: true, overflow: true },
    ]
    const events = summaries.map((part, index) => sdk.mapPartUpdate({
      ...common,
      id: `compact-${index}`,
      ...part,
    } as GenericMessagePart))
    expect(events).toMatchObject([
      { type: 'part_summary', summary: 'File attached: /workspace/source.ts.' },
      { type: 'part_summary', severity: 'info', summary: expect.stringContaining('Patch prepared 1234567890ab: 7 files') },
      { type: 'part_summary', summary: 'Snapshot captured: 1234567890abcdef.' },
      { type: 'part_summary', summary: 'Agent context selected: agent.' },
      { type: 'part_summary', summary: expect.stringContaining('Subtask started for reviewer:') },
      { type: 'part_summary', severity: 'error', summary: 'Retry requested (attempt 2): temporary issue' },
      { type: 'part_summary', summary: 'Context compaction (auto) after context overflow.' },
    ])
  })
})
