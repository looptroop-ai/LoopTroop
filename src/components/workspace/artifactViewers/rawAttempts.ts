import type { LogEntry } from '@/context/logUtils'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import { buildReadableRawDisplayContent } from '../rawDisplayContent'
import { normalizeRawAttempts, tryParseStructuredContent } from '../phaseArtifactTypes'
import type {
  ArtifactRawAttemptData,
  ArtifactStructuredOutputData,
  CouncilDraftData,
  CouncilOutcome,
  CouncilVoterDetailData,
} from '../phaseArtifactTypes'
import type { RawContentSource, RawContentVariant } from './rawContentSources'

/**
 * Raw model attempts: turning the stored attempt list into the variants the raw
 * tab offers, and recovering a rejected attempt's text from the phase logs when
 * the artifact did not keep it.
 *
 * Shared by the council, coverage, execution-setup, refinement, relevant-files
 * and final-test views, so it lives beside them rather than in the dispatcher
 * module they are all imported from.
 */

export function hasStructuredRetryMetadata(structuredOutput?: ArtifactStructuredOutputData): boolean {
  return Boolean(
    (structuredOutput?.autoRetryCount ?? 0) > 0
    || (structuredOutput?.retryDiagnostics?.length ?? 0) > 0,
  )
}

export function normalizeRawOutputForComparison(value: string): string {
  return value.replace(/\s+$/g, '')
}

export function findRejectedRawOutput(history: string[] | undefined, currentRawResponse?: string): string | undefined {
  if (!history || history.length < 2) return undefined

  if (typeof currentRawResponse === 'string') {
    const current = normalizeRawOutputForComparison(currentRawResponse)
    const currentIndex = history
      .map(normalizeRawOutputForComparison)
      .lastIndexOf(current)
    if (currentIndex > 0) return history[currentIndex - 1]
    if (currentIndex === 0) return undefined
  }

  return history[history.length - 2]
}

export function getRawAttemptContent(attempt: ArtifactRawAttemptData): string | undefined {
  const content = attempt.rawResponse ?? attempt.modelOutput ?? attempt.content
  if (typeof content === 'string' && content.length > 0) return content
  const diagnostic = attempt.validationError ?? attempt.error
  if (!diagnostic) return undefined
  return [
    'No model response was captured for this attempt.',
    '',
    `Error: ${diagnostic}`,
    attempt.failureClass ? `Failure class: ${attempt.failureClass}` : '',
  ].filter(Boolean).join('\n')
}

export function getRawAttemptsFromContent(content: string): ArtifactRawAttemptData[] | undefined {
  const parsed = tryParseStructuredContent(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  return normalizeRawAttempts(record.rawAttempts ?? record.raw_attempts)
}

export function getRawAttemptStatus(attempt: ArtifactRawAttemptData): string | undefined {
  return attempt.status ?? attempt.outcome
}

export function isValidatedRawAttemptStatus(status: string | undefined): boolean {
  const normalized = status?.toLowerCase()
  return normalized === 'accepted' || normalized === 'completed' || normalized === 'validated'
}

export function formatRawAttemptStatusLabel(status: string | undefined): string {
  const normalized = status?.toLowerCase()
  if (normalized === 'rejected' || normalized === 'invalid_output' || normalized === 'failed' || normalized === 'timed_out') return 'Rejected'
  if (normalized === 'accepted' || normalized === 'completed') return 'Accepted'
  if (normalized === 'validated') return 'Validated'
  return ''
}

export function isRejectedRawAttempt(attempt: ArtifactRawAttemptData): boolean {
  const status = getRawAttemptStatus(attempt)?.toLowerCase()
  return status === 'rejected' || status === 'failed' || status === 'invalid_output' || status === 'timed_out' || Boolean(attempt.error || attempt.validationError)
}

export function hasRejectedRawAttempt(rawAttempts: ArtifactRawAttemptData[] | undefined): boolean {
  return rawAttempts?.some(isRejectedRawAttempt) ?? false
}

export function getRejectedRawAttempt(rawAttempts: ArtifactRawAttemptData[] | undefined): string | undefined {
  if (!rawAttempts) return undefined
  for (const attempt of [...rawAttempts].reverse()) {
    if (!isRejectedRawAttempt(attempt)) continue
    const content = getRawAttemptContent(attempt)
    if (typeof content === 'string') return content
  }
  return undefined
}

export function getRawAttemptNumber(attempt: ArtifactRawAttemptData, index: number): number {
  return typeof attempt.attempt === 'number' && Number.isFinite(attempt.attempt) && attempt.attempt > 0
    ? attempt.attempt
    : index + 1
}

export function getLatestValidatedRawAttemptNumber(rawAttempts: ArtifactRawAttemptData[] | undefined): number | undefined {
  const attempts = rawAttempts ?? []
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]
    if (attempt && isValidatedRawAttemptStatus(getRawAttemptStatus(attempt))) {
      return getRawAttemptNumber(attempt, index)
    }
  }
  return undefined
}

