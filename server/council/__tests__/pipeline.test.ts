import { describe, it, expect, beforeEach, vi } from 'vitest'

// This suite exercises the real prompt runner with MockOpenCodeAdapter. Some
// workflow suites replace the shared runner; explicitly unmock it so non-
// isolated/full-suite execution cannot inherit a zero-implementation mock.
vi.unmock('../../workflow/runOpenCodePrompt')

import { MockOpenCodeAdapter } from '../../opencode/adapter'
import { runCouncilPipeline } from '../pipeline'
import { generateDrafts } from '../drafter'
import { checkQuorum } from '../quorum'
import { buildVotePresentationOrder, conductVoting, selectWinner } from '../voter'
import { refineDraft } from '../refiner'
import type { CouncilMember, DraftResult, Vote } from '../types'
import type { PromptPart } from '../../opencode/types'
import { deliberateInterview } from '../../phases/interview/deliberate'
import { normalizeInterviewRefinementOutput } from '../../structuredOutput'

/**
 * A prompt that only ever settles when its caller aborts it.
 *
 * Timeout tests used to sleep for longer than the deadline, which made every
 * assertion a race between two real clocks: a loaded worker could let a "late"
 * response land first, or push a "fast" one past the deadline. Never answering
 * on its own leaves the deadline as the only thing that can settle the prompt.
 */
function stalledPrompt(signal?: AbortSignal): Promise<string> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      const abortError = new Error('Aborted')
      abortError.name = 'AbortError'
      reject(abortError)
    }, { once: true })
  })
}

/** Long enough that only a stalled prompt reaches it, short enough to wait for. */
const DEADLINE_MS = 500

