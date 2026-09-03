import { describe, expect, it, vi } from 'vitest'
import {
  buildPersistedBatch,
  collectBatchSelectionErrors,
  createInterviewSessionSnapshot,
  isBatchAnswerSkipped,
  normalizeBatchSelection,
  parseInterviewSessionSnapshot,
  recordBatchAnswers,
  recordPreparedBatch,
  extractCoverageFollowUpQuestionsWithMetadata,
  serializeInterviewSessionSnapshot,
} from '../sessionState'
import { normalizeCoverageResultOutput } from '../../../structuredOutput'
import type { InterviewSessionQuestion, InterviewSessionSnapshot } from '@shared/interviewSession'
import type { BatchQuestion } from '../qa'

function baseSnapshot(): InterviewSessionSnapshot {
  return createInterviewSessionSnapshot({
    winnerId: 'model-a',
    compiledQuestions: [{ id: 'Q01', phase: 'Foundation', question: 'What problem are we solving?' }],
    maxInitialQuestions: 5,
  })
}

function batchOf(questions: BatchQuestion[], batchNumber = 1) {
  return {
    questions,
    progress: { current: batchNumber, total: 4 },
    isComplete: false,
    isFinalFreeForm: false,
    aiCommentary: '',
    batchNumber,
  }
}

const choiceQuestion: Pick<InterviewSessionQuestion, 'id' | 'answerType' | 'options'> = {
  id: 'Q02',
  answerType: 'single_choice',
  options: [{ id: 'web', label: 'Web' }, { id: 'mobile', label: 'Mobile' }],
}

describe('question id reuse inside a session', () => {
  it('rejects a batch that repeats an id', () => {
    const snapshot = baseSnapshot()
    const batch = buildPersistedBatch(batchOf([
      { id: 'Q02', question: 'Which platforms?', phase: 'Scope' },
      { id: 'Q02', question: 'Which browsers?', phase: 'Scope' },
    ]), 'prom4', snapshot)

    expect(() => recordPreparedBatch(snapshot, batch)).toThrow('Interview batch repeats question id Q02.')
  })

  it('rejects a new question reusing an answered id', () => {
    const snapshot = baseSnapshot()
    const batch = buildPersistedBatch(batchOf([
      { id: 'Q01', question: 'Which platforms should we support?', phase: 'Foundation' },
    ]), 'prom4', snapshot)

    expect(() => recordPreparedBatch(snapshot, batch)).toThrow(/id collision for Q01/)
  })

  it('still lets a batch fill in metadata the compiled question lacks', () => {
    const snapshot = baseSnapshot()
    const batch = buildPersistedBatch(batchOf([
      {
        id: 'Q01',
        question: 'What problem are we solving?',
        phase: 'Foundation',
        priority: 'critical',
        rationale: 'Establish the core goal.',
      },
    ]), 'prom4', snapshot)

    const next = recordPreparedBatch(snapshot, batch)
    expect(next.questions).toHaveLength(1)
    expect(next.questions[0]).toMatchObject({ id: 'Q01', priority: 'critical', rationale: 'Establish the core goal.' })
  })

  it('rejects a batch that contradicts a stored answer type', () => {
    const snapshot = baseSnapshot()
    snapshot.questions[0] = { ...snapshot.questions[0]!, answerType: 'single_choice', options: [{ id: 'a', label: 'A' }] }
    const batch = buildPersistedBatch(batchOf([
      {
        id: 'Q01',
        question: 'What problem are we solving?',
        phase: 'Foundation',
        answerType: 'multiple_choice',
        options: [{ id: 'b', label: 'B' }],
      },
    ]), 'prom4', snapshot)

    expect(() => recordPreparedBatch(snapshot, batch)).toThrow(/id collision for Q01/)
  })
})

