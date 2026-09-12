import { isRecord } from '@shared/typeGuards'
import { ensureActorForTicket, sendTicketEvent } from '../machines/persistence'
import { withCommandLoggingAsync } from '../log/commandLogger'
import { emitRoutePhaseLog } from '../routes/ticketHandlers/routeUtils'
import { getLatestPhaseArtifact, getTicketByRef, getTicketContext, isDisplayOnlyMockTicket, type PublicTicket } from '../storage/tickets'
import {
  completeMergedPullRequest,
  readPullRequestReport,
  refreshPullRequestReport,
  refreshPullRequestState,
  type PullRequestReport,
} from './phases/pullRequestPhase'

const pending = new Map<string, Promise<unknown>>()

/** Non-reentrant, process-local lock for one daemon; callers must not acquire it twice. */
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

/** A successful report for this attempt is the checkpoint before the workflow event. */
export function hasVerifiedMergeReport(ticket: PublicTicket): boolean {
  const artifact = getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')
  if (!artifact) return false
  try {
    const report: unknown = JSON.parse(artifact.content)
    return isRecord(report)
      && report.status === 'passed' && report.disposition === 'merged' && report.prState === 'merged'
      && typeof report.baseBranch === 'string' && report.baseBranch.length > 0
      && report.baseBranch === ticket.runtime.baseBranch
      && report.headBranch === (ticket.branchName?.trim() || ticket.externalId)
      && typeof report.candidateCommitSha === 'string' && report.candidateCommitSha.length > 0
      && report.candidateCommitSha === ticket.runtime.candidateCommitSha
      && typeof report.prNumber === 'number' && Number.isInteger(report.prNumber) && report.prNumber > 0
      && typeof report.remoteBaseHead === 'string' && report.remoteBaseHead.length > 0
  } catch {
    return false
  }
}

function resumeVerifiedMerge(ticket: PublicTicket): boolean {
  if (!hasVerifiedMergeReport(ticket)) return false
  ensureActorForTicket(ticket.id)
  emitRoutePhaseLog(ticket.id, 'WAITING_PR_REVIEW', 'info', 'Resuming completion of the verified pull request merge.')
  sendTicketEvent(ticket.id, { type: 'MERGE_COMPLETE' })
  return true
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
  if (resumeVerifiedMerge(ticket)) return
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
  const current = getTicketByRef(ticketId)
  if (!current) return
  if (current.status !== phase) {
    emitRoutePhaseLog(ticketId, phase, 'info', `Pull request merge verified; ticket already moved to ${current.status}.`)
    return
  }
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

export async function syncWaitingPullRequestTicket(ticketId: string): Promise<void> {
  // Recover a committed result before contacting GitHub, including while it is unavailable.
  const input = await withTicketMergeLock(ticketId, async () => {
    const ticket = getTicketByRef(ticketId)
    if (!ticket || ticket.status !== 'WAITING_PR_REVIEW' || isDisplayOnlyMockTicket(ticket)) return null
    if (resumeVerifiedMerge(ticket)) return null
    const context = getTicketContext(ticketId)
    const report = readPullRequestReport(ticketId)
    if (!context || !report) throw new Error('Waiting pull request ticket is missing its workspace or pull request report.')
    return { ticket, report, projectRoot: context.projectRoot }
  })
  if (!input) return
  // Remote reads do not hold up Cancel or Close. Revalidate before any write.
  const pr = await refreshPullRequestState(
    input.projectRoot,
    input.ticket.branchName?.trim() || input.ticket.externalId,
    input.ticket.runtime.baseBranch,
  )
  if (!pr) return
  await withTicketMergeLock(ticketId, async () => {
    const ticket = getTicketByRef(ticketId)
    if (!ticket || ticket.status !== 'WAITING_PR_REVIEW' || isDisplayOnlyMockTicket(ticket)) return
    if (resumeVerifiedMerge(ticket)) return
    const report = readPullRequestReport(ticketId)
    if (!report || report.prNumber !== input.report.prNumber
      || ticket.branchName !== input.ticket.branchName
      || ticket.runtime.baseBranch !== input.ticket.runtime.baseBranch
      || ticket.runtime.candidateCommitSha !== input.ticket.runtime.candidateCommitSha) return
    const updatedReport = {
      ...report,
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
      await completeTicketMerge(ticket, input.projectRoot, updatedReport, true)
    }
  })
}
