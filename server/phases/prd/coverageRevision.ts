import type { RefinementChange, RefinementChangeItem } from '@shared/refinementChanges'
import {
  buildPrdUiRefinementDiffArtifact,
  buildPrdUiRefinementDiffArtifactFromChanges,
} from '@shared/refinementDiffArtifacts'
import type { PromptPart } from '../../opencode/types'
import type { PrdDraftMetrics, StructuredOutputMetadata } from '../../structuredOutput'
import { normalizePrdYamlOutput } from '../../structuredOutput'
import {
  collectStructuredCandidates,
  getValueByAliases,
  isRecord,
  normalizeKey,
  parseYamlOrJsonCandidate,
  unwrapExplicitWrapperRecord,
} from '../../structuredOutput/yamlUtils'
import { matchCoverageGapReference } from '../coverageGapMatching'
import { validatePrdRefinementOutput } from './refined'

export type PrdCoverageGapResolutionAction = 'updated_prd' | 'already_covered' | 'left_unresolved'

export interface PrdCoverageAffectedItem {
  itemType: 'epic' | 'user_story'
  id: string
  label: string
}

export interface PrdCoverageGapResolution {
  gap: string
  action: PrdCoverageGapResolutionAction
  rationale: string
  affectedItems: PrdCoverageAffectedItem[]
}

export interface ValidatedPrdCoverageRevision {
  refinedContent: string
  priorCandidateContent: string
  changes: RefinementChange[]
  gapResolutions: PrdCoverageGapResolution[]
  metrics: PrdDraftMetrics
  repairApplied: boolean
  repairWarnings: string[]
}

export interface PrdCoverageRevisionArtifact {
  winnerId: string
  refinedContent: string
  winnerDraftContent: string
  changes: RefinementChange[]
  gapResolutions: PrdCoverageGapResolution[]
  draftMetrics: PrdDraftMetrics
  candidateVersion: number
  structuredOutput?: StructuredOutputMetadata
}

interface PrdCoverageLookupItem extends RefinementChangeItem {
  itemType: 'epic' | 'user_story'
}

interface PrdCoverageItemLookup {
  byTypedId: Map<string, PrdCoverageLookupItem>
  byId: Map<string, PrdCoverageLookupItem[]>
}

const PRD_SECTION_REFERENCE_KEYS = new Set([
  'prd',
  'section',
  'sections',
  'product',
  'scope',
  'technicalrequirements',
  'architectureconstraints',
  'datamodel',
  'apicontracts',
  'securityconstraints',
  'performanceconstraints',
  'reliabilityconstraints',
  'errorhandlingrules',
  'toolingassumptions',
  'risks',
  'approval',
])

function buildItemLookupFromContent(content: string) {
  const normalized = normalizePrdYamlOutput(content, { ticketId: 'lookup', interviewContent: minimalInterviewContent })
  if (!normalized.ok) {
    return {
      byTypedId: new Map<string, PrdCoverageLookupItem>(),
      byId: new Map<string, PrdCoverageLookupItem[]>(),
    } satisfies PrdCoverageItemLookup
  }

  const byTypedId = new Map<string, PrdCoverageLookupItem>()
  const byId = new Map<string, PrdCoverageLookupItem[]>()

  const addItem = (item: PrdCoverageLookupItem) => {
    byTypedId.set(`${item.itemType}\u241f${item.id}`, item)
    const idMatches = byId.get(item.id) ?? []
    idMatches.push(item)
    byId.set(item.id, idMatches)
  }

  for (const epic of normalized.value.epics) {
    addItem({
      itemType: 'epic',
      id: epic.id,
      label: epic.title,
      detail: epic.objective,
    })
    for (const story of epic.user_stories) {
      addItem({
        itemType: 'user_story',
        id: story.id,
        label: story.title,
        detail: story.acceptance_criteria[0] || story.implementation_steps[0] || '',
      })
    }
  }

  return { byTypedId, byId }
}

function normalizeAffectedItemType(value: unknown): 'epic' | 'user_story' | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeKey(value)
  if (normalized === 'epic' || normalized === 'epics') return 'epic'
  if (normalized === 'story' || normalized === 'stories' || normalized === 'userstory' || normalized === 'userstories' || normalized === 'user_story') return 'user_story'
  return null
}