describe('selected option validation', () => {
  it('deduplicates a repeated selection', () => {
    expect(normalizeBatchSelection(
      { ...choiceQuestion, answerType: 'multiple_choice' },
      ['web', 'web', ' mobile '],
    )).toEqual({ selectedOptionIds: ['web', 'mobile'], error: null })
  })

  it('rejects an option the question does not have', () => {
    const result = normalizeBatchSelection(choiceQuestion, ['desktop'])
    expect(result.selectedOptionIds).toEqual([])
    expect(result.error).toContain('no option "desktop"')
  })

  it('rejects several selections on a single-choice question', () => {
    const result = normalizeBatchSelection(choiceQuestion, ['web', 'mobile'])
    expect(result.selectedOptionIds).toEqual([])
    expect(result.error).toContain('single choice')
  })

  it('allows several selections on a multiple-choice question', () => {
    expect(normalizeBatchSelection(
      { ...choiceQuestion, answerType: 'multiple_choice' },
      ['web', 'mobile'],
    )).toEqual({ selectedOptionIds: ['web', 'mobile'], error: null })
  })

  it('rejects selections on a free-text question', () => {
    const result = normalizeBatchSelection({ id: 'Q03' }, ['web'])
    expect(result.selectedOptionIds).toEqual([])
    expect(result.error).toContain('free text')
  })

  it('accepts an empty selection on a free-text question', () => {
    expect(normalizeBatchSelection({ id: 'Q03' }, [])).toEqual({ selectedOptionIds: [], error: null })
  })

  it('collects every error in a batch', () => {
    expect(collectBatchSelectionErrors(
      [choiceQuestion, { id: 'Q03' }],
      { Q02: ['nope'], Q03: ['web'] },
    )).toHaveLength(2)
  })

  it('does not count a rejected selection as an answer', () => {
    expect(isBatchAnswerSkipped(choiceQuestion, '', ['desktop'])).toBe(true)
    expect(isBatchAnswerSkipped(choiceQuestion, '', ['web'])).toBe(false)
  })

  it('persists only the normalized selection', () => {
    const snapshot = baseSnapshot()
    const prepared = recordPreparedBatch(snapshot, buildPersistedBatch(batchOf([
      { id: 'Q02', question: 'Which platform?', phase: 'Scope', answerType: 'single_choice', options: choiceQuestion.options },
    ]), 'prom4', snapshot))

    const answered = recordBatchAnswers(prepared, { Q02: '' }, { Q02: ['web', 'web'] })
    expect(answered.answers.Q02).toMatchObject({ skipped: false, selectedOptionIds: ['web'] })
  })
})

