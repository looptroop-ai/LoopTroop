import { relative } from 'node:path'
import { contentSha256 } from '../lib/contentHash'
import { getActivePhaseAttempt, getTicketByRef, getTicketPaths, insertPhaseArtifact } from '../storage/tickets'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

type EditedArtifactType = 'interview' | 'prd' | 'beads' | 'execution_setup_plan'
type UserEditAction = 'save' | 'save_and_restart' | 'save_and_rewind' | 'regenerate'
type EditSurface = 'raw' | 'structured' | 'answers' | 'jsonl' | 'unknown'

interface RestartSummary {
  reason: string
  archivedAttempts: Array<{ phase: string; attemptNumber: number }>
  createdAttempts: Array<{ phase: string; attemptNumber: number }>
}

interface InvalidationSummary {
  removedArtifacts: number
  removedFiles: string[]
  invalidatedPhases?: string[]
  clearedExecutionSetupState?: boolean
}

function toTicketRelativePaths(ticketId: string, paths: string[]): string[] {
  const ticketPaths = getTicketPaths(ticketId)
  if (!ticketPaths) return paths
  return paths.map((path) => {
    const relativePath = relative(ticketPaths.ticketDir, path).replace(/\\/g, '/')
    if (!relativePath || relativePath.startsWith('..')) return path
    return `.ticket/${relativePath}`
  })
}

export function buildContentDigest(raw: string | null): {
  sha256: string | null
  bytes: number
} {
  return {
    sha256: raw == null ? null : contentSha256(raw),
    bytes: raw == null ? 0 : Buffer.byteLength(raw, 'utf8'),
  }
}

export function writeUserEditReceipt(input: {
  ticketId: string
  artifactType: EditedArtifactType
  phase: WorkflowPhaseId
  action: UserEditAction
  editSurface?: EditSurface
  statusBeforeEdit: string
  statusAfterEdit?: string | null
  beforeRaw: string | null
  afterRaw: string
  beforeItemCount?: number | null
  afterItemCount?: number | null
  restart?: RestartSummary | null
  invalidation?: InvalidationSummary | null
}): void {
  const ticket = getTicketByRef(input.ticketId)
  const activeAttempt = getActivePhaseAttempt(input.ticketId, input.phase)
  const before = buildContentDigest(input.beforeRaw)
  const after = buildContentDigest(input.afterRaw)
  const invalidation = input.invalidation
    ? {
        removed_artifacts: input.invalidation.removedArtifacts,
        removed_files: toTicketRelativePaths(input.ticketId, input.invalidation.removedFiles),
        invalidated_phases: input.invalidation.invalidatedPhases ?? [],
        cleared_execution_setup_state: Boolean(input.invalidation.clearedExecutionSetupState),
      }
    : null

  insertPhaseArtifact(input.ticketId, {
    phase: input.phase,
    phaseAttempt: activeAttempt ?? undefined,
    artifactType: `user_edit_receipt:${input.artifactType}`,
    content: JSON.stringify({
      schema_version: 1,
      artifact: 'user_edit_receipt',
      target_artifact: input.artifactType,
      action: input.action,
      edit_surface: input.editSurface ?? 'unknown',
      edited_by: 'user',
      edited_at: new Date().toISOString(),
      phase: input.phase,
      phase_attempt: activeAttempt,
      ticket_status_before: input.statusBeforeEdit,
      ticket_status_after: input.statusAfterEdit ?? ticket?.status ?? null,
      before: {
        sha256: before.sha256,
        bytes: before.bytes,
        item_count: input.beforeItemCount ?? null,
      },
      after: {
        sha256: after.sha256,
        bytes: after.bytes,
        item_count: input.afterItemCount ?? null,
      },
      restart: input.restart
        ? {
            reason: input.restart.reason,
            archived_attempts: input.restart.archivedAttempts.map((attempt) => ({
              phase: attempt.phase,
              attempt_number: attempt.attemptNumber,
            })),
            created_attempts: input.restart.createdAttempts.map((attempt) => ({
              phase: attempt.phase,
              attempt_number: attempt.attemptNumber,
            })),
          }
        : null,
      invalidation,
    }),
  })
}