export function inferValidatedAttemptNumber(
  rawAttempts: ArtifactRawAttemptData[] | undefined,
  structuredOutput: ArtifactStructuredOutputData | undefined,
): number | undefined {
  const rawAttemptNumber = getLatestValidatedRawAttemptNumber(rawAttempts)
  if (typeof rawAttemptNumber === 'number') return rawAttemptNumber

  const autoRetryCount = structuredOutput?.autoRetryCount
  if (typeof autoRetryCount === 'number' && Number.isFinite(autoRetryCount) && autoRetryCount > 0) {
    return Math.trunc(autoRetryCount) + 1
  }

  return undefined
}

export function formatValidatedRawVariantLabel(
  rawAttempts: ArtifactRawAttemptData[] | undefined,
  structuredOutput: ArtifactStructuredOutputData | undefined,
): string {
  const attemptNumber = inferValidatedAttemptNumber(rawAttempts, structuredOutput)
  return typeof attemptNumber === 'number' ? `Attempt ${attemptNumber} Validated` : 'Validated'
}

export function inferRejectedRawVariantAttemptNumber(
  rawAttempts: ArtifactRawAttemptData[] | undefined,
  structuredOutput: ArtifactStructuredOutputData | undefined,
): number | undefined {
  if (hasRejectedRawAttempt(rawAttempts)) return undefined

  const autoRetryCount = structuredOutput?.autoRetryCount
  if (typeof autoRetryCount === 'number' && Number.isFinite(autoRetryCount) && autoRetryCount > 0) {
    return Math.trunc(autoRetryCount)
  }

  const diagnosticAttemptNumbers = structuredOutput?.retryDiagnostics
    ?.map((diagnostic) => diagnostic.attempt)
    .filter((attempt): attempt is number => Number.isInteger(attempt) && attempt > 0) ?? []
  if (diagnosticAttemptNumbers.length > 0) {
    return Math.max(...diagnosticAttemptNumbers)
  }

  const validatedAttemptNumber = inferValidatedAttemptNumber(rawAttempts, structuredOutput)
  return typeof validatedAttemptNumber === 'number' && validatedAttemptNumber > 1
    ? validatedAttemptNumber - 1
    : undefined
}

export function formatRejectedRawVariantLabel(
  rawAttempts: ArtifactRawAttemptData[] | undefined,
  structuredOutput: ArtifactStructuredOutputData | undefined,
): string {
  const attemptNumber = inferRejectedRawVariantAttemptNumber(rawAttempts, structuredOutput)
  return typeof attemptNumber === 'number' ? `Attempt ${attemptNumber} Output - Rejected` : 'Rejected'
}

