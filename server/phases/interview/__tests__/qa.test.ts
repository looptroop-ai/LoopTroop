import { describe, expect, it } from 'vitest'
import { MockOpenCodeAdapter } from '../../../opencode/adapter'
import { OPENCODE_READ_ONLY_TOOLS } from '../../../opencode/toolPolicy'
import { startInterviewSession, submitBatchToSession } from '../qa'
import { buildPersistedBatch, createInterviewSessionSnapshot, recordBatchAnswers, recordPreparedBatch } from '../sessionState'
import { TEST } from '../../../test/factories'

class SequencedMockOpenCodeAdapter extends MockOpenCodeAdapter {
  private promptCounts = new Map<string, number>()

  override async promptSession(...args: Parameters<MockOpenCodeAdapter['promptSession']>) {
    const sessionId = args[0]
    const nextCount = (this.promptCounts.get(sessionId) ?? 0) + 1
    this.promptCounts.set(sessionId, nextCount)

    const queuedResponse = this.mockResponses.get(`${sessionId}#${nextCount}`)
    if (queuedResponse !== undefined) {
      this.mockResponses.set(sessionId, queuedResponse)
    }

    return await super.promptSession(...args)
  }
}

describe.concurrent('PROM4 interview session parsing', () => {
  it('frames compiled questions as the working checklist in the initial PROM4 prompt', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1', [
      '<INTERVIEW_BATCH>',
      'batch_number: 1',
      'progress:',
      '  current: 1',
      '  total: 4',
      'is_final_free_form: false',
      'ai_commentary: Start with the compiled foundation checklist.',
      'questions:',
      '  - id: Q01',
      '    question: What problem are we solving?',
      '    phase: Foundation',
      '    priority: critical',
      '    rationale: Establish the core goal.',
      '    answer_type: free_text',
      '</INTERVIEW_BATCH>',
    ].join('\n'))

    await startInterviewSession(
      adapter,
      '/tmp/test',
      'model-a',
      [
        'questions:',
        '  - id: Q01',
        '    phase: foundation',
        '    question: What problem are we solving?',
      ].join('\n'),
      {
        ticketId: TEST.externalId,
        title: 'Checklist framing',
        description: 'Ensure the compiled interview set stays foregrounded.',
        relevantFiles: '',
      },
      5,
      20,
    )

    const messages = adapter.messages.get('mock-session-1') ?? []
    const firstPrompt = messages.find((message) => message.role === 'user')?.content ?? ''

    expect(firstPrompt).toContain('## Compiled Questions (from council)')
    expect(firstPrompt).toContain('Treat the compiled questions above as your working interview checklist')
    expect((firstPrompt.match(/## Compiled Questions \(from council\)/g) ?? [])).toHaveLength(1)
    expect(firstPrompt).not.toContain('### interview')
  })

  it('retries invalid structured output in the same session and returns the corrected batch', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', 'I will ask three useful questions next.')
    adapter.mockResponses.set('mock-session-1#2', [
      '<INTERVIEW_BATCH>',
      'batch_number: 1',
      'progress:',
      '  current: 2',
      '  total: 5',
      'is_final_free_form: false',
      'ai_commentary: Asking the foundation questions first.',
      'questions:',
      '  - id: Q01',
      '    question: What problem are we solving?',
      '    phase: Foundation',
      '    priority: critical',
      '    rationale: Establish the core goal.',
      '</INTERVIEW_BATCH>',
    ].join('\n'))

    const result = await startInterviewSession(
      adapter,
      '/tmp/test',
      'model-a',
      [
        'questions:',
        '  - id: Q01',
        '    phase: foundation',
        '    question: What problem are we solving?',
      ].join('\n'),
      {
        ticketId: TEST.externalId,
        title: 'Retry PROM4 parsing',
        description: 'Ensure malformed batch output is corrected before blocking.',
        relevantFiles: '',
      },
      5,
      20,
    )

    expect(result.sessionId).toBe('mock-session-1')
    expect(result.firstBatch).toMatchObject({
      batchNumber: 1,
      isComplete: false,
      progress: { current: 2, total: 5 },
      questions: [
        {
          id: 'Q01',
          question: 'What problem are we solving?',
          phase: 'Foundation',
          priority: 'critical',
        },
      ],
    })

    const messages = adapter.messages.get('mock-session-1') ?? []
    expect(messages.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(true)
    expect(adapter.promptCalls[0]?.options?.tools).toEqual(OPENCODE_READ_ONLY_TOOLS)
    expect(adapter.promptCalls[1]?.options?.tools).toEqual(OPENCODE_READ_ONLY_TOOLS)
  })

  it('restarts the initial PROM4 session after an empty response', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('mock-session-1#1', '')
    adapter.mockResponses.set('mock-session-2#1', [
      '<INTERVIEW_BATCH>',
      'batch_number: 1',
      'progress:',
      '  current: 1',
      '  total: 4',
      'is_final_free_form: false',
      'ai_commentary: Start with the compiled foundation checklist.',
      'questions:',
      '  - id: Q01',
      '    question: What problem are we solving?',
      '    phase: Foundation',
      '    priority: critical',
      '    rationale: Establish the core goal.',
      '    answer_type: free_text',
      '</INTERVIEW_BATCH>',
    ].join('\n'))

    const result = await startInterviewSession(
      adapter,
      '/tmp/test',
      'model-a',
      [
        'questions:',
        '  - id: Q01',
        '    phase: foundation',
        '    question: What problem are we solving?',
      ].join('\n'),
      {
        ticketId: TEST.externalId,
        title: 'Restart PROM4 session',
        description: 'Blank output should restart the session.',
        relevantFiles: '',
      },
      5,
      20,
    )

    expect(result.sessionId).toBe('mock-session-2')
    expect(result.firstBatch.batchNumber).toBe(1)
    expect(adapter.sessions.map((session) => session.id)).toEqual(['mock-session-1', 'mock-session-2'])
    expect(adapter.messages.get('mock-session-1')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
  })

  it('restarts a follow-up PROM4 batch from normalized interview state after an empty response', async () => {
    const adapter = new SequencedMockOpenCodeAdapter()
    adapter.mockResponses.set('existing-session#1', '')
    adapter.mockResponses.set('mock-session-1#1', [
      '<INTERVIEW_BATCH>',
      'batch_number: 2',
      'progress:',
      '  current: 2',
      '  total: 4',
      'is_final_free_form: false',
      'ai_commentary: Continuing from the normalized state.',
      'questions:',
      '  - id: Q02',
      '    question: Which platforms should we support first?',
      '    phase: Scope',
      '    priority: high',
      '    rationale: Confirm delivery targets.',
      '    answer_type: single_choice',
      '    options:',
      '      - id: web',
      '        label: Web',
      '      - id: mobile',
      '        label: Mobile',
      '</INTERVIEW_BATCH>',
    ].join('\n'))

    const baseSnapshot = createInterviewSessionSnapshot({
      winnerId: 'model-a',
      compiledQuestions: [
        {
          id: 'Q01',
          phase: 'Foundation',
          question: 'What problem are we solving?',
        },
      ],
      maxInitialQuestions: 5,
      followUpBudgetPercent: 20,
    })
    const preparedSnapshot = recordPreparedBatch(baseSnapshot, buildPersistedBatch({
      questions: [
        {
          id: 'Q01',
          question: 'What problem are we solving?',
          phase: 'Foundation',
          priority: 'critical',
          rationale: 'Establish the core goal.',
          answerType: 'free_text',
        },
      ],
      progress: { current: 1, total: 4 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Start with the compiled foundation checklist.',
      batchNumber: 1,
    }, 'prom4', baseSnapshot))
    const answeredSnapshot = recordBatchAnswers(preparedSnapshot, { Q01: 'Reliable structured output handling.' })

    const result = await submitBatchToSession(
      adapter,
      'existing-session',
      { Q01: 'Reliable structured output handling.' },
      undefined,
      'model-a',
      undefined,
      undefined,
      undefined,
      undefined,
      {
        projectPath: '/tmp/test',
        ticketState: {
          ticketId: TEST.externalId,
          title: 'Resume PROM4 session',
          description: 'Restart from normalized interview state.',
          interview: 'questions:\n  - id: Q01\n    phase: Foundation\n    question: What problem are we solving?\n',
        },
        snapshot: answeredSnapshot,
      },
    )

    expect(result).toMatchObject({
      batchNumber: 2,
      sessionId: 'mock-session-1',
      questions: [
        {
          id: 'Q02',
          phase: 'Scope',
        },
      ],
    })
    expect(adapter.messages.get('existing-session')?.some((message) => typeof message.content === 'string' && message.content.includes('Structured Output Retry'))).toBe(false)
    const restartedPrompt = adapter.messages.get('mock-session-1')?.find((message) => message.role === 'user')?.content ?? ''
    expect(restartedPrompt).toContain('## Resume Existing Interview Session')
    expect(restartedPrompt).toContain('max_initial_questions: 5')
    expect(restartedPrompt).toContain('max_follow_ups: 1')
    expect(restartedPrompt).toContain('Answered or skipped questions:')
    expect(restartedPrompt).toContain('- Q01 (answered) [Foundation]: Reliable structured output handling.')
    expect(restartedPrompt).toContain('Pending questions:')
    expect(restartedPrompt).not.toContain('## Compiled Questions (from council)')
    expect(restartedPrompt).not.toContain('questions:\n  - id: Q01')
  })
})
