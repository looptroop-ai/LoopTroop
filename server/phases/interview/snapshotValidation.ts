import { isRecord } from '@shared/typeGuards'
import type {
  InterviewBatchHistoryEntry,
  InterviewBatchSource,
  InterviewFollowUpRound,
  InterviewQuestionAnswerType,
  InterviewQuestionOption,
  InterviewQuestionSource,
  InterviewSessionAnswer,
  InterviewSessionQuestion,
  InterviewSessionSnapshot,
  PersistedInterviewBatch,
} from '@shared/interviewSession'

/**
 * Validates a persisted interview session before it is restored.
 *
 * `parseInterviewSessionSnapshot` used to check the schema version, the winner
 * id, that `questions` was an array and `answers` an object, and then assert the
 * whole value. `cloneSnapshot` then spread every question, answer, batch-history
 * and follow-up entry without looking inside them, so a malformed artifact came
 * back as a typed snapshot whose contents were whatever had been written.
 *
 * A malformed artifact returns null with a diagnostic rather than a snapshot the
 * rest of the interview will trust.
 */
export interface InterviewSnapshotValidationResult {
  snapshot: InterviewSessionSnapshot | null
  error: string | null
}

const QUESTION_SOURCES: readonly InterviewQuestionSource[] = [
  'compiled',
  'prompt_follow_up',
  'coverage_follow_up',
  'final_free_form',
]

const BATCH_SOURCES: readonly InterviewBatchSource[] = ['prom4', 'coverage']

const ANSWER_TYPES: readonly InterviewQuestionAnswerType[] = ['free_text', 'single_choice', 'multiple_choice']

class SnapshotFieldError extends Error {}

function fail(path: string, expected: string): never {
  throw new SnapshotFieldError(`${path} must be ${expected}`)
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'a string')
  return value
}

function requireNonEmptyString(value: unknown, path: string): string {
  const text = requireString(value, path)
  if (!text.trim()) fail(path, 'a non-empty string')
  return text
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'a boolean')
  return value
}

function requireInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(path, 'an integer')
  return value
}

function requireNullableString(value: unknown, path: string): string | null {
  if (value === null) return null
  return requireString(value, path)
}

function requireNullableInteger(value: unknown, path: string): number | null {
  if (value === null) return null
  return requireInteger(value, path)
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'an array')
  return value
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'an object')
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, path)
}

function requireStringArray(value: unknown, path: string): string[] {
  return requireArray(value, path).map((entry, index) => requireString(entry, `${path}[${index}]`))
}

function requireMember<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const text = requireString(value, path)
  if (!(allowed as readonly string[]).includes(text)) fail(path, `one of ${allowed.join(', ')}`)
  return text as T
}

function requireOptions(value: unknown, path: string): InterviewQuestionOption[] {
  return requireArray(value, path).map((entry, index) => {
    const option = requireRecord(entry, `${path}[${index}]`)
    return {
      id: requireNonEmptyString(option.id, `${path}[${index}].id`),
      label: requireString(option.label, `${path}[${index}].label`),
    }
  })
}

function requireQuestion(value: unknown, path: string): InterviewSessionQuestion {
  const record = requireRecord(value, path)
  const priority = optionalString(record.priority, `${path}.priority`)
  const rationale = optionalString(record.rationale, `${path}.rationale`)
  const roundNumber = record.roundNumber === undefined
    ? undefined
    : requireInteger(record.roundNumber, `${path}.roundNumber`)
  const answerType = record.answerType === undefined
    ? undefined
    : requireMember(record.answerType, ANSWER_TYPES, `${path}.answerType`)
  const options = record.options === undefined ? undefined : requireOptions(record.options, `${path}.options`)

  return {
    id: requireNonEmptyString(record.id, `${path}.id`),
    question: requireString(record.question, `${path}.question`),
    phase: requireString(record.phase, `${path}.phase`),
    source: requireMember(record.source, QUESTION_SOURCES, `${path}.source`),
    ...(priority !== undefined ? { priority } : {}),
    ...(rationale !== undefined ? { rationale } : {}),
    ...(roundNumber !== undefined ? { roundNumber } : {}),
    ...(answerType !== undefined ? { answerType } : {}),
    ...(options !== undefined ? { options } : {}),
  }
}

function requireAnswer(value: unknown, path: string): InterviewSessionAnswer {
  const record = requireRecord(value, path)
  const selectedOptionIds = record.selectedOptionIds === undefined
    ? undefined
    : requireStringArray(record.selectedOptionIds, `${path}.selectedOptionIds`)
  const skipReason = record.skipReason === undefined
    ? undefined
    : requireNullableString(record.skipReason, `${path}.skipReason`)
  const skippedAt = record.skippedAt === undefined
    ? undefined
    : requireNullableString(record.skippedAt, `${path}.skippedAt`)

  return {
    answer: requireString(record.answer, `${path}.answer`),
    skipped: requireBoolean(record.skipped, `${path}.skipped`),
    answeredAt: requireNullableString(record.answeredAt, `${path}.answeredAt`),
    batchNumber: requireNullableInteger(record.batchNumber, `${path}.batchNumber`),
    ...(selectedOptionIds !== undefined ? { selectedOptionIds } : {}),
    ...(skipReason !== undefined ? { skipReason } : {}),
    ...(skippedAt !== undefined ? { skippedAt } : {}),
  }
}

