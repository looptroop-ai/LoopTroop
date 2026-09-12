import { ensureActorForTicket, sendTicketEvent } from '../machines/persistence'
import { withCommandLoggingAsync } from '../log/commandLogger'
import { emitRoutePhaseLog } from '../routes/ticketHandlers/routeUtils'
import { getTicketByRef, getTicketContext, isDisplayOnlyMockTicket, type PublicTicket } from '../storage/tickets'
import {
  completeMergedPullRequest,
  readPullRequestReport,
  refreshPullRequestReport,
  refreshPullRequestState,
  type PullRequestReport,
} from './phases/pullRequestPhase'

const pending = new Map<string, Promise<unknown>>()

/** Serialize merge, external-merge detection, close and cancel for one ticket. */
export async function withTicketMergeLock<T>(ticketId: string, operation: () => Promise<T>): Promise<T> {
  const key = getTicketByRef(ticketId)?.id ?? ticketId
  const previous = pending.get(key)
  const current = (previous ?? Promise.resolve()).catch(() => undefined).then(operation)
  pending.set(key, current)
  try {
    return await current
  } finally {
    if (pending.get(key) === current) pending.delete(key)
  }
}

/** Called under the ticket lock by both the Merge action and background detection. */
export async function completeTicketMerge(
  ticket: PublicTicket,
  projectRoot: string,
  prReport: PullRequestReport,
  skipRemoteMerge = false,
): Promise<void> {
  const ticketId = ticket.id
  const phase = 'WAITING_PR_REVIEW'
  const mergeReport = await withCommandLoggingAsync(
    ticketId,
    ticket.externalId,
    phase,
    () => completeMergedPullRequest({
      ticketId,
      externalId: ticket.externalId,
      projectPath: projectRoot,
      baseBranch: ticket.runtime.baseBranch,
      headBranch: ticket.branchName?.trim() || ticket.externalId,
      candidateCommitSha: ticket.runtime.candidateCommitSha,
      prReport,
      skipRemoteMerge,
    }),
    (cmdPhase, type, content) => emitRoutePhaseLog(ticketId, cmdPhase, type, content),
  )
  if (getTicketByRef(ticketId)?.status !== phase) return
  ensureActorForTicket(ticketId)
  emitRoutePhaseLog(ticketId, phase, 'info', mergeReport.message, {
    prNumber: mergeReport.prNumber,
    prUrl: mergeReport.prUrl,
    prState: mergeReport.prState,
    localBaseHead: mergeReport.localBaseHead,
    remoteBaseHead: mergeReport.remoteBaseHead,
  })
  sendTicketEvent(ticketId, { type: 'MERGE_COMPLETE' })
}

export function syncWaitingPullRequestTicket(ticketId: string): Promise<void> {
  return withTicketMergeLock(ticketId, async () => {
    const ticket = getTicketByRef(ticketId)
    if (!ticket || ticket.status !== 'WAITING_PR_REVIEW' || isDisplayOnlyMockTicket(ticket)) return
    const context = getTicketContext(ticketId)
    const report = readPullRequestReport(ticketId)
    if (!context || !report) return
    const pr = await refreshPullRequestState(
      context.projectRoot,
      ticket.branchName?.trim() || ticket.externalId,
      ticket.runtime.baseBranch,
    )
    if (!pr || getTicketByRef(ticketId)?.status !== 'WAITING_PR_REVIEW') return
    const updatedReport = {
      ...report,
      completedAt: new Date().toISOString(),
      prNumber: pr.number,
      prUrl: pr.url,
      prState: pr.state,
      prHeadSha: pr.headRefOid,
      title: report.title ?? pr.title,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
    }
    if (pr.state !== report.prState || pr.headRefOid !== report.prHeadSha) {
      refreshPullRequestReport(ticketId, updatedReport)
    }
    if (pr.state === 'merged') {
      await completeTicketMerge(ticket, context.projectRoot, updatedReport, true)
    }
  })
}