describe('Council Pipeline', () => {
  let adapter: MockOpenCodeAdapter
  const members: CouncilMember[] = [
    { modelId: 'model-a', name: 'Model A' },
    { modelId: 'model-b', name: 'Model B' },
    { modelId: 'model-c', name: 'Model C' },
  ]

  beforeEach(() => {
    adapter = new MockOpenCodeAdapter()
  })

  it('runs full council pipeline with mock adapter', async () => {
    const result = await runCouncilPipeline(adapter, {
      phase: 'interview_draft',
      members,
      contextParts: [{ type: 'text', content: 'Generate interview questions' }],
      projectPath: '/tmp/test',
    })

    expect(result.phase).toBe('interview_draft')
    expect(result.drafts.length).toBe(3)
    expect(result.winnerId).toBeTruthy()
    expect(result.refinedContent).toBeTruthy()
  })

  it('calls contextBuilder for vote and refine steps', async () => {
    const contextBuilder = vi.fn(
      (step: 'vote' | 'refine', _drafts: DraftResult[]): PromptPart[] => {
        return [{ type: 'text' as const, content: `prompt-for-${step}` }]
      },
    )

    const result = await runCouncilPipeline(adapter, {
      phase: 'interview_draft',
      members,
      contextParts: [{ type: 'text', content: 'draft prompt' }],
      projectPath: '/tmp/test',
      contextBuilder,
    })

    expect(contextBuilder).toHaveBeenCalledTimes(2)
    expect(contextBuilder).toHaveBeenCalledWith('vote', expect.any(Array))
    expect(contextBuilder).toHaveBeenCalledWith('refine', expect.any(Array))
    expect(result.refinedContent).toBeTruthy()
  })

  it('uses default contextParts when no contextBuilder provided', async () => {
    const result = await runCouncilPipeline(adapter, {
      phase: 'interview_draft',
      members,
      contextParts: [{ type: 'text', content: 'draft prompt' }],
      projectPath: '/tmp/test',
    })

    expect(result.refinedContent).toBeTruthy()
  })

  it('tracks member outcomes', async () => {
    const result = await runCouncilPipeline(adapter, {
      phase: 'test',
      members,
      contextParts: [{ type: 'text', content: 'test' }],
      projectPath: '/tmp/test',
    })

    expect(Object.keys(result.memberOutcomes).length).toBe(3)
    for (const outcome of Object.values(result.memberOutcomes)) {
      expect(outcome).toBe('completed')
    }
  })

  it('emits draft progress events when sessions are created and finished', async () => {
    const progressEvents = vi.fn()

    const draftRun = await generateDrafts(
      adapter,
      [members[0]!],
      [{ type: 'text', content: 'draft prompt' }],
      '/tmp/test',
      300000,
      undefined,
      undefined,
      undefined,
      progressEvents,
    )

    expect(draftRun.deadlineReached).toBe(false)
    const drafts = draftRun.drafts
    expect(drafts).toHaveLength(1)
    expect(progressEvents).toHaveBeenCalledWith(expect.objectContaining({
      memberId: 'model-a',
      status: 'session_created',
      sessionId: 'mock-session-1',
    }))
    expect(progressEvents).toHaveBeenCalledWith(expect.objectContaining({
      memberId: 'model-a',
      status: 'finished',
      sessionId: 'mock-session-1',
      outcome: 'completed',
      content: 'Mock response',
    }))
  })

  it('marks invalid drafts when validation still fails after the automatic retry', async () => {
    adapter.mockResponses.set('mock-session-1', 'not valid yaml')
    adapter.mockResponses.set('mock-session-2', 'still not valid yaml')

    const draftRun = await generateDrafts(
      adapter,
      [members[0]!],
      [{ type: 'text', content: 'draft prompt' }],
      '/tmp/test',
      300000,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error('schema validation failed')
      },
    )

    const drafts = draftRun.drafts
    expect(drafts[0]!.outcome).toBe('invalid_output')
    expect(drafts[0]!.content).toBe('')
    expect(drafts[0]!.rawResponse).toBe('still not valid yaml')
    expect(drafts[0]!.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'rejected', rawResponse: 'not valid yaml' }),
      expect.objectContaining({ attempt: 2, outcome: 'rejected', rawResponse: 'still not valid yaml' }),
    ])
    expect(drafts[0]!.error).toBe('schema validation failed')
  })

  it('retries drafts once and keeps normalized content when validation succeeds on retry', async () => {
    adapter.mockResponses.set('mock-session-1', 'bad draft')
    adapter.mockResponses.set('mock-session-2', 'valid draft')

    const validator = vi.fn((content: string) => {
      if (content !== 'valid draft') {
        throw new Error('invalid draft')
      }
      return { normalizedContent: 'normalized draft' }
    })

    const draftRun = await generateDrafts(
      adapter,
      [members[0]!],
      [{ type: 'text', content: 'draft prompt' }],
      '/tmp/test',
      300000,
      undefined,
      undefined,
      undefined,
      undefined,
      validator,
    )

    expect(validator).toHaveBeenCalledTimes(2)
    expect(draftRun.drafts[0]!.outcome).toBe('completed')
    expect(draftRun.drafts[0]!.content).toBe('normalized draft')
  })

  it('marks provider/runtime failures as failed when no response is received', async () => {
    class FailingAdapter extends MockOpenCodeAdapter {
      override async promptSession(): Promise<string> {
        throw new Error('Provider rejected request')
      }
    }

    const failingAdapter = new FailingAdapter()
    const draftRun = await generateDrafts(
      failingAdapter,
      [members[0]!],
      [{ type: 'text', content: 'draft prompt' }],
      '/tmp/test',
      300000,
    )

    const drafts = draftRun.drafts
    expect(drafts[0]!.outcome).toBe('failed')
    expect(drafts[0]!.content).toBe('')
    expect(drafts[0]!.error).toBe('Provider rejected request')
  })

  it('respects configured draft timeouts', async () => {
    class StalledAdapter extends MockOpenCodeAdapter {
      override promptSession(_sessionId: string, _parts: PromptPart[], signal?: AbortSignal): Promise<string> {
        return stalledPrompt(signal)
      }
    }

    const slowAdapter = new StalledAdapter()
    const draftRun = await generateDrafts(
      slowAdapter,
      [members[0]!],
      [{ type: 'text', content: 'draft prompt' }],
      '/tmp/test',
      5,
    )

    const drafts = draftRun.drafts
    expect(draftRun.deadlineReached).toBe(true)
    expect(drafts[0]!.outcome).toBe('timed_out')
    expect(drafts[0]!.duration).toBe(5)
  })

  it('returns partial draft results at the hard phase deadline', async () => {
    class MixedLatencyAdapter extends MockOpenCodeAdapter {
      override async promptSession(sessionId: string, _parts: PromptPart[], signal?: AbortSignal): Promise<string> {
        if (sessionId === 'mock-session-1') {
          return super.promptSession(sessionId, _parts, signal)
        }

        return stalledPrompt(signal)
      }
    }

    const draftRun = await generateDrafts(
      new MixedLatencyAdapter(),
      members,
      [{ type: 'text', content: 'draft prompt' }],
      '/tmp/test',
      DEADLINE_MS,
    )

    // The stalled members never answer, so a deadline that failed to fire would
    // hang this test rather than let a wall-clock comparison decide the result.
    expect(draftRun.deadlineReached).toBe(true)
    expect(draftRun.drafts.filter(d => d.outcome === 'completed')).toHaveLength(1)
    expect(draftRun.drafts.filter(d => d.outcome === 'timed_out')).toHaveLength(2)
    expect(draftRun.drafts.filter(d => d.outcome === 'timed_out').every(d => d.duration === DEADLINE_MS)).toBe(true)
  })

  it('deliberateInterview proceeds when validated drafts still meet quorum', async () => {
    adapter.mockResponses.set('mock-session-1', 'not valid yaml')
    adapter.mockResponses.set('mock-session-2', [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What is the goal?"',
    ].join('\n'))
    adapter.mockResponses.set('mock-session-3', [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "Who is the user?"',
    ].join('\n'))

    const result = await deliberateInterview(
      adapter,
      members,
      [
        { type: 'text', source: 'ticket_details', content: '# Ticket: Test\nNeed a change' },
        { type: 'text', source: 'relevant_files', content: 'files:\n  - path: "src/main.ts"' },
      ],
      '/tmp/test',
      { draftTimeoutMs: 300000, minQuorum: 2, maxInitialQuestions: 10 },
    )

    expect(result.drafts.filter(d => d.outcome === 'completed')).toHaveLength(2)
    expect(result.drafts.find(d => d.memberId === 'model-a')?.outcome).toBe('invalid_output')
  })

  it('keeps the interview draft phase moving when the deadline hits after quorum is met', async () => {
    class MixedLatencyAdapter extends MockOpenCodeAdapter {
      override async promptSession(sessionId: string, parts: PromptPart[], signal?: AbortSignal): Promise<string> {
        if (sessionId === 'mock-session-3') {
          return stalledPrompt(signal)
        }

        return super.promptSession(sessionId, parts, signal)
      }
    }

    const adapter = new MixedLatencyAdapter()
    adapter.mockResponses.set('mock-session-1', [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What is the goal?"',
    ].join('\n'))
    adapter.mockResponses.set('mock-session-2', [
      'questions:',
      '  - id: Q02',
      '    phase: structure',
      '    question: "Who is the user?"',
    ].join('\n'))

    const result = await deliberateInterview(
      adapter,
      members,
      [{ type: 'text', source: 'ticket_details', content: '# Ticket: Test\nNeed a change' }],
      '/tmp/test',
      { draftTimeoutMs: DEADLINE_MS, minQuorum: 2, maxInitialQuestions: 10 },
    )

    expect(result.deadlineReached).toBe(true)
    expect(result.drafts.filter(d => d.outcome === 'completed')).toHaveLength(2)
    expect(result.drafts.filter(d => d.outcome === 'timed_out')).toHaveLength(1)
  })

  it('times out voting calls when a voter exceeds the council timeout', async () => {
    class StalledAdapter extends MockOpenCodeAdapter {
      override promptSession(_sessionId: string, _parts: PromptPart[], signal?: AbortSignal): Promise<string> {
        return stalledPrompt(signal)
      }
    }

    const slowAdapter = new StalledAdapter()
    const voteUpdates = vi.fn()
    const voteRun = await conductVoting(
      slowAdapter,
      [members[0]!],
      [{ memberId: 'model-a', content: 'draft-a', outcome: 'completed', duration: 1 }],
      [{ type: 'text', content: 'vote prompt' }],
      '/tmp/test',
      'interview_draft',
      5,
      undefined,
      undefined,
      undefined,
      undefined,
      voteUpdates,
    )

    expect(voteRun.deadlineReached).toBe(true)
    expect(voteRun.votes).toEqual([])
    expect(voteRun.memberOutcomes).toEqual({ 'model-a': 'timed_out' })
    expect(voteUpdates).toHaveBeenCalledWith(expect.objectContaining({
      memberId: 'model-a',
      outcome: 'timed_out',
    }))
  })

  it('builds anonymized ballot orders that change between seeds', () => {
    const completedDrafts: DraftResult[] = [
      { memberId: 'model-a', content: 'draft-a', outcome: 'completed', duration: 1 },
      { memberId: 'model-b', content: 'draft-b', outcome: 'completed', duration: 1 },
      { memberId: 'model-c', content: 'draft-c', outcome: 'completed', duration: 1 },
    ]

    const firstBallot = buildVotePresentationOrder(completedDrafts, 'seed-alpha')
    const secondBallot = buildVotePresentationOrder(completedDrafts, 'seed-beta')

    expect(firstBallot.map(draft => draft.draftId)).not.toEqual(secondBallot.map(draft => draft.draftId))
    expect(firstBallot.map(draft => draft.content)).toEqual([
      expect.stringMatching(/^Draft 1:/),
      expect.stringMatching(/^Draft 2:/),
      expect.stringMatching(/^Draft 3:/),
    ])
    expect(firstBallot.every(draft => !draft.content.includes('model-'))).toBe(true)
  })

  it('returns replayable presentation order metadata for each voter', async () => {
    const voteRun = await conductVoting(
      adapter,
      members.slice(0, 2),
      [
        { memberId: 'model-a', content: 'draft-a', outcome: 'completed', duration: 1 },
        { memberId: 'model-b', content: 'draft-b', outcome: 'completed', duration: 1 },
        { memberId: 'model-c', content: 'draft-c', outcome: 'completed', duration: 1 },
      ],
      [{ type: 'text', content: 'vote prompt' }],
      '/tmp/test',
      'interview_draft',
    )

    expect(Object.keys(voteRun.presentationOrders)).toEqual(['model-a', 'model-b'])
    expect(voteRun.presentationOrders['model-a']).toMatchObject({
      seed: expect.any(String),
      order: expect.arrayContaining(['model-a', 'model-b', 'model-c']),
    })
    expect(voteRun.presentationOrders['model-b']).toMatchObject({
      seed: expect.any(String),
      order: expect.arrayContaining(['model-a', 'model-b', 'model-c']),
    })
  })

  it('continues the council pipeline when voting times out after quorum is met', async () => {
    class VoteTimeoutAdapter extends MockOpenCodeAdapter {
      override async promptSession(sessionId: string, parts: PromptPart[], signal?: AbortSignal): Promise<string> {
        if (sessionId === 'mock-session-6') {
          return stalledPrompt(signal)
        }

        return super.promptSession(sessionId, parts, signal)
      }
    }

    const result = await runCouncilPipeline(new VoteTimeoutAdapter(), {
      phase: 'interview_draft',
      members,
      contextParts: [{ type: 'text', content: 'Generate interview questions' }],
      projectPath: '/tmp/test',
      draftTimeout: DEADLINE_MS,
      minQuorum: 2,
    })

    expect(result.winnerId).toBeTruthy()
    expect(result.votes.length).toBeGreaterThan(0)
  })

  it('fails the council pipeline when voting times out before quorum is met', async () => {
    class VoteQuorumFailingAdapter extends MockOpenCodeAdapter {
      override async promptSession(sessionId: string, parts: PromptPart[], signal?: AbortSignal): Promise<string> {
        if (sessionId === 'mock-session-5' || sessionId === 'mock-session-6') {
          return stalledPrompt(signal)
        }

        return super.promptSession(sessionId, parts, signal)
      }
    }

    await expect(runCouncilPipeline(new VoteQuorumFailingAdapter(), {
      phase: 'interview_draft',
      members,
      contextParts: [{ type: 'text', content: 'Generate interview questions' }],
      projectPath: '/tmp/test',
      draftTimeout: DEADLINE_MS,
      minQuorum: 2,
    })).rejects.toThrow('quorum not met')
  })

  it('times out refinement calls when the winner exceeds the council timeout', async () => {
    class StalledAdapter extends MockOpenCodeAdapter {
      override promptSession(_sessionId: string, _parts: PromptPart[], signal?: AbortSignal): Promise<string> {
        return stalledPrompt(signal)
      }
    }

    const slowAdapter = new StalledAdapter()

    await expect(refineDraft(
      slowAdapter,
      { memberId: 'model-a', content: 'winner', outcome: 'completed', duration: 1 },
      [],
      [{ type: 'text', content: 'refine prompt' }],
      '/tmp/test',
      5,
    )).rejects.toThrow('Timeout')
  })

  it('retries refinement once and returns normalized content when validation succeeds', async () => {
    adapter.mockResponses.set('mock-session-1', 'invalid refine output')
    adapter.mockResponses.set('mock-session-2', 'valid refine output')

    const result = await refineDraft(
      adapter,
      { memberId: 'model-a', content: 'winner', outcome: 'completed', duration: 1 },
      [],
      [{ type: 'text', content: 'refine prompt' }],
      '/tmp/test',
      300000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (content) => {
        if (content !== 'valid refine output') {
          throw new Error('invalid refine output')
        }
        return { normalizedContent: 'normalized refine output' }
      },
      'Return only YAML.',
    )

    expect(result.content).toBe('normalized refine output')
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'rejected', rawResponse: 'invalid refine output' }),
      expect.objectContaining({ attempt: 2, outcome: 'accepted', rawResponse: 'valid refine output' }),
    ])
  })

  it('does not retry refinement when interview semantic auto-heal succeeds on the first pass', async () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
    ].join('\n')

    adapter.mockResponses.set('mock-session-1', [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
      '    after:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
    ].join('\n'))

    const validator = vi.fn((content: string) => {
      const result = normalizeInterviewRefinementOutput(content, winnerDraft, 10)
      if (!result.ok) {
        throw new Error(result.error)
      }
      return { normalizedContent: result.normalizedContent }
    })

    const result = await refineDraft(
      adapter,
      { memberId: 'model-a', content: winnerDraft, outcome: 'completed', duration: 1 },
      [],
      [{ type: 'text', content: 'refine prompt' }],
      '/tmp/test',
      300000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      validator,
      'Return only YAML.',
    )

    expect(result.content).toContain('questions:')
    expect(result.content).not.toContain('changes:')
    expect(result.rawAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'accepted' }),
    ])
    expect(validator).toHaveBeenCalledTimes(1)
    expect(adapter.sessions).toHaveLength(1)
  })
})

