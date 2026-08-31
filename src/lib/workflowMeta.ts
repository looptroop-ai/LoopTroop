import {
  type EditableArtifactType,
  isWorkflowPhaseId,
  type KanbanPhase,
  WORKFLOW_GROUPS,
  WORKFLOW_PHASE_MAP,
  WORKFLOW_PHASES,
  type WorkflowPhaseId,
  type WorkflowPhaseMeta,
} from '@shared/workflowMeta'
import { sanitizeErrorForDisplay } from './errorDisplay'

export { WORKFLOW_GROUPS, WORKFLOW_PHASES, WORKFLOW_PHASE_MAP }
export type { EditableArtifactType, KanbanPhase }

/** Options for customising the user-facing status label (e.g., injecting bead progress or question counts). */
export interface StatusLabelOptions {
  currentBead?: number | null
  totalBeads?: number | null
  questionIndex?: number | null
  questionTotal?: number | null
  errorMessage?: string | null
}

/**
 * Builds a per-status lookup from the shared phase table.
 *
 * Keyed by `WorkflowPhaseId` rather than by `string`, so a phase added to shared
 * metadata cannot quietly miss an entry here: the record would not type-check.
 * Statuses arriving as plain text go through the accessors below instead of
 * indexing these records directly.
 */
function buildPhaseRecord<T>(select: (phase: WorkflowPhaseMeta) => T): Record<WorkflowPhaseId, T> {
  return Object.fromEntries(
    WORKFLOW_PHASES.map((phase) => [phase.id, select(phase)]),
  ) as Record<WorkflowPhaseId, T>
}

/** Maps every workflow status ID to its short description (includes safe-resume suffix). */
const STATUS_DESCRIPTIONS = buildPhaseRecord((phase) => phase.description)

/** Linear ordering of all workflow status IDs — used for range checks and progression queries. */
export const STATUS_ORDER: readonly string[] = WORKFLOW_PHASES.map((phase) => phase.id)

const BASE_STATUS_LABELS = buildPhaseRecord((phase) => phase.label)

/**
 * Returns the short description shown in status tooltips, or `undefined` for a
 * status that is not part of the workflow.
 */
export function getStatusDescription(status: string): string | undefined {
  return isWorkflowPhaseId(status) ? STATUS_DESCRIPTIONS[status] : undefined
}

function hasReachedStatus(currentStatus: string, targetStatus: string): boolean {
  const currentIndex = STATUS_ORDER.indexOf(currentStatus)
  const targetIndex = STATUS_ORDER.indexOf(targetStatus)
  return currentIndex >= 0 && targetIndex >= 0 && currentIndex >= targetIndex
}

function isStatusInRange(currentStatus: string, startStatus: string, endStatus: string): boolean {
  return hasReachedStatus(currentStatus, startStatus) && !hasReachedStatus(currentStatus, endStatus)
}

/**
 * Returns a warning message when saving a post-approval artifact edit would
 * archive downstream planning and restart the next drafting phase, or `null`
 * if no cascade warning is needed.
 */
export function getCascadeEditWarningMessage(
  currentStatus: string,
  artifactType: EditableArtifactType,
  previousStatus?: string | null,
): string | null {
  const effectiveStatus = currentStatus === 'BLOCKED_ERROR' && previousStatus
    ? previousStatus
    : currentStatus
  if (artifactType === 'beads' || artifactType === 'execution_setup_plan') return null

  const affectedPhases: string[] = []

  if (
    artifactType === 'interview'
    && isStatusInRange(effectiveStatus, 'DRAFTING_PRD', 'PRE_FLIGHT_CHECK')
  ) {
    affectedPhases.push('PRD')
  }

  const shouldWarnAboutBeads = isStatusInRange(
    effectiveStatus,
    'DRAFTING_BEADS',
    'PRE_FLIGHT_CHECK',
  )

  if (shouldWarnAboutBeads) {
    affectedPhases.push('Beads')
  }

  if (affectedPhases.length === 0) return null

  if (artifactType === 'interview') {
    if (affectedPhases.includes('Beads')) {
      return 'Saving this Interview edit will restart PRD/specs planning and Beads planning from the edited Interview. Previous PRD and Beads versions will be archived and remain available read-only.'
    }

    return 'Saving this Interview edit will restart PRD/specs planning from the edited Interview. Previous PRD versions will be archived and remain available read-only.'
  }

  return 'Saving this PRD edit will restart Beads/blueprint planning from the edited PRD. Previous Beads versions will be archived and remain available read-only.'
}

function formatBlockedErrorLabel(errorMessage?: string | null): string {
  const blockedErrorLabel = BASE_STATUS_LABELS.BLOCKED_ERROR
  if (!errorMessage) return blockedErrorLabel
  const trimmed = sanitizeErrorForDisplay(errorMessage).replace(/\s+/g, ' ').trim()
  if (!trimmed) return blockedErrorLabel
  const shortReason = trimmed.length > 56 ? `${trimmed.slice(0, 53)}...` : trimmed
  return `Error (${shortReason})`
}

/**
 * Returns the human-readable label for a workflow status, optionally enriched
 * with dynamic data (bead progress, question index, error reason).
 */
export function getStatusUserLabel(status: string, options: StatusLabelOptions = {}): string {
  if (status === 'CODING') {
    const current = options.currentBead ?? null
    const total = options.totalBeads ?? null
    if (current && total) return `Implementing (Bead ${current}/${total})`
  }

  if (status === 'WAITING_INTERVIEW_ANSWERS') {
    const index = options.questionIndex ?? null
    const total = options.questionTotal ?? null
    if (index && total) return `Interviewing (Q ${index}/${total})`
  }

  if (status === 'BLOCKED_ERROR') {
    return formatBlockedErrorLabel(options.errorMessage)
  }

  return (isWorkflowPhaseId(status) ? BASE_STATUS_LABELS[status] : undefined)
    ?? status.replace(/_/g, ' ')
}
