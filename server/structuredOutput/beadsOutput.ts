import * as jsYaml from 'js-yaml'
import type { RefinementChange, RefinementChangeItem } from '@shared/refinementChanges'
import type { Bead, BeadStatus, BeadSubset, BeadContextGuidance, BeadDependencies } from '../phases/beads/types'
import { BEAD_STATUSES, isBeadStatus, resolveBeadStatusAlias } from '../phases/beads/types'
import { openTag, PROTOCOL_TAGS } from './protocolTags'
import { looksLikePromptEcho } from '../lib/promptEcho'
import type { StructuredOutputResult, RelevantFilesOutputEntry, RelevantFilesOutputPayload } from './types'
import {
  isRecord,
  collectStructuredCandidates,
  collectTaggedCandidates,
  maybeUnwrapRecord,
  appendStructuredCandidateRecoveryWarning,
  appendWrapperKeyRepairWarning,
  findMaybeUnwrappedWrapperPath,
  parseYamlOrJsonCandidate,
  shouldRecordStructuredCandidateRecovery,
  toStringArray,
  getValueByAliases,
  getStringByAliases,
  getRequiredString,
  buildYamlDocument,
  buildJsonlDocument,
  collectAliasConflictWarnings,
} from './yamlUtils'
import { takeRefinementChanges } from './refinementChanges'
import { buildStructuredOutputFailure } from './failure'
import { getErrorMessage } from '@shared/typeGuards'
import { normalizeCommandSpec, renderCommandSpec, type CommandSpec } from '@shared/commandSpec'
import { detectHostContext } from '../lib/hostContext'

function normalizeCommandSpecs(value: unknown, label: string, repairWarnings: string[]): CommandSpec[] {
  if (!Array.isArray(value)) throw new Error(`${label} is missing the testCommands list`)
  const host = detectHostContext()
  return value.map((command, index) => {
    try {
      const normalized = normalizeCommandSpec(command, host)
      if (normalized.warning) repairWarnings.push(`${label}[${index}]: ${normalized.warning}`)
      return normalized.command
    } catch {
      throw new Error(`${label} contains an invalid test command`)
    }
  })
}

const BEAD_SEQUENCE_CHILD_KEYS = ['title', 'name', 'prdRefs', 'prd_refs', 'description', 'details', 'contextGuidance', 'context_guidance', 'acceptanceCriteria', 'acceptance_criteria', 'tests', 'testCommands', 'test_commands', 'testCommandReason', 'test_command_reason'] as const
const BEAD_SEQUENCE_ITEM_PRIMARY_KEYS = {
  beads: { primaryKey: 'id', childKeys: BEAD_SEQUENCE_CHILD_KEYS },
  tasks: { primaryKey: 'id', childKeys: BEAD_SEQUENCE_CHILD_KEYS },
  items: { primaryKey: 'id', childKeys: BEAD_SEQUENCE_CHILD_KEYS },
  issues: { primaryKey: 'id', childKeys: BEAD_SEQUENCE_CHILD_KEYS },
  workitems: { primaryKey: 'id', childKeys: BEAD_SEQUENCE_CHILD_KEYS },
  work_items: { primaryKey: 'id', childKeys: BEAD_SEQUENCE_CHILD_KEYS },
} as const

const RELEVANT_FILES_SEQUENCE_ITEM_PRIMARY_KEYS = {
  files: {
    primaryKey: 'path',
    childKeys: ['rationale', 'reason', 'why', 'relevance', 'likely_action', 'likelyAction', 'action', 'content', 'contents', 'code', 'source', 'snippet', 'excerpt', 'content_preview', 'contentPreview', 'preview', 'signatures'],
  },
} as const

export interface CoverageBeadMetrics {
  beadCount: number
  totalTestCount: number
  totalTestCommandCount: number
  totalAcceptanceCriteriaCount: number
}

/**
 * The counts both metric shapes report. Coverage adds the test-command count to
 * these; refinement is exactly these. Keeping the sums in one place is what lets
 * the two shapes stay deliberately different without the arithmetic drifting.
 */
export function getCommonBeadCounts(beads: BeadSubset[]): {
  beadCount: number
  totalTestCount: number
  totalAcceptanceCriteriaCount: number
} {
  return {
    beadCount: beads.length,
    totalTestCount: beads.reduce((sum, b) => sum + b.tests.length, 0),
    totalAcceptanceCriteriaCount: beads.reduce((sum, b) => sum + b.acceptanceCriteria.length, 0),
  }
}

export function getCoverageBeadMetrics(beads: BeadSubset[]): CoverageBeadMetrics {
  return {
    ...getCommonBeadCounts(beads),
    totalTestCommandCount: beads.reduce((sum, b) => sum + b.testCommands.length, 0),
  }
}

