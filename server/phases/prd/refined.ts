import * as jsYaml from 'js-yaml'
import type {
  RefinementChange,
  RefinementChangeAttributionStatus,
  RefinementChangeItem,
} from '@shared/refinementChanges'
import { renderCommandSpec } from '@shared/commandSpec'
import { isRecord } from '@shared/typeGuards'
import type { PromptPart } from '../../opencode/types'
import type {
  PrdDocument,
  PrdDraftMetrics,
  StructuredOutputMetadata,
} from '../../structuredOutput'
import { getPrdDraftMetrics, normalizePrdYamlOutput } from '../../structuredOutput'
import { normalizeStructuredOutputMetadata } from '../../structuredOutput/metadata'
import { normalizeKey } from '../../structuredOutput/yamlUtils'
import { attachStructuredRetryDiagnostic, buildStructuredRetryDiagnostic } from '../../lib/structuredRetryDiagnostics'

type PrdRefinementItemType = 'epic' | 'user_story'
type PrdEpic = PrdDocument['epics'][number]
type PrdUserStory = PrdEpic['user_stories'][number]

interface NormalizedPrdRefinementItem extends RefinementChangeItem {
  itemType: PrdRefinementItemType
  contentFingerprint: string
}

interface PreparedPrdRefinementChange {
  sourceIndex: number
  type: RefinementChange['type']
  itemType: PrdRefinementItemType
  before: RefinementChangeItem | null
  after: RefinementChangeItem | null
  canonicalBefore: NormalizedPrdRefinementItem | null
  canonicalAfter: NormalizedPrdRefinementItem | null
  inspiration: RefinementChange['inspiration'] | null
  attributionStatus: RefinementChangeAttributionStatus
}

export interface ValidatedPrdRefinement {
  document: PrdDocument
  metrics: PrdDraftMetrics
  refinedContent: string
  winnerDraftContent: string
  changes: RefinementChange[]
  repairApplied: boolean
  repairWarnings: string[]
}

export interface PrdRefinedArtifact {
  winnerId: string
  refinedContent: string
  winnerDraftContent: string
  changes?: RefinementChange[]
  structuredOutput?: StructuredOutputMetadata
  draftMetrics: PrdDraftMetrics
}

function buildItemLookupKey(item: Pick<NormalizedPrdRefinementItem, 'itemType' | 'id' | 'label'>): string {
  return `${item.itemType}\u241f${item.id}\u241f${item.label}`
}

function buildItemIdentityKey(item: Pick<NormalizedPrdRefinementItem, 'itemType' | 'id'>): string {
  return `${item.itemType}\u241f${item.id}`
}

function buildItemContentKey(item: Pick<NormalizedPrdRefinementItem, 'itemType' | 'id' | 'contentFingerprint'>): string {
  return `${item.itemType}\u241f${item.id}\u241f${item.contentFingerprint}`
}

function normalizeFingerprintList(values: string[] | undefined): string[] {
  return Array.isArray(values)
    ? values
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
    : []
}

function buildEpicContentFingerprint(epic: PrdEpic): string {
  return JSON.stringify({
    title: epic.title.trim(),
    objective: epic.objective?.trim() ?? '',
    implementationSteps: normalizeFingerprintList(epic.implementation_steps),
  })
}

function buildUserStoryContentFingerprint(story: PrdUserStory): string {
  return JSON.stringify({
    title: story.title.trim(),
    acceptanceCriteria: normalizeFingerprintList(story.acceptance_criteria),
    implementationSteps: normalizeFingerprintList(story.implementation_steps),
    verificationCommands: normalizeFingerprintList(
      story.verification?.required_commands.map((command) => renderCommandSpec(command)),
    ),
  })
}

function normalizePrdItemType(value: unknown): PrdRefinementItemType | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeKey(value)
  if (normalized === 'epic') return 'epic'
  if (normalized === 'userstory' || normalized === 'userstories' || normalized === 'user_story') return 'user_story'
  return null
}

