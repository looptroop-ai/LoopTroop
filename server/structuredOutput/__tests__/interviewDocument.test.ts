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
      status: 'approved',
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
})
