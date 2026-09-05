import { z } from 'zod'
import type { StructuredOutputResult } from '../../structuredOutput/types'
import {
  buildYamlDocument,
  collectTaggedCandidates,
  parseYamlOrJsonCandidate,
} from '../../structuredOutput/yamlUtils'
import { buildStructuredOutputFailure } from '../../structuredOutput/failure'
import { contentSha256 } from '../../lib/contentHash'
import { getErrorMessage } from '@shared/typeGuards'
import {
  MANUAL_QA_SCHEMA_VERSION,
  ManualQaChecklistSchema,
  type ManualQaChecklist,
  type ManualQaPrdCriterion,
  type ManualQaResults,
} from './types'
import { validateManualQaPrdReferences } from './coverage'
import { PROTOCOL_TAGS } from '../../structuredOutput/protocolTags'

export const MANUAL_QA_CHECKLIST_TAG = PROTOCOL_TAGS.MANUAL_QA_CHECKLIST

const ModelReferenceSchema = z.object({
  ref: z.string().trim().min(1),
  coverage: z.enum(['full', 'partial']),
}).strict()

const ModelNotApplicableReferenceSchema = z.object({
  ref: z.string().trim().min(1),
  reason: z.string().trim().min(1),
}).strict()

const ModelItemSchema = z.object({
  lineageId: z.string().trim().min(1).max(160),
  priorItemIds: z.array(z.string().trim().min(1)).default([]),
  title: z.string().trim().min(1).max(500),
  source: z.enum(['prd', 'bead', 'previous_qa', 'implementation_diff']),
  behavior: z.string().trim().min(1),
  severity: z.enum(['required', 'optional']),
  recheckState: z.enum(['new', 'pending_recheck', 'previously_passed']),
  prerequisites: z.array(z.string().trim().min(1)).default([]),
  actions: z.array(z.string().trim().min(1)).min(1),
  expectedResult: z.string().trim().min(1),
  watchNotes: z.array(z.string().trim().min(1)).default([]),
  beadRefs: z.array(z.string().trim().min(1)).default([]),
  prdRefs: z.array(ModelReferenceSchema).default([]),
}).strict()

const ModelChecklistSchema = z.object({
  summary: z.string().trim().min(1),
  notApplicablePrdRefs: z.array(ModelNotApplicableReferenceSchema),
  items: z.array(ModelItemSchema).min(1),
}).strict()

const KEY_ALIASES: Record<string, string> = {
  lineage_id: 'lineageId',
  prior_item_ids: 'priorItemIds',
  recheck_state: 'recheckState',
  expected_result: 'expectedResult',
  watch_notes: 'watchNotes',
  bead_refs: 'beadRefs',
  prd_refs: 'prdRefs',
  not_applicable_prd_refs: 'notApplicablePrdRefs',
}

const HEX_TEXT_MAPPING_KEYS = new Set([
  'summary',
  'title',
  'behavior',
  'expected_result',
  'expectedResult',
])
const HEX_TEXT_SEQUENCE_KEYS = new Set(['prerequisites', 'actions', 'watch_notes', 'watchNotes'])
const HEX_COLOR_TOKEN = /(^|[\s(,;:])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?=$|[\s),.;:!?])/i

