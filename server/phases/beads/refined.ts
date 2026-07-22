import * as jsYaml from 'js-yaml'
import type {
  RefinementChange,
  RefinementChangeAttributionStatus,
  RefinementChangeItem,
} from '@shared/refinementChanges'
import { isRecord } from '@shared/typeGuards'
import type { PromptPart } from '../../opencode/types'
import type { StructuredOutputMetadata } from '../../structuredOutput'
import { normalizeBeadRefinementOutput } from '../../structuredOutput'
import { normalizeStructuredOutputMetadata } from '../../structuredOutput/metadata'
import { attachStructuredRetryDiagnostic, buildStructuredRetryDiagnostic } from '../../lib/structuredRetryDiagnostics'
import type { BeadSubset } from './types'

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface BeadsPipelineStep {
  step: string
  description: string
}

export interface BeadsDraftMetrics {
  beadCount: number
  totalTestCount: number
  totalAcceptanceCriteriaCount: number
}

export interface ValidatedBeadsRefinement {
  beadSubsets: BeadSubset[]
  metrics: BeadsDraftMetrics
  refinedContent: string
  winnerDraftContent: string
  changes: RefinementChange[]
  repairApplied: boolean
  repairWarnings: string[]
}

export interface BeadsRefinedArtifact {
  winnerId: string
  refinedContent: string
  winnerDraftContent: string
  changes?: RefinementChange[]
  structuredOutput?: StructuredOutputMetadata
  draftMetrics: BeadsDraftMetrics
  pipelineSteps: BeadsPipelineStep[]
}

// ---------------------------------------------------------------------------
// Pipeline step constants
// ---------------------------------------------------------------------------

export const BEADS_PIPELINE_STEPS: BeadsPipelineStep[] = [
  {
    step: 'blueprint_refine',
    description: 'Winner model refines its bead draft by incorporating improvements from losing drafts (PROM22). Analyzes alternative drafts for unhandled edge cases, better test coverage, cleaner decomposition, or missing constraints and selectively integrates improvements.',
  },
  {
    step: 'beads_expand',
    description: 'After beads coverage finishes, LoopTroop runs the final expansion step (PROM25). The validated semantic blueprint is expanded with AI-owned execution fields: id, issueType, labels, dependencies.blocked_by, and targetFiles. LoopTroop then hydrates the app-owned execution fields.',
  },
]

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface NormalizedBeadRefinementItem extends RefinementChangeItem {
  contentFingerprint: string
}

