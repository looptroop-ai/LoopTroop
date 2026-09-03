import { buildBeadsUiRefinementDiffArtifact } from '@shared/refinementDiffArtifacts'
import type { RefinementChange } from '@shared/refinementChanges'
import type { PromptPart } from '../../opencode/types'
import { normalizeBeadSubsetYamlOutput, normalizeBeadRefinementOutput, getCoverageBeadMetrics, type CoverageBeadMetrics, type StructuredOutputMetadata } from '../../structuredOutput'
import {
  buildYamlDocument,
  collectAliasConflictWarnings,
  collectStructuredCandidates,
  getValueByAliases,
  isRecord,
  normalizeKey,
  parseYamlOrJsonCandidate,
  unwrapExplicitWrapperRecord,
} from '../../structuredOutput/yamlUtils'
import { parseCoverageGapResolutions } from '../coverage/gapResolutions'
import type { BeadSubset } from './types'

export type BeadsCoverageGapResolutionAction = 'updated_beads' | 'already_covered' | 'left_unresolved'

export interface BeadsCoverageAffectedItem {
  itemType: 'bead'
  id: string
  label: string
}

export interface BeadsCoverageGapResolution {
  gap: string
  action: BeadsCoverageGapResolutionAction
  rationale: string
  affectedItems: BeadsCoverageAffectedItem[]
}

export interface ValidatedBeadsCoverageRevision {
  refinedContent: string
  priorCandidateContent: string
  changes: RefinementChange[]
  gapResolutions: BeadsCoverageGapResolution[]
  draftMetrics: CoverageBeadMetrics
  repairApplied: boolean
  repairWarnings: string[]
}

export interface BeadsCoverageRevisionArtifact {
  winnerId: string
  refinedContent: string
  winnerDraftContent: string
  changes: RefinementChange[]
  gapResolutions: BeadsCoverageGapResolution[]
  draftMetrics: CoverageBeadMetrics
  candidateVersion: number
  structuredOutput?: StructuredOutputMetadata
  uiRefinementDiff: ReturnType<typeof buildBeadsUiRefinementDiffArtifact>
}

interface BeadLookup {
  byId: Map<string, BeadSubset>
  byTitle: Map<string, BeadSubset[]>
}

function buildBlueprintYaml(beads: BeadSubset[]): string {
  return buildYamlDocument({ beads })
}

function parseBeadSubsetYaml(content: string): BeadSubset[] {
  const normalized = normalizeBeadSubsetYamlOutput(content)
  if (!normalized.ok) {
    throw new Error(normalized.error)
  }
  return normalized.value
}

function parseCoverageRevisionRecord(rawContent: string): Record<string, unknown> {
  const candidates = collectStructuredCandidates(rawContent, {
    topLevelHints: ['beads', 'gap_resolutions'],
  })

  for (const candidate of candidates) {
    try {
      const parsed = unwrapExplicitWrapperRecord(parseYamlOrJsonCandidate(candidate, {
        allowTrailingTerminalNoise: true,
      }), ['document', 'output', 'result', 'data'])

      if (isRecord(parsed) && Array.isArray(getValueByAliases(parsed, ['beads']))) {
        return parsed
      }
    } catch {
      // Keep trying candidates.
    }
  }

  throw new Error('Beads coverage revision output is not a valid YAML/JSON object')
}

function buildBeadLookup(beads: BeadSubset[]) {
  const byId = new Map<string, BeadSubset>()
  const byTitle = new Map<string, BeadSubset[]>()

  for (const bead of beads.filter((entry) => entry.id.trim() && entry.title.trim())) {
    byId.set(bead.id, bead)
    const titleMatches = byTitle.get(bead.title) ?? []
    titleMatches.push(bead)
    byTitle.set(bead.title, titleMatches)
  }

  return { byId, byTitle } satisfies BeadLookup
}

function normalizeBeadsAffectedItemType(value: unknown): 'bead' | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeKey(value)
  return normalized === 'bead' || normalized === 'beads' ? 'bead' : null
}

function inferBeadsAffectedItemType(
  id: string,
  label: string,
  priorLookup: BeadLookup,
  revisedLookup: BeadLookup,
): 'bead' | null {
  if (id && (revisedLookup.byId.has(id) || priorLookup.byId.has(id))) {
    return 'bead'
  }

  if (label) {
    const matches = [
      ...(revisedLookup.byTitle.get(label) ?? []),
      ...(priorLookup.byTitle.get(label) ?? []),
    ]
    const uniqueIds = [...new Set(matches.map((bead) => bead.id))]
    if (uniqueIds.length === 1) {
      return 'bead'
    }
  }

  return null
}

