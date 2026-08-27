import type { Context } from 'hono'
import { ensureActorForTicket, sendTicketEvent } from '../../machines/persistence'
import {
  findProjectExecutionBandConflict,
  getLatestPhaseArtifact,
  getTicketByRef,
  getTicketPaths,
  upsertLatestPhaseArtifact,
} from '../../storage/tickets'
import { approveInterviewDocument } from '../../phases/interview/finalDocument'
import {
  approvePrdDocument,
  buildDraftPrdDocumentFromRawContent,
  buildDraftPrdDocumentFromStructuredContent,
  readPrdDocument,
  saveApprovedPrdDocument,
  savePrdDocument,
} from '../../phases/prd/document'
import { approveBeadsDocument } from '../../phases/beads/document'
import {
  approveExecutionSetupPlan,
  readExecutionSetupPlan,
  saveExecutionSetupPlan,
} from '../../phases/executionSetupPlan/document'
import { lockExecutionSetupPlanDetectedHooks } from '../../phases/executionSetupPlan/hookEvidence'
import type { ExecutionSetupPlan } from '../../phases/executionSetupPlan/types'
import type { PrdDocument } from '../../structuredOutput/types'
import { isBeforeExecution, isStatusAtOrPast } from '@shared/workflowMeta'
import { getErrorMessage } from '@shared/typeGuards'
import { assertExpectedContentSha256, StaleArtifactApprovalError } from '../../lib/artifactApproval'
import { contentSha256 } from '../../lib/contentHash'
import { writeUserEditReceipt } from '../../workflow/artifactEditReceipts'
import { deriveSkipActionId, formatSkipReceiptLogLines, writeSkipReceipts } from '../../workflow/skipReceipts'
import { normalizeSkipReason } from '@shared/skipReceipt'
import {
  buildExecutionBandConflictMessage,
  buildRouteStatePayload,
  emitRoutePhaseLog,
  getTicketParam,
  preparePlanningRestart,
  rejectDisplayOnlyMockTicket,
  respondWithState,
} from './routeUtils'
import { approvalRequestSchema, rawPrdSaveSchema, structuredPrdSaveSchema } from './schemas'
import { isCoverageFixInProgress } from './coverageFixHandlers'
import { validateExecutionSetupWorkspaceInputs } from '../../phases/executionSetup/workspaceInputs'

function countPrdItems(document: PrdDocument): number {
  return document.epics.reduce((count, epic) => count + 1 + epic.user_stories.length, 0)
}

async function parseApprovalRequest(c: Context) {
  const body = await c.req.json().catch(() => ({}))
  return approvalRequestSchema.safeParse(body)
}

function staleApprovalResponse(c: Context, err: StaleArtifactApprovalError) {
  return c.json({
    error: 'Stale approval',
    artifactType: err.artifactType,
    expectedContentSha256: err.expectedContentSha256,
    currentContentSha256: err.currentContentSha256,
  }, 409)
}

export async function handleApproveTicket(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse

  const approvalStates = ['WAITING_INTERVIEW_APPROVAL', 'WAITING_PRD_APPROVAL', 'WAITING_BEADS_APPROVAL', 'WAITING_EXECUTION_SETUP_APPROVAL']
  if (!approvalStates.includes(ticket.status)) {
    return c.json({ error: 'Ticket is not in an approval state' }, 409)
  }

  const parsed = await parseApprovalRequest(c)
  if (!parsed.success) {
    return c.json({ error: 'Invalid approval payload', details: parsed.error.flatten() }, 400)
  }
  const expectedContentSha256 = parsed.data.expectedContentSha256
  const gapAcknowledgementReason = parsed.data.gapAcknowledgementReason

  if (ticket.status === 'WAITING_INTERVIEW_APPROVAL') {
    return approveInterviewForRoute(c, ticketId, expectedContentSha256, gapAcknowledgementReason)
  }
  if (ticket.status === 'WAITING_PRD_APPROVAL') {
    return approvePrdForRoute(c, ticketId, expectedContentSha256, gapAcknowledgementReason)
  }
  if (ticket.status === 'WAITING_BEADS_APPROVAL') {
    return approveBeadsForRoute(c, ticketId, expectedContentSha256, gapAcknowledgementReason)
  }
  if (ticket.status === 'WAITING_EXECUTION_SETUP_APPROVAL') {
    return approveExecutionSetupPlanForRoute(c, ticketId, expectedContentSha256)
  }

  try {
    ensureActorForTicket(ticketId)
    sendTicketEvent(ticketId, { type: 'APPROVE' })
  } catch (err) {
    console.error(`[tickets] Failed to send APPROVE to ticket ${ticketId}:`, err)
    return c.json({ error: 'Failed to approve ticket', details: String(err) }, 500)
  }

  return respondWithState(c, ticketId, 'Approve action accepted')
}