interface PreparedBeadRefinementChange {
  sourceIndex: number
  type: RefinementChange['type']
  before: RefinementChangeItem | null
  after: RefinementChangeItem | null
  canonicalBefore: NormalizedBeadRefinementItem | null
  canonicalAfter: NormalizedBeadRefinementItem | null
  inspiration: RefinementChange['inspiration'] | null
  attributionStatus: RefinementChangeAttributionStatus
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeFingerprintList(values: string[] | undefined): string[] {
  return Array.isArray(values)
    ? values
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
    : []
}

export function getBeadsDraftMetrics(beadSubsets: BeadSubset[]): BeadsDraftMetrics {
  let totalTestCount = 0
  let totalAcceptanceCriteriaCount = 0

  for (const bead of beadSubsets) {
    totalTestCount += bead.tests.length
    totalAcceptanceCriteriaCount += bead.acceptanceCriteria.length
  }

  return {
    beadCount: beadSubsets.length,
    totalTestCount,
    totalAcceptanceCriteriaCount,
  }
}

function buildBeadContentFingerprint(bead: BeadSubset): string {
  return JSON.stringify({
    title: bead.title.trim(),
    description: bead.description.trim(),
    acceptanceCriteria: normalizeFingerprintList(bead.acceptanceCriteria),
    tests: normalizeFingerprintList(bead.tests),
    testCommands: bead.testCommands,
    testCommandReason: bead.testCommandReason ?? '',
  })
}

function buildBeadItemFromSubset(bead: BeadSubset): NormalizedBeadRefinementItem {
  return {
    id: bead.id,
    label: bead.title,
    ...(bead.description ? { detail: bead.description } : {}),
    contentFingerprint: buildBeadContentFingerprint(bead),
  }
}

function buildBeadItemContentKey(item: Pick<NormalizedBeadRefinementItem, 'id' | 'contentFingerprint'>): string {
  return `bead\x1f${item.id}\x1f${item.contentFingerprint}`
}

function buildBeadItemLookup(items: NormalizedBeadRefinementItem[]) {
  const byId = new Map<string, NormalizedBeadRefinementItem>()
  const byLabel = new Map<string, NormalizedBeadRefinementItem[]>()
  const byContentFingerprint = new Map<string, NormalizedBeadRefinementItem>()

  for (const item of items) {
    byId.set(item.id, item)

    const labelKey = item.label.toLowerCase().trim()
    const labelMatches = byLabel.get(labelKey) ?? []
    labelMatches.push(item)
    byLabel.set(labelKey, labelMatches)

    byContentFingerprint.set(buildBeadItemContentKey(item), item)
  }

  return { byId, byLabel, byContentFingerprint }
}

function cloneCanonicalItem(item: NormalizedBeadRefinementItem): RefinementChangeItem {
  return item.detail
    ? { id: item.id, label: item.label, detail: item.detail }
    : { id: item.id, label: item.label }
}

// ---------------------------------------------------------------------------
// Attribution helpers
// ---------------------------------------------------------------------------

function normalizeAttributionStatus(
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

function sameRefinementInspiration(
  left: RefinementChange['inspiration'] | null,
  right: RefinementChange['inspiration'] | null,
): boolean {
  if (!left && !right) return true
  if (!left || !right) return false

  return left.draftIndex === right.draftIndex
    && left.memberId === right.memberId
    && left.item.id === right.item.id
    && left.item.label === right.item.label
    && (left.item.detail ?? '') === (right.item.detail ?? '')
}

// ---------------------------------------------------------------------------
// Change deduplication
// ---------------------------------------------------------------------------

function buildDuplicateModifiedBeadChangeKey(change: PreparedBeadRefinementChange): string | null {
  if (change.type !== 'modified' || !change.canonicalBefore || !change.canonicalAfter) {
    return null
  }

  return `${buildBeadItemContentKey(change.canonicalBefore)}\x1f${buildBeadItemContentKey(change.canonicalAfter)}`
}

function collapseDuplicateModifiedBeadChanges(
  changes: PreparedBeadRefinementChange[],
): {
  changes: PreparedBeadRefinementChange[]
  repairApplied: boolean
  repairWarnings: string[]
} {
  const collapsedChanges: PreparedBeadRefinementChange[] = []
  const seenModifiedChanges = new Map<string, PreparedBeadRefinementChange>()
  const repairWarnings: string[] = []
  let repairApplied = false

  for (const change of changes) {
    const duplicateKey = buildDuplicateModifiedBeadChangeKey(change)
    if (!duplicateKey) {
      collapsedChanges.push(change)
      continue
    }

    const existing = seenModifiedChanges.get(duplicateKey)
    if (!existing) {
      seenModifiedChanges.set(duplicateKey, change)
      collapsedChanges.push(change)
      continue
    }

    repairApplied = true
    repairWarnings.push(
      `Collapsed duplicate beads refinement modified change at index ${change.sourceIndex} because ${change.after?.id ?? change.before?.id ?? 'the item'} was already covered by an identical modified change.`,
    )

    if (!sameRefinementInspiration(existing.inspiration, change.inspiration)) {
      existing.inspiration = null
      existing.attributionStatus = 'model_unattributed'
      continue
    }

    if (existing.inspiration) {
      existing.attributionStatus = 'inspired'
      continue
    }

    if (existing.attributionStatus !== change.attributionStatus) {
      existing.attributionStatus = 'model_unattributed'
    }
  }

  return {
    changes: collapsedChanges,
    repairApplied,
    repairWarnings,
  }
}

// ---------------------------------------------------------------------------
// Enhanced synthesis with label-based fallback
// ---------------------------------------------------------------------------

function synthesizeOmittedBeadChanges(params: {
  winnerItems: NormalizedBeadRefinementItem[]
  refinedItems: NormalizedBeadRefinementItem[]
  winnerLookup: ReturnType<typeof buildBeadItemLookup>
  refinedLookup: ReturnType<typeof buildBeadItemLookup>
  usedBeforeIds: Set<string>
  usedAfterIds: Set<string>
  usedBeforeContentKeys: Set<string>
  usedAfterContentKeys: Set<string>
}): { changes: RefinementChange[]; repairApplied: boolean; repairWarnings: string[] } {
  const synthesizedChanges: RefinementChange[] = []
  const repairWarnings: string[] = []

  // Strategy 1: Same ID in both, different content → modified
  for (const winnerItem of params.winnerItems) {
    const refinedMatch = params.refinedLookup.byId.get(winnerItem.id)
    if (!refinedMatch) continue

    const winnerContentKey = buildBeadItemContentKey(winnerItem)
    const refinedContentKey = buildBeadItemContentKey(refinedMatch)
    if (winnerContentKey === refinedContentKey) {
      params.usedBeforeIds.add(winnerItem.id)
      params.usedAfterIds.add(refinedMatch.id)
      continue
    }

    if (params.usedBeforeIds.has(winnerItem.id) || params.usedAfterIds.has(refinedMatch.id)) {
      continue
    }

    params.usedBeforeIds.add(winnerItem.id)
    params.usedAfterIds.add(refinedMatch.id)
    params.usedBeforeContentKeys.add(winnerContentKey)
    params.usedAfterContentKeys.add(refinedContentKey)
    synthesizedChanges.push({
      type: 'modified',
      itemType: 'bead',
      before: cloneCanonicalItem(winnerItem),
      after: cloneCanonicalItem(refinedMatch),
      inspiration: null,
      attributionStatus: 'synthesized_unattributed',
    })
    repairWarnings.push(
      `Synthesized omitted beads refinement modified change for bead "${winnerItem.id}" by matching id across the winning and refined drafts.`,
    )
  }

  // Strategy 2: Same label (title) match when ID changed → modified
  for (const winnerItem of params.winnerItems) {
    if (params.usedBeforeIds.has(winnerItem.id)) continue

    const labelKey = winnerItem.label.toLowerCase().trim()
    const refinedByLabel = params.refinedLookup.byLabel.get(labelKey)
    if (!refinedByLabel || refinedByLabel.length !== 1) continue

    const refinedMatch = refinedByLabel[0]!
    if (params.usedAfterIds.has(refinedMatch.id)) continue

    // Confirm this winner label is also unique
    const winnerByLabel = params.winnerLookup.byLabel.get(labelKey)
    if (!winnerByLabel || winnerByLabel.length !== 1) continue

    const winnerContentKey = buildBeadItemContentKey(winnerItem)
    const refinedContentKey = buildBeadItemContentKey(refinedMatch)
    if (winnerItem.id === refinedMatch.id) continue
    if (winnerContentKey === refinedContentKey) continue

    params.usedBeforeIds.add(winnerItem.id)
    params.usedAfterIds.add(refinedMatch.id)
    params.usedBeforeContentKeys.add(winnerContentKey)
    params.usedAfterContentKeys.add(refinedContentKey)
    synthesizedChanges.push({
      type: 'modified',
      itemType: 'bead',
      before: cloneCanonicalItem(winnerItem),
      after: cloneCanonicalItem(refinedMatch),
      inspiration: null,
      attributionStatus: 'synthesized_unattributed',
    })
    repairWarnings.push(
      `Synthesized omitted beads refinement modified change for bead "${winnerItem.id}" → "${refinedMatch.id}" by matching title across the winning and refined drafts.`,
    )
  }

  // Strategy 3: Added beads (in refined but not in winner)
  for (const refinedItem of params.refinedItems) {
    if (params.usedAfterIds.has(refinedItem.id)) continue

    params.usedAfterIds.add(refinedItem.id)
    params.usedAfterContentKeys.add(buildBeadItemContentKey(refinedItem))
    synthesizedChanges.push({
      type: 'added',
      itemType: 'bead',
      before: null,
      after: cloneCanonicalItem(refinedItem),
      inspiration: null,
      attributionStatus: 'synthesized_unattributed',
    })
    repairWarnings.push(
      `Synthesized omitted beads refinement added change for bead "${refinedItem.id}" (present in refined output but not in winner draft).`,
    )
  }

  // Strategy 4: Removed beads (in winner but not in refined)
  for (const winnerItem of params.winnerItems) {
    if (params.usedBeforeIds.has(winnerItem.id)) continue

    params.usedBeforeIds.add(winnerItem.id)
    params.usedBeforeContentKeys.add(buildBeadItemContentKey(winnerItem))
    synthesizedChanges.push({
      type: 'removed',
      itemType: 'bead',
      before: cloneCanonicalItem(winnerItem),
      after: null,
      inspiration: null,
      attributionStatus: 'synthesized_unattributed',
    })
    repairWarnings.push(
      `Synthesized omitted beads refinement removed change for bead "${winnerItem.id}" (present in winner draft but not in refined output).`,
    )
  }

  return {
    changes: synthesizedChanges,
    repairApplied: synthesizedChanges.length > 0,
    repairWarnings,
  }
}

// ---------------------------------------------------------------------------
// Coverage validation
// ---------------------------------------------------------------------------

function validateChangeCoverage(
  winnerItems: NormalizedBeadRefinementItem[],
  refinedItems: NormalizedBeadRefinementItem[],
  usedBeforeContentKeys: Set<string>,
  usedAfterContentKeys: Set<string>,
  repairWarnings: string[],
) {
  const winnerContentKeySet = new Set(winnerItems.map(buildBeadItemContentKey))
  const refinedContentKeySet = new Set(refinedItems.map(buildBeadItemContentKey))
  const expectedBeforeKeys = [...winnerContentKeySet].filter((key) => !refinedContentKeySet.has(key))
  const expectedAfterKeys = [...refinedContentKeySet].filter((key) => !winnerContentKeySet.has(key))

  const missingBefore = expectedBeforeKeys.filter((key) => !usedBeforeContentKeys.has(key))
  const missingAfter = expectedAfterKeys.filter((key) => !usedAfterContentKeys.has(key))

  if (missingBefore.length > 0 || missingAfter.length > 0) {
    repairWarnings.push(
      `Beads refinement changes do not fully account for the diff between the winning draft and the refined output (${missingBefore.length} missing before, ${missingAfter.length} missing after).`,
    )
  }
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

export function validateBeadsRefinementOutput(
  rawContent: string,
  options: {
    winnerDraftContent: string
    losingDraftMeta?: Array<{ memberId: string; content?: string }>
  },
): ValidatedBeadsRefinement {
  const refinementResult = normalizeBeadRefinementOutput(
    rawContent,
    options.winnerDraftContent,
    options.losingDraftMeta,
  )

  if (!refinementResult.ok) {
    throw attachStructuredRetryDiagnostic(
      new Error(refinementResult.error),
      refinementResult.retryDiagnostic ?? buildStructuredRetryDiagnostic({
        attempt: 1,
        rawResponse: rawContent,
        validationError: refinementResult.error,
      }),
    )
  }

  const { beads: refinedBeads, changes: rawChanges, normalizedContent } = refinementResult.value
  const repairWarnings = [...refinementResult.repairWarnings]
  let repairApplied = refinementResult.repairApplied

  if (rawChanges.length === 0) {
    return {
      beadSubsets: refinedBeads,
      metrics: getBeadsDraftMetrics(refinedBeads),
      refinedContent: normalizedContent,
      winnerDraftContent: options.winnerDraftContent,
      changes: [],
      repairApplied,
      repairWarnings,
    }
  }

  // Build canonical items for enhanced validation
  const winnerItems = parseWinnerBeadItems(options.winnerDraftContent)
  const refinedItems = refinedBeads.map(buildBeadItemFromSubset)
  const winnerLookup = buildBeadItemLookup(winnerItems)
  const refinedLookup = buildBeadItemLookup(refinedItems)
  const usedBeforeIds = new Set<string>()
  const usedAfterIds = new Set<string>()
  const usedBeforeContentKeys = new Set<string>()
  const usedAfterContentKeys = new Set<string>()
  const preparedChanges: PreparedBeadRefinementChange[] = []
  const validatedChanges: RefinementChange[] = []

  for (const [index, change] of rawChanges.entries()) {
    const before = resolveBeadChangeItem(change.before, winnerLookup)
    const after = resolveBeadChangeItem(change.after, refinedLookup)
    const canonicalBefore = before ? winnerLookup.byId.get(before.id) ?? null : null
    const canonicalAfter = after ? refinedLookup.byId.get(after.id) ?? null : null

    if (change.type === 'modified') {
      if (!before || !after) {
        repairApplied = true
        repairWarnings.push(`Skipped beads refinement change at index ${index}: modified change has no resolvable before or after item.`)
        continue
      }
    } else if (change.type === 'added') {
      if (!after) {
        repairApplied = true
        repairWarnings.push(`Skipped beads refinement change at index ${index}: added change has no resolvable after item.`)
        continue
      }
    } else if (change.type === 'removed') {
      if (!before) {
        repairApplied = true
        repairWarnings.push(`Skipped beads refinement change at index ${index}: removed change has no resolvable before item.`)
        continue
      }
    }

    // No-op detection
    if (
      canonicalBefore
      && canonicalAfter
      && buildBeadItemContentKey(canonicalBefore) === buildBeadItemContentKey(canonicalAfter)
    ) {
      repairApplied = true
      repairWarnings.push(`Dropped no-op beads refinement modified change at index ${index} because the winning and refined bead "${canonicalBefore.id}" are identical.`)
      continue
    }

    let inspiration = change.inspiration ?? null
    let attributionStatus = normalizeAttributionStatus(change.attributionStatus, inspiration)
    if (inspiration) {
      const losingDraft = options.losingDraftMeta?.[inspiration.draftIndex]
      if (!losingDraft) {
        const draftNumber = inspiration.draftIndex + 1
        inspiration = null
        attributionStatus = 'invalid_unattributed'
        repairApplied = true
        repairWarnings.push(`Cleared out-of-range beads refinement inspiration at index ${index} because alternative draft ${draftNumber} does not exist.`)
      } else {
        inspiration = {
          ...inspiration,
          memberId: losingDraft.memberId,
        }
        attributionStatus = 'inspired'
      }
    } else if (attributionStatus === 'inspired') {
      attributionStatus = 'model_unattributed'
    }

    preparedChanges.push({
      sourceIndex: index,
      type: change.type,
      before: before ? cloneCanonicalItem(before) : change.before ?? null,
      after: after ? cloneCanonicalItem(after) : change.after ?? null,
      canonicalBefore,
      canonicalAfter,
      inspiration,
      attributionStatus,
    })
  }

  // Deduplication
  const collapsedResult = collapseDuplicateModifiedBeadChanges(preparedChanges)
  if (collapsedResult.repairApplied) {
    repairApplied = true
    repairWarnings.push(...collapsedResult.repairWarnings)
  }

  for (const change of collapsedResult.changes) {
    const { before, after, canonicalBefore, canonicalAfter } = change

    if (before) {
      usedBeforeIds.add(before.id)
      if (canonicalBefore) usedBeforeContentKeys.add(buildBeadItemContentKey(canonicalBefore))
    }

    if (after) {
      usedAfterIds.add(after.id)
      if (canonicalAfter) usedAfterContentKeys.add(buildBeadItemContentKey(canonicalAfter))
    }

    validatedChanges.push({
      type: change.type,
      itemType: 'bead',
      before: change.before,
      after: change.after,
      inspiration: change.inspiration,
      attributionStatus: change.attributionStatus,
    })
  }

  // Enhanced synthesis with label-based fallback
  const synthesized = synthesizeOmittedBeadChanges({
    winnerItems,
    refinedItems,
    winnerLookup,
    refinedLookup,
    usedBeforeIds,
    usedAfterIds,
    usedBeforeContentKeys,
    usedAfterContentKeys,
  })
  if (synthesized.repairApplied) {
    repairApplied = true
    repairWarnings.push(...synthesized.repairWarnings)
    validatedChanges.push(...synthesized.changes)
  }

  // Coverage validation (warn, don't throw)
  validateChangeCoverage(winnerItems, refinedItems, usedBeforeContentKeys, usedAfterContentKeys, repairWarnings)

  return {
    beadSubsets: refinedBeads,
    metrics: getBeadsDraftMetrics(refinedBeads),
    refinedContent: normalizedContent,
    winnerDraftContent: options.winnerDraftContent,
    changes: validatedChanges,
    repairApplied,
    repairWarnings,
  }
}

// ---------------------------------------------------------------------------
// Internal: parse winner draft into canonical items
// ---------------------------------------------------------------------------

function parseWinnerBeadItems(winnerDraftContent: string): NormalizedBeadRefinementItem[] {
  try {
    const parsed = jsYaml.load(winnerDraftContent)
    if (!parsed) return []

    const entries = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray((parsed as Record<string, unknown>).beads)
        ? (parsed as Record<string, unknown>).beads as unknown[]
        : []

    const items: NormalizedBeadRefinementItem[] = []
    for (const entry of entries) {
      if (!isRecord(entry)) continue
      const id = typeof entry.id === 'string' ? entry.id : ''
      const title = typeof entry.title === 'string' ? entry.title : ''
      if (!id || !title) continue

      const description = typeof entry.description === 'string' ? entry.description : ''
      const acceptanceCriteria = Array.isArray(entry.acceptanceCriteria) || Array.isArray(entry.acceptance_criteria)
        ? normalizeFingerprintList((entry.acceptanceCriteria ?? entry.acceptance_criteria) as string[])
        : []
      const tests = Array.isArray(entry.tests) ? normalizeFingerprintList(entry.tests as string[]) : []
      const testCommands = Array.isArray(entry.testCommands) || Array.isArray(entry.test_commands)
        ? normalizeFingerprintList((entry.testCommands ?? entry.test_commands) as string[])
        : []
      const rawTestCommandReason = entry.testCommandReason ?? entry.test_command_reason
      const testCommandReason = typeof rawTestCommandReason === 'string'
        ? rawTestCommandReason.trim()
        : ''

      const bead: BeadSubset = {
        id,
        title,
        prdRefs: [],
        description,
        contextGuidance: { patterns: [], anti_patterns: [] },
        acceptanceCriteria,
        tests,
        testCommands,
        ...(testCommandReason ? { testCommandReason } : {}),
      }

      items.push(buildBeadItemFromSubset(bead))
    }

    return items
  } catch {
    return []
  }
}

function resolveBeadChangeItem(
  raw: RefinementChangeItem | null | undefined,
  lookup: ReturnType<typeof buildBeadItemLookup>,
): NormalizedBeadRefinementItem | null {
  if (!raw) return null

  const byId = lookup.byId.get(raw.id)
  if (byId) return byId

  if (raw.label) {
    const byLabel = lookup.byLabel.get(raw.label.toLowerCase().trim())
    if (byLabel?.length === 1) return byLabel[0]!
  }

  return null
}

// ---------------------------------------------------------------------------
// Artifact builders
// ---------------------------------------------------------------------------

function normalizeDraftMetrics(value: unknown): BeadsDraftMetrics | null {
  if (!isRecord(value)) return null

  const beadCount = typeof value.beadCount === 'number' && Number.isInteger(value.beadCount)
    ? value.beadCount
    : null
  const totalTestCount = typeof value.totalTestCount === 'number' && Number.isInteger(value.totalTestCount)
    ? value.totalTestCount
    : null
  const totalAcceptanceCriteriaCount = typeof value.totalAcceptanceCriteriaCount === 'number' && Number.isInteger(value.totalAcceptanceCriteriaCount)
    ? value.totalAcceptanceCriteriaCount
    : null

  if (beadCount == null || totalTestCount == null || totalAcceptanceCriteriaCount == null) {
    return null
  }

  return { beadCount, totalTestCount, totalAcceptanceCriteriaCount }
}

function normalizePipelineSteps(value: unknown): BeadsPipelineStep[] {
  if (!Array.isArray(value)) return BEADS_PIPELINE_STEPS

  const steps: BeadsPipelineStep[] = []
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.step === 'string' && typeof entry.description === 'string') {
      steps.push({ step: entry.step, description: entry.description })
    }
  }

  return steps.length > 0 ? steps : BEADS_PIPELINE_STEPS
}

function deriveDraftMetricsFromRefinedContent(content: string): BeadsDraftMetrics | null {
  try {
    const parsed = jsYaml.load(content)
    const entries = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray((parsed as Record<string, unknown>).beads)
        ? (parsed as Record<string, unknown>).beads as unknown[]
        : null

    if (!entries) return null

    let totalTestCount = 0
    let totalAcceptanceCriteriaCount = 0
    for (const entry of entries) {
      if (!isRecord(entry)) continue
      const ac = entry.acceptanceCriteria ?? entry.acceptance_criteria
      const tests = entry.tests
      if (Array.isArray(ac)) totalAcceptanceCriteriaCount += ac.length
      if (Array.isArray(tests)) totalTestCount += tests.length
    }

    return {
      beadCount: entries.length,
      totalTestCount,
      totalAcceptanceCriteriaCount,
    }
  } catch {
    return null
  }
}

export function buildBeadsRefinedArtifact(
  winnerId: string,
  winnerDraftContent: string,
  refinement: ValidatedBeadsRefinement,
  structuredOutput?: StructuredOutputMetadata,
): BeadsRefinedArtifact {
  const normalizedWinnerId = winnerId.trim()
  if (!normalizedWinnerId) {
    throw new Error('Beads refined artifact is missing winnerId')
  }

  return {
    winnerId: normalizedWinnerId,
    refinedContent: refinement.refinedContent,
    winnerDraftContent,
    ...(refinement.changes.length > 0 ? { changes: refinement.changes } : {}),
    ...(structuredOutput ? { structuredOutput } : {}),
    draftMetrics: refinement.metrics,
    pipelineSteps: BEADS_PIPELINE_STEPS,
  }
}

export function parseBeadsRefinedArtifact(content: string): BeadsRefinedArtifact {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Beads refined artifact is not valid JSON')
  }

