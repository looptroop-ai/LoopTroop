import type {
  RefinementChange,
  RefinementChangeAttributionStatus,
  RefinementChangeInspiration,
  RefinementChangeItem,
  RefinementChangeType,
} from '@shared/refinementChanges'
import { isRecord, normalizeKey, getValueByAliases, toOrdinalInteger, toOptionalString } from './yamlUtils'

function normalizeRefinementChangeType(value: unknown): RefinementChangeType | null {
  const raw = toOptionalString(value)
  if (!raw) return null
  const normalized = normalizeKey(raw)
  if (normalized === 'modified') return 'modified'
  if (normalized === 'added') return 'added'
  if (normalized === 'removed') return 'removed'
  return null
}

function hasSummaryOnlyChangeMetadata(value: Record<string, unknown>): boolean {
  return [
    'path',
    'summary',
    'before_summary',
    'beforeSummary',
    'after_summary',
    'afterSummary',
  ].some((alias) => getValueByAliases(value, [alias]) !== undefined)
}

function normalizeRefinementChangeItem(value: unknown): RefinementChangeItem | null {
  if (!isRecord(value)) return null
  const id = toOptionalString(getValueByAliases(value, ['id']))
  const label = toOptionalString(getValueByAliases(value, ['title', 'label', 'name']))
  if (!id || !label) return null
  const detail = toOptionalString(getValueByAliases(value, ['detail', 'description', 'objective']))
  return { id, label, ...(detail ? { detail } : {}) }
}

// Lenient parser for inspiration items — mirrors how interviewOutput.ts
// normalizeInterviewInspirationQuestion accepts strings and partial objects.
// Unlike normalizeRefinementChangeItem (used for before/after), this does NOT
// require both id and label — models frequently omit one or output a bare string.
function normalizeInspirationItem(value: unknown): RefinementChangeItem | null {
  if (typeof value === 'string') {
    const label = value.trim()
    if (!label) return null
    return { id: '', label }
  }

  if (!isRecord(value)) return null

  const id = toOptionalString(getValueByAliases(value, ['id'])) ?? ''
  const label = toOptionalString(
    getValueByAliases(value, ['title', 'label', 'name', 'text', 'content', 'description']),
  ) ?? ''
  if (!id && !label) return null

  const detail = id && label
    ? toOptionalString(getValueByAliases(value, ['detail', 'description', 'objective']))
    : undefined

  return { id, label, ...(detail ? { detail } : {}) }
}

/**
 * Resolves which losing draft an inspiration entry points at.
 *
 * Interview refinement and the shared change parser each had their own copy of
 * this, in normalisers that otherwise differ on purpose. Only the reference
 * resolution is shared; what each does with the result is not.
 */
export function resolveLosingDraftReference(
  rawReference: unknown,
  losingDraftMeta?: Array<{ memberId: string }>,
): { draftIndex: number; memberId: string } {
  const rawAltDraft = isRecord(rawReference)
    ? getValueByAliases(rawReference, ['alternative_draft', 'alternativedraft', 'draft', 'draft_index', 'draftindex'])
    : undefined

  if (typeof rawAltDraft === 'string' && losingDraftMeta) {
    const rawTrimmed = rawAltDraft.trim()
    const foundIndex = losingDraftMeta.findIndex((m) => m.memberId === rawTrimmed)
    // The match is on `memberId`, so the found entry's is the string we matched.
    if (foundIndex >= 0) {
      return { draftIndex: foundIndex, memberId: rawTrimmed }
    }
  }

  // Draft references are 1-based ordinals. `toOrdinalInteger` will hand back a
  // zero or a negative, which became `draftIndex: -1` or `-2`;
  // `normalizeRefinementInspiration` only rejects `-1`, so `-2` was accepted as
  // a real reference to a draft that does not exist.
  const altDraft = toOrdinalInteger(rawAltDraft)
  if (altDraft == null || altDraft < 1) return { draftIndex: -1, memberId: '' }

  // A `draftIndex` outside the list still travels back to the caller, which
  // reports it; only the member name it could not resolve is blank.
  const draftIndex = altDraft - 1
  return {
    draftIndex,
    memberId: draftIndex >= 0 ? losingDraftMeta?.[draftIndex]?.memberId ?? '' : '',
  }
}