export function buildRawAttemptVariants(
  ownerId: string,
  ownerLabel: string,
  rawAttempts: ArtifactRawAttemptData[] | undefined,
): RawContentVariant[] {
  const orderedAttempts = (rawAttempts ?? [])
    .map((attempt, index) => ({
      attempt,
      index,
      attemptNumber: getRawAttemptNumber(attempt, index),
    }))
    .sort((a, b) => a.attemptNumber - b.attemptNumber || a.index - b.index)
  const initialInput = orderedAttempts.find(({ attempt }) => typeof attempt.initialInput === 'string' && attempt.initialInput.length > 0)?.attempt.initialInput

  return [
    ...(typeof initialInput === 'string'
      ? [{
          id: `${ownerId}:initial-input`,
          label: 'Initial Prompt',
          content: initialInput,
          displayContent: initialInput,
          ariaLabel: `${ownerLabel} Initial Prompt`,
          title: `Show initial model prompt for ${ownerLabel}`,
          skipDedupe: true,
        }]
      : []),
    ...orderedAttempts.flatMap(({ attempt, index, attemptNumber }) => {
      const content = getRawAttemptContent(attempt)
      if (typeof content !== 'string') return []
      const status = getRawAttemptStatus(attempt)
      const statusLabel = formatRawAttemptStatusLabel(status)
      const baseLabel = `Attempt ${attemptNumber} Output`
      const attemptLabel = attempt.label ?? `${baseLabel}${statusLabel ? ` - ${statusLabel}` : ''}`
      const titleStatus = status ? ` · ${status}` : ''
      return [{
        id: `${ownerId}:attempt:${index}`,
        label: attemptLabel,
        content,
        displayContent: content,
        ariaLabel: `${ownerLabel} ${attemptLabel}`,
        title: `Show ${attemptLabel.toLowerCase()} raw output from ${ownerLabel}${titleStatus}`,
      }]
    }),
  ]
}

export function getRawVariantRenderedContent(variant: RawContentVariant): string | undefined {
  if (typeof variant.displayContent === 'string') return variant.displayContent
  if (typeof variant.content === 'string') return buildReadableRawDisplayContent(variant.content)
  return undefined
}

export function normalizeRawVariantComparisonContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trimEnd()
}

export function getRawVariantDedupPriority(variant: RawContentVariant): number {
  const label = variant.label.toLowerCase()
  if (/^attempt\s+\d+\s+validated/i.test(variant.label)) return 130
  if (variant.id.includes(':attempt:') || /^attempt\s+\d+/i.test(variant.label)) {
    if (label.includes('accepted')) return 120
    if (label.includes('rejected')) return 110
    return 100
  }
  if (label === 'rejected') return 80
  if (label === 'validated') return 70
  if (label === 'accepted output') return 60
  if (label === 'model output') return 20
  if (label === 'raw output') return 10
  return 50
}

export function dedupeRawContentVariants(variants: RawContentVariant[]): RawContentVariant[] {
  const byContent = new Map<string, { variant: RawContentVariant; index: number; priority: number }>()
  const unkeyed: Array<{ variant: RawContentVariant; index: number }> = []

  variants.forEach((variant, index) => {
    if (variant.skipDedupe) {
      unkeyed.push({ variant, index })
      return
    }

    const renderedContent = getRawVariantRenderedContent(variant)
    if (typeof renderedContent !== 'string') {
      unkeyed.push({ variant, index })
      return
    }

    const key = normalizeRawVariantComparisonContent(renderedContent)
    const priority = getRawVariantDedupPriority(variant)
    const existing = byContent.get(key)
    if (!existing || priority > existing.priority) {
      byContent.set(key, {
        variant,
        index,
        priority,
      })
    }
  })

  return [
    ...byContent.values(),
    ...unkeyed.map((entry) => ({ ...entry, priority: getRawVariantDedupPriority(entry.variant) })),
  ]
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.variant)
}

export function buildRawAttemptInspectionVariants(
  ownerId: string,
  ownerLabel: string,
  rawAttempts: ArtifactRawAttemptData[] | undefined,
): RawContentVariant[] {
  const attempts = rawAttempts ?? []
  const latestAcceptedAttempt = [...attempts].reverse().find((attempt) => getRawAttemptStatus(attempt)?.toLowerCase() === 'accepted')
  const latestAcceptedContent = latestAcceptedAttempt ? getRawAttemptContent(latestAcceptedAttempt) : undefined
  return dedupeRawContentVariants([
    ...(typeof latestAcceptedContent === 'string'
      ? [{
          id: `${ownerId}:accepted-latest`,
          label: 'Accepted Output',
          content: latestAcceptedContent,
          displayContent: latestAcceptedContent,
          title: `Show latest accepted raw output from ${ownerLabel}`,
        }]
      : []),
    ...buildRawAttemptVariants(ownerId, ownerLabel, rawAttempts),
  ])
}

