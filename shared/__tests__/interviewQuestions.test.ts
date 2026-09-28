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

  it('normalizes raw question strings in an allowed top-level array', () => {
    expect(parseInterviewQuestions(JSON.stringify([
      '[Structure] Question 16: Which parts must connect?',
    ]), { allowTopLevelArray: true })).toEqual([
      { id: 'Q16', phase: 'Structure', question: 'Which parts must connect?' },
    ])
  })

  it('uses inline IDs when a structured question object has no ID field', () => {
    expect(parseInterviewQuestions(JSON.stringify([
      { phase: 'assembly', question: 'Q08: How will the parts fit together?' },
    ]), { allowTopLevelArray: true })).toEqual([
      { id: 'Q08', phase: 'Assembly', question: 'How will the parts fit together?' },
    ])
  })

  it('returns the original nonempty content when no candidate can be unwrapped', () => {
    expect(unwrapInterviewYamlFence('  no structured artifact here  ')).toBe('no structured artifact here')
  })

  it('reads nested question maps and keeps custom phases and IDs', () => {
    expect(parseInterviewQuestions(JSON.stringify({
      items: {
        question3: '[Foundation] What outcome matters?',
        custom: { qid: 'research', section: ' Discovery ', content: 'What evidence is missing?' },
      },
    }))).toEqual([
      { id: 'Q03', phase: 'Foundation', question: 'What outcome matters?' },
      { id: 'research', phase: 'Discovery', question: 'What evidence is missing?' },
    ])
  })

  it('reports malformed entries in strict question maps by key', () => {
    expect(() => parseInterviewQuestions(JSON.stringify({
      questions: {
        Q1: { phase: 'foundation', question: 'What matters?' },
        broken: { rationale: 'No question or phase' },
      },
    }))).toThrow(/malformed entries at broken/)
  })

  it('surfaces invalid YAML when no loose questions can be recovered', () => {
    expect(() => parseInterviewQuestions('questions: [\n')).toThrow(/^Invalid YAML:/)
  })

  it('falls back to loose questions after a malformed YAML wrapper', () => {
    expect(extractInterviewQuestionPreviews([
      'answer: [unterminated',
      '# Assembly',
      '- Q12: How will this be checked?',
    ].join('\n'))).toEqual([
      { id: 'Q12', phase: 'Assembly', question: 'How will this be checked?' },
    ])
  })

  it('closes an unclosed question before the next structured item', () => {
    const onCandidateRepairApplied = vi.fn()
    expect(parseInterviewQuestions([
      'questions:',
      '  - id: Q21',
      '    phase: foundation',
      '    question: "What outcome matters?',
      '',
      '  - id: Q22',
      '    phase: structure',
      '    question: "Which parts connect?"',
    ].join('\n'), { onCandidateRepairApplied })).toEqual([
      { id: 'Q21', phase: 'Foundation', question: 'What outcome matters?' },
      { id: 'Q22', phase: 'Structure', question: 'Which parts connect?' },
    ])
    expect(onCandidateRepairApplied).toHaveBeenCalledTimes(1)
  })

  it('repairs bare phase list entries with a following question field', () => {
    const onCandidateRepairApplied = vi.fn()
    expect(parseInterviewQuestions([
      'questions:',
      '  - foundation',
      '    question: "What outcome matters?"',
      '  - assembly',
      '    prompt: "How should the pieces fit?"',
    ].join('\n'), { onCandidateRepairApplied })).toEqual([
      { id: 'Q01', phase: 'Foundation', question: 'What outcome matters?' },
      { id: 'Q02', phase: 'Assembly', question: 'How should the pieces fit?' },
    ])
    expect(onCandidateRepairApplied).toHaveBeenCalledTimes(1)
  })

  it('recovers multiline loose questions without consuming the next item', () => {
    expect(extractInterviewQuestionPreviews([
      '# Foundation',
      '- id: Q14',
      'phase: foundation',
      'question: "What outcome should',
      'the first version support?',
      '- id: Q15',
      'phase: structure',
      'question: "How should it connect?"',
    ].join('\n'))).toEqual([
      { id: 'Q14', phase: 'Foundation', question: 'What outcome should the first version support?' },
      { id: 'Q15', phase: 'Structure', question: 'How should it connect?' },
    ])
  })

  it('carries a recovered loose ID to the next bare phase entry', () => {
    expect(extractInterviewQuestionPreviews([
      'invalid: [wrapper',
      '# Foundation',
      '- foundation',
      'question: "What outcome matters? id: Q7 phase: foundation"',
      '- assembly',
      'question: "How will the pieces fit?"',
    ].join('\n'))).toEqual([
      { id: 'Q01', phase: 'Foundation', question: 'What outcome matters? foundation' },
      { id: 'Q07', phase: 'Assembly', question: 'How will the pieces fit?' },
    ])
  })

  it('uses only indented prose as a loose question continuation', () => {
    expect(extractInterviewQuestionPreviews([
      'invalid: [wrapper',
      'question: What must the first version do?',
      '  phase: Discovery',
      '  before expanding further?',
    ].join('\n'))).toEqual([
      { id: 'Q01', phase: 'Discovery', question: 'What must the first version do? before expanding further?' },
    ])
  })

  it('preserves escaped quotes and skips blank lines while recovering a loose question', () => {
    const questions = extractInterviewQuestionPreviews([
      'invalid: [wrapper',
      '# Foundation',
      'question: "What is the \\"best\\" outcome?',
      '',
      '  before choosing?"',
    ].join('\n'))

    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({ id: 'Q01', phase: 'Foundation' })
    expect(questions[0]?.question).toContain('best')
    expect(questions[0]?.question).toContain('before choosing?')
  })

  it('returns no previews for an empty nested question wrapper', () => {
    expect(extractInterviewQuestionPreviews(JSON.stringify({ result: { items: {} } }))).toEqual([])
  })
})
