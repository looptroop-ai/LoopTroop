import { describe, expect, it } from 'vitest'
import { MockOpenCodeAdapter } from '../../opencode/adapter'
import { OPENCODE_DISABLED_PERMISSIONS } from '../../opencode/toolPolicy'
import type { CouncilMember, DraftResult } from '../types'
import { VOTING_RUBRIC_BEADS, VOTING_RUBRIC_INTERVIEW, VOTING_RUBRIC_PRD } from '../types'
import { conductVoting } from '../voter'

describe('conductVoting', () => {
  const cases = [
    { phase: 'interview_draft', rubric: VOTING_RUBRIC_INTERVIEW },
    { phase: 'prd_draft', rubric: VOTING_RUBRIC_PRD },
    { phase: 'beads_draft', rubric: VOTING_RUBRIC_BEADS },
  ] as const

  function buildStrictScorecardResponse(categories: string[]) {
    const scoresA = [18, 17, 16, 15, 18]
    const scoresB = [14, 15, 14, 16, 13]
    const renderDraft = (label: string, scores: number[]) => [
      `  ${label}:`,
      ...categories.map((category, index) => `    ${category}: ${scores[index] ?? 15}`),
      `    total_score: ${categories.reduce((sum, _, index) => sum + (scores[index] ?? 15), 0)}`,
    ]

    return [
      'draft_scores:',
      ...renderDraft('Draft 1', scoresA),
      ...renderDraft('Draft 2', scoresB),
    ].join('\n')
  }

  it.each(cases)('accepts the strict YAML scorecard format for %s', async ({ phase, rubric }) => {
    const adapter = new MockOpenCodeAdapter()
    const voters: CouncilMember[] = [
      { modelId: 'model-a', name: 'Model A' },
    ]
    const drafts: DraftResult[] = [
      { memberId: 'draft-a', content: 'draft-a content', outcome: 'completed', duration: 1 },
      { memberId: 'draft-b', content: 'draft-b content', outcome: 'completed', duration: 1 },
    ]

    const rawResponse = buildStrictScorecardResponse(rubric.map(item => item.category))
    adapter.mockResponses.set('mock-session-1', rawResponse)

    const result = await conductVoting(
      adapter,
      voters,
      drafts,
      [{ type: 'text', content: 'vote prompt' }],
      '/tmp/test',
      phase,
    )

    expect(result.memberOutcomes).toEqual({ 'model-a': 'completed' })
    expect(result.votes).toHaveLength(2)
    expect(result.votes.map(vote => vote.totalScore).sort((a, b) => a - b)).toEqual([72, 84])
    expect(result.votes.every(vote => vote.scores.length === rubric.length)).toBe(true)
    expect(result.votes[0]?.scores.map(score => score.category)).toEqual(rubric.map(item => item.category))
    expect(result.voterDetails[0]?.rawResponse).toBe(rawResponse)
    expect(result.voterDetails[0]?.normalizedResponse).toBeUndefined()
  })

  it('keeps exact raw vote output and stores a cleaned validated scorecard when parsing repairs wrapper text', async () => {
    const adapter = new MockOpenCodeAdapter()
    const voters: CouncilMember[] = [
      { modelId: 'model-a', name: 'Model A' },
    ]
    const drafts: DraftResult[] = [
      { memberId: 'draft-a', content: 'draft-a content', outcome: 'completed', duration: 1 },
      { memberId: 'draft-b', content: 'draft-b content', outcome: 'completed', duration: 1 },
    ]

    const scorecard = buildStrictScorecardResponse(VOTING_RUBRIC_INTERVIEW.map(item => item.category))
    const rawResponse = [
      'Here is the scorecard:',
      '```yaml',
      scorecard,
      '```',
    ].join('\n')
    adapter.mockResponses.set('mock-session-1', rawResponse)

    const result = await conductVoting(
      adapter,
      voters,
      drafts,
      [{ type: 'text', content: 'vote prompt' }],
      '/tmp/test',
      'interview_draft',
    )

    expect(result.memberOutcomes).toEqual({ 'model-a': 'completed' })
    expect(result.voterDetails[0]?.rawResponse).toBe(rawResponse)
    expect(result.voterDetails[0]?.normalizedResponse).toContain('draft_scores:')
    expect(result.voterDetails[0]?.normalizedResponse).not.toContain('Here is the scorecard')
    expect(result.voterDetails[0]?.structuredOutput).toMatchObject({
      repairApplied: true,
    })
  })

  it('retries invalid vote output once before marking the voter invalid', async () => {
    const adapter = new MockOpenCodeAdapter()
    const voters: CouncilMember[] = [
      { modelId: 'model-a', name: 'Model A' },
    ]
    const drafts: DraftResult[] = [
      { memberId: 'draft-a', content: 'draft-a content', outcome: 'completed', duration: 1 },
      { memberId: 'draft-b', content: 'draft-b content', outcome: 'completed', duration: 1 },
    ]

    adapter.mockResponses.set('mock-session-1', 'Draft 1:\nScore: 18/20')
    const retryRawResponse = buildStrictScorecardResponse(VOTING_RUBRIC_INTERVIEW.map(item => item.category))
    adapter.mockResponses.set('mock-session-2', retryRawResponse)

    const result = await conductVoting(
      adapter,
      voters,
      drafts,
      [{ type: 'text', content: 'vote prompt' }],
      '/tmp/test',
      'interview_draft',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'disabled',
    )

    expect(result.memberOutcomes).toEqual({ 'model-a': 'completed' })
    expect(result.votes).toHaveLength(2)
    expect(result.voterDetails[0]?.rawResponse).toBe(retryRawResponse)
    expect(result.voterDetails[0]?.normalizedResponse).toBeUndefined()
    expect(adapter.promptCalls[0]?.options?.permission).toEqual(OPENCODE_DISABLED_PERMISSIONS)
    expect(adapter.promptCalls[1]?.options?.permission).toEqual(OPENCODE_DISABLED_PERMISSIONS)
  })
})
