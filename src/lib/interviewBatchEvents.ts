import type {
  InterviewBatchSource,
  InterviewQuestionAnswerType,
  InterviewQuestionOption,
  InterviewQuestionSource,
  InterviewSessionQuestion,
  PersistedInterviewBatch,
} from '@shared/interviewSession'
import { isRecord } from '@shared/typeGuards'

export const INTERVIEW_BATCH_EVENT = 'looptroop:interview-batch'

export type InterviewBatchEventDetail =
  | { type: 'interview_batch'; ticketId: string; batch: PersistedInterviewBatch }
  | { type: 'interview_error'; ticketId: string; error: string }

const INTERVIEW_BATCH_SOURCES = new Set<InterviewBatchSource>(['prom4', 'coverage'])
const QUESTION_SOURCES = new Set<InterviewQuestionSource>([
  'compiled',
  'prompt_follow_up',
  'coverage_follow_up',
  'final_free_form',
])
const ANSWER_TYPES = new Set<InterviewQuestionAnswerType>([
  'free_text',
  'single_choice',
  'multiple_choice',
])

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value)
}

function isQuestionOption(value: unknown): value is InterviewQuestionOption {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
}

function isInterviewSessionQuestion(value: unknown): value is InterviewSessionQuestion {
  if (!isRecord(value)) return false
  if (
    typeof value.id !== 'string'
    || typeof value.question !== 'string'
    || typeof value.phase !== 'string'
    || typeof value.source !== 'string'
    || !QUESTION_SOURCES.has(value.source as InterviewQuestionSource)
    || !isOptionalNumber(value.roundNumber)
    || !isOptionalString(value.priority)
    || !isOptionalString(value.rationale)
  ) {
    return false
  }

  if (value.answerType !== undefined) {
    if (typeof value.answerType !== 'string' || !ANSWER_TYPES.has(value.answerType as InterviewQuestionAnswerType)) {
      return false
    }
  }

  if (value.options !== undefined) {
    if (!Array.isArray(value.options) || !value.options.every(isQuestionOption)) return false
  }

  return true
}

function isPersistedInterviewBatch(value: unknown): value is PersistedInterviewBatch {
  if (!isRecord(value)) return false
  const progress = value.progress
  return Array.isArray(value.questions)
    && value.questions.every(isInterviewSessionQuestion)
    && isRecord(progress)
    && isFiniteNumber(progress.current)
    && isFiniteNumber(progress.total)
    && typeof value.isComplete === 'boolean'
    && typeof value.isFinalFreeForm === 'boolean'
    && typeof value.aiCommentary === 'string'
    && isFiniteNumber(value.batchNumber)
    && typeof value.source === 'string'
    && INTERVIEW_BATCH_SOURCES.has(value.source as InterviewBatchSource)
    && isOptionalNumber(value.roundNumber)
    && isOptionalString(value.finalYaml)
}

export function parseInterviewBatchEventDetail(value: unknown): InterviewBatchEventDetail | null {
  if (!isRecord(value)) return null
  if (typeof value.ticketId !== 'string' || value.ticketId.length === 0) return null

  if (value.type === 'interview_batch' && isPersistedInterviewBatch(value.batch)) {
    return {
      type: 'interview_batch',
      ticketId: value.ticketId,
      batch: value.batch,
    }
  }

  if (value.type === 'interview_error' && typeof value.error === 'string') {
    return {
      type: 'interview_error',
      ticketId: value.ticketId,
      error: value.error,
    }
  }

  return null
}

export function dispatchInterviewBatchEvent(detail: InterviewBatchEventDetail) {
  window.dispatchEvent(new CustomEvent<InterviewBatchEventDetail>(INTERVIEW_BATCH_EVENT, { detail }))
}