function parseGapResolutions(
  parsed: Record<string, unknown>,
  coverageGaps: string[],
  currentCandidateBeads: BeadSubset[],
  revisedBeads: BeadSubset[],
): {
  gapResolutions: BeadsCoverageGapResolution[]
  repairWarnings: string[]
} {
  const priorLookup = buildBeadLookup(currentCandidateBeads)
  const revisedLookup = buildBeadLookup(revisedBeads)

  return parseCoverageGapResolutions<BeadsCoverageGapResolutionAction, 'bead'>(
    parsed,
    coverageGaps,
    {
      label: 'Beads',
      gapMatchLabel: 'Canonicalized beads',
      resolveAction: (normalizedAction) => {
        if (normalizedAction === 'updatedbeads' || normalizedAction === 'updatedplan') return 'updated_beads'
        if (normalizedAction === 'alreadycovered') return 'already_covered'
        if (normalizedAction === 'leftunresolved') return 'left_unresolved'
        return null
      },
      resolveAffectedItem: ({ id, label, rawItemType, gap, itemIndex, repairWarnings }) => {
        let itemType = normalizeBeadsAffectedItemType(rawItemType)
        if (!itemType) {
          const inferredItemType = inferBeadsAffectedItemType(id, label, priorLookup, revisedLookup)
          if (inferredItemType) {
            itemType = inferredItemType
            repairWarnings.push(`Inferred missing beads coverage affected_items item_type at gap "${gap}" index ${itemIndex} as bead.`)
          }
        }
        if (itemType !== 'bead') {
          throw new Error(`Beads coverage affected_items entry at gap "${gap}" index ${itemIndex} must use item_type bead`)
        }
        if (!id || !label) {
          throw new Error(`Beads coverage affected_items entry at gap "${gap}" index ${itemIndex} requires id and label`)
        }

        const canonical = revisedLookup.byId.get(id) ?? priorLookup.byId.get(id)
        if (!canonical) {
          throw new Error(`Beads coverage affected_items entry at gap "${gap}" references unknown bead ${id}`)
        }
        if (canonical.title !== label) {
          repairWarnings.push(`Canonicalized affected_items label for bead ${id} from "${label}" to "${canonical.title}".`)
        }

        return { itemType: 'bead', id, label: canonical.title } satisfies BeadsCoverageAffectedItem
      },
    },
  )
}

export function validateBeadsCoverageRevisionOutput(
  rawContent: string,
  options: {
    currentCandidateContent: string
    coverageGaps: string[]
  },
): ValidatedBeadsCoverageRevision {
  // Every alias this function and its helpers resolve is model output, so the
  // conflict warnings belong on the revision's own repair record. Without a sink
  // installed they went nowhere.
  const aliasWarnings: string[] = []
  const releaseAliasConflicts = collectAliasConflictWarnings(aliasWarnings)
  try {
    return validateBeadsCoverageRevisionRecord(rawContent, options, aliasWarnings)
  } finally {
    releaseAliasConflicts()
  }
}

function validateBeadsCoverageRevisionRecord(
  rawContent: string,
  options: {
    currentCandidateContent: string
    coverageGaps: string[]
  },
  aliasWarnings: string[],
): ValidatedBeadsCoverageRevision {
  const parsed = parseCoverageRevisionRecord(rawContent)
  const currentCandidateBeads = parseBeadSubsetYaml(options.currentCandidateContent)
  const rawBeads = getValueByAliases(parsed, ['beads'])
  if (!Array.isArray(rawBeads)) {
    throw new Error('Beads coverage revision output must include a top-level beads list')
  }

  // Deliberately `{ beads }` only, without the model's `changes` block.
  //
  // PROM24 asks for `{type, id, title, summary}` change entries — summary-level
  // metadata, no `before`/`after` item records — because a coverage revision
  // accounts for its edits in `gap_resolutions`. `parseRefinementChanges` needs
  // before/after records, so forwarding these would skip every entry with a
  // "summary metadata only" repair warning and then synthesize the same diff
  // anyway: identical result, one spurious warning per declared change. A round
  // of review talked me into forwarding them; the prompt is the reason not to.
  const beadsYaml = buildYamlDocument({ beads: rawBeads })
  const refinementResult = normalizeBeadRefinementOutput(beadsYaml, options.currentCandidateContent)
  if (!refinementResult.ok) {
    throw new Error(refinementResult.error)
  }

  const refinedContent = buildBlueprintYaml(refinementResult.value.beads)
  const parsedGapResolutions = parseGapResolutions(
    parsed,
    options.coverageGaps,
    currentCandidateBeads,
    refinementResult.value.beads,
  )

  return {
    refinedContent,
    priorCandidateContent: options.currentCandidateContent,
    changes: refinementResult.value.changes,
    gapResolutions: parsedGapResolutions.gapResolutions,
    draftMetrics: getCoverageBeadMetrics(refinementResult.value.beads),
    repairApplied: refinementResult.repairApplied
      || parsedGapResolutions.repairWarnings.length > 0
      || aliasWarnings.length > 0,
    repairWarnings: [...refinementResult.repairWarnings, ...parsedGapResolutions.repairWarnings, ...aliasWarnings],
  }
}

