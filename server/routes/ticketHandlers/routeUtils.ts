import type { Context } from 'hono'
import { lstatSync } from 'node:fs'
import { ContainedPathError } from '../../lib/containedPath'
import { db as appDb } from '../../db/index'
import { profiles } from '../../db/schema'
import {
  ensureActorForTicket,
  getTicketState,
  revertTicketToApprovalStatus,
} from '../../machines/persistence'
import { abortTicketSessions } from '../../opencode/sessionManager'
import { clearContextCache } from '../../opencode/contextBuilder'
import { broadcaster } from '../../sse/broadcaster'
import { appendLogEvent, createLogEvent, shouldSkipLogEmission } from '../../log/executionLog'
import {
  cancelTicket,
  claimInterviewBatch,
  releaseInterviewBatch,
  renewInterviewBatchClaim,
} from '../../workflow/runner'
import {
  archiveActivePhaseAttempts,
  createFreshPhaseAttempts,
  ensureActivePhaseAttempt,
  EXECUTION_SETUP_PLAN_RESTART_PHASES,
  EXECUTION_SETUP_RUNTIME_REWIND_PHASES,
  getTicketByRef,
  getTicketPaths,
  resolveTicketContainedPath,
  INTERVIEW_EDIT_RESTART_PHASES,
  isDisplayOnlyMockTicket,
  PRD_EDIT_RESTART_PHASES,
  type PublicTicket,
  type PublicTicketPhaseAttemptRow,
} from '../../storage/tickets'
import { clearExecutionSetupRuntimeArtifacts } from '../../phases/executionSetup/storage'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

export { buildExecutionBandConflictMessage } from '../../workflow/executionBand'

export function getProfileDefaults() {
  return appDb.select().from(profiles).get()
}

/**
 * Logs a failed ticket route operation. Keeps the `[tickets]` prefix in one place so every
 * handler reports the same way; `action` is the wording that precedes the ticket id, for
 * example `Failed to send START to ticket`. A handful of messages read with wording after the
 * id instead — pass it as `trailing` rather than writing the prefix out again.
 */
export function logTicketOperationError(
  ticketId: string,
  action: string,
  error: unknown,
  trailing?: string,
): void {
  console.error(`[tickets] ${action} ${ticketId}${trailing ? ` ${trailing}` : ''}:`, error)
}

export function respondWithState(c: Context, ticketId: string, message: string) {
  const updated = getTicketByRef(ticketId)
  const state = getTicketState(ticketId)
  return c.json({
    message,
    ticketId,
    status: state?.state ?? updated?.status,
    state: state?.state,
    ...(updated ? { ticket: updated } : {}),
  })
}

export function buildRouteStatePayload(ticketId: string) {
  const updated = getTicketByRef(ticketId)
  const state = getTicketState(ticketId)
  return {
    status: state?.state ?? updated?.status,
    state: state?.state,
    ...(updated ? { ticket: updated } : {}),
  }
}

export function emitRoutePhaseLog(
  ticketId: string,
  phase: WorkflowPhaseId,
  type: 'info' | 'error',
  content: string,
  data?: Record<string, unknown>,
) {
  const timestamp = new Date().toISOString()
  const source = type === 'error' ? 'error' : 'system'
  const kind = type === 'error' ? 'error' : 'milestone'
  const emissionData = data ? { ticketId, ...data, timestamp } : { ticketId, timestamp }
  const structuredExtra = {
    audience: 'all',
    kind,
    op: 'append',
    streaming: false,
    ...(typeof data?.phaseAttempt === 'number' && Number.isFinite(data.phaseAttempt) ? { phaseAttempt: data.phaseAttempt } : {}),
  } as const
  if (shouldSkipLogEmission(ticketId, type, phase, content, emissionData, source, phase, structuredExtra)) {
    return
  }

  const event = createLogEvent(
    ticketId,
    type,
    phase,
    content,
    emissionData,
    source,
    phase,
    structuredExtra,
  )
  broadcaster.broadcast(ticketId, 'log', { ...event })
  appendLogEvent(
    ticketId,
    type,
    phase,
    content,
    emissionData,
    source,
    phase,
    structuredExtra,
  )
}

export function getTicketParam(c: Context): string {
  const ticketId = c.req.param('id') ?? c.req.param('ticketId')
  if (!ticketId) {
    throw new Error('Ticket route is missing the required id parameter')
  }
  return ticketId
}

export function getRequiredRouteParam(c: Context, name: string): string {
  const value = c.req.param(name)
  if (!value) {
    throw new Error(`Route is missing required parameter "${name}"`)
  }
  return value
}

export function rejectDisplayOnlyMockTicket(c: Context, ticket: Pick<PublicTicket, 'branchName'>) {
  if (!isDisplayOnlyMockTicket(ticket)) return null
  return c.json({ error: 'Display-only mock tickets are board-only and cannot run workflow actions' }, 409)
}

