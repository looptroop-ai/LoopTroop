import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { patchTicket } from '../../storage/tickets'
import { TEST } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { buildFormattedBatchAnswers } from '../phases/interviewPhase'
import { OpenCodeSDKAdapter, type OpenCodeAdapter } from '../../opencode/adapter'
import { OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS } from '../../opencode/permissions'
import type {
  HealthStatus,
  Message,
  MessageInfo,
  OpenCodeQuestionAnswer,
  OpenCodeQuestionRequest,
  OpenCodeSessionCreateOptions,
  PromptPart,
  PromptSessionOptions,
  Session,
  StreamEvent,
} from '../../opencode/types'
import { deliberateInterview } from '../../phases/interview/deliberate'
import {
  SILENT_DEFAULT_PERMISSIONS,
  SILENT_DISABLED_PERMISSIONS,
  SILENT_EXECUTION_SETUP_ONLINE_PERMISSIONS,
  SILENT_READ_ONLY_PERMISSIONS,
} from '../../opencode/toolPolicy'
import {
  runOpenCodePrompt,
  runOpenCodeSessionPrompt,
  type OpenCodePromptDispatchEvent,
} from '../runOpenCodePrompt'
import { listOpenCodeSessionsForTicket } from '../../opencode/sessionManager'
import {
  clearAllPendingSessionContinuationsForTests,
  requestSessionContinuation,
} from '../../opencode/sessionContinuation'
import { WorkflowDeadlineTimeoutError } from '../../lib/deadlineErrors'
import { removeTempDir } from '../../test/tempDir'

type OpenCodeSDKClient = NonNullable<ConstructorParameters<typeof OpenCodeSDKAdapter>[1]>

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class TestOpenCodeAdapter implements OpenCodeAdapter {
  private readonly queuedResponses: Array<
    | string
    | Deferred<string>
    | Error
    | {
        response: string | Deferred<string>
        messageContent?: string
        messageInfo?: Partial<MessageInfo>
        streamEvents?: StreamEvent[]
      }
  >
  private readonly sessionMessages = new Map<string, Message[]>()
  public readonly sessionCreateCalls: Array<{
    projectPath: string
    signal?: AbortSignal
    options?: OpenCodeSessionCreateOptions
  }> = []
  public readonly promptCalls: Array<{
    sessionId: string
    parts: PromptPart[]
    options?: PromptSessionOptions
  }> = []
  public readonly abortCalls: string[] = []
  public listSessionsCalls = 0
  public healthCalls = 0
  private readonly sessions: Session[] = []
  private sessionCounter = 0

  constructor(responses: Array<
    | string
    | Deferred<string>
    | Error
    | {
        response: string | Deferred<string>
        messageContent?: string
        messageInfo?: Partial<MessageInfo>
        streamEvents?: StreamEvent[]
      }
  >, private readonly options: {
    listSessions?: () => Session[]
    createFailures?: Error[]
    healthStatus?: HealthStatus
  } = {}) {
    this.queuedResponses = [...responses]
  }

  async createSession(
    projectPath: string,
    signal?: AbortSignal,
    options?: OpenCodeSessionCreateOptions,
  ): Promise<Session> {
    this.sessionCreateCalls.push({ projectPath, signal, options })
    const failure = this.options.createFailures?.shift()
    if (failure) throw failure
    this.sessionCounter += 1
    const session = {
      id: `ses-${this.sessionCounter}`,
      projectPath,
    }
    this.sessions.push(session)
    return session
  }

  async promptSession(
    sessionId: string,
    _parts: PromptPart[],
    _signal?: AbortSignal,
    options?: PromptSessionOptions,
  ): Promise<string> {
    this.promptCalls.push({ sessionId, parts: _parts, options })
    const queued = this.queuedResponses.shift() ?? 'assistant response'
    if (queued instanceof Error) {
      throw queued
    }
    const queuedResponse = typeof queued === 'object' && 'response' in queued
      ? queued.response
      : queued
    const signal = options?.signal ?? _signal
    const streamEvents = typeof queued === 'object' && 'response' in queued && Array.isArray(queued.streamEvents)
      ? queued.streamEvents
      : []
    const messageInfo = typeof queued === 'object' && 'response' in queued
      ? queued.messageInfo
      : undefined
    for (const event of streamEvents) {
      options?.onEvent?.(event)
    }
    const response = typeof queuedResponse === 'string'
      ? queuedResponse
      : signal
        ? await Promise.race([
            queuedResponse.promise,
            new Promise<string>((_, reject) => {
              if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
              signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
            }),
          ])
        : await queuedResponse.promise
    const messageContent = typeof queued === 'object' && 'response' in queued && typeof queued.messageContent === 'string'
      ? queued.messageContent
      : response
    const assistantMessageId = typeof messageInfo?.id === 'string'
      ? messageInfo.id
      : `msg-${sessionId}-${this.sessionMessages.size + 1}`

    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: messageContent,
      timestamp: new Date().toISOString(),
      ...(messageInfo
        ? {
            info: {
              id: assistantMessageId,
              sessionID: sessionId,
              role: 'assistant',
              ...messageInfo,
            },
          }
        : {}),
    }
    this.sessionMessages.set(sessionId, [assistantMessage])

    options?.onEvent?.({
      type: 'text',
      sessionId,
      messageId: assistantMessage.id,
      partId: `part-${assistantMessage.id}`,
      text: response,
      streaming: false,
      complete: true,
    })
    options?.onEvent?.({
      type: 'done',
      sessionId,
    })

    return response
  }

  async listSessions(): Promise<Session[]> {
    this.listSessionsCalls += 1
    return this.options.listSessions?.() ?? this.sessions
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.sessions.find((session) => session.id === sessionId) ?? null
  }

  async getSessionMessages(sessionId: string): Promise<Message[]> {
    return this.sessionMessages.get(sessionId) ?? []
  }

  async listPendingQuestions(): Promise<OpenCodeQuestionRequest[]> {
    return []
  }

  async replyQuestion(_requestId: string, _answers: OpenCodeQuestionAnswer[]): Promise<void> {
    return undefined
  }

  async rejectQuestion(_requestId: string): Promise<void> {
    return undefined
  }

  async *subscribeToEvents(sessionId: string, _signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    yield { type: 'done', sessionId }
  }

  async abortSession(sessionId: string): Promise<boolean> {
    this.abortCalls.push(sessionId)
    return true
  }

  async assembleBeadContext(_ticketId: string, _beadId: string): Promise<PromptPart[]> {
    return []
  }

  async assembleCouncilContext(_ticketId: string, _phase: string): Promise<PromptPart[]> {
    return []
  }

  async checkHealth(): Promise<HealthStatus> {
    this.healthCalls += 1
    return this.options.healthStatus ?? { available: true }
  }
}

