import { parseInterviewQuestions, type ParsedInterviewQuestion } from '../phases/interview/questions'
import type {
  InterviewQuestionChangeAttributionStatus,
  InterviewQuestionChangeType,
  InterviewQuestionPreview,
} from '@shared/interviewQuestions'
import { MAX_SINGLE_CHOICE_OPTIONS, MAX_MULTIPLE_CHOICE_OPTIONS } from '../lib/constants'
import { looksLikePromptEcho } from '../lib/promptEcho'
import type {
  InterviewBatchPayload,
  InterviewBatchPayloadQuestion,
  InterviewTurnOutput,
  CoverageFollowUpQuestion,
  CoverageResultEnvelope,
  StructuredOutputResult,
} from './types'
import {
  collectAliasConflictWarnings,
  isRecord,
  normalizeKey,
  collectStructuredCandidates,
  collectTaggedCandidates,
  appendStructuredCandidateRecoveryWarning,
  appendWrapperKeyRepairWarning,
  findMaybeUnwrappedWrapperPath,
  parseYamlOrJsonCandidate,
  repairCoverageGapStringList,
  maybeUnwrapRecord,
  shouldRecordStructuredCandidateRecovery,
  unwrapExplicitWrapperRecord,
  toStringArray,
  toOptionalString,
  toInteger,
  toBoolean,
  getValueByAliases,
  getStringByAliases,
  getNestedRecord,
  getRequiredString,
  buildYamlDocument,
} from './yamlUtils'
import { MAX_INTERVIEW_BATCH_SIZE } from '../lib/constants'
import { resolveLosingDraftReference } from './refinementChanges'
import { buildStructuredOutputFailure } from './failure'
import { getErrorMessage } from '@shared/typeGuards'

const INTERVIEW_ID_PREFIX = 'Q'
const INTERVIEW_ID_PAD_WIDTH = 2
const INTERVIEW_ID_PATTERN = /q?(\d+)/i
const INTERVIEW_QUESTION_KEY_SEPARATOR = '\u241f'
const PHASE_ORDER = new Map([
  ['foundation', 0],
  ['structure', 1],
  ['assembly', 2],
])

const INTERVIEW_TURN_NESTED_MAPPING_CHILDREN = {
  generated_by: ['winner_model', 'generated_at', 'canonicalization'],
  summary: ['goals', 'constraints', 'non_goals', 'final_free_form_answer'],
  approval: ['approved_by', 'approved_at'],
  progress: ['current', 'total'],
} as const

interface NormalizedInterviewQuestion {
  id: string
  phase: 'foundation' | 'structure' | 'assembly'
  question: string
}

interface NormalizedInspirationSource {
  draftIndex: number
  memberId: string
  question: InterviewQuestionPreview
}

interface NormalizedInterviewRefinementChange {
  type: InterviewQuestionChangeType
  before: NormalizedInterviewQuestion | null
  after: NormalizedInterviewQuestion | null
  inspiration: NormalizedInspirationSource | null
  attributionStatus: InterviewQuestionChangeAttributionStatus
}

interface ParsedInterviewRefinementChangeCandidate {
  type: InterviewQuestionChangeType
  before: NormalizedInterviewQuestion | null | undefined
  after: NormalizedInterviewQuestion | null | undefined
  inspiration: NormalizedInspirationSource | null | undefined
  attributionStatus: InterviewQuestionChangeAttributionStatus
  sourceIndex: number
}

function normalizeInterviewPhase(value: string): 'foundation' | 'structure' | 'assembly' {
  const normalized = normalizeKey(value)
  if (normalized === 'foundation') return 'foundation'
  if (normalized === 'structure') return 'structure'
  if (normalized === 'assembly') return 'assembly'
  throw new Error(`Unknown question phase: ${value}`)
}

function normalizeInterviewId(rawId: string): string {
  const match = rawId.trim().match(INTERVIEW_ID_PATTERN)
  if (!match?.[1]) return rawId.trim()
  return `${INTERVIEW_ID_PREFIX}${match[1].padStart(INTERVIEW_ID_PAD_WIDTH, '0')}`
}

function buildInterviewQuestionKey(question: NormalizedInterviewQuestion): string {
  return `${question.id}${INTERVIEW_QUESTION_KEY_SEPARATOR}${question.phase}${INTERVIEW_QUESTION_KEY_SEPARATOR}${question.question}`
}

function buildInterviewQuestionIdentityKey(question: NormalizedInterviewQuestion): string {
  return `${question.id}${INTERVIEW_QUESTION_KEY_SEPARATOR}${question.phase}`
}

function buildInterviewQuestionLookup(questions: NormalizedInterviewQuestion[]) {
  const byFullKey = new Map<string, NormalizedInterviewQuestion>()
  const byIdentityKey = new Map<string, NormalizedInterviewQuestion[]>()

  for (const question of questions) {
    byFullKey.set(buildInterviewQuestionKey(question), question)
    const identityKey = buildInterviewQuestionIdentityKey(question)
    const matches = byIdentityKey.get(identityKey) ?? []
    matches.push(question)
    byIdentityKey.set(identityKey, matches)
  }

  return { byFullKey, byIdentityKey }
}

function sortInterviewQuestionsStable(
  questions: NormalizedInterviewQuestion[],
): NormalizedInterviewQuestion[] {
  return questions
    .map((question, index) => ({ question, index }))
    .sort((left, right) => {
      const orderDiff = (PHASE_ORDER.get(left.question.phase) ?? 0) - (PHASE_ORDER.get(right.question.phase) ?? 0)
      return orderDiff !== 0 ? orderDiff : left.index - right.index
    })
    .map(({ question }) => question)
}

function normalizeParsedInterviewQuestionList(
  parsed: ParsedInterviewQuestion[],
  maxInitialQuestions: number,
): {
  questions: NormalizedInterviewQuestion[]
  reordered: boolean
  repairApplied: boolean
  repairWarnings: string[]
} {
  const repairWarnings: string[] = []
  let repairApplied = false

  // Find the maximum numeric ID across all questions so duplicates can be
  // renumbered above the current ceiling instead of throwing.
  let maxNumericId = 0
  for (const question of parsed) {
    const match = question.id.trim().match(INTERVIEW_ID_PATTERN)
    if (match?.[1]) {
      maxNumericId = Math.max(maxNumericId, Number(match[1]))
    }
  }
  let nextAvailableId = maxNumericId + 1

  const seenIds = new Set<string>()
  const normalized = parsed.map((question, index) => {
    let id = normalizeInterviewId(question.id)
    const phase = normalizeInterviewPhase(question.phase)
    const text = question.question.trim()
    if (!text) throw new Error(`Empty question text at index ${index}`)

    if (seenIds.has(id)) {
      const newId = `${INTERVIEW_ID_PREFIX}${String(nextAvailableId).padStart(INTERVIEW_ID_PAD_WIDTH, '0')}`
      repairWarnings.push(`Renumbered duplicate question id ${id} at index ${index} to ${newId}.`)
      id = newId
      nextAvailableId += 1
      repairApplied = true
    }
    seenIds.add(id)
    return { id, phase, question: text, originalIndex: index }
  })

  if (maxInitialQuestions > 0 && normalized.length > maxInitialQuestions) {
    throw new Error(`Question count ${normalized.length} exceeds max_initial_questions=${maxInitialQuestions}`)
  }

  const sorted = [...normalized].sort((left, right) => {
    const orderDiff = (PHASE_ORDER.get(left.phase) ?? 0) - (PHASE_ORDER.get(right.phase) ?? 0)
    return orderDiff !== 0 ? orderDiff : left.originalIndex - right.originalIndex
  })

  return {
    questions: sorted.map(({ originalIndex: _originalIndex, ...question }) => question),
    reordered: sorted.some((question, index) => question !== normalized[index]),
    repairApplied,
    repairWarnings,
  }
}

function normalizeStructuredInterviewQuestionList(
  rawQuestions: unknown[],
  maxInitialQuestions: number,
): {
  questions: NormalizedInterviewQuestion[]
  questionCount: number
  reordered: boolean
  repairApplied: boolean
  repairWarnings: string[]
} {
  const parsed = parseInterviewQuestions(buildYamlDocument({ questions: rawQuestions }))
  const normalized = normalizeParsedInterviewQuestionList(parsed, maxInitialQuestions)
  return {
    questions: normalized.questions,
    questionCount: normalized.questions.length,
    reordered: normalized.reordered,
    repairApplied: normalized.repairApplied,
    repairWarnings: normalized.repairWarnings,
  }
}

function normalizeInterviewChangeType(value: unknown, index: number): InterviewQuestionChangeType {
  const raw = toOptionalString(value)
  if (!raw) throw new Error(`Interview refinement change at index ${index} is missing type`)

  const normalized = normalizeKey(raw)
  if (normalized === 'modified') return 'modified'
  if (normalized === 'replaced') return 'replaced'
  if (normalized === 'added') return 'added'
  if (normalized === 'removed') return 'removed'

  throw new Error(`Interview refinement change at index ${index} has unknown type: ${raw}`)
}