function cleanString(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function normalizeGuidanceItems(value: unknown, label: string): string[] {
  const items = toStringArray(value).map(cleanString).filter(Boolean)
  if (items.length === 0) {
    throw new Error(`Bead context guidance is missing ${label}`)
  }
  return items
}

/** Parse a multi-line string with Patterns: and Anti-patterns: sections into arrays. */
function parseGuidanceStringToObject(guidance: string): { patterns: string[]; anti_patterns: string[] } | null {
  const patternsMatch = guidance.match(/^\s*patterns\s*:\s*\n?([\s\S]*?)(?=^\s*anti[-\s_]*patterns\s*:|$)/im)
  const antiPatternsMatch = guidance.match(/^\s*anti[-\s_]*patterns\s*:\s*\n?([\s\S]*?)$/im)

  if (!patternsMatch && !antiPatternsMatch) return null

  const parseItems = (text: string) =>
    text.split('\n')
      .map(line => line.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean)

  return {
    patterns: patternsMatch?.[1] ? parseItems(patternsMatch[1]) : [],
    anti_patterns: antiPatternsMatch?.[1] ? parseItems(antiPatternsMatch[1]) : [],
  }
}

function normalizeContextGuidance(
  value: unknown,
  index: number,
  repairWarnings: string[],
): BeadContextGuidance {
  if (typeof value === 'string') {
    const guidance = value.trim()
    if (!guidance) {
      throw new Error(`Bead context guidance at index ${index} is empty`)
    }

    const parsed = parseGuidanceStringToObject(guidance)
    if (parsed && parsed.patterns.length > 0 && parsed.anti_patterns.length > 0) {
      repairWarnings.push(`Canonicalized string context guidance at index ${index} into patterns/anti_patterns object.`)
      return parsed
    }

    // Try inline repair: "Patterns: X Anti-patterns: Y"
    const inlineMatch = guidance.match(/^\s*patterns\s*:\s*(.+?)\s+anti[-\s_]*patterns\s*:\s*(.+)\s*$/is)
    if (inlineMatch) {
      const patterns = cleanString(inlineMatch[1] ?? '')
      const antiPatterns = cleanString(inlineMatch[2] ?? '')
      if (patterns && antiPatterns) {
        repairWarnings.push(`Canonicalized inline string context guidance at index ${index} into patterns/anti_patterns object.`)
        return { patterns: [patterns], anti_patterns: [antiPatterns] }
      }
    }

    throw new Error(`Bead context guidance at index ${index} must include both Patterns and Anti-patterns sections`)
  }

  if (!isRecord(value)) {
    throw new Error(`Bead context guidance at index ${index} must be a string or object`)
  }

  const patterns = normalizeGuidanceItems(
    getValueByAliases(value, ['patterns', 'pattern']),
    'patterns',
  )
  const antiPatterns = normalizeGuidanceItems(
    getValueByAliases(value, ['antipatterns', 'anti_patterns', 'anti-patterns', 'anti_patterns_list']),
    'anti-patterns',
  )

  return { patterns, anti_patterns: antiPatterns }
}

function normalizeDependencies(value: unknown): BeadDependencies {
  if (!value) return { blocked_by: [], blocks: [] }

  if (isRecord(value)) {
    return {
      blocked_by: toStringArray(getValueByAliases(value, ['blockedby', 'blocked_by'])),
      blocks: toStringArray(getValueByAliases(value, ['blocks'])),
    }
  }

  // Legacy flat array format — treat as blocked_by
  if (Array.isArray(value)) {
    return {
      blocked_by: toStringArray(value),
      blocks: [],
    }
  }

  return { blocked_by: [], blocks: [] }
}

function normalizeBeadSubsetEntry(value: unknown, index: number, repairWarnings: string[]): BeadSubset {
  if (!isRecord(value)) throw new Error(`Bead at index ${index} is not an object`)

  const idValue = getValueByAliases(value, ['id', 'beadid', 'bead_id'])
  const id = typeof idValue === 'string' && idValue.trim()
    ? idValue.trim()
    : `bead-${index + 1}`

  const testCommandsValue = getValueByAliases(value, ['testcommands', 'test_commands', 'commands'])
  const testCommands = normalizeCommandSpecs(testCommandsValue, `Bead ${id}`, repairWarnings)
  const testCommandReasonValue = getValueByAliases(value, ['testcommandreason', 'test_command_reason'])
  if (testCommandReasonValue !== undefined && (typeof testCommandReasonValue !== 'string' || !testCommandReasonValue.trim())) {
    throw new Error(`Bead ${id} contains an invalid testCommandReason`)
  }
  const testCommandReason = typeof testCommandReasonValue === 'string' ? testCommandReasonValue.trim() : ''

  const subset: BeadSubset = {
    id,
    title: getRequiredString(value, ['title', 'name'], `bead title at index ${index}`),
    prdRefs: toStringArray(getValueByAliases(value, ['prdrefs', 'prd_refs', 'prdreferences', 'prd_references'])),
    description: getRequiredString(value, ['description', 'details'], `bead description at index ${index}`),
    contextGuidance: normalizeContextGuidance(
      getValueByAliases(value, ['contextguidance', 'context_guidance', 'architecturalguidance', 'guidance']),
      index,
      repairWarnings,
    ),
    acceptanceCriteria: toStringArray(getValueByAliases(value, ['acceptancecriteria', 'acceptance_criteria'])),
    tests: toStringArray(getValueByAliases(value, ['tests', 'testcases', 'test_cases'])),
    testCommands,
    ...(testCommandReason ? { testCommandReason } : {}),
  }

  if (subset.acceptanceCriteria.length === 0) {
    throw new Error(`Bead ${subset.id} is missing acceptance criteria`)
  }
  if (subset.tests.length === 0) {
    throw new Error(`Bead ${subset.id} is missing tests`)
  }
  if (subset.testCommands.length === 0 && !subset.testCommandReason) {
    throw new Error(`Bead ${subset.id} requires testCommandReason when testCommands is empty`)
  }
  if (subset.testCommands.length > 0 && subset.testCommandReason) {
    throw new Error(`Bead ${subset.id} may include testCommandReason only when testCommands is empty`)
  }

  return subset
}

export function normalizeBeadSubsetYamlOutput(
  rawContent: string,
  losingDraftMeta?: Array<{ memberId: string }>,
): StructuredOutputResult<BeadSubset[] & { changes?: RefinementChange[] }> {
  const repairWarnings: string[] = []
  const candidates = collectStructuredCandidates(rawContent, {
    topLevelHints: ['beads', 'tasks', 'items'],
  })
  let lastError = 'No bead subset content found'
  let lastErrorCause: unknown = null

  for (const candidate of candidates) {
    const candidateWarnings: string[] = []
    const releaseAliasConflicts = collectAliasConflictWarnings(candidateWarnings)

    try {
      const rawParsed = parseYamlOrJsonCandidate(candidate, {
        sequenceItemPrimaryKeys: BEAD_SEQUENCE_ITEM_PRIMARY_KEYS,
        repairWarnings: candidateWarnings,
      })

      // Taken before unwrapping, which would lose the changes key.
      const parsedRefinementChanges = takeRefinementChanges(rawParsed, losingDraftMeta)
      candidateWarnings.push(...parsedRefinementChanges.repairWarnings)

      const parsed = maybeUnwrapRecord(rawParsed, [
        'beads',
        'tasks',
        'items',
        'issues',
        'workitems',
        'work_items',
      ])
      const nestedEntries = isRecord(parsed)
        ? getValueByAliases(parsed, ['beads', 'tasks', 'items', 'issues'])
        : undefined
      const entries = Array.isArray(parsed)
        ? parsed
        : Array.isArray(nestedEntries) ? nestedEntries : []

      if (entries.length === 0) {
        throw new Error('Bead subset output is empty')
      }

      const subsets = entries.map((entry, index) => normalizeBeadSubsetEntry(entry, index, candidateWarnings))

      // Detect and repair duplicate bead IDs
      const seenIds = new Set<string>()
      for (const subset of subsets) {
        if (seenIds.has(subset.id)) {
          const originalId = subset.id
          let counter = 2
          while (seenIds.has(`${originalId}-${counter}`)) counter++
          subset.id = `${originalId}-${counter}`
          candidateWarnings.push(`Renumbered duplicate bead id "${originalId}" to "${subset.id}".`)
        }
        seenIds.add(subset.id)
      }

      // Warn about beads with empty prdRefs
      for (const subset of subsets) {
        if (subset.prdRefs.length === 0) {
          candidateWarnings.push(`Bead "${subset.id}" has no PRD references (prdRefs is empty).`)
        }
        if (subset.contextGuidance.patterns.length === 0 || subset.contextGuidance.anti_patterns.length === 0) {
          throw new Error(`Bead "${subset.id}" contextGuidance must include both patterns and anti_patterns`)
        }
      }

      const normalizedContent = buildYamlDocument({ beads: subsets })
      const valueWithChanges = parsedRefinementChanges.changes.length > 0
        ? Object.assign(subsets, { changes: parsedRefinementChanges.changes })
        : subsets
      appendStructuredCandidateRecoveryWarning(candidateWarnings, rawContent, candidate)
      return {
        ok: true,
        value: valueWithChanges,
        normalizedContent,
        repairApplied: candidate !== rawContent.trim() || candidateWarnings.length > 0,
        repairWarnings: candidateWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
      repairWarnings.splice(0, repairWarnings.length, ...candidateWarnings)
    } finally {
      releaseAliasConflicts()
    }
  }

  return buildStructuredOutputFailure(
    rawContent,
    looksLikePromptEcho(rawContent)
      ? 'Bead subset output echoed the prompt instead of returning structured bead YAML'
      : lastError,
    {
      repairWarnings,
      cause: lastErrorCause,
    },
  )
}

// ---------------------------------------------------------------------------
// Bead refinement output validation
// Mirrors the deeper validation that Interview and PRD refinement phases
// apply: canonicalization, no-op detection, synthesis, and inspiration hydration.
// ---------------------------------------------------------------------------

interface NormalizedBeadItem {
  id: string
  label: string
  detail: string
  contentFingerprint: string
}

function buildBeadItemFromSubset(bead: BeadSubset): NormalizedBeadItem {
  const label = bead.title
  const detail = bead.description
  return {
    id: bead.id,
    label,
    detail,
    // prdRefs and contextGuidance are part of the bead's content: an edit that
    // touched only those was dropped from `changes` while the YAML kept the new
    // values.
    contentFingerprint: [
      bead.id,
      label,
      detail,
      bead.prdRefs.join('|'),
      bead.contextGuidance.patterns.join('|'),
      bead.contextGuidance.anti_patterns.join('|'),
      bead.acceptanceCriteria.join('|'),
      bead.tests.join('|'),
      bead.testCommands.map((command) => renderCommandSpec(command)).join('|'),
      bead.testCommandReason ?? '',
    ].join('\x1f'),
  }
}

function buildBeadLookup(items: NormalizedBeadItem[]): {
  byId: Map<string, NormalizedBeadItem>
  byLabel: Map<string, NormalizedBeadItem[]>
} {
  const byId = new Map<string, NormalizedBeadItem>()
  const byLabel = new Map<string, NormalizedBeadItem[]>()
  for (const item of items) {
    byId.set(item.id, item)
    const key = item.label.toLowerCase().trim()
    const existing = byLabel.get(key) ?? []
    existing.push(item)
    byLabel.set(key, existing)
  }
  return { byId, byLabel }
}

function resolveBeadChangeItem(
  raw: { id: string; label: string; detail?: string } | null | undefined,
  lookup: ReturnType<typeof buildBeadLookup>,
): NormalizedBeadItem | null {
  if (!raw) return null

  // Direct ID match
  const byId = lookup.byId.get(raw.id)
  if (byId) return byId

  // Fallback: match by label
  const byLabel = lookup.byLabel.get(raw.label.toLowerCase().trim())
  if (byLabel?.length === 1) return byLabel[0]!

  return null
}

export interface ValidatedBeadRefinementResult {
  beads: BeadSubset[]
  changes: RefinementChange[]
  normalizedContent: string
  repairApplied: boolean
  repairWarnings: string[]
}

/**
 * Full validation for PROM22 (beads refinement) output.
 * Mirrors the sophistication of Interview and PRD refinement validators:
 *  - Canonicalizes changes against winner and refined bead items
 *  - Detects and drops no-op changes
 *  - Synthesizes omitted changes for beads modified but not listed
 *  - Hydrates inspiration attribution with losing draft metadata
 */
export function normalizeBeadRefinementOutput(
  rawContent: string,
  winnerDraftContent: string,
  losingDraftMeta?: Array<{ memberId: string; content?: string }>,
): StructuredOutputResult<ValidatedBeadRefinementResult> {
  // Step 1: Parse the refined output using existing normalizer
  const refinedResult = normalizeBeadSubsetYamlOutput(rawContent, losingDraftMeta)
  if (!refinedResult.ok) {
    return refinedResult as StructuredOutputResult<ValidatedBeadRefinementResult>
  }

  const refinedBeads: BeadSubset[] = refinedResult.value
  const rawChanges: RefinementChange[] = Array.isArray(refinedResult.value.changes)
    ? refinedResult.value.changes
    : []

  // Step 2: Parse the winner draft
  const winnerResult = normalizeBeadSubsetYamlOutput(winnerDraftContent)
  if (!winnerResult.ok) {
    // Every consumer cross-validates the refined beads against the winner, so
    // accepting raw changes here published an unchecked change list as valid.
    // Fail retryably instead.
    return buildStructuredOutputFailure(
      rawContent,
      `Could not parse the winner bead draft required for refinement cross-validation: ${winnerResult.error}`,
      {
        repairApplied: refinedResult.repairApplied,
        repairWarnings: refinedResult.repairWarnings,
      },
    )
  }

  const winnerBeads: BeadSubset[] = winnerResult.value
  const repairWarnings = [...refinedResult.repairWarnings]
  let repairApplied = refinedResult.repairApplied

  // If no changes were provided, try to synthesize all of them
  if (rawChanges.length === 0) {
    const winnerItems = winnerBeads.map(buildBeadItemFromSubset)
    const refinedItems = refinedBeads.map(buildBeadItemFromSubset)
    const synthesized = synthesizeAllBeadChanges(winnerItems, refinedItems)
    if (synthesized.changes.length > 0) {
      repairApplied = true
      repairWarnings.push(...synthesized.repairWarnings)
    }

    return {
      ok: true,
      value: {
        beads: refinedBeads,
        changes: synthesized.changes,
        normalizedContent: refinedResult.normalizedContent,
        repairApplied,
        repairWarnings,
      },
      normalizedContent: refinedResult.normalizedContent,
      repairApplied,
      repairWarnings,
    }
  }

  // Step 3: Build lookups
  const winnerItems = winnerBeads.map(buildBeadItemFromSubset)
  const refinedItems = refinedBeads.map(buildBeadItemFromSubset)
  const winnerLookup = buildBeadLookup(winnerItems)
  const refinedLookup = buildBeadLookup(refinedItems)

  const usedBeforeIds = new Set<string>()
  const usedAfterIds = new Set<string>()
  const validatedChanges: RefinementChange[] = []

  // Step 4: Canonicalize, validate, and filter changes
  for (const [index, change] of rawChanges.entries()) {
    const before = change.before
      ? resolveBeadChangeItem(change.before, winnerLookup)
      : null
    const after = change.after
      ? resolveBeadChangeItem(change.after, refinedLookup)
      : null

    // Type-specific validation (lenient — log warnings instead of throwing)
    if (change.type === 'modified') {
      if (!before && !after) {
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

    // No-op detection: drop changes where before and after are identical
    if (before && after && before.contentFingerprint === after.contentFingerprint) {
      repairApplied = true
      repairWarnings.push(`Dropped no-op beads refinement modified change at index ${index} because the winning and refined bead "${before.id}" are identical.`)
      continue
    }

    // Track used IDs for synthesis
    if (before) usedBeforeIds.add(before.id)
    if (after) usedAfterIds.add(after.id)

    // Hydrate inspiration attribution
    let inspiration = change.inspiration ?? null
    let attributionStatus = change.attributionStatus ?? (inspiration ? 'inspired' : 'model_unattributed')

    if (inspiration) {
      const losingDraft = losingDraftMeta?.[inspiration.draftIndex]
      if (!losingDraft) {
        const draftNumber = inspiration.draftIndex + 1
        inspiration = null
        attributionStatus = 'invalid_unattributed'
        repairApplied = true
        repairWarnings.push(`Cleared out-of-range beads refinement inspiration at index ${index} because alternative draft ${draftNumber} does not exist.`)
      } else {
        // Hydrate with losing draft memberId and optionally enrich item
        const enrichedItem = enrichInspirationFromLosingDraft(inspiration, losingDraft)
        inspiration = {
          ...inspiration,
          memberId: losingDraft.memberId,
          ...(enrichedItem ? { item: enrichedItem } : {}),
        }
        attributionStatus = 'inspired'
      }
    } else if (attributionStatus === 'inspired') {
      attributionStatus = 'model_unattributed'
    }

    validatedChanges.push({
      type: change.type,
      itemType: 'bead',
      before: before ? { id: before.id, label: before.label, detail: before.detail } : change.before ?? null,
      after: after ? { id: after.id, label: after.label, detail: after.detail } : change.after ?? null,
      inspiration,
      attributionStatus,
    })
  }

  // Step 5: Synthesize omitted changes
  const synthesized = synthesizeOmittedBeadChanges(
    winnerItems,
    refinedItems,
    usedBeforeIds,
    usedAfterIds,
  )
  if (synthesized.changes.length > 0) {
    repairApplied = true
    repairWarnings.push(...synthesized.repairWarnings)
    validatedChanges.push(...synthesized.changes)
  }

  return {
    ok: true,
    value: {
      beads: refinedBeads,
      changes: validatedChanges,
      normalizedContent: refinedResult.normalizedContent,
      repairApplied,
      repairWarnings,
    },
    normalizedContent: refinedResult.normalizedContent,
    repairApplied,
    repairWarnings,
  }
}

/**
 * Enrich inspiration item with content from the losing draft (if available).
 */
function enrichInspirationFromLosingDraft(
  inspiration: NonNullable<RefinementChange['inspiration']>,
  losingDraft: { memberId: string; content?: string },
): RefinementChangeItem | null {
  if (!losingDraft.content || !inspiration.item) return null

  const losingResult = normalizeBeadSubsetYamlOutput(losingDraft.content)
  if (!losingResult.ok) return null

  const losingBeads: BeadSubset[] = losingResult.value
  const inspirationId = inspiration.item.id
  const inspirationLabel = inspiration.item.label?.toLowerCase().trim()

  for (const bead of losingBeads) {
    if (
      bead.id === inspirationId
      || bead.title.toLowerCase().trim() === inspirationLabel
    ) {
      return {
        id: bead.id,
        label: bead.title,
        detail: inspiration.item.detail || bead.description,
      }
    }
  }

  return null
}

/**
 * Synthesize changes for beads that were modified (different content fingerprint)
 * but not listed in the explicit changes array.
 */
function synthesizeOmittedBeadChanges(
  winnerItems: NormalizedBeadItem[],
  refinedItems: NormalizedBeadItem[],
  usedBeforeIds: Set<string>,
  usedAfterIds: Set<string>,
): {
  changes: RefinementChange[]
  repairWarnings: string[]
} {
  const changes: RefinementChange[] = []
  const repairWarnings: string[] = []
  const refinedById = new Map(refinedItems.map((item) => [item.id, item]))

  for (const winnerItem of winnerItems) {
    if (usedBeforeIds.has(winnerItem.id)) continue

    const refinedItem = refinedById.get(winnerItem.id)
    if (!refinedItem) continue
    if (usedAfterIds.has(refinedItem.id)) continue

    // Same ID exists in both — check if content actually changed
    if (winnerItem.contentFingerprint === refinedItem.contentFingerprint) continue

    usedBeforeIds.add(winnerItem.id)
    usedAfterIds.add(refinedItem.id)
    changes.push({
      type: 'modified',
      itemType: 'bead',
      before: { id: winnerItem.id, label: winnerItem.label, detail: winnerItem.detail },
      after: { id: refinedItem.id, label: refinedItem.label, detail: refinedItem.detail },
      inspiration: null,
      attributionStatus: 'synthesized_unattributed',
    })
    repairWarnings.push(
      `Synthesized omitted beads refinement modified change for bead "${winnerItem.id}" by matching id across the winning and refined drafts.`,
    )
  }

  // Detect added beads (in refined but not in winner)
  const winnerIds = new Set(winnerItems.map((item) => item.id))
  for (const refinedItem of refinedItems) {
    if (usedAfterIds.has(refinedItem.id)) continue
    if (winnerIds.has(refinedItem.id)) continue

    usedAfterIds.add(refinedItem.id)
    changes.push({
      type: 'added',
      itemType: 'bead',
      before: null,
      after: { id: refinedItem.id, label: refinedItem.label, detail: refinedItem.detail },
      inspiration: null,
      attributionStatus: 'synthesized_unattributed',
    })
    repairWarnings.push(
      `Synthesized omitted beads refinement added change for bead "${refinedItem.id}" (present in refined output but not in winner draft).`,
    )
  }

  // Detect removed beads (in winner but not in refined)
  const refinedIds = new Set(refinedItems.map((item) => item.id))
  for (const winnerItem of winnerItems) {
    if (usedBeforeIds.has(winnerItem.id)) continue
    if (refinedIds.has(winnerItem.id)) continue

    usedBeforeIds.add(winnerItem.id)
    changes.push({
      type: 'removed',
      itemType: 'bead',
      before: { id: winnerItem.id, label: winnerItem.label, detail: winnerItem.detail },
      after: null,
      inspiration: null,
      attributionStatus: 'synthesized_unattributed',
    })
    repairWarnings.push(
      `Synthesized omitted beads refinement removed change for bead "${winnerItem.id}" (present in winner draft but not in refined output).`,
    )
  }

  return { changes, repairWarnings }
}

/**
 * When no changes list is provided at all, synthesize the full diff
 * by comparing winner and refined bead sets.
 */
function synthesizeAllBeadChanges(
  winnerItems: NormalizedBeadItem[],
  refinedItems: NormalizedBeadItem[],
): {
  changes: RefinementChange[]
  repairWarnings: string[]
} {
  return synthesizeOmittedBeadChanges(
    winnerItems,
    refinedItems,
    new Set(),
    new Set(),
  )
}

function parseJsonLines(content: string): unknown[] {
  const trimmed = content.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : []
  }

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function normalizeNoteHistory(value: unknown): Bead['failedIterationNotes'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp.trim() : ''
    const iteration = Number(entry.iteration)
    const content = typeof entry.content === 'string' ? entry.content : ''
    const errorCode = typeof entry.errorCode === 'string' ? entry.errorCode.trim() : ''
    if (!timestamp || !Number.isInteger(iteration) || iteration < 1 || !content.trim()) return []
    return [{ timestamp, iteration, content, ...(errorCode ? { errorCode } : {}) }]
  })
}

/**
 * The legacy aliases are kept, but anything else used to be cast straight to
 * `Bead['status']`. A stored `complete` or `todo` then stalled the scheduler,
 * which only runs `pending` and only finishes on `done`, with no validation error
 * anywhere.
 */
function normalizeBeadStatus(value: unknown, label: string): BeadStatus {
  if (value === undefined || value === null) return 'pending'
  const raw = typeof value === 'string' ? value.trim() : ''
  // Case is folded here as it is on the read path. Rejecting `Completed` while
  // accepting `completed` spent a structured retry on a capital letter, and the
  // same value read back off disk was accepted anyway.
  const folded = raw.toLowerCase()
  const mapped = resolveBeadStatusAlias(folded) ?? folded
  if (!isBeadStatus(mapped)) {
    throw new Error(`${label} has an unsupported status "${String(value)}" (expected one of ${BEAD_STATUSES.join(', ')})`)
  }
  return mapped
}

/**
 * `iteration` counts execution attempts from 1. A zero, a negative or a
 * fractional value is not a wire-format the models are told to emit, and
 * `Number('x')` produced NaN that serialised back as null, so clamp and say so
 * rather than rejecting the whole record.
 *
 * The plan called this field non-negative; 1 is the floor because attempts are
 * counted from 1 and every reader assumes it. The ticket's `maxIterations` is a
 * different field with a similar name, and there 0 is meaningful — it means no
 * cap.
 */
function normalizeBeadIteration(value: unknown, label: string, repairWarnings: string[]): number {
  if (value === undefined || value === null) return 1
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed > 0) return parsed
  repairWarnings.push(`${label}: replaced invalid iteration ${JSON.stringify(value)} with 1.`)
  return 1
}

function normalizeBeadRecord(value: unknown, index: number, repairWarnings: string[]): Bead {
  if (!isRecord(value)) throw new Error(`Bead JSONL entry at index ${index} is not an object`)

  const dependencies = normalizeDependencies(getValueByAliases(value, ['dependencies']))

  const normalizedGuidance = normalizeContextGuidance(
    getValueByAliases(value, ['contextguidance', 'context_guidance']),
    index,
    repairWarnings,
  )

  const status = normalizeBeadStatus(getValueByAliases(value, ['status']), `Bead at index ${index}`)

  const testCommandsValue = getValueByAliases(value, ['testcommands', 'test_commands'])
  const testCommands = normalizeCommandSpecs(testCommandsValue, `Bead at index ${index}`, repairWarnings)
  const testCommandReasonValue = getValueByAliases(value, ['testcommandreason', 'test_command_reason'])
  if (testCommandReasonValue !== undefined && (typeof testCommandReasonValue !== 'string' || !testCommandReasonValue.trim())) {
    throw new Error(`Bead at index ${index} contains an invalid testCommandReason`)
  }
  const testCommandReason = typeof testCommandReasonValue === 'string' ? testCommandReasonValue.trim() : ''

  const bead: Bead = {
    id: getRequiredString(value, ['id'], `bead id at index ${index}`),
    title: getRequiredString(value, ['title'], `bead title at index ${index}`),
    prdRefs: toStringArray(getValueByAliases(value, ['prdrefs', 'prd_refs', 'prdreferences', 'prd_references'])),
    description: getRequiredString(value, ['description'], `bead description at index ${index}`),
    contextGuidance: normalizedGuidance,
    acceptanceCriteria: toStringArray(getValueByAliases(value, ['acceptancecriteria', 'acceptance_criteria'])),
    tests: toStringArray(getValueByAliases(value, ['tests'])),
    testCommands,
    ...(testCommandReason ? { testCommandReason } : {}),
    priority: Number(getValueByAliases(value, ['priority']) ?? index + 1),
    status,
    issueType: getStringByAliases(value, ['issuetype', 'issue_type'])?.trim() ?? 'task',
    externalRef: getStringByAliases(value, ['externalref', 'external_ref'])?.trim() ?? '',
    labels: toStringArray(getValueByAliases(value, ['labels'])),
    dependencies,
    targetFiles: toStringArray(getValueByAliases(value, ['targetfiles', 'target_files'])),
    failedIterationNotes: normalizeNoteHistory(getValueByAliases(value, ['failediterationnotes', 'failed_iteration_notes'])),
    userRetryNotes: normalizeNoteHistory(getValueByAliases(value, ['userretrynotes', 'user_retry_notes'])),
    finalizationFailureNotes: normalizeNoteHistory(getValueByAliases(value, ['finalizationfailurenotes', 'finalization_failure_notes'])),
    iteration: normalizeBeadIteration(getValueByAliases(value, ['iteration']), `Bead at index ${index}`, repairWarnings),
    createdAt: getStringByAliases(value, ['createdat', 'created_at'])?.trim() ?? '',
    updatedAt: getStringByAliases(value, ['updatedat', 'updated_at'])?.trim() ?? '',
    completedAt: getStringByAliases(value, ['completedat', 'completed_at'])?.trim() ?? '',
    startedAt: getStringByAliases(value, ['startedat', 'started_at'])?.trim() ?? '',
    beadStartCommit: getStringByAliases(value, ['beadstartcommit', 'bead_start_commit'])?.trim() || null,
  }

  if (!Number.isInteger(bead.priority) || bead.priority <= 0) {
    throw new Error(`Bead ${bead.id} has invalid priority`)
  }
  if (bead.acceptanceCriteria.length === 0) {
    throw new Error(`Bead ${bead.id} is missing acceptance criteria`)
  }
  if (bead.tests.length === 0) {
    throw new Error(`Bead ${bead.id} is missing tests`)
  }
  if (bead.testCommands.length === 0 && !bead.testCommandReason) {
    throw new Error(`Bead ${bead.id} requires testCommandReason when testCommands is empty`)
  }
  if (bead.testCommands.length > 0 && bead.testCommandReason) {
    throw new Error(`Bead ${bead.id} may include testCommandReason only when testCommands is empty`)
  }

  return bead
}

export function normalizeBeadsJsonlOutput(rawContent: string): StructuredOutputResult<Bead[]> {
  // One shared array reported the repairs attempted on a rejected candidate
  // against whichever candidate eventually validated, so keep them per candidate
  // and carry only the last one's forward for the failure message.
  let repairWarnings: string[] = []
  const candidates = collectStructuredCandidates(rawContent)
  let lastError = 'No beads JSONL content found'
  let lastErrorCause: unknown = null

  for (const candidate of candidates) {
    const candidateWarnings: string[] = []
    const releaseAliasConflicts = collectAliasConflictWarnings(candidateWarnings)
    try {
      const parsedEntries = parseJsonLines(candidate)
      if (parsedEntries.length === 0) throw new Error('Beads JSONL output is empty')

      const beads = parsedEntries.map((entry, index) => normalizeBeadRecord(entry, index, candidateWarnings))
      const beadIds = new Set<string>()
      for (const bead of beads) {
        if (beadIds.has(bead.id)) throw new Error(`Duplicate bead id: ${bead.id}`)
        beadIds.add(bead.id)
        if (bead.dependencies.blocked_by.includes(bead.id) || bead.dependencies.blocks.includes(bead.id)) {
          throw new Error(`Bead ${bead.id} has a self-dependency`)
        }
        for (const dependency of bead.dependencies.blocked_by) {
          if (!beadIds.has(dependency) && !beads.some((candidateBead) => candidateBead.id === dependency)) {
            throw new Error(`Bead ${bead.id} depends on unknown bead ${dependency}`)
          }
        }
      }

      for (const bead of beads) {
        if (bead.contextGuidance.patterns.length === 0 || bead.contextGuidance.anti_patterns.length === 0) {
          throw new Error(`Bead ${bead.id} contextGuidance must include both patterns and anti_patterns`)
        }
      }
      appendStructuredCandidateRecoveryWarning(candidateWarnings, rawContent, candidate)

      return {
        ok: true,
        value: beads,
        normalizedContent: buildJsonlDocument(beads),
        repairApplied: candidate !== rawContent.trim() || candidateWarnings.length > 0,
        repairWarnings: candidateWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
      repairWarnings = candidateWarnings
    } finally {
      releaseAliasConflicts()
    }
  }

  return buildStructuredOutputFailure(
    rawContent,
    looksLikePromptEcho(rawContent)
      ? 'Beads JSONL output echoed the prompt instead of returning bead records'
      : lastError,
    {
      repairWarnings,
      cause: lastErrorCause,
    },
  )
}

/** Truncate YAML content to only complete file entries when the last entry is incomplete (truncated output) */
function truncateToCompleteFileEntries(content: string): string | null {
  const lines = content.split('\n')
  // Find all `  - path:` item boundaries (list items under files:)
  const itemStarts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^\s+-\s+(path|filepath|file_path|file)\s*:/.test(lines[i]!)) {
      itemStarts.push(i)
    }
  }
  // Need at least 2 items to truncate the last one
  if (itemStarts.length < 2) return null
  // Keep everything up to (but not including) the last item
  const cutoff = itemStarts[itemStarts.length - 1]!
  const truncated = lines.slice(0, cutoff).join('\n').trimEnd()
  return truncated || null
}