function isPlainYamlScalar(value: string): boolean {
  const trimmed = value.trim()
  return Boolean(trimmed) && !/^["'[\]{|}>]/.test(trimmed)
}

/**
 * Preserve emitted hex-color text before YAML can interpret it as a comment.
 * This repair is deliberately restricted to known Manual QA prose fields and
 * only quotes the model's existing scalar; it never creates replacement text.
 */
function repairManualQaHexColorText(yaml: string): { yaml: string; repaired: boolean } {
  const lines = yaml.split('\n')
  let sequenceKey: string | null = null
  let sequenceIndent = -1
  let repaired = false
  const output = lines.map((line) => {
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0
    const trimmed = line.trim()
    if (trimmed && sequenceKey && indent <= sequenceIndent && !trimmed.startsWith('-')) {
      sequenceKey = null
      sequenceIndent = -1
    }

    const sequenceParent = line.match(/^(\s*)([A-Za-z_][\w-]*)\s*:\s*$/)
    if (sequenceParent) {
      sequenceKey = HEX_TEXT_SEQUENCE_KEYS.has(sequenceParent[2]!) ? sequenceParent[2]! : null
      sequenceIndent = sequenceKey ? sequenceParent[1]!.length : -1
      return line
    }

    const mapping = line.match(/^(\s*(?:-\s+)?)([A-Za-z_][\w-]*)\s*:\s*(.+)$/)
    if (mapping && HEX_TEXT_MAPPING_KEYS.has(mapping[2]!)) {
      const value = mapping[3]!
      if (isPlainYamlScalar(value) && HEX_COLOR_TOKEN.test(value)) {
        repaired = true
        return `${mapping[1]}${mapping[2]}: ${JSON.stringify(value.trim())}`
      }
    }

    if (sequenceKey && indent > sequenceIndent) {
      const item = line.match(/^(\s*-\s+)(.+)$/)
      if (item && isPlainYamlScalar(item[2]!) && HEX_COLOR_TOKEN.test(item[2]!)) {
        repaired = true
        return `${item[1]}${JSON.stringify(item[2]!.trim())}`
      }
    }
    return line
  })
  return { yaml: output.join('\n'), repaired }
}

function normalizeAliases(value: unknown, warnings: string[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeAliases(entry, warnings))
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = KEY_ALIASES[key] ?? key
    if (normalizedKey !== key) {
      warnings.push(`Normalized YAML key alias ${key} to ${normalizedKey}.`)
    }
    if (Object.prototype.hasOwnProperty.call(output, normalizedKey)) {
      throw new Error(`Duplicate checklist field after alias normalization: ${normalizedKey}`)
    }
    output[normalizedKey] = normalizeAliases(child, warnings)
  }
  return output
}

export interface ManualQaChecklistParseOptions {
  ticketId: string
  version: number
  prdCriteria: readonly ManualQaPrdCriterion[]
  generatedAt?: string
  previousChecklist?: ManualQaChecklist | null
  previousResults?: ManualQaResults | null
}

export type ManualQaChecklistParseResult = StructuredOutputResult<ManualQaChecklist> & {
  checklistHash?: string
}

export function validateManualQaChecklistLineage(
  checklist: ManualQaChecklist,
  previousChecklist: ManualQaChecklist | null | undefined,
  previousResults: ManualQaResults | null | undefined,
): void {
  if (!previousChecklist) {
    const invalid = checklist.items.find((item) => item.priorItemIds.length > 0 || item.recheckState !== 'new')
    if (invalid) {
      throw new Error(`First-round checklist item ${invalid.id} must be new and cannot reference prior items.`)
    }
    return
  }

  const previousById = new Map(previousChecklist.items.map((item) => [item.id, item]))
  const resultByItemId = new Map(previousResults?.results.map((result) => [result.itemId, result]) ?? [])
  const referencedPreviousIds = new Set<string>()

  for (const item of checklist.items) {
    if (item.priorItemIds.length === 0) {
      if (item.recheckState !== 'new') {
        throw new Error(`New checklist item ${item.id} must use the new recheck state.`)
      }
      continue
    }
    if (item.recheckState === 'new') {
      throw new Error(`Checklist item ${item.id} references prior items and must be pending_recheck or previously_passed.`)
    }
    for (const priorItemId of item.priorItemIds) {
      const prior = previousById.get(priorItemId)
      if (!prior) throw new Error(`Checklist item ${item.id} references unknown prior item ${priorItemId}.`)
      if (prior.lineageId !== item.lineageId) {
        throw new Error(`Checklist item ${item.id} changed lineage from ${prior.lineageId} to ${item.lineageId}.`)
      }
      if (referencedPreviousIds.has(priorItemId)) {
        throw new Error(`Prior checklist item ${priorItemId} is referenced more than once.`)
      }
      referencedPreviousIds.add(priorItemId)
      const priorOutcome = resultByItemId.get(priorItemId)?.outcome
      if (item.recheckState === 'previously_passed' && priorOutcome && priorOutcome !== 'pass') {
        throw new Error(`Checklist item ${item.id} can be previously_passed only when its prior result passed.`)
      }
      if (priorOutcome === 'fail' && item.recheckState !== 'pending_recheck') {
        throw new Error(`Previously failed item ${priorItemId} must be pending_recheck.`)
      }
      if (priorOutcome === 'waive' && item.recheckState !== 'pending_recheck') {
        throw new Error(`A retained waived item ${priorItemId} must be pending_recheck.`)
      }
    }
  }

  for (const previousResult of previousResults?.results ?? []) {
    if (previousResult.outcome === 'fail' && !referencedPreviousIds.has(previousResult.itemId)) {
      throw new Error(`Previously failed item ${previousResult.itemId} must remain in the next checklist for recheck.`)
    }
  }
}

