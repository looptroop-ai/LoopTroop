import * as jsYaml from 'js-yaml'
import { isRecord } from './typeGuards'
import { renderCommandSpec, type CommandSpec } from './commandSpec'
import type {
  InterviewQuestionChange,
  InterviewQuestionChangeAttributionStatus,
  ParsedInterviewQuestion,
} from './interviewQuestions'
import { extractInterviewQuestionPreviews } from './interviewQuestions'
import type { RefinementChange, RefinementChangeAttributionStatus } from './refinementChanges'

export type UiRefinementDiffDomain = 'interview' | 'prd' | 'beads'
export type UiRefinementDiffChangeType = 'modified' | 'replaced' | 'added' | 'removed'
export type UiRefinementDiffAttributionStatus =
  | InterviewQuestionChangeAttributionStatus
  | RefinementChangeAttributionStatus

export interface UiRefinementDiffInspirationBlock {
  kind: 'epic' | 'user_story' | 'bead'
  id?: string
  label: string
  text: string
}

export interface UiRefinementDiffInspiration {
  memberId: string
  sourceId?: string
  sourceLabel: string
  sourceText?: string
  blocks?: UiRefinementDiffInspirationBlock[]
}

export interface UiRefinementDiffEntry {
  key: string
  changeType: UiRefinementDiffChangeType
  itemKind: string
  label: string
  beforeId?: string
  afterId?: string
  beforeText?: string
  afterText?: string
  inspiration: UiRefinementDiffInspiration | null
  attributionStatus: UiRefinementDiffAttributionStatus
}

export interface UiRefinementDiffArtifact {
  domain: UiRefinementDiffDomain
  winnerId: string
  generatedAt: string
  entries: UiRefinementDiffEntry[]
}

interface DiffCandidateBlock {
  key: string
  itemKind: string
  label: string
  id?: string
  text: string
  inspirationBlocks?: UiRefinementDiffInspirationBlock[]
}

interface ParsedPrdUserStory {
  id?: string
  title?: string
  acceptance_criteria?: string[]
  implementation_steps?: string[]
  verification?: {
    required_commands?: CommandSpec[]
  }
}

interface ParsedPrdEpic {
  id?: string
  title?: string
  objective?: string
  implementation_steps?: string[]
  user_stories?: ParsedPrdUserStory[]
}

interface ParsedPrdDocument {
  product?: {
    problem_statement?: string
    target_users?: string[]
  }
  scope?: {
    in_scope?: string[]
    out_of_scope?: string[]
  }
  technical_requirements?: {
    architecture_constraints?: string[]
    data_model?: string[]
    api_contracts?: string[]
    security_constraints?: string[]
    performance_constraints?: string[]
    reliability_constraints?: string[]
    error_handling_rules?: string[]
    tooling_assumptions?: string[]
  }
  epics?: ParsedPrdEpic[]
  risks?: string[]
}

interface ParsedBeadSubset {
  id?: string
  title?: string
  prdRefs?: string[]
  description?: string
  contextGuidance?: { patterns?: string[]; anti_patterns?: string[] } | string
  acceptanceCriteria?: string[]
  tests?: string[]
  testCommands?: CommandSpec[]
}

interface DiffSourceCandidate {
  memberId: string
  itemKind: string
  label: string
  id?: string
  text: string
  blocks?: UiRefinementDiffInspirationBlock[]
}

const QUESTION_ID_FALLBACK_PREFIX = 'Q'
const PRD_TECHNICAL_SECTION_CONFIG: Array<{
  key: keyof NonNullable<ParsedPrdDocument['technical_requirements']>
  itemKind: string
  label: string
}> = [
  { key: 'architecture_constraints', itemKind: 'technical_requirements.architecture_constraints', label: 'Architecture Constraints' },
  { key: 'data_model', itemKind: 'technical_requirements.data_model', label: 'Data Model' },
  { key: 'api_contracts', itemKind: 'technical_requirements.api_contracts', label: 'API Contracts' },
  { key: 'security_constraints', itemKind: 'technical_requirements.security_constraints', label: 'Security Constraints' },
  { key: 'performance_constraints', itemKind: 'technical_requirements.performance_constraints', label: 'Performance Constraints' },
  { key: 'reliability_constraints', itemKind: 'technical_requirements.reliability_constraints', label: 'Reliability Constraints' },
  { key: 'error_handling_rules', itemKind: 'technical_requirements.error_handling_rules', label: 'Error Handling Rules' },
  { key: 'tooling_assumptions', itemKind: 'technical_requirements.tooling_assumptions', label: 'Tooling Assumptions' },
]

function readYamlRecord<T>(content: string): T | null {
  try {
    const parsed = jsYaml.load(content)
    return isRecord(parsed) ? parsed as T : null
  } catch {
    return null
  }
}

function readYamlArray<T>(content: string): T[] | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('{')) {
    try {
      return trimmed
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    } catch {
      // Not valid JSON Lines — fall through to YAML parsing
    }
  }

  try {
    const parsed = jsYaml.load(trimmed)
    return Array.isArray(parsed)
      ? parsed as T[]
      : isRecord(parsed) && Array.isArray(parsed.beads)
        ? parsed.beads as T[]
        : null
  } catch {
    return null
  }
}

function normalizeStringArray(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
}

