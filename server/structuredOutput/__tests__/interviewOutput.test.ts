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

  it('normalizes batch option strings and drops empty single-choice options', () => {
    const result = normalizeInterviewTurnOutput(tagged('INTERVIEW_BATCH', {
      batch_number: 1,
      progress: { current: 0, total: 1 },
      questions: [
        {
          id: 'Q01',
          question: 'Which approach?',
          phase: 'Custom',
          priority: 'urgent',
          answer_type: 'single_choice',
          options: [],
        },
        {
          id: 'Q02',
          question: 'Which checks?',
          options: ['  Unit tests  ', '   ', { key: 'lint', name: 'Lint' }],
        },
        {
          id: 'Q03',
          question: 'Which formats?',
          answer_type: 'multiple_choice',
          options: [],
        },
      ],
    }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('batch')
    if (result.value.kind !== 'batch') return
    expect(result.value.batch.questions).toEqual([
      { id: 'Q01', question: 'Which approach?', phase: 'Custom', priority: 'urgent' },
      {
        id: 'Q02',
        question: 'Which checks?',
        options: [{ id: 'opt1', label: 'Unit tests' }, { id: 'lint', label: 'Lint' }],
      },
      { id: 'Q03', question: 'Which formats?' },
    ])
  })

  it.each([
    ['a non-object change', null, 'is not an object'],
    ['an unknown type', { type: 'renamed', before: { id: 'Q01', phase: 'foundation', question: 'What is the original goal?' }, after: { id: 'Q01', phase: 'foundation', question: 'What is the refined goal?' } }, 'unknown type'],
    ['a non-object question', { type: 'modified', before: true, after: { id: 'Q01', phase: 'foundation', question: 'What is the refined goal?' } }, 'must be an object'],
    ['an unknown phase', { type: 'modified', before: { id: 'Q01', phase: 'custom', question: 'What is the original goal?' }, after: { id: 'Q01', phase: 'foundation', question: 'What is the refined goal?' } }, 'Unknown question phase'],
    ['both missing sides', { type: 'modified' }, 'is missing before and after'],
    ['a null before side', { type: 'modified', before: null, after: { id: 'Q01', phase: 'foundation', question: 'What is the refined goal?' } }, 'must use a populated before'],
    ['a null after side', { type: 'modified', before: { id: 'Q01', phase: 'foundation', question: 'What is the original goal?' }, after: null }, 'must use a populated after'],
    ['an added change with a before record', { type: 'added', before: { id: 'Q01', phase: 'foundation', question: 'What is the original goal?' }, after: { id: 'Q02', phase: 'foundation', question: 'What is another goal?' } }, 'with type added must use before: null'],
    ['a removed change with a populated after record', { type: 'removed', before: { id: 'Q01', phase: 'foundation', question: 'What is the original goal?' }, after: { id: 'Q02', phase: 'foundation', question: 'What is another goal?' } }, 'with type removed must use after: null'],
  ])('rejects refinement changes with %s', (_label, change, expectedError) => {
    const result = normalizeInterviewRefinementOutput(JSON.stringify({
      questions: [{ id: 'Q01', phase: 'foundation', question: 'What is the original goal?' }],
      changes: [change],
    }), winnerDraft, 10)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(expectedError)
  })

  it('soft-repairs malformed inspiration and hydrates a valid losing-draft question', () => {
    const winnerQuestions = [
      { id: 'Q01', phase: 'foundation', question: 'Original goal?' },
      { id: 'Q02', phase: 'structure', question: 'Original structure?' },
      { id: 'Q03', phase: 'assembly', question: 'Original assembly?' },
      { id: 'Q04', phase: 'assembly', question: 'Original release?' },
      { id: 'Q05', phase: 'assembly', question: 'Original format?' },
    ]
    const finalQuestions = [
      { id: 'Q01', phase: 'foundation', question: 'Refined goal?' },
      { id: 'Q02', phase: 'structure', question: 'Refined structure?' },
      { id: 'Q03', phase: 'assembly', question: 'Refined assembly?' },
      { id: 'Q04', phase: 'assembly', question: 'Refined release?' },
      { id: 'Q05', phase: 'assembly', question: 'Refined format?' },
    ]
    const losingDrafts = [{
      memberId: 'alternative',
      content: [
        'questions:',
        '  - id: Q09',
        '    phase: foundation',
        '    question: "Canonical inspiration?"',
      ].join('\n'),
    }]
    const result = normalizeInterviewRefinementOutput(JSON.stringify({
      questions: finalQuestions,
      changes: [
        {
          type: 'modified', before: winnerQuestions[0], after: finalQuestions[0],
          inspiration: {
            alternative_draft: 1,
            question: { id: 'Q09', phase: 'unknown phase', question: 'Canonical inspiration?' },
          },
        },
        {
          type: 'modified', before: winnerQuestions[1], after: finalQuestions[1],
          inspiration: { alternative_draft: 1, question: 42 },
        },
        {
          type: 'modified', before: winnerQuestions[2], after: finalQuestions[2],
          inspiration: { alternative_draft: 1, question: { question: '' } },
        },
        {
          type: 'modified', before: winnerQuestions[3], after: finalQuestions[3],
          inspiration: false,
        },
        {
          type: 'modified', before: winnerQuestions[4], after: finalQuestions[4],
          inspiration: null,
        },
      ],
    }), [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "Original goal?"',
      '  - id: Q02',
      '    phase: structure',
      '    question: "Original structure?"',
      '  - id: Q03',
      '    phase: assembly',
      '    question: "Original assembly?"',
      '  - id: Q04',
      '    phase: assembly',
      '    question: "Original release?"',
      '  - id: Q05',
      '    phase: assembly',
      '    question: "Original format?"',
    ].join('\n'), 10, losingDrafts)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.changes[0]?.inspiration).toMatchObject({
      memberId: 'alternative',
      question: { id: 'Q09', phase: 'foundation', question: 'Canonical inspiration?' },
    })
    expect(result.value.changes.slice(1).map(({ attributionStatus, inspiration }) => ({ attributionStatus, inspiration })))
      .toEqual([
        { attributionStatus: 'invalid_unattributed', inspiration: null },
        { attributionStatus: 'invalid_unattributed', inspiration: null },
        { attributionStatus: 'invalid_unattributed', inspiration: null },
        { attributionStatus: 'model_unattributed', inspiration: null },
      ])
  })

  it('removes a stale top-level question declared as removed', () => {
    const original = { id: 'Q01', phase: 'foundation', question: 'What is the original goal?' }
    const removed = { id: 'Q02', phase: 'structure', question: 'Which structure should be removed?' }
    const result = normalizeInterviewRefinementOutput(JSON.stringify({
      questions: [original, removed],
      changes: [{ type: 'removed', before: removed, after: null }],
    }), buildYamlDocument({ questions: [original, removed] }), 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questions).toEqual([original])
    expect(result.repairWarnings).toContain(
      'Removed stale top-level refined interview question Q02 using removed change at index 0.',
    )
  })

  it('normalizes duplicate winner ids when the caller already accounted for omitted changes', () => {
    const winner = buildYamlDocument({ questions: [
      { id: 'Q01', phase: 'foundation', question: 'First goal?' },
      { id: 'Q01', phase: 'assembly', question: 'Final step?' },
    ] })
    const result = normalizeInterviewRefinementOutput(JSON.stringify({
      questions: [{ id: 'Q03', phase: 'foundation', question: 'A final goal?' }],
    }), winner, 10, undefined, {
      missingChangesPolicy: 'accounted_elsewhere',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairWarnings).toContain('Renumbered duplicate question id Q01 at index 1 to Q02.')
  })

  it('rejects missing and unaccounted refinement changes', () => {
    const nonObject = normalizeInterviewRefinementOutput('[]', winnerDraft, 10)
    expect(nonObject.ok).toBe(false)
    if (!nonObject.ok) expect(nonObject.error).toContain('not a YAML/JSON object')

    const missingQuestions = normalizeInterviewRefinementOutput(JSON.stringify({ changes: [] }), winnerDraft, 10)
    expect(missingQuestions.ok).toBe(false)
    if (!missingQuestions.ok) expect(missingQuestions.error).toContain('missing questions')

    const unmatchedAfter = normalizeInterviewRefinementOutput(JSON.stringify({
      questions: [{ id: 'Q01', phase: 'foundation', question: 'Refined goal?' }],
      changes: [{
        type: 'modified',
        before: { id: 'Q01', phase: 'foundation', question: 'What is the original goal?' },
        after: { id: 'Q09', phase: 'foundation', question: 'Unlisted final question?' },
      }],
    }), winnerDraft, 10)
    expect(unmatchedAfter.ok).toBe(false)
    if (!unmatchedAfter.ok) expect(unmatchedAfter.error).toContain('does not match any question from the refined final list')
  })

  it('rejects a refined question referenced by multiple changes', () => {
    const winner = buildYamlDocument({ questions: [
      { id: 'Q01', phase: 'foundation', question: 'First goal?' },
      { id: 'Q02', phase: 'structure', question: 'Second goal?' },
    ] })
    const after = { id: 'Q03', phase: 'assembly', question: 'Combined final goal?' }
    const result = normalizeInterviewRefinementOutput(JSON.stringify({
      questions: [after],
      changes: [
        { type: 'modified', before: { id: 'Q01', phase: 'foundation', question: 'First goal?' }, after },
        { type: 'modified', before: { id: 'Q02', phase: 'structure', question: 'Second goal?' }, after },
      ],
    }), winner, 10)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('reuses a refined question already referenced by another change')
  })
})