export function formatRawAttemptSourceLabel(modeLabel: string, modelId?: string): string {
  const trimmedMode = modeLabel.trim()
  return modelId ? `${getModelDisplayName(modelId)} · ${trimmedMode}` : trimmedMode
}

export function buildRawAttemptSource(
  ownerId: string,
  modeLabel: string,
  rawAttempts: ArtifactRawAttemptData[] | undefined,
  modelId?: string,
): RawContentSource | undefined {
  const label = formatRawAttemptSourceLabel(modeLabel, modelId)
  const variants = buildRawAttemptInspectionVariants(ownerId, label, rawAttempts)
  if (variants.length === 0) return undefined

  return {
    id: ownerId,
    label,
    modelId,
    variants,
    disabled: !variants.some((variant) => !variant.disabled),
    title: `Show raw ${modeLabel.toLowerCase()} attempts${modelId ? ` from ${getModelDisplayName(modelId)}` : ''}`,
  }
}

export function buildRejectedRawVariant(
  id: string,
  label: string,
  rejectedRawResponse: string | undefined,
  variantLabel = 'Rejected',
): RawContentVariant {
  return {
    id,
    label: variantLabel,
    content: rejectedRawResponse,
    displayContent: rejectedRawResponse,
    disabled: typeof rejectedRawResponse !== 'string',
    ariaLabel: `${label} ${variantLabel}`,
    labelClassName: 'italic',
    title: typeof rejectedRawResponse === 'string'
      ? `Show ${variantLabel.toLowerCase()} pre-retry output from ${label}`
      : `${variantLabel} pre-retry output was not found in logs for ${label}`,
  }
}

export function getValidatedDraftContent(draft: CouncilDraftData): string | undefined {
  if (typeof draft.normalizedResponse === 'string') return draft.normalizedResponse
  if (isFailedCouncilDraftOutcome(draft.outcome)) return undefined
  if (typeof draft.content === 'string') return draft.content
  return undefined
}

export function buildValidatedDraftRawSources(draft: CouncilDraftData): RawContentSource[] | undefined {
  const validatedContent = getValidatedDraftContent(draft)
  if (typeof validatedContent !== 'string') return undefined

  const label = getModelDisplayName(draft.memberId)
  return [{
    id: `draft:${draft.memberId}`,
    label,
    modelId: draft.memberId,
    variants: [{
      id: `draft:${draft.memberId}:validated`,
      label: 'Validated',
      content: validatedContent,
      displayContent: validatedContent,
      ariaLabel: `${label} Validated`,
      title: `Show validated draft output from ${label}`,
    }],
    title: `Show validated draft output from ${label}`,
  }]
}

export function buildDraftRawSources(
  draft: CouncilDraftData,
  rejectedRawResponse?: string,
  options: { validatedOnly?: boolean } = {},
): RawContentSource[] | undefined {
  if (options.validatedOnly) return buildValidatedDraftRawSources(draft)

  const rawResponse = draft.rawResponse
  const normalizedResponse = draft.normalizedResponse ?? (
    draft.structuredOutput?.repairApplied && draft.content ? draft.content : undefined
  )
  const label = getModelDisplayName(draft.memberId)
  const rawAttemptVariants = buildRawAttemptVariants(`draft:${draft.memberId}`, label, draft.rawAttempts)
  const shouldShowRejected = hasStructuredRetryMetadata(draft.structuredOutput)
  if (typeof rawResponse !== 'string' && typeof normalizedResponse !== 'string' && rawAttemptVariants.length === 0 && !shouldShowRejected) return undefined
  const variants: RawContentVariant[] = [{
    id: `draft:${draft.memberId}:raw`,
    label: 'Raw Output',
    content: rawResponse,
    displayContent: rawResponse,
    disabled: typeof rawResponse !== 'string',
    ariaLabel: `${label} Raw Output`,
    title: typeof rawResponse === 'string'
      ? `Show raw model output from ${label}`
      : `No exact raw output stored for ${label}`,
  }]
  if (shouldShowRejected) {
    variants.push(buildRejectedRawVariant(
      `draft:${draft.memberId}:rejected`,
      label,
      getRejectedRawAttempt(draft.rawAttempts) ?? rejectedRawResponse,
      formatRejectedRawVariantLabel(draft.rawAttempts, draft.structuredOutput),
    ))
  }
  variants.push(...rawAttemptVariants)
  if (typeof normalizedResponse === 'string') {
    const validatedLabel = formatValidatedRawVariantLabel(draft.rawAttempts, draft.structuredOutput)
    variants.push({
      id: `draft:${draft.memberId}:validated`,
      label: validatedLabel,
      content: normalizedResponse,
      displayContent: normalizedResponse,
      ariaLabel: `${label} ${validatedLabel}`,
      title: `Show ${validatedLabel.toLowerCase()} output from ${label}`,
    })
  }
  const uniqueVariants = dedupeRawContentVariants(variants)
  return [{
    id: `draft:${draft.memberId}`,
    label,
    modelId: draft.memberId,
    variants: uniqueVariants,
    disabled: !uniqueVariants.some((v) => !v.disabled),
    title: typeof rawResponse === 'string'
      ? `Show raw model output from ${label}`
      : `No exact raw output stored for ${label}`,
  }]
}

