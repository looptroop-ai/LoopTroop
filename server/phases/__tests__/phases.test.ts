import { describe, it, expect } from 'vitest'
import { createBatches, processAnswers, calculateFollowUpLimit } from '../interview/qa'
import { expandBeads } from '../beads/expand'
import type { InterviewQuestion } from '../interview/types'
import type { BeadSubset } from '../beads/types'
import { createShellCommandSpec } from '@shared/commandSpec'

describe('Interview Q&A', () => {
  const questions: InterviewQuestion[] = [
    { id: 'q1', phase: 'scope', question: 'What scope?', priority: 'critical', rationale: 'test' },
    { id: 'q2', phase: 'scope', question: 'What edge cases?', priority: 'high', rationale: 'test' },
    { id: 'q3', phase: 'ux', question: 'What UX?', priority: 'medium', rationale: 'test' },
    { id: 'q4', phase: 'ux', question: 'What flow?', priority: 'low', rationale: 'test' },
    { id: 'q5', phase: 'tech', question: 'What tech?', priority: 'medium', rationale: 'test' },
  ]

  it('creates batches of 3', () => {
    const batches = createBatches(questions, 3)
    expect(batches.length).toBe(2)
    expect(batches[0]!.questions.length).toBe(3)
    expect(batches[1]!.questions.length).toBe(2)
  })

  it('processes answers including skipped', () => {
    const answers = processAnswers(questions, { q1: 'answer 1', q3: 'answer 3' })
    expect(answers.length).toBe(5)
    expect(answers[0]!.skipped).toBe(false)
    expect(answers[1]!.skipped).toBe(true)
    expect(answers[2]!.skipped).toBe(false)
  })

  it('calculates follow-up limit at 20%', () => {
    expect(calculateFollowUpLimit(10)).toBe(2)
    expect(calculateFollowUpLimit(5)).toBe(1)
    expect(calculateFollowUpLimit(1)).toBe(1)
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
