import * as jsYaml from 'js-yaml'
import type { ArtifactStructuredOutputData } from '../phaseArtifactTypes'

/** Reading the Manual QA checklist artifact and its processing metadata. */

interface ManualQaArtifactItem {
  id: string
  title: string
  behavior: string
  severity: string
  source: string
  recheckState?: string
  prerequisites: string[]
  actions: string[]
  expectedResult: string
  watchNotes: string[]
  prdRefs: Array<{ ref: string; coverage?: string }>
  beadRefs: string[]
}

export interface ManualQaArtifactChecklist {
  version: number | null
  generatedAt?: string
  summary?: string
  items: ManualQaArtifactItem[]
  notApplicablePrdRefs: Array<{ ref: string; reason: string }>
}

function manualQaArtifactRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function manualQaArtifactStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

/**
 * The repair trail generation recorded, folded into the artifact by the panel.
 *
 * Manual QA generation retries and repairs like every other artifact-processing
 * path, and until this was read the checklist view showed only the result — so
 * an operator never learned a repair had happened, and a generation that gave
 * up showed nothing at all.
 */
export function readManualQaProcessingMetadata(content: string): {
  structuredOutput?: ArtifactStructuredOutputData
  validationError?: string
} {
  try {
    const envelope = JSON.parse(content) as { structuredOutput?: unknown; validationError?: unknown }
    return {
      ...(envelope.structuredOutput && typeof envelope.structuredOutput === 'object'
        ? { structuredOutput: envelope.structuredOutput as ArtifactStructuredOutputData }
        : {}),
      ...(typeof envelope.validationError === 'string' ? { validationError: envelope.validationError } : {}),
    }
  } catch {
    // The artifact can also be the canonical YAML document, which carries none.
    return {}
  }
}

export function parseManualQaArtifactChecklist(content: string): { raw: string; checklist: ManualQaArtifactChecklist } | null {
  let raw = content
  try {
    const envelope = JSON.parse(content) as { checklist?: unknown }
    if (typeof envelope.checklist === 'string' && envelope.checklist.trim()) raw = envelope.checklist
  } catch {
    // The artifact can also be the canonical YAML document itself.
  }

  try {
    const parsed = manualQaArtifactRecord(jsYaml.load(raw))
    if (!parsed || !Array.isArray(parsed.items)) return null
    const items = parsed.items.map((value) => {
      const item = manualQaArtifactRecord(value)
      if (!item) return null
      const prdValues = Array.isArray(item.prdRefs) ? item.prdRefs : Array.isArray(item.prd_refs) ? item.prd_refs : []
      return {
        id: String(item.id ?? ''),
        title: String(item.title ?? ''),
        behavior: String(item.behavior ?? ''),
        severity: String(item.severity ?? 'optional'),
        source: String(item.source ?? 'implementation_diff'),
        recheckState: typeof (item.recheckState ?? item.recheck_state) === 'string' ? String(item.recheckState ?? item.recheck_state) : undefined,
        prerequisites: manualQaArtifactStrings(item.prerequisites),
        actions: manualQaArtifactStrings(item.actions),
        expectedResult: String(item.expectedResult ?? item.expected_result ?? ''),
        watchNotes: manualQaArtifactStrings(item.watchNotes ?? item.watch_notes),
        beadRefs: manualQaArtifactStrings(item.beadRefs ?? item.bead_refs),
        prdRefs: prdValues.map((referenceValue) => {
          const reference = manualQaArtifactRecord(referenceValue)
          return reference
            ? { ref: String(reference.ref ?? ''), coverage: typeof reference.coverage === 'string' ? reference.coverage : undefined }
            : { ref: String(referenceValue) }
        }).filter((reference) => reference.ref),
      }
    }).filter((item) => item !== null) as ManualQaArtifactItem[]
    const notApplicableValues = Array.isArray(parsed.notApplicablePrdRefs)
      ? parsed.notApplicablePrdRefs
      : Array.isArray(parsed.not_applicable_prd_refs)
        ? parsed.not_applicable_prd_refs
        : []
    const generatedAt = parsed.generatedAt ?? parsed.generated_at
    return {
      raw,
      checklist: {
        version: typeof parsed.version === 'number' ? parsed.version : null,
        generatedAt: typeof generatedAt === 'string'
          ? generatedAt
          : generatedAt instanceof Date
            ? generatedAt.toISOString()
            : undefined,
        summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
        items,
        notApplicablePrdRefs: notApplicableValues.map((value) => {
          const entry = manualQaArtifactRecord(value)
          return { ref: String(entry?.ref ?? ''), reason: String(entry?.reason ?? '') }
        }).filter((entry) => entry.ref && entry.reason),
      },
    }
  } catch {
    return null
  }
}
