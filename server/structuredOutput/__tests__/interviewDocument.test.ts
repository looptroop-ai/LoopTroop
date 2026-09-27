import { describe, expect, it } from 'vitest'
import { TEST } from '../../test/factories'
import {
  buildApprovedInterviewDocument,
  buildInterviewDocumentYaml,
  normalizeInterviewDocumentOutput,
  normalizeResolvedInterviewDocumentOutput,
  stripSkipReasonsFromInterviewYaml,
  toDraftInterviewDocument,
  updateInterviewDocumentAnswers,
} from '../interviewDocument'
import type { InterviewDocument } from '../../../shared/interviewArtifact'

function interviewDocument(): InterviewDocument {
  const result = normalizeInterviewDocumentOutput(JSON.stringify({
    schema_version: 1,
    ticket_id: TEST.externalId,
    artifact: 'interview',
    status: 'approved',
    generated_by: { winner_model: TEST.model, generated_at: TEST.timestamp },
    questions: [
      {
        id: 'Q1',
        phase: 'Structure',
        prompt: 'Which plan?',
        source: 'compiled',
        answer_type: 'single_choice',
        options: [{ id: 'quick', label: 'Quick' }, { id: 'safe', label: 'Safe' }],
        answer: { selected_option_ids: ['quick'], answered_by: 'user', answered_at: TEST.timestamp },
      },
      {
        id: 'Q2',
        phase: 'Foundation',
        prompt: 'What is blocking progress?',
        source: 'prompt_follow_up',
        follow_up_round: 1,
        answer_type: 'free_text',
        answer: {
          skipped: true,
          answered_by: 'user_skip',
          answered_at: TEST.timestamp,
          skip_reason: 'Not relevant to this ticket.',
        },
      },
      {
        id: 'Q3',
        phase: 'Assembly',
        prompt: 'Which checks matter?',
        source: 'coverage_follow_up',
        follow_up_round: 2,
        answer_type: 'multiple_choice',
        options: [{ id: 'unit', label: 'Unit tests' }, { id: 'lint', label: 'Lint' }],
        answer: { selected_option_ids: ['unit'], answered_by: 'user', answered_at: TEST.timestamp },
      },
    ],
    follow_up_rounds: [{ round_number: 2, source: 'coverage', question_ids: ['Q3'] }],
    summary: { goals: ['Finish the task'], constraints: [], non_goals: [], final_free_form_answer: '' },
    approval: { approved_by: 'user', approved_at: TEST.timestamp },
  }), { ticketId: TEST.externalId })
  if (!result.ok) throw new Error(result.error)
  return result.value
}