describe('Quorum', () => {
  it('passes when enough valid drafts', () => {
    const drafts: DraftResult[] = [
      { memberId: 'a', content: 'draft', outcome: 'completed', duration: 100 },
      { memberId: 'b', content: 'draft', outcome: 'completed', duration: 100 },
    ]
    expect(checkQuorum(drafts, 2).passed).toBe(true)
  })

  it('fails when not enough valid drafts', () => {
    const drafts: DraftResult[] = [
      { memberId: 'a', content: 'draft', outcome: 'completed', duration: 100 },
      { memberId: 'b', content: '', outcome: 'timed_out', duration: 100, error: 'Timeout' },
    ]
    expect(checkQuorum(drafts, 2).passed).toBe(false)
  })

  it('only counts completed drafts with content', () => {
    const drafts: DraftResult[] = [
      { memberId: 'a', content: '', outcome: 'completed', duration: 100 },
      { memberId: 'b', content: 'draft', outcome: 'completed', duration: 100 },
    ]
    expect(checkQuorum(drafts, 2).passed).toBe(false)
  })

  it('excludes invalid_output drafts from quorum', () => {
    const drafts: DraftResult[] = [
      { memberId: 'a', content: 'questions: []', outcome: 'completed', duration: 100 },
      { memberId: 'b', content: 'invalid', outcome: 'invalid_output', duration: 100, error: 'schema validation failed' },
    ]
    expect(checkQuorum(drafts, 2).passed).toBe(false)
    expect(checkQuorum(drafts, 2).message).toContain('schema validation failed')
  })
})

describe('Winner Selection', () => {
  const members: CouncilMember[] = [
    { modelId: 'mai', name: 'MAI' },
    { modelId: 'other', name: 'Other' },
  ]

  it('selects highest scoring draft', () => {
    const votes: Vote[] = [
      { voterId: 'mai', draftId: 'other', scores: [], totalScore: 90 },
      { voterId: 'other', draftId: 'mai', scores: [], totalScore: 80 },
    ]
    expect(selectWinner(votes, members).winnerId).toBe('other')
  })

  it('MAI wins ties', () => {
    const votes: Vote[] = [
      { voterId: 'mai', draftId: 'other', scores: [], totalScore: 80 },
      { voterId: 'other', draftId: 'mai', scores: [], totalScore: 80 },
    ]
    expect(selectWinner(votes, members).winnerId).toBe('mai')
  })
})
