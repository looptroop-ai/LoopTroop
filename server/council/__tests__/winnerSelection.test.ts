import { describe, expect, it } from 'vitest'
import type { CouncilMember, DraftResult, Vote } from '../types'
import { selectWinner } from '../voter'
import { requireWinnerDraft } from '../draftUtils'

const members: CouncilMember[] = [
  { modelId: 'mai', name: 'MAI' },
  { modelId: 'other', name: 'Other' },
]

describe('selectWinner fails closed', () => {
  it('never elects a member whose draft nobody scored', () => {
    const votes: Vote[] = [
      { voterId: 'mai', draftId: 'other', scores: [], totalScore: 0 },
    ]
    expect(selectWinner(votes, members).winnerId).toBe('other')
  })

  it('throws when no draft was scored at all', () => {
    expect(() => selectWinner([], members)).toThrow(/no scored draft/i)
  })

  it('still prefers the main implementer among scored drafts on a tie', () => {
    const votes: Vote[] = [
      { voterId: 'a', draftId: 'other', scores: [], totalScore: 0 },
      { voterId: 'b', draftId: 'mai', scores: [], totalScore: 0 },
    ]
    expect(selectWinner(votes, members).winnerId).toBe('mai')
  })

  it('still picks the highest score when the main implementer scored lower', () => {
    const votes: Vote[] = [
      { voterId: 'a', draftId: 'mai', scores: [], totalScore: 10 },
      { voterId: 'b', draftId: 'other', scores: [], totalScore: 40 },
    ]
    expect(selectWinner(votes, members)).toEqual({ winnerId: 'other', totalScore: 40 })
  })
})

describe('requireWinnerDraft', () => {
  const drafts: DraftResult[] = [
    { memberId: 'mai', content: 'draft', outcome: 'completed', duration: 1 },
  ]

  it('returns the winner draft', () => {
    expect(requireWinnerDraft(drafts, 'mai', 'PRD').memberId).toBe('mai')
  })

  it('names the phase and the winner when no draft matches', () => {
    expect(() => requireWinnerDraft(drafts, 'ghost', 'PRD'))
      .toThrow('PRD winner ghost has no matching draft — cannot refine')
  })
})