function inferAffectedItemType(
  id: string,
  priorItems: PrdCoverageItemLookup,
  revisedItems: PrdCoverageItemLookup,
): 'epic' | 'user_story' | null {
  if (!id) return null

  const matches = [
    ...(revisedItems.byId.get(id) ?? []),
    ...(priorItems.byId.get(id) ?? []),
  ]
  const uniqueTypes = [...new Set(matches.map((item) => item.itemType))]
  if (uniqueTypes.length === 1) {
    return uniqueTypes[0]!
  }

  if (/^epic-/i.test(id)) return 'epic'
  if (/^us-/i.test(id)) return 'user_story'
  return null
}

function isPrdSectionReference(rawItemType: unknown, id: string, label: string): boolean {
  const candidates = [
    typeof rawItemType === 'string' ? rawItemType : '',
    id,
    label,
  ]

  return candidates.some((candidate) => {
    const normalized = normalizeKey(candidate)
    return normalized.length > 0 && PRD_SECTION_REFERENCE_KEYS.has(normalized)
  })
}

function parseCoverageRevisionRecord(rawContent: string): Record<string, unknown> {
  const candidates = collectStructuredCandidates(rawContent, {
    topLevelHints: ['schema_version', 'artifact', 'gap_resolutions', 'epics'],
  })

  for (const candidate of candidates) {
    try {
      const parsed = unwrapExplicitWrapperRecord(parseYamlOrJsonCandidate(candidate, {
        allowTrailingTerminalNoise: true,
      }), ['prd', 'document', 'output', 'result', 'data'])
      if (isRecord(parsed)) return parsed
    } catch {
      // Keep trying candidates.
    }
  }

  throw new Error('PRD coverage revision output is not a valid YAML/JSON object')
}

