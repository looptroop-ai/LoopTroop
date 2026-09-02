import type { ParsedInterviewQuestion } from './questions'
import { parseInterviewQuestions } from './questions'
import type { BatchQuestion } from './qa'
import type {
  InterviewQuestionView,
  InterviewSessionQuestion,
  InterviewSessionSnapshot,
} from '@shared/interviewSession'
import type { InterviewDocument, InterviewDocumentAnswer, InterviewDocumentQuestion } from '@shared/interviewArtifact'
import { normalizeSkipReason } from '@shared/skipReceipt'
import { calculateFollowUpLimit } from './followUpBudget'
import { buildInterviewDocumentYaml, normalizeCoverageFollowUpQuestions } from '../../structuredOutput'
import { getValueByAliases, isRecord, parseYamlOrJsonCandidate } from '../../structuredOutput/yamlUtils'
import { nowIso, normalizeQuestion, cloneSnapshot } from './interviewUtils'
import { validateInterviewSessionSnapshot } from './snapshotValidation'

const INTERVIEW_SESSION_NESTED_MAPPING_CHILDREN = {
  generated_by: ['winner_model', 'generated_at', 'canonicalization'],
  summary: ['goals', 'constraints', 'non_goals', 'final_free_form_answer'],
  approval: ['approved_by', 'approved_at'],
} as const

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export function createInterviewSessionSnapshot(input: {
  winnerId: string
  compiledQuestions: ParsedInterviewQuestion[]
  maxInitialQuestions: number
  followUpBudgetPercent?: number
}): InterviewSessionSnapshot {
  const updatedAt = nowIso()

  return {
    schemaVersion: 1,
    winnerId: input.winnerId,
    maxInitialQuestions: input.maxInitialQuestions,
    maxFollowUps: calculateFollowUpLimit(input.maxInitialQuestions, input.followUpBudgetPercent),
    questions: input.compiledQuestions.map((question) => normalizeQuestion(question, 'compiled')),
    answers: {},
    currentBatch: null,
    batchHistory: [],
    followUpRounds: [],
    rawFinalYaml: null,
    completedAt: null,
    updatedAt,
  }
}

export function parseInterviewSessionSnapshot(content: string | null | undefined): InterviewSessionSnapshot | null {
  if (!content?.trim()) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }

  // The old check read four top-level fields and asserted the rest, so a
  // malformed artifact came back as a typed snapshot holding whatever had been
  // written into it.
  const validated = validateInterviewSessionSnapshot(parsed)
  if (!validated.snapshot) {
    console.warn(`[interview] Ignored a malformed interview session snapshot: ${validated.error}`)
    return null
  }
  return cloneSnapshot(validated.snapshot)
}

export function serializeInterviewSessionSnapshot(snapshot: InterviewSessionSnapshot): string {
  return JSON.stringify(snapshot)
}

function emptyAnswer(): InterviewDocumentAnswer {
  return {
    skipped: true,
    selected_option_ids: [],
    free_text: '',
    answered_by: 'ai_skip',
    answered_at: '',
    skip_reason: null,
  }
}

function extractRawFinalInterviewSummary(rawFinalYaml: string | null | undefined): {
  goals: string[]
  constraints: string[]
  nonGoals: string[]
  finalFreeFormAnswer: string | null
} | null {
  if (!rawFinalYaml?.trim()) return null

  try {
    const parsed = parseYamlOrJsonCandidate(rawFinalYaml, {
      nestedMappingChildren: INTERVIEW_SESSION_NESTED_MAPPING_CHILDREN,
    })
    if (!isRecord(parsed)) return null

    const summary = parsed.summary
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null

    const record = summary as Record<string, unknown>
    const finalFreeFormAnswer = typeof record.final_free_form_answer === 'string' && record.final_free_form_answer.trim()
      ? record.final_free_form_answer.trim()
      : null

    return {
      goals: toStringArray(record.goals),
      constraints: toStringArray(record.constraints),
      nonGoals: toStringArray(record.non_goals),
      finalFreeFormAnswer,
    }
  } catch {
    return null
  }
}

