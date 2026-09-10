import { describe, expect, it } from 'vitest'
import { PROM5, PROM13, PROM23 } from '../../../prompts/index'
import {
  describeCouncilMemberSource,
  describeCoverageTerminationReason,
  formatCouncilMemberRoster,
  formatCouncilResolutionLog,
  formatDurationMs,
  getCoverageContextPhase,
  getCoveragePromptTemplate,
  getCoverageStateLabel,
  mapCouncilStageToStatus,
} from '../phaseRuntimeSettings'
import type { TicketContext } from '../../../machines/types'

/**
 * The per-flow lookups a phase makes before it runs anything.
 *
 * Each is a small mapping over a closed set, and the failure mode is the same
 * for all of them: a flow or stage that returns the wrong member reports a
 * ticket under a phase it is not in, or coverage-checks the wrong artifact.
 */
describe('mapCouncilStageToStatus', () => {
  it.each([
    ['interview', 'draft', 'COUNCIL_DELIBERATING'],
    ['interview', 'vote', 'COUNCIL_VOTING_INTERVIEW'],
    ['interview', 'refine', 'COMPILING_INTERVIEW'],
    ['prd', 'draft', 'DRAFTING_PRD'],
    ['prd', 'vote', 'COUNCIL_VOTING_PRD'],
    ['prd', 'refine', 'REFINING_PRD'],
    ['beads', 'draft', 'DRAFTING_BEADS'],
    ['beads', 'vote', 'COUNCIL_VOTING_BEADS'],
    ['beads', 'refine', 'REFINING_BEADS'],
  ] as const)('maps %s/%s to %s', (flow, stage, expected) => {
    expect(mapCouncilStageToStatus(flow, stage)).toBe(expected)
  })

  it('gives all nine combinations a distinct status', () => {
    const statuses = (['interview', 'prd', 'beads'] as const).flatMap((flow) =>
      (['draft', 'vote', 'refine'] as const).map((stage) => mapCouncilStageToStatus(flow, stage)),
    )

    expect(new Set(statuses).size).toBe(statuses.length)
  })
})

describe('the coverage lookups', () => {
  it.each([
    ['interview', 'VERIFYING_INTERVIEW_COVERAGE', 'interview_coverage', PROM5],
    ['prd', 'VERIFYING_PRD_COVERAGE', 'prd_coverage', PROM13],
    ['beads', 'VERIFYING_BEADS_COVERAGE', 'beads_coverage', PROM23],
  ] as const)('resolves %s to its own status, context phase and prompt', (phase, status, contextPhase, prompt) => {
    expect(getCoverageStateLabel(phase)).toBe(status)
    expect(getCoverageContextPhase(phase)).toBe(contextPhase)
    expect(getCoveragePromptTemplate(phase)).toBe(prompt)
  })
})

describe('describeCoverageTerminationReason', () => {
  it.each([
    ['coverage_pass_limit_reached', 'retry cap reached'],
    ['follow_up_budget_exhausted', 'follow-up budget exhausted'],
    ['follow_up_generation_failed', 'follow-up generation failed'],
  ])('describes %s', (reason, expected) => {
    expect(describeCoverageTerminationReason(reason)).toBe(expected)
  })

  it('falls back to manual review for a reason it does not recognise', () => {
    // The reason reaches a person, so an unmapped one has to read as something
    // actionable rather than as the raw token.
    expect(describeCoverageTerminationReason('something_new')).toBe('manual review required')
    expect(describeCoverageTerminationReason('')).toBe('manual review required')
  })
})

describe('the council roster log line', () => {
  const members = [
    { modelId: 'openai/gpt-5.4', name: 'GPT' },
    { modelId: 'anthropic/claude-opus-5', name: 'Claude' },
  ]

  it('lists members by model id, in the order given', () => {
    // Order is identity here: the roster is locked by order elsewhere, so
    // sorting it would make a reorder look like no change.
    expect(formatCouncilMemberRoster(members)).toBe('openai/gpt-5.4, anthropic/claude-opus-5')
    expect(formatCouncilMemberRoster([...members].reverse()))
      .toBe('anthropic/claude-opus-5, openai/gpt-5.4')
  })

  it('renders an empty roster as an empty string', () => {
    expect(formatCouncilMemberRoster([])).toBe('')
  })

  it.each([
    ['locked_ticket', 'locked ticket config'],
    ['profile', 'profile config'],
  ] as const)('describes the %s source', (source, expected) => {
    expect(describeCouncilMemberSource(source)).toBe(expected)
  })

  it('names the source, the count, the roster and the implementer', () => {
    const context = { lockedMainImplementer: 'openai/gpt-5.4' } as TicketContext

    expect(formatCouncilResolutionLog(context, { members, source: 'locked_ticket' })).toBe(
      'Council members resolved from locked ticket config: 2 members '
      + '(openai/gpt-5.4, anthropic/claude-opus-5). Main implementer: openai/gpt-5.4.',
    )
  })

  it('says the implementer is not configured rather than printing undefined', () => {
    const context = {} as TicketContext

    expect(formatCouncilResolutionLog(context, { members: [], source: 'profile' }))
      .toBe('Council members resolved from profile config: 0 members (). Main implementer: not configured.')
  })
})

describe('formatDurationMs', () => {
  it.each([
    [0, '0ms'],
    [840, '840ms'],
    [999, '999ms'],
    [1000, '1.0s'],
    [1500, '1.5s'],
    [59_999, '60.0s'],
    [60_000, '1.0m'],
    [90_000, '1.5m'],
  ])('renders %ims as %s', (input, expected) => {
    expect(formatDurationMs(input)).toBe(expected)
  })
})
