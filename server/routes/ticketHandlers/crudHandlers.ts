import type { Context } from 'hono'
import {
  createTicketActor,
  ensureActorForTicket,
  sendTicketEvent,
  stopActor,
} from '../../machines/persistence'
import { abortTicketSessions } from '../../opencode/sessionManager'
import { clearContextCache } from '../../opencode/contextBuilder'
import { broadcaster } from '../../sse/broadcaster'
import { cancelTicket } from '../../workflow/runner'
import { withCommandLoggingAsync } from '../../log/commandLogger'
import { getProjectContextById } from '../../storage/projects'
import {
  createTicket as createTicketRecord,
  deleteTicket as deleteStoredTicket,
  getTicketByRef,
  getTicketContext,
  listTickets,
  updateTicket,
} from '../../storage/tickets'
import {
  completeMergedPullRequest,
  readPullRequestReport,
  refreshPullRequestReport,
  refreshPullRequestState,
  type PullRequestReport,
} from '../../workflow/phases/pullRequestPhase'
import { getErrorMessage } from '@shared/typeGuards'
import { isTerminalWorkflowStatus } from '@shared/workflowMeta'
import {
  emitRoutePhaseLog,
  getProfileDefaults,
  getRequiredRouteParam,
  getTicketParam,
  logTicketOperationError,
} from './routeUtils'
import { createTicketSchema, updateTicketSchema } from './schemas'
import { resolveStoredWorkflowPhase } from '@shared/workflowMeta'

export function handleListTickets(c: Context) {
  const projectId = c.req.query('project') ?? c.req.query('projectId')
  const parsedProjectId = projectId ? Number(projectId) : undefined
  if (projectId && Number.isNaN(parsedProjectId)) {
    return c.json({ error: 'Invalid project ID' }, 400)
  }
  return c.json(listTickets(parsedProjectId))
}

function updatePullRequestReportFromLiveState(
  ticketId: string,
  existing: PullRequestReport,
  pr: NonNullable<Awaited<ReturnType<typeof refreshPullRequestState>>>,
) {
  refreshPullRequestReport(ticketId, {
    ...existing,
    completedAt: new Date().toISOString(),
    prNumber: pr.number,
    prUrl: pr.url,
    prState: pr.state,
    prHeadSha: pr.headRefOid,
    title: existing.title ?? pr.title,
    body: existing.body,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    message: existing.message,
  })
}

async function syncWaitingPullRequestTicket(ticketId: string) {
  const current = getTicketByRef(ticketId)
  if (!current || current.status !== 'WAITING_PR_REVIEW') return current

  const ticketContext = getTicketContext(ticketId)
  const prReport = readPullRequestReport(ticketId)
  if (!ticketContext || !prReport) return current

  const headBranch = current.branchName?.trim() || current.externalId
  const baseBranch = current.runtime.baseBranch

  try {
    const livePr = await refreshPullRequestState(ticketContext.projectRoot, headBranch, baseBranch)
    if (!livePr) return current

    if (livePr.state !== prReport.prState || livePr.headRefOid !== prReport.prHeadSha) {
      updatePullRequestReportFromLiveState(ticketId, prReport, livePr)
    }

    if (livePr.state === 'merged') {
      const mergeReport = await withCommandLoggingAsync(
        ticketId,
        current.externalId,
        'WAITING_PR_REVIEW',
        () => completeMergedPullRequest({
          ticketId,
          externalId: current.externalId,
          projectPath: ticketContext.projectRoot,
          baseBranch,
          headBranch,
          candidateCommitSha: current.runtime.candidateCommitSha,
          prReport: {
            ...prReport,
            prNumber: livePr.number,
            prUrl: livePr.url,
            prState: livePr.state,
            prHeadSha: livePr.headRefOid,
            createdAt: livePr.createdAt,
            updatedAt: livePr.updatedAt,
            mergedAt: livePr.mergedAt,
            closedAt: livePr.closedAt,
          },
          skipRemoteMerge: true,
        }),
        (phase, type, content) => emitRoutePhaseLog(ticketId, phase, type, content),
      )

      emitRoutePhaseLog(ticketId, 'WAITING_PR_REVIEW', 'info', mergeReport.message, {
        prNumber: mergeReport.prNumber,
        prUrl: mergeReport.prUrl,
      })

      const fresh = getTicketByRef(ticketId)
      if (fresh && fresh.status === 'WAITING_PR_REVIEW') {
        ensureActorForTicket(ticketId)
        sendTicketEvent(ticketId, { type: 'MERGE_COMPLETE' })
      }
      return getTicketByRef(ticketId) ?? current
    }
  } catch (err) {
    // Advisory only. This runs on a routine UI poll of GET /tickets/:id, and it
    // used to dispatch ERROR here — so a transient GitHub outage, a rate limit
    // or a slow `gh` moved the ticket to BLOCKED_ERROR. A read request could
    // brick a ticket, and the ticket was fine: the next poll would have
    // succeeded. The failure is worth recording and nothing more.
    emitRoutePhaseLog(
      ticketId,
      'WAITING_PR_REVIEW',
      'info',
      `Pull request sync could not reach GitHub and will retry on the next poll: ${getErrorMessage(err)}`,
    )
  }

  return getTicketByRef(ticketId) ?? current
}