export function buildCanonicalInterviewYaml(
  ticketId: string,
  snapshot: InterviewSessionSnapshot,
): string {
  const generatedAt = snapshot.updatedAt || nowIso()
  const questions: InterviewDocumentQuestion[] = snapshot.questions.map((question) => {
    const answer = snapshot.answers[question.id]
    const answerType = question.answerType ?? 'free_text'
    const options = question.options ?? []
    return {
      id: question.id,
      phase: question.phase,
      prompt: question.question,
      source: question.source,
      follow_up_round: question.roundNumber ?? null,
      answer_type: answerType,
      options,
      answer: answer
        ? {
            skipped: answer.skipped,
            selected_option_ids: answer.selectedOptionIds ?? [],
            free_text: answer.answer,
            // A recorded skip came from a person clicking Skip (or leaving a
            // question blank in a submitted batch), which is a `user_skip`.
            // Only a question nobody ever reached stays an `ai_skip` placeholder.
            answered_by: answer.skipped ? 'user_skip' as const : 'user' as const,
            answered_at: (answer.skipped ? answer.skippedAt : answer.answeredAt) ?? '',
            skip_reason: answer.skipped ? normalizeSkipReason(answer.skipReason) : null,
          }
        : emptyAnswer(),
    }
  })

  const followUpRounds = snapshot.followUpRounds.map((round) => ({
    round_number: round.roundNumber,
    source: round.source,
    question_ids: [...round.questionIds],
  }))

  const finalFreeFormAnswerFromQuestions = questions.find((question) => question.source === 'final_free_form')?.answer.free_text ?? ''
  const rawFinalSummary = extractRawFinalInterviewSummary(snapshot.rawFinalYaml)

  const interviewData: InterviewDocument = {
    schema_version: 1,
    ticket_id: ticketId,
    artifact: 'interview',
    status: 'draft',
    generated_by: {
      winner_model: snapshot.winnerId,
      generated_at: generatedAt,
      canonicalization: 'server_normalized',
    },
    questions,
    follow_up_rounds: followUpRounds,
    summary: {
      goals: rawFinalSummary?.goals ?? [],
      constraints: rawFinalSummary?.constraints ?? [],
      non_goals: rawFinalSummary?.nonGoals ?? [],
      final_free_form_answer: rawFinalSummary?.finalFreeFormAnswer ?? finalFreeFormAnswerFromQuestions,
    },
    approval: {
      approved_by: '',
      approved_at: '',
    },
  }

  return buildInterviewDocumentYaml(interviewData)
}

function normalizeCoverageQuestion(question: BatchQuestion, roundNumber: number): InterviewSessionQuestion {
  return normalizeQuestion(question, 'coverage_follow_up', roundNumber)
}

export interface ExtractedCoverageFollowUpQuestionsResult {
  questions: InterviewSessionQuestion[]
  repairWarnings: string[]
}

function nextCoverageFollowUpId(usedIds: Set<string>): string {
  let index = 1
  while (usedIds.has(`CFU${index}`)) {
    index += 1
  }
  return `CFU${index}`
}

function normalizeCoverageFollowUpQuestionIds(
  questions: InterviewSessionQuestion[],
  snapshot: InterviewSessionSnapshot,
): ExtractedCoverageFollowUpQuestionsResult {
  const usedIds = new Set<string>([
    'QFF1',
    ...snapshot.questions.map((question) => question.id.trim()).filter((id) => id.length > 0),
  ])
  const canonicalIds = new Set<string>(usedIds)
  const repairWarnings: string[] = []

  const normalizedQuestions = questions.map((question) => {
    const normalizedId = question.id.trim()
    if (normalizedId.length > 0 && !usedIds.has(normalizedId)) {
      usedIds.add(normalizedId)
      return {
        ...question,
        id: normalizedId,
      }
    }

    const nextId = nextCoverageFollowUpId(usedIds)
    usedIds.add(nextId)

    if (normalizedId.length > 0) {
      repairWarnings.push(
        canonicalIds.has(normalizedId)
          ? `Coverage follow-up id ${normalizedId} remapped to ${nextId} to avoid canonical question overwrite.`
          : `Coverage follow-up id ${normalizedId} remapped to ${nextId} to avoid duplicate question ids in the same batch.`,
      )
    }

    return {
      ...question,
      id: nextId,
    }
  })

  return {
    questions: normalizedQuestions,
    repairWarnings,
  }
}

