import { getWorkflowPhaseMeta, WORKFLOW_PHASES } from '@shared/workflowMeta'

/**
 * The statuses that hold a project's single execution slot, in workflow order.
 *
 * Derived from the phase table so the band and the workflow cannot disagree —
 * a new execution phase joins the band by carrying `executionBand` there, and
 * there is no second list to forget.
 */
export const EXECUTION_BAND_STATUSES: readonly string[] = WORKFLOW_PHASES
  .filter((phase) => phase.executionBand)
  .map((phase) => phase.id)

export const EXECUTION_BAND_CONCURRENCY_LIMIT_MESSAGE =
  'Configured limitation in LoopTroop alpha: Each project may have only one active ticket in the execution band at a time.'

/**
 * Turns an internal execution-band status into the shortest useful user-facing
 * workflow label. Runtime-only progress placeholders (for example, a bead
 * count) are deliberately omitted because they are not stable conflict context.
 */
export function getExecutionBandStatusLabel(status: string): string {
  const configuredLabel = getWorkflowPhaseMeta(status)?.label
  if (configuredLabel) {
    const label = configuredLabel.replace(/\s*\([^()]*\?[^()]*\)/g, '').trim()
    if (label) return label
  }
  return status.toLowerCase().replace(/_/g, ' ')
}

export function buildExecutionBandConflictMessage(
  blockedTicket: { externalId: string },
  conflict: { externalId: string; status: string },
): string {
  const statusLabel = getExecutionBandStatusLabel(conflict.status)
  return `${blockedTicket.externalId} can’t enter execution yet because ${conflict.externalId} is still running and currently at ${statusLabel}. ${EXECUTION_BAND_CONCURRENCY_LIMIT_MESSAGE} Finish or cancel ${conflict.externalId}, then try again.`
}

export function isExecutionBandStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && getWorkflowPhaseMeta(status)?.executionBand === true
}
