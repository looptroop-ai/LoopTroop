import { getWorkflowPhaseMeta } from '@shared/workflowMeta'

export const EXECUTION_BAND_STATUSES = [
  'PRE_FLIGHT_CHECK',
  'GENERATING_EXECUTION_SETUP_PLAN',
  'WAITING_EXECUTION_SETUP_APPROVAL',
  'PREPARING_EXECUTION_ENV',
  'CODING',
  'RUNNING_FINAL_TEST',
  'GENERATING_QA_CHECKLIST',
  'WAITING_MANUAL_QA',
  'INTEGRATING_CHANGES',
  'CREATING_PULL_REQUEST',
  'WAITING_PR_REVIEW',
  'CLEANING_ENV',
] as const

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
  return typeof status === 'string' && EXECUTION_BAND_STATUSES.includes(status as (typeof EXECUTION_BAND_STATUSES)[number])
}
