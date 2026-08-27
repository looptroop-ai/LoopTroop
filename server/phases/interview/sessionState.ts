// Core session state logic with barrel re-exports from extracted modules.
//
// Batch lifecycle (build, record, submit, clear) → ./batchManagement
// Serialization, YAML canonicalization, coverage extraction, question views → ./sessionSerializer

export {
  buildPersistedBatch,
  recordPreparedBatch,
  recordBatchAnswers,
  isBatchAnswerSkipped,
  clearInterviewSessionBatch,
  buildCoverageFollowUpBatch,
} from './batchManagement'

export {
  createInterviewSessionSnapshot,
  parseInterviewSessionSnapshot,
  serializeInterviewSessionSnapshot,
  buildCanonicalInterviewYaml,
  extractCoverageFollowUpQuestionsWithMetadata,
  extractCoverageFollowUpQuestions,
  buildInterviewQuestionViews,
} from './sessionSerializer'

import type {
  InterviewSessionSnapshot,
} from '@shared/interviewSession'
import { normalizeSkipReason } from '@shared/skipReceipt'
import { isBatchAnswerSkipped, recordBatchAnswers } from './batchManagement'
import { cloneSnapshot, nowIso } from './interviewUtils'

export const INTERVIEW_SESSION_ARTIFACT = 'interview_session'
export const INTERVIEW_PROM4_FINAL_ARTIFACT = 'interview_prom4_final'
export const INTERVIEW_QA_SESSION_ARTIFACT = 'interview_qa_session'
export const INTERVIEW_CURRENT_BATCH_ARTIFACT = 'interview_current_batch'
export const INTERVIEW_BATCH_HISTORY_ARTIFACT = 'interview_batch_history'
export const INTERVIEW_COVERAGE_FOLLOWUPS_ARTIFACT = 'interview_coverage_followups'

export interface SkipRemainingOptions {
  selectedOptions?: Record<string, string[]>
  /** Per-question reasons for the batch on screen. These always win. */
  skipReasons?: Record<string, string>
  /**
   * One reason for the whole action, used only where no per-question reason was
   * given. It must never overwrite a reason the person typed against a specific
   * question, and it must never reach a question answered in an earlier batch.
   */
  bulkReason?: string | null
}

export function completeInterviewBySkippingRemaining(
  snapshot: InterviewSessionSnapshot,
  batchAnswers: Record<string, string>,
  options: SkipRemainingOptions = {},
): InterviewSessionSnapshot {
  const currentBatchNumber = snapshot.currentBatch?.batchNumber ?? null
  const answeredSnapshot = snapshot.currentBatch
    ? recordBatchAnswers(snapshot, batchAnswers, options.selectedOptions ?? {}, options.skipReasons ?? {})
    : cloneSnapshot(snapshot)

  const bulkReason = options.bulkReason?.trim() ?? ''
  const skippedAt = nowIso()

  for (const question of answeredSnapshot.questions) {
    const existing = answeredSnapshot.answers[question.id]
    if (existing) {
      // Prior batches are already committed and are not part of this action.
      // Only a question this action itself skipped, and left without a reason of
      // its own, falls back to the bulk reason.
      if (
        bulkReason
        && existing.skipped
        && !existing.skipReason
        && existing.batchNumber === currentBatchNumber
      ) {
        existing.skipReason = bulkReason
      }
      continue
    }
    answeredSnapshot.answers[question.id] = {
      answer: '',
      skipped: true,
      answeredAt: null,
      skippedAt,
      batchNumber: currentBatchNumber,
      ...(bulkReason ? { skipReason: bulkReason } : {}),
    }
  }

  return markInterviewSessionComplete(answeredSnapshot)
}

/**
 * The question ids this action would leave skipped.
 *
 * The route needs this before anything is committed, so it can reject a reason
 * attached to a question the person actually answered.
 */
export function resolveSkippedQuestionIdsForSkipAll(
  snapshot: InterviewSessionSnapshot,
  batchAnswers: Record<string, string>,
  selectedOptions: Record<string, string[]> = {},
): Set<string> {
  const batchQuestionIds = new Set(snapshot.currentBatch?.questions.map((question) => question.id) ?? [])
  const skipped = new Set<string>()

  for (const question of snapshot.currentBatch?.questions ?? []) {
    if (isBatchAnswerSkipped(question, batchAnswers[question.id] ?? '', selectedOptions[question.id] ?? [])) {
      skipped.add(question.id)
    }
  }
  for (const question of snapshot.questions) {
    if (batchQuestionIds.has(question.id)) continue
    const existing = snapshot.answers[question.id]
    if (!existing) skipped.add(question.id)
  }

  return skipped
}

export function markInterviewSessionComplete(
  snapshot: InterviewSessionSnapshot,
  rawFinalYaml?: string,
): InterviewSessionSnapshot {
  const next = cloneSnapshot(snapshot)
  next.currentBatch = null
  next.completedAt = nowIso()
  next.updatedAt = next.completedAt
  if (rawFinalYaml?.trim()) {
    next.rawFinalYaml = rawFinalYaml.trim()
  }
  return next
}

export function updateInterviewAnswer(
  snapshot: InterviewSessionSnapshot,
  questionId: string,
  newAnswer: string,
  skipReason?: string | null,
): InterviewSessionSnapshot {
  const next = cloneSnapshot(snapshot)
  const existing = next.answers[questionId]
  if (!existing) {
    throw new Error(`No existing answer for question ${questionId}`)
  }

  const trimmed = newAnswer.trim()
  const skipped = trimmed.length === 0
  const now = nowIso()
  // Clearing an answer is a skip, and it takes a reason like any other. An
  // explicit reason replaces what was there; omitting one keeps the reason the
  // question already carried, because the skip it explained has not changed.
  // Answering the question drops the reason entirely.
  const nextSkipReason = skipped
    ? (skipReason === undefined ? existing.skipReason ?? null : normalizeSkipReason(skipReason))
    : null

  next.answers[questionId] = {
    answer: newAnswer,
    skipped,
    answeredAt: skipped ? null : now,
    skippedAt: skipped ? now : null,
    batchNumber: existing.batchNumber,
    ...(nextSkipReason ? { skipReason: nextSkipReason } : {}),
  }
  next.updatedAt = now
  return next
}

export function countCoverageFollowUpQuestions(snapshot: InterviewSessionSnapshot): number {
  return snapshot.followUpRounds
    .filter((round) => round.source === 'coverage')
    .reduce((sum, round) => sum + round.questionIds.length, 0)
}
