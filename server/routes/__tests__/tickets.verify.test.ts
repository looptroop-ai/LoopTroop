import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { request } from 'node:http'
import { once } from 'node:events'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import {
  archiveActivePhaseAttempts,
  createFreshPhaseAttempts,
  createTicket,
  ensureActivePhaseAttempt,
  getLatestPhaseArtifact,
  getTicketByRef,
  insertPhaseArtifact,
  patchTicket,
} from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { initializeTicket } from '../../ticket/initialize'
import { ticketRouter } from '../tickets'
import { listSkipEvents } from '../../workflow/skipReceipts'
import { hasClosedUnmergedReport, hasVerifiedMergeReport, syncWaitingPullRequestTicket } from '../../workflow/mergeCompletion'
import { sendTicketEvent } from '../../machines/persistence'
import * as ticketStorage from '../../storage/tickets'

const {
  readPullRequestReportMock,
  refreshPullRequestReportMock,
  refreshPullRequestStateMock,
  buildObservedPullRequestReportMock,
  recordPullRequestRefreshFailureMock,
  completeMergedPullRequestMock,
  completeCloseUnmergedMock,
} = vi.hoisted(() => ({
  readPullRequestReportMock: vi.fn(),
  refreshPullRequestReportMock: vi.fn(),
  refreshPullRequestStateMock: vi.fn(),
  buildObservedPullRequestReportMock: vi.fn((report: Record<string, unknown>, pr: Record<string, unknown>, message = report.message) => ({
    ...report,
    prNumber: pr.number,
    prUrl: pr.url ?? report.prUrl,
    prState: pr.state,
    prHeadSha: pr.headRefOid ?? report.prHeadSha,
    title: pr.title ?? report.title,
    body: pr.body ?? report.body,
    createdAt: pr.createdAt ?? report.createdAt,
    updatedAt: pr.updatedAt ?? report.updatedAt,
    mergedAt: pr.mergedAt ?? report.mergedAt,
    closedAt: pr.closedAt ?? report.closedAt,
    message,
  })),
  recordPullRequestRefreshFailureMock: vi.fn(),
  completeMergedPullRequestMock: vi.fn(),
  completeCloseUnmergedMock: vi.fn(),
}))

vi.mock('../../workflow/phases/pullRequestPhase', () => ({
  readPullRequestReport: readPullRequestReportMock,
  refreshPullRequestReport: refreshPullRequestReportMock,
  refreshPullRequestState: refreshPullRequestStateMock,
  buildObservedPullRequestReport: buildObservedPullRequestReportMock,
  recordPullRequestRefreshFailure: recordPullRequestRefreshFailureMock,
  completeMergedPullRequest: completeMergedPullRequestMock,
  completeCloseUnmerged: completeCloseUnmergedMock,
}))

vi.mock('../../machines/persistence', async () => {
  const storage = await import('../../storage/tickets')

  return {
    createTicketActor: vi.fn(),
    ensureActorForTicket: vi.fn(() => ({ id: 'mock-actor' })),
    sendTicketEvent: vi.fn((ticketRef: string | number, event: { type: string; message?: string | null }) => {
      const resolvedTicketRef = String(ticketRef)
      if (event.type === 'MERGE_COMPLETE' || event.type === 'CLOSE_UNMERGED_COMPLETE') {
        storage.patchTicket(resolvedTicketRef, { status: 'CLEANING_ENV' })
      }
      if (event.type === 'ERROR') {
        storage.patchTicket(resolvedTicketRef, {
          status: 'BLOCKED_ERROR',
          errorMessage: event.message ?? null,
        })
      }
      return { value: event.type }
    }),
    getTicketState: vi.fn((ticketRef: string | number) => {
      const ticket = storage.getTicketByRef(String(ticketRef))
      if (!ticket) return null
      return {
        state: ticket.status,
        context: {},
        status: 'active',
      }
    }),
    stopActor: vi.fn(() => true),
  }
})

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-route-pr-review-',
  files: {
    'README.md': 'base\n',
  },
})

async function createWaitingPrReviewTicket() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'LoopTroop',
    shortname: 'LOOP',
  })
  const ticket = createTicket({
    projectId: project.id,
    title: 'PR review',
    description: 'Verify the PR review routes.',
  })

  const init = await initializeTicket({
    projectFolder: repoDir,
    externalId: ticket.externalId,
  })

  patchTicket(ticket.id, {
    status: 'WAITING_PR_REVIEW',
    branchName: init.branchName,
  })

  insertPhaseArtifact(ticket.id, {
    phase: 'INTEGRATING_CHANGES',
    artifactType: 'integration_report',
    content: JSON.stringify({
      status: 'passed',
      baseBranch: init.baseBranch,
      candidateCommitSha: 'abc123def456',
      preSquashHead: 'old789hash',
      mergeBase: 'mergebase123',
    }),
  })

  return { repoDir, ticket, init }
}