function buildDocumentItems(document: PrdDocument): NormalizedPrdRefinementItem[] {
  const items: NormalizedPrdRefinementItem[] = []

  for (const epic of document.epics) {
    items.push({
      itemType: 'epic',
      id: epic.id,
      label: epic.title,
      ...(epic.objective ? { detail: epic.objective } : {}),
      contentFingerprint: buildEpicContentFingerprint(epic),
    })

    for (const story of epic.user_stories) {
      const detail = story.acceptance_criteria[0] || story.implementation_steps[0] || ''
      items.push({
        itemType: 'user_story',
        id: story.id,
        label: story.title,
        ...(detail ? { detail } : {}),
        contentFingerprint: buildUserStoryContentFingerprint(story),
      })
    }
  }

  return items
}

function buildItemLookup(items: NormalizedPrdRefinementItem[]) {
  const byLookupKey = new Map<string, NormalizedPrdRefinementItem>()
  const byIdentityKey = new Map<string, NormalizedPrdRefinementItem[]>()
  const byId = new Map<string, NormalizedPrdRefinementItem[]>()

  for (const item of items) {
    byLookupKey.set(buildItemLookupKey(item), item)

    const identityKey = buildItemIdentityKey(item)
    const identityMatches = byIdentityKey.get(identityKey) ?? []
    identityMatches.push(item)
    byIdentityKey.set(identityKey, identityMatches)

    const idMatches = byId.get(item.id) ?? []
    idMatches.push(item)
    byId.set(item.id, idMatches)
  }

  return { byLookupKey, byIdentityKey, byId }
}

function cloneCanonicalItem(item: NormalizedPrdRefinementItem): RefinementChangeItem {
  return item.detail
    ? { id: item.id, label: item.label, detail: item.detail }
    : { id: item.id, label: item.label }
}

function normalizeDraftMetrics(value: unknown): PrdDraftMetrics | null {
  if (!isRecord(value)) return null

  const epicCount = typeof value.epicCount === 'number' && Number.isInteger(value.epicCount)
    ? value.epicCount
    : null
  const userStoryCount = typeof value.userStoryCount === 'number' && Number.isInteger(value.userStoryCount)
    ? value.userStoryCount
    : null

  if (epicCount == null || userStoryCount == null) {
    return null
  }

  return { epicCount, userStoryCount }
}

function deriveDraftMetricsFromRefinedContent(content: string): PrdDraftMetrics | null {
  try {
    const parsed = jsYaml.load(content)
    if (!isRecord(parsed) || !Array.isArray(parsed.epics)) {
      return null
    }

    const epicCount = parsed.epics.length
    const userStoryCount = parsed.epics.reduce((sum, epic) => {
      if (!isRecord(epic) || !Array.isArray(epic.user_stories)) {
        return sum
      }
      return sum + epic.user_stories.length
    }, 0)

    return { epicCount, userStoryCount }
  } catch {
    return null
  }
}

function inferPrdItemType(
  change: RefinementChange,
  winnerLookup: ReturnType<typeof buildItemLookup>,
  finalLookup: ReturnType<typeof buildItemLookup>,
): PrdRefinementItemType | null {
  const candidates: PrdRefinementItemType[] = [change.before, change.after]
    .filter((item): item is RefinementChangeItem => Boolean(item))
    .flatMap((item) => {
      const matches: PrdRefinementItemType[] = []
      if (item.label) {
        for (const lookup of [winnerLookup, finalLookup]) {
          for (const itemType of ['epic', 'user_story'] as const) {
            const candidate = lookup.byLookupKey.get(buildItemLookupKey({ itemType, id: item.id, label: item.label }))
            if (candidate) matches.push(candidate.itemType)
          }
        }
      }

      if (matches.length > 0) return matches

      const idMatches = [
        ...(winnerLookup.byId.get(item.id) ?? []),
        ...(finalLookup.byId.get(item.id) ?? []),
      ]
      if (idMatches.length === 1) {
        return [idMatches[0]!.itemType]
      }

      if (/^epic-/i.test(item.id)) return ['epic']
      if (/^us-/i.test(item.id)) return ['user_story']
      return []
    })

  const unique = [...new Set<PrdRefinementItemType>(candidates)]
  return unique.length === 1 ? unique[0]! : null
}

