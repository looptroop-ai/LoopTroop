import { isRecord } from '@shared/typeGuards'
import { ensureActorForTicket, sendTicketEvent } from '../machines/persistence'
import { withCommandLoggingAsync } from '../log/commandLogger'
import { emitRoutePhaseLog } from '../routes/ticketHandlers/routeUtils'
import { getLatestPhaseArtifact, getTicketByRef, getTicketContext, isDisplayOnlyMockTicket, type PublicTicket } from '../storage/tickets'
import {
  buildObservedPullRequestReport,
  completeMergedPullRequest,
  recordPullRequestRefreshFailure,
  readPullRequestReport,
  refreshPullRequestReport,
  refreshPullRequestState,
  type PullRequestReport,
} from './phases/pullRequestPhase'
import type { PullRequestInfo, PullRequestState } from '../git/github'

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

/** A successful report for the current attempt is the checkpoint before the workflow event. */
function readVerifiedMergeReport(ticket: PublicTicket) {
  const artifact = getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')
  const prReport = readPullRequestReport(ticket.id)
  if (!artifact || !prReport) return null
  try {
    const report: unknown = JSON.parse(artifact.content)
    if (!isRecord(report)
      || report.status !== 'passed' || report.disposition !== 'merged' || report.prState !== 'merged'
      || typeof report.baseBranch !== 'string' || report.baseBranch.length === 0
      || report.baseBranch !== ticket.runtime.baseBranch
      || report.headBranch !== (ticket.branchName?.trim() || ticket.externalId)
      || typeof report.candidateCommitSha !== 'string' || report.candidateCommitSha.length === 0
      || report.candidateCommitSha !== ticket.runtime.candidateCommitSha
      || report.prHeadSha !== report.candidateCommitSha
      || typeof report.prNumber !== 'number' || !Number.isSafeInteger(report.prNumber) || report.prNumber <= 0
      || report.prNumber !== prReport.prNumber
      || (report.prUrl !== null && typeof report.prUrl !== 'string')
      || typeof report.message !== 'string'
      || typeof report.remoteBaseHead !== 'string' || report.remoteBaseHead.length === 0) return null
    return {
      prNumber: report.prNumber, prUrl: report.prUrl, prState: 'merged' as const,
      prHeadSha: report.candidateCommitSha, message: report.message, remoteBaseHead: report.remoteBaseHead,
    }
  } catch {
    return null
  }
}

/** A committed close decision for the current pull request is a recovery checkpoint. */
function readClosedUnmergedReport(ticket: PublicTicket) {
  const artifact = getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')
  const prReport = readPullRequestReport(ticket.id)
  if (!artifact || !prReport) return null
  try {
    const report: unknown = JSON.parse(artifact.content)
    const prState = isRecord(report) && (report.prState === null
      || report.prState === 'draft'
      || report.prState === 'open'
      || report.prState === 'closed'
      || report.prState === 'merged')
      ? report.prState as PullRequestState | null
      : undefined
    const prHeadSha = isRecord(report) && (report.prHeadSha === null || typeof report.prHeadSha === 'string')
      ? report.prHeadSha as string | null
      : undefined
    const prUrl = isRecord(report) && (report.prUrl === null || typeof report.prUrl === 'string')
      ? report.prUrl as string | null
      : undefined
    if (!isRecord(report)
      || report.status !== 'passed' || report.disposition !== 'closed_unmerged'
      || report.prState === 'merged'
      || prState === undefined
      || prHeadSha === undefined
      || typeof report.baseBranch !== 'string' || report.baseBranch !== ticket.runtime.baseBranch
      || report.headBranch !== (ticket.branchName?.trim() || ticket.externalId)
      || typeof report.candidateCommitSha !== 'string' || report.candidateCommitSha.length === 0
      || report.candidateCommitSha !== ticket.runtime.candidateCommitSha
      || typeof report.prNumber !== 'number' || !Number.isSafeInteger(report.prNumber) || report.prNumber <= 0
      || report.prNumber !== prReport.prNumber
      || prUrl === undefined
      || (prReport.prUrl !== null && prUrl !== prReport.prUrl)
      || typeof report.message !== 'string') return null
    return {
      prNumber: report.prNumber,
      prUrl,
      prState,
      prHeadSha,
      message: report.message,
      closeReason: report.closeReason,
    }
  } catch {
    return null
  }
}

export function hasVerifiedMergeReport(ticket: PublicTicket): boolean {
  return readVerifiedMergeReport(ticket) !== null
}

export function hasClosedUnmergedReport(ticket: PublicTicket): boolean {
  return readClosedUnmergedReport(ticket) !== null
}