function insertClosedUnmergedCheckpoint(
  ticketId: string,
  overrides: { prNumber?: number; prUrl?: string; prHeadSha?: string } = {},
) {
  const ticket = getTicketByRef(ticketId)!
  insertPhaseArtifact(ticketId, {
    phase: 'WAITING_PR_REVIEW',
    artifactType: 'merge_report',
    content: JSON.stringify({
      status: 'passed',
      disposition: 'closed_unmerged',
      baseBranch: ticket.runtime.baseBranch,
      headBranch: ticket.branchName,
      candidateCommitSha: ticket.runtime.candidateCommitSha,
      prNumber: overrides.prNumber ?? 42,
      prUrl: overrides.prUrl ?? 'https://github.com/test/repo/pull/42',
      prState: 'open',
      prHeadSha: overrides.prHeadSha ?? ticket.runtime.candidateCommitSha,
      localBaseHead: null,
      remoteBaseHead: null,
      remoteBranchDeleteWarning: null,
      closeReason: 'Superseded.',
      message: 'Ticket finished without merging the pull request. The pull request and remote branch were left untouched.',
    }),
  })
}

describe('ticketRouter PR review routes', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
    vi.clearAllMocks()
    refreshPullRequestStateMock.mockResolvedValue({
      number: 42,
      url: 'https://github.com/test/repo/pull/42',
      title: 'TEST-1: PR review',
      body: '## Summary\n- test',
      state: 'draft',
      baseRefName: 'main',
      headRefName: 'TEST-1',
      headRefOid: 'abc123def456',
      mergeCommitSha: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      mergedAt: null,
      closedAt: null,
    })
    readPullRequestReportMock.mockReturnValue({
      status: 'passed',
      completedAt: '2026-01-01T00:00:00.000Z',
      baseBranch: 'main',
      headBranch: 'TEST-1',
      candidateCommitSha: 'abc123def456',
      prNumber: 42,
      prUrl: 'https://github.com/test/repo/pull/42',
      prState: 'draft',
      prHeadSha: 'abc123def456',
      title: 'TEST-1: PR review',
      body: '## Summary\n- test',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      mergedAt: null,
      closedAt: null,
      message: 'Draft PR ready.',
    })
    completeMergedPullRequestMock.mockImplementation((input: { ticketId: string }) => {
      const ticket = getTicketByRef(input.ticketId)!
      const report = {
        status: 'passed',
        completedAt: '2026-01-01T00:00:00.000Z',
        disposition: 'merged',
        baseBranch: ticket.runtime.baseBranch,
        headBranch: ticket.branchName || ticket.externalId,
        candidateCommitSha: 'abc123def456',
        prNumber: 42,
        prUrl: 'https://github.com/test/repo/pull/42',
        prState: 'merged',
        prHeadSha: 'abc123def456',
        localBaseHead: null,
        remoteBaseHead: 'base123',
        remoteBranchDeleteWarning: null,
        message: 'Pull request merged into origin/main. Local checkout was not modified.',
      }
      insertPhaseArtifact(input.ticketId, {
        phase: 'WAITING_PR_REVIEW', artifactType: 'merge_report', content: JSON.stringify(report),
      })
      return report
    })
    completeCloseUnmergedMock.mockImplementation((input: { ticketId: string; reason?: string | null }) => {
      insertPhaseArtifact(input.ticketId, {
        phase: 'WAITING_PR_REVIEW',
        artifactType: 'merge_report',
        content: JSON.stringify({ disposition: 'closed_unmerged', closeReason: input.reason ?? null }),
      })
      return {
        status: 'passed',
        completedAt: '2026-01-01T00:00:00.000Z',
        disposition: 'closed_unmerged',
        baseBranch: 'main',
        headBranch: 'TEST-1',
        candidateCommitSha: 'abc123def456',
        prNumber: 42,
        prUrl: 'https://github.com/test/repo/pull/42',
        prState: 'draft',
        prHeadSha: 'abc123def456',
        localBaseHead: null,
        remoteBaseHead: null,
        remoteBranchDeleteWarning: null,
        closeReason: input.reason ?? null,
        message: 'Ticket finished without merging the pull request. The pull request and remote branch were left untouched.',
      }
    })
  })

  it('leaves the ticket alone when a GET cannot reach GitHub', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    refreshPullRequestStateMock.mockRejectedValue(new Error('gh: API rate limit exceeded'))
    const app = new Hono()
    app.route('/api', ticketRouter)

    const response = await app.request(`/api/tickets/${ticket.id}`)

    expect(response.status).toBe(200)
    // A routine UI poll used to dispatch ERROR here, so a transient GitHub
    // failure moved the ticket to BLOCKED_ERROR: a read request bricked it.
    const after = getTicketByRef(ticket.id)
    expect(after?.status).toBe('WAITING_PR_REVIEW')
    expect(after?.errorMessage).toBeFalsy()
    expect(refreshPullRequestStateMock).not.toHaveBeenCalled()
    expect(completeMergedPullRequestMock).not.toHaveBeenCalled()
    expect(refreshPullRequestReportMock).not.toHaveBeenCalled()
  })

  it.each(['merge', 'close-unmerged'] as const)('persists a refresh receipt when %s cannot read the pull request', async (action) => {
    const { ticket } = await createWaitingPrReviewTicket()
    const actualPhase = await vi.importActual<typeof import('../../workflow/phases/pullRequestPhase')>('../../workflow/phases/pullRequestPhase')
    recordPullRequestRefreshFailureMock.mockImplementation(actualPhase.recordPullRequestRefreshFailure)
    refreshPullRequestStateMock.mockRejectedValue(new Error('GitHub unavailable'))
    const app = new Hono().route('/api', ticketRouter)

    const response = await app.request(`/api/tickets/${ticket.id}/${action}`, {
      method: 'POST',
      ...(action === 'close-unmerged' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
    })

    expect(response.status).toBe(502)
    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_PR_REVIEW')
    const receipt = getLatestPhaseArtifact(ticket.id, 'git_recovery_receipt', 'WAITING_PR_REVIEW')
    expect(receipt).toBeDefined()
    expect(JSON.parse(receipt!.content)).toMatchObject({
      step: 'refresh_pull_request',
      error: 'GitHub unavailable',
      prNumber: 42,
      prUrl: null,
      prState: null,
    })
  })

  it('persists a refresh receipt when background waiting-ticket recovery cannot read the pull request', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    const actualPhase = await vi.importActual<typeof import('../../workflow/phases/pullRequestPhase')>('../../workflow/phases/pullRequestPhase')
    recordPullRequestRefreshFailureMock.mockImplementation(actualPhase.recordPullRequestRefreshFailure)
    refreshPullRequestStateMock.mockRejectedValue(new Error('GitHub unavailable'))

    await expect(syncWaitingPullRequestTicket(ticket.id)).rejects.toThrow('GitHub unavailable')

    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_PR_REVIEW')
    const receipt = getLatestPhaseArtifact(ticket.id, 'git_recovery_receipt', 'WAITING_PR_REVIEW')
    expect(receipt).toBeDefined()
    expect(JSON.parse(receipt!.content)).toMatchObject({
      step: 'refresh_pull_request',
      error: 'GitHub unavailable',
      prNumber: 42,
      prUrl: null,
      prState: null,
    })
  })

  it('keeps overlapping GETs read-only even when GitHub has merged the PR', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    refreshPullRequestStateMock.mockResolvedValue({ state: 'merged' })
    const app = new Hono().route('/api', ticketRouter)
    const responses = await Promise.all([
      app.request(`/api/tickets/${ticket.id}`), app.request(`/api/tickets/${ticket.id}`),
    ])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_PR_REVIEW')
    expect(refreshPullRequestStateMock).not.toHaveBeenCalled()
    expect(completeMergedPullRequestMock).not.toHaveBeenCalled()
    expect(refreshPullRequestReportMock).not.toHaveBeenCalled()
  })

  it('finalizes an external merge once without any GET or remote merge request', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    refreshPullRequestStateMock.mockResolvedValue({ state: 'merged', number: 42 })
    await Promise.all([syncWaitingPullRequestTicket(ticket.id), syncWaitingPullRequestTicket(ticket.id)])
    expect(completeMergedPullRequestMock).toHaveBeenCalledOnce()
    expect(completeMergedPullRequestMock).toHaveBeenCalledWith(expect.objectContaining({ skipRemoteMerge: true }))
    expect(getTicketByRef(ticket.id)?.status).toBe('CLEANING_ENV')
    expect(refreshPullRequestReportMock).not.toHaveBeenCalled()
  })

  it('resumes a durable merge after interrupted event dispatch without contacting GitHub', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    const current = getTicketByRef(ticket.id)!
    insertPhaseArtifact(ticket.id, {
      phase: 'WAITING_PR_REVIEW', artifactType: 'merge_report',
      content: JSON.stringify({
        status: 'passed', disposition: 'merged', prState: 'merged', prNumber: 42,
        baseBranch: current.runtime.baseBranch, headBranch: current.branchName,
        candidateCommitSha: current.runtime.candidateCommitSha, prHeadSha: current.runtime.candidateCommitSha,
        prUrl: 'https://github.com/test/repo/pull/42', message: 'Verified merge', remoteBaseHead: 'verified-base',
      }),
    })
    refreshPullRequestStateMock.mockRejectedValue(new Error('GitHub unavailable after restart'))
    await syncWaitingPullRequestTicket(ticket.id)
    expect(getTicketByRef(ticket.id)?.status).toBe('CLEANING_ENV')
    expect(refreshPullRequestStateMock).not.toHaveBeenCalled()
    expect(completeMergedPullRequestMock).not.toHaveBeenCalled()
    expect(refreshPullRequestReportMock).toHaveBeenCalledWith(ticket.id, expect.objectContaining({
      prNumber: 42, prState: 'merged', prHeadSha: current.runtime.candidateCommitSha, message: 'Verified merge',
      mergedAt: null, closedAt: null,
    }))
  })

  it('resumes a durable close decision after interrupted event dispatch without contacting GitHub', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    insertClosedUnmergedCheckpoint(ticket.id)
    refreshPullRequestStateMock.mockRejectedValue(new Error('GitHub unavailable after restart'))

    await syncWaitingPullRequestTicket(ticket.id)

    expect(getTicketByRef(ticket.id)?.status).toBe('CLEANING_ENV')
    expect(refreshPullRequestStateMock).not.toHaveBeenCalled()
    expect(completeMergedPullRequestMock).not.toHaveBeenCalled()
    expect(refreshPullRequestReportMock).toHaveBeenCalledWith(ticket.id, expect.objectContaining({
      prNumber: 42,
      prState: 'open',
      prHeadSha: 'abc123def456',
    }))
  })

  it('resumes a close decision after the remote head changes before event dispatch is interrupted', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    const actualPhase = await vi.importActual<typeof import('../../workflow/phases/pullRequestPhase')>('../../workflow/phases/pullRequestPhase')
    completeCloseUnmergedMock.mockImplementation(actualPhase.completeCloseUnmerged)
    refreshPullRequestStateMock.mockResolvedValue({
      number: 42,
      url: 'https://github.com/test/repo/pull/42',
      state: 'open',
      headRefOid: 'new-remote-head',
    })
    const dispatch = vi.mocked(sendTicketEvent).getMockImplementation()!
    vi.mocked(sendTicketEvent).mockImplementationOnce(() => { throw new Error('Interrupted dispatch') })
    const app = new Hono().route('/api', ticketRouter)

    try {
      const response = await app.request(`/api/tickets/${ticket.id}/close-unmerged`, { method: 'POST' })
      expect(response.status).toBe(500)
      const checkpoint = getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')
      expect(JSON.parse(checkpoint!.content)).toMatchObject({
        disposition: 'closed_unmerged',
        prNumber: 42,
        prHeadSha: 'new-remote-head',
      })
      // The committed close checkpoint is the newer observation; the projection
      // can still be old when the event dispatch is interrupted.
      expect(readPullRequestReportMock()).toMatchObject({ prHeadSha: 'abc123def456' })
    } finally {
      vi.mocked(sendTicketEvent).mockImplementation(dispatch)
    }

    refreshPullRequestStateMock.mockClear()
    await syncWaitingPullRequestTicket(ticket.id)

    expect(getTicketByRef(ticket.id)?.status).toBe('CLEANING_ENV')
    expect(refreshPullRequestStateMock).not.toHaveBeenCalled()
    expect(refreshPullRequestReportMock).toHaveBeenCalledWith(ticket.id, expect.objectContaining({
      prNumber: 42,
      prHeadSha: 'new-remote-head',
    }))
  })

  it('rejects a closed-unmerged checkpoint that belongs to a different pull request', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    const current = getTicketByRef(ticket.id)!
    insertClosedUnmergedCheckpoint(ticket.id, {
      prNumber: 43,
      prUrl: 'https://github.com/test/repo/pull/43',
      prHeadSha: 'stale-other-pr-head',
    })

    expect(hasClosedUnmergedReport(current)).toBe(false)
    await syncWaitingPullRequestTicket(ticket.id)

    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_PR_REVIEW')
    expect(sendTicketEvent).not.toHaveBeenCalled()
    expect(completeMergedPullRequestMock).not.toHaveBeenCalled()
  })

  it.each(['corrupt', 'unverified', 'different-candidate', 'missing-candidate', 'different-pr', 'unsafe-pr-number', 'different-head'])('rejects a %s merge checkpoint', async (kind) => {
    const { ticket } = await createWaitingPrReviewTicket()
    const current = getTicketByRef(ticket.id)!
    const report = {
      status: 'passed', disposition: 'merged', prState: 'merged',
      baseBranch: current.runtime.baseBranch, headBranch: current.branchName,
      candidateCommitSha: kind === 'missing-candidate' ? undefined : kind === 'different-candidate' ? 'stale-sha' : current.runtime.candidateCommitSha,
      prNumber: kind === 'different-pr' ? 43 : kind === 'unsafe-pr-number' ? Number.MAX_SAFE_INTEGER + 1 : 42,
      prHeadSha: kind === 'different-head' ? 'other-head' : current.runtime.candidateCommitSha,
      prUrl: 'https://github.com/test/repo/pull/42', message: 'Verified merge',
      remoteBaseHead: kind === 'unverified' ? null : 'verified-base',
    }
    insertPhaseArtifact(ticket.id, {
      phase: 'WAITING_PR_REVIEW', artifactType: 'merge_report',
      content: kind === 'corrupt' ? '{' : JSON.stringify(report),
    })
    expect(hasVerifiedMergeReport(current)).toBe(false)
  })

  it('requires independent candidate authority and keeps archived merge checkpoints out of recovery', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    ensureActivePhaseAttempt(ticket.id, 'WAITING_PR_REVIEW')
    completeMergedPullRequestMock({ ticketId: ticket.id })
    const current = getTicketByRef(ticket.id)!
    expect(hasVerifiedMergeReport(current)).toBe(true)
    expect(hasVerifiedMergeReport({ ...current, runtime: { ...current.runtime, candidateCommitSha: null } })).toBe(false)
    expect(hasVerifiedMergeReport({ ...current, runtime: { ...current.runtime, baseBranch: 'unknown' } })).toBe(false)
    archiveActivePhaseAttempts(ticket.id, ['WAITING_PR_REVIEW'], 'new_review')
    createFreshPhaseAttempts(ticket.id, ['WAITING_PR_REVIEW'])
    expect(hasVerifiedMergeReport(getTicketByRef(ticket.id)!)).toBe(false)
  })

  it.each(['cancel', 'close-unmerged'])('preserves a verified merge when %s arrives before event recovery', async (action) => {
    const { ticket } = await createWaitingPrReviewTicket()
    completeMergedPullRequestMock({ ticketId: ticket.id })
    const checkpoint = getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')!
    const app = new Hono().route('/api', ticketRouter)
    const response = await app.request(`/api/tickets/${ticket.id}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'cancel' ? { deleteTicket: true } : {}),
    })
    expect(response.status).toBe(409)
    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_PR_REVIEW')
    expect(getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')?.id).toBe(checkpoint.id)
    expect(completeCloseUnmergedMock).not.toHaveBeenCalled()
    expect(sendTicketEvent).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'close-unmerged'])('allows completion during a slow %s body and checks the new state afterwards', async (action) => {
    const { ticket } = await createWaitingPrReviewTicket()
    refreshPullRequestStateMock.mockResolvedValue({ state: 'merged', number: 42 })
    let bodyStarted!: () => void
    const readingBody = new Promise<void>((resolve) => { bodyStarted = resolve })
    const app = new Hono()
    app.use('*', async (c, next) => {
      const readText = c.req.text.bind(c.req)
      c.req.text = () => { bodyStarted(); return readText() }
      await next()
    })
    app.route('/api', ticketRouter)
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server')
    const pending = request({
      hostname: '127.0.0.1', port: address.port,
      path: `/api/tickets/${ticket.id}/${action}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    })
    const response = once(pending, 'response')
    let completion: Promise<void> | undefined
    try {
      pending.flushHeaders()
      await readingBody
      completion = syncWaitingPullRequestTicket(ticket.id)
      await vi.waitFor(() => expect(getTicketByRef(ticket.id)?.status).toBe('CLEANING_ENV'))
      pending.end('{}')
      const [result] = await response
      expect(result.statusCode).toBe(409)
      result.resume()
      expect(completeMergedPullRequestMock).toHaveBeenCalledOnce()
      expect(completeCloseUnmergedMock).not.toHaveBeenCalled()
      expect(sendTicketEvent).not.toHaveBeenCalledWith(ticket.id, { type: 'CANCEL' })
    } finally {
      if (!pending.writableEnded) pending.end('{}')
      const [result] = await response
      result.resume()
      await completion
      if ('closeAllConnections' in server) server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it.each(['dispatch', 'post-commit refresh'])('keeps a verified merge retryable after %s fails', async (failure) => {
    const { ticket } = await createWaitingPrReviewTicket()
    if (failure === 'dispatch') {
      vi.mocked(sendTicketEvent).mockImplementationOnce(() => { throw new Error('dispatch unavailable') })
    } else {
      const complete = completeMergedPullRequestMock.getMockImplementation()!
      completeMergedPullRequestMock.mockImplementationOnce((input) => {
        complete(input)
        throw new Error('PR projection unavailable after commit')
      })
    }
    const app = new Hono().route('/api', ticketRouter)
    const failed = await app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toMatchObject({ error: expect.stringContaining('merge is verified') })
    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_PR_REVIEW')
    expect(vi.mocked(sendTicketEvent).mock.calls.every(([, event]) => event.type !== 'ERROR')).toBe(true)
    const checkpoint = getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')!
    expect((await app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' })).status).toBe(200)
    expect(getTicketByRef(ticket.id)?.status).toBe('CLEANING_ENV')
    expect(getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')?.id).toBe(checkpoint.id)
    expect(completeMergedPullRequestMock).toHaveBeenCalledOnce()
  })

  it('keeps recovery pending when repairing the PR report fails', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    completeMergedPullRequestMock({ ticketId: ticket.id })
    refreshPullRequestReportMock.mockImplementationOnce(() => { throw new Error('PR report is unavailable') })
    await expect(syncWaitingPullRequestTicket(ticket.id)).rejects.toThrow('PR report is unavailable')
    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_PR_REVIEW')
    expect(sendTicketEvent).not.toHaveBeenCalled()
    await syncWaitingPullRequestTicket(ticket.id)
    expect(getTicketByRef(ticket.id)?.status).toBe('CLEANING_ENV')
    expect(refreshPullRequestStateMock).not.toHaveBeenCalled()
  })

  it('discards remote observations after the attached project root changes', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    let finishRefresh!: (value: unknown) => void
    refreshPullRequestStateMock.mockReturnValueOnce(new Promise(resolve => { finishRefresh = resolve }))
    const background = syncWaitingPullRequestTicket(ticket.id)
    await vi.waitFor(() => expect(refreshPullRequestStateMock).toHaveBeenCalledOnce())
    const getContext = ticketStorage.getTicketContext
    const moved = vi.spyOn(ticketStorage, 'getTicketContext').mockImplementation((ref) => {
      const context = getContext(ref)
      return context ? { ...context, projectRoot: `${context.projectRoot}-moved` } : undefined
    })
    try {
      finishRefresh({ state: 'merged', number: 42 })
      await background
      expect(completeMergedPullRequestMock).not.toHaveBeenCalled()
      expect(refreshPullRequestReportMock).not.toHaveBeenCalled()
    } finally {
      moved.mockRestore()
    }
  })

  it('does not hold Close behind a remote read or complete from its stale result', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    let finishRefresh!: (value: unknown) => void
    refreshPullRequestStateMock.mockReturnValueOnce(new Promise(resolve => { finishRefresh = resolve }))
    const background = syncWaitingPullRequestTicket(ticket.id)
    await vi.waitFor(() => expect(refreshPullRequestStateMock).toHaveBeenCalledOnce())
    const app = new Hono().route('/api', ticketRouter)
    const response = await app.request(`/api/tickets/${ticket.id}/close-unmerged`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(completeCloseUnmergedMock).toHaveBeenCalledOnce()
    finishRefresh({ state: 'merged', number: 42 })
    await background
    expect(completeMergedPullRequestMock).not.toHaveBeenCalled()
  })

  it('refreshes open PR metadata without initiating a merge', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    refreshPullRequestStateMock.mockResolvedValue({ state: 'open', number: 42, headRefOid: 'new-head' })
    await syncWaitingPullRequestTicket(ticket.id)
    expect(refreshPullRequestReportMock).toHaveBeenCalledWith(ticket.id, expect.objectContaining({ prState: 'open', prHeadSha: 'new-head' }))
    expect(completeMergedPullRequestMock).not.toHaveBeenCalled()
    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_PR_REVIEW')
  })

  it('retries failed background completion without blocking the ticket', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    refreshPullRequestStateMock.mockResolvedValue({ state: 'merged', number: 42 })
    completeMergedPullRequestMock.mockRejectedValueOnce(new Error('GitHub temporarily unavailable'))
    await expect(syncWaitingPullRequestTicket(ticket.id)).rejects.toThrow('GitHub temporarily unavailable')
    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_PR_REVIEW')
    await syncWaitingPullRequestTicket(ticket.id)
    expect(getTicketByRef(ticket.id)?.status).toBe('CLEANING_ENV')
  })

  it('serializes a background completion with the Merge action', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    let finishCompletion!: () => void
    const complete = completeMergedPullRequestMock.getMockImplementation()!
    completeMergedPullRequestMock.mockImplementationOnce(async (input) => {
      await new Promise<void>(resolve => { finishCompletion = resolve })
      return complete(input)
    })
    refreshPullRequestStateMock.mockResolvedValue({ state: 'merged', number: 42 })
    const background = syncWaitingPullRequestTicket(ticket.id)
    await vi.waitFor(() => expect(completeMergedPullRequestMock).toHaveBeenCalledOnce())
    const app = new Hono().route('/api', ticketRouter)
    const response = app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' })
    finishCompletion()
    await background
    expect((await response).status).toBe(200)
    expect(completeMergedPullRequestMock).toHaveBeenCalledOnce()
    expect(getTicketByRef(ticket.id)?.status).toBe('CLEANING_ENV')
  })

  it('serializes overlapping Merge actions', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    const app = new Hono().route('/api', ticketRouter)
    const responses = await Promise.all([
      app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' }),
      app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' }),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([200, 200])
    expect(completeMergedPullRequestMock).toHaveBeenCalledOnce()
  })

  it('merges the pull request and advances to cleanup', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    const app = new Hono()
    app.route('/api', ticketRouter)

    const response = await app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' })

    expect(response.status).toBe(200)
    const payload = await response.json() as { status?: string; message?: string }
    expect(payload).toMatchObject({
      status: 'CLEANING_ENV',
      message: 'Merge complete',
    })
    expect(completeMergedPullRequestMock).toHaveBeenCalledOnce()
  })

  it.each(['CLEANING_ENV', 'COMPLETED'])('returns recorded Merge success from %s without remote work', async (status) => {
    const { ticket } = await createWaitingPrReviewTicket()
    const app = new Hono().route('/api', ticketRouter)
    expect((await app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' })).status).toBe(200)
    patchTicket(ticket.id, { status })
    const response = await app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status, message: 'Merge complete' })
    expect(completeMergedPullRequestMock).toHaveBeenCalledOnce()
  })

  it.each(['CANCELED', 'BLOCKED_ERROR', 'DRAFT'])('rejects a repeated Merge from %s even with a verified report', async (status) => {
    const { ticket } = await createWaitingPrReviewTicket()
    const app = new Hono().route('/api', ticketRouter)
    await app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' })
    patchTicket(ticket.id, { status })
    expect((await app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' })).status).toBe(409)
    expect(completeMergedPullRequestMock).toHaveBeenCalledOnce()
  })

  it.each(['CLEANING_ENV', 'COMPLETED'])('rejects Merge from %s without matching verified completion', async (status) => {
    const { ticket } = await createWaitingPrReviewTicket()
    const app = new Hono().route('/api', ticketRouter)
    patchTicket(ticket.id, { status })
    expect((await app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' })).status).toBe(409)
    completeMergedPullRequestMock({ ticketId: ticket.id })
    const report = JSON.parse(getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')!.content)
    for (const invalid of [{ ...report, disposition: 'closed_unmerged' }, { ...report, candidateCommitSha: 'other-candidate' }]) {
      insertPhaseArtifact(ticket.id, { phase: 'WAITING_PR_REVIEW', artifactType: 'merge_report', content: JSON.stringify(invalid) })
      expect((await app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' })).status).toBe(409)
    }
    expect(completeMergedPullRequestMock).toHaveBeenCalledOnce()
  })

  it('finishes without merge and advances to cleanup', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    const app = new Hono()
    app.route('/api', ticketRouter)

    const response = await app.request(`/api/tickets/${ticket.id}/close-unmerged`, { method: 'POST' })

    expect(response.status).toBe(200)
    const payload = await response.json() as { status?: string; message?: string }
    expect(payload).toMatchObject({
      status: 'CLEANING_ENV',
      message: 'Finished without merge',
    })
    expect(completeCloseUnmergedMock).toHaveBeenCalledOnce()
  })

  it('refuses Merge, Close, and Cancel when a closed-unmerged checkpoint is already recorded', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    insertClosedUnmergedCheckpoint(ticket.id)
    const app = new Hono().route('/api', ticketRouter)

    expect((await app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' })).status).toBe(409)
    expect((await app.request(`/api/tickets/${ticket.id}/close-unmerged`, { method: 'POST' })).status).toBe(409)
    expect((await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })).status).toBe(409)
    expect(refreshPullRequestStateMock).not.toHaveBeenCalled()
    expect(completeMergedPullRequestMock).not.toHaveBeenCalled()
    expect(completeCloseUnmergedMock).not.toHaveBeenCalled()
  })

  it('refuses Close when the refreshed pull request is already merged', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    refreshPullRequestStateMock.mockResolvedValue({
      number: 42,
      url: 'https://github.com/test/repo/pull/42',
      title: 'TEST-1: PR review',
      body: '## Summary\n- test',
      state: 'merged',
      baseRefName: 'main',
      headRefName: 'TEST-1',
      headRefOid: 'abc123def456',
      mergeCommitSha: 'landed123',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:05:00.000Z',
      mergedAt: '2026-01-01T00:05:00.000Z',
      closedAt: '2026-01-01T00:05:00.000Z',
    })
    const app = new Hono().route('/api', ticketRouter)

    const response = await app.request(`/api/tickets/${ticket.id}/close-unmerged`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('already merged') })
    expect(refreshPullRequestReportMock).toHaveBeenCalledWith(ticket.id, expect.objectContaining({
      prState: 'merged',
      prHeadSha: 'abc123def456',
      mergedAt: '2026-01-01T00:05:00.000Z',
    }))
    expect(completeCloseUnmergedMock).not.toHaveBeenCalled()
    expect(getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')).toBeUndefined()
  })

  it('keeps /verify as an alias for merge during the transition', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    const app = new Hono()
    app.route('/api', ticketRouter)

    const response = await app.request(`/api/tickets/${ticket.id}/verify`, { method: 'POST' })

    expect(response.status).toBe(200)
    const payload = await response.json() as { status?: string; message?: string }
    expect(payload).toMatchObject({
      status: 'CLEANING_ENV',
      message: 'Merge complete',
    })
    expect(completeMergedPullRequestMock).toHaveBeenCalledOnce()
  })

  it('blocks as a merge failure when remote merge verification fails', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    const app = new Hono()
    app.route('/api', ticketRouter)
    completeMergedPullRequestMock.mockImplementationOnce(() => {
      throw new Error('Remote origin/main does not contain commit abc123def456')
    })

    const response = await app.request(`/api/tickets/${ticket.id}/merge`, { method: 'POST' })

    expect(response.status).toBe(200)
    const payload = await response.json() as { status?: string; message?: string }
    expect(payload).toMatchObject({
      status: 'BLOCKED_ERROR',
      message: 'Merge failed and ticket was blocked',
    })
    expect(getTicketByRef(ticket.id)?.errorMessage).toContain('Remote origin/main does not contain commit abc123def456')
  })

  it('persists a close-unmerged merge report artifact', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    const app = new Hono()
    app.route('/api', ticketRouter)

    const response = await app.request(`/api/tickets/${ticket.id}/close-unmerged`, { method: 'POST' })

    expect(response.status).toBe(200)
    const artifact = getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')
    expect(artifact).toBeDefined()
    const report = JSON.parse(artifact!.content) as { disposition?: string }
    expect(report.disposition).toBe('closed_unmerged')
  })

  it('records why the branch was finished without merging', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    const app = new Hono()
    app.route('/api', ticketRouter)

    const response = await app.request(`/api/tickets/${ticket.id}/close-unmerged`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Superseded by a smaller change on another branch.' }),
    })

    expect(response.status).toBe(200)

    const artifact = getLatestPhaseArtifact(ticket.id, 'merge_report', 'WAITING_PR_REVIEW')
    const report = JSON.parse(artifact!.content) as { closeReason?: string | null }
    expect(report.closeReason).toBe('Superseded by a smaller change on another branch.')

    const events = listSkipEvents(ticket.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      surface: 'close_unmerged',
      phase: 'WAITING_PR_REVIEW',
      reason: 'Superseded by a smaller change on another branch.',
    })
  })

  it('rejects an unknown field on the close request', async () => {
    const { ticket } = await createWaitingPrReviewTicket()
    const app = new Hono()
    app.route('/api', ticketRouter)

    const response = await app.request(`/api/tickets/${ticket.id}/close-unmerged`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A close reason is not a retry note and must not be accepted as one.
      body: JSON.stringify({ note: 'Superseded.' }),
    })

    expect(response.status).toBe(400)
  })
})
