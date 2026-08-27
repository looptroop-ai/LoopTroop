import { describe, expect, it } from 'vitest'
import type { OpenCodeAdapter } from '../../../opencode/adapter'
import { OPENCODE_READ_ONLY_PERMISSIONS } from '../../../opencode/toolPolicy'
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
} from '../../../opencode/types'
import { buildMinimalContext, clearContextCache } from '../../../opencode/contextBuilder'
import { draftPRD } from '../draft'
import { buildPrdVotePrompt } from '../../../workflow/phases/prdPhase'
import { TEST, makeInterviewYaml, makeInterviewQuestion, makePrdYaml } from '../../../test/factories'

class TestOpenCodeAdapter implements OpenCodeAdapter {
  public sessions: Session[] = []
  public messages = new Map<string, Message[]>()
  public promptCalls: Array<{
    sessionId: string
    parts: PromptPart[]
    options?: PromptSessionOptions
  }> = []
  private readonly queuedResponses: Array<string | { response: string; error?: string; messageContent?: string }>
  private sessionCounter = 0

  constructor(responses: Array<string | { response: string; error?: string; messageContent?: string }>) {
    this.queuedResponses = [...responses]
  }

  async createSession(
    projectPath: string,
    _signal?: AbortSignal,
    _options?: OpenCodeSessionCreateOptions,
  ): Promise<Session> {
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
    const queued = this.queuedResponses.shift() ?? 'assistant response'
    const response = typeof queued === 'string' ? queued : queued.response
    const messageContent = typeof queued === 'string' ? response : (queued.messageContent ?? response)
    const messages = this.messages.get(sessionId) ?? []

    for (const part of parts) {
      messages.push({
        id: `msg-${sessionId}-${messages.length + 1}`,
        role: 'user',
        content: part.content,
        timestamp: new Date().toISOString(),
      })
    }

    const assistantMessage: Message = {
      id: `msg-${sessionId}-${messages.length + 1}`,
      role: 'assistant',
      content: messageContent,
      timestamp: new Date().toISOString(),
      ...(typeof queued === 'string' || !queued.error
        ? {}
        : {
            info: {
              id: `msg-${sessionId}-${messages.length + 1}`,
              sessionID: sessionId,
              error: queued.error,
            },
          }),
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

  async listSessions(): Promise<Session[]> { return this.sessions }
  async getSession(sessionId: string): Promise<Session | null> { return this.sessions.find((session) => session.id === sessionId) ?? null }
  async getSessionMessages(sessionId: string): Promise<Message[]> { return this.messages.get(sessionId) ?? [] }
  async listPendingQuestions(): Promise<OpenCodeQuestionRequest[]> { return [] }
  async replyQuestion(_requestId: string, _answers: OpenCodeQuestionAnswer[]): Promise<void> { return undefined }
  async rejectQuestion(_requestId: string): Promise<void> { return undefined }
  async *subscribeToEvents(sessionId: string, _signal?: AbortSignal): AsyncGenerator<StreamEvent> { yield { type: 'done', sessionId } }
  async abortSession(_sessionId: string): Promise<boolean> { return true }
  async assembleBeadContext(_ticketId: string, _beadId: string): Promise<PromptPart[]> { return [] }
  async assembleCouncilContext(_ticketId: string, _phase: string): Promise<PromptPart[]> { return [] }
  async checkHealth(): Promise<HealthStatus> { return { available: true } }
}

/**
 * Never answers on its own, so a timeout test cannot race a sleeping model
 * against the deadline: only the deadline can settle the prompt.
 */
class StalledTestOpenCodeAdapter extends TestOpenCodeAdapter {
  override promptSession(
    _sessionId: string, _parts: PromptPart[], signal?: AbortSignal, _options?: PromptSessionOptions,
  ): Promise<string> {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        const abortError = new Error('Aborted')
        abortError.name = 'AbortError'
        reject(abortError)
      }, { once: true })
    })
  }
}

const COUNCIL = [{ modelId: 'model-a', name: 'Model A' }]
/**
 * Long enough that no test here can reach it by accident. Only the timeout test
 * sets a budget it means to exhaust; every other assertion is about content, and
 * a short wall-clock budget turns a loaded CI worker into a spurious failure.
 */
const DRAFT_OPTS = { draftTimeoutMs: 300_000, minQuorum: 1, ticketExternalId: TEST.externalId }
const DEADLINE_MS = 250
const GENERATED_BY = { winner_model: 'model-a', generated_at: TEST.timestamp }
const ANSWERED = {
  skipped: false, selected_option_ids: [] as string[], free_text: 'Preserve council retry behavior and strict validation.',
  answered_by: 'ai_skip', answered_at: TEST.timestamp, skip_reason: null,
} as const

function resolvedYaml() {
  return makeInterviewYaml({
    status: 'draft', generated_by: GENERATED_BY,
    questions: [makeInterviewQuestion({ answer: { ...ANSWERED } })],
  })
}

function ticket(title: string, description: string, interview = makeInterviewYaml()) {
  return { ticketId: TEST.externalId, title, description, interview }
}