export async function handlePutPrd(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (!isStatusAtOrPast(ticket.status, 'WAITING_PRD_APPROVAL') || !isBeforeExecution(ticket.status, ticket.previousStatus)) {
    return c.json({ error: 'Ticket is not in a state where PRD can be edited' }, 409)
  }

  const body = await c.req.json().catch(() => ({}))
  const rawParsed = rawPrdSaveSchema.safeParse(body)
  if (rawParsed.success) {
    let beforeRaw: string | null = null
    let beforeItemCount: number | null = null
    try {
      const before = readPrdDocument(ticketId)
      beforeRaw = before.raw
      beforeItemCount = countPrdItems(before.document)
    } catch {
      beforeRaw = null
    }

    let document: PrdDocument
    try {
      document = buildDraftPrdDocumentFromRawContent(ticketId, rawParsed.data.content)
    } catch (err) {
      return c.json({
        error: 'Failed to save PRD document',
        details: getErrorMessage(err),
      }, 400)
    }

    try {
      const shouldRestart = ticket.status !== 'WAITING_PRD_APPROVAL'
      let restart: Awaited<ReturnType<typeof preparePlanningRestart>> | null = null
      let result: ReturnType<typeof savePrdDocument>
      if (ticket.status !== 'WAITING_PRD_APPROVAL') {
        restart = await preparePlanningRestart(ticketId, 'WAITING_PRD_APPROVAL')
        result = saveApprovedPrdDocument(ticketId, document)
        emitRoutePhaseLog(ticketId, 'WAITING_PRD_APPROVAL', 'info', 'PRD edit saved and approved. Restarting Beads planning from the edited PRD.')
        sendTicketEvent(ticketId, { type: 'APPROVE' })
        writeUserEditReceipt({
          ticketId,
          artifactType: 'prd',
          phase: 'WAITING_PRD_APPROVAL',
          action: shouldRestart ? 'save_and_restart' : 'save',
          editSurface: 'raw',
          statusBeforeEdit: ticket.status,
          statusAfterEdit: getTicketByRef(ticketId)?.status ?? null,
          beforeRaw,
          afterRaw: result.raw,
          beforeItemCount,
          afterItemCount: countPrdItems(result.document),
          restart,
          invalidation: result.invalidation,
        })
        return c.json({
          success: true,
          content: result.raw,
          contentSha256: contentSha256(result.raw),
          ...buildRouteStatePayload(ticketId),
        })
      }
      result = savePrdDocument(ticketId, document)
      writeUserEditReceipt({
        ticketId,
        artifactType: 'prd',
        phase: 'WAITING_PRD_APPROVAL',
        action: shouldRestart ? 'save_and_restart' : 'save',
        editSurface: 'raw',
        statusBeforeEdit: ticket.status,
        statusAfterEdit: getTicketByRef(ticketId)?.status ?? null,
        beforeRaw,
        afterRaw: result.raw,
        beforeItemCount,
        afterItemCount: countPrdItems(result.document),
        restart,
        invalidation: result.invalidation,
      })
      return c.json({
        success: true,
        content: result.raw,
        contentSha256: contentSha256(result.raw),
        ...buildRouteStatePayload(ticketId),
      })
    } catch (err) {
      return c.json({
        error: 'Failed to save PRD document',
        details: getErrorMessage(err),
      }, 400)
    }
  }

  const structuredParsed = structuredPrdSaveSchema.safeParse(body)
  if (!structuredParsed.success) {
    return c.json({ error: 'Invalid PRD document payload', details: structuredParsed.error.flatten() }, 400)
  }

  let beforeRaw: string | null = null
  let beforeItemCount: number | null = null
  try {
    const before = readPrdDocument(ticketId)
    beforeRaw = before.raw
    beforeItemCount = countPrdItems(before.document)
  } catch {
    beforeRaw = null
  }

  let document: PrdDocument
  try {
    document = buildDraftPrdDocumentFromStructuredContent(ticketId, structuredParsed.data.document)
  } catch (err) {
    return c.json({
      error: 'Failed to save PRD document',
      details: getErrorMessage(err),
    }, 400)
  }

  try {
    const shouldRestart = ticket.status !== 'WAITING_PRD_APPROVAL'
    let restart: Awaited<ReturnType<typeof preparePlanningRestart>> | null = null
    let result: ReturnType<typeof savePrdDocument>
    if (ticket.status !== 'WAITING_PRD_APPROVAL') {
      restart = await preparePlanningRestart(ticketId, 'WAITING_PRD_APPROVAL')
      result = saveApprovedPrdDocument(ticketId, document)
      emitRoutePhaseLog(ticketId, 'WAITING_PRD_APPROVAL', 'info', 'PRD edit saved and approved. Restarting Beads planning from the edited PRD.')
      sendTicketEvent(ticketId, { type: 'APPROVE' })
      writeUserEditReceipt({
        ticketId,
        artifactType: 'prd',
        phase: 'WAITING_PRD_APPROVAL',
        action: shouldRestart ? 'save_and_restart' : 'save',
        editSurface: 'structured',
        statusBeforeEdit: ticket.status,
        statusAfterEdit: getTicketByRef(ticketId)?.status ?? null,
        beforeRaw,
        afterRaw: result.raw,
        beforeItemCount,
        afterItemCount: countPrdItems(result.document),
        restart,
        invalidation: result.invalidation,
      })
      return c.json({
        success: true,
        content: result.raw,
        contentSha256: contentSha256(result.raw),
        ...buildRouteStatePayload(ticketId),
      })
    }
    result = savePrdDocument(ticketId, document)
    writeUserEditReceipt({
      ticketId,
      artifactType: 'prd',
      phase: 'WAITING_PRD_APPROVAL',
      action: shouldRestart ? 'save_and_restart' : 'save',
      editSurface: 'structured',
      statusBeforeEdit: ticket.status,
      statusAfterEdit: getTicketByRef(ticketId)?.status ?? null,
      beforeRaw,
      afterRaw: result.raw,
      beforeItemCount,
      afterItemCount: countPrdItems(result.document),
      restart,
      invalidation: result.invalidation,
    })
    return c.json({
      success: true,
      content: result.raw,
      contentSha256: contentSha256(result.raw),
      ...buildRouteStatePayload(ticketId),
    })
  } catch (err) {
    return c.json({
      error: 'Failed to save PRD document',
      details: getErrorMessage(err),
    }, 400)
  }
}