  if (!isRecord(parsed)) {
    throw new Error('Beads refined artifact payload is invalid')
  }

  const winnerId = typeof parsed.winnerId === 'string' ? parsed.winnerId.trim() : ''
  const refinedContent = typeof parsed.refinedContent === 'string' ? parsed.refinedContent : ''
  const winnerDraftContent = typeof parsed.winnerDraftContent === 'string' ? parsed.winnerDraftContent : ''
  const changes = Array.isArray(parsed.changes) ? parsed.changes as RefinementChange[] : []
  const structuredOutput = normalizeStructuredOutputMetadata(parsed.structuredOutput)
  const draftMetrics = normalizeDraftMetrics(parsed.draftMetrics) ?? deriveDraftMetricsFromRefinedContent(refinedContent)
  const pipelineSteps = normalizePipelineSteps(parsed.pipelineSteps)

  if (!refinedContent.trim()) {
    throw new Error('Beads refined artifact is missing refinedContent')
  }
  if (!draftMetrics) {
    throw new Error('Beads refined artifact is missing draftMetrics')
  }

  return {
    winnerId,
    refinedContent,
    winnerDraftContent,
    changes,
    structuredOutput,
    draftMetrics,
    pipelineSteps,
  }
}

export function requireBeadsRefinedArtifact(content: string | null | undefined): BeadsRefinedArtifact {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('No validated refined beads found')
  }

  return parseBeadsRefinedArtifact(content)
}

