import type {
  InterviewAnsweredBy,
  InterviewAnswerUpdate,
  InterviewDocument,
  InterviewDocumentAnswer,
  InterviewDocumentFollowUpRound,
  InterviewDocumentGeneratedBy,
  InterviewDocumentQuestion,
} from '@shared/interviewArtifact'
import { normalizeSkipReason } from '@shared/skipReceipt'
import type {
  InterviewBatchSource,
  InterviewQuestionAnswerType,
  InterviewQuestionOption,
  InterviewQuestionSource,
} from '@shared/interviewSession'
import type { StructuredOutputResult } from './types'
import { looksLikeStructuredPromptSchemaEcho } from '../lib/promptEcho'
import {
  buildYamlDocument,
  appendStructuredCandidateRecoveryWarning,
  collectStructuredCandidates,
  getNestedRecord,
  getRequiredString,
  getValueByAliases,
  getStringByAliases,
  isRecord,
  normalizeKey,
  parseYamlOrJsonCandidate,
  toBoolean,
  toInteger,
  toOptionalString,
  toStringArray,
  unwrapExplicitWrapperRecord,
  collectAliasConflictWarnings,
  withAliasConflictWarnings,
} from './yamlUtils'
import { buildStructuredOutputFailure, createStructuredCandidateFailureTracker } from './failure'

const INTERVIEW_DOCUMENT_PROMPT_ECHO_ERROR = 'Interview document output echoed the prompt instead of returning a structured interview artifact'

const INTERVIEW_DOCUMENT_NESTED_MAPPING_CHILDREN = {
  generated_by: ['winner_model', 'generated_at', 'canonicalization'],
  answer: ['skipped', 'selected_option_ids', 'free_text', 'answered_by', 'answered_at', 'skip_reason'],
  summary: ['goals', 'constraints', 'non_goals', 'final_free_form_answer'],
  approval: ['approved_by', 'approved_at'],
} as const

function isPromptEchoValidationError(error: string): boolean {
  return /echoed the prompt/i.test(error)
}

function normalizePhaseLabel(value: string): string {
  const trimmed = value.trim()
  const normalized = normalizeKey(trimmed)
  if (normalized === 'foundation') return 'Foundation'
  if (normalized === 'structure') return 'Structure'
  if (normalized === 'assembly') return 'Assembly'
  return trimmed
}

function normalizeQuestionSource(value: unknown): InterviewQuestionSource {
  const raw = toOptionalString(value)
  const normalized = normalizeKey(raw ?? '')
  if (normalized === 'compiled') return 'compiled'
  if (normalized === 'promptfollowup' || normalized === 'prompt_follow_up') return 'prompt_follow_up'
  if (normalized === 'coveragefollowup' || normalized === 'coverage_follow_up') return 'coverage_follow_up'
  if (normalized === 'finalfreeform' || normalized === 'final_free_form') return 'final_free_form'
  return 'compiled'
}

function normalizeOption(value: unknown, index: number): InterviewQuestionOption | null {
  if (typeof value === 'string') {
    const label = value.trim()
    if (!label) return null
    return { id: `opt${index + 1}`, label }
  }
  if (!isRecord(value)) return null

  const id = toOptionalString(getValueByAliases(value, ['id', 'key', 'value'])) ?? `opt${index + 1}`
  const label = toOptionalString(getValueByAliases(value, ['label', 'text', 'name', 'option', 'description']))
  if (!label) return null

  return {
    id: id.trim(),
    label: label.trim(),
  }
}

function normalizeAnswerType(
  value: unknown,
  warnings: string[],
  label: string,
): { answerType: InterviewQuestionAnswerType; impliedOptions: InterviewQuestionOption[] | null } {
  const raw = toOptionalString(value)
  const normalized = normalizeKey(raw ?? '')
  if (!raw || normalized === 'freetext' || normalized === 'free_text' || normalized === 'text') {
    return { answerType: 'free_text', impliedOptions: null }
  }
  if (normalized === 'singlechoice' || normalized === 'single_choice' || normalized === 'radio') {
    return { answerType: 'single_choice', impliedOptions: null }
  }
  if (normalized === 'multiplechoice' || normalized === 'multiple_choice' || normalized === 'multichoice' || normalized === 'checkbox') {
    return { answerType: 'multiple_choice', impliedOptions: null }
  }
  if (normalized === 'yesno' || normalized === 'yes_no' || normalized === 'boolean' || normalized === 'bool') {
    warnings.push(`${label}: normalized yes/no answer_type to single_choice with Yes/No options.`)
    return {
      answerType: 'single_choice',
      impliedOptions: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    }
  }

  throw new Error(`${label}: unsupported answer_type "${raw}"`)
}

function normalizeGeneratedBy(record: Record<string, unknown>): InterviewDocumentGeneratedBy {
  const winnerModel = getRequiredString(record, ['winnermodel', 'winner_model'], 'generated_by.winner_model')
  const generatedAt = getRequiredString(record, ['generatedat', 'generated_at'], 'generated_by.generated_at')
  const canonicalization = toOptionalString(getValueByAliases(record, ['canonicalization']))

  return {
    winner_model: winnerModel,
    generated_at: generatedAt,
    ...(canonicalization ? { canonicalization } : {}),
  }
}