describe.concurrent('draftPRD', () => {
  it('builds the PRD voting prompt with anonymized drafts and a strict scorecard reminder', () => {
    const prompt = buildPrdVotePrompt(
      {
        ticketId: TEST.externalId, title: 'Vote on PRD drafts',
        description: 'Compare PRD candidates.', relevantFiles: 'files:\n  - path: src/main.ts',
        interview: `schema_version: 1\nticket_id: ${TEST.externalId}\nartifact: interview\nstatus: approved`,
      },
      [
        { draftId: 'model-a', content: 'Draft 1:\nMock PRD alpha' },
        { draftId: 'model-b', content: 'Draft 2:\nMock PRD beta' },
      ],
    )
    const rendered = prompt.map((part) => part.content).join('\n')
    expect(rendered).toContain('You are an impartial judge on an AI Council.')
    expect(rendered).toContain('## Context')
    expect(rendered).toContain('### draft')
    expect(rendered).toContain('Draft 1:')
    expect(rendered).toContain('Draft 2:')
    expect(rendered).toContain('Use the exact PROM11 `draft_scores` YAML schema')
    expect(rendered).toContain('Coverage of requirements')
    expect(rendered).toContain('Correctness / feasibility')
  })

  it('clears stale cached interview context before building Full Answers prompts and adds the runtime checklist', async () => {
    clearContextCache(TEST.externalId)

    try {
      const answeredByUser = {
        skipped: false,
        selected_option_ids: [],
        free_text: 'Keep the approved answer verbatim.',
        answered_by: 'user' as const,
        answered_at: TEST.timestamp, skip_reason: null,
      }
      const staleInterview = makeInterviewYaml({
        questions: [
          makeInterviewQuestion({ id: 'Q01', answer: answeredByUser }),
          makeInterviewQuestion({ id: 'Q02', phase: 'Structure', prompt: 'What scope stays minimal?' }),
        ],
      })
      const canonicalInterview = makeInterviewYaml({
        questions: [
          makeInterviewQuestion({ id: 'Q01', answer: answeredByUser }),
          makeInterviewQuestion({ id: 'Q02', phase: 'Structure', prompt: 'What scope stays minimal?' }),
          makeInterviewQuestion({
            id: 'Q02_confirm',
            phase: 'Structure',
            prompt: 'Confirm the same minimal scope for PRD drafting.',
            source: 'coverage_follow_up',
            follow_up_round: 1,
          }),
        ],
        follow_up_rounds: [{ round_number: 1, source: 'coverage', question_ids: ['Q02_confirm'] }],
      })
      const resolvedInterview = makeInterviewYaml({
        status: 'draft',
        generated_by: GENERATED_BY,
        questions: [
          makeInterviewQuestion({ id: 'Q01', answer: answeredByUser }),
          makeInterviewQuestion({
            id: 'Q02',
            phase: 'Structure',
            prompt: 'What scope stays minimal?',
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Keep the scope minimal.',
              answered_by: 'ai_skip',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
          makeInterviewQuestion({
            id: 'Q02_confirm',
            phase: 'Structure',
            prompt: 'Confirm the same minimal scope for PRD drafting.',
            source: 'coverage_follow_up',
            follow_up_round: 1,
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Yes, keep the same minimal scope.',
              answered_by: 'ai_skip',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
        ],
        follow_up_rounds: [{ round_number: 1, source: 'coverage', question_ids: ['Q02_confirm'] }],
      })
      buildMinimalContext('prd_draft', {
        ticketId: TEST.externalId,
        title: 'Seed stale cache',
        description: 'Old prompt context that should be discarded.',
        interview: staleInterview,
      })

      const adapter = new TestOpenCodeAdapter([resolvedInterview, makePrdYaml()])

      const result = await draftPRD(adapter, COUNCIL,
        ticket('Refresh cached interview context', 'Ensure the current canonical interview is used.', canonicalInterview),
        '/tmp/test', DRAFT_OPTS,
      )

      const firstPrompt = adapter.promptCalls[0]?.parts.map((part) => part.content).join('\n') ?? ''

      expect(result.fullAnswers[0]?.outcome).toBe('completed')
      expect(firstPrompt).toContain('### full_answers_runtime_checklist')
      expect(firstPrompt).toContain('canonical_question_count: 3')
      expect(firstPrompt).toContain('canonical_question_ids: [Q01, Q02, Q02_confirm]')
      expect(firstPrompt).toContain('skipped_question_ids: [Q02, Q02_confirm]')
      expect(firstPrompt).toContain('coverage_follow_up questions are canonical questions too and must not be omitted')
      expect(firstPrompt).toContain('- id: Q02_confirm')
      expect(firstPrompt).not.toContain('canonical_question_count: 2')
      expect(firstPrompt).toContain('# Ticket: Refresh cached interview context')
      expect(firstPrompt).not.toContain('# Ticket: Seed stale cache')
    } finally {
      clearContextCache(TEST.externalId)
    }
  })

  it('salvages near-miss full answers without using a structured retry', async () => {
    const adapter = new TestOpenCodeAdapter([
      makeInterviewYaml({
        generated_by: GENERATED_BY,
        questions: [makeInterviewQuestion({
          phase: 'Assembly', prompt: 'Rewritten prompt that should be ignored',
          answer: { ...ANSWERED, answered_by: 'user' },
        })],
        summary: { goals: ['Changed summary'], constraints: [], non_goals: [], final_free_form_answer: '' },
        approval: { approved_by: 'user', approved_at: TEST.timestamp },
      }),
      makePrdYaml(),
    ])

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Salvage near-miss full answers', 'Treat the approved interview as canonical structure for future tickets.'),
      '/tmp/test', DRAFT_OPTS,
    )

    expect(result.fullAnswers[0]).toMatchObject({
      memberId: 'model-a', outcome: 'completed',
      structuredOutput: { autoRetryCount: 0, repairApplied: true },
    })
    expect(result.fullAnswers[0]?.content).toContain('prompt: What are the key requirements?')
    expect(result.fullAnswers[0]?.content).not.toContain('Rewritten prompt that should be ignored')
    expect(adapter.messages.get('mock-session-1')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
  })

  it('uses the complete latest assistant message when the immediate full-answers response is a truncated prefix', async () => {
    const fullAnswers = resolvedYaml()
    const adapter = new TestOpenCodeAdapter([
      { response: fullAnswers.slice(0, fullAnswers.indexOf('follow_up_rounds:')), messageContent: fullAnswers },
      makePrdYaml(),
    ])

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Prefer full assistant snapshot', 'Use the latest assistant artifact when the immediate response is only a prefix.'),
      '/tmp/test', DRAFT_OPTS,
    )

    expect(result.fullAnswers[0]).toMatchObject({ memberId: 'model-a', outcome: 'completed', structuredOutput: { autoRetryCount: 0 } })
    expect(result.fullAnswers[0]?.content).toContain('follow_up_rounds: []')
    expect(result.drafts[0]).toMatchObject({ memberId: 'model-a', outcome: 'completed', draftMetrics: { epicCount: 1, userStoryCount: 1 } })
    expect(adapter.messages.get('mock-session-1')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
  })

  it('skips full answers and creates only one PRD session when no interview questions are skipped', async () => {
    const adapter = new TestOpenCodeAdapter([makePrdYaml()])
    const fullAnswerProgress: Array<{ status: string; sessionId?: string }> = []
    const draftProgress: Array<{ status: string; sessionId?: string }> = []
    const stepEvents: Array<{ step: string; status: string }> = []

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Keep PRD sessions isolated', 'Skip gap resolution when the approved interview is complete.',
        makeInterviewYaml({
          questions: [makeInterviewQuestion({
            answer: { skipped: false, selected_option_ids: [], free_text: 'Use explicit PRD session boundaries.', answered_by: 'user', answered_at: TEST.timestamp, skip_reason: null },
          })],
        }),
      ),
      '/tmp/test', DRAFT_OPTS, undefined, undefined, undefined, undefined,
      (entry) => { draftProgress.push({ status: entry.status, sessionId: entry.sessionId }) },
      (entry) => { fullAnswerProgress.push({ status: entry.status, sessionId: entry.sessionId }) },
      (entry) => { stepEvents.push({ step: entry.step, status: entry.status }) },
    )

    expect(result.fullAnswers[0]).toMatchObject({ memberId: 'model-a', outcome: 'completed', questionCount: 1 })
    expect(result.fullAnswers[0]?.content).toContain('answered_by: user')
    expect(result.drafts[0]).toMatchObject({ memberId: 'model-a', outcome: 'completed', draftMetrics: { epicCount: 1, userStoryCount: 1 } })
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1'])
    expect(fullAnswerProgress).toEqual([{ status: 'finished', sessionId: undefined }])
    expect(draftProgress).toEqual([
      { status: 'session_created', sessionId: 'mock-session-1' },
      { status: 'finished', sessionId: 'mock-session-1' },
    ])
    expect(stepEvents).toEqual([
      { step: 'full_answers', status: 'skipped' },
      { step: 'prd_draft', status: 'started' },
      { step: 'prd_draft', status: 'completed' },
    ])
  })

  it('does not run Full Answers just because answered text mentions skipped syntax', async () => {
    const adapter = new TestOpenCodeAdapter([makePrdYaml()])
    const fullAnswerProgress: Array<{ status: string; sessionId?: string }> = []
    const stepEvents: Array<{ step: string; status: string }> = []
    const canonicalInterview = makeInterviewYaml({
      questions: [makeInterviewQuestion({
        answer: {
          skipped: false,
          selected_option_ids: [],
          free_text: 'Preserve this answer even though it mentions skipped: true as literal text.',
          answered_by: 'user',
          answered_at: TEST.timestamp, skip_reason: null,
        },
      })],
    })

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Ignore literal skipped text', 'Only actual answer flags should trigger Full Answers.', canonicalInterview),
      '/tmp/test', DRAFT_OPTS, undefined, undefined, undefined, undefined, undefined,
      (entry) => { fullAnswerProgress.push({ status: entry.status, sessionId: entry.sessionId }) },
      (entry) => { stepEvents.push({ step: entry.step, status: entry.status }) },
    )

    expect(result.fullAnswers[0]).toMatchObject({ memberId: 'model-a', outcome: 'completed', questionCount: 1 })
    expect(result.fullAnswers[0]?.content).toContain('mentions skipped: true as literal text')
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1'])
    expect(adapter.promptCalls[0]?.parts.map((part) => part.content).join('\n')).not.toContain('full_answers_runtime_checklist')
    expect(fullAnswerProgress).toEqual([{ status: 'finished', sessionId: undefined }])
    expect(stepEvents).toEqual([
      { step: 'full_answers', status: 'skipped' },
      { step: 'prd_draft', status: 'started' },
      { step: 'prd_draft', status: 'completed' },
    ])
  })

  it.each([
    {
      scenario: 'tracks only skipped compiled questions when no coverage follow-ups are skipped',
      canonicalInterview: makeInterviewYaml({
        questions: [
          makeInterviewQuestion({
            id: 'Q01',
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Keep the approved answer verbatim.',
              answered_by: 'user',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
          makeInterviewQuestion({
            id: 'Q02',
            phase: 'Structure',
            prompt: 'Which parts must stay minimal?',
          }),
          makeInterviewQuestion({
            id: 'Q03',
            phase: 'Assembly',
            prompt: 'Which areas can be deferred?',
          }),
        ],
      }),
      resolvedInterview: makeInterviewYaml({
        status: 'draft',
        generated_by: GENERATED_BY,
        questions: [
          makeInterviewQuestion({
            id: 'Q01',
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Keep the approved answer verbatim.',
              answered_by: 'user',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
          makeInterviewQuestion({
            id: 'Q02',
            phase: 'Structure',
            prompt: 'Which parts must stay minimal?',
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Limit the change to theme selection and shared tokens.',
              answered_by: 'ai_skip',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
          makeInterviewQuestion({
            id: 'Q03',
            phase: 'Assembly',
            prompt: 'Which areas can be deferred?',
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Defer any theme-system redesign.',
              answered_by: 'ai_skip',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
        ],
      }),
      expectedSkippedIds: 'skipped_question_ids: [Q02, Q03]',
      preservedAnswers: ['Keep the approved answer verbatim.'],
    },
    {
      scenario: 'tracks only skipped coverage follow-ups when compiled questions are already answered',
      canonicalInterview: makeInterviewYaml({
        questions: [
          makeInterviewQuestion({
            id: 'Q01',
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Keep the approved answer verbatim.',
              answered_by: 'user',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
          makeInterviewQuestion({
            id: 'CFU1',
            phase: 'Assembly',
            prompt: 'Which exact pink palette should be used?',
            source: 'coverage_follow_up',
            follow_up_round: 1,
          }),
          makeInterviewQuestion({
            id: 'CFU2',
            phase: 'Assembly',
            prompt: 'Should pink persist like the other themes?',
            source: 'coverage_follow_up',
            follow_up_round: 1,
            answer_type: 'single_choice',
            options: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ],
          }),
        ],
        follow_up_rounds: [{ round_number: 1, source: 'coverage', question_ids: ['CFU1', 'CFU2'] }],
      }),
      resolvedInterview: makeInterviewYaml({
        status: 'draft',
        generated_by: GENERATED_BY,
        questions: [
          makeInterviewQuestion({
            id: 'Q01',
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Keep the approved answer verbatim.',
              answered_by: 'user',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
          makeInterviewQuestion({
            id: 'CFU1',
            phase: 'Assembly',
            prompt: 'Which exact pink palette should be used?',
            source: 'coverage_follow_up',
            follow_up_round: 1,
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Use a soft pink palette with #EC4899 as the primary token.',
              answered_by: 'ai_skip',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
          makeInterviewQuestion({
            id: 'CFU2',
            phase: 'Assembly',
            prompt: 'Should pink persist like the other themes?',
            source: 'coverage_follow_up',
            follow_up_round: 1,
            answer_type: 'single_choice',
            options: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ],
            answer: {
              skipped: false,
              selected_option_ids: ['yes'],
              free_text: 'Yes',
              answered_by: 'ai_skip',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
        ],
        follow_up_rounds: [{ round_number: 1, source: 'coverage', question_ids: ['CFU1', 'CFU2'] }],
      }),
      expectedSkippedIds: 'skipped_question_ids: [CFU1, CFU2]',
      preservedAnswers: ['Keep the approved answer verbatim.'],
    },
    {
      scenario: 'keeps mixed compiled and coverage skip tracking question-granular',
      canonicalInterview: makeInterviewYaml({
        questions: [
          makeInterviewQuestion({
            id: 'Q01',
            prompt: 'Which theme behavior still needs a fallback?',
          }),
          makeInterviewQuestion({
            id: 'Q02',
            phase: 'Structure',
            prompt: 'What answer is already locked in?',
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Preserve the existing theme selector.',
              answered_by: 'user',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
          makeInterviewQuestion({
            id: 'CFU1',
            phase: 'Assembly',
            prompt: 'Which palette note was already confirmed?',
            source: 'coverage_follow_up',
            follow_up_round: 1,
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Keep the palette note concise.',
              answered_by: 'user',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
          makeInterviewQuestion({
            id: 'CFU2',
            phase: 'Assembly',
            prompt: 'Which remaining coverage detail should be inferred?',
            source: 'coverage_follow_up',
            follow_up_round: 1,
          }),
        ],
        follow_up_rounds: [{ round_number: 1, source: 'coverage', question_ids: ['CFU1', 'CFU2'] }],
      }),
      resolvedInterview: makeInterviewYaml({
        status: 'draft',
        generated_by: GENERATED_BY,
        questions: [
          makeInterviewQuestion({
            id: 'Q01',
            prompt: 'Which theme behavior still needs a fallback?',
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Infer the fallback from the current light-theme behavior.',
              answered_by: 'ai_skip',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
          makeInterviewQuestion({
            id: 'Q02',
            phase: 'Structure',
            prompt: 'What answer is already locked in?',
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Preserve the existing theme selector.',
              answered_by: 'user',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
          makeInterviewQuestion({
            id: 'CFU1',
            phase: 'Assembly',
            prompt: 'Which palette note was already confirmed?',
            source: 'coverage_follow_up',
            follow_up_round: 1,
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Keep the palette note concise.',
              answered_by: 'user',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
          makeInterviewQuestion({
            id: 'CFU2',
            phase: 'Assembly',
            prompt: 'Which remaining coverage detail should be inferred?',
            source: 'coverage_follow_up',
            follow_up_round: 1,
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Infer the remaining detail from the approved selector behavior.',
              answered_by: 'ai_skip',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
        ],
        follow_up_rounds: [{ round_number: 1, source: 'coverage', question_ids: ['CFU1', 'CFU2'] }],
      }),
      expectedSkippedIds: 'skipped_question_ids: [Q01, CFU2]',
      preservedAnswers: ['Preserve the existing theme selector.', 'Keep the palette note concise.'],
    },
  ])('$scenario', async ({ canonicalInterview, resolvedInterview, expectedSkippedIds, preservedAnswers }) => {
    const adapter = new TestOpenCodeAdapter([resolvedInterview, makePrdYaml()])

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Respect question-level skipped answers', 'Keep PRD full answers scoped to truly skipped questions.', canonicalInterview),
      '/tmp/test', DRAFT_OPTS,
    )

    const firstPrompt = adapter.promptCalls[0]?.parts.map((part) => part.content).join('\n') ?? ''

    expect(result.fullAnswers[0]?.outcome).toBe('completed')
    expect(firstPrompt).toContain('### full_answers_runtime_checklist')
    expect(firstPrompt).toContain(expectedSkippedIds)
    for (const preservedAnswer of preservedAnswers) {
      expect(firstPrompt).toContain(preservedAnswer)
      expect(result.fullAnswers[0]?.content).toContain(preservedAnswer)
    }
  })

  it('retries invalid structured PRD output and keeps normalized metrics', async () => {
    const adapter = new TestOpenCodeAdapter([
      resolvedYaml(),
      'I would draft a PRD with a few epics and stories.',
      [
        '```yaml',
        'schema_version: 1',
        'ticket_id: WRONG-ID',
        'artifact: prd',
        'status: draft',
        'source_interview:',
        '  content_sha256: stale',
        'product:',
        '  problem_statement: Keep PRD drafting resilient.',
        '  target_users: [LoopTroop maintainers]',
        'scope:',
        '  in_scope: [Normalize council PRD drafts]',
        '  out_of_scope: [PRD approval workflow]',
        'technical_requirements:',
        '  architecture_constraints: [Reuse council retry behavior]',
        '  data_model: []',
        '  api_contracts: []',
        '  security_constraints: []',
        '  performance_constraints: []',
        '  reliability_constraints: [Fail fast without canonical interview]',
        '  error_handling_rules: [Persist only normalized YAML]',
        '  tooling_assumptions: [Vitest remains the test runner]',
        'epics:',
        '  - title: Draft parsing parity',
        '    objective: Match interview council draft rigor.',
        '    implementation_steps: [Normalize PRD drafts before persistence]',
        '    user_stories:',
        '      - title: Repair ids deterministically',
        '        acceptance_criteria: [Missing ids are repaired deterministically]',
        '        implementation_steps: [Fill stable fallback ids]',
        '        verification:',
        '          required_commands: [npm run test:server]',
        'risks: []',
        'approval:',
        '  approved_by: ""',
        '  approved_at: ""',
        '```',
      ].join('\n'),
      [
        'schema_version: 1',
        `ticket_id: ${TEST.externalId}`,
        'artifact: prd',
        'status: draft',
        'source_interview:',
        '  content_sha256: stale',
        'product:',
        '  problem_statement: Keep PRD drafting resilient.',
        '  target_users: [LoopTroop maintainers]',
        'scope:',
        '  in_scope: [Normalize council PRD drafts]',
        '  out_of_scope: [PRD approval workflow]',
        'technical_requirements:',
        '  architecture_constraints: [Reuse council retry behavior]',
        '  data_model: []',
        '  api_contracts: []',
        '  security_constraints: []',
        '  performance_constraints: []',
        '  reliability_constraints: [Fail fast without canonical interview]',
        '  error_handling_rules: [Persist only normalized YAML]',
        '  tooling_assumptions: [Vitest remains the test runner]',
        'epics:',
        '  - title: Draft parsing parity',
        '    objective: Match interview council draft rigor.',
        '    implementation_steps: [Normalize PRD drafts before persistence]',
        '    user_stories:',
        '      - title: Repair ids deterministically',
        '        acceptance_criteria: [Missing ids are repaired deterministically]',
        '        implementation_steps: [Fill stable fallback ids]',
        '        verification:',
        '          required_commands: [npm run test:server]',
        'approval:',
        '  approved_by: ""',
        '  approved_at: ""',
      ].join('\n'),
    ])
    const fullAnswerProgress: Array<{ status: string; sessionId?: string }> = []
    const draftProgress: Array<{ status: string; sessionId?: string }> = []

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Harden PRD drafting output', 'Keep the PRD drafting phase strict and restart-safe.'),
      '/tmp/test', DRAFT_OPTS, undefined, undefined, undefined, undefined,
      (entry) => { draftProgress.push({ status: entry.status, sessionId: entry.sessionId }) },
      (entry) => { fullAnswerProgress.push({ status: entry.status, sessionId: entry.sessionId }) },
    )

    expect(result.drafts).toHaveLength(1)
    expect(result.drafts[0]).toMatchObject({
      memberId: 'model-a', outcome: 'completed',
      draftMetrics: { epicCount: 1, userStoryCount: 1 },
      structuredOutput: { autoRetryCount: 1, repairApplied: true },
    })
    expect(result.fullAnswers[0]).toMatchObject({ memberId: 'model-a', outcome: 'completed', questionCount: 1 })
    expect(result.fullAnswers[0]?.content).toContain('answered_by: ai_skip')
    expect(result.drafts[0]?.content).toContain(`ticket_id: ${TEST.externalId}`)
    expect(result.drafts[0]?.content).toContain('id: EPIC-1')
    expect(result.drafts[0]?.structuredOutput?.validationError).toBeTruthy()
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2'])
    expect(fullAnswerProgress).toEqual([
      { status: 'session_created', sessionId: 'mock-session-1' },
      { status: 'finished', sessionId: 'mock-session-1' },
    ])
    expect(draftProgress).toEqual([
      { status: 'session_created', sessionId: 'mock-session-2' },
      { status: 'finished', sessionId: 'mock-session-2' },
    ])
    const messages = Array.from(adapter.messages.values()).flat()
    expect(messages.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(true)
    expect(adapter.messages.get('mock-session-1')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
    expect(adapter.messages.get('mock-session-2')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(true)
    expect(adapter.promptCalls[1]?.options?.permission).toEqual(OPENCODE_READ_ONLY_PERMISSIONS)
  })

  it('keeps full answers structured retries inside the same session while starting PRD drafting in a fresh one', async () => {
    const adapter = new TestOpenCodeAdapter(['This is not valid interview YAML.', resolvedYaml(), makePrdYaml()])
    const fullAnswerProgress: Array<{ status: string; sessionId?: string }> = []
    const draftProgress: Array<{ status: string; sessionId?: string }> = []

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Retry full answers in place', 'Keep retries in-step but isolate PRD drafting into a new session.'),
      '/tmp/test', DRAFT_OPTS, undefined, undefined, undefined, undefined,
      (entry) => { draftProgress.push({ status: entry.status, sessionId: entry.sessionId }) },
      (entry) => { fullAnswerProgress.push({ status: entry.status, sessionId: entry.sessionId }) },
    )

    expect(result.fullAnswers[0]).toMatchObject({ memberId: 'model-a', outcome: 'completed', structuredOutput: { autoRetryCount: 1 } })
    expect(result.drafts[0]).toMatchObject({ memberId: 'model-a', outcome: 'completed', draftMetrics: { epicCount: 1, userStoryCount: 1 } })
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2'])
    expect(fullAnswerProgress).toEqual([
      { status: 'session_created', sessionId: 'mock-session-1' },
      { status: 'finished', sessionId: 'mock-session-1' },
    ])
    expect(draftProgress).toEqual([
      { status: 'session_created', sessionId: 'mock-session-2' },
      { status: 'finished', sessionId: 'mock-session-2' },
    ])
    const fullAnswerRetryMessages = adapter.messages.get('mock-session-1')?.filter((message) => typeof message.content === 'string' && message.content.includes('Full Answers Structured Output Retry')) ?? []
    expect(fullAnswerRetryMessages).toHaveLength(1)
    expect(fullAnswerRetryMessages[0]?.content).toContain('Only these skipped question answers may change: Q01')
    expect(fullAnswerRetryMessages[0]?.content).toContain('Canonical approved interview artifact')
    expect(fullAnswerRetryMessages[0]?.content).toContain('What are the key requirements?')
    expect(fullAnswerRetryMessages[0]?.content).not.toContain('generated_by:')
    expect(fullAnswerRetryMessages[0]?.content).toContain('Keep every generated free_text answer concise')
    expect(fullAnswerRetryMessages[0]?.content).toContain('For any `free_text` question with `answer.skipped: false`, `free_text` must be non-empty.')
    expect(fullAnswerRetryMessages[0]?.content).toContain('If the final free-form question has nothing else to add')
    expect(fullAnswerRetryMessages[0]?.content).toContain('If an earlier answer makes a follow-up question not applicable')
    expect(fullAnswerRetryMessages[0]?.content).toContain('If any free_text contains `:`')
    expect(fullAnswerRetryMessages[0]?.content).toContain('`selected_option_ids` must still use the existing canonical option IDs')
    expect(fullAnswerRetryMessages[0]?.content).toContain('Treat single_choice and multiple_choice options as orientation only, not as the full answer')
    expect(fullAnswerRetryMessages[0]?.content).toContain('use concise `free_text` when nuance, caveats, or a better suggestion matter')
    expect(fullAnswerRetryMessages[0]?.content).toContain('Set `status: draft`')
    expect(fullAnswerRetryMessages[0]?.content).toContain('keep `approval.approved_by: ""` plus `approval.approved_at: ""`')
    expect(fullAnswerRetryMessages[0]?.content).toContain('Stop immediately after the final approval block')
    expect(fullAnswerRetryMessages[0]?.content).not.toContain('Do not change `follow_up_rounds`, `summary`, or approval fields.')
    expect(adapter.messages.get('mock-session-2')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
    expect(adapter.promptCalls[0]?.options?.permission).toEqual(OPENCODE_READ_ONLY_PERMISSIONS)
  })

  it('restarts full answers in a fresh session when the model leaves skipped questions unanswered', async () => {
    const adapter = new TestOpenCodeAdapter([
      makeInterviewYaml({ status: 'draft', generated_by: GENERATED_BY }),
      resolvedYaml(),
      makePrdYaml(),
    ])

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Restart unanswered full answers', 'Incomplete semantic full-answers artifacts should restart cleanly.'),
      '/tmp/test', DRAFT_OPTS,
    )

    expect(result.fullAnswers[0]).toMatchObject({ memberId: 'model-a', outcome: 'completed', structuredOutput: { autoRetryCount: 1 } })
    expect(result.drafts[0]?.outcome).toBe('completed')
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2', 'mock-session-3'])
    expect(adapter.messages.get('mock-session-1')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
    expect(adapter.messages.get('mock-session-2')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
  })

  it('restarts full answers in a fresh session when the model omits canonical questions', async () => {
    const twoQResolved = makeInterviewYaml({
      status: 'draft', generated_by: GENERATED_BY,
      questions: [
        makeInterviewQuestion({ id: 'Q01', answer: { ...ANSWERED } }),
        makeInterviewQuestion({
          id: 'Q02', phase: 'Structure', prompt: 'Which session isolation guarantees are mandatory?',
          answer: { ...ANSWERED, free_text: 'Fresh-session retries must not inherit drifting context from invalid artifacts.' },
        }),
      ],
    })
    const adapter = new TestOpenCodeAdapter([resolvedYaml(), twoQResolved, makePrdYaml()])

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Restart missing-question full answers', 'Missing canonical questions should force a clean retry session.',
        makeInterviewYaml({
          questions: [
            makeInterviewQuestion({ id: 'Q01' }),
            makeInterviewQuestion({ id: 'Q02', phase: 'Structure', prompt: 'Which session isolation guarantees are mandatory?' }),
          ],
        }),
      ),
      '/tmp/test', DRAFT_OPTS,
    )

    expect(result.fullAnswers[0]).toMatchObject({ memberId: 'model-a', outcome: 'completed', questionCount: 2, structuredOutput: { autoRetryCount: 1 } })
    expect(result.drafts[0]?.outcome).toBe('completed')
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2', 'mock-session-3'])
    expect(adapter.messages.get('mock-session-1')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
    expect(adapter.messages.get('mock-session-2')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
  })

  it('keeps choice-mapping near misses on the same-session structured retry path', async () => {
    const choiceQ = { id: 'Q01', prompt: 'Who should consume the strategy?', answer_type: 'single_choice' as const, options: [{ id: 'opt1', label: 'Workflow engine' }, { id: 'opt2', label: 'Beads generation' }] }
    const adapter = new TestOpenCodeAdapter([
      makeInterviewYaml({
        status: 'draft', generated_by: GENERATED_BY,
        questions: [makeInterviewQuestion({ ...choiceQ, answer: { ...ANSWERED, free_text: 'Workflow engines' } })],
      }),
      makeInterviewYaml({
        status: 'draft', generated_by: GENERATED_BY,
        questions: [makeInterviewQuestion({ ...choiceQ, answer: { ...ANSWERED, selected_option_ids: ['opt1'], free_text: '' } })],
      }),
      makePrdYaml(),
    ])

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Retry choice near misses in place', 'Exact option-ID mismatches should stay on the structured retry path.',
        makeInterviewYaml({ questions: [makeInterviewQuestion(choiceQ)] }),
      ),
      '/tmp/test', DRAFT_OPTS,
    )

    expect(result.fullAnswers[0]).toMatchObject({ memberId: 'model-a', outcome: 'completed', structuredOutput: { autoRetryCount: 1 } })
    expect(result.drafts[0]?.outcome).toBe('completed')
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2'])
    const fullAnswerRetryMessages = adapter.messages.get('mock-session-1')?.filter((message) => typeof message.content === 'string' && message.content.includes('Full Answers Structured Output Retry')) ?? []
    expect(fullAnswerRetryMessages).toHaveLength(1)
    expect(fullAnswerRetryMessages[0]?.content).toContain('Only these skipped question answers may change: Q01')
    expect(adapter.messages.get('mock-session-2')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
  })

  it('accepts choice-based full answers that combine canonical selections with explanatory free_text', async () => {
    const singleChoiceQ = {
      id: 'Q01',
      prompt: 'Which audience should the first rollout prioritize?',
      answer_type: 'single_choice' as const,
      options: [
        { id: 'opt1', label: 'Internal operators' },
        { id: 'opt2', label: 'External users' },
      ],
    }
    const multipleChoiceQ = {
      id: 'Q02',
      phase: 'Structure',
      prompt: 'Which delivery channels should the first rollout support?',
      answer_type: 'multiple_choice' as const,
      options: [
        { id: 'opt1', label: 'Web app' },
        { id: 'opt2', label: 'CLI' },
        { id: 'opt3', label: 'Internal API' },
      ],
    }
    const adapter = new TestOpenCodeAdapter([
      makeInterviewYaml({
        status: 'draft',
        generated_by: GENERATED_BY,
        questions: [
          makeInterviewQuestion({
            ...singleChoiceQ,
            answer: {
              skipped: false,
              selected_option_ids: ['opt1'],
              free_text: 'Prioritize internal operators first, mainly support and operations staff, because the current workflow still needs validation.',
              answered_by: 'ai_skip',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
          makeInterviewQuestion({
            ...multipleChoiceQ,
            answer: {
              skipped: false,
              selected_option_ids: ['opt1', 'opt3'],
              free_text: 'Keep the API internal-only during the first rollout; do not expose partner access yet.',
              answered_by: 'ai_skip',
              answered_at: TEST.timestamp, skip_reason: null,
            },
          }),
        ],
      }),
      makePrdYaml(),
    ])

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Preserve choice nuance in full answers', 'Choice questions may need canonical selections plus explanatory free text.',
        makeInterviewYaml({
          questions: [
            makeInterviewQuestion(singleChoiceQ),
            makeInterviewQuestion(multipleChoiceQ),
          ],
        }),
      ),
      '/tmp/test', DRAFT_OPTS,
    )

    expect(result.fullAnswers[0]).toMatchObject({
      memberId: 'model-a',
      outcome: 'completed',
      questionCount: 2,
      structuredOutput: { autoRetryCount: 0 },
    })
    expect(result.fullAnswers[0]?.content).toContain('Prioritize internal operators first')
    expect(result.fullAnswers[0]?.content).toContain('Keep the API internal-only during the first rollout')
    expect(result.drafts[0]).toMatchObject({
      memberId: 'model-a',
      outcome: 'completed',
      draftMetrics: { epicCount: 1, userStoryCount: 1 },
    })
  })

  it('continues to fail when the full-answers retry devolves into prose planning', async () => {
    const adapter = new TestOpenCodeAdapter([
      'This is not valid interview YAML.',
      '1. Introduce shard support.\n2. Add parser repairs.\n3. Update tests.',
    ])

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Keep prose retries invalid', 'Pure prose should not be salvageable.'),
      '/tmp/test', DRAFT_OPTS,
    )

    expect(result.fullAnswers[0]).toMatchObject({ memberId: 'model-a', outcome: 'invalid_output', structuredOutput: { autoRetryCount: 1 } })
    expect(result.fullAnswers[0]?.rawAttempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        stage: 'full_answers',
        outcome: 'rejected',
        rawResponse: 'This is not valid interview YAML.',
      }),
      expect.objectContaining({
        attempt: 2,
        stage: 'full_answers',
        outcome: 'rejected',
        rawResponse: '1. Introduce shard support.\n2. Add parser repairs.\n3. Update tests.',
      }),
    ])
    expect(result.drafts[0]).toMatchObject({
      memberId: 'model-a',
      outcome: 'invalid_output',
      content: '',
      error: 'PRD draft not started because Full Answers did not pass validation',
      skippedReason: 'full_answers_invalid',
      structuredOutput: {
        autoRetryCount: 0,
        validationError: 'PRD draft not started because Full Answers did not pass validation',
      },
    })
    expect(result.drafts[0]?.rawResponse).toBeUndefined()
    expect(result.drafts[0]?.rawAttempts).toBeUndefined()
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1'])
  })

  it('continues to fail when the full-answers retry is only a status message', async () => {
    const adapter = new TestOpenCodeAdapter([
      'This is not valid interview YAML.',
      'The complete interview artifact has been written to `.ticket/interview.yaml`.',
    ])

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Keep status-message retries invalid', 'Status text is not a structured artifact.'),
      '/tmp/test', DRAFT_OPTS,
    )

    expect(result.fullAnswers[0]).toMatchObject({ memberId: 'model-a', outcome: 'invalid_output', structuredOutput: { autoRetryCount: 1 } })
    expect(result.drafts[0]).toMatchObject({
      memberId: 'model-a',
      outcome: 'invalid_output',
      content: '',
      error: 'PRD draft not started because Full Answers did not pass validation',
      skippedReason: 'full_answers_invalid',
    })
    expect(result.drafts[0]?.rawResponse).toBeUndefined()
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1'])
  })

  it('keeps prompt-schema full-answers echoes invalid and records the prompt-echo validation message after one retry', async () => {
    const promptSchemaEcho = [
      'schema_version: 1',
      `ticket_id: "${TEST.externalId}"`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: "<winner-model-id>"',
      '  generated_at: "<ISO-8601 timestamp>"',
      '  canonicalization: server_normalized',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "What problem are we solving?"',
      '    source: compiled | prompt_follow_up | coverage_follow_up | final_free_form',
      '    follow_up_round: null',
      '    answer_type: free_text | single_choice | multiple_choice',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: "User answer or empty string"',
      '      answered_by: user | ai_skip',
      '      answered_at: "<ISO-8601 timestamp or empty string>"',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
      '',
      '## Context',
      '### ticket_details',
      '# Ticket: Keep prompt echoes invalid',
      'Status text is not an artifact.',
    ].join('\n')
    const adapter = new TestOpenCodeAdapter([promptSchemaEcho, promptSchemaEcho])

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Keep prompt echoes invalid', 'Prompt-schema echoes should fail with a clear validation error.'),
      '/tmp/test', DRAFT_OPTS,
    )

    expect(result.fullAnswers[0]).toMatchObject({
      memberId: 'model-a',
      outcome: 'invalid_output',
      structuredOutput: {
        autoRetryCount: 1,
        validationError: 'Interview document output echoed the prompt instead of returning a structured interview artifact',
      },
    })
    expect(result.fullAnswers[0]?.structuredOutput?.retryDiagnostics).toHaveLength(2)
    expect(result.drafts[0]).toMatchObject({
      memberId: 'model-a',
      outcome: 'invalid_output',
      content: '',
      error: 'PRD draft not started because Full Answers did not pass validation',
      skippedReason: 'full_answers_invalid',
      structuredOutput: {
        autoRetryCount: 0,
        validationError: 'PRD draft not started because Full Answers did not pass validation',
      },
    })
    expect(result.drafts[0]?.rawResponse).toBeUndefined()
    expect(result.drafts[0]?.rawAttempts).toBeUndefined()
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1'])
    const fullAnswerRetryMessages = adapter.messages.get('mock-session-1')?.filter((message) => typeof message.content === 'string' && message.content.includes('Full Answers Structured Output Retry')) ?? []
    expect(fullAnswerRetryMessages).toHaveLength(1)
  })

  it('restarts full answers in a fresh session after an empty response instead of sending a structured retry prompt', async () => {
    const adapter = new TestOpenCodeAdapter(['', resolvedYaml(), makePrdYaml()])

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Restart empty full answers', 'Blank structured output should restart the session.'),
      '/tmp/test', DRAFT_OPTS,
    )

    expect(result.fullAnswers[0]).toMatchObject({ memberId: 'model-a', outcome: 'completed', structuredOutput: { autoRetryCount: 1 } })
    expect(result.drafts[0]?.outcome).toBe('completed')
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2', 'mock-session-3'])
    expect(adapter.messages.get('mock-session-1')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
  })

  it('classifies repeated provider/session errors during prd_draft as failed instead of invalid_output', async () => {
    const adapter = new TestOpenCodeAdapter([
      resolvedYaml(),
      { response: '', error: "Provider returned error: The last message cannot have role 'assistant'" },
      { response: '', error: "Provider returned error: The last message cannot have role 'assistant'" },
    ])

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Classify provider failures', 'Provider/session protocol failures should not be treated as invalid YAML.'),
      '/tmp/test', DRAFT_OPTS,
    )

    expect(result.fullAnswers[0]?.outcome).toBe('completed')
    expect(result.drafts[0]).toMatchObject({
      memberId: 'model-a', outcome: 'failed',
      structuredOutput: { autoRetryCount: 1, failureClass: 'session_protocol_error' },
    })
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2', 'mock-session-3'])
    expect(adapter.messages.get('mock-session-2')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
    expect(adapter.messages.get('mock-session-3')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
  })

  it('continues to time out when the model misses the full-answers deadline', async () => {
    const adapter = new StalledTestOpenCodeAdapter([resolvedYaml()])

    const result = await draftPRD(adapter, COUNCIL,
      ticket('Keep full-answers timeouts unchanged', 'Timeout policy is out of scope for this hardening pass.'),
      '/tmp/test', { draftTimeoutMs: DEADLINE_MS, minQuorum: 1, ticketExternalId: TEST.externalId },
    )

    expect(result.fullAnswers[0]).toMatchObject({
      memberId: 'model-a', outcome: 'timed_out', error: `AI response timeout reached after ${DEADLINE_MS}ms`,
    })
    expect(result.drafts[0]?.outcome).toBe('timed_out')
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1'])
  })
})