function normalizeRefinementInspiration(
  value: unknown,
  losingDraftMeta?: Array<{ memberId: string }>,
): RefinementChangeInspiration | null {
  if (!isRecord(value)) return null

  const reference = resolveLosingDraftReference(value, losingDraftMeta)
  const draftIndex = reference.draftIndex
  let memberId = reference.memberId

  if (!memberId) {
    memberId = toOptionalString(getValueByAliases(value, ['member_id', 'memberid', 'memberId'])) ?? ''
  }

  const rawItem = getValueByAliases(value, ['item', 'bead', 'epic', 'story'])
  const item = normalizeInspirationItem(rawItem)

  if (draftIndex === -1 || !item) return null

  return { draftIndex, memberId, item }
}

export function parseRefinementChanges(
  rawChanges: unknown,
  losingDraftMeta?: Array<{ memberId: string }>,
): {
  changes: RefinementChange[]
  repairWarnings: string[]
} {
  if (!Array.isArray(rawChanges)) {
    return { changes: [], repairWarnings: [] }
  }

  const changes: RefinementChange[] = []
  const repairWarnings: string[] = []

  for (let index = 0; index < rawChanges.length; index += 1) {
    const entry = rawChanges[index]
    if (!isRecord(entry)) {
      repairWarnings.push(`Skipped non-object refinement change at index ${index}.`)
      continue
    }

    const type = normalizeRefinementChangeType(getValueByAliases(entry, ['type', 'change_type']))
    if (!type) {
      repairWarnings.push(`Skipped refinement change at index ${index} with invalid type.`)
      continue
    }

    const itemType = toOptionalString(getValueByAliases(entry, ['item_type', 'itemtype', 'itemType']))

    const rawBefore = getValueByAliases(entry, ['before'])
    const rawAfter = getValueByAliases(entry, ['after'])
    if (rawBefore === undefined && rawAfter === undefined && hasSummaryOnlyChangeMetadata(entry)) {
      repairWarnings.push(`Skipped refinement change at index ${index} with path/summary metadata only; semantic before/after item records are required.`)
      continue
    }

    const before = rawBefore === null ? null : normalizeRefinementChangeItem(rawBefore)
    const after = rawAfter === null ? null : normalizeRefinementChangeItem(rawAfter)

    const rawInspiration = getValueByAliases(entry, ['inspiration', 'inspired_by'])
    const inspiration = rawInspiration === null || rawInspiration === undefined
      ? null
      : normalizeRefinementInspiration(rawInspiration, losingDraftMeta)
    const attributionStatus: RefinementChangeAttributionStatus = inspiration
      ? 'inspired'
      : rawInspiration === null || rawInspiration === undefined
        ? 'model_unattributed'
        : 'invalid_unattributed'

    changes.push({
      type,
      ...(itemType ? { itemType } : {}),
      before,
      after,
      inspiration,
      attributionStatus,
    })
  }

  return { changes, repairWarnings }
}

/**
 * Takes `changes` off a parsed refinement record and parses it.
 *
 * Both the beads and PRD normalisers read the alias, deleted the key so the rest
 * of the document could be validated against a schema that does not have it, and
 * then parsed it — three steps written twice.
 */
export function takeRefinementChanges(
  parsed: unknown,
  losingDraftMeta?: Array<{ memberId: string }>,
): { changes: RefinementChange[]; repairWarnings: string[] } {
  if (!isRecord(parsed)) return { changes: [], repairWarnings: [] }

  const rawChanges = getValueByAliases(parsed, ['changes'])
  if (rawChanges !== undefined) {
    // The lookup normalises keys, so a document writing `Changes:` is found
    // here but was not the key being deleted, and it survived into a schema
    // validation that does not expect it.
    for (const key of Object.keys(parsed)) {
      if (normalizeKey(key) === 'changes') delete parsed[key]
    }
  }
  return parseRefinementChanges(rawChanges, losingDraftMeta)
}