/**
 * Records why the operator approved despite known coverage gaps.
 *
 * The reason goes onto the existing `approval_receipt` — which is the domain
 * record of the approval, and where anyone reading the approval will look — and
 * into the append-only skip trail. Read-modify-write on the receipt rather than
 * a new parameter through four document modules: `upsertLatestPhaseArtifact`
 * updates the row the approval just wrote, so there is exactly one receipt
 * either way.
 */
function recordGapAcknowledgement(input: {
  ticketId: string
  phase: string
  ticketStatusBefore: string
  artifactType: 'interview' | 'prd' | 'beads' | 'execution_setup_plan'
  reason: string | undefined
}): void {
  const reason = normalizeSkipReason(input.reason)
  if (!reason) return

  const receipt = getLatestPhaseArtifact(input.ticketId, 'approval_receipt', input.phase)
  if (receipt) {
    try {
      const parsed = JSON.parse(receipt.content) as Record<string, unknown>
      upsertLatestPhaseArtifact(input.ticketId, 'approval_receipt', input.phase, JSON.stringify({
        ...parsed,
        gap_acknowledgement: { reason },
      }))
    } catch {
      // A receipt this build cannot parse is not worth failing an approval over;
      // the skip trail below still records the reason.
    }
  }

  // The approval is already persisted by the time this runs, and the APPROVE
  // event has not been sent yet. Letting a receipt write throw would return 500
  // and strand the ticket: approved on disk, still sitting in the approval
  // state. Recording why something happened must never undo it.
  try {
    const receipts = writeSkipReceipts({
      ticketId: input.ticketId,
      surface: 'approval_with_gaps',
      itemType: 'approval',
      phase: input.phase,
      ticketStatusBefore: input.ticketStatusBefore,
      actionId: deriveSkipActionId('approval_with_gaps', [input.ticketId, input.phase, input.artifactType, reason]),
      items: [{ itemId: input.artifactType, reason }],
    })
    for (const line of formatSkipReceiptLogLines(receipts)) {
      emitRoutePhaseLog(input.ticketId, input.phase, 'info', line)
    }
  } catch (err) {
    console.error(`[tickets] Failed to record the gap acknowledgement for ${input.ticketId}:`, err)
  }
}