function renderList(values: string[] | undefined): string {
  const normalized = normalizeStringArray(values)
  return normalized.map((value) => `- ${value}`).join('\n').trim()
}

function renderNamedSection(label: string, body: string): string {
  const trimmed = body.trim()
  return trimmed ? `${label}:\n${trimmed}` : ''
}

function uniqueByKey<T>(values: T[], getKey: (value: T) => string): T[] {
  const seen = new Set<string>()
  const deduped: T[] = []
  for (const value of values) {
    const key = getKey(value)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(value)
  }
  return deduped
}

function buildSourceCandidates(
  drafts: Array<{ memberId: string; content: string }>,
  buildBlocks: (content: string) => DiffCandidateBlock[],
): DiffSourceCandidate[] {
  return drafts.flatMap((draft) =>
    buildBlocks(draft.content).map((block) => ({
      memberId: draft.memberId,
      itemKind: block.itemKind,
      label: block.label,
      id: block.id,
      text: block.text,
      blocks: block.inspirationBlocks,
    })),
  )
}

function buildInspirationBlock(
  kind: UiRefinementDiffInspirationBlock['kind'],
  label: string,
  text: string,
  id?: string,
): UiRefinementDiffInspirationBlock {
  return {
    kind,
    ...(id ? { id } : {}),
    label,
    text,
  }
}

function cloneInspirationBlocks(
  blocks: UiRefinementDiffInspirationBlock[] | undefined,
): UiRefinementDiffInspirationBlock[] | undefined {
  return blocks?.length
    ? blocks.map((block) => ({ ...block }))
    : undefined
}

function buildFallbackPrimaryInspirationBlocks(
  itemKind: string,
  item: { id?: string; label?: string; detail?: string } | null | undefined,
  sourceText?: string,
): UiRefinementDiffInspirationBlock[] | undefined {
  const normalizedText = sourceText?.trim()
  const normalizedLabel = item?.label?.trim()
  if (!normalizedText || !normalizedLabel) return undefined

  if (itemKind === 'epic' || itemKind === 'user_story' || itemKind === 'bead') {
    return [
      buildInspirationBlock(
        itemKind,
        normalizedLabel,
        normalizedText,
        item?.id?.trim() || undefined,
      ),
    ]
  }

  return undefined
}

function resolveInspirationBlocks(
  itemKind: string,
  sourceCandidate: DiffSourceCandidate | null,
  fallbackItem: { id?: string; label?: string; detail?: string } | null | undefined,
  fallbackSourceText?: string,
): UiRefinementDiffInspirationBlock[] | undefined {
  return cloneInspirationBlocks(sourceCandidate?.blocks)
    ?? buildFallbackPrimaryInspirationBlocks(itemKind, fallbackItem, fallbackSourceText)
}

function findDeterministicInspiration(
  target: { itemKind: string; text?: string | null },
  candidates: DiffSourceCandidate[],
): UiRefinementDiffInspiration | null {
  const text = target.text?.trim()
  if (!text) return null

  const matches = uniqueByKey(
    candidates.filter((candidate) => candidate.itemKind === target.itemKind && candidate.text.trim() === text),
    (candidate) => `${candidate.memberId}\u241f${candidate.itemKind}\u241f${candidate.id ?? ''}\u241f${candidate.text}`,
  )

  if (matches.length !== 1) return null

  const match = matches[0]!
  const blocks = resolveInspirationBlocks(
    target.itemKind,
    match,
    { id: match.id, label: match.label },
    match.text,
  )
  return {
    memberId: match.memberId,
    ...(match.id ? { sourceId: match.id } : {}),
    sourceLabel: match.label,
    sourceText: match.text,
    ...(blocks ? { blocks } : {}),
  }
}

function findSourceCandidateByIdentity(
  target: { memberId?: string; itemKind: string; id?: string; label?: string },
  candidates: DiffSourceCandidate[],
): DiffSourceCandidate | null {
  const memberScopedCandidates = candidates.filter((candidate) =>
    (!target.memberId || candidate.memberId === target.memberId)
  )

  if (target.id) {
    const exactKindMatches = uniqueByKey(
      memberScopedCandidates.filter((candidate) => candidate.id === target.id && candidate.itemKind === target.itemKind),
      (candidate) => `${candidate.memberId}\u241f${candidate.itemKind}\u241f${candidate.id ?? ''}\u241f${candidate.text}`
    )
    if (exactKindMatches.length === 1) return exactKindMatches[0]!

    const idMatches = uniqueByKey(
      memberScopedCandidates.filter((candidate) => candidate.id === target.id),
      (candidate) => `${candidate.memberId}\u241f${candidate.itemKind}\u241f${candidate.id ?? ''}\u241f${candidate.text}`
    )
    if (idMatches.length === 1) return idMatches[0]!
  }

  if (target.label) {
    const exactKindMatches = uniqueByKey(
      memberScopedCandidates.filter((candidate) => candidate.label === target.label && candidate.itemKind === target.itemKind),
      (candidate) => `${candidate.memberId}\u241f${candidate.itemKind}\u241f${candidate.id ?? ''}\u241f${candidate.text}`
    )
    if (exactKindMatches.length === 1) return exactKindMatches[0]!

    const labelMatches = uniqueByKey(
      memberScopedCandidates.filter((candidate) => candidate.label === target.label),
      (candidate) => `${candidate.memberId}\u241f${candidate.itemKind}\u241f${candidate.id ?? ''}\u241f${candidate.text}`
    )
    if (labelMatches.length === 1) return labelMatches[0]!
  }

  return null
}