function normalizeQuestionAnswer(
  value: unknown,
  answerType: InterviewQuestionAnswerType,
  warnings: string[],
  questionId: string,
): InterviewDocumentAnswer {
  if (!isRecord(value)) {
    throw new Error(`Question ${questionId} is missing answer`)
  }

  const selectedOptionIds = Array.from(new Set(toStringArray(
    getValueByAliases(value, ['selectedoptionids', 'selected_option_ids', 'selected']),
  )))
  const freeText = getStringByAliases(value, ['freetext', 'free_text', 'text']) ?? ''
  const explicitSkipped = toBoolean(getValueByAliases(value, ['skipped']))

  let nextSelectedOptionIds = selectedOptionIds
  if (answerType === 'free_text' && selectedOptionIds.length > 0) {
    warnings.push(`Question ${questionId}: dropped selected_option_ids for free_text answer_type.`)
    nextSelectedOptionIds = []
  }
  if (answerType === 'single_choice' && selectedOptionIds.length > 1) {
    warnings.push(`Question ${questionId}: kept only the first selected option for single_choice answer_type.`)
    nextSelectedOptionIds = selectedOptionIds.slice(0, 1)
  }

  const skipped = explicitSkipped ?? (freeText.trim().length === 0 && nextSelectedOptionIds.length === 0)
  const answeredByRaw = toOptionalString(getValueByAliases(value, ['answeredby', 'answered_by'])) ?? ''
  const answeredByNormalized = normalizeKey(answeredByRaw)
  const isUserSkip = answeredByNormalized === 'userskip' || answeredByNormalized === 'user_skip'
  // A skipped answer defaults to `ai_skip`, which is what every artifact written
  // before user skips existed says. Only an explicit `user_skip` overrides it,
  // so an old interview keeps loading exactly as it always did.
  const answeredBy: InterviewAnsweredBy = skipped
    ? (isUserSkip ? 'user_skip' : 'ai_skip')
    : answeredByNormalized === 'aiskip' || answeredByNormalized === 'ai_skip'
      ? 'ai_skip'
      : 'user'
  const rawAnsweredAt = toOptionalString(getValueByAliases(value, ['answeredat', 'answered_at'])) ?? ''
  // A user skip is a decision with a time. An AI-fill placeholder is not.
  const answeredAt = skipped && answeredBy !== 'user_skip' ? '' : rawAnsweredAt
  const skipReason = answeredBy === 'user_skip'
    ? normalizeSkipReason(toOptionalString(getValueByAliases(value, ['skipreason', 'skip_reason'])))
    : null

  return {
    skipped,
    selected_option_ids: nextSelectedOptionIds,
    free_text: freeText,
    answered_by: answeredBy,
    answered_at: answeredAt,
    skip_reason: skipReason,
  }
}

function compareStringArrays(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function compareQuestionMetadata(
  left: InterviewDocumentQuestion,
  right: InterviewDocumentQuestion,
): boolean {
  return left.id === right.id
    && left.phase === right.phase
    && left.prompt === right.prompt
    && left.source === right.source
    && left.follow_up_round === right.follow_up_round
    && left.answer_type === right.answer_type
    && left.options.length === right.options.length
    && left.options.every((option, index) => (
      option.id === right.options[index]?.id
      && option.label === right.options[index]?.label
    ))
}

function compareQuestionAnswers(
  left: InterviewDocumentQuestion['answer'],
  right: InterviewDocumentQuestion['answer'],
): boolean {
  return left.skipped === right.skipped
    && left.free_text === right.free_text
    && left.answered_by === right.answered_by
    && left.answered_at === right.answered_at
    && compareStringArrays(left.selected_option_ids, right.selected_option_ids)
}

function answerHasContent(answer: InterviewDocumentQuestion['answer']): boolean {
  return answer.free_text.trim().length > 0 || answer.selected_option_ids.length > 0
}

function isAcceptedEmptyFinalFreeFormAnswer(
  canonicalQuestion: InterviewDocumentQuestion,
  candidateQuestion: InterviewDocumentQuestion,
): boolean {
  return canonicalQuestion.source === 'final_free_form'
    && canonicalQuestion.answer_type === 'free_text'
    && !candidateQuestion.answer.skipped
    && candidateQuestion.answer.selected_option_ids.length === 0
    && candidateQuestion.answer.free_text.trim().length === 0
    && candidateQuestion.answer.answered_at.trim().length > 0
}

function compareSummary(
  left: InterviewDocument['summary'],
  right: InterviewDocument['summary'],
): boolean {
  return compareStringArrays(left.goals, right.goals)
    && compareStringArrays(left.constraints, right.constraints)
    && compareStringArrays(left.non_goals, right.non_goals)
    && left.final_free_form_answer === right.final_free_form_answer
}

function buildResolvedInterviewQuestionMismatchError(
  canonicalIds: string[],
  candidateIds: string[],
): string {
  const candidateIdSet = new Set(candidateIds)
  const canonicalIdSet = new Set(canonicalIds)
  const missingCanonicalIds = canonicalIds.filter((id) => !candidateIdSet.has(id))
  const unexpectedIds = candidateIds.filter((id) => !canonicalIdSet.has(id))
  const duplicateCandidateIds = candidateIds.filter((id, index) => candidateIds.indexOf(id) !== index)
  const details: string[] = []

  if (missingCanonicalIds.length > 0) {
    details.push(`missing canonical ids: ${missingCanonicalIds.join(', ')}`)
  }
  if (unexpectedIds.length > 0) {
    details.push(`unexpected ids: ${unexpectedIds.join(', ')}`)
  }
  if (duplicateCandidateIds.length > 0) {
    details.push(`duplicate candidate ids: ${Array.from(new Set(duplicateCandidateIds)).join(', ')}`)
  }

  return details.length > 0
    ? `Resolved interview must preserve all ${canonicalIds.length} canonical questions (${details.join('; ')})`
    : `Resolved interview must preserve all ${canonicalIds.length} canonical questions`
}

function parseExactOptionLabelSelections(
  answerText: string,
  answerType: InterviewQuestionAnswerType,
): string[] {
  const trimmed = answerText.trim()
  if (!trimmed) return []

  if (answerType === 'single_choice') {
    return [trimmed]
  }

  const newlineTokens = trimmed
    .split('\n')
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean)
  if (newlineTokens.length > 1) {
    return newlineTokens
  }

  const commaTokens = trimmed
    .split(/[;,]/)
    .map((token) => token.trim())
    .filter(Boolean)
  if (commaTokens.length > 1) {
    return commaTokens
  }

  return [trimmed]
}