function requireBatch(value: unknown, path: string): PersistedInterviewBatch {
  const record = requireRecord(value, path)
  const progress = requireRecord(record.progress, `${path}.progress`)
  const finalYaml = optionalString(record.finalYaml, `${path}.finalYaml`)
  const roundNumber = record.roundNumber === undefined
    ? undefined
    : requireInteger(record.roundNumber, `${path}.roundNumber`)

  return {
    questions: requireArray(record.questions, `${path}.questions`)
      .map((question, index) => requireQuestion(question, `${path}.questions[${index}]`)),
    progress: {
      current: requireInteger(progress.current, `${path}.progress.current`),
      total: requireInteger(progress.total, `${path}.progress.total`),
    },
    isComplete: requireBoolean(record.isComplete, `${path}.isComplete`),
    isFinalFreeForm: requireBoolean(record.isFinalFreeForm, `${path}.isFinalFreeForm`),
    aiCommentary: requireString(record.aiCommentary, `${path}.aiCommentary`),
    batchNumber: requireInteger(record.batchNumber, `${path}.batchNumber`),
    source: requireMember(record.source, BATCH_SOURCES, `${path}.source`),
    ...(finalYaml !== undefined ? { finalYaml } : {}),
    ...(roundNumber !== undefined ? { roundNumber } : {}),
  }
}

function requireBatchHistoryEntry(value: unknown, path: string): InterviewBatchHistoryEntry {
  const record = requireRecord(value, path)
  const roundNumber = record.roundNumber === undefined
    ? undefined
    : requireInteger(record.roundNumber, `${path}.roundNumber`)

  return {
    batchNumber: requireInteger(record.batchNumber, `${path}.batchNumber`),
    source: requireMember(record.source, BATCH_SOURCES, `${path}.source`),
    questionIds: requireStringArray(record.questionIds, `${path}.questionIds`),
    isFinalFreeForm: requireBoolean(record.isFinalFreeForm, `${path}.isFinalFreeForm`),
    submittedAt: requireString(record.submittedAt, `${path}.submittedAt`),
    ...(roundNumber !== undefined ? { roundNumber } : {}),
  }
}

function requireFollowUpRound(value: unknown, path: string): InterviewFollowUpRound {
  const record = requireRecord(value, path)
  return {
    roundNumber: requireInteger(record.roundNumber, `${path}.roundNumber`),
    source: requireMember(record.source, BATCH_SOURCES, `${path}.source`),
    questionIds: requireStringArray(record.questionIds, `${path}.questionIds`),
  }
}

export function validateInterviewSessionSnapshot(value: unknown): InterviewSnapshotValidationResult {
  try {
    const record = requireRecord(value, 'snapshot')
    if (record.schemaVersion !== 1) fail('snapshot.schemaVersion', '1')

    const answersRecord = requireRecord(record.answers, 'snapshot.answers')

    return {
      snapshot: {
        schemaVersion: 1,
        winnerId: requireString(record.winnerId, 'snapshot.winnerId'),
        maxInitialQuestions: requireInteger(record.maxInitialQuestions, 'snapshot.maxInitialQuestions'),
        maxFollowUps: requireInteger(record.maxFollowUps, 'snapshot.maxFollowUps'),
        questions: requireArray(record.questions, 'snapshot.questions')
          .map((question, index) => requireQuestion(question, `snapshot.questions[${index}]`)),
        answers: Object.fromEntries(
          Object.entries(answersRecord)
            .map(([id, answer]) => [id, requireAnswer(answer, `snapshot.answers.${id}`)]),
        ),
        currentBatch: record.currentBatch === null || record.currentBatch === undefined
          ? null
          : requireBatch(record.currentBatch, 'snapshot.currentBatch'),
        batchHistory: requireArray(record.batchHistory, 'snapshot.batchHistory')
          .map((entry, index) => requireBatchHistoryEntry(entry, `snapshot.batchHistory[${index}]`)),
        followUpRounds: requireArray(record.followUpRounds, 'snapshot.followUpRounds')
          .map((round, index) => requireFollowUpRound(round, `snapshot.followUpRounds[${index}]`)),
        rawFinalYaml: requireNullableString(record.rawFinalYaml ?? null, 'snapshot.rawFinalYaml'),
        completedAt: requireNullableString(record.completedAt ?? null, 'snapshot.completedAt'),
        updatedAt: requireString(record.updatedAt, 'snapshot.updatedAt'),
      },
      error: null,
    }
  } catch (error) {
    if (error instanceof SnapshotFieldError) {
      return { snapshot: null, error: error.message }
    }
    throw error
  }
}