function buildExplicitRefinementInspiration(
  itemKind: string,
  inspiration: NonNullable<RefinementChange['inspiration']>,
  sourceCandidates: DiffSourceCandidate[],
): UiRefinementDiffInspiration {
  const sourceCandidate = findSourceCandidateByIdentity(
    {
      memberId: inspiration.memberId,
      itemKind,
      id: inspiration.item.id,
      label: inspiration.item.label,
    },
    sourceCandidates,
  )

  const fallbackSourceText = buildFallbackRefinementSourceText(itemKind, inspiration.item)
  const blocks = resolveInspirationBlocks(
    itemKind,
    sourceCandidate,
    inspiration.item,
    sourceCandidate?.text ?? fallbackSourceText,
  )

  return {
    memberId: sourceCandidate?.memberId ?? inspiration.memberId ?? '',
    sourceId: inspiration.item.id,
    sourceLabel: inspiration.item.label,
    ...(sourceCandidate?.text || fallbackSourceText
      ? { sourceText: sourceCandidate?.text ?? fallbackSourceText }
      : {}),
    ...(blocks ? { blocks } : {}),
  }
}

function normalizeRefinementAttributionStatus(
  status: RefinementChangeAttributionStatus | undefined,
  inspiration: RefinementChange['inspiration'] | null,
): RefinementChangeAttributionStatus {
  if (
    status === 'inspired'
    || status === 'model_unattributed'
    || status === 'synthesized_unattributed'
    || status === 'invalid_unattributed'
  ) {
    return status
  }

  return inspiration ? 'inspired' : 'model_unattributed'
}

function buildFallbackRefinementItemText(
  item: NonNullable<RefinementChange['before'] | RefinementChange['after']> | null | undefined,
): string | undefined {
  const label = item?.label?.trim()
  if (!label) return undefined
  const detail = item?.detail?.trim()
  return detail ? `${label}\n\n${detail}` : label
}

function buildFallbackRefinementSourceText(
  itemKind: string,
  item: { label?: string; detail?: string } | null | undefined,
): string | undefined {
  const label = item?.label?.trim()
  if (!label) return undefined

  const detail = item?.detail?.trim()
  if (!detail) {
    return itemKind === 'epic' || itemKind === 'user_story' || itemKind === 'bead'
      ? `Title: ${label}`
      : label
  }

  if (itemKind === 'epic') {
    return `Title: ${label}\n\nObjective: ${detail}`
  }

  if (itemKind === 'bead') {
    return `Title: ${label}\n\nDescription: ${detail}`
  }

  if (itemKind === 'user_story') {
    return `Title: ${label}\n\nDetail: ${detail}`
  }

  return `${label}\n\n${detail}`
}

function buildBlockIdentityLookup(blocks: DiffCandidateBlock[]): Map<string, DiffCandidateBlock> {
  const lookup = new Map<string, DiffCandidateBlock>()
  for (const block of blocks) {
    if (!block.id) continue
    lookup.set(`${block.itemKind}\u241f${block.id}`, block)
  }
  return lookup
}

function resolveRefinementChangeInspiration(params: {
  change: RefinementChange
  itemKind: string
  afterText?: string
  sourceCandidates: DiffSourceCandidate[]
}): {
  inspiration: UiRefinementDiffInspiration | null
  attributionStatus: RefinementChangeAttributionStatus
} {
  const attributionStatus = normalizeRefinementAttributionStatus(
    params.change.attributionStatus,
    params.change.inspiration ?? null,
  )

  if (params.change.inspiration) {
    return {
      inspiration: buildExplicitRefinementInspiration(
        params.itemKind,
        params.change.inspiration,
        params.sourceCandidates,
      ),
      attributionStatus: 'inspired',
    }
  }

  if (
    params.change.type === 'removed'
    || attributionStatus === 'invalid_unattributed'
    || attributionStatus === 'synthesized_unattributed'
  ) {
    return {
      inspiration: null,
      attributionStatus,
    }
  }

  const deterministicInspiration = findDeterministicInspiration(
    {
      itemKind: params.itemKind,
      text: params.afterText ?? null,
    },
    params.sourceCandidates,
  )

  return {
    inspiration: deterministicInspiration,
    attributionStatus: deterministicInspiration ? 'inspired' : attributionStatus,
  }
}

function buildDiffEntry(
  params: {
    key: string
    changeType: UiRefinementDiffChangeType
    itemKind: string
    label: string
    beforeId?: string
    afterId?: string
    beforeText?: string
    afterText?: string
  },
  sourceCandidates: DiffSourceCandidate[],
): UiRefinementDiffEntry {
  const inspiration = params.changeType === 'removed'
    ? null
    : findDeterministicInspiration(
        {
          itemKind: params.itemKind,
          text: params.afterText ?? null,
        },
        sourceCandidates,
      )

  return {
    ...params,
    inspiration,
    attributionStatus: inspiration ? 'inspired' : 'model_unattributed',
  }
}