function buildCanonicalOptionLabelMap(
  canonicalQuestion: InterviewDocumentQuestion,
): Map<string, string> {
  const normalizedOptionLabels = new Map<string, string>()

  for (const option of canonicalQuestion.options) {
    const normalized = normalizeKey(option.label)
    if (normalizedOptionLabels.has(normalized)) {
      throw new Error(`Canonical question ${canonicalQuestion.id} has ambiguous option labels after normalization`)
    }
    normalizedOptionLabels.set(normalized, option.id)
  }

  return normalizedOptionLabels
}

function resolveCanonicalOptionIdFromAnswerText(
  answerText: string,
  canonicalQuestion: InterviewDocumentQuestion,
  normalizedOptionLabels: Map<string, string>,
): string | null {
  const trimmed = answerText.trim()
  if (!trimmed) return null

  const exactMatch = normalizedOptionLabels.get(normalizeKey(trimmed))
  if (exactMatch) return exactMatch

  const lowerTrimmed = trimmed.toLowerCase()
  const prefixMatches = canonicalQuestion.options.filter((option) => {
    const label = option.label.trim()
    if (!label) return false
    if (!lowerTrimmed.startsWith(label.toLowerCase())) return false

    const remainder = trimmed.slice(label.length)
    return remainder.length === 0 || /^[\s]*[.,;:!?()[\]{}'"`-]/.test(remainder)
  })

  return prefixMatches.length === 1 ? prefixMatches[0]!.id : null
}

function normalizeChoiceQuestionAnswer(
  canonicalQuestion: InterviewDocumentQuestion,
  candidateQuestion: InterviewDocumentQuestion,
): { selectedOptionIds: string[]; freeText: string; repairedSelectionIds: boolean } {
  const optionIdSet = new Set(canonicalQuestion.options.map((option) => option.id))
  const normalizedOptionLabels = buildCanonicalOptionLabelMap(canonicalQuestion)
  const explicitSelections = Array.from(new Set(candidateQuestion.answer.selected_option_ids))

  if (explicitSelections.length > 0) {
    let repairedSelectionIds = false
    const selectedOptionIds = explicitSelections.map((optionId) => {
      if (optionIdSet.has(optionId)) {
        return optionId
      }

      const candidateOption = candidateQuestion.options.find((option) => option.id === optionId)
      const repairedOptionId = candidateOption
        ? resolveCanonicalOptionIdFromAnswerText(candidateOption.label, canonicalQuestion, normalizedOptionLabels)
        : null

      if (!repairedOptionId) {
        throw new Error(`Resolved interview selected unknown option id "${optionId}" for canonical question ${canonicalQuestion.id}`)
      }

      repairedSelectionIds = true
      return repairedOptionId
    })

    const uniqueSelections = Array.from(new Set(selectedOptionIds))
    if (canonicalQuestion.answer_type === 'single_choice' && explicitSelections.length !== 1) {
      throw new Error(`Resolved interview must select exactly one option for canonical question ${canonicalQuestion.id}`)
    }
    return {
      selectedOptionIds: uniqueSelections,
      freeText: candidateQuestion.answer.free_text,
      repairedSelectionIds,
    }
  }

  const labels = parseExactOptionLabelSelections(candidateQuestion.answer.free_text, canonicalQuestion.answer_type)
  if (labels.length === 0) {
    throw new Error(`Resolved interview left skipped question unanswered: ${canonicalQuestion.id}`)
  }

  const selectedOptionIds = labels.map((label) => {
    const optionId = resolveCanonicalOptionIdFromAnswerText(label, canonicalQuestion, normalizedOptionLabels)
    if (!optionId) {
      throw new Error(`Resolved interview answer for canonical question ${canonicalQuestion.id} does not map exactly to canonical options`)
    }
    return optionId
  })

  const uniqueSelections = Array.from(new Set(selectedOptionIds))
  if (canonicalQuestion.answer_type === 'single_choice' && uniqueSelections.length !== 1) {
    throw new Error(`Resolved interview must select exactly one option for canonical question ${canonicalQuestion.id}`)
  }

  return {
    selectedOptionIds: uniqueSelections,
    freeText: candidateQuestion.answer.free_text,
    repairedSelectionIds: false,
  }
}

function normalizeQuestion(
  value: unknown,
  index: number,
  warnings: string[],
): InterviewDocumentQuestion {
  if (!isRecord(value)) {
    throw new Error(`Question at index ${index} is not an object`)
  }

  const id = getRequiredString(value, ['id'], `questions[${index}].id`)
  const prompt = getRequiredString(value, ['prompt', 'question', 'text'], `questions[${index}].prompt`)
  const phase = normalizePhaseLabel(getRequiredString(value, ['phase'], `questions[${index}].phase`))
  const source = normalizeQuestionSource(getValueByAliases(value, ['source']))
  const followUpRound = toInteger(getValueByAliases(value, ['followupround', 'follow_up_round']))
  const { answerType, impliedOptions } = normalizeAnswerType(
    getValueByAliases(value, ['answertype', 'answer_type', 'type']),
    warnings,
    `Question ${id}`,
  )
  const rawOptions = getValueByAliases(value, ['options'])
  const normalizedOptions = Array.isArray(rawOptions)
    ? rawOptions
      .map((option, optionIndex) => normalizeOption(option, optionIndex))
      .filter((option): option is InterviewQuestionOption => option !== null)
    : []
  const options = impliedOptions ?? normalizedOptions
  if (answerType !== 'free_text' && options.length === 0) {
    throw new Error(`Question ${id} requires options for answer_type ${answerType}`)
  }
  const answer = normalizeQuestionAnswer(getValueByAliases(value, ['answer']), answerType, warnings, id)

  return {
    id,
    phase,
    prompt,
    source,
    follow_up_round: followUpRound === null ? null : followUpRound,
    answer_type: answerType,
    options,
    answer,
  }
}

function normalizeFollowUpRound(value: unknown, index: number): InterviewDocumentFollowUpRound {
  if (!isRecord(value)) {
    throw new Error(`follow_up_rounds[${index}] is not an object`)
  }

  const roundNumber = toInteger(getValueByAliases(value, ['roundnumber', 'round_number']))
  if (roundNumber === null || roundNumber < 1) {
    throw new Error(`follow_up_rounds[${index}] is missing round_number`)
  }

  const sourceRaw = toOptionalString(getValueByAliases(value, ['source'])) ?? 'prom4'
  const sourceNormalized = normalizeKey(sourceRaw)
  let source: InterviewBatchSource
  if (sourceNormalized === 'coverage') {
    source = 'coverage'
  } else if (sourceNormalized === 'prom4') {
    source = 'prom4'
  } else {
    throw new Error(`follow_up_rounds[${index}] has unsupported source "${sourceRaw}"`)
  }

  return {
    round_number: roundNumber,
    source,
    question_ids: Array.from(new Set(toStringArray(getValueByAliases(value, ['questionids', 'question_ids'])))),
  }
}

function normalizeFollowUpRounds(
  value: unknown,
  warnings: string[],
  options?: {
    allowMalformedFollowUpRounds?: boolean
  },
): InterviewDocumentFollowUpRound[] {
  if (!Array.isArray(value)) return []

  try {
    return value.map((round, index) => normalizeFollowUpRound(round, index))
  } catch (error) {
    if (!options?.allowMalformedFollowUpRounds) {
      throw error
    }
    warnings.push('Canonicalized follow_up_rounds to match the approved Interview Results artifact.')
    return []
  }
}

function syncFinalFreeFormSummary(document: InterviewDocument): InterviewDocument {
  const finalFreeFormQuestion = document.questions.find((question) => question.source === 'final_free_form')
  if (!finalFreeFormQuestion) return document

  return {
    ...document,
    summary: {
      ...document.summary,
      final_free_form_answer: finalFreeFormQuestion.answer.skipped
        ? ''
        : finalFreeFormQuestion.answer.free_text,
    },
  }
}

function unwrapInterviewArtifactObjectWrapper(value: unknown): unknown {
  if (!isRecord(value)) return value

  const artifact = getValueByAliases(value, ['artifact'])
  if (!isRecord(artifact)) return value

  const nestedInterview = getValueByAliases(artifact, ['interview'])
  if (!isRecord(nestedInterview)) return value

  return {
    ...value,
    ...nestedInterview,
    artifact: 'interview',
  }
}

function buildAnswerOnlyResolvedInterviewCandidate(
  candidateContent: string,
  canonical: InterviewDocument,
  options: {
    memberId?: string
  },
): StructuredOutputResult<InterviewDocument> | null {
  const repairWarnings: string[] = []
  // This fallback resolves its own aliases rather than going through
  // `normalizeInterviewDocumentOutput`, which installs the sink itself, so
  // without one here a payload spelling `questions` two ways resolved silently.
  return withAliasConflictWarnings(repairWarnings, () =>
    buildAnswerOnlyResolvedInterviewCandidateInner(candidateContent, canonical, options, repairWarnings))
}

function buildAnswerOnlyResolvedInterviewCandidateInner(
  candidateContent: string,
  canonical: InterviewDocument,
  options: {
    memberId?: string
  },
  repairWarnings: string[],
): StructuredOutputResult<InterviewDocument> | null {
  let parsed: unknown

  for (const parseOptions of [
    {},
    { nestedMappingChildren: INTERVIEW_DOCUMENT_NESTED_MAPPING_CHILDREN },
  ]) {
    try {
      parsed = unwrapInterviewArtifactObjectWrapper(unwrapExplicitWrapperRecord(parseYamlOrJsonCandidate(candidateContent, {
        ...parseOptions,
        allowTrailingTerminalNoise: true,
        repairWarnings,
      }), [
        'interview',
        'output',
        'result',
        'data',
      ]))
      break
    } catch {
      parsed = undefined
    }
  }
  if (parsed === undefined) return null

  if (!isRecord(parsed)) return null

  const rawQuestions = getValueByAliases(parsed, ['questions'])
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null

  const canonicalIds = canonical.questions.map((question) => question.id)
  const rawQuestionRecords: Record<string, unknown>[] = []
  const rawQuestionIds: string[] = []
  const allowedQuestionKeys = new Set([
    'id',
    'answer',
    'skipped',
    'selectedoptionids',
    'selected_option_ids',
    'selected',
    'freetext',
    'free_text',
    'text',
    'answeredby',
    'answered_by',
    'answeredat',
    'answered_at',
  ].map(normalizeKey))

  for (let index = 0; index < rawQuestions.length; index += 1) {
    const rawQuestion = rawQuestions[index]
    if (!isRecord(rawQuestion)) return null

    const unknownKeys = Object.keys(rawQuestion).filter((key) => !allowedQuestionKeys.has(normalizeKey(key)))
    if (unknownKeys.length > 0) return null

    const id = toOptionalString(getValueByAliases(rawQuestion, ['id']))
    if (!id) return null

    rawQuestionRecords.push(rawQuestion)
    rawQuestionIds.push(id)
  }

  if (
    rawQuestionIds.length !== canonicalIds.length
    || new Set(rawQuestionIds).size !== rawQuestionIds.length
    || canonicalIds.some((id) => !rawQuestionIds.includes(id))
  ) {
    return null
  }

  repairWarnings.push('Recovered Full Answers answer-only question blocks using canonical question metadata.')

  const rawQuestionsById = new Map(rawQuestionRecords.map((question) => [
    toOptionalString(getValueByAliases(question, ['id']))!,
    question,
  ]))

  const questions = canonical.questions.map((canonicalQuestion) => {
    const rawQuestion = rawQuestionsById.get(canonicalQuestion.id)
    if (!rawQuestion) {
      throw new Error(`Resolved interview is missing canonical question ${canonicalQuestion.id}`)
    }

    const rawAnswer = getValueByAliases(rawQuestion, ['answer'])
    const answerRecord = isRecord(rawAnswer) ? { ...rawAnswer } : {}
    const hoistedAnsweredBy = getValueByAliases(rawQuestion, ['answeredby', 'answered_by'])
    const hoistedAnsweredAt = getValueByAliases(rawQuestion, ['answeredat', 'answered_at'])

    if (hoistedAnsweredBy !== undefined && getValueByAliases(answerRecord, ['answeredby', 'answered_by']) === undefined) {
      answerRecord.answered_by = hoistedAnsweredBy
      repairWarnings.push(`Hoisted answered_by into answer for canonical question ${canonicalQuestion.id}.`)
    }
    if (hoistedAnsweredAt !== undefined && getValueByAliases(answerRecord, ['answeredat', 'answered_at']) === undefined) {
      answerRecord.answered_at = hoistedAnsweredAt
      repairWarnings.push(`Hoisted answered_at into answer for canonical question ${canonicalQuestion.id}.`)
    }

    const answerSiblingAliases: Array<[string[], string[]]> = [
      [['skipped'], ['skipped']],
      [['selectedoptionids', 'selected_option_ids', 'selected'], ['selectedoptionids', 'selected_option_ids', 'selected']],
      [['freetext', 'free_text', 'text'], ['freetext', 'free_text', 'text']],
    ]
    for (const [sourceKey, targetKey] of answerSiblingAliases) {
      const siblingValue = getValueByAliases(rawQuestion, sourceKey)
      const target = targetKey[0]
      if (target && siblingValue !== undefined && getValueByAliases(answerRecord, targetKey) === undefined) {
        answerRecord[target] = siblingValue
      }
    }

    return {
      ...canonicalQuestion,
      answer: normalizeQuestionAnswer(answerRecord, canonicalQuestion.answer_type, repairWarnings, canonicalQuestion.id),
    }
  })

  let generatedBy = canonical.generated_by
  const rawGeneratedBy = getValueByAliases(parsed, ['generatedby', 'generated_by'])
  if (isRecord(rawGeneratedBy)) {
    try {
      generatedBy = normalizeGeneratedBy(rawGeneratedBy)
    } catch {
      repairWarnings.push('Ignored incomplete generated_by in answer-only Full Answers artifact.')
    }
  }

  const document = syncFinalFreeFormSummary({
    ...canonical,
    status: 'draft',
    generated_by: {
      ...generatedBy,
      ...(options.memberId ? { winner_model: options.memberId } : {}),
      canonicalization: 'server_normalized',
    },
    questions,
    approval: {
      approved_by: '',
      approved_at: '',
    },
  })

  return {
    ok: true,
    value: document,
    normalizedContent: buildInterviewDocumentYaml(document),
    repairApplied: true,
    repairWarnings,
  }
}

/**
 * Serialises the answer block, dropping `skip_reason` when there is none.
 *
 * Emitting `skip_reason: null` on every one of forty questions would add a line
 * of noise per question to an artifact that several prompts read in full, and
 * would rewrite every interview already on disk for no gain. The field appears
 * only where a person actually left a reason.
 */
function toSerializableAnswer(answer: InterviewDocumentAnswer): Record<string, unknown> {
  const { skip_reason: skipReason, ...rest } = answer
  return skipReason === null ? rest : { ...rest, skip_reason: skipReason }
}

export function buildInterviewDocumentYaml(document: InterviewDocument): string {
  return buildYamlDocument({
    ...document,
    questions: document.questions.map((question) => ({
      ...question,
      answer: toSerializableAnswer(question.answer),
    })),
  })
}

/**
 * Removes `skip_reason:` and everything indented under it.
 *
 * The last line of defence, for a document that no longer parses. Handles block
 * scalars, which a single-line regex would leave half-deleted.
 */
function stripSkipReasonLines(rawContent: string): string {
  const lines = rawContent.split('\n')
  const kept: string[] = []
  let dropIndent: number | null = null

  for (const line of lines) {
    const indent = line.length - line.trimStart().length
    if (dropIndent !== null) {
      if (line.trim().length === 0 || indent > dropIndent) continue
      dropIndent = null
    }
    if (/^[^\S\n]*skip_reason[^\S\n]*:/.test(line)) {
      dropIndent = indent
      continue
    }
    kept.push(line)
  }

  return kept.join('\n')
}

/**
 * The same document with every skip reason removed.
 *
 * Reasons are for people and for PROM10a, which receives them through its own
 * fenced context part. Every other prompt that reads `interview.yaml` — PRD
 * drafting, PRD voting, interview coverage — gets this instead, so a reason
 * cannot reach a model that was never meant to weigh it.
 *
 * Falls back rather than failing, because a stripped-but-imperfect interview is
 * always better than either leaking a reason or dropping the interview from a
 * prompt that needs it.
 */
export function stripSkipReasonsFromInterviewYaml(rawContent: string): string {
  if (!/^[^\S\n]*skip_reason[^\S\n]*:/m.test(rawContent)) return rawContent

  try {
    const parsed = parseYamlOrJsonCandidate(rawContent, {
      nestedMappingChildren: INTERVIEW_DOCUMENT_NESTED_MAPPING_CHILDREN,
    })
    if (isRecord(parsed) && Array.isArray(parsed.questions)) {
      for (const question of parsed.questions) {
        if (isRecord(question) && isRecord(question.answer)) delete question.answer.skip_reason
      }
      return buildYamlDocument(parsed)
    }
  } catch {
    // Fall through to the textual strip below.
  }

  return stripSkipReasonLines(rawContent)
}

export function normalizeInterviewDocumentOutput(
  rawContent: string,
  options?: {
    ticketId?: string
    allowTrailingTerminalNoise?: boolean
    allowMalformedFollowUpRounds?: boolean
  },
): StructuredOutputResult<InterviewDocument> {
  const candidates = collectStructuredCandidates(rawContent, {
    topLevelHints: ['schema_version', 'ticket_id', 'artifact', 'questions'],
  })
  const failures = createStructuredCandidateFailureTracker('No interview document content found')

  for (const candidate of candidates) {
    const warnings: string[] = []
    const releaseAliasConflicts = collectAliasConflictWarnings(warnings)
    try {
      if (looksLikeStructuredPromptSchemaEcho(candidate, {
        rootKeys: ['schema_version', 'ticket_id', 'artifact', 'questions'],
      })) {
        failures.recordPromptEcho(candidate, INTERVIEW_DOCUMENT_PROMPT_ECHO_ERROR)
        continue
      }

      const parsed = unwrapInterviewArtifactObjectWrapper(unwrapExplicitWrapperRecord(parseYamlOrJsonCandidate(candidate, {
        nestedMappingChildren: INTERVIEW_DOCUMENT_NESTED_MAPPING_CHILDREN,
        allowTrailingTerminalNoise: options?.allowTrailingTerminalNoise,
        repairWarnings: warnings,
      }), [
        'interview',
        'output',
        'result',
        'data',
      ]))
      if (!isRecord(parsed)) {
        throw new Error('Interview document is not a YAML/JSON object')
      }

      const rawQuestions = getValueByAliases(parsed, ['questions'])
      if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
        throw new Error('Interview document is missing questions')
      }

      const schemaVersion = toInteger(getValueByAliases(parsed, ['schemaversion', 'schema_version'])) ?? 1
      const ticketId = toOptionalString(getValueByAliases(parsed, ['ticketid', 'ticket_id'])) ?? options?.ticketId ?? ''
      if (!ticketId) {
        throw new Error('Interview document is missing ticket_id')
      }
      if (!toOptionalString(getValueByAliases(parsed, ['ticketid', 'ticket_id'])) && options?.ticketId) {
        warnings.push('Filled missing ticket_id from runtime context.')
      }

      const artifactRaw = toOptionalString(getValueByAliases(parsed, ['artifact'])) ?? 'interview'
      if (artifactRaw !== 'interview') {
        warnings.push(`Normalized artifact "${artifactRaw}" to "interview".`)
      }

      const statusRaw = toOptionalString(getValueByAliases(parsed, ['status'])) ?? 'draft'
      const status = normalizeKey(statusRaw) === 'approved' ? 'approved' : 'draft'
      if (statusRaw !== status) {
        warnings.push(`Normalized status "${statusRaw}" to "${status}".`)
      }

      const generatedBy = normalizeGeneratedBy(getNestedRecord(parsed, ['generatedby', 'generated_by']))
      const seenQuestionIds = new Set<string>()
      const questions = rawQuestions.map((question, index) => normalizeQuestion(question, index, warnings))

      // Find max numeric ID for duplicate renumbering.
      let maxNumericId = 0
      for (const question of questions) {
        const match = question.id.match(/q?(\d+)/i)
        if (match?.[1]) maxNumericId = Math.max(maxNumericId, Number(match[1]))
      }
      let nextAvailableId = maxNumericId + 1

      for (const question of questions) {
        if (seenQuestionIds.has(question.id)) {
          const newId = `Q${String(nextAvailableId).padStart(2, '0')}`
          warnings.push(`Renumbered duplicate question id "${question.id}" to "${newId}".`)
          question.id = newId
          nextAvailableId += 1
        }
        seenQuestionIds.add(question.id)
      }

      const followUpRounds = normalizeFollowUpRounds(
        getValueByAliases(parsed, ['followuprounds', 'follow_up_rounds']),
        warnings,
        { allowMalformedFollowUpRounds: options?.allowMalformedFollowUpRounds },
      )

      const summary = getNestedRecord(parsed, ['summary'])
      const approval = getNestedRecord(parsed, ['approval'])
      const document = syncFinalFreeFormSummary({
        schema_version: schemaVersion,
        ticket_id: ticketId,
        artifact: 'interview',
        status,
        generated_by: generatedBy,
        questions,
        follow_up_rounds: followUpRounds,
        summary: {
          goals: toStringArray(getValueByAliases(summary, ['goals'])),
          constraints: toStringArray(getValueByAliases(summary, ['constraints'])),
          non_goals: toStringArray(getValueByAliases(summary, ['nongoals', 'non_goals'])),
          final_free_form_answer: getStringByAliases(summary, ['finalfreeformanswer', 'final_free_form_answer']) ?? '',
        },
        approval: {
          approved_by: toOptionalString(getValueByAliases(approval, ['approvedby', 'approved_by'])) ?? '',
          approved_at: toOptionalString(getValueByAliases(approval, ['approvedat', 'approved_at'])) ?? '',
        },
      })
      appendStructuredCandidateRecoveryWarning(warnings, rawContent, candidate)

      return {
        ok: true,
        value: document,
        normalizedContent: buildInterviewDocumentYaml(document),
        repairApplied: candidate !== rawContent.trim() || warnings.length > 0,
        repairWarnings: warnings,
      }
    } catch (error) {
      failures.recordCandidateError(candidate, error, isPromptEchoValidationError)
    } finally {
      releaseAliasConflicts()
    }
  }

  return failures.build(rawContent)
}