function parsesAsPlainYamlOrJson(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed) return false

  try {
    JSON.parse(trimmed)
    return true
  } catch {
    try {
      jsYaml.load(trimmed)
      return true
    } catch {
      return false
    }
  }
}

export function normalizeRelevantFilesOutput(rawContent: string): StructuredOutputResult<RelevantFilesOutputPayload> {
  const candidates = collectTaggedCandidates(rawContent, PROTOCOL_TAGS.RELEVANT_FILES_RESULT)

  // Also try structured candidates as fallback
  const fallbackCandidates = collectStructuredCandidates(rawContent, {
    topLevelHints: ['file_count', 'files'],
  })
  const allCandidates = [...candidates, ...fallbackCandidates]
  const seen = new Set<string>()
  const uniqueCandidates = allCandidates.filter((c) => {
    if (seen.has(c)) return false
    seen.add(c)
    return true
  })

  let lastError = 'No relevant files content found'
  let lastErrorCause: unknown = null

  for (const candidate of uniqueCandidates) {
    const candidateWarnings: string[] = []
    const releaseAliasConflicts = collectAliasConflictWarnings(candidateWarnings)
    try {
      if (looksLikePromptEcho(candidate)) {
        throw new Error(`Relevant files output echoed the prompt instead of returning a ${openTag(PROTOCOL_TAGS.RELEVANT_FILES_RESULT)} artifact`)
      }

      let yamlParsed: unknown
      try {
        yamlParsed = parseYamlOrJsonCandidate(candidate, {
          sequenceItemPrimaryKeys: RELEVANT_FILES_SEQUENCE_ITEM_PRIMARY_KEYS,
          repairWarnings: candidateWarnings,
        })
      } catch (parseErr) {
        // Truncation recovery: trim the last incomplete file entry and retry
        const truncated = truncateToCompleteFileEntries(candidate)
        if (truncated) {
          try {
            yamlParsed = parseYamlOrJsonCandidate(truncated, {
              sequenceItemPrimaryKeys: RELEVANT_FILES_SEQUENCE_ITEM_PRIMARY_KEYS,
              repairWarnings: candidateWarnings,
            })
            candidateWarnings.push('Truncated incomplete last file entry to recover from malformed YAML.')
          } catch {
            throw parseErr
          }
        } else {
          throw parseErr
        }
      }

      const parsed = maybeUnwrapRecord(yamlParsed, [
        'relevantfilesresult',
        'relevant_files_result',
        'relevantfiles',
        'relevant_files',
        'payload',
        'result',
        'output',
        'data',
        'artifact',
      ])
      if (!isRecord(parsed)) throw new Error('Relevant files output is not a YAML/JSON object')
      if (parsed !== yamlParsed && isRecord(yamlParsed)) {
        appendWrapperKeyRepairWarning(candidateWarnings, findMaybeUnwrappedWrapperPath(yamlParsed, [
          'relevantfilesresult',
          'relevant_files_result',
          'relevantfiles',
          'relevant_files',
          'payload',
          'result',
          'output',
          'data',
          'artifact',
        ]))
      }

      const rawFiles = getValueByAliases(parsed, ['files'])
      if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
        throw new Error('Relevant files output is missing files list')
      }

      const files: RelevantFilesOutputEntry[] = rawFiles.map((entry: unknown, index: number) => {
        if (!isRecord(entry)) throw new Error(`Relevant file at index ${index} is not an object`)

        const path = getRequiredString(entry, ['path', 'filepath', 'file_path', 'file'], `file path at index ${index}`)
        const rationale = getStringByAliases(entry, ['rationale', 'reason', 'why'])?.trim() ?? ''
        const relevance = getStringByAliases(entry, ['relevance'])?.trim().toLowerCase() ?? 'medium'
        const likelyAction = getStringByAliases(entry, ['likelyaction', 'likely_action', 'action'])?.trim().toLowerCase() ?? 'read'
        const content = getStringByAliases(entry, ['content', 'contents', 'code', 'source', 'snippet', 'excerpt']) ?? ''
        const contentPreview = getStringByAliases(entry, ['content_preview', 'contentpreview', 'preview', 'signatures']) ?? ''

        return { path, rationale, relevance, likely_action: likelyAction, content, content_preview: contentPreview || content }
      })

      const payload: RelevantFilesOutputPayload = {
        file_count: files.length,
        files,
      }
      appendStructuredCandidateRecoveryWarning(candidateWarnings, rawContent, candidate, { tag: PROTOCOL_TAGS.RELEVANT_FILES_RESULT })

      return {
        ok: true,
        value: payload,
        normalizedContent: buildYamlDocument(payload),
        repairApplied: candidateWarnings.length > 0 || shouldRecordStructuredCandidateRecovery(rawContent, candidate, { tag: PROTOCOL_TAGS.RELEVANT_FILES_RESULT }) || (
          !parsesAsPlainYamlOrJson(candidate)
        ),
        repairWarnings: candidateWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
    } finally {
      releaseAliasConflicts()
    }
  }

  return buildStructuredOutputFailure(
    rawContent,
    looksLikePromptEcho(rawContent)
      ? `Relevant files output echoed the prompt instead of returning a ${openTag(PROTOCOL_TAGS.RELEVANT_FILES_RESULT)} artifact`
      : lastError,
    { cause: lastErrorCause },
  )
}