function normalizeInterviewQuestions(content: string): ParsedInterviewQuestion[] {
  return extractInterviewQuestionPreviews(content)
    .map((question, index) => ({
      id: question.id?.trim() || `${QUESTION_ID_FALLBACK_PREFIX}${String(index + 1).padStart(2, '0')}`,
      phase: question.phase?.trim() || '',
      question: question.question.trim(),
    }))
    .filter((question) => question.question.length > 0)
}

function formatInterviewQuestionDiffText(question: ParsedInterviewQuestion | null | undefined): string | undefined {
  if (!question) return undefined
  const text = question.question.trim()
  if (!text) return undefined
  return [question.phase.trim() ? `Phase: ${question.phase.trim()}` : '', text].filter(Boolean).join('\n')
}

function buildInterviewQuestionBlocks(content: string): DiffCandidateBlock[] {
  return normalizeInterviewQuestions(content).map((question) => ({
    key: `question:${question.id}`,
    itemKind: 'question',
    label: question.id,
    id: question.id,
    text: [question.phase ? `Phase: ${question.phase}` : '', question.question].filter(Boolean).join('\n'),
  }))
}

export function buildInterviewUiRefinementDiffArtifact(params: {
  winnerId: string
  winnerDraftContent: string
  refinedContent: string
  losingDrafts?: Array<{ memberId: string; content: string }>
  generatedAt?: string
}): UiRefinementDiffArtifact {
  const winnerQuestions = normalizeInterviewQuestions(params.winnerDraftContent)
  const refinedQuestions = normalizeInterviewQuestions(params.refinedContent)
  const losingDrafts = params.losingDrafts ?? []
  const sourceCandidates = buildSourceCandidates(losingDrafts, buildInterviewQuestionBlocks)

  const winnerById = new Map(winnerQuestions.map((question) => [question.id, question] as const))
  const consumedWinnerIds = new Set<string>()
  const consumedRefinedIds = new Set<string>()
  const entries: UiRefinementDiffEntry[] = []

  for (const refinedQuestion of refinedQuestions) {
    const winnerQuestion = winnerById.get(refinedQuestion.id)
    if (!winnerQuestion) continue
    consumedWinnerIds.add(winnerQuestion.id)
    consumedRefinedIds.add(refinedQuestion.id)

    if (
      winnerQuestion.question === refinedQuestion.question
      && (winnerQuestion.phase || '') === (refinedQuestion.phase || '')
    ) {
      continue
    }

    entries.push(
      buildDiffEntry(
        {
          key: `question:${refinedQuestion.id}:modified`,
          changeType: 'modified',
          itemKind: 'question',
          label: refinedQuestion.id,
          beforeId: winnerQuestion.id,
          afterId: refinedQuestion.id,
          beforeText: formatInterviewQuestionDiffText(winnerQuestion),
          afterText: formatInterviewQuestionDiffText(refinedQuestion),
        },
        sourceCandidates,
      ),
    )
  }

  const unmatchedWinner = winnerQuestions.filter((question) => !consumedWinnerIds.has(question.id))
  const unmatchedRefined = refinedQuestions.filter((question) => !consumedRefinedIds.has(question.id))
  const replacementCount = Math.min(unmatchedWinner.length, unmatchedRefined.length)

  for (let index = 0; index < replacementCount; index += 1) {
    const before = unmatchedWinner[index]!
    const after = unmatchedRefined[index]!
    entries.push(
      buildDiffEntry(
        {
          key: `question:${before.id}->${after.id}:replaced:${index}`,
          changeType: 'replaced',
          itemKind: 'question',
          label: after.id,
          beforeId: before.id,
          afterId: after.id,
          beforeText: formatInterviewQuestionDiffText(before),
          afterText: formatInterviewQuestionDiffText(after),
        },
        sourceCandidates,
      ),
    )
  }

  for (const [index, question] of unmatchedRefined.slice(replacementCount).entries()) {
    entries.push(
      buildDiffEntry(
        {
          key: `question:${question.id}:added:${index}`,
          changeType: 'added',
          itemKind: 'question',
          label: question.id,
          afterId: question.id,
          afterText: formatInterviewQuestionDiffText(question),
        },
        sourceCandidates,
      ),
    )
  }

  for (const [index, question] of unmatchedWinner.slice(replacementCount).entries()) {
    entries.push(
      buildDiffEntry(
        {
          key: `question:${question.id}:removed:${index}`,
          changeType: 'removed',
          itemKind: 'question',
          label: question.id,
          beforeId: question.id,
          beforeText: formatInterviewQuestionDiffText(question),
        },
        sourceCandidates,
      ),
    )
  }

  return {
    domain: 'interview',
    winnerId: params.winnerId.trim(),
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    entries,
  }
}

function shouldDropNoOpUiRefinementDiffEntry(
  changeType: string,
  beforeText: string | undefined,
  afterText: string | undefined,
): boolean {
  if (changeType !== 'modified' && changeType !== 'replaced') return false
  if (typeof beforeText !== 'string' || typeof afterText !== 'string') return false
  return beforeText.trim() === afterText.trim()
}