export function normalizeResolvedInterviewDocumentOutput(
  rawContent: string,
  options: {
    ticketId: string
    canonicalInterviewContent: string
    memberId?: string
  },
): StructuredOutputResult<InterviewDocument> {
  const canonicalResult = normalizeInterviewDocumentOutput(options.canonicalInterviewContent, {
    ticketId: options.ticketId,
  })
  if (!canonicalResult.ok) {
    return buildStructuredOutputFailure(
      options.canonicalInterviewContent,
      `Canonical interview artifact is invalid: ${canonicalResult.error}`,
      { retryDiagnostic: canonicalResult.retryDiagnostic },
    )
  }

  const candidates = collectStructuredCandidates(rawContent, {
    topLevelHints: ['schema_version', 'ticket_id', 'artifact', 'questions'],
  })
  const failures = createStructuredCandidateFailureTracker('No resolved interview document content found')

  for (const candidateContent of candidates) {
    if (looksLikeStructuredPromptSchemaEcho(candidateContent, {
      rootKeys: ['schema_version', 'ticket_id', 'artifact', 'questions'],
    })) {
      failures.recordPromptEcho(candidateContent, INTERVIEW_DOCUMENT_PROMPT_ECHO_ERROR)
      continue
    }

    let candidateResult = normalizeInterviewDocumentOutput(candidateContent, {
      ticketId: options.ticketId,
      allowTrailingTerminalNoise: true,
      allowMalformedFollowUpRounds: true,
    })
    if (!candidateResult.ok) {
      const answerOnlyCandidate = buildAnswerOnlyResolvedInterviewCandidate(candidateContent, canonicalResult.value, {
        memberId: options.memberId,
      })
      if (answerOnlyCandidate) {
        candidateResult = answerOnlyCandidate
      } else {
        failures.recordCandidateFailure(candidateResult, isPromptEchoValidationError)
        continue
      }
    }
    if (!candidateResult.ok) continue

    try {
      const repairWarnings = Array.from(new Set(candidateResult.repairWarnings))
      const canonical = canonicalResult.value
      const candidate = candidateResult.value
      const canonicalIds = canonical.questions.map((question) => question.id)
      const candidateIds = candidate.questions.map((question) => question.id)

      if (candidate.questions.length !== canonical.questions.length) {
        throw new Error(buildResolvedInterviewQuestionMismatchError(canonicalIds, candidateIds))
      }

      const candidateIdSet = new Set(candidateIds)
      const canonicalIdSet = new Set(canonicalIds)
      const missingCanonicalIds = canonicalIds.filter((id) => !candidateIdSet.has(id))
      const unexpectedIds = candidateIds.filter((id) => !canonicalIdSet.has(id))

      if (missingCanonicalIds.length > 0 || unexpectedIds.length > 0) {
        const parts: string[] = []
        if (missingCanonicalIds.length > 0) {
          parts.push(`missing canonical ids: ${missingCanonicalIds.join(', ')}`)
        }
        if (unexpectedIds.length > 0) {
          parts.push(`unexpected ids: ${unexpectedIds.join(', ')}`)
        }
        throw new Error(`Resolved interview must preserve canonical question ids (${parts.join('; ')})`)
      }

      if (candidateIds.some((id, index) => id !== canonicalIds[index])) {
        repairWarnings.push('Canonicalized question order to match the approved Interview Results artifact.')
      }

      const candidateQuestionsById = new Map(candidate.questions.map((question) => [question.id, question]))

      const questions = canonical.questions.map((canonicalQuestion) => {
        const candidateQuestion = candidateQuestionsById.get(canonicalQuestion.id)
        if (!candidateQuestion) {
          throw new Error(`Resolved interview is missing canonical question ${canonicalQuestion.id}`)
        }

        if (!compareQuestionMetadata(candidateQuestion, canonicalQuestion)) {
          repairWarnings.push(`Canonicalized metadata for canonical question ${canonicalQuestion.id}.`)
        }

        if (!canonicalQuestion.answer.skipped) {
          if (!compareQuestionAnswers(candidateQuestion.answer, canonicalQuestion.answer)) {
            repairWarnings.push(`Restored answered canonical question ${canonicalQuestion.id} from the approved Interview Results artifact.`)
          }
          return canonicalQuestion
        }

        const acceptedEmptyFinalFreeForm = isAcceptedEmptyFinalFreeFormAnswer(canonicalQuestion, candidateQuestion)
        if (candidateQuestion.answer.skipped || (!answerHasContent(candidateQuestion.answer) && !acceptedEmptyFinalFreeForm)) {
          throw new Error(`Resolved interview left skipped question unanswered: ${canonicalQuestion.id}`)
        }

        if (!candidateQuestion.answer.answered_at.trim()) {
          throw new Error(`Resolved interview is missing answered_at for AI-filled question ${canonicalQuestion.id}`)
        }

        if (candidateQuestion.answer.answered_by !== 'ai_skip') {
          repairWarnings.push(`Canonicalized answered_by to ai_skip for AI-filled question ${canonicalQuestion.id}.`)
        }
        if (acceptedEmptyFinalFreeForm) {
          repairWarnings.push(`Accepted empty final_free_form answer as an explicit no-additions response for AI-filled question ${canonicalQuestion.id}.`)
        }

        if (canonicalQuestion.answer_type === 'free_text') {
          return {
            ...canonicalQuestion,
            answer: {
              skipped: false,
              selected_option_ids: [],
              free_text: candidateQuestion.answer.free_text,
              answered_by: 'ai_skip' as const,
              answered_at: candidateQuestion.answer.answered_at,
              // The question is answered now, so there is no skip left to explain.
              // This is also where the reason stops travelling: Full Answers feeds
              // PROM10b, PROM12 and PRD coverage, none of which may see it.
              skip_reason: null,
            },
          }
        }

        const normalizedChoiceAnswer = normalizeChoiceQuestionAnswer(canonicalQuestion, candidateQuestion)
        if (candidateQuestion.answer.selected_option_ids.length === 0) {
          repairWarnings.push(`Mapped free_text to canonical option ids for AI-filled question ${canonicalQuestion.id}.`)
        } else if (normalizedChoiceAnswer.repairedSelectionIds) {
          repairWarnings.push(`Mapped selected option ids to canonical option ids for AI-filled question ${canonicalQuestion.id}.`)
        }

        return {
          ...canonicalQuestion,
          answer: {
            skipped: false,
            selected_option_ids: normalizedChoiceAnswer.selectedOptionIds,
            free_text: normalizedChoiceAnswer.freeText,
            answered_by: 'ai_skip' as const,
            answered_at: candidateQuestion.answer.answered_at,
            skip_reason: null,
          },
        }
      })

      const followUpRoundsWarning = 'Canonicalized follow_up_rounds to match the approved Interview Results artifact.'
      if (candidate.follow_up_rounds.length !== canonical.follow_up_rounds.length) {
        if (!repairWarnings.includes(followUpRoundsWarning)) {
          repairWarnings.push(followUpRoundsWarning)
        }
      } else {
        const followUpChanged = candidate.follow_up_rounds.some((round, index) => (
          round.round_number !== canonical.follow_up_rounds[index]?.round_number
          || round.source !== canonical.follow_up_rounds[index]?.source
          || !compareStringArrays(round.question_ids, canonical.follow_up_rounds[index]?.question_ids ?? [])
        ))
        if (followUpChanged && !repairWarnings.includes(followUpRoundsWarning)) {
          repairWarnings.push(followUpRoundsWarning)
        }
      }

      const approvalChanged = candidate.approval.approved_by || candidate.approval.approved_at
      if (!compareSummary(candidate.summary, canonical.summary)) {
        repairWarnings.push('Canonicalized summary to match the approved Interview Results artifact.')
      }
      if (candidate.ticket_id !== canonical.ticket_id) {
        repairWarnings.push(`Canonicalized ticket_id from "${candidate.ticket_id}" to "${canonical.ticket_id}".`)
      }
      if (candidate.status !== 'draft') {
        repairWarnings.push(`Canonicalized resolved interview status from "${candidate.status}" to "draft".`)
      }
      if (approvalChanged) {
        repairWarnings.push('Cleared approval fields for the AI-generated Full Answers artifact.')
      }
      if (options.memberId && candidate.generated_by.winner_model !== options.memberId) {
        repairWarnings.push(`Canonicalized generated_by.winner_model from "${candidate.generated_by.winner_model}" to "${options.memberId}".`)
      }

      const document = syncFinalFreeFormSummary({
        ...canonical,
        ticket_id: canonical.ticket_id,
        status: 'draft',
        generated_by: {
          ...candidate.generated_by,
          ...(options.memberId ? { winner_model: options.memberId } : {}),
          canonicalization: 'server_normalized',
        },
        questions,
        follow_up_rounds: canonical.follow_up_rounds,
        summary: canonical.summary,
        approval: {
          approved_by: '',
          approved_at: '',
        },
      })

      return {
        ok: true,
        value: document,
        normalizedContent: buildInterviewDocumentYaml(document),
        repairApplied: candidateResult.repairApplied || repairWarnings.length > 0,
        repairWarnings,
      }
    } catch (error) {
      failures.recordCandidateError(candidateContent, error, isPromptEchoValidationError)
    }
  }

  return failures.build(rawContent)
}

