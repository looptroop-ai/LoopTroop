import * as jsYaml from 'js-yaml'
import type {
  InterviewAnsweredBy,
  InterviewAnswerUpdate,
  InterviewDocument,
  InterviewDocumentAnswer,
  InterviewDocumentQuestion,
} from '@shared/interviewArtifact'
import type {
  InterviewBatchSource,
  InterviewQuestionAnswerType,
  InterviewQuestionOption,
  InterviewQuestionSource,
} from '@shared/interviewSession'
import { isRecord } from '@shared/typeGuards'

export const INTERVIEW_APPROVAL_FOCUS_EVENT = 'looptroop:interview-approval-focus'

export interface InterviewDocumentParseResult {
  document: InterviewDocument | null
  error: string | null
}

export interface InterviewDocumentGroup {
  id: string
  label: string
  description: string
  anchorId: string
  questions: InterviewDocumentQuestion[]
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeAnswerType(value: unknown): InterviewQuestionAnswerType {
  if (value === 'single_choice' || value === 'multiple_choice' || value === 'free_text') {
    return value
  }
  return 'free_text'
}

function normalizeQuestionSource(value: unknown): InterviewQuestionSource {
  if (value === 'prompt_follow_up' || value === 'coverage_follow_up' || value === 'final_free_form') {
    return value
  }
  return 'compiled'
}

function normalizeOption(value: unknown, index: number): InterviewQuestionOption | null {
  if (typeof value === 'string' && value.trim()) {
    return {
      id: `opt${index + 1}`,
      label: value.trim(),
    }
  }
  if (!isRecord(value)) return null

  const id = toStringValue(value.id || value.key || value.value).trim() || `opt${index + 1}`
  const label = toStringValue(value.label || value.text || value.name).trim()
  if (!label) return null
  return { id, label }
}

function normalizeAnsweredBy(value: unknown): InterviewAnsweredBy {
  if (value === 'user') return 'user'
  if (value === 'user_skip') return 'user_skip'
  return 'ai_skip'
}

function normalizeAnswer(value: unknown): InterviewDocumentAnswer {
  if (!isRecord(value)) {
    return {
      skipped: true,
      selected_option_ids: [],
      free_text: '',
      answered_by: 'ai_skip',
      answered_at: '',
      skip_reason: null,
    }
  }

  const isSkipped = value.skipped === true
  const freeText = toStringValue(value.free_text || value.text)
  const selectedOptionIds = toStringArray(value.selected_option_ids || value.selected)
  const answeredBy = normalizeAnsweredBy(value.answered_by)

  return {
    skipped: isSkipped,
    selected_option_ids: isSkipped ? [] : selectedOptionIds,
    free_text: isSkipped ? '' : freeText,
    answered_by: answeredBy,
    answered_at: toStringValue(value.answered_at),
    // This normaliser rebuilds a fixed object and drops everything it does not
    // name, so a reason the server round-tripped correctly would still die here
    // if it were not listed.
    skip_reason: answeredBy === 'user_skip'
      ? (toStringValue(value.skip_reason).trim() || null)
      : null,
  }
}

export function normalizeInterviewDocumentLike(value: unknown): InterviewDocument | null {
  if (!isRecord(value)) return null

  if (typeof value.interview === 'string' && value.interview.trim()) {
    return parseInterviewDocument(value.interview)
  }

  if (value.artifact !== 'interview' || !Array.isArray(value.questions)) {
    return null
  }

  const questions = value.questions.flatMap((question, index) => {
    if (!isRecord(question)) return []

    const answerType = normalizeAnswerType(question.answer_type)
    const options = Array.isArray(question.options)
      ? question.options
        .map((option, optionIndex) => normalizeOption(option, optionIndex))
        .filter((option): option is InterviewQuestionOption => option !== null)
      : []

    return [{
      id: toStringValue(question.id).trim() || `Q${String(index + 1).padStart(2, '0')}`,
      phase: toStringValue(question.phase).trim() || 'Foundation',
      prompt: toStringValue(question.prompt || question.question).trim(),
      source: normalizeQuestionSource(question.source),
      follow_up_round: typeof question.follow_up_round === 'number' ? question.follow_up_round : null,
      answer_type: answerType,
      options,
      answer: normalizeAnswer(question.answer),
    }]
  })

  if (questions.length === 0) return null

  const generatedBy = isRecord(value.generated_by) ? value.generated_by : {}
  const summary = isRecord(value.summary) ? value.summary : {}
  const approval = isRecord(value.approval) ? value.approval : {}
  const rawFollowUpRounds = Array.isArray(value.follow_up_rounds) ? value.follow_up_rounds : []
  const followUpRounds = rawFollowUpRounds.flatMap((round) => {
    if (!isRecord(round)) return []
    const source = round.source === 'coverage' ? 'coverage' : 'prom4'
    const roundNumber = typeof round.round_number === 'number' ? round.round_number : null
    if (!roundNumber) return []
    return [{
      round_number: roundNumber,
      source: source as InterviewBatchSource,
      question_ids: toStringArray(round.question_ids),
    }]
  })

  return {
    schema_version: typeof value.schema_version === 'number' ? value.schema_version : 1,
    ticket_id: toStringValue(value.ticket_id).trim(),
    artifact: 'interview',
    status: value.status === 'approved' ? 'approved' : 'draft',
    generated_by: {
      winner_model: toStringValue(generatedBy.winner_model),
      generated_at: toStringValue(generatedBy.generated_at),
      canonicalization: toStringValue(generatedBy.canonicalization) || undefined,
    },
    questions,
    follow_up_rounds: followUpRounds,
    summary: {
      goals: toStringArray(summary.goals),
      constraints: toStringArray(summary.constraints),
      non_goals: toStringArray(summary.non_goals),
      final_free_form_answer: toStringValue(summary.final_free_form_answer),
    },
    approval: {
      approved_by: toStringValue(approval.approved_by),
      approved_at: toStringValue(approval.approved_at),
    },
  }
}

export function parseInterviewDocumentContent(content: string): InterviewDocumentParseResult {
  if (!content.trim()) {
    return { document: null, error: 'Interview YAML is empty.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    try {
      parsed = jsYaml.load(content)
    } catch (error) {
      return {
        document: null,
        error: error instanceof Error ? error.message : 'Interview YAML could not be parsed.',
      }
    }
  }

  const document = normalizeInterviewDocumentLike(parsed)
  if (!document) {
    return {
      document: null,
      error: 'Interview YAML must contain an artifact: interview document with questions.',
    }
  }

  return { document, error: null }
}

export function parseInterviewDocument(content: string | null | undefined): InterviewDocument | null {
  if (typeof content !== 'string') return null
  return parseInterviewDocumentContent(content).document
}

function hasMeaningfulSummaryItems(items: string[]): boolean {
  return items.some((item) => item.trim().length > 0)
}

export function hasInterviewSummaryContent(document: Pick<InterviewDocument, 'summary'> | null | undefined): boolean {
  if (!document) return false

  return hasMeaningfulSummaryItems(document.summary.goals)
    || hasMeaningfulSummaryItems(document.summary.constraints)
    || hasMeaningfulSummaryItems(document.summary.non_goals)
    || document.summary.final_free_form_answer.trim().length > 0
}

function buildGroupId(question: InterviewDocumentQuestion): string {
  if (question.source === 'prompt_follow_up') {
    return `prompt-follow-up-${question.follow_up_round ?? 0}`
  }
  if (question.source === 'coverage_follow_up') {
    return `coverage-follow-up-${question.follow_up_round ?? 0}`
  }
  if (question.source === 'final_free_form') {
    return 'final-free-form'
  }
  return `phase-${slugify(question.phase || 'foundation') || 'foundation'}`
}

function getPhaseGroupDescription(phase: string): string {
  const normalizedPhase = phase.trim().toLowerCase()

  if (normalizedPhase === 'foundation') {
    return 'Problem framing, goals, and constraints established in the approved interview.'
  }
  if (normalizedPhase === 'structure') {
    return 'System shape, workflows, and boundaries defined in the approved interview.'
  }
  if (normalizedPhase === 'assembly') {
    return 'Implementation details, integrations, and delivery considerations captured in the approved interview.'
  }

  return 'Core interview questions captured in the approved interview results.'
}

function buildGroupLabel(question: InterviewDocumentQuestion): { label: string; description: string } {
  if (question.source === 'prompt_follow_up') {
    const roundSuffix = question.follow_up_round ? ` · Round ${question.follow_up_round}` : ''
    return {
      label: `PROM4 Follow-ups${roundSuffix}`,
      description: 'Follow-up questions generated to deepen or clarify earlier answers.',
    }
  }
  if (question.source === 'coverage_follow_up') {
    const roundSuffix = question.follow_up_round ? ` · Round ${question.follow_up_round}` : ''
    return {
      label: `Coverage Follow-ups${roundSuffix}`,
      description: 'Gap-filling questions generated during interview coverage verification.',
    }
  }
  if (question.source === 'final_free_form') {
    return {
      label: 'Final Free-Form',
      description: 'The final catch-all answer for anything still important after the structured questions.',
    }
  }
  return {
    label: question.phase || 'Foundation',
    description: getPhaseGroupDescription(question.phase || 'Foundation'),
  }
}

export function getInterviewSummaryAnchorId(): string {
  return 'interview-summary'
}

export function getInterviewGroupAnchorId(groupId: string): string {
  return `interview-group-${slugify(groupId) || 'section'}`
}

export function getInterviewPhaseGroupAnchorId(phase: string): string {
  return getInterviewGroupAnchorId(`phase-${slugify(phase || 'foundation') || 'foundation'}`)
}

export function getInterviewQuestionAnchorId(questionId: string): string {
  return `interview-question-${slugify(questionId) || 'question'}`
}

export function getInterviewFollowUpsAnchorId(): string {
  return 'interview-follow-ups'
}

export function groupInterviewDocumentQuestions(document: InterviewDocument): InterviewDocumentGroup[] {
  const groups = new Map<string, InterviewDocumentGroup>()

  for (const question of document.questions) {
    const id = buildGroupId(question)
    const existing = groups.get(id)
    if (existing) {
      existing.questions.push(question)
      continue
    }

    const meta = buildGroupLabel(question)
    groups.set(id, {
      id,
      label: meta.label,
      description: meta.description,
      anchorId: getInterviewGroupAnchorId(id),
      questions: [question],
    })
  }

  return Array.from(groups.values())
}

export function buildInterviewAnswerDrafts(document: InterviewDocument): Record<string, InterviewAnswerUpdate['answer']> {
  return Object.fromEntries(document.questions.map((question) => [
    question.id,
    {
      skipped: question.answer.skipped,
      selected_option_ids: [...question.answer.selected_option_ids],
      free_text: question.answer.free_text,
      skip_reason: question.answer.skip_reason,
    },
  ]))
}

export function hasSkippedInterviewAnswers(document: InterviewDocument | null): boolean {
  if (!document) return false
  return document.questions.some((question) => question.answer.skipped)
}

export function getInterviewAnswerSummary(answer: InterviewDocumentAnswer, options: InterviewQuestionOption[]): {
  labels: string[]
  freeText: string
  skipped: boolean
} {
  const labels = answer.selected_option_ids.map((selectedId) => {
    const match = options.find((option) => option.id === selectedId)
    return match?.label ?? selectedId
  })

  return {
    labels,
    freeText: answer.free_text,
    skipped: answer.skipped,
  }
}