export function buildInterviewUiRefinementDiffArtifactFromChanges(params: {
  winnerId: string
  changes: InterviewQuestionChange[]
  generatedAt?: string
}): UiRefinementDiffArtifact {
  const entries = params.changes.flatMap((change, index) => {
    const changeType = typeof change?.type === 'string' ? change.type.toLowerCase() : ''
    if (
      changeType !== 'modified'
      && changeType !== 'replaced'
      && changeType !== 'added'
      && changeType !== 'removed'
    ) {
      return []
    }

    const before = change.before ?? null
    const after = change.after ?? null
    const label = after?.id || before?.id || `Q${String(index + 1).padStart(2, '0')}`
    const beforeText = formatInterviewQuestionDiffText(before)
    const afterText = formatInterviewQuestionDiffText(after)
    if (shouldDropNoOpUiRefinementDiffEntry(changeType, beforeText, afterText)) {
      return []
    }
    const inspiration = change.inspiration
      ? {
          memberId: change.inspiration.memberId ?? '',
          ...(change.inspiration.question?.id ? { sourceId: change.inspiration.question.id } : {}),
          sourceLabel: change.inspiration.question?.id ?? change.inspiration.question?.question ?? label,
          ...(change.inspiration.question?.question
            ? { sourceText: change.inspiration.question.question }
            : {}),
        }
      : null

    return [{
      key: `${label}:${changeType}:${index}`,
      changeType,
      itemKind: 'question',
      label,
      ...(before?.id ? { beforeId: before.id } : {}),
      ...(after?.id ? { afterId: after.id } : {}),
      ...(beforeText ? { beforeText } : {}),
      ...(afterText ? { afterText } : {}),
      inspiration,
      attributionStatus: change.attributionStatus ?? (inspiration ? 'inspired' : 'model_unattributed'),
    } satisfies UiRefinementDiffEntry]
  })

  return {
    domain: 'interview',
    winnerId: params.winnerId.trim(),
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    entries,
  }
}

function buildRefinementUiRefinementDiffArtifactFromChanges(params: {
  domain: 'prd' | 'beads'
  winnerId: string
  changes: RefinementChange[]
  winnerBlocks: DiffCandidateBlock[]
  refinedBlocks: DiffCandidateBlock[]
  sourceCandidates: DiffSourceCandidate[]
  generatedAt?: string
}): UiRefinementDiffArtifact {
  const winnerLookup = buildBlockIdentityLookup(params.winnerBlocks)
  const refinedLookup = buildBlockIdentityLookup(params.refinedBlocks)

  const entries = params.changes.flatMap((change, index) => {
    const changeType = typeof change?.type === 'string' ? change.type.toLowerCase() : ''
    if (changeType !== 'modified' && changeType !== 'added' && changeType !== 'removed') {
      return []
    }

    const itemKind = typeof change.itemType === 'string' && change.itemType.trim()
      ? change.itemType.trim()
      : 'item'
    const before = change.before ?? null
    const after = change.after ?? null
    const beforeBlock = before?.id ? winnerLookup.get(`${itemKind}\u241f${before.id}`) : undefined
    const afterBlock = after?.id ? refinedLookup.get(`${itemKind}\u241f${after.id}`) : undefined
    const beforeText = beforeBlock?.text ?? buildFallbackRefinementItemText(before)
    const afterText = afterBlock?.text ?? buildFallbackRefinementItemText(after)
    if (shouldDropNoOpUiRefinementDiffEntry(changeType, beforeText, afterText)) {
      return []
    }
    const { inspiration, attributionStatus } = resolveRefinementChangeInspiration({
      change,
      itemKind,
      afterText,
      sourceCandidates: params.sourceCandidates,
    })
    const fallbackId = after?.id ?? before?.id ?? `${index + 1}`
    const key = afterBlock?.key
      ?? beforeBlock?.key
      ?? `${itemKind}:${fallbackId}:${changeType}:${index}`

    return [{
      key,
      changeType,
      itemKind,
      label: afterBlock?.label ?? beforeBlock?.label ?? after?.label ?? before?.label ?? fallbackId,
      ...(beforeBlock?.id ?? before?.id ? { beforeId: beforeBlock?.id ?? before?.id } : {}),
      ...(afterBlock?.id ?? after?.id ? { afterId: afterBlock?.id ?? after?.id } : {}),
      ...(beforeText ? { beforeText } : {}),
      ...(afterText ? { afterText } : {}),
      inspiration,
      attributionStatus,
    } satisfies UiRefinementDiffEntry]
  })

  return {
    domain: params.domain,
    winnerId: params.winnerId.trim(),
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    entries,
  }
}

function parsePrdDocument(content: string): ParsedPrdDocument | null {
  return readYamlRecord<ParsedPrdDocument>(content)
}

