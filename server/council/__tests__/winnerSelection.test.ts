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

describe('selectWinner breaks a tie the same way twice', () => {
  const threeMembers: CouncilMember[] = [
    { modelId: 'mai', name: 'MAI' },
    { modelId: 'second', name: 'Second' },
    { modelId: 'third', name: 'Third' },
  ]

  // The scores are built by walking `votes`, so the map's insertion order is the
  // order the votes arrived in — parallel model calls, which finish in whatever
  // order they finish. The same scorecard used to elect either draft.
  it.each([
    ['votes arriving in council order', ['second', 'third']],
    ['votes arriving in reverse', ['third', 'second']],
  ] as [string, string[]][])('picks the earlier council member with %s', (_label, order) => {
    const votes: Vote[] = order.map((draftId, index) => ({
      voterId: `voter-${index}`,
      draftId,
      scores: [],
      totalScore: 30,
    }))
    expect(selectWinner(votes, threeMembers)).toEqual({ winnerId: 'second', totalScore: 30 })
  })

  it('lets the main implementer win a tie it is part of, whenever its vote lands', () => {
    const votes: Vote[] = [
      { voterId: 'a', draftId: 'third', scores: [], totalScore: 30 },
      { voterId: 'b', draftId: 'mai', scores: [], totalScore: 30 },
      { voterId: 'c', draftId: 'second', scores: [], totalScore: 30 },
    ]
    expect(selectWinner(votes, threeMembers).winnerId).toBe('mai')
  })

  it('does not let council order beat a higher score', () => {
    const votes: Vote[] = [
      { voterId: 'a', draftId: 'second', scores: [], totalScore: 10 },
      { voterId: 'b', draftId: 'third', scores: [], totalScore: 40 },
    ]
    expect(selectWinner(votes, threeMembers).winnerId).toBe('third')
  })

  it('ranks a scored draft from outside the council last rather than first', () => {
    const votes: Vote[] = [
      { voterId: 'a', draftId: 'stranger', scores: [], totalScore: 30 },
      { voterId: 'b', draftId: 'third', scores: [], totalScore: 30 },
    ]
    expect(selectWinner(votes, threeMembers).winnerId).toBe('third')
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