export async function handleApproveInterview(c: Context) {
  const ticketId = getTicketParam(c)
  const parsed = await parseApprovalRequest(c)
  if (!parsed.success) {
    return c.json({ error: 'Invalid approval payload', details: parsed.error.flatten() }, 400)
  }
  return approveInterviewForRoute(c, ticketId, parsed.data.expectedContentSha256, parsed.data.gapAcknowledgementReason)
}

function approveInterviewForRoute(c: Context, ticketId: string, expectedContentSha256: string, gapAcknowledgementReason?: string) {
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (ticket.status !== 'WAITING_INTERVIEW_APPROVAL') {
    return c.json({ error: 'Ticket is not waiting for interview approval' }, 409)
  }

  try {
    approveInterviewDocument(ticketId, expectedContentSha256)
    ensureActorForTicket(ticketId)

    const phase = 'WAITING_INTERVIEW_APPROVAL'
    emitRoutePhaseLog(ticketId, phase, 'info', 'Interview approved by user.')
    recordGapAcknowledgement({
      ticketId,
      phase,
      ticketStatusBefore: ticket.status,
      artifactType: 'interview',
      reason: gapAcknowledgementReason,
    })

    sendTicketEvent(ticketId, { type: 'APPROVE' })
  } catch (err) {
    if (err instanceof StaleArtifactApprovalError) return staleApprovalResponse(c, err)
    console.error(`[tickets] Failed to approve interview for ${ticketId}:`, err)
    return c.json({
      error: 'Failed to approve interview',
      details: getErrorMessage(err),
    }, 500)
  }

  return respondWithState(c, ticketId, 'Interview approved')
}

export async function handleApprovePrd(c: Context) {
  const ticketId = getTicketParam(c)
  const parsed = await parseApprovalRequest(c)
  if (!parsed.success) {
    return c.json({ error: 'Invalid approval payload', details: parsed.error.flatten() }, 400)
  }
  return approvePrdForRoute(c, ticketId, parsed.data.expectedContentSha256, parsed.data.gapAcknowledgementReason)
}

function approvePrdForRoute(c: Context, ticketId: string, expectedContentSha256: string, gapAcknowledgementReason?: string) {
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (ticket.status !== 'WAITING_PRD_APPROVAL') {
    return c.json({ error: 'Ticket is not waiting for PRD approval' }, 409)
  }
  if (isCoverageFixInProgress(ticketId, 'prd')) {
    return c.json({ error: 'Coverage gap fix is in progress' }, 409)
  }

  try {
    approvePrdDocument(ticketId, expectedContentSha256)
    ensureActorForTicket(ticketId)

    const phase = 'WAITING_PRD_APPROVAL'
    emitRoutePhaseLog(ticketId, phase, 'info', 'PRD approved by user.')
    recordGapAcknowledgement({
      ticketId,
      phase,
      ticketStatusBefore: ticket.status,
      artifactType: 'prd',
      reason: gapAcknowledgementReason,
    })

    sendTicketEvent(ticketId, { type: 'APPROVE' })
  } catch (err) {
    if (err instanceof StaleArtifactApprovalError) return staleApprovalResponse(c, err)
    console.error(`[tickets] Failed to approve PRD for ${ticketId}:`, err)
    return c.json({
      error: 'Failed to approve PRD',
      details: getErrorMessage(err),
    }, 500)
  }

  return respondWithState(c, ticketId, 'PRD approved')
}

export async function handleApproveBeads(c: Context) {
  const ticketId = getTicketParam(c)
  const parsed = await parseApprovalRequest(c)
  if (!parsed.success) {
    return c.json({ error: 'Invalid approval payload', details: parsed.error.flatten() }, 400)
  }
  return approveBeadsForRoute(c, ticketId, parsed.data.expectedContentSha256, parsed.data.gapAcknowledgementReason)
}