export type DraftRawLogStage = 'draft' | 'full_answers' | 'prd_draft'

export type DraftRawLogFallbacks = Record<DraftRawLogStage, Map<string, string>>
export type DraftRawLogHistories = Record<DraftRawLogStage, Map<string, string[]>>

export function shouldReadDraftRawLogsForPhase(phase?: string): boolean {
  return phase === 'DRAFTING_PRD'
    || phase === 'DRAFTING_BEADS'
    || phase === 'COUNCIL_DELIBERATING'
    || phase === 'COUNCIL_DRAFTING_INTERVIEW'
}

export function shouldShowValidatedDraftRawOnly(phase?: string): boolean {
  return Boolean(phase) && !shouldReadDraftRawLogsForPhase(phase)
}

export function createEmptyDraftRawLogFallbacks(): DraftRawLogFallbacks {
  return {
    draft: new Map<string, string>(),
    full_answers: new Map<string, string>(),
    prd_draft: new Map<string, string>(),
  }
}

export function createEmptyDraftRawLogHistories(): DraftRawLogHistories {
  return {
    draft: new Map<string, string[]>(),
    full_answers: new Map<string, string[]>(),
    prd_draft: new Map<string, string[]>(),
  }
}

export function appendRawLogHistory(history: Map<string, string[]>, modelId: string, output: string) {
  const outputs = history.get(modelId) ?? []
  if (outputs[outputs.length - 1] === output) return
  history.set(modelId, [...outputs, output])
}

export function stripLogTag(line: string): string {
  return line.replace(/^\[[A-Z_]+\]\s*/, '')
}

export function getModelOutputFromLog(log: LogEntry): string | undefined {
  if (!log.line.startsWith('[MODEL] ')) return undefined
  const output = log.line.slice('[MODEL] '.length)
  if (!output.trim()) return undefined
  if (output.startsWith('[PROMPT]')) return undefined
  return output
}

export function updateDraftRawLogStage(
  stagesByMember: Map<string, DraftRawLogStage>,
  phase: string | undefined,
  log: LogEntry,
) {
  if (!log.modelId) return
  const line = stripLogTag(log.line)

  if (phase === 'DRAFTING_PRD') {
    if (line.includes(`${log.modelId} Full Answers started.`)) {
      stagesByMember.set(log.modelId, 'full_answers')
      return
    }
    if (line.includes(`${log.modelId} PRD draft started.`)) {
      stagesByMember.set(log.modelId, 'prd_draft')
      return
    }
    if (
      line.includes(`${log.modelId} Full Answers completed.`)
      || line.includes(`${log.modelId} Full Answers failed:`)
      || line.includes(`${log.modelId} PRD draft completed.`)
      || line.includes(`${log.modelId} PRD draft failed:`)
    ) {
      stagesByMember.delete(log.modelId)
    }
    return
  }

  if (phase === 'DRAFTING_BEADS') {
    if (line.includes(`${log.modelId} Beads draft`) || line.includes(`${log.modelId} draft`)) {
      stagesByMember.set(log.modelId, 'draft')
    }
    return
  }

  if (phase === 'COUNCIL_DELIBERATING' || phase === 'COUNCIL_DRAFTING_INTERVIEW') {
    stagesByMember.set(log.modelId, 'draft')
  }
}