describe('interview document serialization and edits', () => {
  it('omits empty skip reasons and strips non-model reasons from valid and malformed YAML', () => {
    const document = interviewDocument()
    const yaml = buildInterviewDocumentYaml(document)
    expect(yaml).toContain('skip_reason: Not relevant to this ticket.')

    const withoutReasons = stripSkipReasonsFromInterviewYaml(yaml)
    expect(withoutReasons).not.toContain('skip_reason:')
    expect(stripSkipReasonsFromInterviewYaml('questions: []\n')).toBe('questions: []\n')

    const malformed = [
      'questions:',
      '  - id: Q1',
      '    answer:',
      '      skipped: true',
      '      skip_reason: |',
      '        private context',
      '        second line',
      '      answered_by: user_skip',
    ].join('\n')
    const stripped = stripSkipReasonsFromInterviewYaml(malformed)
    expect(stripped).not.toContain('private context')
    expect(stripped).toContain('answered_by: user_skip')
  })

  it('updates free-text and choice answers while retaining deliberate skip history', () => {
    const document = interviewDocument()
    const next = updateInterviewDocumentAnswers(document, [
      {
        id: 'Q1',
        answer: { skipped: false, selected_option_ids: ['safe', 'quick'], free_text: '' },
      },
      {
        id: 'Q2',
        answer: { skipped: true, selected_option_ids: ['ignored'], free_text: '' },
      },
      {
        id: 'Q3',
        answer: { skipped: false, selected_option_ids: ['lint', 'lint', 'unit'], free_text: '' },
      },
    ], '2026-02-03T04:05:06.000Z')

    expect(next.status).toBe('draft')
    expect(next.approval).toEqual({ approved_by: '', approved_at: '' })
    expect(next.questions[0]?.answer).toMatchObject({
      skipped: false,
      selected_option_ids: ['safe'],
      answered_by: 'user',
      answered_at: '2026-02-03T04:05:06.000Z',
      skip_reason: null,
    })
    expect(next.questions[1]?.answer).toMatchObject({
      skipped: true,
      selected_option_ids: [],
      answered_by: 'user_skip',
      answered_at: TEST.timestamp,
      skip_reason: 'Not relevant to this ticket.',
    })
    expect(next.questions[2]?.answer).toMatchObject({
      skipped: false,
      selected_option_ids: ['lint', 'unit'],
      answered_by: 'user',
      skip_reason: null,
    })

    expect(buildApprovedInterviewDocument(next, '2026-03-04T05:06:07.000Z')).toMatchObject({
      status: 'approved',
      approval: { approved_by: 'user', approved_at: '2026-03-04T05:06:07.000Z' },
    })
    expect(toDraftInterviewDocument(buildApprovedInterviewDocument(next, TEST.timestamp)).approval)
      .toEqual({ approved_by: '', approved_at: '' })
  })
})