// ---------------------------------------------------------------------------
// Retry prompt builder
// ---------------------------------------------------------------------------

function stripLegacyTopLevelChangesFromYaml(rawResponse: string): string {
  const trimmed = rawResponse.trim()
  if (!trimmed) return trimmed

  try {
    const parsed = jsYaml.load(trimmed)
    if (isRecord(parsed) && 'changes' in parsed) {
      const sanitized = { ...parsed }
      delete sanitized.changes
      return jsYaml.dump(sanitized, { lineWidth: -1, noRefs: true }).trim()
    }
  } catch {
    // Preserve the original response when it cannot be parsed safely.
  }

  return trimmed.replace(/\nchanges:\n(?: {2,}.*\n?)*/u, '').trim()
}

export function buildBeadsRefinementRetryPrompt(
  baseParts: PromptPart[],
  params: {
    validationError: string
    rawResponse: string
  },
): PromptPart[] {
  const sanitizedRawResponse = stripLegacyTopLevelChangesFromYaml(params.rawResponse)

  return [
    ...baseParts,
    {
      type: 'text',
      content: [
        '## Beads Refinement Structured Output Retry',
        `Your previous response failed validation: ${params.validationError}`,
        '',
        'Return only one corrected YAML artifact.',
        'Requirements:',
        '- Use the bead subset schema (id, title, prdRefs, description, contextGuidance, acceptanceCriteria, tests, testCommands, and conditional testCommandReason) plus a top-level `changes` list.',
        '- The `changes` list must fully and exactly account for the diff between the winning bead draft and the final refined beads.',
        '- Every changed bead must appear exactly once in `changes` with item_type: bead.',
        '- If an existing bead keeps the same ID but its content changes, emit exactly one `modified` entry for that bead.',
        '- Do not split one changed bead across multiple change entries.',
        '- Preserve bead IDs unless the final draft contains a genuinely new bead.',
        '- Do not wrap the beads in another object.',
        '- Do not include prose, commentary, or markdown fences.',
        '',
        '## Previous Invalid Response',
        '```yaml',
        sanitizedRawResponse,
        '```',
      ].join('\n'),
    },
  ]
}