function buildPrdBlocks(content: string): DiffCandidateBlock[] {
  const document = parsePrdDocument(content)
  if (!document) return []

  const blocks: DiffCandidateBlock[] = []

  if (typeof document.product?.problem_statement === 'string' && document.product.problem_statement.trim()) {
    blocks.push({
      key: 'product.problem_statement',
      itemKind: 'product.problem_statement',
      label: 'Problem Statement',
      text: document.product.problem_statement.trim(),
    })
  }

  if (normalizeStringArray(document.product?.target_users).length > 0) {
    blocks.push({
      key: 'product.target_users',
      itemKind: 'product.target_users',
      label: 'Target Users',
      text: renderList(document.product?.target_users),
    })
  }

  if (normalizeStringArray(document.scope?.in_scope).length > 0) {
    blocks.push({
      key: 'scope.in_scope',
      itemKind: 'scope.in_scope',
      label: 'In Scope',
      text: renderList(document.scope?.in_scope),
    })
  }

  if (normalizeStringArray(document.scope?.out_of_scope).length > 0) {
    blocks.push({
      key: 'scope.out_of_scope',
      itemKind: 'scope.out_of_scope',
      label: 'Out of Scope',
      text: renderList(document.scope?.out_of_scope),
    })
  }

  for (const section of PRD_TECHNICAL_SECTION_CONFIG) {
    if (normalizeStringArray(document.technical_requirements?.[section.key]).length === 0) continue
    blocks.push({
      key: section.itemKind,
      itemKind: section.itemKind,
      label: section.label,
      text: renderList(document.technical_requirements?.[section.key]),
    })
  }

  if (normalizeStringArray(document.risks).length > 0) {
    blocks.push({
      key: 'risks',
      itemKind: 'risks',
      label: 'Risks',
      text: renderList(document.risks),
    })
  }

  for (const epic of document.epics ?? []) {
    if (!epic?.id || !epic.title?.trim()) continue
    const epicText = [
      `Title: ${epic.title.trim()}`,
      epic.objective?.trim() ? `Objective: ${epic.objective.trim()}` : '',
      epic.implementation_steps?.length
        ? renderNamedSection('Implementation Steps', renderList(epic.implementation_steps))
        : '',
    ].filter(Boolean).join('\n\n')
    const epicInspirationBlock = buildInspirationBlock(
      'epic',
      epic.title.trim(),
      epicText,
      epic.id,
    )
    blocks.push({
      key: `epic:${epic.id}`,
      itemKind: 'epic',
      label: epic.title.trim(),
      id: epic.id,
      text: epicText,
      inspirationBlocks: [epicInspirationBlock],
    })

    for (const story of epic.user_stories ?? []) {
      if (!story?.id || !story.title?.trim()) continue
      const storyText = [
        `Title: ${story.title.trim()}`,
        story.acceptance_criteria?.length
          ? renderNamedSection('Acceptance Criteria', renderList(story.acceptance_criteria))
          : '',
        story.implementation_steps?.length
          ? renderNamedSection('Implementation Steps', renderList(story.implementation_steps))
          : '',
        story.verification?.required_commands?.length
          ? renderNamedSection('Verification Commands', renderList(story.verification.required_commands.map((command) => renderCommandSpec(command))))
          : '',
      ].filter(Boolean).join('\n\n')
      blocks.push({
        key: `user_story:${story.id}`,
        itemKind: 'user_story',
        label: story.title.trim(),
        id: story.id,
        text: storyText,
        inspirationBlocks: [
          epicInspirationBlock,
          buildInspirationBlock('user_story', story.title.trim(), storyText, story.id),
        ],
      })
    }
  }

  return blocks
}

function buildBlockDiffEntries(
  beforeBlocks: DiffCandidateBlock[],
  afterBlocks: DiffCandidateBlock[],
  sourceCandidates: DiffSourceCandidate[],
): UiRefinementDiffEntry[] {
  const beforeByKey = new Map(beforeBlocks.map((block) => [block.key, block] as const))
  const afterByKey = new Map(afterBlocks.map((block) => [block.key, block] as const))
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])]
  const entries: UiRefinementDiffEntry[] = []

  for (const key of keys) {
    const before = beforeByKey.get(key)
    const after = afterByKey.get(key)
    if (before && after) {
      if (before.text.trim() === after.text.trim()) continue
      entries.push(
        buildDiffEntry(
          {
            key,
            changeType: 'modified',
            itemKind: after.itemKind,
            label: after.label,
            beforeId: before.id,
            afterId: after.id,
            beforeText: before.text,
            afterText: after.text,
          },
          sourceCandidates,
        ),
      )
      continue
    }

    if (after) {
      entries.push(
        buildDiffEntry(
          {
            key,
            changeType: 'added',
            itemKind: after.itemKind,
            label: after.label,
            afterId: after.id,
            afterText: after.text,
          },
          sourceCandidates,
        ),
      )
      continue
    }

    if (before) {
      entries.push(
        buildDiffEntry(
          {
            key,
            changeType: 'removed',
            itemKind: before.itemKind,
            label: before.label,
            beforeId: before.id,
            beforeText: before.text,
          },
          sourceCandidates,
        ),
      )
    }
  }

  return entries
}

export function buildPrdUiRefinementDiffArtifact(params: {
  winnerId: string
  winnerDraftContent: string
  refinedContent: string
  losingDrafts?: Array<{ memberId: string; content: string }>
  generatedAt?: string
}): UiRefinementDiffArtifact {
  const winnerBlocks = buildPrdBlocks(params.winnerDraftContent)
  const refinedBlocks = buildPrdBlocks(params.refinedContent)
  const sourceCandidates = buildSourceCandidates(params.losingDrafts ?? [], buildPrdBlocks)

  return {
    domain: 'prd',
    winnerId: params.winnerId.trim(),
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    entries: buildBlockDiffEntries(winnerBlocks, refinedBlocks, sourceCandidates),
  }
}

