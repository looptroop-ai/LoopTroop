import type { Context } from 'hono'
import { z } from 'zod'
import { normalizeSettingSource, type TicketContext } from '../../machines/types'
import {
  getTicketByRef,
  type PublicTicket,
} from '../../storage/tickets'
import {
  performCoverageExtraFix,
  type CoverageExtraFixDomain,
} from '../../workflow/phases/verificationPhase'
import { getErrorMessage } from '@shared/typeGuards'
import {
  buildRouteStatePayload,
  emitRoutePhaseLog,
  getTicketParam,
  rejectDisplayOnlyMockTicket,
} from './routeUtils'

const fixCoverageGapsSchema = z.object({
  domain: z.enum(['prd', 'beads']),
})

const activeCoverageFixes = new Set<string>()

function coverageFixKey(ticketId: string, domain: CoverageExtraFixDomain): string {
  return `${ticketId}:${domain}`
}

export function isCoverageFixInProgress(ticketId: string, domain?: CoverageExtraFixDomain): boolean {
  if (domain) return activeCoverageFixes.has(coverageFixKey(ticketId, domain))
  return activeCoverageFixes.has(coverageFixKey(ticketId, 'prd'))
    || activeCoverageFixes.has(coverageFixKey(ticketId, 'beads'))
}

function buildMachineContextFromTicket(ticket: PublicTicket): TicketContext {
  return {
    ticketId: ticket.id,
    projectId: ticket.projectId,
    externalId: ticket.externalId,
    title: ticket.title,
    status: ticket.status,
    lockedMainImplementer: ticket.lockedMainImplementer,
    lockedMainImplementerVariant: ticket.lockedMainImplementerVariant,
    lockedCouncilMembers: ticket.lockedCouncilMembers,
    lockedCouncilMemberVariants: ticket.lockedCouncilMemberVariants,
    lockedInterviewQuestions: ticket.lockedInterviewQuestions,
    lockedCoverageFollowUpBudgetPercent: ticket.lockedCoverageFollowUpBudgetPercent,
    lockedMaxCoveragePasses: ticket.lockedMaxCoveragePasses,
    lockedMaxPrdCoveragePasses: ticket.lockedMaxPrdCoveragePasses,
    lockedMaxBeadsCoveragePasses: ticket.lockedMaxBeadsCoveragePasses,
    lockedStructuredRetryCount: ticket.lockedStructuredRetryCount,
    lockedManualQaEnabled: ticket.lockedManualQaEnabled,
    lockedManualQaSource: ticket.lockedManualQaSource === 'profile'
      || ticket.lockedManualQaSource === 'project'
      || ticket.lockedManualQaSource === 'ticket'
      ? ticket.lockedManualQaSource
      : null,
    lockedAiQuestionsEnabled: ticket.lockedAiQuestionsEnabled,
    lockedAiQuestionsSource: normalizeSettingSource(ticket.lockedAiQuestionsSource),
    lockedAiQuestionWindow: ticket.lockedAiQuestionWindow,
    lockedAiQuestionWindowSource: normalizeSettingSource(ticket.lockedAiQuestionWindowSource),
    pendingExecutionSetupPlanRequestArtifactId: null,
    previousStatus: ticket.previousStatus,
    error: ticket.errorMessage,
    errorCodes: ticket.errorOccurrences.at(-1)?.errorCodes ?? [],
    errorDiagnostics: ticket.errorOccurrences.at(-1)?.diagnostics ?? null,
    blockedErrorResolution: null,
    beadProgress: {
      total: ticket.runtime.totalBeads,
      completed: ticket.runtime.completedBeads,
      current: ticket.runtime.activeBeadId,
    },
    iterationCount: ticket.runtime.iterationCount,
    maxIterations: ticket.runtime.maxIterations ?? 0,
    councilResults: null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  }
}

function expectedApprovalStatus(domain: CoverageExtraFixDomain): 'WAITING_PRD_APPROVAL' | 'WAITING_BEADS_APPROVAL' {
  return domain === 'prd' ? 'WAITING_PRD_APPROVAL' : 'WAITING_BEADS_APPROVAL'
}

export async function handleFixCoverageGaps(c: Context) {
  const ticketId = getTicketParam(c)
  const parsed = fixCoverageGapsSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: 'Invalid coverage fix payload', details: parsed.error.flatten() }, 400)
  }

  const domain = parsed.data.domain
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const mockResponse = rejectDisplayOnlyMockTicket(c, ticket)
  if (mockResponse) return mockResponse

  const approvalStatus = expectedApprovalStatus(domain)
  if (ticket.status !== approvalStatus) {
    return c.json({ error: `Ticket is not waiting for ${domain === 'prd' ? 'PRD' : 'beads'} approval` }, 409)
  }

  const key = coverageFixKey(ticketId, domain)
  if (activeCoverageFixes.has(key)) {
    return c.json({ error: 'Coverage gap fix is already in progress' }, 409)
  }

  activeCoverageFixes.add(key)
  emitRoutePhaseLog(ticketId, approvalStatus, 'info', `Starting Extra Fix for ${domain.toUpperCase()} coverage gaps.`, {
    source: 'ai_fix_button',
    domain,
  })

  try {
    const result = await performCoverageExtraFix({
      ticketId,
      context: buildMachineContextFromTicket(ticket),
      domain,
      signal: c.req.raw.signal,
    })

    return c.json({
      message: result.noOp ? 'No open coverage gaps remain' : 'Coverage gaps fix completed',
      result,
      ...buildRouteStatePayload(ticketId),
    })
  } catch (err) {
    const details = getErrorMessage(err)
    emitRoutePhaseLog(ticketId, approvalStatus, 'error', `Coverage gap fix failed: ${details}`, {
      source: 'ai_fix_button',
      domain,
    })
    return c.json({
      error: 'Failed to fix coverage gaps',
      details,
    }, 500)
  } finally {
    activeCoverageFixes.delete(key)
  }
}