function parseGapResolutions(
  rawContent: string,
  coverageGaps: string[],
  currentCandidateContent: string,
  revisedContent: string,
): {
  gapResolutions: PrdCoverageGapResolution[]
  repairWarnings: string[]
} {
  const parsed = parseCoverageRevisionRecord(rawContent)
  const rawGapResolutions = getValueByAliases(parsed, ['gap_resolutions', 'gapresolutions'])
  if (!Array.isArray(rawGapResolutions)) {
    throw new Error('PRD coverage revision output must include a top-level gap_resolutions list')
  }

  const repairWarnings: string[] = []
  const priorItems = buildItemLookupFromContent(currentCandidateContent)
  const revisedItems = buildItemLookupFromContent(revisedContent)
  const resolutions: PrdCoverageGapResolution[] = []

  for (const [index, value] of rawGapResolutions.entries()) {
    if (!isRecord(value)) {
      throw new Error(`PRD coverage gap_resolutions entry at index ${index} is not an object`)
    }

    const gap = typeof getValueByAliases(value, ['gap']) === 'string'
      ? String(getValueByAliases(value, ['gap'])).trim()
      : ''
    if (!gap) {
      throw new Error(`PRD coverage gap_resolutions entry at index ${index} is missing gap`)
    }

    const rawAction = typeof getValueByAliases(value, ['action']) === 'string'
      ? String(getValueByAliases(value, ['action'])).trim()
      : ''
    const normalizedAction = normalizeKey(rawAction)
    let action: PrdCoverageGapResolutionAction | null = null
    if (normalizedAction === 'updatedprd') action = 'updated_prd'
    if (normalizedAction === 'alreadycovered') action = 'already_covered'
    if (normalizedAction === 'leftunresolved') action = 'left_unresolved'
    if (!action) {
      throw new Error(`PRD coverage gap_resolutions entry for "${gap}" has unsupported action "${rawAction}"`)
    }

    const rationale = typeof getValueByAliases(value, ['rationale']) === 'string'
      ? String(getValueByAliases(value, ['rationale'])).trim()
      : ''
    if (!rationale) {
      throw new Error(`PRD coverage gap_resolutions entry for "${gap}" is missing rationale`)
    }

    const rawAffectedItems = getValueByAliases(value, ['affected_items', 'affecteditems'])
    const affectedItems = Array.isArray(rawAffectedItems)
      ? rawAffectedItems.flatMap((item, itemIndex) => {
          if (!isRecord(item)) {
            throw new Error(`PRD coverage affected_items entry at gap "${gap}" index ${itemIndex} is not an object`)
          }
          const id = typeof getValueByAliases(item, ['id']) === 'string'
            ? String(getValueByAliases(item, ['id'])).trim()
            : ''
          const label = typeof getValueByAliases(item, ['label', 'title']) === 'string'
            ? String(getValueByAliases(item, ['label', 'title'])).trim()
            : ''
          const rawItemType = getValueByAliases(item, ['item_type', 'itemtype'])
          let itemType = normalizeAffectedItemType(rawItemType)
          if (!itemType) {
            const inferredItemType = inferAffectedItemType(id, priorItems, revisedItems)
            if (inferredItemType) {
              itemType = inferredItemType
              repairWarnings.push(`Inferred missing PRD coverage affected_items item_type at gap "${gap}" index ${itemIndex} as ${itemType}.`)
            }
          }
          if (!itemType) {
            if (isPrdSectionReference(rawItemType, id, label)) {
              const reference = id || label || String(rawItemType ?? '[missing]')
              repairWarnings.push(`Ignored PRD coverage affected_items entry at gap "${gap}" index ${itemIndex} because "${reference}" refers to a PRD section and affected_items only supports epic or user_story references.`)
              return []
            }
            throw new Error(`PRD coverage affected_items entry at gap "${gap}" index ${itemIndex} is missing item_type`)
          }
          if (!id || !label) {
            throw new Error(`PRD coverage affected_items entry at gap "${gap}" index ${itemIndex} requires id and label`)
          }

          const lookupKey = `${itemType}\u241f${id}`
          const canonical = revisedItems.byTypedId.get(lookupKey) ?? priorItems.byTypedId.get(lookupKey)
          if (!canonical) {
            throw new Error(`PRD coverage affected_items entry at gap "${gap}" references unknown ${itemType} ${id}`)
          }
          if (canonical.label !== label) {
            repairWarnings.push(`Canonicalized affected_items label for ${itemType} ${id} from "${label}" to "${canonical.label}".`)
          }

          return [{
            itemType,
            id,
            label: canonical.label,
          } satisfies PrdCoverageAffectedItem]
        })
      : []

    resolutions.push({
      gap,
      action,
      rationale,
      affectedItems,
    })
  }

  const normalizedCoverageGaps = coverageGaps.map((gap) => gap.trim()).filter(Boolean)
  const seen = new Set<string>()
  for (const resolution of resolutions) {
    const matchedGap = matchCoverageGapReference(resolution.gap, normalizedCoverageGaps, 'Canonicalized PRD')
    if (!matchedGap) {
      throw new Error(`PRD coverage gap_resolutions entry references unknown gap "${resolution.gap}"`)
    }
    if (seen.has(matchedGap.gap)) {
      throw new Error(`PRD coverage gap_resolutions contains duplicate entry for "${matchedGap.gap}"`)
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
    throw new Error(`PRD coverage gap_resolutions must include exactly one entry per gap. Missing: ${missingGaps.join(' | ')}`)
  }

  return { gapResolutions: resolutions, repairWarnings }
}

export function validatePrdCoverageRevisionOutput(
  rawContent: string,
  options: {
    ticketId: string
    interviewContent: string
    currentCandidateContent: string
    coverageGaps: string[]
  },
): ValidatedPrdCoverageRevision {
  const validatedRefinement = validatePrdRefinementOutput(rawContent, {
    ticketId: options.ticketId,
    interviewContent: options.interviewContent,
    winnerDraftContent: options.currentCandidateContent,
    // A coverage revision accounts for its edits in gap_resolutions.
    missingChangesPolicy: 'accounted_elsewhere',
  })
  const parsedGapResolutions = parseGapResolutions(
    rawContent,
    options.coverageGaps,
    validatedRefinement.winnerDraftContent,
    validatedRefinement.refinedContent,
  )

  return {
    refinedContent: validatedRefinement.refinedContent,
    priorCandidateContent: validatedRefinement.winnerDraftContent,
    changes: validatedRefinement.changes,
    gapResolutions: parsedGapResolutions.gapResolutions,
    metrics: validatedRefinement.metrics,
    repairApplied: validatedRefinement.repairApplied || parsedGapResolutions.repairWarnings.length > 0,
    repairWarnings: [...validatedRefinement.repairWarnings, ...parsedGapResolutions.repairWarnings],
  }
}

export function buildPrdCoverageRevisionArtifact(
  winnerId: string,
  candidateVersion: number,
  revision: ValidatedPrdCoverageRevision,
  structuredOutput?: StructuredOutputMetadata,
): PrdCoverageRevisionArtifact {
  const normalizedWinnerId = winnerId.trim()
  if (!normalizedWinnerId) {
    throw new Error('PRD coverage revision artifact is missing winnerId')
  }

  return {
    winnerId: normalizedWinnerId,
    refinedContent: revision.refinedContent,
    winnerDraftContent: revision.priorCandidateContent,
    changes: revision.changes,
    gapResolutions: revision.gapResolutions,
    draftMetrics: revision.metrics,
    candidateVersion,
    ...(structuredOutput ? { structuredOutput } : {}),
  }
}

export function buildPrdCoverageRevisionUiDiff(revisionArtifact: PrdCoverageRevisionArtifact) {
  const changesBasedDiff = buildPrdUiRefinementDiffArtifactFromChanges({
    winnerId: revisionArtifact.winnerId,
    changes: revisionArtifact.changes,
    winnerDraftContent: revisionArtifact.winnerDraftContent,
    refinedContent: revisionArtifact.refinedContent,
    losingDrafts: [],
  })

  if (changesBasedDiff.entries.length > 0) {
    return changesBasedDiff
  }

  return buildPrdUiRefinementDiffArtifact({
    winnerId: revisionArtifact.winnerId,
    winnerDraftContent: revisionArtifact.winnerDraftContent,
    refinedContent: revisionArtifact.refinedContent,
    losingDrafts: [],
  })
}

function stripLegacyTopLevelKeysFromYaml(rawResponse: string): string {
  const candidates = [rawResponse.trim()]
  for (const candidate of candidates) {
    try {
      const parsed = parseCoverageRevisionRecord(candidate)
      delete parsed.changes
      delete parsed.gap_resolutions
      delete parsed.gapResolutions
      return JSON.stringify(parsed, null, 2)
    } catch {
      // fall through to regex cleanup
    }
  }

  return rawResponse.trim()
    .replace(/\nchanges:\n(?: {2,}.*\n?)*/u, '')
    .replace(/\ngap_resolutions:\n(?: {2,}.*\n?)*/u, '')
    .trim()
}

export function buildPrdCoverageRevisionRetryPrompt(
  baseParts: PromptPart[],
  params: {
    validationError: string
    rawResponse: string
  },
): PromptPart[] {
  const sanitizedRawResponse = stripLegacyTopLevelKeysFromYaml(params.rawResponse)

  return [
    ...baseParts,
    {
      type: 'text',
      content: [
        '## PRD Coverage Resolution Structured Output Retry',
        `Your previous response failed validation: ${params.validationError}`,
        '',
        'Return only one corrected YAML artifact.',
        'Requirements:',
        '- Use the exact PRD schema.',
        '- Include a top-level `changes` list that fully accounts for the diff between the current PRD candidate and the revised PRD candidate.',
        '- Include a top-level `gap_resolutions` list with exactly one entry per provided coverage gap.',
        '- Preserve epic IDs and user story IDs unless the revised candidate contains a genuinely new item.',
        '- If a gap was already covered, keep the PRD unchanged for that gap and record `action: already_covered`.',
        '- If a gap describes internally contradictory source artifacts, do not choose a side or invent a requirement. Record `action: left_unresolved`, explain the contradiction in `rationale`, and use `affected_items: []`.',
        '- Use `affected_items` only for epic or user_story references. Leave it empty when no epic/story mapping applies.',
        '- If a gap updates top-level PRD sections such as `product`, `scope`, `technical_requirements`, or `api_contracts`, use `affected_items: []` instead of section references like `item_type: prd`.',
        '',
        'Previous invalid response:',
        '```',
        sanitizedRawResponse || '[empty response]',
        '```',
      ].join('\n'),
    },
  ]
}

const minimalInterviewContent = [
  'schema_version: 1',
  'ticket_id: LOOKUP',
  'artifact: interview',
  'status: approved',
  'generated_by:',
  '  winner_model: lookup',
  '  generated_at: 2026-01-01T00:00:00.000Z',
  'questions:',
  '  - id: Q01',
  '    phase: Foundation',
  '    prompt: "Lookup placeholder"',
  '    source: compiled',
  '    answer_type: free_text',
  '    options: []',
  '    answer:',
  '      skipped: false',
  '      selected_option_ids: []',
  '      free_text: "Lookup placeholder"',
  '      answered_by: user',
  '      answered_at: 2026-01-01T00:00:00.000Z',
  'follow_up_rounds: []',
  'summary:',
  '  goals: []',
  '  constraints: []',
  '  non_goals: []',
  '  final_free_form_answer: ""',
  'approval:',
  '  approved_by: ""',
  '  approved_at: ""',
].join('\n')