describe('resolved interview normalization', () => {
  it('restores the canonical question order and answer metadata', () => {
    const canonical = interviewDocument()
    const result = normalizeResolvedInterviewDocumentOutput(JSON.stringify({
      ...canonical,
      ticket_id: 'candidate-ticket',
      status: 'approved',
      generated_by: { ...canonical.generated_by, winner_model: 'candidate-model' },
      questions: [...canonical.questions].reverse().map((question) => ({
        ...question,
        phase: 'changed',
        answer: question.id === 'Q2'
          ? { skipped: false, free_text: 'Resolved the blocker.', answered_by: 'test model', answered_at: TEST.timestamp }
          : question.answer,
      })),
    }), {
      ticketId: TEST.externalId,
      canonicalInterviewContent: buildInterviewDocumentYaml(canonical),
      memberId: TEST.model,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questions.map((question) => question.id)).toEqual(['Q1', 'Q2', 'Q3'])
    expect(result.value.questions[0]?.phase).toBe('Structure')
    expect(result.value.questions[1]?.answer).toMatchObject({
      skipped: false,
      free_text: 'Resolved the blocker.',
      answered_by: 'ai_skip',
      skip_reason: null,
    })
    expect(result.value.approval).toEqual({ approved_by: '', approved_at: '' })
    expect(result.repairWarnings).toContain('Canonicalized question order to match the approved Interview Results artifact.')
    expect(result.repairWarnings).toContain('Cleared approval fields for the AI-generated Full Answers artifact.')
    expect(result.repairWarnings).toContain(`Canonicalized ticket_id from "candidate-ticket" to "${TEST.externalId}".`)
    expect(result.repairWarnings).toContain(`Canonicalized generated_by.winner_model from "candidate-model" to "${TEST.model}".`)
  })

  it('rejects a resolved artifact that drops a canonical question', () => {
    const canonical = interviewDocument()
    const result = normalizeResolvedInterviewDocumentOutput(JSON.stringify({
      ...canonical,
      questions: canonical.questions.slice(0, 2),
    }), {
      ticketId: TEST.externalId,
      canonicalInterviewContent: buildInterviewDocumentYaml(canonical),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('preserve all 3 canonical questions')
    expect(result.error).toContain('missing canonical ids: Q3')
  })

  it('normalizes legacy metadata, string options, yes/no answers, and malformed rounds', () => {
    const result = normalizeInterviewDocumentOutput(JSON.stringify({
      artifact: 'prd',
      status: 'complete',
      generated_by: { winner_model: TEST.model, generated_at: TEST.timestamp },
      questions: [
        {
          id: 'Q1',
          phase: 'Discovery',
          prompt: 'Which choices are acceptable?',
          source: 'legacy_source',
          answer_type: 'multiple_choice',
          options: [' Agree ', '  ', { key: 'other', name: ' Other ' }],
          answer: {
            selected_option_ids: ['opt1', 'other'],
            answered_by: 'user',
            answered_at: TEST.timestamp,
          },
        },
        {
          id: 'Q2',
          phase: 'Assembly',
          prompt: 'Should the pieces ship together?',
          source: 'final_free_form',
          answer_type: 'yes/no',
          answer: {},
        },
        {
          id: 'Q3',
          phase: 'Structure',
          prompt: 'What details belong in the handoff?',
          answer_type: 'free_text',
          answer: { selected_option_ids: ['ignored'], free_text: 'Keep the context.' },
        },
        {
          id: 'Q4',
          phase: 'Structure',
          prompt: 'Should the review be synchronous?',
          answer_type: 'single_choice',
          options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
          answer: { selected_option_ids: ['no', 'yes'] },
        },
        {
          id: 'Q4',
          phase: 'Assembly',
          prompt: 'What needs a final check?',
          answer_type: 'free_text',
          answer: { free_text: 'The release notes.' },
        },
      ],
      follow_up_rounds: [{ round_number: 0, source: 'unknown' }],
    }), { ticketId: TEST.externalId, allowMalformedFollowUpRounds: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.ticket_id).toBe(TEST.externalId)
    expect(result.value.questions[0]).toMatchObject({
      phase: 'Discovery',
      source: 'compiled',
      options: [{ id: 'opt1', label: 'Agree' }, { id: 'other', label: 'Other' }],
    })
    expect(result.value.questions[1]).toMatchObject({
      answer_type: 'single_choice',
      options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
      answer: { skipped: true, answered_by: 'ai_skip', answered_at: '' },
    })
    expect(result.value.questions[2]?.answer.selected_option_ids).toEqual([])
    expect(result.value.questions[3]?.answer.selected_option_ids).toEqual(['no'])
    expect(result.value.questions[4]?.id).toBe('Q05')
    expect(result.repairWarnings).toEqual(expect.arrayContaining([
      'Question Q3: dropped selected_option_ids for free_text answer_type.',
      'Question Q4: kept only the first selected option for single_choice answer_type.',
      'Renumbered duplicate question id "Q4" to "Q05".',
    ]))
    expect(result.value.follow_up_rounds).toEqual([])
    expect(result.repairWarnings).toEqual(expect.arrayContaining([
      'Filled missing ticket_id from runtime context.',
      'Normalized artifact "prd" to "interview".',
      'Normalized status "complete" to "draft".',
      'Question Q2: normalized yes/no answer_type to single_choice with Yes/No options.',
      'Canonicalized follow_up_rounds to match the approved Interview Results artifact.',
    ]))
  })

  it('rejects unsupported answer types and invalid canonical resolved documents', () => {
    const invalidQuestion = normalizeInterviewDocumentOutput(JSON.stringify({
      ticket_id: TEST.externalId,
      generated_by: { winner_model: TEST.model, generated_at: TEST.timestamp },
      questions: [{
        id: 'Q1',
        phase: 'Foundation',
        prompt: 'What should happen?',
        answer_type: 'rating_scale',
        answer: {},
      }],
    }))
    expect(invalidQuestion.ok).toBe(false)
    if (!invalidQuestion.ok) expect(invalidQuestion.error).toContain('unsupported answer_type "rating_scale"')

    const invalidCanonical = normalizeResolvedInterviewDocumentOutput('{}', {
      ticketId: TEST.externalId,
      canonicalInterviewContent: 'not an interview artifact',
    })
    expect(invalidCanonical.ok).toBe(false)
    if (!invalidCanonical.ok) expect(invalidCanonical.error).toContain('Canonical interview artifact is invalid')
  })

  it('rejects missing answers, malformed questions, and invalid follow-up rounds', () => {
    const base = {
      ticket_id: TEST.externalId,
      generated_by: { winner_model: TEST.model, generated_at: TEST.timestamp },
      questions: [{
        id: 'Q1',
        phase: 'Foundation',
        prompt: 'What should happen?',
        answer_type: 'free_text',
        answer: { free_text: 'Proceed.' },
      }],
    }
    const cases = [
      [{ ...base, questions: [{ ...base.questions[0], answer: undefined }] }, 'is missing answer'],
      [{ ...base, questions: [null] }, 'is not an object'],
      [{ ...base, ticket_id: undefined }, 'missing ticket_id'],
      [{ ...base, questions: [{ ...base.questions[0], answer_type: 'single_choice' }] }, 'requires options'],
      [{ ...base, follow_up_rounds: [null] }, 'is not an object'],
      [{ ...base, follow_up_rounds: [{ round_number: 1, source: 'unknown' }] }, 'unsupported source'],
    ] as const

    for (const [document, error] of cases) {
      const result = normalizeInterviewDocumentOutput(JSON.stringify(document))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain(error)
    }
  })

  it('maps comma-separated choice labels and requires timestamps for AI-filled answers', () => {
    const canonical = interviewDocument()
    const choice = canonical.questions[2]!
    const skippedChoice = {
      skipped: true,
      selected_option_ids: [],
      free_text: '',
      answered_by: 'ai_skip' as const,
      answered_at: '',
      skip_reason: null,
    }
    canonical.questions[2] = { ...choice, answer: skippedChoice }

    const candidate = {
      ...canonical,
      ticket_id: 'candidate-ticket',
      follow_up_rounds: [],
      questions: canonical.questions.map((question) => question.id === 'Q2'
        ? {
            ...question,
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: 'Resolved the blocker.',
              answered_by: 'ai_skip',
              answered_at: TEST.timestamp,
              skip_reason: null,
            },
          }
        : question.id === 'Q3'
          ? {
              ...question,
              answer: {
                skipped: false,
                selected_option_ids: [],
                free_text: 'Unit tests, Lint',
                answered_by: 'user',
                answered_at: TEST.timestamp,
                skip_reason: null,
              },
            }
          : question),
    }
    const result = normalizeResolvedInterviewDocumentOutput(JSON.stringify(candidate), {
      ticketId: TEST.externalId,
      canonicalInterviewContent: buildInterviewDocumentYaml(canonical),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questions[2]?.answer.selected_option_ids).toEqual(['unit', 'lint'])
    expect(result.repairWarnings).toContain('Mapped free_text to canonical option ids for AI-filled question Q3.')
    expect(result.repairWarnings).toContain('Canonicalized follow_up_rounds to match the approved Interview Results artifact.')
    expect(result.repairWarnings).toContain(`Canonicalized ticket_id from "candidate-ticket" to "${TEST.externalId}".`)

    const missingTimestamp = normalizeResolvedInterviewDocumentOutput(JSON.stringify({
      ...candidate,
      questions: candidate.questions.map((question) => question.id === 'Q3'
        ? { ...question, answer: { ...question.answer, answered_at: '' } }
        : question),
    }), {
      ticketId: TEST.externalId,
      canonicalInterviewContent: buildInterviewDocumentYaml(canonical),
    })
    expect(missingTimestamp.ok).toBe(false)
    if (!missingTimestamp.ok) expect(missingTimestamp.error).toContain('missing answered_at')
  })

  it('removes skip reasons textually when the surrounding YAML cannot be parsed', () => {
    const malformed = [
      'questions:',
      '  - id: Q1',
      '    answer:',
      '      skip_reason: |',
      '        private context',
      '        second line',
      '      answered_by: user_skip',
      'broken: [',
    ].join('\n')

    const stripped = stripSkipReasonsFromInterviewYaml(malformed)

    expect(stripped).not.toContain('private context')
    expect(stripped).not.toContain('second line')
    expect(stripped).toContain('answered_by: user_skip')
    expect(stripped).toContain('broken: [')
  })
})