/**
 * Reads the candidate blueprint back out of a persisted `beads_coverage_revision`
 * artifact. Callers used to `JSON.parse(...) as { refinedContent?: string }`, which
 * accepted a truncated or foreign artifact as an empty revision.
 */
/**
 * Reads the candidate a coverage revision produced, with the version it revised
 * into. The version matters to the semantic-coverage input, which numbers each
 * candidate it audits; readers that only need the YAML use the wrapper below.
 */
export function parseBeadsCoverageRevisionCandidate(
  content: string,
): { refinedContent: string; candidateVersion: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Beads coverage revision artifact is not valid JSON')
  }
  if (!isRecord(parsed)) {
    throw new Error('Beads coverage revision artifact payload is invalid')
  }
  const refinedContent = typeof parsed.refinedContent === 'string' ? parsed.refinedContent : ''
  if (!refinedContent.trim()) {
    throw new Error('Beads coverage revision artifact is missing refinedContent')
  }
  // Absent means "the first candidate". A present but impossible value — 0, a
  // negative, a fraction — is a corrupt artifact, and silently reading it as
  // version 1 made the semantic coverage loop audit a later revision under the
  // first candidate's identity.
  if (parsed.candidateVersion !== undefined
    && !(typeof parsed.candidateVersion === 'number'
      && Number.isInteger(parsed.candidateVersion)
      && parsed.candidateVersion > 0)) {
    throw new Error('Beads coverage revision artifact has an invalid candidateVersion')
  }
  return { refinedContent, candidateVersion: (parsed.candidateVersion as number | undefined) ?? 1 }
}

export function parseBeadsCoverageRevisionRefinedContent(content: string): string {
  return parseBeadsCoverageRevisionCandidate(content).refinedContent
}

export function buildBeadsCoverageRevisionArtifact(
  winnerId: string,
  candidateVersion: number,
  revision: ValidatedBeadsCoverageRevision,
  structuredOutput?: StructuredOutputMetadata,
  prdContent?: string,
): BeadsCoverageRevisionArtifact {
  const normalizedWinnerId = winnerId.trim()
  if (!normalizedWinnerId) {
    throw new Error('Beads coverage revision artifact is missing winnerId')
  }

  const uiRefinementDiff = buildBeadsUiRefinementDiffArtifact({
    winnerId: normalizedWinnerId,
    winnerDraftContent: revision.priorCandidateContent,
    refinedContent: revision.refinedContent,
    prdContent,
  })

  return {
    winnerId: normalizedWinnerId,
    refinedContent: revision.refinedContent,
    winnerDraftContent: revision.priorCandidateContent,
    changes: revision.changes,
    gapResolutions: revision.gapResolutions,
    draftMetrics: revision.draftMetrics,
    candidateVersion,
    ...(structuredOutput ? { structuredOutput } : {}),
    uiRefinementDiff,
  }
}

function stripLegacyTopLevelKeysFromYaml(rawResponse: string): string {
  const candidates = [rawResponse.trim()]
  for (const candidate of candidates) {
    try {
      const parsed = parseCoverageRevisionRecord(candidate)
      delete parsed.gap_resolutions
      delete parsed.gapResolutions
      delete parsed.changes
      return JSON.stringify(parsed, null, 2)
    } catch {
      // fall through to regex cleanup
    }
  }

  return rawResponse.trim()
    .replace(/\ngap_resolutions:\n(?: {2,}.*\n?)*/u, '')
    .replace(/\nchanges:\n(?: {2,}.*\n?)*/u, '')
    .trim()
}

export function buildBeadsCoverageRevisionRetryPrompt(
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
        '## Beads Coverage Resolution Structured Output Retry',
        `Your previous response failed validation: ${params.validationError}`,
        '',
        'Return only one corrected YAML artifact.',
        'Requirements:',
        '- Use a top-level `beads` list of semantic Part 1 bead records only.',
        '- Include a top-level `changes` list that fully accounts for the diff between the current Beads candidate and the revised Beads candidate. Each entry: {type, id, title, summary}.',
        '- Include a top-level `gap_resolutions` list with exactly one entry per provided coverage gap.',
        '- Preserve existing bead order and IDs unless a provided gap requires a concrete change.',
        '- Every bead must include non-empty `acceptanceCriteria` and `tests`; `testCommands` may be empty only with a non-empty `testCommandReason`.',
        '- If a gap describes internally contradictory source artifacts, do not choose a side or invent implementation requirements. Record `action: left_unresolved`, explain the contradiction in `rationale`, and use `affected_items: []`.',
        '- Use `affected_items` only for bead references. Leave it empty when no bead mapping applies.',
        '- If a gap does not map cleanly to one or more specific beads, use `affected_items: []` and do not emit PRD refs, section names, or non-bead item types.',
        '',
        'Previous invalid response:',
        '```yaml',
        sanitizedRawResponse || '[empty response]',
        '```',
      ].join('\n'),
    },
  ]
}
