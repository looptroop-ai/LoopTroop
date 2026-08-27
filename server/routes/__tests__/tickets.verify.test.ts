import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import {
  createTicket,
  getLatestPhaseArtifact,
  getTicketByRef,
  insertPhaseArtifact,
  patchTicket,
} from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { initializeTicket } from '../../ticket/initialize'
import { ticketRouter } from '../tickets'
import { listSkipEvents } from '../../workflow/skipReceipts'

const {
  readPullRequestReportMock,
  refreshPullRequestReportMock,
  refreshPullRequestStateMock,
  completeMergedPullRequestMock,
  completeCloseUnmergedMock,
} = vi.hoisted(() => ({
  readPullRequestReportMock: vi.fn(),
  refreshPullRequestReportMock: vi.fn(),
  refreshPullRequestStateMock: vi.fn(),
  completeMergedPullRequestMock: vi.fn(),
  completeCloseUnmergedMock: vi.fn(),
}))

vi.mock('../../workflow/phases/pullRequestPhase', () => ({
  readPullRequestReport: readPullRequestReportMock,
  refreshPullRequestReport: refreshPullRequestReportMock,
  refreshPullRequestState: refreshPullRequestStateMock,
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

function createWaitingPrReviewTicket() {
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

  const init = initializeTicket({
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

describe('ticketRouter PR review routes', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
    vi.clearAllMocks()
    refreshPullRequestStateMock.mockReturnValue(null)
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
      insertPhaseArtifact(input.ticketId, {
        phase: 'WAITING_PR_REVIEW',
        artifactType: 'merge_report',
        content: JSON.stringify({ disposition: 'merged' }),
      })
      return {
        status: 'passed',
        completedAt: '2026-01-01T00:00:00.000Z',
        disposition: 'merged',
        baseBranch: 'main',
        headBranch: 'TEST-1',
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

  it('merges the pull request and advances to cleanup', async () => {
    const { ticket } = createWaitingPrReviewTicket()
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

  it('finishes without merge and advances to cleanup', async () => {
    const { ticket } = createWaitingPrReviewTicket()
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

  it('keeps /verify as an alias for merge during the transition', async () => {
    const { ticket } = createWaitingPrReviewTicket()
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
    const { ticket } = createWaitingPrReviewTicket()
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
    const { ticket } = createWaitingPrReviewTicket()
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
    const { ticket } = createWaitingPrReviewTicket()
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
    const { ticket } = createWaitingPrReviewTicket()
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
