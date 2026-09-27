import { describe, expect, it } from 'vitest'
import {
  normalizeCoverageFollowUpQuestions,
  normalizeCoverageResultOutput,
  normalizeInterviewRefinementOutput,
  normalizeInterviewTurnOutput,
} from '../interviewOutput'
import { buildYamlDocument } from '../yamlUtils'
import { MAX_MULTIPLE_CHOICE_OPTIONS, MAX_SINGLE_CHOICE_OPTIONS } from '../../lib/constants'

function tagged(tag: string, value: unknown): string {
  return `<${tag}>\n${buildYamlDocument(value)}\n</${tag}>`
}

const winnerDraft = [
  'questions:',
  '  - id: Q01',
  '    phase: foundation',
  '    question: "What is the original goal?"',
].join('\n')

describe('interview output normalization edge cases', () => {
  it('normalizes coverage follow-up choice limits, empty choices, aliases, and defaults', () => {
    const normalized = normalizeCoverageFollowUpQuestions([
      '  What should be decided?  ',
      '   ',
      { id: 'SINGLE_EMPTY', question: 'Which choice?', answer_type: 'single_choice', options: [] },
      { id: 'MULTI_EMPTY', question: 'Which choices?', answer_type: 'multiple_choice', options: [] },
      {
        id: 'SINGLE_LIMIT', prompt: 'Which option?', type: 'radio',
        options: [
          { id: 'repeat', label: 'First repeat' },
          { id: 'repeat', label: 'Discarded repeat' },
          ...Array.from({ length: 11 }, (_, index) => ({ id: `single-${index}`, label: `Single ${index}` })),
        ],
      },
      {
        id: 'MULTI_LIMIT', text: 'Which platforms?', type: 'checkbox',
        options: Array.from({ length: MAX_MULTIPLE_CHOICE_OPTIONS + 1 }, (_, index) => ({
          id: `multi-${index}`,
          label: `Multiple ${index}`,
        })),
      },
      { id: 'FREE', question: 'What else?', answer_type: 'free_text' },
      { id: 'UNKNOWN', question: 'What should happen?', phase: 'Custom', priority: 'urgent', answer_type: 'dropdown' },
      null,
    ], { phase: 'Foundation', priority: 'high', rationale: 'Default context' })

    expect(normalized.questions.map(({ id }) => id)).toEqual([
      'FU1', 'SINGLE_EMPTY', 'MULTI_EMPTY', 'SINGLE_LIMIT', 'MULTI_LIMIT', 'FREE', 'UNKNOWN',
    ])
    expect(normalized.questions[0]).toMatchObject({
      question: 'What should be decided?',
      phase: 'Foundation',
      priority: 'high',
      rationale: 'Default context',
    })
    expect(normalized.questions[1]).not.toHaveProperty('answerType')
    expect(normalized.questions[2]).not.toHaveProperty('answerType')
    expect(normalized.questions[3]?.options).toHaveLength(MAX_SINGLE_CHOICE_OPTIONS)
    expect(normalized.questions[4]?.options).toHaveLength(MAX_MULTIPLE_CHOICE_OPTIONS)
    expect(normalized.questions[5]).not.toHaveProperty('answerType')
    expect(normalized.questions[6]).toMatchObject({ phase: 'Custom', priority: 'urgent' })
    expect(normalized.repairWarnings).toContain(
      'Coverage follow-up question SINGLE_LIMIT: removed duplicate option ids repeat and kept the first occurrence.',
    )
  })

  it.each([
    ['missing questions', { batch_number: 1, progress: { current: 0, total: 1 } }, 'missing questions'],
    ['invalid batch number', { batch_number: 0, progress: { current: 0, total: 1 }, questions: [{ id: 'Q01', question: 'Goal?' }] }, 'valid batch_number'],
    ['negative current progress', { batch_number: 1, progress: { current: -1, total: 1 }, questions: [{ id: 'Q01', question: 'Goal?' }] }, 'progress.current'],
    ['total below current progress', { batch_number: 1, progress: { current: 2, total: 1 }, questions: [{ id: 'Q01', question: 'Goal?' }] }, 'progress.total'],
  ])('rejects interview batches with %s', (_label, payload, error) => {
    const result = normalizeInterviewTurnOutput(tagged('INTERVIEW_BATCH', payload))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain(error)
  })

  it('rejects complete interview envelopes without answers and final schema fields', () => {
    const noAnswers = normalizeInterviewTurnOutput(tagged('INTERVIEW_COMPLETE', { status: 'complete' }))
    const noFinalSchema = normalizeInterviewTurnOutput(tagged('INTERVIEW_COMPLETE', { answers: [{ id: 'Q01', answer: 'Ship it' }] }))

    expect(noAnswers.ok).toBe(false)
    expect(noFinalSchema.ok).toBe(false)
  })

  it('reports duplicate question repairs and stable phase ordering during refinement', () => {
    const result = normalizeInterviewRefinementOutput(JSON.stringify({
      questions: [
        { id: 'Q01', phase: 'assembly', question: 'What is the final step?' },
        { id: 'Q01', phase: 'foundation', question: 'What is the main goal?' },
      ],
    }), winnerDraft, 10, undefined, { missingChangesPolicy: 'accounted_elsewhere' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questions.map(({ phase }) => phase)).toEqual(['foundation', 'assembly'])
    expect(result.value.questions.map(({ id }) => id)).toEqual(['Q02', 'Q01'])
    expect(result.repairWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Renumbered duplicate question id'),
      'Applied stable interview phase reordering (foundation -> structure -> assembly).',
    ]))
  })

  it('rejects refinement questions over the configured initial-question limit', () => {
    const result = normalizeInterviewRefinementOutput(JSON.stringify({
      questions: [
        { id: 'Q01', phase: 'foundation', question: 'First question?' },
        { id: 'Q02', phase: 'structure', question: 'Second question?' },
      ],
      changes: [],
    }), winnerDraft, 1)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('exceeds max_initial_questions=1')
  })

  it('soft-repairs malformed inspiration questions and rejects out-of-range draft references', () => {
    const finalQuestion = { id: 'Q01', phase: 'foundation', question: 'What is the refined goal?' }
    const before = { id: 'Q01', phase: 'foundation', question: 'What is the original goal?' }
    const malformed = normalizeInterviewRefinementOutput(JSON.stringify({
      questions: [finalQuestion],
      changes: [{
        type: 'modified', before, after: finalQuestion,
        inspiration: { alternative_draft: 1, question: '' },
      }],
    }), winnerDraft, 10, [{ memberId: 'alternative', content: 'questions: []' }])

    expect(malformed.ok).toBe(true)
    if (malformed.ok) {
      expect(malformed.value.changes[0]).toMatchObject({ inspiration: null, attributionStatus: 'invalid_unattributed' })
    }

    const outOfRange = normalizeInterviewRefinementOutput(JSON.stringify({
      questions: [finalQuestion],
      changes: [{
        type: 'modified', before, after: finalQuestion,
        inspiration: { alternative_draft: 2, question: 'Alternative question?' },
      }],
    }), winnerDraft, 10, [{ memberId: 'alternative', content: 'questions: []' }])

    expect(outOfRange.ok).toBe(true)
    if (outOfRange.ok) {
      expect(outOfRange.value.changes[0]).toMatchObject({ inspiration: null, attributionStatus: 'invalid_unattributed' })
      expect(outOfRange.repairWarnings.join('\n')).toContain('draftIndex 1 is out of bounds')
    }
  })

  it('hydrates inspiration from a uniquely matching losing-draft question', () => {
    const finalQuestion = { id: 'Q01', phase: 'foundation', question: 'What is the refined goal?' }
    const before = { id: 'Q01', phase: 'foundation', question: 'What is the original goal?' }
    const result = normalizeInterviewRefinementOutput(JSON.stringify({
      questions: [finalQuestion],
      changes: [{
        type: 'modified', before, after: finalQuestion,
        inspiration: {
          alternative_draft: 1,
          question: { id: 'Q09', phase: 'foundation', question: 'A paraphrased inspiration' },
        },
      }],
    }), winnerDraft, 10, [{
      memberId: 'alternative',
      content: [
        'questions:',
        '  - id: Q09',
        '    phase: foundation',
        '    question: "The canonical inspiration question"',
      ].join('\n'),
    }])

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.changes[0]?.inspiration).toMatchObject({
        memberId: 'alternative',
        question: { id: 'Q09', phase: 'foundation', question: 'The canonical inspiration question' },
      })
    }
  })

  it('does not classify a closing fence as orphaned when the artifact opened a fence', () => {
    const result = normalizeCoverageResultOutput([
      '```yaml',
      'status: clean',
      'gaps: []',
      'follow_up_questions: []',
      '```',
      'commentary after a properly fenced artifact',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('clean')
      expect(result.repairWarnings).not.toContain(
        'Trimmed an orphan trailing closing code fence and commentary after the complete coverage artifact.',
      )
    }
  })

  it('keeps coverage invalid when a repaired gap list still has an invalid status', () => {
    const result = normalizeCoverageResultOutput([
      'status: unknown',
      'gaps:',
      '  "   "',
      'follow_up_questions: []',
    ].join('\n'))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('missing valid status')
  })
})
