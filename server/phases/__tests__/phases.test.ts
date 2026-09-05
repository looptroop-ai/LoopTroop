import { describe, it, expect } from 'vitest'
import { calculateFollowUpLimit } from '../interview/qa'
import { expandBeads } from '../beads/expand'
import type { BeadSubset } from '../beads/types'
import { createShellCommandSpec } from '@shared/commandSpec'

describe('Interview Q&A', () => {
  it('calculates follow-up limit at 20%', () => {
    expect(calculateFollowUpLimit(10)).toBe(2)
    expect(calculateFollowUpLimit(5)).toBe(1)
    expect(calculateFollowUpLimit(1)).toBe(1)
  })

  it('yields no follow-ups at all when the budget is zero', () => {
    // The profile accepts 0-100, and `Math.max(1, …)` turned a deliberate 0%
    // into one question — so an operator who had switched coverage follow-ups
    // off still got asked one.
    expect(calculateFollowUpLimit(50, 0)).toBe(0)
    expect(calculateFollowUpLimit(1, 0)).toBe(0)
    // The floor of one still applies to a small positive budget, which is a
    // rounding guard rather than an override of "off".
    expect(calculateFollowUpLimit(1, 1)).toBe(1)
    expect(calculateFollowUpLimit(100, 1)).toBe(1)
  })

  it('yields no follow-ups when there are no questions to follow up on', () => {
    // Same floor, the other way round: a percentage of nothing is nothing, but
    // `Math.max(1, 0)` budgeted a follow-up for an interview that asked nothing.
    expect(calculateFollowUpLimit(0)).toBe(0)
    expect(calculateFollowUpLimit(0, 1)).toBe(0)
    expect(calculateFollowUpLimit(0, 100)).toBe(0)
  })
})

describe('Beads Expansion', () => {
  it('expands subset beads to full fields', () => {
    const subsets: BeadSubset[] = [
      { id: 'b1', title: 'T1', prdRefs: [], description: 'd',
        contextGuidance: { patterns: ['Keep the draft aligned with PRD refs.'], anti_patterns: ['Do not drop later beads when output is long.'] },
        acceptanceCriteria: ['ac'], tests: ['t'], testCommands: [createShellCommandSpec('cmd')] },
    ]
    const expanded = expandBeads(subsets)
    expect(expanded.length).toBe(1)
    expect(expanded[0]!.priority).toBe(1)
    expect(expanded[0]!.status).toBe('pending')
    expect(expanded[0]!.iteration).toBe(1)
    expect(expanded[0]!.beadStartCommit).toBeNull()
  })
})