export function buildDraftRawLogFallbacks(logs: LogEntry[], phase?: string): DraftRawLogFallbacks {
  const fallbacks = createEmptyDraftRawLogFallbacks()
  if (!shouldReadDraftRawLogsForPhase(phase)) return fallbacks

  const stagesByMember = new Map<string, DraftRawLogStage>()

  for (const log of logs) {
    updateDraftRawLogStage(stagesByMember, phase, log)
    if (!log.modelId) continue

    const output = getModelOutputFromLog(log)
    if (!output) continue

    const stage = stagesByMember.get(log.modelId)
      ?? (phase === 'DRAFTING_PRD' ? 'prd_draft' : 'draft')
    fallbacks[stage].set(log.modelId, output)
  }

  return fallbacks
}

export function buildDraftRawLogHistories(logs: LogEntry[], phase?: string): DraftRawLogHistories {
  const histories = createEmptyDraftRawLogHistories()
  if (!shouldReadDraftRawLogsForPhase(phase)) return histories

  const stagesByMember = new Map<string, DraftRawLogStage>()

  for (const log of logs) {
    updateDraftRawLogStage(stagesByMember, phase, log)
    if (!log.modelId) continue

    const output = getModelOutputFromLog(log)
    if (!output) continue

    const stage = stagesByMember.get(log.modelId)
      ?? (phase === 'DRAFTING_PRD' ? 'prd_draft' : 'draft')
    appendRawLogHistory(histories[stage], log.modelId, output)
  }

  return histories
}

export function getDraftRawLogStage(phase?: string, artifactId?: string): DraftRawLogStage {
  if (phase === 'DRAFTING_PRD') {
    return artifactId?.startsWith('prd-fullanswers-member-') ? 'full_answers' : 'prd_draft'
  }
  return 'draft'
}

export function getRejectedDraftRawResponse(
  draft: CouncilDraftData,
  phase: string | undefined,
  artifactId: string | undefined,
  histories: DraftRawLogHistories,
): string | undefined {
  if (!hasStructuredRetryMetadata(draft.structuredOutput)) return undefined
  const stage = getDraftRawLogStage(phase, artifactId)
  return findRejectedRawOutput(histories[stage].get(draft.memberId), draft.rawResponse)
}

export function withDraftRawLogFallback(
  draft: CouncilDraftData,
  phase: string | undefined,
  artifactId: string | undefined,
  fallbacks: DraftRawLogFallbacks,
): CouncilDraftData {
  if (typeof draft.rawResponse === 'string') return draft

  const stage = getDraftRawLogStage(phase, artifactId)
  const rawResponse = fallbacks[stage].get(draft.memberId)
  if (typeof rawResponse !== 'string') return draft

  const normalizedResponse = typeof draft.normalizedResponse === 'string'
    ? draft.normalizedResponse
    : typeof draft.content === 'string' && draft.content !== rawResponse
      ? draft.content
      : undefined

  return {
    ...draft,
    rawResponse,
    ...(typeof normalizedResponse === 'string' ? { normalizedResponse } : {}),
  }
}

export function buildVoteRawLogHistories(logs: LogEntry[], phase?: string): Map<string, string[]> {
  const histories = new Map<string, string[]>()
  if (!phase?.includes('VOTING')) return histories

  for (const log of logs) {
    if (!log.modelId) continue
    const output = getModelOutputFromLog(log)
    if (!output) continue
    appendRawLogHistory(histories, log.modelId, output)
  }

  return histories
}

export function getRejectedVoteRawResponse(
  voterId: string,
  detail: CouncilVoterDetailData | undefined,
  histories: Map<string, string[]>,
): string | undefined {
  if (!hasStructuredRetryMetadata(detail?.structuredOutput)) return undefined
  return findRejectedRawOutput(histories.get(voterId), detail?.rawResponse)
}

export function isFailedCouncilDraftOutcome(outcome?: CouncilOutcome): boolean {
  return outcome === 'invalid_output' || outcome === 'failed' || outcome === 'timed_out'
}
