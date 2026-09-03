import { describe, expect, it } from 'vitest'
import { normalizeVoteScorecardOutput } from '../index'
import { MAX_VOTE_CATEGORY_SCORE, MAX_VOTE_TOTAL_SCORE } from '../../council/types'
import { PROM2, PROM11, PROM21 } from '../../prompts/index'

const CATEGORIES = ['Coverage', 'Correctness']

function buildScorecard(scores: number[]): string {
  return [
    'draft_scores:',
    '  Draft 1:',
    ...CATEGORIES.map((category, index) => `    ${category}: ${scores[index]}`),
    `    total_score: ${scores.reduce((sum, score) => sum + score, 0)}`,
  ].join('\n')
}

describe('vote score bounds come from one constant', () => {
  it('accepts a category score at the maximum', () => {
    const result = normalizeVoteScorecardOutput(
      buildScorecard([MAX_VOTE_CATEGORY_SCORE, 1]),
      ['Draft 1'],
      CATEGORIES,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.draftScores['Draft 1']?.Coverage).toBe(MAX_VOTE_CATEGORY_SCORE)
  })

  it('rejects a category score one above the maximum', () => {
    const result = normalizeVoteScorecardOutput(
      buildScorecard([MAX_VOTE_CATEGORY_SCORE + 1, 1]),
      ['Draft 1'],
      CATEGORIES,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Invalid score for Draft 1 / Coverage')
  })

  it.each([PROM2, PROM11, PROM21])('states the same bounds in $id', (template) => {
    const instructions = template.instructions.join('\n')
    expect(instructions).toContain(`maximum ${MAX_VOTE_CATEGORY_SCORE} points per category`)
    expect(instructions).toContain(`total maximum ${MAX_VOTE_TOTAL_SCORE}`)
    expect(instructions).toContain(`plain integers from 0 to ${MAX_VOTE_CATEGORY_SCORE}`)
    expect(template.task).toContain(`from 0 to ${MAX_VOTE_TOTAL_SCORE}`)
  })
})
