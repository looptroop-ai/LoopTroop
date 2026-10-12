import { describe, expect, it } from 'vitest'
import {
  applyDraftProgress,
  applyVoteProgress,
  buildCouncilQuorumErrorWithDiagnostics,
  collectMembersByOutcome,
  createPendingDrafts,
  formatDraftFailureDetail,
  formatDraftRoundSummary,
  summarizeDraftOutcomes,
  type LiveVoteState,
} from '../councilDrafts'
import type { DraftResult, DraftStructuredOutputMeta, MemberOutcome, Vote } from '../../../council/types'
import type { StructuredFailureClass } from '../../../lib/structuredOutputRetry'

function draft(outcome: DraftResult['outcome'], memberId = 'model'): DraftResult {
  return { memberId, content: '', outcome, duration: 0 }
}

function structuredOutput(failureClass: StructuredFailureClass): DraftStructuredOutputMeta {
  return { repairApplied: false, repairWarnings: [], autoRetryCount: 0, failureClass }
}

/**
 * The council round's own bookkeeping, split out of `helpers.ts` by PR-13.
 *
 * What these produce is what a person reads when a round does not reach quorum,
 * so a miscount or a swallowed failure class is the difference between a
 * diagnosable run and "council quorum not met".
 */
describe('summarizeDraftOutcomes', () => {
  it('counts each outcome under its own name', () => {
    expect(summarizeDraftOutcomes([
      draft('completed'), draft('completed'), draft('timed_out'), draft('failed'), draft('invalid_output'), draft('stopped'),
    ])).toEqual({ completed: 2, timedOut: 1, failed: 1, invalidOutput: 1, stopped: 1 })
  })

  it('counts an outcome it does not know as invalid output, not as completed', () => {
    // The reducer's tail is an else, so anything new lands there. Counting it
    // as completed would let a round pass quorum on responses nobody read.
    expect(summarizeDraftOutcomes([draft('pending'), draft('completed')]))
      .toEqual({ completed: 1, timedOut: 0, failed: 0, invalidOutput: 1, stopped: 0 })
  })

  it('returns zeroes for an empty round', () => {
    expect(summarizeDraftOutcomes([])).toEqual({ completed: 0, timedOut: 0, failed: 0, invalidOutput: 0, stopped: 0 })
  })
})

describe('formatDraftRoundSummary', () => {
  const summary = { completed: 2, timedOut: 1, failed: 0, invalidOutput: 1 }

  it('reports the elapsed time when the round settled on its own', () => {
    expect(formatDraftRoundSummary('PRD drafts', 90_000, 120_000, false, summary))
      .toBe('PRD drafts completed in 1.5m: completed=2, timed_out=1, failed=0, invalid_output=1.')
  })

  it('reports the configured deadline, not the elapsed time, when the deadline was reached', () => {
    // The elapsed time at a deadline is the deadline, so printing it would say
    // nothing; what matters is that the limit is what stopped the round.
    expect(formatDraftRoundSummary('PRD drafts', 120_000, 120_000, true, summary))
      .toBe('PRD drafts reached configured deadline (120000ms): completed=2, timed_out=1, failed=0, invalid_output=1.')
  })

  it('names stopped models only when a person stopped some', () => {
    expect(formatDraftRoundSummary('PRD drafts', 90_000, 120_000, false, { ...summary, stopped: 0 }))
      .toBe('PRD drafts completed in 1.5m: completed=2, timed_out=1, failed=0, invalid_output=1.')
    expect(formatDraftRoundSummary('PRD drafts', 90_000, 120_000, false, { ...summary, stopped: 2 }))
      .toBe('PRD drafts completed in 1.5m: completed=2, timed_out=1, failed=0, invalid_output=1, stopped=2.')
  })
})