function normalizeInterviewChangeQuestion(value: unknown, label: string): NormalizedInterviewQuestion {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`)
  }

  const id = normalizeInterviewId(getRequiredString(value, ['id'], `${label} id`))
  const phase = normalizeInterviewPhase(getRequiredString(value, ['phase', 'category', 'stage', 'section'], `${label} phase`))
  const question = getRequiredString(value, ['question', 'prompt', 'text', 'content'], `${label} question`).trim()

  if (!question) {
    throw new Error(`${label} question must not be empty`)
  }

  return { id, phase, question }
}

function normalizeInterviewInspirationQuestion(value: unknown, label: string): InterviewQuestionPreview {
  if (typeof value === 'string') {
    const question = value.trim()
    if (!question) {
      throw new Error(`${label} question must not be empty`)
    }
    return { question }
  }

  if (!isRecord(value)) {
    throw new Error(`${label} must be an object or string`)
  }

  const question = getRequiredString(value, ['question', 'prompt', 'text', 'content'], `${label} question`).trim()
  if (!question) {
    throw new Error(`${label} question must not be empty`)
  }

  const id = toOptionalString(getValueByAliases(value, ['id']))
  const rawPhase = toOptionalString(getValueByAliases(value, ['phase', 'category', 'stage', 'section']))
  let phase: NormalizedInterviewQuestion['phase'] | undefined
  if (rawPhase) {
    try {
      phase = normalizeInterviewPhase(rawPhase)
    } catch {
      phase = undefined
    }
  }

  return {
    ...(id ? { id: normalizeInterviewId(id) } : {}),
    ...(phase ? { phase } : {}),
    question,
  }
}

function normalizeInterviewQuestionMatchText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function hydrateInterviewInspirationQuestion(
  question: InterviewQuestionPreview,
  draftQuestions: NormalizedInterviewQuestion[],
): InterviewQuestionPreview {
  const questionText = normalizeInterviewQuestionMatchText(question.question)
  if (!questionText) return question

  const normalizedId = question.id ? normalizeInterviewId(question.id) : undefined
  let normalizedPhase: NormalizedInterviewQuestion['phase'] | undefined
  if (question.phase) {
    try {
      normalizedPhase = normalizeInterviewPhase(question.phase)
    } catch {
      normalizedPhase = undefined
    }
  }

  const matches = draftQuestions.filter((candidate) => {
    if (normalizeInterviewQuestionMatchText(candidate.question) !== questionText) return false
    if (normalizedId && candidate.id !== normalizedId) return false
    if (normalizedPhase && candidate.phase !== normalizedPhase) return false
    return true
  })

  if (matches.length === 1) {
    return matches[0]!
  }

  if (normalizedId || normalizedPhase) {
    const metadataMatches = draftQuestions.filter((candidate) => {
      if (normalizedId && candidate.id !== normalizedId) return false
      if (normalizedPhase && candidate.phase !== normalizedPhase) return false
      return true
    })
    if (metadataMatches.length === 1) {
      return metadataMatches[0]!
    }
  }

  return question
}

function parseInterviewRefinementChangeEntry(
  value: unknown,
  index: number,
  losingDraftMeta?: Array<{ memberId: string }>,
): ParsedInterviewRefinementChangeCandidate {
  if (!isRecord(value)) {
    throw new Error(`Interview refinement change at index ${index} is not an object`)
  }

  const type = normalizeInterviewChangeType(getValueByAliases(value, ['type', 'change_type', 'changetype']), index)
  const hasBefore = Object.keys(value).some((key) => normalizeKey(key) === 'before')
  const hasAfter = Object.keys(value).some((key) => normalizeKey(key) === 'after')

  const rawBefore = hasBefore ? getValueByAliases(value, ['before']) : undefined
  const rawAfter = hasAfter ? getValueByAliases(value, ['after']) : undefined
  const before = !hasBefore
    ? undefined
    : rawBefore === null
      ? null
      : normalizeInterviewChangeQuestion(rawBefore, `Interview refinement change.before at index ${index}`)
  const after = !hasAfter
    ? undefined
    : rawAfter === null
      ? null
      : normalizeInterviewChangeQuestion(rawAfter, `Interview refinement change.after at index ${index}`)

  // Parse optional inspiration (soft-repair: malformed → null)
  let inspiration: NormalizedInspirationSource | null | undefined = undefined
  let attributionStatus: InterviewQuestionChangeAttributionStatus = 'model_unattributed'
  const rawInspiration = getValueByAliases(value, ['inspiration', 'inspired_by', 'source_inspiration'])
  if (rawInspiration === null) {
    inspiration = null
  } else if (rawInspiration === undefined) {
    inspiration = undefined
  } else if (isRecord(rawInspiration)) {
    try {
      // The memberId is hydrated later, from losingDraftMeta, once the change
      // list has been canonicalised; only the index matters here.
      const { draftIndex } = resolveLosingDraftReference(rawInspiration, losingDraftMeta)

      const rawInspirationQuestion = getValueByAliases(rawInspiration, ['question', 'item'])
      if (draftIndex >= 0 && rawInspirationQuestion !== undefined) {
        const question = normalizeInterviewInspirationQuestion(
          rawInspirationQuestion,
          `Interview refinement change.inspiration.question at index ${index}`,
        )
        inspiration = { draftIndex, memberId: '', question }
        attributionStatus = 'inspired'
      } else {
        inspiration = null
        attributionStatus = 'invalid_unattributed'
      }
    } catch {
      inspiration = null
      attributionStatus = 'invalid_unattributed'
    }
  } else {
    inspiration = null
    attributionStatus = 'invalid_unattributed'
  }

  if (type === 'modified' || type === 'replaced') {
    if (!hasBefore && !hasAfter) {
      throw new Error(`Interview refinement change at index ${index} is missing before and after`)
    }
    if (hasBefore && before === null) {
      throw new Error(`Interview refinement change at index ${index} must use a populated before for type ${type}`)
    }
    if (hasAfter && after === null) {
      throw new Error(`Interview refinement change at index ${index} must use a populated after for type ${type}`)
    }
    return { type, before, after, inspiration, attributionStatus, sourceIndex: index }
  }

  if (!hasBefore) throw new Error(`Interview refinement change at index ${index} is missing before`)
  if (!hasAfter) throw new Error(`Interview refinement change at index ${index} is missing after`)
  if (type === 'added' && (before !== null || !after)) {
    throw new Error(`Interview refinement change at index ${index} with type added must use before: null and a populated after`)
  }
  if (type === 'removed' && (!before || rawAfter !== null)) {
    throw new Error(`Interview refinement change at index ${index} with type removed must use after: null and a populated before`)
  }

  return {
    type,
    before,
    after,
    inspiration: type === 'removed' ? null : inspiration,
    attributionStatus,
    sourceIndex: index,
  }
}

function resolveCanonicalInterviewQuestion(
  question: NormalizedInterviewQuestion,
  lookup: ReturnType<typeof buildInterviewQuestionLookup>,
): {
  question: NormalizedInterviewQuestion
  repaired: boolean
} {
  const fullKey = buildInterviewQuestionKey(question)
  const canonicalByFullKey = lookup.byFullKey.get(fullKey)
  if (canonicalByFullKey) {
    return { question: canonicalByFullKey, repaired: false }
  }

  const identityKey = buildInterviewQuestionIdentityKey(question)
  const canonicalByIdentity = lookup.byIdentityKey.get(identityKey)
  if (canonicalByIdentity?.length === 1) {
    return {
      question: canonicalByIdentity[0]!,
      repaired: true,
    }
  }

  return { question, repaired: false }
}

function canonicalizeInterviewRefinementChanges(
  changes: ParsedInterviewRefinementChangeCandidate[],
  winnerQuestions: NormalizedInterviewQuestion[],
  finalQuestions: NormalizedInterviewQuestion[],
): {
  changes: ParsedInterviewRefinementChangeCandidate[]
  repairApplied: boolean
  repairWarnings: string[]
} {
  const winnerLookup = buildInterviewQuestionLookup(winnerQuestions)
  const finalLookup = buildInterviewQuestionLookup(finalQuestions)
  const normalizedChanges: ParsedInterviewRefinementChangeCandidate[] = []
  const repairWarnings: string[] = []
  let repairApplied = false

  for (const change of changes) {
    let before = change.before
    let after = change.after

    if (before) {
      const resolved = resolveCanonicalInterviewQuestion(before, winnerLookup)
      if (resolved.repaired) {
        before = resolved.question
        repairApplied = true
        repairWarnings.push(`Canonicalized interview refinement change.before at index ${change.sourceIndex} to the winning draft record for ${before.id}.`)
      }
    }

    if (after) {
      const resolved = resolveCanonicalInterviewQuestion(after, finalLookup)
      if (resolved.repaired) {
        after = resolved.question
        repairApplied = true
        repairWarnings.push(`Canonicalized interview refinement change.after at index ${change.sourceIndex} to the refined final record for ${after.id}.`)
      }
    }

    if (
      (change.type === 'modified' || change.type === 'replaced')
      && before
      && after
      && buildInterviewQuestionKey(before) === buildInterviewQuestionKey(after)
      && winnerLookup.byFullKey.has(buildInterviewQuestionKey(before))
      && finalLookup.byFullKey.has(buildInterviewQuestionKey(after))
    ) {
      repairApplied = true
      repairWarnings.push(`Dropped no-op interview refinement ${change.type} at index ${change.sourceIndex} because the question is unchanged across the winning and final drafts.`)
      continue
    }

    normalizedChanges.push({
      type: change.type,
      before,
      after,
      inspiration: change.inspiration,
      attributionStatus: change.attributionStatus,
      sourceIndex: change.sourceIndex,
    })
  }

  // Repair added → replaced where the model reused a winner-draft question ID
  // but declared the change as "added" instead of "replaced"
  const accountedWinnerIds = new Set(
    normalizedChanges.flatMap(c => c.before ? [c.before.id] : []),
  )
  const winnerById = new Map(
    winnerQuestions
      .filter(q => !accountedWinnerIds.has(q.id))
      .map(q => [q.id, q] as const),
  )
  for (const [i, change] of normalizedChanges.entries()) {
    if (change.type === 'added' && change.before === null && change.after) {
      const orphanedWinner = winnerById.get(change.after.id)
      if (orphanedWinner && buildInterviewQuestionKey(orphanedWinner) !== buildInterviewQuestionKey(change.after)) {
        normalizedChanges[i] = {
          type: 'replaced',
          before: orphanedWinner,
          after: change.after,
          inspiration: change.inspiration,
          attributionStatus: change.attributionStatus,
          sourceIndex: change.sourceIndex,
        }
        winnerById.delete(change.after.id)
        repairApplied = true
        repairWarnings.push(
          `Converted interview refinement change at index ${change.sourceIndex} from "added" to "replaced" because ${change.after.id} already existed in the winning draft with different content.`,
        )
      }
    }
  }

  return {
    changes: normalizedChanges,
    repairApplied,
    repairWarnings,
  }
}

function repairStaleInterviewRefinedQuestionsFromChanges(
  finalQuestions: NormalizedInterviewQuestion[],
  changes: ParsedInterviewRefinementChangeCandidate[],
): {
  questions: NormalizedInterviewQuestion[]
  repairApplied: boolean
  repairWarnings: string[]
} {
  const repairedQuestions = [...finalQuestions]
  const repairWarnings: string[] = []
  let repairApplied = false

  const findIndexByFullKey = (question: NormalizedInterviewQuestion) => repairedQuestions.findIndex(
    (candidate) => buildInterviewQuestionKey(candidate) === buildInterviewQuestionKey(question),
  )
  const findIndexByIdentity = (question: NormalizedInterviewQuestion) => repairedQuestions.findIndex(
    (candidate) => buildInterviewQuestionIdentityKey(candidate) === buildInterviewQuestionIdentityKey(question),
  )

  for (const change of changes) {
    if ((change.type !== 'modified' && change.type !== 'replaced') || !change.before || !change.after) continue
    if (findIndexByFullKey(change.after) !== -1) continue

    const beforeIndex = findIndexByFullKey(change.before)
    if (beforeIndex === -1) continue

    repairedQuestions[beforeIndex] = change.after
    repairApplied = true
    repairWarnings.push(
      `Updated the refined interview questions from ${change.type} change at index ${change.sourceIndex} for ${change.after.id} because the top-level questions list still contained the pre-change record.`,
    )
  }

  for (const change of changes) {
    if (change.type !== 'added' || change.before !== null || !change.after) continue
    if (findIndexByFullKey(change.after) !== -1) continue

    const identityIndex = findIndexByIdentity(change.after)
    if (identityIndex === -1) continue

    repairedQuestions[identityIndex] = change.after
    repairApplied = true
    repairWarnings.push(
      `Updated the refined interview questions from added change at index ${change.sourceIndex} for ${change.after.id} because the top-level questions list still contained the winner-draft record with the same id and phase.`,
    )
  }

  for (const change of changes) {
    if (change.type !== 'removed' || !change.before || change.after !== null) continue

    const beforeIndex = findIndexByFullKey(change.before)
    if (beforeIndex === -1) continue

    repairedQuestions.splice(beforeIndex, 1)
    repairApplied = true
    repairWarnings.push(
      `Removed stale top-level refined interview question ${change.before.id} using removed change at index ${change.sourceIndex}.`,
    )
  }

  const sortedQuestions = sortInterviewQuestionsStable(repairedQuestions)
  if (repairApplied && sortedQuestions.some((question, index) => question !== repairedQuestions[index])) {
    repairWarnings.push('Applied stable interview phase reordering after repairing the refined question list from declared changes.')
  }

  return {
    questions: sortedQuestions,
    repairApplied,
    repairWarnings,
  }
}

function isCompleteInterviewRefinementChangeCandidate(
  change: ParsedInterviewRefinementChangeCandidate,
): boolean {
  if (change.type === 'modified' || change.type === 'replaced') {
    return Boolean(change.before && change.after)
  }
  if (change.type === 'added') {
    return change.before === null && Boolean(change.after)
  }
  if (change.type === 'removed') {
    return Boolean(change.before) && change.after === null
  }
  return false
}

function normalizeCompleteInterviewRefinementChangeCandidate(
  change: ParsedInterviewRefinementChangeCandidate,
): NormalizedInterviewRefinementChange {
  const inspiration = change.inspiration ?? null
  const attributionStatus: InterviewQuestionChangeAttributionStatus = inspiration
    ? 'inspired'
    : change.attributionStatus

  if (change.type === 'modified' || change.type === 'replaced') {
    if (!change.before || !change.after) {
      const missingSide = !change.before ? 'before' : 'after'
      throw new Error(`Interview refinement change at index ${change.sourceIndex} is missing ${missingSide} and no unique safe repair candidate was found`)
    }
    return {
      type: change.type,
      before: change.before,
      after: change.after,
      inspiration,
      attributionStatus,
    }
  }

  if (change.type === 'added') {
    if (change.before !== null || !change.after) {
      throw new Error(`Interview refinement change at index ${change.sourceIndex} with type added is incomplete`)
    }
    return {
      type: change.type,
      before: null,
      after: change.after,
      inspiration,
      attributionStatus,
    }
  }

  if (!change.before || change.after !== null) {
    throw new Error(`Interview refinement change at index ${change.sourceIndex} with type removed is incomplete`)
  }
  return {
    type: change.type,
    before: change.before,
    after: null,
    inspiration: null,
    attributionStatus,
  }
}

function synthesizeOmittedSameIdentityInterviewRefinementChanges(
  changes: ParsedInterviewRefinementChangeCandidate[],
  winnerQuestions: NormalizedInterviewQuestion[],
  finalQuestions: NormalizedInterviewQuestion[],
): {
  changes: ParsedInterviewRefinementChangeCandidate[]
  synthesizedChanges: ParsedInterviewRefinementChangeCandidate[]
  repairApplied: boolean
  repairWarnings: string[]
} {
  const usedBeforeKeys = new Set<string>()
  const usedAfterKeys = new Set<string>()
  for (const change of changes) {
    if (!isCompleteInterviewRefinementChangeCandidate(change)) continue
    if (change.before) usedBeforeKeys.add(buildInterviewQuestionKey(change.before))
    if (change.after) usedAfterKeys.add(buildInterviewQuestionKey(change.after))
  }

  const winnerLookup = buildInterviewQuestionLookup(winnerQuestions)
  const finalLookup = buildInterviewQuestionLookup(finalQuestions)
  const synthesizedChanges: ParsedInterviewRefinementChangeCandidate[] = []
  const repairWarnings: string[] = []

  for (const winnerQuestion of winnerQuestions) {
    const identityKey = buildInterviewQuestionIdentityKey(winnerQuestion)
    const finalMatches = finalLookup.byIdentityKey.get(identityKey)
    if (finalMatches?.length !== 1) continue

    const finalQuestion = finalMatches[0]!
    const beforeKey = buildInterviewQuestionKey(winnerQuestion)
    const afterKey = buildInterviewQuestionKey(finalQuestion)

    if (beforeKey === afterKey) continue
    if (!winnerLookup.byFullKey.has(beforeKey) || !finalLookup.byFullKey.has(afterKey)) continue
    if (usedBeforeKeys.has(beforeKey) || usedAfterKeys.has(afterKey)) continue

    synthesizedChanges.push({
      type: 'modified',
      before: winnerQuestion,
      after: finalQuestion,
      inspiration: null,
      attributionStatus: 'synthesized_unattributed',
      sourceIndex: -1,
    })
    usedBeforeKeys.add(beforeKey)
    usedAfterKeys.add(afterKey)
    repairWarnings.push(
      `Synthesized omitted interview refinement modified change for ${winnerQuestion.id} by matching id and phase across the winning and final drafts.`,
    )
  }

  return {
    changes: [...changes, ...synthesizedChanges],
    synthesizedChanges,
    repairApplied: synthesizedChanges.length > 0,
    repairWarnings,
  }
}

function dropRedundantPartialInterviewRefinementChanges(
  changes: ParsedInterviewRefinementChangeCandidate[],
  synthesizedChanges: ParsedInterviewRefinementChangeCandidate[],
): {
  changes: ParsedInterviewRefinementChangeCandidate[]
  repairApplied: boolean
  repairWarnings: string[]
} {
  if (synthesizedChanges.length === 0) {
    return {
      changes,
      repairApplied: false,
      repairWarnings: [],
    }
  }

  const synthesizedBeforeKeys = new Set(
    synthesizedChanges
      .map((change) => change.before)
      .filter((question): question is NormalizedInterviewQuestion => Boolean(question))
      .map(buildInterviewQuestionKey),
  )
  const synthesizedAfterKeys = new Set(
    synthesizedChanges
      .map((change) => change.after)
      .filter((question): question is NormalizedInterviewQuestion => Boolean(question))
      .map(buildInterviewQuestionKey),
  )

  const normalizedChanges: ParsedInterviewRefinementChangeCandidate[] = []
  const repairWarnings: string[] = []
  let repairApplied = false

  for (const change of changes) {
    if (isCompleteInterviewRefinementChangeCandidate(change)) {
      normalizedChanges.push(change)
      continue
    }

    const beforeKey = change.before ? buildInterviewQuestionKey(change.before) : null
    const afterKey = change.after ? buildInterviewQuestionKey(change.after) : null
    if (
      (beforeKey && synthesizedBeforeKeys.has(beforeKey))
      || (afterKey && synthesizedAfterKeys.has(afterKey))
    ) {
      repairApplied = true
      const questionId = change.before?.id ?? change.after?.id ?? 'unknown question'
      repairWarnings.push(
        `Dropped partial interview refinement change at index ${change.sourceIndex} because a canonical same-identity modified change for ${questionId} was synthesized from the winner/final question lists.`,
      )
      continue
    }

    normalizedChanges.push(change)
  }

  return {
    changes: normalizedChanges,
    repairApplied,
    repairWarnings,
  }
}

function repairPartialInterviewRefinementChanges(
  changes: ParsedInterviewRefinementChangeCandidate[],
  winnerQuestions: NormalizedInterviewQuestion[],
  finalQuestions: NormalizedInterviewQuestion[],
): {
  changes: ParsedInterviewRefinementChangeCandidate[]
  repairApplied: boolean
  repairWarnings: string[]
} {
  const winnerLookup = buildInterviewQuestionLookup(winnerQuestions)
  const finalLookup = buildInterviewQuestionLookup(finalQuestions)
  const usedBeforeKeys = new Set<string>()
  const usedAfterKeys = new Set<string>()
  for (const change of changes) {
    if (!isCompleteInterviewRefinementChangeCandidate(change)) continue
    if (change.before) usedBeforeKeys.add(buildInterviewQuestionKey(change.before))
    if (change.after) usedAfterKeys.add(buildInterviewQuestionKey(change.after))
  }

  const normalizedChanges: ParsedInterviewRefinementChangeCandidate[] = []
  const repairWarnings: string[] = []
  let repairApplied = false

  for (const change of changes) {
    if (isCompleteInterviewRefinementChangeCandidate(change) || (change.type !== 'modified' && change.type !== 'replaced')) {
      normalizedChanges.push(change)
      continue
    }

    let repairedChange = change
    if (change.before && change.after === undefined) {
      const identityKey = buildInterviewQuestionIdentityKey(change.before)
      const finalMatches = finalLookup.byIdentityKey.get(identityKey)
      if (finalMatches?.length === 1) {
        const candidate = finalMatches[0]!
        const beforeKey = buildInterviewQuestionKey(change.before)
        const afterKey = buildInterviewQuestionKey(candidate)
        if (beforeKey !== afterKey && !usedBeforeKeys.has(beforeKey) && !usedAfterKeys.has(afterKey)) {
          repairedChange = { ...change, after: candidate }
          usedBeforeKeys.add(beforeKey)
          usedAfterKeys.add(afterKey)
          repairApplied = true
          repairWarnings.push(
            `Inferred missing interview refinement change.after at index ${change.sourceIndex} from refined final question ${candidate.id} by matching id and phase.`,
          )
        }
      }
    } else if (change.after && change.before === undefined) {
      const identityKey = buildInterviewQuestionIdentityKey(change.after)
      const winnerMatches = winnerLookup.byIdentityKey.get(identityKey)
      if (winnerMatches?.length === 1) {
        const candidate = winnerMatches[0]!
        const beforeKey = buildInterviewQuestionKey(candidate)
        const afterKey = buildInterviewQuestionKey(change.after)
        if (beforeKey !== afterKey && !usedBeforeKeys.has(beforeKey) && !usedAfterKeys.has(afterKey)) {
          repairedChange = { ...change, before: candidate }
          usedBeforeKeys.add(beforeKey)
          usedAfterKeys.add(afterKey)
          repairApplied = true
          repairWarnings.push(
            `Inferred missing interview refinement change.before at index ${change.sourceIndex} from winning-draft question ${candidate.id} by matching id and phase.`,
          )
        }
      }
    }

    normalizedChanges.push(repairedChange)
  }

  return {
    changes: normalizedChanges,
    repairApplied,
    repairWarnings,
  }
}

function assertNoPartialInterviewRefinementChanges(
  changes: ParsedInterviewRefinementChangeCandidate[],
) {
  for (const change of changes) {
    if (isCompleteInterviewRefinementChangeCandidate(change)) continue
    if (change.type === 'modified' || change.type === 'replaced') {
      const missingSide = change.before === undefined ? 'before' : 'after'
      throw new Error(`Interview refinement change at index ${change.sourceIndex} is missing ${missingSide} and no unique safe repair candidate was found`)
    }
    throw new Error(`Interview refinement change at index ${change.sourceIndex} remains incomplete after repair`)
  }
}

function validateInterviewRefinementChangeEntry(
  change: NormalizedInterviewRefinementChange,
  index: number,
  winnerKeySet: Set<string>,
  finalKeySet: Set<string>,
  usedBeforeKeys: Set<string>,
  usedAfterKeys: Set<string>,
): NormalizedInterviewRefinementChange {
  const before = change.before
  const after = change.after

  if (before && after && buildInterviewQuestionKey(before) === buildInterviewQuestionKey(after)) {
    throw new Error(`Interview refinement change at index ${index} cannot use identical before and after question records`)
  }

  if (before) {
    const beforeKey = buildInterviewQuestionKey(before)
    if (!winnerKeySet.has(beforeKey)) {
      throw new Error(`Interview refinement change.before at index ${index} does not match any question from the winning draft`)
    }
    if (usedBeforeKeys.has(beforeKey)) {
      throw new Error(`Interview refinement change.before at index ${index} reuses a winning-draft question already referenced by another change`)
    }
    usedBeforeKeys.add(beforeKey)
  }

  if (after) {
    const afterKey = buildInterviewQuestionKey(after)
    if (!finalKeySet.has(afterKey)) {
      throw new Error(`Interview refinement change.after at index ${index} does not match any question from the refined final list`)
    }
    if (usedAfterKeys.has(afterKey)) {
      throw new Error(`Interview refinement change.after at index ${index} reuses a refined question already referenced by another change`)
    }
    usedAfterKeys.add(afterKey)
  }

  return change
}

export const INTERVIEW_MISSING_CHANGES_WARNING = 'Interview refinement returned no changes list while the questions differed from the winning draft; accounted for the difference from the two drafts.'

function interviewQuestionListsDiffer(
  winnerQuestions: NormalizedInterviewQuestion[],
  finalQuestions: NormalizedInterviewQuestion[],
): boolean {
  const winnerKeys = new Set(winnerQuestions.map(buildInterviewQuestionKey))
  const finalKeys = new Set(finalQuestions.map(buildInterviewQuestionKey))
  return winnerKeys.size !== finalKeys.size || [...finalKeys].some((key) => !winnerKeys.has(key))
}

function ensureQuestionChangeCoverage(
  winnerQuestions: NormalizedInterviewQuestion[],
  finalQuestions: NormalizedInterviewQuestion[],
  usedBeforeKeys: Set<string>,
  usedAfterKeys: Set<string>,
) {
  const winnerKeySet = new Set(winnerQuestions.map(buildInterviewQuestionKey))
  const finalKeySet = new Set(finalQuestions.map(buildInterviewQuestionKey))
  const expectedBeforeKeys = [...winnerKeySet].filter((key) => !finalKeySet.has(key))
  const expectedAfterKeys = [...finalKeySet].filter((key) => !winnerKeySet.has(key))

  const missingBefore = expectedBeforeKeys.filter((key) => !usedBeforeKeys.has(key))
  const missingAfter = expectedAfterKeys.filter((key) => !usedAfterKeys.has(key))
  const extraBefore = [...usedBeforeKeys].filter((key) => !winnerKeySet.has(key) || finalKeySet.has(key))
  const extraAfter = [...usedAfterKeys].filter((key) => !finalKeySet.has(key) || winnerKeySet.has(key))

  if (missingBefore.length > 0 || missingAfter.length > 0 || extraBefore.length > 0 || extraAfter.length > 0) {
    throw new Error('Interview refinement changes do not fully and exactly account for the differences between the winning draft and the refined final draft')
  }
}

function normalizeInterviewBatchPhase(value: unknown): string | undefined {
  const raw = toOptionalString(value)
  if (!raw) return undefined
  const normalized = normalizeKey(raw)
  if (normalized === 'foundation') return 'Foundation'
  if (normalized === 'structure') return 'Structure'
  if (normalized === 'assembly') return 'Assembly'
  return raw
}

function normalizeInterviewBatchPriority(value: unknown): string | undefined {
  const raw = toOptionalString(value)
  if (!raw) return undefined
  const normalized = normalizeKey(raw)
  if (['critical', 'high', 'medium', 'low'].includes(normalized)) {
    return normalized
  }
  return raw
}

function normalizeInterviewBatchAnswerType(value: unknown): 'free_text' | 'single_choice' | 'multiple_choice' | 'yes_no' | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = normalizeKey(value)
  if (normalized === 'yesno' || normalized === 'yes_no' || normalized === 'boolean' || normalized === 'bool') return 'yes_no'
  if (normalized === 'singlechoice' || normalized === 'radio' || normalized === 'single') return 'single_choice'
  if (normalized === 'multiplechoice' || normalized === 'multchoice' || normalized === 'multi' || normalized === 'checkbox' || normalized === 'multichoice') return 'multiple_choice'
  if (normalized === 'freetext' || normalized === 'free' || normalized === 'text' || normalized === 'open') return 'free_text'
  return undefined
}

function normalizeInterviewBatchOption(value: unknown, index: number): { id: string; label: string } | null {
  if (typeof value === 'string') {
    const label = value.trim()
    if (!label) return null
    return { id: `opt${index + 1}`, label }
  }
  if (!isRecord(value)) return null
  const id = toOptionalString(getValueByAliases(value, ['id', 'key', 'value'])) ?? `opt${index + 1}`
  const label = toOptionalString(getValueByAliases(value, ['label', 'text', 'name', 'option', 'description']))
  if (!label) return null
  return { id: id.trim(), label: label.trim() }
}

function dedupeQuestionOptions<T extends { id: string; label: string }>(
  options: T[] | undefined,
  contextLabel: string,
): {
  options: T[] | undefined
  repairWarnings: string[]
} {
  if (!options || options.length === 0) {
    return { options, repairWarnings: [] }
  }

  const deduped: T[] = []
  const seenIds = new Set<string>()
  const duplicateIds = new Set<string>()

  for (const option of options) {
    if (seenIds.has(option.id)) {
      duplicateIds.add(option.id)
      continue
    }
    seenIds.add(option.id)
    deduped.push(option)
  }

  if (duplicateIds.size === 0) {
    return { options, repairWarnings: [] }
  }

  return {
    options: deduped,
    repairWarnings: [
      `${contextLabel}: removed duplicate option ids ${Array.from(duplicateIds).join(', ')} and kept the first occurrence.`,
    ],
  }
}

function normalizeInterviewBatchOptions(rawOptions: unknown): { id: string; label: string }[] | undefined {
  if (!Array.isArray(rawOptions)) return undefined
  return rawOptions.map((opt, i) => normalizeInterviewBatchOption(opt, i)).filter((opt): opt is { id: string; label: string } => opt !== null)
}

function normalizeInterviewBatchQuestion(value: unknown, index: number): {
  question: InterviewBatchPayloadQuestion
  repairWarnings: string[]
} {
  if (!isRecord(value)) throw new Error(`Interview batch question at index ${index} is not an object`)

  const repairWarnings: string[] = []
  const id = getRequiredString(value, ['id', 'questionid', 'question_id'], `question id at index ${index}`).trim()
  const question = getRequiredString(value, ['question', 'prompt', 'text'], `question text at index ${index}`)
  const phase = normalizeInterviewBatchPhase(getValueByAliases(value, ['phase', 'category', 'stage', 'section']))
  const priority = normalizeInterviewBatchPriority(getValueByAliases(value, ['priority']))
  const rationale = toOptionalString(getValueByAliases(value, ['rationale', 'reason']))
  const rawAnswerType = getValueByAliases(value, ['answertype', 'answer_type', 'type', 'inputtype', 'input_type'])
  const rawNormAnswerType = normalizeInterviewBatchAnswerType(rawAnswerType)
  const rawOptions = getValueByAliases(value, ['options', 'choices', 'answers'])
  const parsedOptions = normalizeInterviewBatchOptions(rawOptions)

  // Handle yes_no → single_choice expansion
  let finalAnswerType: 'free_text' | 'single_choice' | 'multiple_choice' | undefined = rawNormAnswerType === 'yes_no' ? 'single_choice' : rawNormAnswerType
  let finalOptions = rawNormAnswerType === 'yes_no'
    ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]
    : parsedOptions

  const dedupedOptions = dedupeQuestionOptions(finalOptions, `Interview batch question ${id}`)
  finalOptions = dedupedOptions.options
  repairWarnings.push(...dedupedOptions.repairWarnings)

  // Enforce option limits and downgrade empty-option choice types
  if (finalAnswerType === 'single_choice') {
    if (!finalOptions || finalOptions.length === 0) {
      finalAnswerType = undefined
      finalOptions = undefined
    } else if (finalOptions.length > MAX_SINGLE_CHOICE_OPTIONS) {
      finalOptions = finalOptions.slice(0, MAX_SINGLE_CHOICE_OPTIONS)
    }
  } else if (finalAnswerType === 'multiple_choice') {
    if (!finalOptions || finalOptions.length === 0) {
      finalAnswerType = undefined
      finalOptions = undefined
    } else if (finalOptions.length > MAX_MULTIPLE_CHOICE_OPTIONS) {
      finalOptions = finalOptions.slice(0, MAX_MULTIPLE_CHOICE_OPTIONS)
    }
  }

  return {
    question: {
      id,
      question: question.trim(),
      ...(phase ? { phase } : {}),
      ...(priority ? { priority } : {}),
      ...(rationale ? { rationale } : {}),
      ...(finalAnswerType && finalAnswerType !== 'free_text' ? { answerType: finalAnswerType } : {}),
      ...(finalOptions && finalOptions.length > 0 ? { options: finalOptions } : {}),
    },
    repairWarnings,
  }
}

function normalizeInterviewBatchPayload(value: unknown): {
  batch: InterviewBatchPayload
  repairWarnings: string[]
} {
  const repairWarnings: string[] = []
  const parsed = maybeUnwrapRecord(value, [
    'interviewbatch',
    'interview_batch',
    'batch',
    'payload',
    'output',
    'data',
  ])
  if (!isRecord(parsed)) throw new Error('Interview batch output is not a YAML/JSON object')
  if (parsed !== value && isRecord(value)) {
    appendWrapperKeyRepairWarning(repairWarnings, findMaybeUnwrappedWrapperPath(value, [
      'interviewbatch',
      'interview_batch',
      'batch',
      'payload',
      'output',
      'data',
    ]))
  }

  const rawQuestions = getValueByAliases(parsed, ['questions', 'nextquestions', 'next_questions'])
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error('Interview batch output is missing questions')
  }

  const progressRecord = getNestedRecord(parsed, ['progress'])
  const current = toInteger(getValueByAliases(progressRecord, ['current']))
  const total = toInteger(getValueByAliases(progressRecord, ['total']))
  const batchNumber = toInteger(getValueByAliases(parsed, ['batchnumber', 'batch_number']))

  if (batchNumber === null || batchNumber < 1) {
    throw new Error('Interview batch output is missing a valid batch_number')
  }
  if (current === null || current < 0) {
    throw new Error('Interview batch output is missing progress.current')
  }
  if (total === null || total < current) {
    throw new Error('Interview batch output is missing a valid progress.total')
  }

  const normalizedQuestions = rawQuestions.map((question, index) => normalizeInterviewBatchQuestion(question, index))
  repairWarnings.push(...normalizedQuestions.flatMap((question) => question.repairWarnings))
  const questions = normalizedQuestions.map((question) => question.question)

  // Enforce architecture batch size limit (1-3 questions per batch)
  if (questions.length > MAX_INTERVIEW_BATCH_SIZE) {
    questions.length = MAX_INTERVIEW_BATCH_SIZE
  }

  // Two questions sharing an id in one batch meant the second overwrote the
  // first in the session snapshot, and a prompt could inherit the other's answer.
  //
  // Checked after the size limit, not before: the invariant belongs to the batch
  // that reaches the snapshot, and a repeat in a question that is about to be
  // discarded used to reject a payload whose kept part was perfectly valid.
  const seenQuestionIds = new Set<string>()
  for (const question of questions) {
    if (seenQuestionIds.has(question.id)) {
      throw new Error(`Interview batch output repeats question id ${question.id}`)
    }
    seenQuestionIds.add(question.id)
  }

  return {
    batch: {
      batchNumber,
      progress: { current, total },
      isFinalFreeForm: toBoolean(getValueByAliases(parsed, ['isfinalfreeform', 'is_final_free_form'])) ?? false,
      aiCommentary: toOptionalString(getValueByAliases(parsed, ['aicommentary', 'ai_commentary', 'commentary', 'notes'])) ?? '',
      questions,
    },
    repairWarnings,
  }
}

function normalizeInterviewCompletePayload(value: unknown, shouldAllowQuestionsOnly: boolean): {
  normalizedContent: string
  repairWarnings: string[]
} {
  const repairWarnings: string[] = []
  const parsed = maybeUnwrapRecord(value, [
    'interviewcomplete',
    'interview_complete',
    'interview',
    'result',
    'output',
    'data',
  ])
  if (!isRecord(parsed)) throw new Error('Interview complete output is not a YAML/JSON object')
  if (parsed !== value && isRecord(value)) {
    appendWrapperKeyRepairWarning(repairWarnings, findMaybeUnwrappedWrapperPath(value, [
      'interviewcomplete',
      'interview_complete',
      'interview',
      'result',
      'output',
      'data',
    ]))
  }

  const hasQuestions = Array.isArray(getValueByAliases(parsed, ['questions']))
  const hasAnswers = Array.isArray(getValueByAliases(parsed, ['answers']))
  const hasFinalSchemaKeys = ['schemaversion', 'schema_version', 'artifact', 'generatedby', 'generated_by', 'approval', 'summary', 'followuprounds', 'follow_up_rounds']
    .some((alias) => getValueByAliases(parsed, [alias]) !== undefined)
  const hasAuditSummaryKeys = ['ticketid', 'ticket_id', 'status', 'derivedfindings', 'derived_findings', 'skippedquestionids', 'skipped_question_ids', 'assumptionsforprdgeneration', 'assumptions_for_prd_generation', 'confidence']
    .some((alias) => getValueByAliases(parsed, [alias]) !== undefined)

  if (!hasQuestions && !hasAnswers) {
    throw new Error('Interview complete output is missing questions or answers')
  }
  if (!shouldAllowQuestionsOnly && !hasFinalSchemaKeys && !hasAuditSummaryKeys) {
    throw new Error('Interview complete output is missing final interview schema fields')
  }

  return {
    normalizedContent: buildYamlDocument(parsed),
    repairWarnings,
  }
}

export function normalizeInterviewTurnOutput(rawContent: string): StructuredOutputResult<InterviewTurnOutput> {
  let lastError = 'No interview batch or completion content found'
  let lastErrorCause: unknown = null
  let lastCandidateWarnings: string[] = []

  const completeCandidates = collectTaggedCandidates(rawContent, 'INTERVIEW_COMPLETE')
  for (const candidate of completeCandidates) {
    const candidateWarnings: string[] = []
    const releaseAliasConflicts = collectAliasConflictWarnings(candidateWarnings)
    try {
      const parsedCandidate = parseYamlOrJsonCandidate(candidate, {
        nestedMappingChildren: INTERVIEW_TURN_NESTED_MAPPING_CHILDREN,
        repairWarnings: candidateWarnings,
      })
      const normalizedContent = normalizeInterviewCompletePayload(parsedCandidate, true)
      candidateWarnings.push(...normalizedContent.repairWarnings)
      appendStructuredCandidateRecoveryWarning(candidateWarnings, rawContent, candidate, { tag: 'INTERVIEW_COMPLETE' })
      return {
        ok: true,
        value: {
          kind: 'complete',
          finalYaml: normalizedContent.normalizedContent.trim(),
        },
        normalizedContent: normalizedContent.normalizedContent,
        repairApplied: candidateWarnings.length > 0 || shouldRecordStructuredCandidateRecovery(rawContent, candidate, { tag: 'INTERVIEW_COMPLETE' }),
        repairWarnings: candidateWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
      lastCandidateWarnings = candidateWarnings
    } finally {
      releaseAliasConflicts()
    }
  }

  const batchCandidates = collectTaggedCandidates(rawContent, 'INTERVIEW_BATCH')
  for (const candidate of batchCandidates) {
    const candidateWarnings: string[] = []
    const releaseAliasConflicts = collectAliasConflictWarnings(candidateWarnings)
    try {
      const normalizedBatch = normalizeInterviewBatchPayload(parseYamlOrJsonCandidate(candidate, {
        nestedMappingChildren: INTERVIEW_TURN_NESTED_MAPPING_CHILDREN,
        repairWarnings: candidateWarnings,
      }))
      candidateWarnings.push(...normalizedBatch.repairWarnings)
      appendStructuredCandidateRecoveryWarning(candidateWarnings, rawContent, candidate, { tag: 'INTERVIEW_BATCH' })
      return {
        ok: true,
        value: {
          kind: 'batch',
          batch: normalizedBatch.batch,
        },
        normalizedContent: buildYamlDocument({
          batch_number: normalizedBatch.batch.batchNumber,
          progress: normalizedBatch.batch.progress,
          is_final_free_form: normalizedBatch.batch.isFinalFreeForm,
          ai_commentary: normalizedBatch.batch.aiCommentary,
          questions: normalizedBatch.batch.questions,
        }),
        repairApplied: candidateWarnings.length > 0 || shouldRecordStructuredCandidateRecovery(rawContent, candidate, { tag: 'INTERVIEW_BATCH' }),
        repairWarnings: candidateWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
      lastCandidateWarnings = candidateWarnings
    } finally {
      releaseAliasConflicts()
    }
  }

  const fallbackCandidates = collectStructuredCandidates(rawContent, {
    topLevelHints: ['batch_number', 'batchnumber', 'progress', 'schema_version', 'approval', 'generated_by', 'generatedby', 'ticket_id', 'ticketid', 'answers', 'status'],
  })

  for (const candidate of fallbackCandidates) {
    const candidateWarnings: string[] = []
    let releaseAliasConflicts = collectAliasConflictWarnings(candidateWarnings)
    try {
      const parsed = parseYamlOrJsonCandidate(candidate, {
        nestedMappingChildren: INTERVIEW_TURN_NESTED_MAPPING_CHILDREN,
        repairWarnings: candidateWarnings,
      })
      const normalizedContent = normalizeInterviewCompletePayload(parsed, false)
      candidateWarnings.push(...normalizedContent.repairWarnings)
      appendStructuredCandidateRecoveryWarning(candidateWarnings, rawContent, candidate)
      return {
        ok: true,
        value: {
          kind: 'complete',
          finalYaml: normalizedContent.normalizedContent.trim(),
        },
        normalizedContent: normalizedContent.normalizedContent,
        repairApplied: candidateWarnings.length > 0 || shouldRecordStructuredCandidateRecovery(rawContent, candidate),
        repairWarnings: candidateWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
    } finally {
      releaseAliasConflicts()
    }

    const batchCandidateWarnings: string[] = []
    releaseAliasConflicts = collectAliasConflictWarnings(batchCandidateWarnings)
    try {
      const normalizedBatch = normalizeInterviewBatchPayload(parseYamlOrJsonCandidate(candidate, {
        nestedMappingChildren: INTERVIEW_TURN_NESTED_MAPPING_CHILDREN,
        repairWarnings: batchCandidateWarnings,
      }))
      batchCandidateWarnings.push(...normalizedBatch.repairWarnings)
      appendStructuredCandidateRecoveryWarning(batchCandidateWarnings, rawContent, candidate)
      return {
        ok: true,
        value: {
          kind: 'batch',
          batch: normalizedBatch.batch,
        },
        normalizedContent: buildYamlDocument({
          batch_number: normalizedBatch.batch.batchNumber,
          progress: normalizedBatch.batch.progress,
          is_final_free_form: normalizedBatch.batch.isFinalFreeForm,
          ai_commentary: normalizedBatch.batch.aiCommentary,
          questions: normalizedBatch.batch.questions,
        }),
        repairApplied: batchCandidateWarnings.length > 0 || shouldRecordStructuredCandidateRecovery(rawContent, candidate),
        repairWarnings: batchCandidateWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
      lastCandidateWarnings = candidateWarnings
    } finally {
      releaseAliasConflicts()
    }
  }

  return buildStructuredOutputFailure(
    rawContent,
    looksLikePromptEcho(rawContent)
      ? 'Interview output echoed the prompt instead of returning an <INTERVIEW_BATCH> or <INTERVIEW_COMPLETE> artifact'
      : lastError,
    {
      cause: lastErrorCause,
      // The sibling normalisers in this file carry the last rejected
      // candidate's repair record into their failures, and so do beadsOutput
      // and voteOutput. This one built the per-candidate arrays and dropped
      // them, so a failure could not say what had been attempted.
      repairApplied: lastCandidateWarnings.length > 0,
      repairWarnings: lastCandidateWarnings,
    },
  )
}

export function normalizeInterviewQuestionsOutput(
  rawContent: string,
  maxInitialQuestions: number,
): StructuredOutputResult<{
  questions: NormalizedInterviewQuestion[]
  questionCount: number
}> {
  let repairWarnings: string[] = []
  let repairApplied = false
  const candidates = collectStructuredCandidates(rawContent, {
    topLevelHints: ['questions'],
  })

  let lastError = 'No interview question content found'
  let lastErrorCause: unknown = null

  for (const candidate of candidates) {
    const candidateWarnings: string[] = []
    let candidateRepairApplied = false
    const releaseAliasConflicts = collectAliasConflictWarnings(candidateWarnings)
    try {
      // The two inline repairs used to be computed here, discarded, and reported
      // as applied. `parseInterviewQuestions` runs `repairInterviewCandidate`
      // first for every candidate, and that begins with the same two repairs
      // followed by more, so this pair only ever described work the parser was
      // already doing — on a string the parser never saw. Ask the parser which
      // variant it actually used instead.
      const parsed = parseInterviewQuestions(candidate, {
        onCandidateRepairApplied: () => {
          candidateRepairApplied = true
          candidateWarnings.push('Repaired inline YAML sequence or mapping syntax before parsing.')
        },
      })
      const normalized = normalizeParsedInterviewQuestionList(parsed, maxInitialQuestions)

      if (normalized.repairApplied) {
        candidateRepairApplied = true
        candidateWarnings.push(...normalized.repairWarnings)
      }
      if (normalized.reordered) {
        candidateRepairApplied = true
        candidateWarnings.push('Applied stable interview phase reordering (foundation -> structure -> assembly).')
      }

      const questions = normalized.questions
      appendStructuredCandidateRecoveryWarning(candidateWarnings, rawContent, candidate)
      return {
        ok: true,
        value: {
          questions,
          questionCount: questions.length,
        },
        normalizedContent: buildYamlDocument({ questions }),
        // `candidateWarnings` also collects what the shared parser and the alias
        // sink recorded, neither of which touches `candidateRepairApplied`, so a
        // repair could be reported in the warnings while the flag said none ran.
        repairApplied: candidateRepairApplied || candidateWarnings.length > 0 || candidate !== rawContent.trim(),
        repairWarnings: candidateWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
      repairWarnings = candidateWarnings
      repairApplied = candidateRepairApplied
    } finally {
      releaseAliasConflicts()
    }
  }

  return buildStructuredOutputFailure(
    rawContent,
    looksLikePromptEcho(rawContent)
      ? 'Interview question output echoed the prompt instead of returning structured questions'
      : lastError,
    {
      repairApplied,
      repairWarnings,
      cause: lastErrorCause,
    },
  )
}

export interface InterviewRefinementOptions {
  /**
   * `accounted_elsewhere` skips the missing-changes policy for a caller that is
   * re-reading content this module already validated and accounted for — the
   * canonical `questionsYaml` carries questions only, by design.
   */
  missingChangesPolicy?: 'require' | 'accounted_elsewhere'
}

export function normalizeInterviewRefinementOutput(
  rawContent: string,
  winnerDraftContent: string,
  maxInitialQuestions: number,
  losingDraftMeta?: Array<{ memberId: string; content: string }>,
  options?: InterviewRefinementOptions,
): StructuredOutputResult<{
  questions: NormalizedInterviewQuestion[]
  questionCount: number
  changes: NormalizedInterviewRefinementChange[]
  questionsYaml: string
}> {
  // Per candidate, so a repair attempted on a candidate that was rejected is not
  // reported against the one that validated.
  let repairWarnings: string[] = []
  let repairApplied = false
  const candidates = collectStructuredCandidates(rawContent, {
    topLevelHints: ['questions', 'changes'],
  })

  let lastError = 'No interview refinement content found'
  let lastErrorCause: unknown = null

  for (const candidate of candidates) {
    const candidateWarnings: string[] = []
    let candidateRepairApplied = false
    const releaseAliasConflicts = collectAliasConflictWarnings(candidateWarnings)
    try {
      const parsed = unwrapExplicitWrapperRecord(parseYamlOrJsonCandidate(candidate, {
        repairWarnings: candidateWarnings,
      }), [
        'interviewrefinement',
        'interview_refinement',
        'refinement',
        'output',
        'data',
      ])
      if (!isRecord(parsed)) {
        throw new Error('Interview refinement output is not a YAML/JSON object')
      }

      const rawQuestions = getValueByAliases(parsed, ['questions'])
      const rawChanges = getValueByAliases(parsed, ['changes'])

      if (!Array.isArray(rawQuestions)) {
        throw new Error('Interview refinement output is missing questions')
      }

      const normalizedQuestions = normalizeStructuredInterviewQuestionList(rawQuestions, maxInitialQuestions)
      if (normalizedQuestions.repairApplied) {
        candidateRepairApplied = true
        candidateWarnings.push(...normalizedQuestions.repairWarnings)
      }
      if (normalizedQuestions.reordered) {
        candidateRepairApplied = true
        candidateWarnings.push('Applied stable interview phase reordering (foundation -> structure -> assembly).')
      }

      const winnerDraftNormalized = normalizeParsedInterviewQuestionList(parseInterviewQuestions(winnerDraftContent), 0)
      if (winnerDraftNormalized.repairApplied) {
        candidateRepairApplied = true
        candidateWarnings.push(...winnerDraftNormalized.repairWarnings)
      }
      const winnerDraftQuestions = winnerDraftNormalized.questions
      let finalQuestions = normalizedQuestions.questions
      let changes: NormalizedInterviewRefinementChange[] = []

      // A refinement that returned no `changes` at all used to skip change
      // accounting entirely, so a rewritten question list shipped with an empty
      // diff and no attribution. When the two documents actually differ, the
      // accounting runs on an empty change list: synthesis covers what it can
      // and ensureQuestionChangeCoverage rejects the rest.
      const changesAreAccountable = Array.isArray(rawChanges)
        || (options?.missingChangesPolicy !== 'accounted_elsewhere'
          && interviewQuestionListsDiffer(winnerDraftQuestions, finalQuestions))
      if (!Array.isArray(rawChanges) && changesAreAccountable) {
        candidateRepairApplied = true
        candidateWarnings.push(INTERVIEW_MISSING_CHANGES_WARNING)
      }

      if (changesAreAccountable) {
        const rawChangeEntries = Array.isArray(rawChanges) ? rawChanges : []
        const parsedChanges = rawChangeEntries.map((entry, index) => parseInterviewRefinementChangeEntry(
          entry,
          index,
          losingDraftMeta,
        ))
        const repairedFinalQuestions = repairStaleInterviewRefinedQuestionsFromChanges(
          finalQuestions,
          parsedChanges,
        )
        if (repairedFinalQuestions.repairApplied) {
          candidateRepairApplied = true
          candidateWarnings.push(...repairedFinalQuestions.repairWarnings)
          finalQuestions = repairedFinalQuestions.questions
        }

        const winnerKeySet = new Set(winnerDraftQuestions.map(buildInterviewQuestionKey))
        const finalKeySet = new Set(finalQuestions.map(buildInterviewQuestionKey))
        const usedBeforeKeys = new Set<string>()
        const usedAfterKeys = new Set<string>()
        const canonicalizedChanges = canonicalizeInterviewRefinementChanges(
          parsedChanges,
          winnerDraftQuestions,
          finalQuestions,
        )
        if (canonicalizedChanges.repairApplied) {
          candidateRepairApplied = true
          candidateWarnings.push(...canonicalizedChanges.repairWarnings)
        }

        const synthesizedChanges = synthesizeOmittedSameIdentityInterviewRefinementChanges(
          canonicalizedChanges.changes,
          winnerDraftQuestions,
          finalQuestions,
        )
        if (synthesizedChanges.repairApplied) {
          candidateRepairApplied = true
          candidateWarnings.push(...synthesizedChanges.repairWarnings)
        }

        const prunedPartialChanges = dropRedundantPartialInterviewRefinementChanges(
          synthesizedChanges.changes,
          synthesizedChanges.synthesizedChanges,
        )
        if (prunedPartialChanges.repairApplied) {
          candidateRepairApplied = true
          candidateWarnings.push(...prunedPartialChanges.repairWarnings)
        }

        const repairedPartialChanges = repairPartialInterviewRefinementChanges(
          prunedPartialChanges.changes,
          winnerDraftQuestions,
          finalQuestions,
        )
        if (repairedPartialChanges.repairApplied) {
          candidateRepairApplied = true
          candidateWarnings.push(...repairedPartialChanges.repairWarnings)
        }

        assertNoPartialInterviewRefinementChanges(repairedPartialChanges.changes)

        const completeChanges = repairedPartialChanges.changes.map((change) => normalizeCompleteInterviewRefinementChangeCandidate(change))
        changes = completeChanges.map((change, index) => validateInterviewRefinementChangeEntry(
          change,
          index,
          winnerKeySet,
          finalKeySet,
          usedBeforeKeys,
          usedAfterKeys,
        ))

        // Resolve inspiration memberIds from losingDraftMeta
        if (losingDraftMeta) {
          const normalizedLosingDraftQuestions = new Map<number, NormalizedInterviewQuestion[]>()
          for (const change of changes) {
            if (change.inspiration && change.inspiration.draftIndex >= 0 && change.inspiration.draftIndex < losingDraftMeta.length) {
              const losingDraftIndex = change.inspiration.draftIndex
              change.inspiration.memberId = losingDraftMeta[losingDraftIndex]!.memberId
              if (!normalizedLosingDraftQuestions.has(losingDraftIndex)) {
                try {
                  const parsedLosingDraft = normalizeParsedInterviewQuestionList(
                    parseInterviewQuestions(losingDraftMeta[losingDraftIndex]!.content),
                    0,
                  )
                  normalizedLosingDraftQuestions.set(losingDraftIndex, parsedLosingDraft.questions)
                } catch {
                  normalizedLosingDraftQuestions.set(losingDraftIndex, [])
                }
              }
              change.inspiration.question = hydrateInterviewInspirationQuestion(
                change.inspiration.question,
                normalizedLosingDraftQuestions.get(losingDraftIndex) ?? [],
              )
            } else if (change.inspiration && change.inspiration.draftIndex >= 0) {
              candidateRepairApplied = true
              candidateWarnings.push(
                `Inspiration draftIndex ${change.inspiration.draftIndex} is out of bounds (${losingDraftMeta.length} alternatives). Setting inspiration to null.`,
              )
              ;(change as { inspiration: NormalizedInspirationSource | null }).inspiration = null
              change.attributionStatus = 'invalid_unattributed'
            }
          }
        }

        ensureQuestionChangeCoverage(
          winnerDraftQuestions,
          finalQuestions,
          usedBeforeKeys,
          usedAfterKeys,
        )
      }

      const questionsYaml = buildYamlDocument({ questions: finalQuestions })
      appendStructuredCandidateRecoveryWarning(candidateWarnings, rawContent, candidate)

      return {
        ok: true,
        value: {
          questions: finalQuestions,
          questionCount: finalQuestions.length,
          changes,
          questionsYaml,
        },
        normalizedContent: questionsYaml,
        // `candidateWarnings` also collects what the shared parser and the alias
        // sink recorded, neither of which touches `candidateRepairApplied`, so a
        // repair could be reported in the warnings while the flag said none ran.
        repairApplied: candidateRepairApplied || candidateWarnings.length > 0 || candidate !== rawContent.trim(),
        repairWarnings: candidateWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
      repairWarnings = candidateWarnings
      repairApplied = candidateRepairApplied
    } finally {
      releaseAliasConflicts()
    }
  }

  return buildStructuredOutputFailure(
    rawContent,
    looksLikePromptEcho(rawContent)
      ? 'Interview refinement output echoed the prompt instead of returning structured refinement YAML'
      : lastError,
    {
      repairApplied,
      repairWarnings,
      cause: lastErrorCause,
    },
  )
}

export interface CoverageFollowUpDefaults {
  /** Used when the model omits `phase`. The coverage parser leaves it unset. */
  phase?: string
  /** Used when the model omits `priority`. */
  priority?: string
  /** Used when the model omits `rationale`. */
  rationale?: string
}

/**
 * The one semantic normaliser for coverage follow-up questions. The interview
 * session used to carry a second, narrower copy, so the same coverage response
 * produced different question types depending on which path read it.
 */
export function normalizeCoverageFollowUpQuestions(value: unknown, defaults?: CoverageFollowUpDefaults): {
  questions: CoverageFollowUpQuestion[]
  repairWarnings: string[]
} {
  if (!Array.isArray(value)) return { questions: [], repairWarnings: [] }

  const repairWarnings: string[] = []
  const questions = value.map((entry, index) => {
    if (typeof entry === 'string') {
      return {
        id: `FU${index + 1}`,
        question: entry.trim(),
        ...(defaults?.phase ? { phase: defaults.phase } : {}),
        ...(defaults?.priority ? { priority: defaults.priority } : {}),
        ...(defaults?.rationale ? { rationale: defaults.rationale } : {}),
      }
    }

    const record = isRecord(entry) ? entry : {}
    const question = typeof record.question === 'string'
      ? record.question
      : typeof record.prompt === 'string'
        ? record.prompt
        : typeof record.text === 'string'
          ? record.text
          : ''

    // Normalize answer type and options for coverage follow-ups
    const rawAnswerType = getValueByAliases(record, ['answertype', 'answer_type', 'type', 'inputtype', 'input_type'])
    const rawNormAnswerType = normalizeInterviewBatchAnswerType(rawAnswerType)
    const rawOptions = getValueByAliases(record, ['options', 'choices', 'answers'])
    const parsedOptions = normalizeInterviewBatchOptions(rawOptions)

    // Handle yes_no → single_choice expansion
    let finalAnswerType: 'free_text' | 'single_choice' | 'multiple_choice' | undefined = rawNormAnswerType === 'yes_no' ? 'single_choice' : rawNormAnswerType
    let finalOptions = rawNormAnswerType === 'yes_no'
      ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]
      : parsedOptions
    const questionId = typeof record.id === 'string' ? record.id : `FU${index + 1}`

    const dedupedOptions = dedupeQuestionOptions(finalOptions, `Coverage follow-up question ${questionId}`)
    finalOptions = dedupedOptions.options
    repairWarnings.push(...dedupedOptions.repairWarnings)

    // Enforce option limits and downgrade empty-option choice types
    if (finalAnswerType === 'single_choice') {
      if (!finalOptions || finalOptions.length === 0) {
        finalAnswerType = undefined
        finalOptions = undefined
      } else if (finalOptions.length > MAX_SINGLE_CHOICE_OPTIONS) {
        finalOptions = finalOptions.slice(0, MAX_SINGLE_CHOICE_OPTIONS)
      }
    } else if (finalAnswerType === 'multiple_choice') {
      if (!finalOptions || finalOptions.length === 0) {
        finalAnswerType = undefined
        finalOptions = undefined
      } else if (finalOptions.length > MAX_MULTIPLE_CHOICE_OPTIONS) {
        finalOptions = finalOptions.slice(0, MAX_MULTIPLE_CHOICE_OPTIONS)
      }
    }

    return {
      id: questionId,
      question: question.trim(),
      phase: typeof record.phase === 'string' ? record.phase : defaults?.phase,
      priority: typeof record.priority === 'string' ? record.priority : defaults?.priority,
      rationale: typeof record.rationale === 'string' ? record.rationale : defaults?.rationale,
      ...(finalAnswerType && finalAnswerType !== 'free_text' ? { answerType: finalAnswerType } : {}),
      ...(finalOptions && finalOptions.length > 0 ? { options: finalOptions } : {}),
    }
  }).filter((entry) => entry.question.length > 0)

  return { questions, repairWarnings }
}

function parseCoverageResultCandidate(candidate: string): {
  value: CoverageResultEnvelope
  repairWarnings: string[]
} {
  const parseRepairWarnings: string[] = []
  const releaseAliasConflicts = collectAliasConflictWarnings(parseRepairWarnings)
  try {
    return parseCoverageResultCandidateFields(candidate, parseRepairWarnings)
  } finally {
    releaseAliasConflicts()
  }
}

function parseCoverageResultCandidateFields(candidate: string, parseRepairWarnings: string[]): {
  value: CoverageResultEnvelope
  repairWarnings: string[]
} {
  const parsed = maybeUnwrapRecord(parseYamlOrJsonCandidate(candidate, {
    allowTrailingTerminalNoise: true,
    repairWarnings: parseRepairWarnings,
  }), [
    'coverage',
    'result',
    'output',
    'data',
  ])
  if (!isRecord(parsed)) throw new Error('Coverage output is not a YAML/JSON object')

  const rawStatus = getStringByAliases(parsed, ['status'])?.trim().toLowerCase() ?? ''
  const gaps = toStringArray(getValueByAliases(parsed, ['gaps', 'issues']))
  const normalizedFollowUps = normalizeCoverageFollowUpQuestions(
    getValueByAliases(parsed, ['followupquestions', 'follow_up_questions']),
  )
  const followUpQuestions = normalizedFollowUps.questions

  const status: CoverageResultEnvelope['status'] = rawStatus === 'clean'
    || rawStatus === 'pass'
    || rawStatus === 'coverage_complete'
    || rawStatus === 'coverage_pass'
    ? 'clean'
    : rawStatus === 'gaps'
      || rawStatus === 'fail'
      || rawStatus === 'coverage_gaps'
      || rawStatus === 'coverage_fail'
      ? 'gaps'
      : followUpQuestions.length > 0 || gaps.length > 0
        ? 'gaps'
        : (() => { throw new Error('Coverage output missing valid status') })()

  return {
    value: {
      status,
      gaps,
      followUpQuestions,
    },
    repairWarnings: [...parseRepairWarnings, ...normalizedFollowUps.repairWarnings],
  }
}

const ORPHAN_CLOSING_FENCE_WITH_COMMENTARY_WARNING =
  'Trimmed an orphan trailing closing code fence and commentary after the complete coverage artifact.'

/**
 * Some models return a complete coverage envelope, then close a fence they never
 * opened and continue with prose. The prefix is safe to recover only when the
 * fence is top-level and there is no earlier opening fence in the candidate.
 */
function extractCoverageArtifactBeforeOrphanFence(rawContent: string): string | null {
  const lines = rawContent.trim().split('\n')
  const fenceIndex = lines.findIndex((line) => /^```\s*$/.test(line.trim()))
  if (fenceIndex <= 0) return null

  const prefix = lines.slice(0, fenceIndex)
  if (prefix.some((line) => /^```(?:yaml|yml|jsonl|json)?\s*$/i.test(line.trim()))) {
    return null
  }

  const candidate = prefix.join('\n').trim()
  return candidate || null
}

export function normalizeCoverageResultOutput(rawContent: string): StructuredOutputResult<CoverageResultEnvelope> {
  const structuredCandidates = collectStructuredCandidates(rawContent, {
    topLevelHints: ['status', 'gaps', 'follow_up_questions', 'followUpQuestions'],
  })
  const orphanFenceCandidate = extractCoverageArtifactBeforeOrphanFence(rawContent)
  const candidates = orphanFenceCandidate && !structuredCandidates.includes(orphanFenceCandidate)
    ? [...structuredCandidates, orphanFenceCandidate]
    : structuredCandidates
  let lastError = 'No coverage result content found'
  let lastErrorCause: unknown = null

  for (const candidate of candidates) {
    let repairWarnings: string[] = []
    let repairApplied = false

    try {
      const normalized = parseCoverageResultCandidate(candidate)
      appendStructuredCandidateRecoveryWarning(normalized.repairWarnings, rawContent, candidate)
      if (candidate === orphanFenceCandidate) {
        normalized.repairWarnings.push(ORPHAN_CLOSING_FENCE_WITH_COMMENTARY_WARNING)
      }

      return {
        ok: true,
        value: normalized.value,
        normalizedContent: buildYamlDocument({
          status: normalized.value.status,
          gaps: normalized.value.gaps,
          follow_up_questions: normalized.value.followUpQuestions,
        }),
        repairApplied: candidate !== rawContent.trim() || normalized.repairWarnings.length > 0,
        repairWarnings: normalized.repairWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error

      const repairedCandidate = repairCoverageGapStringList(candidate)
      if (!repairedCandidate.repairApplied) {
        continue
      }

      try {
        const normalized = parseCoverageResultCandidate(repairedCandidate.content)
        repairApplied = true
        repairWarnings = [...repairedCandidate.repairWarnings, ...normalized.repairWarnings]
        appendStructuredCandidateRecoveryWarning(repairWarnings, rawContent, candidate)

        return {
          ok: true,
          value: normalized.value,
          normalizedContent: buildYamlDocument({
            status: normalized.value.status,
            gaps: normalized.value.gaps,
            follow_up_questions: normalized.value.followUpQuestions,
          }),
          repairApplied: candidate !== rawContent.trim() || repairApplied,
          repairWarnings,
        }
      } catch (repairError) {
        lastError = getErrorMessage(repairError)
        lastErrorCause = repairError
      }
    }
  }

  return buildStructuredOutputFailure(
    rawContent,
    looksLikePromptEcho(rawContent)
      ? 'Coverage output echoed the prompt instead of returning structured coverage YAML'
      : lastError,
    { cause: lastErrorCause },
  )
}