async function cancelAndConfirmTicketSessions(ticketId: string): Promise<void> {
  cancelTicket(ticketId)
  const stopped = await abortTicketSessions(ticketId)
  if (stopped === false) {
    throw new Error('Could not confirm that active OpenCode sessions stopped')
  }
}

export interface PhaseRestartSummary {
  reason: string
  archivedAttempts: PublicTicketPhaseAttemptRow[]
  createdAttempts: PublicTicketPhaseAttemptRow[]
}

/**
 * The existing durable ticket claim also fences manual planning edits.
 *
 * The name is historical — interview batches were the first user of the row —
 * but the row is the only ticket-scoped CAS claim shared by every daemon. A
 * planning edit keeps it from the first baseline read through its save,
 * awaited restart, and downstream invalidation, then releases it explicitly;
 * no SQLite transaction is held across the external stop.
 */
export function claimPlanningEdit(ticketId: string): string | null {
  return claimInterviewBatch(ticketId)
}

export function releasePlanningEdit(ticketId: string, token: string): void {
  releaseInterviewBatch(ticketId, token)
}

export class PlanningEditClaimLostError extends Error {
  constructor() {
    super('Planning edit ownership was lost before restart side effects could be applied')
    this.name = 'PlanningEditClaimLostError'
  }
}

export function assertPlanningEditClaim(ticketId: string, token: string): void {
  if (!renewInterviewBatchClaim(ticketId, token)) throw new PlanningEditClaimLostError()
}