export function buildPrdUiRefinementDiffArtifactFromChanges(params: {
  winnerId: string
  changes: RefinementChange[]
  winnerDraftContent: string
  refinedContent: string
  losingDrafts?: Array<{ memberId: string; content: string }>
  generatedAt?: string
}): UiRefinementDiffArtifact {
  const winnerBlocks = buildPrdBlocks(params.winnerDraftContent)
  const refinedBlocks = buildPrdBlocks(params.refinedContent)
  const sourceCandidates = buildSourceCandidates(params.losingDrafts ?? [], buildPrdBlocks)

  return buildRefinementUiRefinementDiffArtifactFromChanges({
    domain: 'prd',
    winnerId: params.winnerId,
    changes: params.changes,
    winnerBlocks,
    refinedBlocks,
    sourceCandidates,
    generatedAt: params.generatedAt,
  })
}

function parseBeadSubsetContent(content: string): ParsedBeadSubset[] {
  const parsed = readYamlArray<ParsedBeadSubset>(content)
  return Array.isArray(parsed) ? parsed : []
}

function buildBeadText(bead: ParsedBeadSubset): string {
  return [
    bead.title?.trim() ? `Title: ${bead.title.trim()}` : '',
    normalizeStringArray(bead.prdRefs).length
      ? renderNamedSection('PRD References', renderList(bead.prdRefs))
      : '',
    bead.description?.trim() ? `Description: ${bead.description.trim()}` : '',
    bead.contextGuidance
      ? typeof bead.contextGuidance === 'string'
        ? bead.contextGuidance.trim() ? `Context Guidance: ${bead.contextGuidance.trim()}` : ''
        : [
            ...(bead.contextGuidance.patterns?.length ? [`Patterns: ${bead.contextGuidance.patterns.join(', ')}`] : []),
            ...(bead.contextGuidance.anti_patterns?.length ? [`Anti-patterns: ${bead.contextGuidance.anti_patterns.join(', ')}`] : []),
          ].join('\n') || ''
      : '',
    normalizeStringArray(bead.acceptanceCriteria).length
      ? renderNamedSection('Acceptance Criteria', renderList(bead.acceptanceCriteria))
      : '',
    normalizeStringArray(bead.tests).length
      ? renderNamedSection('Tests', renderList(bead.tests))
      : '',
    bead.testCommands?.length
      ? renderNamedSection('Test Commands', renderList(bead.testCommands.map((command) => renderCommandSpec(command))))
      : '',
  ].filter(Boolean).join('\n\n')
}

function buildPrdReferenceLookup(content: string): Map<string, UiRefinementDiffInspirationBlock> {
  const lookup = new Map<string, UiRefinementDiffInspirationBlock>()
  for (const block of buildPrdBlocks(content)) {
    if (
      !block.id
      || !block.inspirationBlocks?.length
      || (block.itemKind !== 'epic' && block.itemKind !== 'user_story')
    ) {
      continue
    }
    const primaryBlock = block.inspirationBlocks[block.inspirationBlocks.length - 1]
    if (!primaryBlock) continue
    lookup.set(`${block.itemKind}\u241f${block.id}`, primaryBlock)
  }
  return lookup
}