describe('runOpenCodePrompt', () => {
  const repoManager = createTestRepoManager('run-opencode-prompt-')

  afterAll(() => {
    clearAllPendingSessionContinuationsForTests()
    resetTestDb()
    repoManager.cleanup()
  })

  function createFakeSdkClient(overrides: {
    create?: (...args: unknown[]) => Promise<unknown>
    update?: (...args: unknown[]) => Promise<unknown>
    prompt?: (...args: unknown[]) => Promise<unknown>
    permissionReply?: (...args: unknown[]) => Promise<unknown>
    abort?: (...args: unknown[]) => Promise<unknown>
    list?: (...args: unknown[]) => Promise<unknown>
    messages?: (...args: unknown[]) => Promise<unknown>
    subscribe?: (...args: unknown[]) => Promise<{ stream: AsyncIterable<unknown> }>
    eventSubscribe?: (...args: unknown[]) => Promise<{ stream: AsyncIterable<unknown> }>
    globalEvent?: (...args: unknown[]) => Promise<{ stream: AsyncIterable<unknown> }>
    get?: (...args: unknown[]) => Promise<unknown>
  } = {}) {
    const defaultSubscribe = async () => ({
      stream: (async function* () {
        yield { type: 'session.idle', properties: { info: { id: 'ses-1' } } }
      })(),
    })
    const eventSubscribe = overrides.eventSubscribe ?? overrides.subscribe ?? defaultSubscribe
    const globalEvent = overrides.globalEvent ?? overrides.subscribe ?? defaultSubscribe
    return {
      session: {
        create: overrides.create ?? (async () => ({ data: { id: 'ses-1', directory: '/tmp/project' } })),
        update: overrides.update ?? (async () => ({ data: { id: 'ses-1', directory: '/tmp/project' } })),
        list: overrides.list ?? (async () => ({ data: [] })),
        prompt: overrides.prompt ?? (async () => ({ data: { parts: [] } })),
        messages: overrides.messages ?? (async () => ({ data: [] })),
        abort: overrides.abort ?? (async () => ({ data: {} })),
        get: overrides.get ?? (async () => ({ data: { directory: '/tmp/project' } })),
      },
      permission: {
        reply: overrides.permissionReply ?? (async () => ({ data: true })),
      },
      event: {
        subscribe: eventSubscribe,
      },
      global: {
        health: async () => ({ data: { version: 'test' } }),
        event: globalEvent,
      },
      config: {
        providers: async () => ({ data: { providers: [] } }),
      },
    }
  }

  it('passes session-scoped allow-all permissions to the SDK when requested', async () => {
    const sessionCreate = createFakeSdkClient({
      create: async (...args: unknown[]) => {
        expect(args[0]).toMatchObject({
          directory: '/tmp/project',
          permission: OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS,
        })
        return { data: { id: 'ses-1', directory: '/tmp/project' } }
      },
    })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', sessionCreate as unknown as OpenCodeSDKClient)

    await adapter.createSession('/tmp/project', undefined, {
      permission: OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS,
    })
  })

  it('omits session-scoped permissions when none are requested', async () => {
    const sessionCreate = createFakeSdkClient({
      create: async (...args: unknown[]) => {
        expect(args[0]).toEqual({ directory: '/tmp/project' })
        return { data: { id: 'ses-1', directory: '/tmp/project' } }
      },
    })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', sessionCreate as unknown as OpenCodeSDKClient)

    await adapter.createSession('/tmp/project')
  })

  it('applies complete session permissions before prompting without sending deprecated tools', async () => {
    const updateCalls: unknown[][] = []
    const promptCalls: unknown[][] = []
    const fakeClient = createFakeSdkClient({
      update: async (...args: unknown[]) => {
        updateCalls.push(args)
        return { data: { id: 'ses-1', directory: '/tmp/project' } }
      },
      prompt: async (...args: unknown[]) => {
        promptCalls.push(args)
        return {
          data: {
            info: { id: 'msg-1' },
            parts: [{ type: 'text', text: 'assistant response' }],
          },
        }
      },
    })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    await expect(adapter.promptSession(
      'ses-1',
      [{ type: 'text', content: 'Prompt body' }],
      undefined,
      { permission: SILENT_DEFAULT_PERMISSIONS },
    )).resolves.toBe('assistant response')

    expect(updateCalls[0]?.[0]).toMatchObject({
      sessionID: 'ses-1',
      directory: '/tmp/project',
      permission: SILENT_DEFAULT_PERMISSIONS,
    })
    expect(promptCalls[0]?.[0]).not.toHaveProperty('tools')
  })

  it('auto-approves each unexpected permission request once and continues the prompt', async () => {
    const promptResponse = createDeferred<unknown>()
    const permissionReplies: unknown[][] = []
    const fakeClient = createFakeSdkClient({
      prompt: async () => promptResponse.promise,
      permissionReply: async (...args: unknown[]) => {
        permissionReplies.push(args)
        promptResponse.resolve({
          data: {
            info: { id: 'msg-1' },
            parts: [{ type: 'text', text: 'assistant response' }],
          },
        })
        return { data: true }
      },
      subscribe: async () => ({
        stream: (async function* () {
          const permission = {
            type: 'permission.asked',
            properties: {
              id: 'per-1',
              sessionID: 'ses-1',
              permission: 'external_directory',
              patterns: ['/tmp/test/*'],
            },
          }
          yield permission
          yield permission
          yield { type: 'session.idle', properties: { sessionID: 'ses-1' } }
        })(),
      }),
    })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    await expect(adapter.promptSession(
      'ses-1',
      [{ type: 'text', content: 'Prompt body' }],
      undefined,
      {
        permission: SILENT_DEFAULT_PERMISSIONS,
        autoApprovePermissions: true,
      },
    )).resolves.toBe('assistant response')

    expect(permissionReplies).toHaveLength(1)
    expect(permissionReplies[0]?.[0]).toMatchObject({
      requestID: 'per-1',
      directory: '/tmp/project',
      reply: 'always',
    })
  })

  it('aborts immediately when an unexpected permission cannot be auto-approved', async () => {
    const abortCalls: unknown[][] = []
    const fakeClient = createFakeSdkClient({
      prompt: async (...args: unknown[]) => {
        const options = args[1] as { signal?: AbortSignal } | undefined
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
      },
      permissionReply: async () => {
        throw new Error('permission endpoint unavailable')
      },
      abort: async (...args: unknown[]) => {
        abortCalls.push(args)
        return { data: true }
      },
      subscribe: async () => ({
        stream: (async function* () {
          yield {
            type: 'permission.asked',
            properties: {
              id: 'per-1',
              sessionID: 'ses-1',
              permission: 'external_directory',
              patterns: ['/tmp/test/*'],
            },
          }
        })(),
      }),
    })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    await expect(adapter.promptSession(
      'ses-1',
      [{ type: 'text', content: 'Prompt body' }],
      undefined,
      {
        permission: SILENT_DEFAULT_PERMISSIONS,
        autoApprovePermissions: true,
      },
    )).rejects.toThrow(
      'Failed to auto-approve OpenCode permission external_directory: permission endpoint unavailable',
    )
    expect(abortCalls).toHaveLength(1)
    expect(abortCalls[0]?.[0]).toMatchObject({ sessionID: 'ses-1' })
  })

  it('passes bounded caller signals to create, list, session get, and messages SDK calls', async () => {
    const capturedSignals: AbortSignal[] = []
    const captureSignal = (args: unknown[]) => {
      const options = args[1] as { signal?: AbortSignal } | undefined
      expect(options?.signal).toBeDefined()
      capturedSignals.push(options!.signal!)
    }
    const fakeClient = createFakeSdkClient({
      create: async (...args: unknown[]) => {
        captureSignal(args)
        return { data: { id: 'ses-1', directory: '/tmp/project' } }
      },
      list: async (...args: unknown[]) => {
        captureSignal(args)
        return { data: [{ id: 'ses-1', directory: '/tmp/project' }] }
      },
      get: async (...args: unknown[]) => {
        captureSignal(args)
        return { data: { id: 'ses-1', directory: '/tmp/project' } }
      },
      messages: async (...args: unknown[]) => {
        captureSignal(args)
        return { data: [] }
      },
    })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)
    const controller = new AbortController()

    await adapter.createSession('/tmp/project', controller.signal)
    await adapter.listSessions(controller.signal)
    await adapter.getSessionMessages('ses-2', controller.signal)

    expect(capturedSignals).toHaveLength(4)
    expect(capturedSignals.every(signal => signal.aborted === false)).toBe(true)
    controller.abort()
    expect(capturedSignals.every(signal => signal.aborted)).toBe(true)
  })

  it('gets the exact session through the SDK v2 flat parameter contract', async () => {
    const get = vi.fn(async (..._args: unknown[]) => ({
      data: { id: 'ses-exact', directory: '/tmp/project' },
    }))
    const fakeClient = createFakeSdkClient({ get })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    await expect(adapter.getSession('ses-exact')).resolves.toMatchObject({
      id: 'ses-exact',
      directory: '/tmp/project',
    })
    expect(get).toHaveBeenCalledOnce()
    expect(get.mock.calls[0]?.[0]).toEqual({ sessionID: 'ses-exact' })
  })

  it('returns a missing session only for a confirmed SDK 404 response', async () => {
    const missingClient = createFakeSdkClient({
      get: async () => ({
        error: { name: 'NotFoundError', message: 'Session not found' },
        response: { status: 404 },
      }),
    })
    const unavailableClient = createFakeSdkClient({
      get: async () => ({
        error: { name: 'InternalServerError', message: 'OpenCode unavailable' },
        response: { status: 500 },
      }),
    })

    const missingAdapter = new OpenCodeSDKAdapter('http://localhost:4096', missingClient as unknown as OpenCodeSDKClient)
    const unavailableAdapter = new OpenCodeSDKAdapter('http://localhost:4096', unavailableClient as unknown as OpenCodeSDKClient)

    await expect(missingAdapter.getSession('ses-missing')).resolves.toBeNull()
    await expect(unavailableAdapter.getSession('ses-preserve')).rejects.toMatchObject({
      name: 'InternalServerError',
      message: 'OpenCode unavailable',
    })
  })

  it('dispatches prompt metadata before the prompt completes', async () => {
    const deferredResponse = createDeferred<string>()
    const adapter = new TestOpenCodeAdapter([deferredResponse])
    const callbackOrder: string[] = []
    let dispatchedEvent: OpenCodePromptDispatchEvent | null = null

    const runPromise = runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'PROM1 body' }],
      timeoutMs: 1_000,
      timeoutKind: 'ai_response',
      model: 'openai/gpt-5-mini',
      onSessionCreated: () => {
        callbackOrder.push('session')
      },
      onPromptDispatched: (event) => {
        callbackOrder.push('prompt')
        dispatchedEvent = event
      },
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(callbackOrder).toEqual(['session', 'prompt'])
    expect(dispatchedEvent).toMatchObject({
      session: { id: 'ses-1' },
      promptText: 'PROM1 body',
      promptNumber: 1,
      timeoutKind: 'ai_response',
      timeoutMs: 1_000,
      model: 'openai/gpt-5-mini',
    })
    expect((dispatchedEvent as OpenCodePromptDispatchEvent | null)?.deadlineAt).toEqual(expect.any(String))

    deferredResponse.resolve('assistant response')
    await expect(runPromise).resolves.toMatchObject({
      response: 'assistant response',
      session: { id: 'ses-1' },
    })
  })

  it('classifies setup-plan drafting prompt metadata as AI response timeout by default', async () => {
    resetTestDb()
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'AI response timeout metadata',
    })
    patchTicket(ticket.id, { status: 'GENERATING_EXECUTION_SETUP_PLAN' })
    const adapter = new TestOpenCodeAdapter(['assistant response'])
    let dispatchedEvent: OpenCodePromptDispatchEvent | null = null

    await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Workspace setup-plan draft body' }],
      timeoutMs: 2_000,
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'GENERATING_EXECUTION_SETUP_PLAN',
      },
      onPromptDispatched: (event) => {
        dispatchedEvent = event
      },
    })

    expect(dispatchedEvent).toMatchObject({
      timeoutKind: 'ai_response',
      timeoutMs: 2_000,
    })
    expect((dispatchedEvent as OpenCodePromptDispatchEvent | null)?.deadlineAt).toEqual(expect.any(String))
  })

  it('blocks after 10 continuable OpenCode retry events by default and preserves the session for Continue', async () => {
    resetTestDb()
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Default OpenCode retry budget',
    })
    patchTicket(ticket.id, { status: 'DRAFTING_PRD' })
    const adapter = new TestOpenCodeAdapter([{
      response: 'assistant response',
      streamEvents: Array.from({ length: 10 }, (_, index) => ({
        type: 'session_status' as const,
        sessionId: 'ses-1',
        status: 'retry' as const,
        attempt: index + 1,
        message: 'The usage limit has been reached',
      })),
    }])

    let thrown: unknown
    try {
      await runOpenCodePrompt({
        adapter,
        projectPath: '/tmp/project',
        parts: [{ type: 'text', content: 'Prompt body' }],
        model: TEST.implementer,
        sessionOwnership: {
          ticketId: ticket.id,
          phase: 'DRAFTING_PRD',
          keepActive: true,
        },
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      message: expect.stringContaining('OpenCode retry budget exhausted after 10 retry event(s)'),
      blockedErrorDiagnostics: expect.objectContaining({
        kind: 'opencode_provider',
        source: 'provider',
        sessionId: 'ses-1',
        modelId: TEST.implementer,
      }),
      blockedErrorCodes: expect.arrayContaining(['OPENCODE_PROVIDER_ERROR']),
    })
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toHaveLength(1)
  })

  it('blocks after the configured continuable OpenCode retry limit', async () => {
    const adapter = new TestOpenCodeAdapter([{
      response: 'assistant response',
      streamEvents: [
        {
          type: 'session_status',
          sessionId: 'ses-1',
          status: 'retry',
          attempt: 1,
          message: 'rate limited',
        },
        {
          type: 'session_status',
          sessionId: 'ses-1',
          status: 'busy',
        },
        {
          type: 'session_status',
          sessionId: 'ses-1',
          status: 'retry',
          attempt: 2,
          message: 'rate limited',
        },
      ],
    }])

    await expect(runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
      opencodeRetryPolicy: { limit: 2, delayMs: 0 },
    })).rejects.toThrow('OpenCode retry budget exhausted after 2 retry event(s)')
  })

  it('blocks when a continuable OpenCode retry state exceeds the configured grace window', async () => {
    vi.useFakeTimers()
    try {
      const deferredResponse = createDeferred<string>()
      const adapter = new TestOpenCodeAdapter([{
        response: deferredResponse,
        streamEvents: [{
          type: 'session_status',
          sessionId: 'ses-1',
          status: 'retry',
          attempt: 1,
          message: 'temporarily unavailable',
        }],
      }])

      const runPromise = runOpenCodePrompt({
        adapter,
        projectPath: '/tmp/project',
        parts: [{ type: 'text', content: 'Prompt body' }],
        opencodeRetryPolicy: { limit: 50, delayMs: 20 },
      })
      const rejection = expect(runPromise).rejects.toThrow('OpenCode retry grace window expired after 20ms')

      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(25)

      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores non-matching OpenCode retry status messages', async () => {
    const adapter = new TestOpenCodeAdapter([{
      response: 'assistant response',
      streamEvents: [
        {
          type: 'session_status',
          sessionId: 'ses-1',
          status: 'busy',
        },
        {
          type: 'session_status',
          sessionId: 'ses-1',
          status: 'retry',
          attempt: 1,
          message: 'Refreshing local workspace state',
        },
      ],
    }])

    await expect(runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
      opencodeRetryPolicy: { limit: 0, delayMs: 1 },
    })).resolves.toMatchObject({
      response: 'assistant response',
    })
  })

  it('creates allow-all sessions for workflow phases', async () => {
    resetTestDb()
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Execution-band session permissions',
    })
    patchTicket(ticket.id, { status: 'CODING' })
    const adapter = new TestOpenCodeAdapter(['assistant response'])

    await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'CODING',
      },
    })

    expect(adapter.sessionCreateCalls).toHaveLength(1)
    expect(adapter.sessionCreateCalls[0]?.options?.permission).toEqual(OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS)
  })

  it('also creates allow-all sessions for non-execution workflow phases', async () => {
    resetTestDb()
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Non execution session permissions',
    })
    patchTicket(ticket.id, { status: 'DRAFTING_PRD' })
    const adapter = new TestOpenCodeAdapter(['assistant response'])

    await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'DRAFTING_PRD',
      },
    })

    expect(adapter.sessionCreateCalls).toHaveLength(1)
    expect(adapter.sessionCreateCalls[0]?.options?.permission).toEqual(OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS)
  })

  it('retries unowned session creation before prompting', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new TestOpenCodeAdapter(['assistant response'], {
        createFailures: [
          new Error('OpenCode returned no session payload'),
          new Error('socket hang up'),
        ],
      })

      const runPromise = runOpenCodePrompt({
        adapter,
        projectPath: '/tmp/project',
        parts: [{ type: 'text', content: 'Prompt body' }],
      })

      await vi.runAllTimersAsync()
      const result = await runPromise

      expect(result.session.id).toBe('ses-1')
      expect(adapter.sessionCreateCalls).toHaveLength(3)
      expect(adapter.healthCalls).toBe(2)
      expect(adapter.promptCalls.map((call) => call.sessionId)).toEqual(['ses-1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries owned session creation before prompting and recording the session', async () => {
    vi.useFakeTimers()
    try {
      resetTestDb()
      const { ticket } = createInitializedTestTicket(repoManager, {
        title: 'Owned session retry',
      })
      patchTicket(ticket.id, { status: 'CODING' })
      const adapter = new TestOpenCodeAdapter(['assistant response'], {
        createFailures: [
          new Error('OpenCode returned no session payload'),
        ],
      })

      const runPromise = runOpenCodePrompt({
        adapter,
        projectPath: '/tmp/project',
        parts: [{ type: 'text', content: 'Prompt body' }],
        sessionOwnership: {
          ticketId: ticket.id,
          phase: 'CODING',
        },
      })

      await vi.runAllTimersAsync()
      const result = await runPromise

      expect(result.session.id).toBe('ses-1')
      expect(adapter.sessionCreateCalls).toHaveLength(2)
      expect(adapter.healthCalls).toBe(1)
      expect(adapter.promptCalls.map((call) => call.sessionId)).toEqual(['ses-1'])
      expect(listOpenCodeSessionsForTicket(ticket.id, ['completed']).map((session) => session.sessionId)).toEqual(['ses-1'])
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * Fake timers, because this asserts on where a 1ms deadline lands.
   *
   * With real timers it is a race the test loses roughly once in fifteen runs
   * on a loaded machine: the retry loop checks `signal.aborted` *before* calling
   * the adapter, so a deadline that fires during the several awaits it takes to
   * get there produces zero session-create calls where this expects one. The
   * failure reads as a product bug and is a wall-clock race in the test.
   *
   * Advancing deliberately also states what the test is actually about. The
   * first attempt has to happen and fail on its own — none of that is
   * timer-driven — and only then does the deadline land, inside the 1000ms wait
   * before the second attempt. That is the state the name refers to.
   */
  it('preserves timeout behavior while waiting to retry session creation', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new TestOpenCodeAdapter(['assistant response'], {
        createFailures: [
          new Error('OpenCode returned no session payload'),
        ],
      })

      const runPromise = runOpenCodePrompt({
        adapter,
        projectPath: '/tmp/project',
        parts: [{ type: 'text', content: 'Prompt body' }],
        timeoutMs: 1,
      })
      const rejection = expect(runPromise).rejects.toThrow('Timeout')

      await vi.advanceTimersByTimeAsync(0)
      expect(adapter.sessionCreateCalls).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(1)
      await rejection

      // Still one: the deadline cut the wait short rather than allowing the
      // retry the loop was about to make.
      expect(adapter.sessionCreateCalls).toHaveLength(1)
      expect(adapter.promptCalls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prompts a newly-created owned session without requiring it to appear in the remote session list first', async () => {
    resetTestDb()
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Owned session immediate prompt',
    })
    patchTicket(ticket.id, { status: 'COUNCIL_DELIBERATING' })
    const adapter = new TestOpenCodeAdapter(['assistant response'], {
      listSessions: () => [],
    })

    await expect(runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'COUNCIL_DELIBERATING',
        memberId: 'openai/gpt-5.3-codex',
      },
    })).resolves.toMatchObject({
      response: 'assistant response',
      session: { id: 'ses-1' },
    })

    expect(adapter.promptCalls).toHaveLength(1)
    expect(adapter.listSessionsCalls).toBe(0)
    expect(listOpenCodeSessionsForTicket(ticket.id, ['completed'])).toHaveLength(1)
  })

  it('abandons an existing owned active session when forceFresh is requested', async () => {
    resetTestDb()
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Fresh PR session',
    })
    patchTicket(ticket.id, { status: 'CREATING_PULL_REQUEST' })
    const adapter = new TestOpenCodeAdapter(['initial response', 'fresh response'])

    await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Initial PR prompt' }],
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'CREATING_PULL_REQUEST',
        memberId: 'openai/gpt-5.3-codex',
        keepActive: true,
      },
    })

    expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toHaveLength(1)

    const result = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Fresh PR prompt' }],
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'CREATING_PULL_REQUEST',
        memberId: 'openai/gpt-5.3-codex',
        forceFresh: true,
      },
    })

    expect(result.session.id).toBe('ses-2')
    expect(adapter.abortCalls).toEqual(['ses-1'])
    expect(adapter.promptCalls.map((call) => call.sessionId)).toEqual(['ses-1', 'ses-2'])
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toHaveLength(0)
    expect(listOpenCodeSessionsForTicket(ticket.id, ['abandoned'])).toHaveLength(1)
    expect(listOpenCodeSessionsForTicket(ticket.id, ['completed'])).toHaveLength(1)
  })

  it('preserves an owned same-session prompt after a resumable transport interruption', async () => {
    resetTestDb()
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Same session prompt continuation',
    })
    patchTicket(ticket.id, { status: 'CODING' })
    const adapter = new TestOpenCodeAdapter([
      'initial response',
      new Error('Failed to prompt OpenCode session: socket hang up'),
    ])

    const initial = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Initial prompt' }],
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'CODING',
        keepActive: true,
      },
    })

    expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toHaveLength(1)

    await expect(runOpenCodeSessionPrompt({
      adapter,
      session: initial.session,
      parts: [{ type: 'text', content: 'Follow-up prompt' }],
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'CODING',
      },
    })).rejects.toThrow('Failed to prompt OpenCode session')

    expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toHaveLength(1)
    expect(listOpenCodeSessionsForTicket(ticket.id, ['abandoned'])).toHaveLength(0)
  })

  it('abandons an owned same-session prompt after a non-continuable auth failure', async () => {
    resetTestDb()
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Same session auth cleanup',
    })
    patchTicket(ticket.id, { status: 'CODING' })
    const adapter = new TestOpenCodeAdapter([
      'initial response',
      new Error('Failed to prompt OpenCode session: HTTP 401 authentication failed'),
    ])

    const initial = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Initial prompt' }],
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'CODING',
        keepActive: true,
      },
    })

    await expect(runOpenCodeSessionPrompt({
      adapter,
      session: initial.session,
      parts: [{ type: 'text', content: 'Follow-up prompt' }],
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'CODING',
      },
    })).rejects.toThrow('Failed to prompt OpenCode session')

    expect(listOpenCodeSessionsForTicket(ticket.id, ['active'])).toHaveLength(0)
    expect(listOpenCodeSessionsForTicket(ticket.id, ['abandoned'])).toHaveLength(1)
  })

  it('replaces a pending continuation prompt with the bare PROM54 text in the owned active session', async () => {
    resetTestDb()
    clearAllPendingSessionContinuationsForTests()
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Same session continuation prompt',
    })
    patchTicket(ticket.id, { status: 'PREPARING_EXECUTION_ENV' })
    const adapter = new TestOpenCodeAdapter(['initial response', 'continued response'])

    const initial = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Initial setup prompt' }],
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'PREPARING_EXECUTION_ENV',
        keepActive: true,
      },
    })

    requestSessionContinuation({
      ticketId: ticket.id,
      phase: 'PREPARING_EXECUTION_ENV',
      sessionId: initial.session.id,
    })

    const continued = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Original prompt should not be resent' }],
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'PREPARING_EXECUTION_ENV',
      },
    })

    expect(continued.response).toBe('continued response')
    expect(adapter.promptCalls[1]?.sessionId).toBe(initial.session.id)
    expect(adapter.promptCalls[1]?.parts).toEqual([{ type: 'text', content: 'continue please' }])
  })

  it('sends a custom continuation prompt to the preserved session across setup attempt numbers', async () => {
    resetTestDb()
    clearAllPendingSessionContinuationsForTests()
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Workspace setup note continuation',
    })
    patchTicket(ticket.id, { status: 'PREPARING_EXECUTION_ENV' })
    const adapter = new TestOpenCodeAdapter(['initial response', 'continued response'])

    const initial = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Initial setup prompt' }],
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'PREPARING_EXECUTION_ENV',
        phaseAttempt: 5,
        keepActive: true,
      },
    })
    const note = 'Create file x first, then rerun the workspace check.'
    requestSessionContinuation({
      ticketId: ticket.id,
      phase: 'PREPARING_EXECUTION_ENV',
      sessionId: initial.session.id,
      prompt: note,
      additionalRetryAttempts: 1,
    })

    const continued = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Original prompt should not be resent' }],
      sessionOwnership: {
        ticketId: ticket.id,
        phase: 'PREPARING_EXECUTION_ENV',
        phaseAttempt: 6,
      },
    })

    expect(continued.response).toBe('continued response')
    expect(adapter.promptCalls[1]?.sessionId).toBe(initial.session.id)
    expect(adapter.promptCalls[1]?.parts).toEqual([{ type: 'text', content: note }])
  })

  it('retains upgrade guidance after execution-band session creation retries are exhausted', async () => {
    vi.useFakeTimers()
    try {
      resetTestDb()
      const { ticket } = createInitializedTestTicket(repoManager, {
        title: 'Execution permission rejection',
      })
      patchTicket(ticket.id, { status: 'CODING' })
      let createCalls = 0
      const fakeClient = createFakeSdkClient({
        create: async (...args: unknown[]) => {
          createCalls += 1
          expect(args[0]).toMatchObject({
            directory: '/tmp/project',
            permission: OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS,
          })
          throw new Error('400 Bad Request: unknown field "permission"')
        },
      })
      const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

      const runPromise = runOpenCodePrompt({
        adapter,
        projectPath: '/tmp/project',
        parts: [{ type: 'text', content: 'Prompt body' }],
        sessionOwnership: {
          ticketId: ticket.id,
          phase: 'CODING',
        },
      })
      const rejected = expect(runPromise).rejects.toThrow('Upgrade OpenCode and restart `opencode serve`')

      await vi.runAllTimersAsync()
      await rejected
      expect(createCalls).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('increments prompt numbers across repeated prompts in the same session', async () => {
    const adapter = new TestOpenCodeAdapter(['first response', 'second response'])
    const promptNumbers: number[] = []

    await runOpenCodeSessionPrompt({
      adapter,
      session: { id: 'shared-session' },
      parts: [{ type: 'text', content: 'first prompt' }],
      onPromptDispatched: (event) => {
        promptNumbers.push(event.promptNumber)
      },
    })

    await runOpenCodeSessionPrompt({
      adapter,
      session: { id: 'shared-session' },
      parts: [{ type: 'text', content: 'second prompt' }],
      onPromptDispatched: (event) => {
        promptNumbers.push(event.promptNumber)
      },
    })

    expect(promptNumbers).toEqual([1, 2])
  })

  it('sends the shared deny-all permission policy when toolPolicy is disabled', async () => {
    const adapter = new TestOpenCodeAdapter(['assistant response'])

    await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
      toolPolicy: 'disabled',
    })

    expect(adapter.promptCalls).toHaveLength(1)
    expect(adapter.promptCalls[0]?.options?.permission).toEqual(SILENT_DISABLED_PERMISSIONS)
  })

  it('sends the default no-web permission policy with unattended safeguards', async () => {
    const adapter = new TestOpenCodeAdapter(['assistant response'])

    await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
      toolPolicy: 'default',
    })

    expect(adapter.promptCalls).toHaveLength(1)
    expect(adapter.promptCalls[0]?.options?.permission).toEqual(SILENT_DEFAULT_PERMISSIONS)
    expect(adapter.promptCalls[0]?.options?.permission).toEqual(expect.arrayContaining([
      { permission: 'external_directory', pattern: '*', action: 'allow' },
      { permission: 'doom_loop', pattern: '*', action: 'allow' },
      { permission: 'webfetch', pattern: '*', action: 'deny' },
      { permission: 'websearch', pattern: '*', action: 'deny' },
    ]))
    expect(adapter.promptCalls[0]?.options?.autoApprovePermissions).toBe(true)
  })

  it('allows OpenCode web permissions for execution setup prompts only', async () => {
    const adapter = new TestOpenCodeAdapter(['assistant response'])

    await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
      toolPolicy: 'execution_setup_online',
    })

    expect(adapter.promptCalls).toHaveLength(1)
    expect(adapter.promptCalls[0]?.options?.permission).toEqual(SILENT_EXECUTION_SETUP_ONLINE_PERMISSIONS)
  })

  it('propagates the initial PROM1 interview draft prompt to callers', async () => {
    const adapter = new TestOpenCodeAdapter([
      [
        'questions:',
        '  - id: Q01',
        '    phase: foundation',
        '    question: "What problem are we solving?"',
      ].join('\n'),
    ])
    const dispatchedEntries: Array<{
      stage: 'draft'
      memberId: string
      event: OpenCodePromptDispatchEvent
    }> = []

    const result = await deliberateInterview(
      adapter,
      [{ modelId: 'openai/gpt-5-mini', name: 'GPT-5 Mini' }],
      [{ type: 'text', source: 'ticket_details', content: 'Build a ticket dashboard.' }],
      '/tmp/project',
      {
        draftTimeoutMs: 300_000,
        minQuorum: 1,
        maxInitialQuestions: 3,
      },
      undefined,
      undefined,
      undefined,
      (entry) => {
        dispatchedEntries.push(entry)
      },
    )

    expect(result.drafts).toHaveLength(1)
    expect(result.drafts[0]).toMatchObject({
      memberId: 'openai/gpt-5-mini',
      outcome: 'completed',
    })
    expect(dispatchedEntries).toHaveLength(1)
    expect(dispatchedEntries[0]).toMatchObject({
      stage: 'draft',
      memberId: 'openai/gpt-5-mini',
    })
    expect(dispatchedEntries[0]!.event.promptText).toContain('## System Role')
    expect(dispatchedEntries[0]!.event.promptText).toContain('Build a ticket dashboard.')
    expect(dispatchedEntries[0]!.event.promptText).toContain('max_initial_questions: 3')
    expect(adapter.promptCalls[0]?.options?.permission).toEqual(SILENT_READ_ONLY_PERMISSIONS)
  })

  it('returns snapshot content when stream done arrives before SDK prompt resolves', async () => {
    const deferredPrompt = createDeferred<{ data?: { parts?: Array<{ type: string; text: string }> } }>()
    const fakeClient = createFakeSdkClient({
      prompt: async () => deferredPrompt.promise,
      messages: async () => ({
        data: [
          {
            info: { id: 'msg-1', role: 'assistant', time: { created: Date.now() } },
            parts: [
              {
                id: 'part-1',
                type: 'text',
                text: 'stream snapshot response',
                sessionID: 'ses-1',
                messageID: 'msg-1',
                time: { end: Date.now() },
              },
            ],
          },
        ],
      }),
    })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    const runPromise = runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
    })

    // The stream reports done before the SDK prompt settles, so this resolves
    // without the deferred below. A wall-clock race here would only measure how
    // loaded the worker is; a regression hangs and fails on the test timeout.
    const result = await runPromise
    expect(result.response).toBe('stream snapshot response')

    deferredPrompt.resolve({
      data: {
        parts: [
          { type: 'text', text: 'late sdk response' },
        ],
      },
    })
  })

  it('falls back to streamed text when the final snapshot text is empty', async () => {
    const fakeClient = createFakeSdkClient({
      prompt: async () => ({
        data: {
          info: { id: 'msg-1' },
          parts: [
            { type: 'text', text: '' },
          ],
        },
      }),
      messages: async () => ({
        data: [
          {
            info: { id: 'msg-1', role: 'assistant', time: { created: Date.now() } },
            parts: [
              {
                id: 'part-1',
                type: 'text',
                text: '',
                sessionID: 'ses-1',
                messageID: 'msg-1',
                time: { end: Date.now() },
              },
            ],
          },
        ],
      }),
      subscribe: async () => ({
        stream: (async function* () {
          yield {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'part-1',
                type: 'text',
                text: '<RELEVANT_FILES_RESULT>streamed artifact</RELEVANT_FILES_RESULT>',
                sessionID: 'ses-1',
                messageID: 'msg-1',
                time: { end: Date.now() },
              },
            },
          }
          yield {
            type: 'session.idle',
            properties: { info: { id: 'ses-1' } },
          }
        })(),
      }),
    })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    const result = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
    })

    expect(result.response).toBe('<RELEVANT_FILES_RESULT>streamed artifact</RELEVANT_FILES_RESULT>')
  })

  it('does not fall back to older assistant text when the latest assistant snapshot is empty', async () => {
    const fakeClient = createFakeSdkClient({
      prompt: async () => ({
        data: {
          info: { id: 'msg-2' },
          parts: [{ type: 'text', text: '' }],
        },
      }),
      messages: async () => ({
        data: [
          {
            info: { id: 'msg-1', role: 'assistant', time: { created: Date.now() - 10 } },
            parts: [
              {
                id: 'part-1',
                type: 'text',
                text: 'older assistant output',
                sessionID: 'ses-1',
                messageID: 'msg-1',
                time: { end: Date.now() - 10 },
              },
            ],
          },
          {
            info: { id: 'msg-2', role: 'assistant', time: { created: Date.now() } },
            parts: [
              {
                id: 'part-2',
                type: 'text',
                text: '',
                sessionID: 'ses-1',
                messageID: 'msg-2',
                time: { end: Date.now() },
              },
            ],
          },
        ],
      }),
    })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    const result = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
    })

    expect(result.response).toBe('')
    expect(result.responseMeta).toMatchObject({
      hasAssistantMessage: true,
      latestAssistantMessageId: 'msg-2',
      latestAssistantWasEmpty: true,
      latestAssistantHasError: false,
    })
  })

  it('throws the streamed provider error when the SDK prompt response is empty', async () => {
    const fakeClient = createFakeSdkClient({
      prompt: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
        return { data: { parts: [] } }
      },
      messages: async () => ({ data: [] }),
      subscribe: async () => ({
        stream: (async function* () {
          yield {
            type: 'session.error',
            properties: {
              sessionID: 'ses-1',
              error: {
                name: 'APIError',
                data: {
                  message: 'Your authentication token has been invalidated. Please try signing in again.',
                  statusCode: 401,
                  isRetryable: false,
                  responseBody: JSON.stringify({
                    error: {
                      type: 'invalid_request_error',
                      code: 'token_invalidated',
                      message: 'Your authentication token has been invalidated. Please try signing in again.',
                    },
                  }),
                },
              },
            },
          }
          yield { type: 'session.idle', properties: { info: { id: 'ses-1' } } }
        })(),
      }),
    })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    await expect(adapter.promptSession('ses-1', [{ type: 'text', content: 'Prompt body' }]))
      .rejects
      .toThrow(/Your authentication token has been invalidated.*HTTP 401/)
  })

  it('enriches generic streamed provider errors from matching OpenCode log entries', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'looptroop-opencode-stream-'))
    const previousLogDir = process.env.LOOPTROOP_OPENCODE_LOG_DIR
    process.env.LOOPTROOP_OPENCODE_LOG_DIR = logDir
    writeFileSync(join(logDir, '2026-05-22T151603.log'), 'ERROR 2026-05-22T15:45:45 +166301ms service=llm providerID=kilo modelID=kilo-auto/free session.id=ses-generic small=false agent=build mode=primary error={"error":{"name":"AI_APICallError","url":"https://api.kilo.ai/api/gateway/chat/completions","requestBodyValues":{"model":"anthropic/claude-haiku-4.5","messages":[{"role":"user","content":"prompt must not leak"}]},"statusCode":402,"isRetryable":false,"responseBody":"{\\"error\\":{\\"title\\":\\"Low Credit Warning!\\",\\"message\\":\\"Add credits to continue, or switch to a free model\\"},\\"error_type\\":\\"usage_limit_exceeded\\"}"}}} stream error')
    try {
      const fakeClient = createFakeSdkClient({
        create: async () => ({ data: { id: 'ses-generic', directory: '/tmp/project' } }),
        prompt: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 20))
          return { data: { parts: [] } }
        },
        messages: async () => ({ data: [] }),
        subscribe: async () => ({
          stream: (async function* () {
            yield {
              type: 'session.error',
              properties: {
                sessionID: 'ses-generic',
                error: 'Provider returned error',
              },
            }
            yield { type: 'session.idle', properties: { info: { id: 'ses-generic' } } }
          })(),
        }),
      })
      const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

      await expect(runOpenCodePrompt({
        adapter,
        projectPath: '/tmp/project',
        parts: [{ type: 'text', content: 'Prompt body' }],
      })).rejects.toMatchObject({
        message: expect.stringContaining('Low Credit Warning!: Add credits to continue, or switch to a free model'),
        modelErrorDetails: expect.objectContaining({
          statusCode: 402,
          responseErrorType: 'usage_limit_exceeded',
          responseErrorTitle: 'Low Credit Warning!',
          responseErrorMessage: 'Add credits to continue, or switch to a free model',
          requestModel: 'anthropic/claude-haiku-4.5',
        }),
      })
    } finally {
      if (previousLogDir === undefined) {
        delete process.env.LOOPTROOP_OPENCODE_LOG_DIR
      } else {
        process.env.LOOPTROOP_OPENCODE_LOG_DIR = previousLogDir
      }
      removeTempDir(logDir)
    }
  })

  it('surfaces provider metadata from the latest assistant snapshot instead of reusing stale text', async () => {
    const fakeClient = createFakeSdkClient({
      prompt: async () => ({
        data: {
          info: { id: 'msg-2' },
          parts: [],
        },
      }),
      messages: async () => ({
        data: [
          {
            info: { id: 'msg-1', role: 'assistant', time: { created: Date.now() - 10 } },
            parts: [
              {
                id: 'part-1',
                type: 'text',
                text: 'older assistant output',
                sessionID: 'ses-1',
                messageID: 'msg-1',
                time: { end: Date.now() - 10 },
              },
            ],
          },
          {
            info: {
              id: 'msg-2',
              role: 'assistant',
              error: "Provider returned error: The last message cannot have role 'assistant'",
              time: { created: Date.now() },
            },
            parts: [],
          },
        ],
      }),
    })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    const result = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
    })

    expect(result.response).toBe('')
    expect(result.responseMeta).toMatchObject({
      hasAssistantMessage: true,
      latestAssistantMessageId: 'msg-2',
      latestAssistantWasEmpty: true,
      latestAssistantHasError: true,
      latestAssistantError: "Provider returned error: The last message cannot have role 'assistant'",
    })
  })

  it('discards parseable output when the session stream emitted a provider error and the caller opts in', async () => {
    const adapter = new TestOpenCodeAdapter([{
      response: '<RELEVANT_FILES_RESULT>streamed artifact</RELEVANT_FILES_RESULT>',
      messageContent: '<RELEVANT_FILES_RESULT>streamed artifact</RELEVANT_FILES_RESULT>',
      streamEvents: [{
        type: 'session_error',
        sessionId: 'ses-1',
        error: "Provider returned error: The last message cannot have role 'assistant'",
      }],
    }])

    const result = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
      erroredSessionPolicy: 'discard_errored_session_output',
    })

    expect(result.response).toBe('')
    expect(result.responseMeta).toMatchObject({
      sessionErrored: true,
      sessionError: "Provider returned error: The last message cannot have role 'assistant'",
      latestAssistantHasError: false,
    })
    expect(result.attemptMeta).toMatchObject({
      outcome: 'errored_session',
      responseAccepted: false,
      discardedResponse: true,
      sessionErrored: true,
      latestAssistantErrored: false,
      errorSource: 'session_error',
      error: "Provider returned error: The last message cannot have role 'assistant'",
    })
  })

  it('discards output when the latest assistant snapshot carries provider error metadata and the caller opts in', async () => {
    const adapter = new TestOpenCodeAdapter([{
      response: '<RELEVANT_FILES_RESULT>provider response</RELEVANT_FILES_RESULT>',
      messageContent: '<RELEVANT_FILES_RESULT>provider response</RELEVANT_FILES_RESULT>',
      messageInfo: {
        error: "Provider returned error: The last message cannot have role 'assistant'",
      },
    }])

    const result = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
      erroredSessionPolicy: 'discard_errored_session_output',
    })

    expect(result.response).toBe('')
    expect(result.responseMeta).toMatchObject({
      sessionErrored: false,
      latestAssistantHasError: true,
      latestAssistantError: "Provider returned error: The last message cannot have role 'assistant'",
    })
    expect(result.attemptMeta).toMatchObject({
      outcome: 'errored_session',
      responseAccepted: false,
      discardedResponse: true,
      sessionErrored: false,
      latestAssistantErrored: true,
      errorSource: 'assistant_error',
      error: "Provider returned error: The last message cannot have role 'assistant'",
    })
  })

  it('extracts structured provider error details from the latest assistant snapshot', async () => {
    const fakeClient = createFakeSdkClient({
      prompt: async () => ({
        data: {
          info: { id: 'msg-2' },
          parts: [],
        },
      }),
      messages: async () => ({
        data: [
          {
            info: {
              id: 'msg-2',
              role: 'assistant',
              error: {
                name: 'AI_APICallError',
                statusCode: 402,
                requestBodyValues: { model: 'gpt-5-nano' },
                responseBody: JSON.stringify({
                  error: {
                    title: 'Low Credit Warning!',
                    message: 'Add credits to continue, or switch to a free model',
                  },
                }),
                data: {
                  error: {
                    type: 'ModelError',
                    message: 'Add credits to continue, or switch to a free model',
                  },
                },
              },
              time: { created: Date.now() },
            },
            parts: [],
          },
        ],
      }),
    })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    const result = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
    })

    expect(result.responseMeta.latestAssistantErrorInfo).toMatchObject({
      name: 'AI_APICallError',
      statusCode: 402,
      requestModel: 'gpt-5-nano',
      responseErrorType: 'ModelError',
      responseErrorMessage: 'Add credits to continue, or switch to a free model',
      responseErrorTitle: 'Low Credit Warning!',
    })
  })

  it('waits for the terminal snapshot when the immediate SDK response echoes the prompt', async () => {
    let latestAssistantText = [
      'CRITICAL OUTPUT RULE:',
      'Return strict machine-readable output.',
      '',
      'CONTEXT REFRESH:',
      'Use the latest ticket context.',
    ].join('\n')

    const fakeClient = {
      session: {
        create: async () => ({ data: { id: 'ses-1', directory: '/tmp/project' } }),
        update: async () => ({ data: { id: 'ses-1', directory: '/tmp/project' } }),
        prompt: async () => ({
          data: {
            info: { id: 'msg-echo' },
            parts: [
              { type: 'text', text: latestAssistantText },
            ],
          },
        }),
        messages: async () => ({
          data: [
            {
              info: { id: 'msg-final', role: 'assistant', time: { created: Date.now() } },
              parts: [
                {
                  id: 'part-final',
                  type: 'text',
                  text: latestAssistantText,
                  sessionID: 'ses-1',
                  messageID: 'msg-final',
                  time: { end: Date.now() },
                },
              ],
            },
          ],
        }),
        abort: async () => ({ data: {} }),
      },
      global: {
        event: async () => ({
          stream: (async function* () {
            await new Promise((resolve) => setTimeout(resolve, 20))
            latestAssistantText = [
              '<RELEVANT_FILES_RESULT>',
              'file_count: 1',
              'files:',
              '  - path: src/app.ts',
              '    rationale: Entry point.',
              '    relevance: high',
              '    likely_action: modify',
              '</RELEVANT_FILES_RESULT>',
            ].join('\n')
            yield {
              type: 'session.idle',
              properties: { info: { id: 'ses-1' } },
            }
          })(),
        }),
      },
    }
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    const result = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
    })

    expect(result.response).toContain('<RELEVANT_FILES_RESULT>')
    expect(result.response).not.toContain('CRITICAL OUTPUT RULE:')
  })

  it('prefers the complete latest assistant message when the immediate response is only a strict prefix', async () => {
    const fullMessage = [
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: interview',
      'status: draft',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Which workflow guardrails are mandatory?',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n')
    const adapter = new TestOpenCodeAdapter([{
      response: fullMessage.slice(0, fullMessage.indexOf('follow_up_rounds:')),
      messageContent: fullMessage,
    }])

    const result = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
    })

    expect(result.response).toBe(fullMessage)
    expect(result.responseMeta).toMatchObject({
      hasAssistantMessage: true,
      latestAssistantWasEmpty: false,
      latestAssistantHasError: false,
    })
  })

  it('keeps the immediate response when the latest assistant message is not a strict extension', async () => {
    const adapter = new TestOpenCodeAdapter([{
      response: 'immediate provider response',
      messageContent: 'different assistant text',
    }])

    const result = await runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
    })

    expect(result.response).toBe('immediate provider response')
  })

  it('keeps timeout behavior when done would arrive after the timeout window', async () => {
    const fakeClient = createFakeSdkClient({
      prompt: async () => new Promise<never>(() => {}),
      messages: async () => ({
        data: [
          {
            info: { id: 'msg-1', role: 'assistant', time: { created: Date.now() } },
            parts: [
              {
                id: 'part-1',
                type: 'text',
                text: 'late stream response',
                sessionID: 'ses-1',
                messageID: 'msg-1',
                time: { end: Date.now() },
              },
            ],
          },
        ],
      }),
      subscribe: async (...args: unknown[]) => {
        const requestOptions = (
          args[1] && typeof args[1] === 'object'
            ? args[1] as { signal?: AbortSignal }
            : undefined
        )

        return {
          stream: (async function* () {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 80)
            requestOptions?.signal?.addEventListener('abort', () => {
              clearTimeout(timer)
              const abortError = new Error('Aborted')
              abortError.name = 'AbortError'
              reject(abortError)
            }, { once: true })
          })
          yield {
            type: 'session.idle',
            properties: { info: { id: 'ses-1' } },
          }
          })(),
        }
      },
    })
    const adapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    await expect(runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
      timeoutMs: 20,
    })).rejects.toThrow('Timeout')
  })

  it('treats timeoutMs 0 as no timeout', async () => {
    const deferred = createDeferred<string>()
    const adapter = new TestOpenCodeAdapter([deferred])

    const promise = runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
      timeoutMs: 0,
    })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(adapter.abortCalls).toEqual([])

    deferred.resolve('done after disabled timeout')
    await expect(promise).resolves.toMatchObject({
      response: 'done after disabled timeout',
    })
    expect(adapter.abortCalls).toEqual([])
  })

  it('uses an explicit absolute deadline instead of restarting timeoutMs', async () => {
    const deferred = createDeferred<string>()
    const adapter = new TestOpenCodeAdapter([{
      response: deferred,
      streamEvents: [{
        type: 'session_status',
        sessionId: 'ses-1',
        status: 'retry',
        attempt: 1,
        message: 'temporarily unavailable',
      }],
    }])
    const timeoutDeadline = Date.now() + 20
    const dispatched: OpenCodePromptDispatchEvent[] = []

    await expect(runOpenCodePrompt({
      adapter,
      projectPath: '/tmp/project',
      parts: [{ type: 'text', content: 'Prompt body' }],
      timeoutMs: 60_000,
      timeoutDeadline,
      opencodeRetryPolicy: { limit: 50, delayMs: 60_000 },
      onPromptDispatched: event => dispatched.push(event),
    })).rejects.toThrow('Timeout')

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.deadlineAt).toBe(new Date(timeoutDeadline).toISOString())
    expect(adapter.abortCalls).toEqual(['ses-1'])
  })

  it('subscribeToEvents emits synthetic done after step-finish safety timeout', async () => {
    // Test the safety timeout directly on the adapter level with a small value
    const fakeClient = createFakeSdkClient({
      get: async () => ({ data: { directory: '/tmp/project' } }),
      subscribe: async () => ({
        stream: (async function* () {
          yield {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'part-step-1',
                type: 'step-finish',
                reason: 'stop',
                sessionID: 'ses-1',
                messageID: 'msg-1',
              },
            },
          }
          // Hang indefinitely — simulating missing session.idle
          await new Promise<void>(() => {})
        })(),
      }),
    })
    const sdkAdapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    const events: StreamEvent[] = []
    for await (const event of sdkAdapter.subscribeToEvents('ses-1', undefined, 50)) {
      events.push(event)
    }

    // Should have: step-finish event + synthetic done from safety timeout
    expect(events.some(e => e.type === 'step' && e.step === 'finish')).toBe(true)
    expect(events[events.length - 1]?.type).toBe('done')
  })

  it('subscribeToEvents does not synthesize completion when a stream closes before a terminal session event', async () => {
    const fakeClient = createFakeSdkClient({
      get: async () => ({ data: { directory: '/tmp/project' } }),
      subscribe: async () => ({
        stream: (async function* () {
          yield {
            type: 'workspace.ready',
            properties: {},
          }
        })(),
      }),
    })
    const sdkAdapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    const events: StreamEvent[] = []
    for await (const event of sdkAdapter.subscribeToEvents('ses-1', undefined, 50)) {
      events.push(event)
    }

    expect(events.some(e => e.type === 'done')).toBe(false)
  })

  it('subscribeToEvents reads OpenCode global events without using the legacy directory event stream', async () => {
    let legacyEventSubscribeCalls = 0
    let globalEventCalls = 0
    const fakeClient = createFakeSdkClient({
      get: async () => ({ data: { directory: '/tmp/project' } }),
      eventSubscribe: async () => {
        legacyEventSubscribeCalls += 1
        throw new Error('legacy event stream should not be used')
      },
      globalEvent: async () => {
        globalEventCalls += 1
        return {
          stream: (async function* () {
            yield {
              directory: '/tmp/project',
              payload: {
                type: 'message.updated',
                properties: {
                  info: { id: 'msg-1', sessionID: 'ses-1', role: 'assistant' },
                },
              },
            }
            yield {
              directory: '/tmp/project',
              payload: {
                type: 'message.part.updated',
                properties: {
                  part: {
                    id: 'part-text-1',
                    type: 'text',
                    text: 'live answer',
                    sessionID: 'ses-1',
                    messageID: 'msg-1',
                    time: { end: Date.now() },
                  },
                },
              },
            }
            yield {
              directory: '/tmp/other-project',
              payload: {
                type: 'file.edited',
                properties: { file: 'unrelated.ts' },
              },
            }
            yield {
              directory: '/tmp/project',
              payload: {
                type: 'session.idle',
                properties: { sessionID: 'ses-1' },
              },
            }
          })(),
        }
      },
    })
    const sdkAdapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    const events: StreamEvent[] = []
    for await (const event of sdkAdapter.subscribeToEvents('ses-1')) {
      events.push(event)
    }

    expect(legacyEventSubscribeCalls).toBe(0)
    expect(globalEventCalls).toBe(1)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'text',
        text: 'live answer',
        complete: true,
      }),
      expect.objectContaining({ type: 'done' }),
    ]))
    expect(events.some((event) => event.type === 'file_edited' && event.file === 'unrelated.ts')).toBe(false)
  })

  it('subscribeToEvents filters user prompt parts from the OpenCode global event stream', async () => {
    const fakeClient = createFakeSdkClient({
      get: async () => ({ data: { directory: '/tmp/project' } }),
      globalEvent: async () => ({
        stream: (async function* () {
          yield {
            directory: '/tmp/project',
            payload: {
              type: 'message.updated',
              properties: {
                info: { id: 'msg-user', sessionID: 'ses-1', role: 'user' },
              },
            },
          }
          yield {
            directory: '/tmp/project',
            payload: {
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'part-user',
                  type: 'text',
                  text: 'Prompt body that should not appear as model output',
                  sessionID: 'ses-1',
                  messageID: 'msg-user',
                  time: { end: Date.now() },
                },
              },
            },
          }
          yield {
            directory: '/tmp/project',
            payload: {
              type: 'message.updated',
              properties: {
                info: { id: 'msg-assistant', sessionID: 'ses-1', role: 'assistant' },
              },
            },
          }
          yield {
            directory: '/tmp/project',
            payload: {
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'part-assistant',
                  type: 'text',
                  text: 'Assistant answer',
                  sessionID: 'ses-1',
                  messageID: 'msg-assistant',
                  time: { end: Date.now() },
                },
              },
            },
          }
          yield {
            directory: '/tmp/project',
            payload: {
              type: 'session.idle',
              properties: { sessionID: 'ses-1' },
            },
          }
        })(),
      }),
    })
    const sdkAdapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    const events: StreamEvent[] = []
    for await (const event of sdkAdapter.subscribeToEvents('ses-1')) {
      events.push(event)
    }

    const textEvents = events.filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
    expect(textEvents.map((event) => event.text)).toEqual(['Assistant answer'])
  })

  it('uses the final snapshot after early stream close without emitting synthetic done for prompt echoes', async () => {
    const fakeClient = createFakeSdkClient({
      get: async () => ({ data: { directory: '/tmp/project' } }),
      prompt: async () => ({
        data: {
          info: { id: 'msg-echo' },
          parts: [
            {
              type: 'text',
              text: [
                'CRITICAL OUTPUT RULE:',
                'Return strict machine-readable output.',
                '',
                'CONTEXT REFRESH:',
                'Use the latest ticket context.',
              ].join('\n'),
            },
          ],
        },
      }),
      messages: async () => ({
        data: [
          {
            info: { id: 'msg-final', role: 'assistant', time: { created: Date.now() } },
            parts: [
              {
                id: 'part-final',
                type: 'text',
                text: '<FINAL_RESULT>done</FINAL_RESULT>',
                sessionID: 'ses-1',
                messageID: 'msg-final',
                time: { end: Date.now() },
              },
            ],
          },
        ],
      }),
      subscribe: async () => ({
        stream: (async function* () {
          yield {
            type: 'workspace.ready',
            properties: {},
          }
        })(),
      }),
    })
    const sdkAdapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)
    const events: StreamEvent[] = []

    const response = await sdkAdapter.promptSession(
      'ses-1',
      [{ type: 'text', content: 'Prompt body' }],
      undefined,
      { onEvent: event => events.push(event) },
    )

    expect(response).toBe('<FINAL_RESULT>done</FINAL_RESULT>')
    expect(events.some(event => event.type === 'done')).toBe(false)
  })

  it('preserves OpenCode tool input, output, and error details in stream events', async () => {
    const fakeClient = createFakeSdkClient({
      get: async () => ({ data: { directory: '/tmp/project' } }),
      subscribe: async () => ({
        stream: (async function* () {
          yield {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'part-tool-1',
                type: 'tool',
                callID: 'call-1',
                tool: 'bash',
                sessionID: 'ses-1',
                messageID: 'msg-1',
                state: {
                  status: 'error',
                  title: 'Run unit tests',
                  input: {
                    command: 'npm test',
                  },
                  output: 'stdout body',
                  error: 'stderr body',
                },
              },
            },
          }
          yield {
            type: 'session.idle',
            properties: { info: { id: 'ses-1' } },
          }
        })(),
      }),
    })
    const sdkAdapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    const events: StreamEvent[] = []
    for await (const event of sdkAdapter.subscribeToEvents('ses-1')) {
      events.push(event)
    }

    expect(events[0]).toMatchObject({
      type: 'tool',
      tool: 'bash',
      status: 'error',
      title: 'Run unit tests',
      input: { command: 'npm test' },
      output: 'stdout body',
      error: 'stderr body',
      complete: true,
    })
  })

  it('normalizes OpenCode question events from the stream', async () => {
    const fakeClient = createFakeSdkClient({
      get: async () => ({ data: { directory: '/tmp/project' } }),
      subscribe: async () => ({
        stream: (async function* () {
          yield {
            type: 'question.asked',
            properties: {
              id: 'question-1',
              sessionID: 'ses-1',
              questions: [{
                header: 'Deploy?',
                question: 'Should I deploy now?',
                options: [{ label: 'Yes', description: 'Deploy now' }],
                custom: true,
              }],
              tool: { messageID: 'msg-1', callID: 'call-1' },
            },
          }
          yield {
            type: 'question.replied',
            properties: {
              sessionID: 'ses-1',
              requestID: 'question-1',
              answers: [['Yes']],
            },
          }
          yield {
            type: 'question.rejected',
            properties: {
              sessionID: 'ses-1',
              requestID: 'question-2',
            },
          }
          yield { type: 'session.idle', properties: { sessionID: 'ses-1' } }
        })(),
      }),
    })
    const sdkAdapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    const events: StreamEvent[] = []
    for await (const event of sdkAdapter.subscribeToEvents('ses-1')) {
      events.push(event)
    }

    expect(events.filter((event) => event.type === 'question')).toEqual([
      {
        type: 'question',
        action: 'asked',
        sessionId: 'ses-1',
        requestId: 'question-1',
        questions: [{
          header: 'Deploy?',
          question: 'Should I deploy now?',
          options: [{ label: 'Yes', description: 'Deploy now' }],
          custom: true,
        }],
        tool: { messageID: 'msg-1', callID: 'call-1' },
      },
      {
        type: 'question',
        action: 'replied',
        sessionId: 'ses-1',
        requestId: 'question-1',
        answers: [['Yes']],
      },
      {
        type: 'question',
        action: 'rejected',
        sessionId: 'ses-1',
        requestId: 'question-2',
      },
    ])
  })

  it('normalizes approved compact part and operational events without large bodies', async () => {
    const fakeClient = createFakeSdkClient({
      get: async () => ({ data: { directory: '/tmp/project' } }),
      subscribe: async () => ({
        stream: (async function* () {
          yield {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'part-patch-1',
                type: 'patch',
                hash: 'abcdef1234567890',
                files: ['src/a.ts', 'src/b.ts'],
                sessionID: 'ses-1',
                messageID: 'msg-1',
              },
            },
          }
          yield {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'part-retry-1',
                type: 'retry',
                attempt: 2,
                error: { data: { message: 'rate limited' } },
                sessionID: 'ses-1',
                messageID: 'msg-1',
              },
            },
          }
          yield {
            payload: {
              type: 'file.edited',
              properties: { file: 'src/a.ts' },
            },
            directory: '/tmp/project',
          }
          yield {
            type: 'command.executed',
            properties: {
              sessionID: 'ses-1',
              name: 'test',
              arguments: 'npm test',
              messageID: 'msg-1',
            },
          }
          yield { type: 'session.idle', properties: { sessionID: 'ses-1' } }
        })(),
      }),
    })
    const sdkAdapter = new OpenCodeSDKAdapter('http://localhost:4096', fakeClient as unknown as OpenCodeSDKClient)

    const events: StreamEvent[] = []
    for await (const event of sdkAdapter.subscribeToEvents('ses-1')) {
      events.push(event)
    }

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'part_summary',
        partType: 'patch',
        summary: expect.stringContaining('2 files'),
      }),
      expect.objectContaining({
        type: 'part_summary',
        partType: 'retry',
        severity: 'error',
        summary: expect.stringContaining('rate limited'),
      }),
      expect.objectContaining({
        type: 'file_edited',
        file: 'src/a.ts',
      }),
      expect.objectContaining({
        type: 'debug_event',
        eventName: 'command.executed',
        summary: expect.stringContaining('npm test'),
      }),
    ]))
  })

  it('reports Timeout as an ERROR event, not as a CancelledError', async () => {
    const deferredResponse = createDeferred<string>()
    const testAdapter = new TestOpenCodeAdapter([deferredResponse])
    const errors: unknown[] = []

    const runPromise = runOpenCodeSessionPrompt({
      adapter: testAdapter,
      session: { id: 'ses-timeout-test' },
      parts: [{ type: 'text', content: 'test prompt' }],
      timeoutMs: 50,
      onStreamError: (err) => {
        errors.push(err)
      },
    })

    await expect(runPromise).rejects.toThrow('Timeout')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toBe('Timeout')
    // Verify it's NOT a CancelledError
    expect((errors[0] as Error).name).not.toBe('CancelledError')
  })

  it('reports workflow-scoped prompt deadline as WorkflowDeadlineTimeoutError', async () => {
    const deferredResponse = createDeferred<string>()
    const testAdapter = new TestOpenCodeAdapter([deferredResponse])
    const errors: unknown[] = []

    const runPromise = runOpenCodeSessionPrompt({
      adapter: testAdapter,
      session: { id: 'ses-workflow-timeout' },
      parts: [{ type: 'text', content: 'test prompt' }],
      timeoutMs: 25,
      deadlineScope: 'workflow',
      skipSessionValidation: true,
      sessionOwnership: {
        ticketId: 'ticket-1',
        phase: 'CODING',
        beadId: 'bead-1',
        iteration: 3,
        keepActive: true,
      },
      onStreamError: (err) => {
        errors.push(err)
      },
    })

    await expect(runPromise).rejects.toBeInstanceOf(WorkflowDeadlineTimeoutError)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(WorkflowDeadlineTimeoutError)
    expect((errors[0] as Error).message).toContain('Iteration timeout for bead bead-1 attempt 3')
  })

  it('keeps workflow-scoped deadline typed when the adapter reports a generic Timeout after abort', async () => {
    class TimeoutOnAbortAdapter extends TestOpenCodeAdapter {
      constructor() {
        super([])
      }

      override async promptSession(
        sessionId: string,
        parts: PromptPart[],
        signal?: AbortSignal,
        options?: PromptSessionOptions,
      ): Promise<string> {
        this.promptCalls.push({ sessionId, parts, options })
        const activeSignal = options?.signal ?? signal
        if (!activeSignal) throw new Error('Missing abort signal')
        return await new Promise<string>((_, reject) => {
          const rejectTimeout = () => reject(new Error('Timeout'))
          if (activeSignal.aborted) {
            rejectTimeout()
            return
          }
          activeSignal.addEventListener('abort', rejectTimeout, { once: true })
        })
      }
    }

    const testAdapter = new TimeoutOnAbortAdapter()
    const errors: unknown[] = []

    const runPromise = runOpenCodeSessionPrompt({
      adapter: testAdapter,
      session: { id: 'ses-generic-timeout' },
      parts: [{ type: 'text', content: 'test prompt' }],
      timeoutMs: 25,
      deadlineScope: 'workflow',
      skipSessionValidation: true,
      sessionOwnership: {
        ticketId: 'ticket-1',
        phase: 'CODING',
        beadId: 'bead-2',
        iteration: 4,
        keepActive: true,
      },
      onStreamError: (err) => {
        errors.push(err)
      },
    })

    await expect(runPromise).rejects.toBeInstanceOf(WorkflowDeadlineTimeoutError)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(WorkflowDeadlineTimeoutError)
    expect(testAdapter.abortCalls).toEqual(['ses-generic-timeout'])
  })
})

describe('buildFormattedBatchAnswers', () => {
  it('formats free_text answers unchanged', () => {
    const result = buildFormattedBatchAnswers(
      [{ id: 'Q01' }],
      { Q01: 'My answer' },
    )
    expect(result.Q01).toBe('My answer')
  })

  it('formats single_choice with selected option labels', () => {
    const result = buildFormattedBatchAnswers(
      [{ id: 'Q01', answerType: 'single_choice', options: [{ id: 'opt1', label: 'PostgreSQL' }, { id: 'opt2', label: 'MySQL' }] }],
      { Q01: '' },
      { Q01: ['opt1'] },
    )
    expect(result.Q01).toBe('Selected: "PostgreSQL"')
  })

  it('formats multiple_choice with notes', () => {
    const result = buildFormattedBatchAnswers(
      [{ id: 'Q01', answerType: 'multiple_choice', options: [{ id: 'a', label: 'Web' }, { id: 'b', label: 'iOS' }] }],
      { Q01: 'Also need desktop' },
      { Q01: ['a', 'b'] },
    )
    expect(result.Q01).toBe('Selected: "Web", "iOS". Notes: Also need desktop')
  })

})
