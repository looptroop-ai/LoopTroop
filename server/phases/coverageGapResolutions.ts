import {
  getStringByAliases,
  getValueByAliases,
  isRecord,
  normalizeKey,
} from '../structuredOutput/yamlUtils'
import { matchCoverageGapReference } from './coverageGapMatching'

/**
 * The gap-resolution loop the PRD and beads coverage revisions both run.
 *
 * The two were near copies of a hundred and fifty lines: the same shape
 * validation, the same alias handling, the same duplicate- and missing-gap
 * accounting, differing only in the item type they resolve and the action
 * vocabulary they accept. Keeping them apart meant a repair added to one silently
 * did not apply to the other.
 *
 * What stays per phase is what genuinely differs: the action names, and how an
 * affected item is recognised and canonicalised. Those come in as callbacks so
 * neither phase has to widen its types to accommodate the other.
 */

export interface CoverageAffectedItem<TItemType extends string> {
  itemType: TItemType
  id: string
  label: string
}

export interface CoverageGapResolution<TAction extends string, TItemType extends string> {
  gap: string
  action: TAction
  rationale: string
  affectedItems: CoverageAffectedItem<TItemType>[]
}

export interface AffectedItemInput {
  /** Raw `id` from the model, trimmed. May be empty. */
  id: string
  /** Raw `label`/`title` from the model, trimmed. May be empty. */
  label: string
  /** Raw `item_type` from the model, before any normalisation. */
  rawItemType: unknown
  /** The gap this item was listed under, for message text. */
  gap: string
  /** Position within this gap's `affected_items`, for message text. */
  itemIndex: number
  /** Somewhere for the resolver to record a repair it applied. */
  repairWarnings: string[]
}

export interface CoverageGapResolutionOptions<TAction extends string, TItemType extends string> {
  /** Leads every message: `PRD` or `Beads`. */
  label: string
  /** Prefix `matchCoverageGapReference` puts on its canonicalisation warning. */
  gapMatchLabel: string
  /** Maps a normalised action string to this phase's vocabulary, or null. */
  resolveAction: (normalizedAction: string) => TAction | null
  /**
   * Resolves one affected item.
   *
   * Returns null to drop the entry — the resolver is expected to have recorded
   * why in `repairWarnings` — and throws when the entry is unusable.
   */
  resolveAffectedItem: (input: AffectedItemInput) => CoverageAffectedItem<TItemType> | null
}

export function parseCoverageGapResolutions<TAction extends string, TItemType extends string>(
  parsed: Record<string, unknown>,
  coverageGaps: string[],
  options: CoverageGapResolutionOptions<TAction, TItemType>,
): {
  gapResolutions: CoverageGapResolution<TAction, TItemType>[]
  repairWarnings: string[]
} {
  const { label } = options
  const rawGapResolutions = getValueByAliases(parsed, ['gap_resolutions', 'gapresolutions'])
  if (!Array.isArray(rawGapResolutions)) {
    throw new Error(`${label} coverage revision output must include a top-level gap_resolutions list`)
  }

  const repairWarnings: string[] = []
  const resolutions: CoverageGapResolution<TAction, TItemType>[] = []

  for (const [index, value] of rawGapResolutions.entries()) {
    if (!isRecord(value)) {
      throw new Error(`${label} coverage gap_resolutions entry at index ${index} is not an object`)
    }

    const gap = getStringByAliases(value, ['gap'])?.trim() ?? ''
    if (!gap) {
      throw new Error(`${label} coverage gap_resolutions entry at index ${index} is missing gap`)
    }

    const rawAction = getStringByAliases(value, ['action'])?.trim() ?? ''
    const action = options.resolveAction(normalizeKey(rawAction))
    if (!action) {
      throw new Error(`${label} coverage gap_resolutions entry for "${gap}" has unsupported action "${rawAction}"`)
    }

    const rationale = getStringByAliases(value, ['rationale'])?.trim() ?? ''
    if (!rationale) {
      throw new Error(`${label} coverage gap_resolutions entry for "${gap}" is missing rationale`)
    }

    const rawAffectedItems = getValueByAliases(value, ['affected_items', 'affecteditems'])
    const affectedItems = Array.isArray(rawAffectedItems)
      ? rawAffectedItems.flatMap((item, itemIndex) => {
          if (!isRecord(item)) {
            throw new Error(`${label} coverage affected_items entry at gap "${gap}" index ${itemIndex} is not an object`)
          }
          const resolved = options.resolveAffectedItem({
            id: getStringByAliases(item, ['id'])?.trim() ?? '',
            label: getStringByAliases(item, ['label', 'title'])?.trim() ?? '',
            rawItemType: getValueByAliases(item, ['item_type', 'itemtype']),
            gap,
            itemIndex,
            repairWarnings,
          })
          return resolved ? [resolved] : []
        })
      : []

    resolutions.push({ gap, action, rationale, affectedItems })
  }

  const normalizedCoverageGaps = coverageGaps.map((gap) => gap.trim()).filter(Boolean)
  const seen = new Set<string>()
  for (const resolution of resolutions) {
    const matchedGap = matchCoverageGapReference(resolution.gap, normalizedCoverageGaps, options.gapMatchLabel)
    if (!matchedGap) {
      throw new Error(`${label} coverage gap_resolutions entry references unknown gap "${resolution.gap}"`)
    }
    if (seen.has(matchedGap.gap)) {
      throw new Error(`${label} coverage gap_resolutions contains duplicate entry for "${matchedGap.gap}"`)
    }
    if (matchedGap.gap !== resolution.gap) {
      resolution.gap = matchedGap.gap
    }
    if (matchedGap.repairWarning) {
      repairWarnings.push(matchedGap.repairWarning)
    }
    seen.add(matchedGap.gap)
  }

  const missingGaps = normalizedCoverageGaps.filter((gap) => !seen.has(gap))
  if (missingGaps.length > 0) {
    throw new Error(`${label} coverage gap_resolutions must include exactly one entry per gap. Missing: ${missingGaps.join(' | ')}`)
  }

  return { gapResolutions: resolutions, repairWarnings }
}