function requireExistingTicketWorkspace(ticketId: string): void {
  // getTicketPaths can persist missing base-branch metadata, so check existence first.
  const ticketDir = resolveTicketContainedPath(ticketId, '.')
  if (!ticketDir || !lstatSync(ticketDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ContainedPathError('Ticket workspace not initialized')
  }
  if (!getTicketPaths(ticketId)) throw new Error('Ticket workspace not initialized')
}

export async function preparePlanningRestart(
  ticketId: string,
  targetApprovalStatus: 'WAITING_INTERVIEW_APPROVAL' | 'WAITING_PRD_APPROVAL',
  planningClaimToken?: string,
): Promise<PhaseRestartSummary> {
  if (planningClaimToken) assertPlanningEditClaim(ticketId, planningClaimToken)
  requireExistingTicketWorkspace(ticketId)
  const restartPhase = targetApprovalStatus === 'WAITING_INTERVIEW_APPROVAL'
    ? 'WAITING_INTERVIEW_APPROVAL'
    : 'WAITING_PRD_APPROVAL'
  const restartReason = targetApprovalStatus === 'WAITING_INTERVIEW_APPROVAL'
    ? 'interview_edit_restart'
    : 'prd_edit_restart'
  const phasesToArchive = targetApprovalStatus === 'WAITING_INTERVIEW_APPROVAL'
    ? INTERVIEW_EDIT_RESTART_PHASES
    : PRD_EDIT_RESTART_PHASES

  emitRoutePhaseLog(ticketId, restartPhase, 'info', 'Archiving downstream planning attempts and aborting active downstream work.')
  await cancelAndConfirmTicketSessions(ticketId)
  if (planningClaimToken) assertPlanningEditClaim(ticketId, planningClaimToken)
  clearContextCache(ticketId)
  ensureActivePhaseAttempt(ticketId, targetApprovalStatus)
  const archivedAttempts = archiveActivePhaseAttempts(ticketId, phasesToArchive, restartReason)
  const createdAttempts = createFreshPhaseAttempts(ticketId, phasesToArchive)

  ensureActorForTicket(ticketId)
  revertTicketToApprovalStatus(ticketId, targetApprovalStatus)

  return {
    reason: restartReason,
    archivedAttempts,
    createdAttempts,
  }
}

export async function prepareExecutionSetupPlanRestart(ticketId: string): Promise<PhaseRestartSummary> {
  requireExistingTicketWorkspace(ticketId)
  const restartReason = 'execution_setup_plan_regenerate'
  emitRoutePhaseLog(
    ticketId,
    'GENERATING_EXECUTION_SETUP_PLAN',
    'info',
    'Archiving the current workspace setup draft and approval attempt for versioned regeneration.',
  )
  await cancelAndConfirmTicketSessions(ticketId)
  clearContextCache(ticketId)
  ensureActivePhaseAttempt(ticketId, 'GENERATING_EXECUTION_SETUP_PLAN')
  ensureActivePhaseAttempt(ticketId, 'WAITING_EXECUTION_SETUP_APPROVAL')
  const archivedAttempts = archiveActivePhaseAttempts(ticketId, EXECUTION_SETUP_PLAN_RESTART_PHASES, restartReason)
  const createdAttempts = createFreshPhaseAttempts(ticketId, EXECUTION_SETUP_PLAN_RESTART_PHASES)
  ensureActorForTicket(ticketId)

  return {
    reason: restartReason,
    archivedAttempts,
    createdAttempts,
  }
}

export async function prepareExecutionSetupRuntimeRewind(ticketId: string): Promise<PhaseRestartSummary> {
  // Refuse an unsafe workspace before canceling work or archiving its attempts.
  requireExistingTicketWorkspace(ticketId)
  const restartReason = 'execution_setup_runtime_rewind'
  emitRoutePhaseLog(ticketId, 'WAITING_EXECUTION_SETUP_APPROVAL', 'info', 'Stopping workspace runtime setup and returning to setup-plan approval.')
  await cancelAndConfirmTicketSessions(ticketId)
  clearContextCache(ticketId)
  ensureActivePhaseAttempt(ticketId, 'GENERATING_EXECUTION_SETUP_PLAN')
  ensureActivePhaseAttempt(ticketId, 'WAITING_EXECUTION_SETUP_APPROVAL')
  ensureActivePhaseAttempt(ticketId, 'PREPARING_EXECUTION_ENV')
  const archivedAttempts = archiveActivePhaseAttempts(ticketId, EXECUTION_SETUP_RUNTIME_REWIND_PHASES, restartReason)
  const createdAttempts = createFreshPhaseAttempts(ticketId, ['WAITING_EXECUTION_SETUP_APPROVAL'])
  const removedFiles = clearExecutionSetupRuntimeArtifacts(ticketId, { preserveToolCache: true })
  if (removedFiles.length > 0) {
    emitRoutePhaseLog(ticketId, 'WAITING_EXECUTION_SETUP_APPROVAL', 'info', 'Cleared stale workspace runtime setup outputs after rewind.', {
      removedFiles,
      preserveToolCache: true,
    })
  }

  ensureActorForTicket(ticketId)
  // The route that requested this rewind will save the edited plan or start
  // the explicit regeneration. Avoid also auto-drafting from the empty attempt.
  revertTicketToApprovalStatus(ticketId, 'WAITING_EXECUTION_SETUP_APPROVAL', {
    skipInitialWorkflowRun: true,
  })

  return {
    reason: restartReason,
    archivedAttempts,
    createdAttempts,
  }
}

export async function prepareExecutionSetupRuntimeRegeneration(
  ticketId: string,
): Promise<PhaseRestartSummary> {
  requireExistingTicketWorkspace(ticketId)
  const restartReason = 'execution_setup_runtime_regenerate'
  emitRoutePhaseLog(
    ticketId,
    'GENERATING_EXECUTION_SETUP_PLAN',
    'info',
    'Stopping workspace runtime setup and starting a versioned workspace setup draft.',
  )
  await cancelAndConfirmTicketSessions(ticketId)
  clearContextCache(ticketId)
  ensureActivePhaseAttempt(ticketId, 'GENERATING_EXECUTION_SETUP_PLAN')
  ensureActivePhaseAttempt(ticketId, 'WAITING_EXECUTION_SETUP_APPROVAL')
  ensureActivePhaseAttempt(ticketId, 'PREPARING_EXECUTION_ENV')
  const archivedAttempts = archiveActivePhaseAttempts(
    ticketId,
    EXECUTION_SETUP_RUNTIME_REWIND_PHASES,
    restartReason,
  )
  const createdAttempts = createFreshPhaseAttempts(ticketId, EXECUTION_SETUP_PLAN_RESTART_PHASES)
  const removedFiles = clearExecutionSetupRuntimeArtifacts(ticketId, { preserveToolCache: true })
  if (removedFiles.length > 0) {
    emitRoutePhaseLog(
      ticketId,
      'GENERATING_EXECUTION_SETUP_PLAN',
      'info',
      'Cleared stale workspace runtime setup outputs before regeneration.',
      {
        removedFiles,
        preserveToolCache: true,
      },
    )
  }
  ensureActorForTicket(ticketId)

  return {
    reason: restartReason,
    archivedAttempts,
    createdAttempts,
  }
}

/**
 * Reads a JSON request body, distinguishing "empty" from "malformed".
 *
 * `c.req.json().catch(() => ({}))` collapses the two, so a body that is not
 * JSON at all arrives at a schema whose fields all have defaults, parses
 * cleanly, and the request proceeds as though nothing were sent. On a
 * destructive route that means the destructive part runs while the field the
 * caller actually sent is silently discarded.
 */
export async function readJsonBody(c: Context): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    const raw = await c.req.text()
    return { ok: true, body: raw.trim().length === 0 ? {} : JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}
