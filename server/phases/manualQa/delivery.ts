import { listManualQaVersions, readManualQaSummary } from './storage'
import { ManualQaSummarySchema, type ManualQaSummary } from './types'
import { getLatestPhaseArtifact, getTicketPaths } from '../../storage/tickets'

type CompletedManualQaOutcome = Exclude<ManualQaSummary['outcome'], 'failed'>

export interface ManualQaDeliverySummary {
  version: number
  outcome: CompletedManualQaOutcome
  createdFixBeadIds: string[]
  improvementTicketIds: string[]
  waivedItemIds: string[]
  skipReason: string | null
}

/**
 * Build the compact delivery view across the whole QA loop. The newest
 * completed round owns the outcome/waiver/skip state, while created work is
 * cumulative because fix beads and improvement tickets from earlier rounds
 * remain part of the delivered ticket's history.
 */
export function readManualQaDeliverySummary(ticketDir: string): ManualQaDeliverySummary | null {
  const summaries = listManualQaVersions(ticketDir)
    .map((version) => readManualQaSummary(ticketDir, version))
    .filter((summary): summary is ManualQaSummary & { outcome: CompletedManualQaOutcome } => (
      summary !== null && summary.outcome !== 'failed'
    ))
  const latest = summaries.at(-1)
  if (!latest) return null

  return {
    version: latest.version,
    outcome: latest.outcome,
    createdFixBeadIds: [...new Set(summaries.flatMap((summary) => summary.createdFixBeadIds))],
    improvementTicketIds: [...new Set(summaries.flatMap((summary) => summary.improvementTicketIds))],
    waivedItemIds: latest.waivedItemIds,
    skipReason: latest.skipReason ?? null,
  }
}

/**
 * Reads a stored `manual_qa_summary` phase artifact.
 *
 * The fallback for a ticket whose canonical `manual-qa/` files are gone or were
 * never written. Two phases had their own version of this and they were not
 * equivalent: the integration phase validated against the schema and refused a
 * `failed` outcome, while the pull-request phase unwrapped a `value` key and
 * handed whatever it found straight to the prompt. So the same artifact could
 * be refused by one phase and described to the model by the other.
 *
 * Returns null for anything this cannot vouch for, which is what the prompt
 * needs: no Manual QA section at all is honest, a section built from an
 * unvalidated envelope is not.
 */
export function parseManualQaDeliverySummaryArtifact(content: string): ManualQaDeliverySummary | null {
  try {
    const raw = JSON.parse(content) as unknown
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const candidate = record.value && typeof record.value === 'object' && !Array.isArray(record.value)
      ? record.value as Record<string, unknown>
      : record
    const { idempotencyKey: _idempotencyKey, ...summaryValue } = candidate
    const parsed = ManualQaSummarySchema.safeParse(summaryValue)
    if (!parsed.success || parsed.data.outcome === 'failed') return null
    return {
      version: parsed.data.version,
      outcome: parsed.data.outcome,
      createdFixBeadIds: parsed.data.createdFixBeadIds,
      improvementTicketIds: parsed.data.improvementTicketIds,
      waivedItemIds: parsed.data.waivedItemIds,
      skipReason: parsed.data.skipReason ?? null,
    }
  } catch {
    return null
  }
}

/** Canonical files first, the stored phase artifact as a fallback. */
export function readManualQaDeliverySummaryForTicket(ticketId: string): ManualQaDeliverySummary | null {
  const ticketDir = getTicketPaths(ticketId)?.ticketDir
  const canonical = ticketDir ? readManualQaDeliverySummary(ticketDir) : null
  if (canonical) return canonical

  const artifact = getLatestPhaseArtifact(ticketId, 'manual_qa_summary')
  return artifact ? parseManualQaDeliverySummaryArtifact(artifact.content) : null
}