function resumeVerifiedMerge(ticket: PublicTicket): boolean {
  const report = readVerifiedMergeReport(ticket)
  if (!report) return false
  const prReport = readPullRequestReport(ticket.id)!
  // A crash can leave the PR projection behind the committed verification report.
  // Keep its timestamps: the checkpoint records verification, not GitHub's merge time.
  refreshPullRequestReport(ticket.id, {
    ...prReport,
    prNumber: report.prNumber, prUrl: report.prUrl, prState: report.prState,
    prHeadSha: report.prHeadSha, message: report.message,
  })
  ensureActorForTicket(ticket.id)
  emitRoutePhaseLog(ticket.id, 'WAITING_PR_REVIEW', 'info', 'Resuming completion of the verified pull request merge.', {
    prNumber: report.prNumber, prUrl: report.prUrl, prState: report.prState, remoteBaseHead: report.remoteBaseHead,
  })
  sendTicketEvent(ticket.id, { type: 'MERGE_COMPLETE' })
  return true
}

function resumeClosedUnmerged(ticket: PublicTicket): boolean {
  const report = readClosedUnmergedReport(ticket)
  if (!report) return false
  const prReport = readPullRequestReport(ticket.id)!
  refreshPullRequestReport(ticket.id, {
    ...prReport,
    prNumber: report.prNumber,
    prUrl: report.prUrl,
    prState: report.prState,
    prHeadSha: report.prHeadSha,
    message: report.message,
  })
  ensureActorForTicket(ticket.id)
  emitRoutePhaseLog(ticket.id, 'WAITING_PR_REVIEW', 'info', 'Resuming completion of the recorded pull request close decision.', {
    disposition: 'closed_unmerged',
    prNumber: report.prNumber,
    prUrl: report.prUrl,
    prState: report.prState,
  })
  sendTicketEvent(ticket.id, { type: 'CLOSE_UNMERGED_COMPLETE' })
  return true
}

/** Called under the ticket lock by both the Merge action and background detection. */
export async function completeTicketMerge(
  ticket: PublicTicket,
  projectRoot: string,
  prReport: PullRequestReport,
  skipRemoteMerge = false,
  observedPullRequest?: PullRequestInfo,
): Promise<void> {
  const ticketId = ticket.id
  const phase = 'WAITING_PR_REVIEW'
  if (resumeVerifiedMerge(ticket)) return
  if (hasClosedUnmergedReport(ticket)) {
    throw new Error('A close-without-merge decision is already recorded for this pull request.')
  }
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
      observedPullRequest,
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
    if (resumeClosedUnmerged(ticket)) return null
    const context = getTicketContext(ticketId)
    const report = readPullRequestReport(ticketId)
    if (!context || !report) throw new Error('Waiting pull request ticket is missing its workspace or pull request report.')
    return { ticket, report, projectRoot: context.projectRoot }
  })
  if (!input) return
  // Remote reads do not hold up Cancel or Close. Revalidate before any write.
  let pr
  try {
    pr = await refreshPullRequestState(
      input.projectRoot,
      input.report.prNumber,
    )
  } catch (error) {
    recordPullRequestRefreshFailure({
      ticketId,
      projectPath: input.projectRoot,
      baseBranch: input.ticket.runtime.baseBranch,
      headBranch: input.ticket.branchName?.trim() || input.ticket.externalId,
      candidateCommitSha: input.ticket.runtime.candidateCommitSha,
      prNumber: input.report.prNumber,
      error,
    })
    throw error
  }
  await withTicketMergeLock(ticketId, async () => {
    const ticket = getTicketByRef(ticketId)
    if (!ticket || ticket.status !== 'WAITING_PR_REVIEW' || isDisplayOnlyMockTicket(ticket)) return
    if (resumeVerifiedMerge(ticket)) return
    if (resumeClosedUnmerged(ticket)) return
    const context = getTicketContext(ticketId)
    const report = readPullRequestReport(ticketId)
    if (!context || context.projectRoot !== input.projectRoot
      || !report || report.prNumber !== input.report.prNumber
      || ticket.branchName !== input.ticket.branchName
      || ticket.runtime.baseBranch !== input.ticket.runtime.baseBranch
      || ticket.runtime.candidateCommitSha !== input.ticket.runtime.candidateCommitSha) return
    const updatedReport = buildObservedPullRequestReport(report, pr)
    if (pr.state !== 'merged' && (pr.state !== report.prState || pr.headRefOid !== report.prHeadSha)) {
      refreshPullRequestReport(ticketId, updatedReport)
    }
    if (pr.state === 'merged') {
      await completeTicketMerge(ticket, context.projectRoot, updatedReport, true, pr)
    }
  })
}
