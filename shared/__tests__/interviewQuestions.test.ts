import { describe, expect, it, vi } from 'vitest'
import {
  extractInterviewQuestionPreviews,
  parseInterviewQuestions,
  unwrapInterviewYamlFence,
} from '../interviewQuestions'

describe('shared interview question parsing', () => {
  it('rejects malformed entries inside a structured questions collection', () => {
    const content = [
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    question: "What problem are we solving?"',
      '  - id: Q02',
      '    phase: Structure',
      '    rationale: "Missing the actual question text."',
    ].join('\n')

    expect(() => parseInterviewQuestions(content)).toThrow(
      /structured questions collection contains malformed entries at 2/,
    )
  })

  it('normalizes question maps, aliases, phases, and IDs', () => {
    const questions = parseInterviewQuestions(JSON.stringify({
      questions: {
        question1: { prompt: '  What outcome matters?  ', category: 'foundation' },
        Q8: { text: 'Where should the work begin?', stage: 'assembly' },
      },
    }))

    expect(questions).toEqual([
      { id: 'Q01', phase: 'Foundation', question: 'What outcome matters?' },
      { id: 'Q08', phase: 'Assembly', question: 'Where should the work begin?' },
    ])
    expect(extractInterviewQuestionPreviews(JSON.stringify({ questions: { Q10: 'Which path is safest?' } })))
      .toEqual([{ id: 'Q10', question: 'Which path is safest?' }])
  })

  it('uses loose headings and inline metadata when the content is not structured YAML', () => {
    const questions = extractInterviewQuestionPreviews([
      '# Foundation',
      'What outcome matters most?',
      '## Structure',
      '- Q7: Which parts need to connect?',
      '[Assembly] Q09: How will success be checked?',
    ].join('\n'))

    expect(questions).toEqual([
      { id: 'Q01', phase: 'Foundation', question: 'What outcome matters most?' },
      { id: 'Q07', phase: 'Structure', question: 'Which parts need to connect?' },
      { id: 'Q09', phase: 'Assembly', question: 'How will success be checked?' },
    ])
  })

  it('reports when malformed structured input needed a safe inline repair', () => {
    const onCandidateRepairApplied = vi.fn()
    const questions = parseInterviewQuestions([
      'questions: - id: Q01 phase: foundation question: "What outcome should the flow support?"',
    ].join('\n'), { onCandidateRepairApplied })

    expect(questions).toEqual([
      { id: 'Q01', phase: 'Foundation', question: 'What outcome should the flow support?' },
    ])
    expect(onCandidateRepairApplied).toHaveBeenCalledTimes(1)
  })

  it('accepts a top-level question array only when the caller enables it', () => {
    const content = JSON.stringify([{ id: 'Q3', phase: 'structure', text: 'What must connect?' }])

    expect(() => parseInterviewQuestions(content)).toThrow('could not parse interview questions')
    expect(parseInterviewQuestions(content, { allowTopLevelArray: true })).toEqual([
      { id: 'Q03', phase: 'Structure', question: 'What must connect?' },
    ])
  })

  it('returns the original nonempty content when no candidate can be unwrapped', () => {
    expect(unwrapInterviewYamlFence('  no structured artifact here  ')).toBe('no structured artifact here')
  })
})
