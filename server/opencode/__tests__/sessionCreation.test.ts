import { describe, expect, it } from 'vitest'
import type { OpenCodeAdapter } from '../adapter'
import { createOpenCodeSessionWithRetry } from '../sessionCreation'
import { buildOpenCodeBlockedErrorDiagnostics } from '../blockedErrorDiagnostics'
import type {
  HealthStatus,
  Message,
  OpenCodeQuestionAnswer,
  OpenCodeQuestionRequest,
  OpenCodeSessionCreateOptions,
  PromptPart,
  PromptSessionOptions,
  Session,
  StreamEvent,
} from '../types'

class TestOpenCodeAdapter implements OpenCodeAdapter {
  public readonly createCalls: Array<{
    projectPath: string
    signal?: AbortSignal
    options?: OpenCodeSessionCreateOptions
  }> = []
  public healthCalls = 0

  constructor(
    private readonly createOutcomes: Array<Session | Error>,
    private readonly healthStatus: HealthStatus = { available: true, version: 'test' },
  ) {}

  async createSession(
    projectPath: string,
    signal?: AbortSignal,
    options?: OpenCodeSessionCreateOptions,
  ): Promise<Session> {
    this.createCalls.push({ projectPath, signal, options })
    const outcome = this.createOutcomes.shift()
    if (outcome instanceof Error) throw outcome
    return outcome ?? { id: `session-${this.createCalls.length}`, projectPath }
  }

  async promptSession(
    _sessionId: string,
    _parts: PromptPart[],
    _signal?: AbortSignal,
    _options?: PromptSessionOptions,
  ): Promise<string> {
    return ''
  }

  async listSessions(): Promise<Session[]> {
    return []
  }

  async getSession(_sessionId: string): Promise<Session | null> {
    return null
  }

  async getSessionMessages(): Promise<Message[]> {
    return []
  }

  async *subscribeToEvents(_sessionId: string): AsyncGenerator<StreamEvent> {
    yield { type: 'done', sessionId: _sessionId }
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

  async abortSession(): Promise<boolean> {
    return true
  }

  async assembleBeadContext(): Promise<PromptPart[]> {
    return []
  }

  async assembleCouncilContext(): Promise<PromptPart[]> {
    return []
  }

  async checkHealth(): Promise<HealthStatus> {
    this.healthCalls += 1
    return this.healthStatus
  }
}

describe('createOpenCodeSessionWithRetry', () => {
  it('retries failed session creation attempts before returning the successful session', async () => {
    const adapter = new TestOpenCodeAdapter([
      new Error('empty session payload'),
      new Error('connection reset'),
      { id: 'session-3', projectPath: '/tmp/project' },
    ])

    const session = await createOpenCodeSessionWithRetry(
      adapter,
      '/tmp/project',
      undefined,
      undefined,
      { retryDelaysMs: [0, 0, 0] },
    )

    expect(session.id).toBe('session-3')
    expect(adapter.createCalls).toHaveLength(3)
    expect(adapter.healthCalls).toBe(2)
  })

  it('reports the final session creation failure after the initial attempt and three retries', async () => {
    const adapter = new TestOpenCodeAdapter([
      new Error('failure one'),
      new Error('failure two'),
      new Error('failure three'),
      new Error('failure four'),
    ], { available: false, error: 'OpenCode unreachable' })

    await expect(createOpenCodeSessionWithRetry(
      adapter,
      '/tmp/project',
      undefined,
      undefined,
      { retryDelaysMs: [0, 0, 0] },
    )).rejects.toThrow(/after 4 attempts.*failure four.*OpenCode health check: unavailable: OpenCode unreachable/s)

    expect(adapter.createCalls).toHaveLength(4)
    expect(adapter.healthCalls).toBe(4)
  })

  it('stops retrying immediately when the caller aborts during retry delay', async () => {
    const adapter = new TestOpenCodeAdapter([
      new Error('temporary failure'),
      { id: 'session-2', projectPath: '/tmp/project' },
    ])
    const controller = new AbortController()

    const sessionPromise = createOpenCodeSessionWithRetry(
      adapter,
      '/tmp/project',
      controller.signal,
      undefined,
      { retryDelaysMs: [1000] },
    )

    await Promise.resolve()
    controller.abort()

    await expect(sessionPromise).rejects.toThrow(/abort/i)
    expect(adapter.createCalls).toHaveLength(1)
  })

  it('retains the final creation failure cause and known operation after exhausting retries', async () => {
    const failure = Object.assign(new Error('Failed to create OpenCode session: fetch failed', { cause:
      new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND opencode.local'), { code: 'ENOTFOUND' }) }),
    }), { openCodeOperation: 'creating an OpenCode session' })
    const adapter = new TestOpenCodeAdapter([
      new Error('earlier creation failure'), failure,
    ], { available: false, error: 'fetch failed' })
    const error = await createOpenCodeSessionWithRetry(adapter, '/tmp/project', undefined, undefined, { retryDelaysMs: [0] })
      .catch((failure: unknown) => failure)

    expect(error).toMatchObject({ cause: failure, openCodeOperation: 'creating an OpenCode session' })
    const result = buildOpenCodeBlockedErrorDiagnostics({ error, modelId: 'provider/model' })
    expect(result.diagnostics).toMatchObject({
      operation: 'creating an OpenCode session', transportCode: 'ENOTFOUND',
      causeMessage: 'getaddrinfo ENOTFOUND opencode.local', modelId: 'provider/model',
    })
    expect(result.diagnostics?.sessionId).toBeUndefined()
    expect(result.diagnostics?.summary).toContain('Captured connection details are available in Technical details.')
    expect(result.diagnostics?.summary).not.toContain('..')
    expect(adapter.createCalls).toHaveLength(2)
  })
})