describe('parseInterviewSessionSnapshot', () => {
  it('restores a valid snapshot', () => {
    const snapshot = baseSnapshot()
    expect(parseInterviewSessionSnapshot(serializeInterviewSessionSnapshot(snapshot))).toEqual(snapshot)
  })

  it.each([
    ['a question with no id', (snapshot: InterviewSessionSnapshot) => { snapshot.questions[0] = { ...snapshot.questions[0]!, id: '' } }],
    ['a question with an unknown source', (snapshot: InterviewSessionSnapshot) => {
      snapshot.questions[0] = { ...snapshot.questions[0]!, source: 'invented' as never }
    }],
    ['an answer that is not an object', (snapshot: InterviewSessionSnapshot) => { snapshot.answers.Q01 = 'yes' as never }],
    ['an answer with a non-boolean skipped', (snapshot: InterviewSessionSnapshot) => {
      snapshot.answers.Q01 = { answer: '', skipped: 'no' as never, answeredAt: null, batchNumber: null }
    }],
    ['a batch history entry with an unknown source', (snapshot: InterviewSessionSnapshot) => {
      snapshot.batchHistory.push({ batchNumber: 1, source: 'nope' as never, questionIds: [], isFinalFreeForm: false, submittedAt: '' })
    }],
    ['a follow-up round with a non-integer round number', (snapshot: InterviewSessionSnapshot) => {
      snapshot.followUpRounds.push({ roundNumber: 1.5, source: 'coverage', questionIds: [] })
    }],
    ['an empty winner id', (snapshot: InterviewSessionSnapshot) => { snapshot.winnerId = '  ' }],
    ['a negative question budget', (snapshot: InterviewSessionSnapshot) => { snapshot.maxInitialQuestions = -1 }],
    ['a negative follow-up budget', (snapshot: InterviewSessionSnapshot) => { snapshot.maxFollowUps = -2 }],
    // Answers are written by question id, so the second of a duplicate pair
    // silently replaced the first once the restored batch was submitted.
    ['two questions sharing an id', (snapshot: InterviewSessionSnapshot) => {
      snapshot.questions.push({ ...snapshot.questions[0]! })
    }],
    ['a current batch repeating a question id', (snapshot: InterviewSessionSnapshot) => {
      snapshot.currentBatch = {
        questions: [snapshot.questions[0]!, { ...snapshot.questions[0]! }],
        progress: { current: 1, total: 2 },
        isComplete: false,
        isFinalFreeForm: false,
        aiCommentary: '',
        batchNumber: 1,
        source: 'prom4',
      }
    }],
    // The two lists were checked for internal duplicates and never against each
    // other, so answers normalised against one question were recorded against
    // another asking something else.
    ['a batch question reusing a canonical id for a different question', (snapshot: InterviewSessionSnapshot) => {
      snapshot.currentBatch = {
        questions: [{ ...snapshot.questions[0]!, question: 'Something else entirely?' }],
        progress: { current: 1, total: 1 },
        isComplete: false,
        isFinalFreeForm: false,
        aiCommentary: '',
        batchNumber: 1,
        source: 'prom4',
      }
    }],
    // A batch question absent from the canonical list can be answered, and then
    // appears in neither the canonical artifact nor the question views.
    ['a batch question that is in no canonical list', (snapshot: InterviewSessionSnapshot) => {
      snapshot.currentBatch = {
        questions: [{ ...snapshot.questions[0]!, id: 'GHOST' }],
        progress: { current: 1, total: 1 },
        isComplete: false,
        isFinalFreeForm: false,
        aiCommentary: '',
        batchNumber: 1,
        source: 'prom4',
      }
    }],
    ['batch progress claiming more done than exist', (snapshot: InterviewSessionSnapshot) => {
      snapshot.currentBatch = {
        questions: [snapshot.questions[0]!],
        progress: { current: 99, total: 1 },
        isComplete: false,
        isFinalFreeForm: false,
        aiCommentary: '',
        batchNumber: 1,
        source: 'prom4',
      }
    }],
    ['a history entry naming a question that does not exist', (snapshot: InterviewSessionSnapshot) => {
      snapshot.batchHistory.push({
        batchNumber: 1, source: 'prom4', questionIds: ['GHOST'], isFinalFreeForm: false, submittedAt: '',
      })
    }],
    ['a follow-up round naming the same question twice', (snapshot: InterviewSessionSnapshot) => {
      snapshot.followUpRounds.push({ roundNumber: 1, source: 'coverage', questionIds: ['Q01', 'Q01'] })
    }],
    ['a negative round number', (snapshot: InterviewSessionSnapshot) => {
      snapshot.followUpRounds.push({ roundNumber: -1, source: 'coverage', questionIds: [] })
    }],
    ['a current batch with malformed progress', (snapshot: InterviewSessionSnapshot) => {
      snapshot.currentBatch = {
        questions: [],
        progress: { current: 'one' as never, total: 2 },
        isComplete: false,
        isFinalFreeForm: false,
        aiCommentary: '',
        batchNumber: 1,
        source: 'prom4',
      }
    }],
  ])('refuses %s', (_label, corrupt) => {
    const snapshot = baseSnapshot()
    corrupt(snapshot)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(parseInterviewSessionSnapshot(JSON.stringify(snapshot))).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('drops an answer filed under a question that does not exist', () => {
    // `countAnsweredQuestions` counted it, so a restored session could report
    // more answers than it had questions and skip ahead.
    const snapshot = baseSnapshot()
    snapshot.answers.GHOST = { answer: 'orphan', skipped: false, answeredAt: null, batchNumber: null }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const restored = parseInterviewSessionSnapshot(JSON.stringify(snapshot))
      expect(restored).not.toBeNull()
      expect(Object.keys(restored!.answers)).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    ['deduplicates a repeated selection', ['opt-a', 'opt-a'], 'single_choice', ['opt-a']],
    ['clears two options on a single-choice question', ['opt-a', 'opt-b'], 'single_choice', []],
    ['clears an option the question does not offer', ['opt-z'], 'multiple_choice', []],
    ['clears a selection on a free-text question', ['opt-a'], 'free_text', []],
  ] as [string, string[], 'single_choice' | 'multiple_choice' | 'free_text', string[]][])(
    '%s after a restart',
    (_label, selectedOptionIds, answerType, expected) => {
      // The restore path only checked that this was an array of strings, so a
      // selection the batch route would have rejected reached the canonical
      // interview document unchanged.
      const snapshot = baseSnapshot()
      snapshot.questions[0] = {
        ...snapshot.questions[0]!,
        answerType,
        options: answerType === 'free_text' ? undefined : [{ id: 'opt-a', label: 'A' }, { id: 'opt-b', label: 'B' }],
      }
      snapshot.answers.Q01 = { answer: '', skipped: false, answeredAt: null, batchNumber: 1, selectedOptionIds }

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const restored = parseInterviewSessionSnapshot(JSON.stringify(snapshot))
        expect(restored?.answers.Q01?.selectedOptionIds).toEqual(expected)
      } finally {
        warn.mockRestore()
      }
    },
  )

  it('re-reads a blank answer as a skip even when it never had a selection', () => {
    // `recordBatchAnswers` derives `skipped` for every question it records, so a
    // persisted `{ answer: '', skipped: false }` was answered by its own account
    // and blank by every other, inflating the answered count.
    const snapshot = baseSnapshot()
    snapshot.answers.Q01 = { answer: '   ', skipped: false, answeredAt: '2026-09-01T00:00:00.000Z', batchNumber: 1 }

    const restored = parseInterviewSessionSnapshot(JSON.stringify(snapshot))
    expect(restored?.answers.Q01?.skipped).toBe(true)
    // The serializer reads `skippedAt` for a skip, so flipping the flag without
    // moving the timestamp would have lost it.
    expect(restored?.answers.Q01?.skippedAt).toBe('2026-09-01T00:00:00.000Z')
    expect(restored?.answers.Q01?.answeredAt).toBeNull()
  })

  it('leaves a real answer answered', () => {
    const snapshot = baseSnapshot()
    snapshot.answers.Q01 = { answer: 'A real answer.', skipped: false, answeredAt: '2026-09-01T00:00:00.000Z', batchNumber: 1 }

    const restored = parseInterviewSessionSnapshot(JSON.stringify(snapshot))
    expect(restored?.answers.Q01?.skipped).toBe(false)
    expect(restored?.answers.Q01?.answeredAt).toBe('2026-09-01T00:00:00.000Z')
  })

  it('keeps a valid selection intact', () => {
    const snapshot = baseSnapshot()
    snapshot.questions[0] = {
      ...snapshot.questions[0]!,
      answerType: 'multiple_choice',
      options: [{ id: 'opt-a', label: 'A' }, { id: 'opt-b', label: 'B' }],
    }
    snapshot.answers.Q01 = { answer: '', skipped: false, answeredAt: null, batchNumber: 1, selectedOptionIds: ['opt-a', 'opt-b'] }
    expect(parseInterviewSessionSnapshot(JSON.stringify(snapshot))?.answers.Q01?.selectedOptionIds)
      .toEqual(['opt-a', 'opt-b'])
  })

  it('returns null for content that is not JSON', () => {
    expect(parseInterviewSessionSnapshot('{ truncated')).toBeNull()
  })
})

describe('coverage follow-up questions read the same either way', () => {
  const coverageYaml = [
    'status: gaps',
    'gaps:',
    '  - Nothing covers rollout.',
    'follow_up_questions:',
    '  - id: FU1',
    '    question: Which platforms should ship first?',
    '    input_type: yes_no',
    '  - id: FU2',
    '    question: Which channels?',
    '    type: multiple_choice',
    '    choices:',
    '      - id: email',
    '        label: Email',
    '      - id: email',
    '        label: Email again',
    '      - id: sms',
    '        label: SMS',
  ].join('\n')

  it('expands yes_no, reads the choices alias and deduplicates options', () => {
    const snapshot = baseSnapshot()
    const extracted = extractCoverageFollowUpQuestionsWithMetadata(coverageYaml, snapshot)

    expect(extracted.questions).toHaveLength(2)
    expect(extracted.questions[0]).toMatchObject({
      question: 'Which platforms should ship first?',
      answerType: 'single_choice',
      options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    })
    expect(extracted.questions[1]).toMatchObject({
      answerType: 'multiple_choice',
      options: [{ id: 'email', label: 'Email' }, { id: 'sms', label: 'SMS' }],
    })
    expect(extracted.repairWarnings.join('\n')).toContain('removed duplicate option ids email')
  })

  it('agrees with the structured envelope parser on the same response', () => {
    const envelope = normalizeCoverageResultOutput(coverageYaml)
    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return

    const fromSession = extractCoverageFollowUpQuestionsWithMetadata(coverageYaml, baseSnapshot()).questions
    expect(fromSession.map((question) => question.answerType))
      .toEqual(envelope.value.followUpQuestions.map((question) => question.answerType))
    expect(fromSession.map((question) => question.options))
      .toEqual(envelope.value.followUpQuestions.map((question) => question.options))
  })

  it('keeps the session defaults the structured parser leaves unset', () => {
    const extracted = extractCoverageFollowUpQuestionsWithMetadata(coverageYaml, baseSnapshot())
    expect(extracted.questions[0]).toMatchObject({
      phase: 'Structure',
      priority: 'high',
      rationale: 'Coverage follow-up required to close interview gaps.',
    })
  })
})