function approveBeadsForRoute(c: Context, ticketId: string, expectedContentSha256: string, gapAcknowledgementReason?: string) {
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (ticket.status !== 'WAITING_BEADS_APPROVAL') {
    return c.json({ error: 'Ticket is not waiting for beads approval' }, 409)
  }
  if (isCoverageFixInProgress(ticketId, 'beads')) {
    return c.json({ error: 'Coverage gap fix is in progress' }, 409)
  }

  const executionConflict = findProjectExecutionBandConflict(ticket.projectId, ticket.id)
  if (executionConflict) {
    return c.json({ error: buildExecutionBandConflictMessage(ticket, executionConflict) }, 409)
  }

  try {
    approveBeadsDocument(ticketId, expectedContentSha256)
    ensureActorForTicket(ticketId)

    const phase = 'WAITING_BEADS_APPROVAL'
    emitRoutePhaseLog(ticketId, phase, 'info', 'Beads approved by user.')
    recordGapAcknowledgement({
      ticketId,
      phase,
      ticketStatusBefore: ticket.status,
      artifactType: 'beads',
      reason: gapAcknowledgementReason,
    })

    sendTicketEvent(ticketId, { type: 'APPROVE' })
  } catch (err) {
    if (err instanceof StaleArtifactApprovalError) return staleApprovalResponse(c, err)
    console.error(`[tickets] Failed to approve beads for ${ticketId}:`, err)
    return c.json({
      error: 'Failed to approve beads',
      details: getErrorMessage(err),
    }, 500)
  }

  return respondWithState(c, ticketId, 'Beads approved')
}

export async function handleApproveExecutionSetupPlan(c: Context) {
  const ticketId = getTicketParam(c)
  const parsed = await parseApprovalRequest(c)
  if (!parsed.success) {
    return c.json({ error: 'Invalid approval payload', details: parsed.error.flatten() }, 400)
  }
  return approveExecutionSetupPlanForRoute(c, ticketId, parsed.data.expectedContentSha256)
}

function approveExecutionSetupPlanForRoute(c: Context, ticketId: string, expectedContentSha256: string) {
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse
  if (ticket.status !== 'WAITING_EXECUTION_SETUP_APPROVAL') {
    return c.json({ error: 'Ticket is not waiting for execution setup plan approval' }, 409)
  }

  const executionConflict = findProjectExecutionBandConflict(ticket.projectId, ticket.id)
  if (executionConflict) {
    return c.json({ error: buildExecutionBandConflictMessage(ticket, executionConflict) }, 409)
  }

  let plan: ExecutionSetupPlan | null = null
  try {
    const current = readExecutionSetupPlan(ticketId)
    plan = current.plan
    if (!plan) {
      return c.json({ error: 'Execution setup plan is not ready yet' }, 409)
    }
    if (!current.raw) {
      return c.json({ error: 'Execution setup plan is not ready yet' }, 409)
    }
    assertExpectedContentSha256({
      artifactType: 'execution_setup_plan',
      currentContent: current.raw,
      expectedContentSha256,
    })

    const refreshedPlan = lockExecutionSetupPlanDetectedHooks(ticketId, plan)
    const evidenceChanged = JSON.stringify({
      hostContext: refreshedPlan.hostContext,
      policy: refreshedPlan.gitHooks.policy,
      detected: refreshedPlan.gitHooks.detected,
    }) !== JSON.stringify({
      hostContext: plan.hostContext,
      policy: plan.gitHooks.policy,
      detected: plan.gitHooks.detected,
    })
    if (evidenceChanged) {
      const refreshed = saveExecutionSetupPlan(ticketId, refreshedPlan)
      emitRoutePhaseLog(
        ticketId,
        'WAITING_EXECUTION_SETUP_APPROVAL',
        'info',
        'Current host or Git-hook evidence changed before approval; review the refreshed plan.',
      )
      return c.json({
        error: 'Workspace evidence changed before approval. Review the refreshed plan and approve its new hash.',
        contentSha256: refreshed.contentSha256,
        plan: refreshed.plan,
      }, 409)
    }

    const paths = getTicketPaths(ticketId)
    if (!paths) return c.json({ error: 'Ticket workspace could not be resolved' }, 409)
    plan.workspaceInputs = validateExecutionSetupWorkspaceInputs({
      projectRoot: paths.projectRoot,
      worktreePath: paths.worktreePath,
      workspaceInputs: plan.workspaceInputs,
    })
    approveExecutionSetupPlan(ticketId, plan, current.raw, expectedContentSha256)
    ensureActorForTicket(ticketId)

    const phase = 'WAITING_EXECUTION_SETUP_APPROVAL'
    emitRoutePhaseLog(ticketId, phase, 'info', 'Execution setup plan approved by user.')

    sendTicketEvent(ticketId, { type: 'APPROVE_EXECUTION_SETUP_PLAN' })
  } catch (err) {
    if (err instanceof StaleArtifactApprovalError) return staleApprovalResponse(c, err)
    console.error(`[tickets] Failed to approve execution setup plan for ${ticketId}:`, err)
    return c.json({
      error: 'Failed to approve execution setup plan',
      details: getErrorMessage(err),
    }, 500)
  }

  return respondWithState(c, ticketId, 'Execution setup plan approved')
}