function normalizePrdChangeItem(
  item: RefinementChangeItem | null | undefined,
  itemType: PrdRefinementItemType,
  lookup: ReturnType<typeof buildItemLookup>,
): RefinementChangeItem | null {
  if (!item) return null

  const canonical = lookup.byLookupKey.get(buildItemLookupKey({ itemType, id: item.id, label: item.label }))
  return canonical ? cloneCanonicalItem(canonical) : item
}

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

function buildDuplicateModifiedChangeKey(change: PreparedPrdRefinementChange): string | null {
  if (change.type !== 'modified' || !change.canonicalBefore || !change.canonicalAfter) {
    return null
  }

  return `${buildItemContentKey(change.canonicalBefore)}\u241f${buildItemContentKey(change.canonicalAfter)}`
}

function collapseDuplicateModifiedPrdChanges(
  changes: PreparedPrdRefinementChange[],
): {
  changes: PreparedPrdRefinementChange[]
  repairApplied: boolean
  repairWarnings: string[]
} {
  const collapsedChanges: PreparedPrdRefinementChange[] = []
  const seenModifiedChanges = new Map<string, PreparedPrdRefinementChange>()
  const repairWarnings: string[] = []
  let repairApplied = false

  for (const change of changes) {
    const duplicateKey = buildDuplicateModifiedChangeKey(change)
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
      `Collapsed duplicate PRD refinement modified change at index ${change.sourceIndex} because ${change.after?.id ?? change.before?.id ?? 'the item'} was already covered by an identical modified change.`,
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

function synthesizeOmittedSameIdentityPrdChanges(params: {
  winnerItems: NormalizedPrdRefinementItem[]
  winnerLookup: ReturnType<typeof buildItemLookup>
  finalLookup: ReturnType<typeof buildItemLookup>
  usedBeforeIdentityKeys: Set<string>
  usedAfterIdentityKeys: Set<string>
  usedBeforeContentKeys: Set<string>
  usedAfterContentKeys: Set<string>
}): {
  changes: RefinementChange[]
  repairApplied: boolean
  repairWarnings: string[]
} {
  const synthesizedChanges: RefinementChange[] = []
  const repairWarnings: string[] = []

  for (const winnerItem of params.winnerItems) {
    const identityKey = buildItemIdentityKey(winnerItem)
    const winnerMatches = params.winnerLookup.byIdentityKey.get(identityKey)
    const finalMatches = params.finalLookup.byIdentityKey.get(identityKey)

    if (winnerMatches?.length !== 1 || finalMatches?.length !== 1) continue

    const finalItem = finalMatches[0]!
    const winnerContentKey = buildItemContentKey(winnerItem)
    const finalContentKey = buildItemContentKey(finalItem)
    if (winnerContentKey === finalContentKey) continue

    if (
      params.usedBeforeIdentityKeys.has(identityKey)
      || params.usedAfterIdentityKeys.has(identityKey)
    ) {
      continue
    }

    params.usedBeforeIdentityKeys.add(identityKey)
    params.usedAfterIdentityKeys.add(identityKey)
    params.usedBeforeContentKeys.add(winnerContentKey)
    params.usedAfterContentKeys.add(finalContentKey)
    synthesizedChanges.push({
      type: 'modified',
      itemType: winnerItem.itemType,
      before: cloneCanonicalItem(winnerItem),
      after: cloneCanonicalItem(finalItem),
      inspiration: null,
      attributionStatus: 'synthesized_unattributed',
    })
    repairWarnings.push(
      `Synthesized omitted PRD refinement modified change for ${winnerItem.itemType} ${winnerItem.id} by matching item_type + id across the winning and final drafts.`,
    )
  }

  return {
    changes: synthesizedChanges,
    repairApplied: synthesizedChanges.length > 0,
    repairWarnings,
  }
}

function validateChangeCoverage(
  winnerItems: NormalizedPrdRefinementItem[],
  finalItems: NormalizedPrdRefinementItem[],
  usedBeforeContentKeys: Set<string>,
  usedAfterContentKeys: Set<string>,
) {
  const winnerContentKeySet = new Set(winnerItems.map(buildItemContentKey))
  const finalContentKeySet = new Set(finalItems.map(buildItemContentKey))
  const expectedBeforeKeys = [...winnerContentKeySet].filter((key) => !finalContentKeySet.has(key))
  const expectedAfterKeys = [...finalContentKeySet].filter((key) => !winnerContentKeySet.has(key))

  const missingBefore = expectedBeforeKeys.filter((key) => !usedBeforeContentKeys.has(key))
  const missingAfter = expectedAfterKeys.filter((key) => !usedAfterContentKeys.has(key))
  const extraBefore = [...usedBeforeContentKeys].filter((key) => !winnerContentKeySet.has(key) || finalContentKeySet.has(key))
  const extraAfter = [...usedAfterContentKeys].filter((key) => !finalContentKeySet.has(key) || winnerContentKeySet.has(key))

  if (missingBefore.length > 0 || missingAfter.length > 0 || extraBefore.length > 0 || extraAfter.length > 0) {
    throw new Error('PRD refinement changes do not fully and exactly account for the diff between the winning draft and the final output.')
  }
}

export function validatePrdRefinementOutput(
  rawContent: string,
  options: {
    ticketId: string
    interviewContent: string
    winnerDraftContent: string
    losingDraftMeta?: Array<{ memberId: string }>
  },
): ValidatedPrdRefinement {
  const winnerResult = normalizePrdYamlOutput(options.winnerDraftContent, {
    ticketId: options.ticketId,
    interviewContent: options.interviewContent,
  })
  if (!winnerResult.ok) {
    throw new Error(`Winning PRD draft is invalid: ${winnerResult.error}`)
  }

  const refinementResult = normalizePrdYamlOutput(rawContent, {
    ticketId: options.ticketId,
    interviewContent: options.interviewContent,
    losingDraftMeta: options.losingDraftMeta,
  })
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

  const { changes = [], ...refinedDocument } = refinementResult.value
  if (changes.length === 0) {
    return {
      document: refinedDocument,
      metrics: getPrdDraftMetrics(refinedDocument),
      refinedContent: refinementResult.normalizedContent,
      winnerDraftContent: winnerResult.normalizedContent,
      changes: [],
      repairApplied: refinementResult.repairApplied,
      repairWarnings: [...refinementResult.repairWarnings],
    }
  }

  const winnerDocument = winnerResult.value
  const winnerItems = buildDocumentItems(winnerDocument)
  const finalItems = buildDocumentItems(refinedDocument)
  const winnerLookup = buildItemLookup(winnerItems)
  const finalLookup = buildItemLookup(finalItems)
  const winnerLookupKeySet = new Set(winnerItems.map(buildItemLookupKey))
  const finalLookupKeySet = new Set(finalItems.map(buildItemLookupKey))
  const winnerContentKeySet = new Set(winnerItems.map(buildItemContentKey))
  const finalContentKeySet = new Set(finalItems.map(buildItemContentKey))
  const usedBeforeIdentityKeys = new Set<string>()
  const usedAfterIdentityKeys = new Set<string>()
  const usedBeforeContentKeys = new Set<string>()
  const usedAfterContentKeys = new Set<string>()
  const repairWarnings = [...refinementResult.repairWarnings]
  const preparedChanges: PreparedPrdRefinementChange[] = []
  const validatedChanges: RefinementChange[] = []
  let repairApplied = refinementResult.repairApplied

  for (const [index, change] of changes.entries()) {
    let itemType = normalizePrdItemType(change.itemType)
    if (!itemType) {
      const inferredItemType = inferPrdItemType(change, winnerLookup, finalLookup)
      if (!inferredItemType) {
        throw new Error(`PRD refinement change at index ${index} is missing item_type and no unique repair candidate was found`)
      }
      itemType = inferredItemType
      repairApplied = true
      repairWarnings.push(`Inferred missing PRD refinement item_type at index ${index} as ${itemType}.`)
    }

    const before = normalizePrdChangeItem(change.before, itemType, winnerLookup)
    const after = normalizePrdChangeItem(change.after, itemType, finalLookup)
    const beforeLookupKey = before ? buildItemLookupKey({ itemType, ...before }) : null
    const afterLookupKey = after ? buildItemLookupKey({ itemType, ...after }) : null
    const canonicalBefore = beforeLookupKey ? winnerLookup.byLookupKey.get(beforeLookupKey) ?? null : null
    const canonicalAfter = afterLookupKey ? finalLookup.byLookupKey.get(afterLookupKey) ?? null : null

    if (change.type === 'modified') {
      if (!before || !after) {
        throw new Error(`PRD refinement change at index ${index} with type modified must include populated before and after items`)
      }
      if (before.id !== after.id) {
        throw new Error(`PRD refinement change at index ${index} with type modified must preserve the same id`)
      }
    } else if (change.type === 'added') {
      if (before !== null || !after) {
        throw new Error(`PRD refinement change at index ${index} with type added must use before: null and a populated after`)
      }
    } else if (change.type === 'removed') {
      if (!before || after !== null) {
        throw new Error(`PRD refinement change at index ${index} with type removed must use after: null and a populated before`)
      }
    }

    if (before && (!beforeLookupKey || !winnerLookupKeySet.has(beforeLookupKey) || !canonicalBefore)) {
      throw new Error(`PRD refinement change.before at index ${index} does not match any item from the winning draft`)
    }

    if (after && (!afterLookupKey || !finalLookupKeySet.has(afterLookupKey) || !canonicalAfter)) {
      throw new Error(`PRD refinement change.after at index ${index} does not match any item from the refined final draft`)
    }

    if (
      canonicalBefore
      && canonicalAfter
      && buildItemContentKey(canonicalBefore) === buildItemContentKey(canonicalAfter)
    ) {
      const changeKey = buildItemContentKey(canonicalBefore)
      if (winnerContentKeySet.has(changeKey) && finalContentKeySet.has(changeKey)) {
        repairApplied = true
        repairWarnings.push(`Dropped no-op PRD refinement modified change at index ${index} because the winning and final records are identical.`)
        continue
      }
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
        repairWarnings.push(`Cleared out-of-range PRD refinement inspiration at index ${index} because alternative draft ${draftNumber} does not exist.`)
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
      itemType,
      before,
      after,
      canonicalBefore,
      canonicalAfter,
      inspiration,
      attributionStatus,
    })
  }

  const collapsedChanges = collapseDuplicateModifiedPrdChanges(preparedChanges)
  if (collapsedChanges.repairApplied) {
    repairApplied = true
    repairWarnings.push(...collapsedChanges.repairWarnings)
  }

  for (const change of collapsedChanges.changes) {
    const { sourceIndex, itemType, before, after, canonicalBefore, canonicalAfter } = change

    if (before) {
      const beforeIdentityKey = buildItemIdentityKey({ itemType, id: before.id })
      if (usedBeforeIdentityKeys.has(beforeIdentityKey)) {
        throw new Error(`PRD refinement change.before at index ${sourceIndex} reuses a winning-draft item already referenced by another change`)
      }
      usedBeforeIdentityKeys.add(beforeIdentityKey)
      usedBeforeContentKeys.add(buildItemContentKey(canonicalBefore!))
    }

    if (after) {
      const afterIdentityKey = buildItemIdentityKey({ itemType, id: after.id })
      if (usedAfterIdentityKeys.has(afterIdentityKey)) {
        throw new Error(`PRD refinement change.after at index ${sourceIndex} reuses a refined final item already referenced by another change`)
      }
      usedAfterIdentityKeys.add(afterIdentityKey)
      usedAfterContentKeys.add(buildItemContentKey(canonicalAfter!))
    }

    validatedChanges.push({
      type: change.type,
      itemType,
      before,
      after,
      inspiration: change.inspiration,
      attributionStatus: change.attributionStatus,
    })
  }

  const synthesizedChanges = synthesizeOmittedSameIdentityPrdChanges({
    winnerItems,
    winnerLookup,
    finalLookup,
    usedBeforeIdentityKeys,
    usedAfterIdentityKeys,
    usedBeforeContentKeys,
    usedAfterContentKeys,
  })
  if (synthesizedChanges.repairApplied) {
    repairApplied = true
    repairWarnings.push(...synthesizedChanges.repairWarnings)
    validatedChanges.push(...synthesizedChanges.changes)
  }

  validateChangeCoverage(winnerItems, finalItems, usedBeforeContentKeys, usedAfterContentKeys)

  return {
    document: refinedDocument,
    metrics: getPrdDraftMetrics(refinedDocument),
    refinedContent: refinementResult.normalizedContent,
    winnerDraftContent: winnerResult.normalizedContent,
    changes: validatedChanges,
    repairApplied,
    repairWarnings,
  }
}

export function buildPrdRefinedArtifact(
  winnerId: string,
  winnerDraftContent: string,
  refinement: ValidatedPrdRefinement,
  structuredOutput?: StructuredOutputMetadata,
): PrdRefinedArtifact {
  const normalizedWinnerId = winnerId.trim()
  if (!normalizedWinnerId) {
    throw new Error('PRD refined artifact is missing winnerId')
  }

  return {
    winnerId: normalizedWinnerId,
    refinedContent: refinement.refinedContent,
    winnerDraftContent,
    ...(structuredOutput ? { structuredOutput } : {}),
    draftMetrics: refinement.metrics,
  }
}

export function parsePrdRefinedArtifact(content: string): PrdRefinedArtifact {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('PRD refined artifact is not valid JSON')
  }

  if (!isRecord(parsed)) {
    throw new Error('PRD refined artifact payload is invalid')
  }

  const winnerId = typeof parsed.winnerId === 'string' ? parsed.winnerId.trim() : ''
  const refinedContent = typeof parsed.refinedContent === 'string' ? parsed.refinedContent : ''
  const winnerDraftContent = typeof parsed.winnerDraftContent === 'string' ? parsed.winnerDraftContent : ''
  const changes = Array.isArray(parsed.changes) ? parsed.changes as RefinementChange[] : []
  const structuredOutput = normalizeStructuredOutputMetadata(parsed.structuredOutput)
  const draftMetrics = normalizeDraftMetrics(parsed.draftMetrics) ?? deriveDraftMetricsFromRefinedContent(refinedContent)

  if (!refinedContent.trim()) {
    throw new Error('PRD refined artifact is missing refinedContent')
  }
  if (!draftMetrics) {
    throw new Error('PRD refined artifact is missing draftMetrics')
  }

  return {
    winnerId,
    refinedContent,
    winnerDraftContent,
    changes,
    structuredOutput,
    draftMetrics,
  }
}

export function requirePrdRefinedArtifact(content: string | null | undefined): PrdRefinedArtifact {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('No validated refined PRD found')
  }

  return parsePrdRefinedArtifact(content)
}

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

export function buildPrdRefinementRetryPrompt(
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
        '## PRD Refinement Structured Output Retry',
        `Your previous response failed validation: ${params.validationError}`,
        '',
        'Return only one corrected YAML artifact.',
        'Requirements:',
        '- Use the normal PRD schema plus a top-level `changes` list.',
        '- The `changes` list must fully and exactly account for the diff between the winning PRD and the final refined PRD.',
        '- Every changed epic or user story must appear exactly once in `changes`.',
        '- Epic changes do not subsume changed user stories.',
        '- Every epic must include at least one fully populated `user_stories` entry. Do not leave any epic with `user_stories: []`, omit `user_stories`, or move story-level requirements only into epic-level fields.',
        '- If an existing epic or user story keeps the same ID but its content changes, emit exactly one `modified` entry for that item.',
        '- Do not split one changed item across multiple change entries.',
        '- Preserve epic IDs and user story IDs unless the final draft contains a genuinely new item.',
        '- Do not wrap the PRD in another object.',
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
