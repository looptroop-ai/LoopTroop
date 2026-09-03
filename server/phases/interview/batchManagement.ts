import type { BatchResponse } from './qa'
import type {
  InterviewBatchSource,
  InterviewQuestionSource,
  InterviewSessionQuestion,
  InterviewSessionSnapshot,
  PersistedInterviewBatch,
} from '@shared/interviewSession'
import { nowIso, normalizeQuestion, cloneSnapshot } from './interviewUtils'

function determinePromptQuestionSource(
  snapshot: InterviewSessionSnapshot,
  questionId: string,
  isFinalFreeForm: boolean,
): { source: InterviewQuestionSource; roundNumber?: number } {
  if (isFinalFreeForm) {
    return { source: 'final_free_form' }
  }

  const existing = snapshot.questions.find((question) => question.id === questionId)
  if (existing) {
    return {
      source: existing.source,
      ...(existing.roundNumber !== undefined ? { roundNumber: existing.roundNumber } : {}),
    }
  }

  const nextRoundNumber = snapshot.followUpRounds
    .filter((round) => round.source === 'prom4')
    .reduce((max, round) => Math.max(max, round.roundNumber), 0) + 1

  return { source: 'prompt_follow_up', roundNumber: nextRoundNumber }
}

function sameQuestionOptions(
  left: NonNullable<InterviewSessionQuestion['options']>,
  right: NonNullable<InterviewSessionQuestion['options']>,
): boolean {
  return left.length === right.length
    && left.every((option, index) => option.id === right[index]?.id && option.label === right[index]?.label)
}

/**
 * Whether a repeated id names the same question.
 *
 * Matching source and round used to be enough, so a new prompt reusing an
 * earlier id silently replaced that question while its answer stayed behind
 * under the same key — a new question wearing an old answer.
 *
 * A batch may still fill in a field the stored question does not have: a
 * compiled question carries only its id, phase and text, and the batch that
 * presents it adds the priority, rationale and answer type. What it may not do
 * is contradict a field that is already set, because that is what makes the
 * stored answer mean something else.
 */
export function isSameSessionQuestion(
  existing: InterviewSessionQuestion,
  incoming: InterviewSessionQuestion,
): boolean {
  const compatible = <T>(before: T | undefined, after: T | undefined, equals: (a: T, b: T) => boolean) =>
    before === undefined || after === undefined || equals(before, after)

  return existing.source === incoming.source
    && (existing.roundNumber ?? null) === (incoming.roundNumber ?? null)
    && existing.question === incoming.question
    && existing.phase === incoming.phase
    && compatible(existing.priority, incoming.priority, (a, b) => a === b)
    && compatible(existing.rationale, incoming.rationale, (a, b) => a === b)
    && compatible(existing.answerType, incoming.answerType, (a, b) => a === b)
    && compatible(existing.options, incoming.options, sameQuestionOptions)
}

function describeQuestionRound(question: InterviewSessionQuestion): string {
  return question.roundNumber === undefined ? '' : ` (round ${question.roundNumber})`
}

function upsertQuestion(
  snapshot: InterviewSessionSnapshot,
  question: InterviewSessionQuestion,
) {
  const existingIndex = snapshot.questions.findIndex((entry) => entry.id === question.id)
  if (existingIndex >= 0) {
    const existing = snapshot.questions[existingIndex]!
    if (!isSameSessionQuestion(existing, question)) {
      throw new Error(
        `Interview session question id collision for ${question.id}: cannot replace existing ${existing.source} question`
        + `${describeQuestionRound(existing)}`
        + ` with a different ${question.source} question`
        + `${describeQuestionRound(question)}.`,
      )
    }
    snapshot.questions[existingIndex] = {
      ...existing,
      ...question,
    }
    return
  }
  snapshot.questions.push(question)
}

function upsertFollowUpRound(
  snapshot: InterviewSessionSnapshot,
  source: InterviewBatchSource,
  roundNumber: number | undefined,
  questionIds: string[],
) {
  if (roundNumber === undefined || questionIds.length === 0) return
  const existing = snapshot.followUpRounds.find((round) => round.source === source && round.roundNumber === roundNumber)
  if (existing) {
    const nextIds = new Set([...existing.questionIds, ...questionIds])
    existing.questionIds = Array.from(nextIds)
    return
  }
  snapshot.followUpRounds.push({
    roundNumber,
    source,
    questionIds: [...questionIds],
  })
}

