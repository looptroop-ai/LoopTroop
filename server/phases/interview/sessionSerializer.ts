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
import { buildInterviewDocumentYaml } from '../../structuredOutput'
import { isRecord, parseYamlOrJsonCandidate } from '../../structuredOutput/yamlUtils'
import { nowIso, normalizeQuestion, cloneSnapshot } from './interviewUtils'

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

  try {
    const parsed = JSON.parse(content) as InterviewSessionSnapshot
    if (parsed.schemaVersion !== 1 || typeof parsed.winnerId !== 'string') return null
    if (!Array.isArray(parsed.questions) || !parsed.answers || typeof parsed.answers !== 'object') return null
    return cloneSnapshot(parsed)
  } catch {
    return null
  }
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

function parseCoverageYamlQuestions(response: string): BatchQuestion[] {
  try {
    const parsed = parseYamlOrJsonCandidate(response)
    if (!isRecord(parsed)) return []

    const rawFollowUps = Array.isArray(parsed.follow_up_questions)
      ? parsed.follow_up_questions
      : Array.isArray(parsed.followUpQuestions)
        ? parsed.followUpQuestions
        : []

    if (rawFollowUps.length === 0) return []
    return rawFollowUps.map((entry, index) => {
      if (typeof entry === 'string') {
        return {
          id: `FU${index + 1}`,
          question: entry.trim(),
          phase: 'Structure',
          priority: 'high',
          rationale: 'Coverage follow-up required to close interview gaps.',
        }
      }

      const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}

      // Extract answer type
      const rawAnswerType = record.answer_type ?? record.answerType ?? record.type
      let answerType: 'single_choice' | 'multiple_choice' | undefined
      if (typeof rawAnswerType === 'string') {
        const at = rawAnswerType.toLowerCase().replace(/[\s_-]/g, '')
        if (at === 'yesno' || at === 'boolean' || at === 'bool') {
          answerType = 'single_choice'
        } else if (at === 'singlechoice' || at === 'radio' || at === 'single') {
          answerType = 'single_choice'
        } else if (at === 'multiplechoice' || at === 'multi' || at === 'checkbox' || at === 'multichoice') {
          answerType = 'multiple_choice'
        }
      }

      // Extract options (auto-generate for yes_no)
      const isYesNo = typeof rawAnswerType === 'string' && ['yes_no', 'yesno', 'boolean', 'bool'].includes(rawAnswerType.toLowerCase().replace(/[\s_-]/g, ''))
      let options: Array<{ id: string; label: string }> | undefined
      if (isYesNo) {
        options = [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]
      } else if (answerType && Array.isArray(record.options)) {
        options = record.options
          .map((opt: unknown, i: number) => {
            if (typeof opt === 'string') return { id: `opt${i + 1}`, label: opt.trim() }
            if (opt && typeof opt === 'object') {
              const o = opt as Record<string, unknown>
              const label = typeof o.label === 'string' ? o.label : typeof o.text === 'string' ? o.text : undefined
              if (!label) return null
              return { id: typeof o.id === 'string' ? o.id : `opt${i + 1}`, label: label.trim() }
            }
            return null
          })
          .filter((opt: { id: string; label: string } | null): opt is { id: string; label: string } => opt !== null)
      }

      // Downgrade if choice type but no options
      if (answerType && (!options || options.length === 0) && !isYesNo) {
        answerType = undefined
        options = undefined
      }

      return {
        id: typeof record.id === 'string' ? record.id : `FU${index + 1}`,
        question: typeof record.question === 'string'
          ? record.question
          : typeof record.prompt === 'string'
            ? record.prompt
            : String(record.text ?? ''),
        phase: typeof record.phase === 'string' ? record.phase : 'Structure',
        priority: typeof record.priority === 'string' ? record.priority : 'high',
        rationale: typeof record.rationale === 'string' ? record.rationale : 'Coverage follow-up required to close interview gaps.',
        ...(answerType ? { answerType } : {}),
        ...(options && options.length > 0 ? { options } : {}),
      }
    }).filter((question) => question.question.trim().length > 0)
  } catch {
    return []
  }
}

export function extractCoverageFollowUpQuestionsWithMetadata(
  response: string,
  snapshot: InterviewSessionSnapshot,
): ExtractedCoverageFollowUpQuestionsResult {
  const roundNumber = snapshot.followUpRounds
    .filter((round) => round.source === 'coverage')
    .reduce((max, round) => Math.max(max, round.roundNumber), 0) + 1

  const parsedYamlQuestions = parseCoverageYamlQuestions(response)
  if (parsedYamlQuestions.length > 0) {
    return normalizeCoverageFollowUpQuestionIds(
      parsedYamlQuestions.map((question) => normalizeCoverageQuestion(question, roundNumber)),
      snapshot,
    )
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
    }
  })
}