function extractPrdReferenceIds(prdRefs: string[] | undefined): Array<{
  kind: 'epic' | 'user_story'
  id: string
}> {
  const results: Array<{ kind: 'epic' | 'user_story'; id: string }> = []
  const seen = new Set<string>()

  for (const reference of normalizeStringArray(prdRefs)) {
    const matches = reference.match(/\b(?:EPIC|US)-[A-Za-z0-9-]+\b/g) ?? []
    for (const match of matches) {
      const kind = match.startsWith('EPIC-') ? 'epic' : 'user_story'
      const key = `${kind}\u241f${match}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({ kind, id: match })
    }
  }

  return results
}

function buildBeadInspirationBlocks(
  bead: ParsedBeadSubset,
  prdReferenceLookup?: Map<string, UiRefinementDiffInspirationBlock>,
): UiRefinementDiffInspirationBlock[] {
  const title = bead.title?.trim()
  const id = bead.id?.trim()
  if (!title || !id) return []

  const beadText = buildBeadText(bead)
  const blocks: UiRefinementDiffInspirationBlock[] = [
    buildInspirationBlock('bead', title, beadText, id),
  ]

  if (!prdReferenceLookup || prdReferenceLookup.size === 0) {
    return blocks
  }

  const seen = new Set<string>([`bead\u241f${id}`])
  for (const reference of extractPrdReferenceIds(bead.prdRefs)) {
    const block = prdReferenceLookup.get(`${reference.kind}\u241f${reference.id}`)
    if (!block) continue
    const key = `${block.kind}\u241f${block.id ?? block.label}`
    if (seen.has(key)) continue
    seen.add(key)
    blocks.push({ ...block })
  }

  return blocks
}

function buildBeadBlocks(
  content: string,
  prdReferenceLookup?: Map<string, UiRefinementDiffInspirationBlock>,
): DiffCandidateBlock[] {
  return parseBeadSubsetContent(content)
    .filter((bead) => bead.id?.trim() && bead.title?.trim())
    .map((bead) => ({
      key: `bead:${bead.id!.trim()}`,
      itemKind: 'bead',
      label: bead.title!.trim(),
      id: bead.id!.trim(),
      text: buildBeadText(bead),
      inspirationBlocks: buildBeadInspirationBlocks(bead, prdReferenceLookup),
    }))
}

export function buildBeadsUiRefinementDiffArtifact(params: {
  winnerId: string
  winnerDraftContent: string
  refinedContent: string
  losingDrafts?: Array<{ memberId: string; content: string }>
  prdContent?: string
  generatedAt?: string
}): UiRefinementDiffArtifact {
  const prdReferenceLookup = params.prdContent ? buildPrdReferenceLookup(params.prdContent) : undefined
  const winnerBlocks = buildBeadBlocks(params.winnerDraftContent, prdReferenceLookup)
  const refinedBlocks = buildBeadBlocks(params.refinedContent, prdReferenceLookup)
  const sourceCandidates = buildSourceCandidates(
    params.losingDrafts ?? [],
    (content) => buildBeadBlocks(content, prdReferenceLookup),
  )

  return {
    domain: 'beads',
    winnerId: params.winnerId.trim(),
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    entries: buildBlockDiffEntries(winnerBlocks, refinedBlocks, sourceCandidates),
  }
}

export function buildBeadsUiRefinementDiffArtifactFromChanges(params: {
  winnerId: string
  changes: RefinementChange[]
  winnerDraftContent: string
  refinedContent: string
  losingDrafts?: Array<{ memberId: string; content: string }>
  prdContent?: string
  generatedAt?: string
}): UiRefinementDiffArtifact {
  const prdReferenceLookup = params.prdContent ? buildPrdReferenceLookup(params.prdContent) : undefined
  const winnerBlocks = buildBeadBlocks(params.winnerDraftContent, prdReferenceLookup)
  const refinedBlocks = buildBeadBlocks(params.refinedContent, prdReferenceLookup)
  const sourceCandidates = buildSourceCandidates(
    params.losingDrafts ?? [],
    (content) => buildBeadBlocks(content, prdReferenceLookup),
  )

  return buildRefinementUiRefinementDiffArtifactFromChanges({
    domain: 'beads',
    winnerId: params.winnerId,
    changes: params.changes,
    winnerBlocks,
    refinedBlocks,
    sourceCandidates,
    generatedAt: params.generatedAt,
  })
}

export function parseUiRefinementDiffArtifact(content: string | null | undefined): UiRefinementDiffArtifact | null {
  if (typeof content !== 'string' || !content.trim()) return null

  try {
    const parsed = JSON.parse(content) as unknown
    if (!isRecord(parsed)) return null
    if (parsed.domain !== 'interview' && parsed.domain !== 'prd' && parsed.domain !== 'beads') return null
    if (typeof parsed.winnerId !== 'string') return null
    if (typeof parsed.generatedAt !== 'string') return null
    if (!Array.isArray(parsed.entries)) return null

    const normalizeInspirationBlocks = (value: unknown): UiRefinementDiffInspirationBlock[] | undefined => {
      if (!Array.isArray(value)) return undefined
      const blocks = value.flatMap((block) => {
        if (!isRecord(block)) return []
        const kind = block.kind
        if (kind !== 'epic' && kind !== 'user_story' && kind !== 'bead') return []
        if (typeof block.label !== 'string' || typeof block.text !== 'string') return []
        return [{
          kind,
          label: block.label,
          text: block.text,
          ...(typeof block.id === 'string' ? { id: block.id } : {}),
        } satisfies UiRefinementDiffInspirationBlock]
      })
      return blocks.length > 0 ? blocks : undefined
    }

    const entries = parsed.entries
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .flatMap((entry) => {
        const changeType = entry.changeType
        if (
          changeType !== 'modified'
          && changeType !== 'replaced'
          && changeType !== 'added'
          && changeType !== 'removed'
        ) {
          return []
        }
        const itemKind = typeof entry.itemKind === 'string' ? entry.itemKind : ''
        const key = typeof entry.key === 'string' ? entry.key : ''
        const label = typeof entry.label === 'string' ? entry.label : ''
        const attributionStatus = entry.attributionStatus
        if (
          attributionStatus !== 'inspired'
          && attributionStatus !== 'model_unattributed'
          && attributionStatus !== 'synthesized_unattributed'
          && attributionStatus !== 'invalid_unattributed'
        ) {
          return []
        }
        const inspiration = isRecord(entry.inspiration) && typeof entry.inspiration.memberId === 'string' && typeof entry.inspiration.sourceLabel === 'string'
          ? (() => {
              const blocks = normalizeInspirationBlocks(entry.inspiration.blocks)
              return {
              memberId: entry.inspiration.memberId,
              sourceLabel: entry.inspiration.sourceLabel,
              ...(typeof entry.inspiration.sourceId === 'string' ? { sourceId: entry.inspiration.sourceId } : {}),
              ...(typeof entry.inspiration.sourceText === 'string' ? { sourceText: entry.inspiration.sourceText } : {}),
              ...(blocks ? { blocks } : {}),
            }
            })()
          : null

        return [{
          key,
          changeType,
          itemKind,
          label,
          ...(typeof entry.beforeId === 'string' ? { beforeId: entry.beforeId } : {}),
          ...(typeof entry.afterId === 'string' ? { afterId: entry.afterId } : {}),
          ...(typeof entry.beforeText === 'string' ? { beforeText: entry.beforeText } : {}),
          ...(typeof entry.afterText === 'string' ? { afterText: entry.afterText } : {}),
          inspiration,
          attributionStatus,
        } satisfies UiRefinementDiffEntry]
      })

    return {
      domain: parsed.domain,
      winnerId: parsed.winnerId,
      generatedAt: parsed.generatedAt,
      entries,
    }
  } catch {
    return null
  }
}