function countAnsweredQuestions(snapshot: InterviewSessionSnapshot): number {
  return Object.values(snapshot.answers).filter((answer) => !answer.skipped).length
}

export function buildPersistedBatch(
  batch: BatchResponse,
  source: InterviewBatchSource,
  snapshot: InterviewSessionSnapshot,
  explicitRoundNumber?: number,
): PersistedInterviewBatch {
  const batchQuestions = batch.questions.map((question) => {
    const promptSource = source === 'coverage'
      ? { source: 'coverage_follow_up' as const, roundNumber: explicitRoundNumber }
      : determinePromptQuestionSource(snapshot, question.id, batch.isFinalFreeForm)

    return normalizeQuestion(question, promptSource.source, promptSource.roundNumber)
  })

  return {
    questions: batchQuestions,
    progress: {
      current: batch.batchNumber,
      total: Math.max(batch.progress.total, batch.batchNumber),
    },
    isComplete: batch.isComplete,
    isFinalFreeForm: batch.isFinalFreeForm,
    aiCommentary: batch.aiCommentary,
    ...(batch.finalYaml ? { finalYaml: batch.finalYaml } : {}),
    batchNumber: batch.batchNumber,
    source,
    ...(explicitRoundNumber !== undefined ? { roundNumber: explicitRoundNumber } : {}),
  }
}

export function recordPreparedBatch(
  snapshot: InterviewSessionSnapshot,
  batch: PersistedInterviewBatch,
): InterviewSessionSnapshot {
  const next = cloneSnapshot(snapshot)

  const followUpIds: string[] = []
  const batchIds = new Set<string>()
  for (const question of batch.questions) {
    if (batchIds.has(question.id)) {
      throw new Error(`Interview batch repeats question id ${question.id}.`)
    }
    batchIds.add(question.id)
    upsertQuestion(next, question)
    if (question.source === 'prompt_follow_up' || question.source === 'coverage_follow_up') {
      followUpIds.push(question.id)
    }
  }

  if (batch.source === 'prom4') {
    const promptRoundNumber = batch.questions
      .filter((question) => question.source === 'prompt_follow_up')
      .reduce((max, question) => Math.max(max, question.roundNumber ?? 0), 0)
    if (promptRoundNumber > 0) {
      upsertFollowUpRound(
        next,
        'prom4',
        promptRoundNumber,
        batch.questions
          .filter((question) => question.source === 'prompt_follow_up' && question.roundNumber === promptRoundNumber)
          .map((question) => question.id),
      )
    }
  }

  if (batch.source === 'coverage') {
    upsertFollowUpRound(next, 'coverage', batch.roundNumber, followUpIds)
  }

  next.currentBatch = {
    ...batch,
    questions: batch.questions.map((question) => ({ ...question })),
  }
  next.updatedAt = nowIso()
  return next
}

export interface NormalizedBatchSelection {
  selectedOptionIds: string[]
  error: string | null
}

/**
 * Checks a submitted selection against the question it answers.
 *
 * The route schema accepts any array of strings, and the selection used to be
 * stored exactly as sent: a single-choice question could keep several ids, a
 * free-text question could keep selections at all, and an id naming no option
 * reached the model later as a fallback label. Skip detection and persistence
 * both read the result of this, so they cannot disagree.
 */
export function normalizeBatchSelection(
  question: Pick<InterviewSessionQuestion, 'id' | 'answerType' | 'options'>,
  selectedIds: string[],
): NormalizedBatchSelection {
  const deduped = [...new Set(selectedIds.map((id) => id.trim()).filter((id) => id.length > 0))]
  const answerType = question.answerType ?? 'free_text'

  if (answerType === 'free_text') {
    return deduped.length > 0
      ? { selectedOptionIds: [], error: `Question ${question.id} is free text and cannot carry selected options.` }
      : { selectedOptionIds: [], error: null }
  }

  const knownIds = new Set((question.options ?? []).map((option) => option.id))
  const unknown = deduped.filter((id) => !knownIds.has(id))
  if (unknown.length > 0) {
    return {
      selectedOptionIds: [],
      error: `Question ${question.id} has no option ${unknown.map((id) => `"${id}"`).join(', ')}.`,
    }
  }

  if (answerType === 'single_choice' && deduped.length > 1) {
    return {
      selectedOptionIds: [],
      error: `Question ${question.id} is single choice and accepts one option, received ${deduped.length}.`,
    }
  }

  return { selectedOptionIds: deduped, error: null }
}