describe('formatDraftFailureDetail', () => {
  it.each([
    ['timed_out', undefined, undefined, 'timed out'],
    ['invalid_output', undefined, undefined, 'invalid output (malformed response)'],
    ['invalid_output', 'no closing brace', undefined, 'invalid output (no closing brace)'],
    ['invalid_output', undefined, 'validation_error', 'invalid output (validation_error)'],
    ['invalid_output', 'missing epic', 'validation_error', 'invalid output (validation_error: missing epic)'],
    ['failed', undefined, undefined, 'failed'],
    ['failed', 'connection reset', undefined, 'failed (connection reset)'],
    ['failed', 'ran out of tokens', 'output_truncated', 'failed (output_truncated: ran out of tokens)'],
    ['stopped', 'Stopped by you', undefined, 'stopped by the user'],
  ] as const)('describes %s (%s / %s)', (outcome, error, failureClass, expected) => {
    expect(formatDraftFailureDetail(outcome, error, failureClass)).toBe(expected)
  })

  it('says nothing about an outcome that is not a failure', () => {
    expect(formatDraftFailureDetail('completed', 'ignored')).toBe('')
    expect(formatDraftFailureDetail('pending')).toBe('')
  })
})

describe('buildCouncilQuorumErrorWithDiagnostics', () => {
  it('returns a plain error when nothing was truncated', () => {
    const error = buildCouncilQuorumErrorWithDiagnostics('quorum not met', [
      { memberId: 'a', outcome: 'failed', structuredOutput: structuredOutput('validation_error') },
    ])

    expect(error.message).toBe('quorum not met')
    expect(error).not.toHaveProperty('blockedErrorDiagnostics')
  })

  it('attaches truncation diagnostics naming the model that ran out of room', () => {
    const error = buildCouncilQuorumErrorWithDiagnostics('quorum not met', [
      { memberId: 'a', outcome: 'completed' },
      { memberId: 'b', outcome: 'failed', structuredOutput: structuredOutput('output_truncated') },
    ]) as Error & { blockedErrorDiagnostics?: { kind?: string; modelId?: string } }

    expect(error.message).toBe('quorum not met')
    expect(error.blockedErrorDiagnostics?.kind).toBe('model_output_truncated')
    expect(error.blockedErrorDiagnostics?.modelId).toBe('b')
  })

  it('finds a truncation reported by one raw attempt as well as by the outcome', () => {
    const error = buildCouncilQuorumErrorWithDiagnostics('quorum not met', [
      {
        voterId: 'v1',
        outcome: 'invalid_output',
        rawAttempts: [
          { attempt: 1, failureClass: 'validation_error' },
          { attempt: 2, failureClass: 'output_truncated' },
        ] as never,
      },
    ]) as Error & { blockedErrorDiagnostics?: { modelId?: string } }

    // A voter has no `memberId`; the diagnostics still have to name it.
    expect(error.blockedErrorDiagnostics?.modelId).toBe('v1')
  })

  it('ignores a truncation on a member that completed anyway', () => {
    // A retry that succeeded is not what blocked the round.
    const error = buildCouncilQuorumErrorWithDiagnostics('quorum not met', [
      { memberId: 'a', outcome: 'completed', structuredOutput: structuredOutput('output_truncated') },
    ])

    expect(error).not.toHaveProperty('blockedErrorDiagnostics')
  })
})

describe('createPendingDrafts', () => {
  it('gives every member a pending placeholder, in roster order', () => {
    expect(createPendingDrafts([{ modelId: 'a' }, { modelId: 'b' }])).toEqual([
      { memberId: 'a', content: '', outcome: 'pending', duration: 0 },
      { memberId: 'b', content: '', outcome: 'pending', duration: 0 },
    ])
  })

  it('returns nothing for an empty roster', () => {
    expect(createPendingDrafts([])).toEqual([])
  })
})

describe('collectMembersByOutcome', () => {
  const outcomes: Record<string, MemberOutcome> = {
    a: 'completed',
    b: 'timed_out',
    c: 'completed',
  }

  it('returns the member ids with that outcome', () => {
    expect(collectMembersByOutcome(outcomes, 'completed')).toEqual(['a', 'c'])
    expect(collectMembersByOutcome(outcomes, 'timed_out')).toEqual(['b'])
  })

  it('returns nothing for an outcome no member had', () => {
    expect(collectMembersByOutcome(outcomes, 'failed')).toEqual([])
    expect(collectMembersByOutcome({}, 'completed')).toEqual([])
  })
})