export function toDraftInterviewDocument(document: InterviewDocument): InterviewDocument {
  return {
    ...document,
    status: 'draft',
    approval: {
      approved_by: '',
      approved_at: '',
    },
  }
}

export function updateInterviewDocumentAnswers(
  document: InterviewDocument,
  updates: InterviewAnswerUpdate[],
  answeredAt: string,
): InterviewDocument {
  const updatesById = new Map(updates.map((update) => [update.id, update]))

  const next = syncFinalFreeFormSummary({
    ...toDraftInterviewDocument(document),
    questions: document.questions.map((question) => {
      const update = updatesById.get(question.id)
      if (!update) return question

      let selectedOptionIds = Array.from(new Set(update.answer.selected_option_ids))
      if (question.answer_type === 'free_text') {
        selectedOptionIds = []
      } else if (question.answer_type === 'single_choice' && selectedOptionIds.length > 1) {
        selectedOptionIds = selectedOptionIds.slice(0, 1)
      }

      const freeText = update.answer.free_text
      const skipped = update.answer.skipped || (freeText.trim().length === 0 && selectedOptionIds.length === 0)

      // The reason has to survive the round trip, or the approval editor would
      // silently discard whatever was just typed. Omitting the field means
      // "leave it alone"; an explicit null clears it.
      const skipReason = skipped
        ? (update.answer.skip_reason === undefined
          ? question.answer.skip_reason
          : normalizeSkipReason(update.answer.skip_reason))
        : null

      // An edit that skips an answer is a person skipping it. An answer that was
      // *already* skipped keeps whoever it was attributed to: re-saving the
      // document unchanged must not rewrite history into a decision nobody made.
      //
      // The exception is a reason. Only a `user_skip` may carry one, so writing
      // a reason onto an `ai_skip` placeholder would store a field the next load
      // strips straight back out. Supplying a reason *is* claiming the skip.
      const claimsSkipByReason = skipped
        && skipReason !== null
        && question.answer.answered_by !== 'user_skip'
      const answeredBy = skipped
        ? (question.answer.skipped && !claimsSkipByReason ? question.answer.answered_by : 'user_skip')
        : 'user'
      const unchangedSkip = skipped && question.answer.skipped && !claimsSkipByReason

      return {
        ...question,
        answer: {
          skipped,
          selected_option_ids: skipped ? [] : selectedOptionIds,
          free_text: skipped ? '' : freeText,
          answered_by: answeredBy,
          answered_at: unchangedSkip ? question.answer.answered_at : answeredAt,
          skip_reason: skipReason,
        },
      }
    }),
  })

  return syncFinalFreeFormSummary(next)
}

export function buildApprovedInterviewDocument(
  document: InterviewDocument,
  approvedAt: string,
): InterviewDocument {
  return {
    ...document,
    status: 'approved',
    approval: {
      approved_by: 'user',
      approved_at: approvedAt,
    },
  }
}