/** Every selection error in a submitted batch, in question order. */
export function collectBatchSelectionErrors(
  questions: Array<Pick<InterviewSessionQuestion, 'id' | 'answerType' | 'options'>>,
  selectedOptions: Record<string, string[]>,
): string[] {
  return questions
    .map((question) => normalizeBatchSelection(question, selectedOptions[question.id] ?? []).error)
    .filter((error): error is string => error !== null)
}

/**
 * Whether a submitted batch answer counts as a skip.
 *
 * Exported because the route has to answer the same question before the batch is
 * committed, to reject a reason attached to something the person actually
 * answered. Two copies of this rule would disagree the first time either moved.
 */
export function isBatchAnswerSkipped(
  question: Pick<InterviewSessionQuestion, 'id' | 'answerType' | 'options'>,
  rawAnswer: string,
  selectedIds: string[],
): boolean {
  const isChoiceQuestion = question.answerType === 'single_choice' || question.answerType === 'multiple_choice'
  const hasSelection = normalizeBatchSelection(question, selectedIds).selectedOptionIds.length > 0
  const hasText = rawAnswer.trim().length > 0
  return isChoiceQuestion ? (!hasSelection && !hasText) : !hasText
}

export function recordBatchAnswers(
  snapshot: InterviewSessionSnapshot,
  batchAnswers: Record<string, string>,
  selectedOptions: Record<string, string[]> = {},
  skipReasons: Record<string, string> = {},
): InterviewSessionSnapshot {
  const next = cloneSnapshot(snapshot)
  const currentBatch = next.currentBatch
  if (!currentBatch) return next

  const submittedAt = nowIso()
  for (const question of currentBatch.questions) {
    const rawAnswer = batchAnswers[question.id] ?? ''
    // The same normalised selection decides the skip and what is persisted, so a
    // rejected selection cannot count as an answer and then vanish on write.
    const { selectedOptionIds } = normalizeBatchSelection(question, selectedOptions[question.id] ?? [])
    const skipped = isBatchAnswerSkipped(question, rawAnswer, selectedOptionIds)
    const skipReason = skipped ? (skipReasons[question.id] ?? '').trim() : ''
    next.answers[question.id] = {
      answer: rawAnswer,
      skipped,
      answeredAt: skipped ? null : submittedAt,
      // A skip is a decision with a time. Recording it separately is what stops
      // "skipped at" and "answered at" collapsing into the same empty string.
      skippedAt: skipped ? submittedAt : null,
      batchNumber: currentBatch.batchNumber,
      ...(selectedOptionIds.length > 0 ? { selectedOptionIds } : {}),
      ...(skipReason ? { skipReason } : {}),
    }
  }

  next.batchHistory.push({
    batchNumber: currentBatch.batchNumber,
    source: currentBatch.source,
    ...(currentBatch.roundNumber !== undefined ? { roundNumber: currentBatch.roundNumber } : {}),
    questionIds: currentBatch.questions.map((question) => question.id),
    isFinalFreeForm: currentBatch.isFinalFreeForm,
    submittedAt,
  })
  next.currentBatch = null
  next.updatedAt = submittedAt
  return next
}

export function clearInterviewSessionBatch(snapshot: InterviewSessionSnapshot): InterviewSessionSnapshot {
  const next = cloneSnapshot(snapshot)
  next.currentBatch = null
  next.updatedAt = nowIso()
  return next
}

export function buildCoverageFollowUpBatch(
  snapshot: InterviewSessionSnapshot,
  questions: InterviewSessionQuestion[],
  aiCommentary: string,
): PersistedInterviewBatch {
  const answeredCount = countAnsweredQuestions(snapshot)
  const roundNumber = questions.reduce((max, question) => Math.max(max, question.roundNumber ?? 0), 0)

  return {
    questions: questions.map((question) => ({ ...question })),
    progress: {
      current: answeredCount,
      total: answeredCount + questions.length,
    },
    isComplete: false,
    isFinalFreeForm: false,
    aiCommentary,
    batchNumber: snapshot.batchHistory.length + 1,
    source: 'coverage',
    ...(roundNumber > 0 ? { roundNumber } : {}),
  }
}