describe('applyDraftProgress', () => {
  it('records a finished member and resets a restarted one to a bare pending entry', () => {
    const live = createPendingDrafts([{ modelId: 'a' }, { modelId: 'b' }])

    expect(applyDraftProgress(live, {
      memberId: 'a',
      status: 'finished',
      outcome: 'invalid_output',
      duration: 12,
      error: 'bad yaml',
      rawResponse: 'not yaml',
      rawAttempts: [{ attempt: 1, stage: 'draft', outcome: 'rejected', rawResponse: 'not yaml' }],
    })).toBe(true)
    expect(live[0]).toMatchObject({ outcome: 'invalid_output', error: 'bad yaml', rawResponse: 'not yaml' })

    expect(applyDraftProgress(live, { memberId: 'a', status: 'restarted' })).toBe(true)
    expect(live[0]).toEqual({ memberId: 'a', content: '', outcome: 'pending', duration: 0 })
  })

  it('drops the diagnostics of an earlier result that a later one does not carry', () => {
    const live = createPendingDrafts([{ modelId: 'a' }])
    applyDraftProgress(live, {
      memberId: 'a',
      status: 'finished',
      outcome: 'completed',
      content: 'Part 1 answers',
      rawResponse: 'Part 1 output',
      normalizedResponse: 'Part 1 output',
      rawAttempts: [{ attempt: 1, stage: 'draft', outcome: 'accepted', rawResponse: 'Part 1 output' }],
    })

    // A model stopped during PRD Part 2 throws its Part 1 answers away.
    applyDraftProgress(live, { memberId: 'a', status: 'finished', outcome: 'stopped', content: '', error: 'Stopped by the user' })

    expect(live[0]).toEqual(expect.objectContaining({ outcome: 'stopped', content: '' }))
    expect(live[0]).not.toHaveProperty('rawResponse')
    expect(live[0]).not.toHaveProperty('normalizedResponse')
    expect(live[0]).not.toHaveProperty('rawAttempts')
  })

  it('ignores session events and members outside the round', () => {
    const live = createPendingDrafts([{ modelId: 'a' }])
    expect(applyDraftProgress(live, { memberId: 'a', status: 'session_created', sessionId: 's-1' })).toBe(false)
    expect(applyDraftProgress(live, { memberId: 'z', status: 'restarted' })).toBe(false)
    expect(live).toEqual(createPendingDrafts([{ modelId: 'a' }]))
  })
})

describe('applyVoteProgress', () => {
  function vote(voterId: string, draftId: string): Vote {
    return { voterId, draftId, scores: [], totalScore: 10 }
  }

  it('replaces a voter\'s scorecard and drops it again when the voter restarts', () => {
    const live: LiveVoteState = {
      votes: [vote('b', 'x')],
      voterOutcomes: { a: 'pending', b: 'completed' },
      voterDetails: new Map(),
    }

    applyVoteProgress(live, { memberId: 'a', outcome: 'completed', votes: [vote('a', 'x'), vote('a', 'y')], rawResponse: 'scores' })
    expect(live.votes.map((entry) => entry.voterId)).toEqual(['b', 'a', 'a'])
    expect(live.voterDetails.get('a')).toEqual({ voterId: 'a', rawResponse: 'scores' })

    applyVoteProgress(live, { memberId: 'a', outcome: 'pending', votes: [] })
    expect(live.votes.map((entry) => entry.voterId)).toEqual(['b'])
    expect(live.voterOutcomes.a).toBe('pending')
    expect(live.voterDetails.has('a')).toBe(false)

    applyVoteProgress(live, { memberId: 'a', outcome: 'stopped', votes: [], error: 'Stopped by you' })
    expect(live.voterOutcomes.a).toBe('stopped')
    expect(live.voterDetails.get('a')).toEqual({ voterId: 'a', error: 'Stopped by you' })
  })
})
