import { describe, expect, it } from 'vitest'
import {
  buildCouncilQuorumErrorWithDiagnostics,
  collectMembersByOutcome,
  createPendingDrafts,
  formatDraftFailureDetail,
  formatDraftRoundSummary,
  summarizeDraftOutcomes,
} from '../councilDrafts'
import type { DraftResult, DraftStructuredOutputMeta, MemberOutcome } from '../../../council/types'
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
      draft('completed'), draft('completed'), draft('timed_out'), draft('failed'), draft('invalid_output'),
    ])).toEqual({ completed: 2, timedOut: 1, failed: 1, invalidOutput: 1 })
  })

  it('counts an outcome it does not know as invalid output, not as completed', () => {
    // The reducer's tail is an else, so anything new lands there. Counting it
    // as completed would let a round pass quorum on responses nobody read.
    expect(summarizeDraftOutcomes([draft('pending'), draft('completed')]))
      .toEqual({ completed: 1, timedOut: 0, failed: 0, invalidOutput: 1 })
  })

  it('returns zeroes for an empty round', () => {
    expect(summarizeDraftOutcomes([])).toEqual({ completed: 0, timedOut: 0, failed: 0, invalidOutput: 0 })
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