const COVERAGE_SESSION_DEFAULTS = {
  phase: 'Structure',
  priority: 'high',
  rationale: 'Coverage follow-up required to close interview gaps.',
} as const

function parseCoverageYamlQuestions(response: string): {
  questions: BatchQuestion[]
  repairWarnings: string[]
} {
  try {
    const parsed = parseYamlOrJsonCandidate(response)
    if (!isRecord(parsed)) return { questions: [], repairWarnings: [] }

    // One semantic normaliser, so a coverage response cannot yield a different
    // question type depending on whether the structured envelope or the raw
    // response was the thing that carried it.
    const normalized = normalizeCoverageFollowUpQuestions(
      getValueByAliases(parsed, ['followupquestions', 'follow_up_questions']),
      COVERAGE_SESSION_DEFAULTS,
    )

    return {
      questions: normalized.questions.map((question, index): BatchQuestion => ({
        id: question.id ?? `FU${index + 1}`,
        question: question.question,
        phase: question.phase ?? COVERAGE_SESSION_DEFAULTS.phase,
        priority: question.priority ?? COVERAGE_SESSION_DEFAULTS.priority,
        rationale: question.rationale ?? COVERAGE_SESSION_DEFAULTS.rationale,
        ...(question.answerType ? { answerType: question.answerType } : {}),
        ...(question.options && question.options.length > 0 ? { options: question.options } : {}),
      })),
      repairWarnings: normalized.repairWarnings,
    }
  } catch {
    return { questions: [], repairWarnings: [] }
  }
}

export function extractCoverageFollowUpQuestionsWithMetadata(
  response: string,
  snapshot: InterviewSessionSnapshot,
): ExtractedCoverageFollowUpQuestionsResult {
  const roundNumber = snapshot.followUpRounds
    .filter((round) => round.source === 'coverage')
    .reduce((max, round) => Math.max(max, round.roundNumber), 0) + 1

  const parsedYaml = parseCoverageYamlQuestions(response)
  if (parsedYaml.questions.length > 0) {
    const normalized = normalizeCoverageFollowUpQuestionIds(
      parsedYaml.questions.map((question) => normalizeCoverageQuestion(question, roundNumber)),
      snapshot,
    )
    return {
      questions: normalized.questions,
      repairWarnings: [...parsedYaml.repairWarnings, ...normalized.repairWarnings],
    }
  }

  try {
    const parsedQuestions = parseInterviewQuestions(response, { allowTopLevelArray: true })
    return normalizeCoverageFollowUpQuestionIds(
      parsedQuestions.map((question) => normalizeQuestion(question, 'coverage_follow_up', roundNumber)),
      snapshot,
    )
  } catch {
    return {
      questions: [],
      repairWarnings: [],
    }
  }
}

export function extractCoverageFollowUpQuestions(
  response: string,
  snapshot: InterviewSessionSnapshot,
): InterviewSessionQuestion[] {
  return extractCoverageFollowUpQuestionsWithMetadata(response, snapshot).questions
}

export function buildInterviewQuestionViews(
  snapshot: InterviewSessionSnapshot,
): InterviewQuestionView[] {
  const currentIds = new Set(snapshot.currentBatch?.questions.map((question) => question.id) ?? [])

  return snapshot.questions.map((question) => {
    const answer = snapshot.answers[question.id]
    let status: InterviewQuestionView['status'] = 'pending'
    if (currentIds.has(question.id)) status = 'current'
    else if (answer?.skipped) status = 'skipped'
    else if (answer && !answer.skipped) status = 'answered'

    return {
      ...question,
      status,
      answer: answer ? answer.answer : null,
      ...(answer?.selectedOptionIds && answer.selectedOptionIds.length > 0 ? { selectedOptionIds: answer.selectedOptionIds } : {}),
      ...(status === 'skipped' && answer?.skipReason ? { skipReason: answer.skipReason } : {}),
    }
  })
}