export function parseManualQaChecklistOutput(
  rawContent: string,
  options: ManualQaChecklistParseOptions,
): ManualQaChecklistParseResult {
  const candidates = collectTaggedCandidates(rawContent, MANUAL_QA_CHECKLIST_TAG)
  if (candidates.length === 0) {
    return buildStructuredOutputFailure(rawContent, `Expected exactly one <${MANUAL_QA_CHECKLIST_TAG}> tagged YAML response.`)
  }

  const openingTags = rawContent.match(new RegExp(`<${MANUAL_QA_CHECKLIST_TAG}>`, 'gi'))?.length ?? 0
  const closingTags = rawContent.match(new RegExp(`</${MANUAL_QA_CHECKLIST_TAG}>`, 'gi'))?.length ?? 0
  if (openingTags !== 1 || closingTags !== 1) {
    return buildStructuredOutputFailure(rawContent, `Expected exactly one complete <${MANUAL_QA_CHECKLIST_TAG}> tagged YAML response.`)
  }

  const repairWarnings: string[] = []
  try {
    const hexRepaired = repairManualQaHexColorText(candidates[0]!)
    if (hexRepaired.repaired) {
      repairWarnings.push('Quoted hex-color text in Manual QA prose before YAML parsing.')
    }
    const parsed = parseYamlOrJsonCandidate(hexRepaired.yaml, {
      repairWarnings,
      nestedMappingChildren: {
        items: [
          'lineage_id', 'lineageId', 'prior_item_ids', 'priorItemIds', 'source',
          'title', 'behavior', 'severity', 'recheck_state', 'recheckState',
          'prerequisites', 'actions', 'expected_result', 'expectedResult',
          'watch_notes', 'watchNotes', 'bead_refs', 'beadRefs', 'prd_refs', 'prdRefs',
        ],
      },
    })
    const model = ModelChecklistSchema.parse(normalizeAliases(parsed, repairWarnings))
    const checklist = ManualQaChecklistSchema.parse({
      schemaVersion: MANUAL_QA_SCHEMA_VERSION,
      artifact: 'manual_qa_checklist',
      ticketId: options.ticketId,
      version: options.version,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      summary: model.summary,
      notApplicablePrdRefs: model.notApplicablePrdRefs,
      items: model.items.map((item, index) => ({
        id: `qa-v${options.version}-${String(index + 1).padStart(3, '0')}`,
        ...item,
      })),
    })
    validateManualQaPrdReferences(checklist, options.prdCriteria)
    validateManualQaChecklistLineage(checklist, options.previousChecklist, options.previousResults)
    const normalizedContent = buildYamlDocument(checklist)
    return {
      ok: true,
      value: checklist,
      normalizedContent,
      checklistHash: contentSha256(normalizedContent),
      repairApplied: repairWarnings.length > 0,
      repairWarnings: [...new Set(repairWarnings)],
    }
  } catch (error) {
    const failure = buildStructuredOutputFailure(rawContent, getErrorMessage(error))
    return {
      ...failure,
      repairApplied: repairWarnings.length > 0 || failure.repairApplied,
      repairWarnings: [...new Set([...repairWarnings, ...failure.repairWarnings])],
    }
  }
}