export async function handleGetTicket(c: Context) {
  const ticketId = getRequiredRouteParam(c, 'id')
  const ticket = await syncWaitingPullRequestTicket(ticketId) ?? getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  return c.json(ticket)
}

export async function handleCreateTicket(c: Context) {
  const body = await c.req.json()
  const parsed = createTicketSchema.safeParse(body)
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors
    const message = Object.entries(fieldErrors)
      .map(([field, errors]) => `${field}: ${(errors as string[]).join(', ')}`)
      .join('; ')
    return c.json({ error: 'Invalid input', details: parsed.error.flatten(), message }, 400)
  }

  let result: ReturnType<typeof createTicketRecord>
  try {
    result = createTicketRecord(parsed.data)
  } catch (err) {
    if (err instanceof Error && err.message === 'Project not found') {
      return c.json({ error: 'Project not found' }, 404)
    }
    if (err instanceof Error && err.message.startsWith('Invalid createTicket input:')) {
      return c.json({ error: 'Invalid input', message: err.message }, 400)
    }
    return c.json({ error: 'Failed to create ticket', details: getErrorMessage(err) }, 500)
  }

  const projectContext = getProjectContextById(result.projectId)
  const profile = getProfileDefaults()
  createTicketActor(result.id, {
    ticketId: result.id,
    projectId: result.projectId,
    externalId: result.externalId,
    title: result.title,
    maxIterations: projectContext?.project.maxIterations ?? profile?.maxIterations ?? undefined,
  })

  return c.json(getTicketByRef(result.id) ?? result, 201)
}

export async function handlePatchTicket(c: Context) {
  const ticketId = getTicketParam(c)
  const body = await c.req.json()

  if ('status' in body) {
    return c.json({ error: 'Status field is API-protected. Use workflow actions to change status.' }, 403)
  }

  const parsed = updateTicketSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.flatten() }, 400)
  }

  const existing = getTicketByRef(ticketId)
  if (!existing) return c.json({ error: 'Ticket not found' }, 404)

  try {
    const result = updateTicket(ticketId, parsed.data)
    return c.json(result ?? existing)
  } catch (err) {
    if (err instanceof Error && err.message.includes('only be changed while the ticket is in DRAFT')) {
      return c.json({ error: err.message }, 409)
    }
    throw err
  }
}

export async function handleDeleteTicket(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  if (!isTerminalWorkflowStatus(ticket.status)) {
    return c.json({ error: 'Only completed or canceled tickets can be deleted' }, 409)
  }

  try {
    cancelTicket(ticketId)
    stopActor(ticketId)
    await abortTicketSessions(ticketId)
    clearContextCache(ticketId)

    emitRoutePhaseLog(ticketId, resolveStoredWorkflowPhase(ticket.status), 'info', `Deleting ticket ${ticket.externalId}: removing worktree, branch, and database records.`)
    const deleted = deleteStoredTicket(ticketId)
    if (!deleted) return c.json({ error: 'Ticket not found' }, 404)

    broadcaster.clearTicket(ticketId)
    return c.json({ success: true, ticketId })
  } catch (err) {
    logTicketOperationError(ticketId, 'Failed to delete ticket', err)
    return c.json({ error: 'Failed to delete ticket', details: getErrorMessage(err) }, 500)
  }
}
