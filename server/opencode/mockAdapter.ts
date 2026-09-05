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
} from './types'
import type { OpenCodeAdapter } from './adapter'
import { closeTag, openTag, PROTOCOL_TAGS } from '@shared/protocolTags'

export class MockOpenCodeAdapter implements OpenCodeAdapter {
  public sessions: Session[] = []
  public messages: Map<string, Message[]> = new Map()
  public mockResponses: Map<string, string> = new Map()
  public mockStreamEvents: Map<string, StreamEvent[]> = new Map()
  public mockAssistantInfos: Map<string, Partial<MessageInfo>> = new Map()
  public mockSessionCreateFailures: unknown[] = []
  public mockQuestions: OpenCodeQuestionRequest[] = []
  public questionReplies: Array<{ requestId: string; answers: OpenCodeQuestionAnswer[]; projectPath?: string }> = []
  public questionRejections: Array<{ requestId: string; projectPath?: string }> = []
  /**
   * Makes `rejectQuestion` throw.
   *
   * An expiry that cannot reject recreates the hang this feature exists to
   * prevent, so the fallback has to be testable.
   */
  public failRejectQuestion = false
  public sessionCreateCalls: Array<{
    projectPath: string
    options?: OpenCodeSessionCreateOptions
  }> = []
  public promptCalls: Array<{
    sessionId: string
    parts: PromptPart[]
    options?: PromptSessionOptions
  }> = []
  private sessionCounter = 0

  async createSession(
    projectPath: string,
    _signal?: AbortSignal,
    options?: OpenCodeSessionCreateOptions,
  ): Promise<Session> {
    this.sessionCreateCalls.push({ projectPath, options })
    const failure = this.mockSessionCreateFailures.shift()
    if (failure) throw failure instanceof Error ? failure : new Error(String(failure))
    const session: Session = {
      id: `mock-session-${++this.sessionCounter}`,
      projectPath,
      createdAt: new Date().toISOString(),
    }
    this.sessions.push(session)
    return session
  }

  async promptSession(
    sessionId: string,
    parts: PromptPart[],
    _signal?: AbortSignal,
    options?: PromptSessionOptions,
  ): Promise<string> {
    this.promptCalls.push({ sessionId, parts, options })
    const promptText = parts.map(part => part.content).join('\n')
    const response = this.mockResponses.get(sessionId) ?? this.buildMockResponse(promptText)
    const queuedStreamEvents = this.mockStreamEvents.get(sessionId) ?? []
    const queuedAssistantInfo = this.mockAssistantInfos.get(sessionId)

    const messages = this.messages.get(sessionId) ?? []
    for (const part of parts) {
      messages.push({
        id: `msg-${Date.now()}`,
        role: 'user',
        content: part.content,
        timestamp: new Date().toISOString(),
      })
    }

    for (const event of queuedStreamEvents) {
      options?.onEvent?.(event)
    }

    const assistantMessageId = `msg-${Date.now()}-resp`
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: response,
      timestamp: new Date().toISOString(),
      ...(queuedAssistantInfo
        ? {
            info: {
              id: assistantMessageId,
              sessionID: sessionId,
              role: 'assistant',
              ...queuedAssistantInfo,
            },
          }
        : {}),
    }
    messages.push(assistantMessage)
    this.messages.set(sessionId, messages)

    options?.onEvent?.({
      type: 'text',
      sessionId,
      messageId: assistantMessage.id,
      partId: `part-${assistantMessage.id}`,
      text: response,
      streaming: false,
      complete: true,
    })
    options?.onEvent?.({ type: 'done', sessionId })

    return response
  }

  private buildMockResponse(promptText: string): string {
    if (promptText.includes('Score each draft')) {
      const draftCount = Array.from(promptText.matchAll(/Draft\s+\d+:/g)).length || 3
      const rubricCategories = Array.from(promptText.matchAll(/- ([^\n(]+?) \(\d+pts\):/g))
        .map((match) => match[1]?.trim())
        .filter((category): category is string => Boolean(category))
      const fallbackCategories = [
        'Coverage of requirements',
        'Correctness / feasibility',
        'Testability',
        'Minimal complexity / good decomposition',
        'Risks / edge cases addressed',
      ]
      const categories = rubricCategories.length > 0 ? rubricCategories : fallbackCategories
      const renderDraft = (label: string, scores: number[]) => [
        `  ${label}:`,
        ...categories.map((category, index) => `    ${category}: ${scores[index] ?? 15}`),
        `    total_score: ${categories.reduce((sum, _, index) => sum + (scores[index] ?? 15), 0)}`,
      ]
      const scoreRows = Array.from({ length: draftCount }, (_, index) => {
        const score = Math.max(12, 18 - index)
        return Array.from({ length: categories.length }, () => score)
      })
      return [
        'draft_scores:',
        ...scoreRows.flatMap((scores, index) => renderDraft(`Draft ${index + 1}`, scores)),
      ].join('\n')
    }

    if (promptText.includes('## Winning Draft')) {
      return 'Mock refined response'
    }

    if (promptText.includes(PROTOCOL_TAGS.FINAL_TEST_COMMANDS)) {
      return [
        openTag(PROTOCOL_TAGS.FINAL_TEST_COMMANDS),
        '{"commands":["echo mock-final-test"],"summary":"mock final test plan"}',
        closeTag(PROTOCOL_TAGS.FINAL_TEST_COMMANDS),
      ].join('')
    }

    if (promptText.includes('reply with exactly OK') || promptText.includes('reply with exactly `OK`')) {
      return 'OK'
    }

    return 'Mock response'
  }

  async listSessions(): Promise<Session[]> {
    return this.sessions
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.sessions.find((session) => session.id === sessionId) ?? null
  }

  async getSessionMessages(sessionId: string): Promise<Message[]> {
    return this.messages.get(sessionId) ?? []
  }

  async listPendingQuestions(projectPath?: string): Promise<OpenCodeQuestionRequest[]> {
    return this.mockQuestions.filter((question) => {
      const session = this.sessions.find((candidate) => candidate.id === question.sessionID)
      return !projectPath || session?.projectPath === projectPath || session?.directory === projectPath
    })
  }

  async replyQuestion(requestId: string, answers: OpenCodeQuestionAnswer[], projectPath?: string): Promise<void> {
    this.questionReplies.push({ requestId, answers, ...(projectPath ? { projectPath } : {}) })
    this.mockQuestions = this.mockQuestions.filter((question) => question.id !== requestId)
  }

  async rejectQuestion(requestId: string, projectPath?: string): Promise<void> {
    if (this.failRejectQuestion) {
      throw new Error(`Mock adapter refused to reject question ${requestId}`)
    }
    this.questionRejections.push({ requestId, ...(projectPath ? { projectPath } : {}) })
    this.mockQuestions = this.mockQuestions.filter((question) => question.id !== requestId)
  }

  async abortSession(_sessionId: string): Promise<boolean> {
    return true
  }

  async *subscribeToEvents(sessionId: string, _signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    yield { type: 'done', sessionId }
  }

  async assembleBeadContext(_ticketId: string, _beadId: string): Promise<PromptPart[]> {
    return [{ type: 'text', content: 'Mock bead context' }]
  }

  async assembleCouncilContext(_ticketId: string, _phase: string): Promise<PromptPart[]> {
    return [{ type: 'text', content: 'Mock council context' }]
  }

  async checkHealth(): Promise<HealthStatus> {
    return { available: true, version: 'mock-1.0.0', models: ['mock-model-1', 'mock-model-2'] }
  }
}
