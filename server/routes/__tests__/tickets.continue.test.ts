import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { opencodeSessions, phaseArtifacts } from '../../db/schema'
import { attachProject } from '../../storage/projects'
import {
  createTicket,
  ensureActivePhaseAttempt,
  getTicketByRef,
  getTicketContext,
  listPhaseAttempts,
  patchTicket,
  recordTicketErrorOccurrence,
  upsertLatestPhaseArtifact,
} from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import {
  clearAllPendingSessionContinuationsForTests,
  getPendingSessionContinuationForTicketPhase,
  hasPendingSessionContinuationForTicketPhase,
} from '../../opencode/sessionContinuation'

const { getSessionMock, listSessionsMock, abortSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  listSessionsMock: vi.fn(),
  abortSessionMock: vi.fn(),
}))

vi.mock('../../opencode/factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../opencode/factory')>()
  return {
    ...actual,
    getOpenCodeAdapter: vi.fn(() => ({
      getSession: getSessionMock,
      listSessions: listSessionsMock,
      abortSession: abortSessionMock,
    })),
  }
})

vi.mock('../../machines/persistence', async () => {
  const storage = await import('../../storage/tickets')

  return {
    createTicketActor: vi.fn(),
    ensureActorForTicket: vi.fn(() => ({ id: 'mock-actor' })),
    sendTicketEvent: vi.fn((ticketRef: string | number, event: { type: string }) => {
      const ticket = storage.getTicketByRef(String(ticketRef))
      if (event.type === 'CONTINUE' && ticket?.previousStatus) {
        storage.patchTicket(String(ticketRef), {
          status: ticket.previousStatus,
          errorMessage: null,
        })
      }
      return { value: event.type }
    }),
    getTicketState: vi.fn((ticketRef: string | number) => {
      const ticket = storage.getTicketByRef(String(ticketRef))
      if (!ticket) return null
      return { state: ticket.status, context: {}, status: 'active' }
    }),
    stopActor: vi.fn(() => true),
    revertTicketToApprovalStatus: vi.fn(),
  }
})

import { sendTicketEvent } from '../../machines/persistence'
import { ticketRouter } from '../tickets'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-continue-route-',
  files: {
    'README.md': '# Continue route test\n',
  },
})

function setupContinueTicketApp() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'LoopTroop',
    shortname: 'LOOP',
  })
  const ticket = createTicket({
    projectId: project.id,
    title: 'Continue route',
    description: 'Verify same-session continuation.',
  })

  const app = new Hono()
  app.route('/api', ticketRouter)

  return { app, project, ticket }
}

function insertActiveOpenCodeSession(
  ticketRef: string,
  phase: string,
  sessionId = 'ses-continue',
  ownership: { phaseAttempt?: number; step?: string; memberId?: string } = {},
) {
  const context = getTicketContext(ticketRef)
  if (!context) throw new Error(`Missing ticket context for ${ticketRef}`)
  context.projectDb.insert(opencodeSessions)
    .values({
      sessionId,
      ticketId: context.localTicketId,
      phase,
      phaseAttempt: ownership.phaseAttempt ?? 1,
      memberId: ownership.memberId ?? null,
      step: ownership.step ?? null,
      state: 'active',
    })
    .run()
}

function blockTicketWithContinuableError(
  ticketRef: string,
  previousStatus: string,
  sessionId = 'ses-continue',
  ownership: { phaseAttempt?: number; step?: string; memberId?: string } = {},
) {
  recordTicketErrorOccurrence(ticketRef, {
    blockedFromStatus: previousStatus,
    errorMessage: 'Usage limit has been reached.',
    errorCodes: [],
    diagnostics: {
      kind: 'opencode_provider',
      source: 'provider',
      summary: 'usage limit has been reached',
      sessionId,
      statusCode: 429,
      isRetryable: true,
    },
  })
  patchTicket(ticketRef, {
    status: 'BLOCKED_ERROR',
    xstateSnapshot: JSON.stringify({ context: { previousStatus } }),
    errorMessage: 'Usage limit has been reached.',
  })
  insertActiveOpenCodeSession(ticketRef, previousStatus, sessionId, ownership)
}

describe('ticketRouter POST /tickets/:id/continue', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
    clearAllPendingSessionContinuationsForTests()
    vi.clearAllMocks()
    listSessionsMock.mockResolvedValue([{ id: 'ses-continue', projectPath: '/tmp/project' }])
    abortSessionMock.mockResolvedValue(true)
    getSessionMock.mockResolvedValue({ id: 'ses-continue', projectPath: '/tmp/project' })
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it.each(['PREPARING_EXECUTION_ENV', 'WAITING_INTERVIEW_ANSWERS', 'REFINING_PRD'] as const)('continues %s in the same session with the default continuation prompt and unchanged attempt', async (phase) => {
    const { app, ticket } = setupContinueTicketApp()
    ensureActivePhaseAttempt(ticket.id, phase)
    blockTicketWithContinuableError(ticket.id, phase)
    expect(getTicketByRef(ticket.id)?.availableActions).toContain('continue')

    const response = await app.request(`/api/tickets/${ticket.id}/continue`, { method: 'POST' })

    expect(response.status).toBe(200)
    expect(sendTicketEvent).toHaveBeenCalledWith(ticket.id, { type: 'CONTINUE' })
    expect(getPendingSessionContinuationForTicketPhase(ticket.id, phase)).toMatchObject({ sessionId: 'ses-continue' })
    expect(getPendingSessionContinuationForTicketPhase(ticket.id, phase)?.prompt).toBeUndefined()
    expect(getTicketByRef(ticket.id)?.status).toBe(phase)
    expect(listPhaseAttempts(ticket.id, phase)).toEqual([
      expect.objectContaining({ attemptNumber: 1, state: 'active' }),
    ])
  })

  it.each(['missing', 'damaged', 'other-attempt', 'wrong-session-attempt', 'wrong-member'] as const)(
    'hides coverage Continue when the revision checkpoint is %s',
    (checkpointState) => {
      const { ticket } = setupContinueTicketApp()
      const phase = 'VERIFYING_PRD_COVERAGE'
      ensureActivePhaseAttempt(ticket.id, phase)
      upsertLatestPhaseArtifact(ticket.id, 'prd_winner', 'REFINING_PRD', JSON.stringify({ winnerId: 'test/model' }))
      blockTicketWithContinuableError(ticket.id, phase, 'ses-continue', {
        step: 'revision',
        memberId: checkpointState === 'wrong-member' ? 'test/other-model' : 'test/model',
        phaseAttempt: checkpointState === 'wrong-session-attempt' ? 2 : undefined,
      })

      const content = JSON.stringify({
        candidateVersion: 1,
        refinedContent: 'saved candidate',
        auditResult: { envelope: { status: 'gaps', gaps: ['Missing acceptance check'] } },
      })
      if (checkpointState === 'damaged') {
        upsertLatestPhaseArtifact(ticket.id, 'prd_coverage_input', phase, '{')
      } else if (checkpointState === 'other-attempt') {
        const context = getTicketContext(ticket.id)!
        context.projectDb.insert(phaseArtifacts).values({
          ticketId: context.localTicketId,
          phase,
          phaseAttempt: 2,
          artifactType: 'prd_coverage_input',
          content,
        }).run()
      }

      expect(getTicketByRef(ticket.id)?.availableActions).not.toContain('continue')
    },
  )

  it('advertises coverage Continue when the revision checkpoint matches the active session', () => {
    const { ticket } = setupContinueTicketApp()
    const phase = 'VERIFYING_PRD_COVERAGE'
    ensureActivePhaseAttempt(ticket.id, phase)
    upsertLatestPhaseArtifact(ticket.id, 'prd_winner', 'REFINING_PRD', JSON.stringify({ winnerId: 'test/model' }))
    upsertLatestPhaseArtifact(ticket.id, 'prd_coverage_input', phase, JSON.stringify({
      candidateVersion: 1,
      refinedContent: 'saved candidate',
      auditResult: { envelope: { status: 'gaps', gaps: ['Missing acceptance check'] } },
    }))
    blockTicketWithContinuableError(ticket.id, phase, 'ses-continue', { step: 'revision', memberId: 'test/model' })

    expect(getTicketByRef(ticket.id)?.availableActions).toContain('continue')
  })

  it.each(['missing', 'damaged', 'different-base', 'different-candidate', 'wrong-member', 'overlapping-decisions'] as const)(
    'hides pull-request draft Continue when its checkpoint or session identity is %s',
    (checkpointState) => {
      const { ticket } = setupContinueTicketApp()
      const phase = 'CREATING_PULL_REQUEST'
      ensureActivePhaseAttempt(ticket.id, 'INTEGRATING_CHANGES')
      ensureActivePhaseAttempt(ticket.id, phase)
      patchTicket(ticket.id, { lockedMainImplementer: 'test/model' })
      upsertLatestPhaseArtifact(ticket.id, 'integration_report', 'INTEGRATING_CHANGES', JSON.stringify({
        status: 'passed', mergeBase: 'base123', candidateCommitSha: 'candidate123',
      }))
      blockTicketWithContinuableError(ticket.id, phase, 'ses-continue', {
        step: 'pull_request_draft',
        memberId: checkpointState === 'wrong-member' ? 'test/other-model' : 'test/model',
      })

      if (checkpointState === 'damaged') {
        upsertLatestPhaseArtifact(ticket.id, 'candidate_file_audit', phase, '{')
      } else if (checkpointState !== 'missing') {
        upsertLatestPhaseArtifact(ticket.id, 'candidate_file_audit', phase, JSON.stringify({
          baseCommit: checkpointState === 'different-base' ? 'other-base' : 'base123',
          candidateCommitSha: checkpointState === 'different-candidate' ? 'other-candidate' : 'candidate123',
          status: 'passed',
          includedFiles: ['src/example.ts'],
          excludedFiles: checkpointState === 'overlapping-decisions' ? ['src/example.ts'] : [],
          entries: checkpointState === 'overlapping-decisions'
            ? [
              { path: 'src/example.ts', decision: 'include', reason: 'Requested implementation.' },
              { path: 'src/example.ts', decision: 'exclude', reason: 'Out of scope.' },
            ]
            : [{ path: 'src/example.ts', decision: 'include', reason: 'Requested implementation.' }],
        }))
      }

      expect(getTicketByRef(ticket.id)?.availableActions).not.toContain('continue')
    },
  )

  it('advertises pull-request draft Continue when the audit matches the latest candidate', () => {
    const { ticket } = setupContinueTicketApp()
    const phase = 'CREATING_PULL_REQUEST'
    ensureActivePhaseAttempt(ticket.id, 'INTEGRATING_CHANGES')
    ensureActivePhaseAttempt(ticket.id, phase)
    patchTicket(ticket.id, { lockedMainImplementer: 'test/model' })
    upsertLatestPhaseArtifact(ticket.id, 'integration_report', 'INTEGRATING_CHANGES', JSON.stringify({
      status: 'passed', mergeBase: 'base123', candidateCommitSha: 'candidate123',
    }))
    upsertLatestPhaseArtifact(ticket.id, 'candidate_file_audit', phase, JSON.stringify({
      baseCommit: 'base123',
      candidateCommitSha: 'candidate123',
      status: 'passed',
      includedFiles: ['src/example.ts'],
      excludedFiles: [],
      entries: [{ path: 'src/example.ts', decision: 'include', reason: 'Requested implementation.' }],
    }))
    blockTicketWithContinuableError(ticket.id, phase, 'ses-continue', {
      step: 'pull_request_draft',
      memberId: 'test/model',
    })

    expect(getTicketByRef(ticket.id)?.availableActions).toContain('continue')
  })

  it('clears a pending continuation if dispatching CONTINUE fails', async () => {
    const { app, ticket } = setupContinueTicketApp()
    blockTicketWithContinuableError(ticket.id, 'PREPARING_EXECUTION_ENV')
    const dispatchError = new Error('actor stopped before continuation')
    vi.mocked(sendTicketEvent).mockImplementationOnce(() => { throw dispatchError })

    const response = await app.request(`/api/tickets/${ticket.id}/continue`, { method: 'POST' })
    const body = await response.json() as { error?: string; details?: string }

    expect(response.status).toBe(500)
    expect(body).toEqual({ error: 'Failed to continue ticket', details: dispatchError.message })
    expect(hasPendingSessionContinuationForTicketPhase(ticket.id, 'PREPARING_EXECUTION_ENV')).toBe(false)
    expect(getTicketByRef(ticket.id)?.status).toBe('BLOCKED_ERROR')
  })

  it('withholds Continue when the old turn cannot be confirmed stopped', async () => {
    const { app, ticket } = setupContinueTicketApp()
    ensureActivePhaseAttempt(ticket.id, 'PREPARING_EXECUTION_ENV')
    blockTicketWithContinuableError(ticket.id, 'PREPARING_EXECUTION_ENV')
    abortSessionMock.mockResolvedValueOnce(false)

    const response = await app.request(`/api/tickets/${ticket.id}/continue`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(abortSessionMock).toHaveBeenCalledWith('ses-continue')
    expect(sendTicketEvent).not.toHaveBeenCalled()
    expect(hasPendingSessionContinuationForTicketPhase(ticket.id, 'PREPARING_EXECUTION_ENV')).toBe(false)
    expect(getTicketByRef(ticket.id)?.status).toBe('BLOCKED_ERROR')
  })

  it('continues when OpenCode list omits a preserved session that exact lookup can still read', async () => {
    const { app, ticket } = setupContinueTicketApp()
    ensureActivePhaseAttempt(ticket.id, 'PREPARING_EXECUTION_ENV')
    blockTicketWithContinuableError(ticket.id, 'PREPARING_EXECUTION_ENV')
    listSessionsMock.mockResolvedValue([])
    getSessionMock.mockResolvedValue({ id: 'ses-continue', projectPath: '/tmp/project' })

    const response = await app.request(`/api/tickets/${ticket.id}/continue`, { method: 'POST' })

    expect(response.status).toBe(200)
    expect(getSessionMock).toHaveBeenCalledWith('ses-continue')
    expect(listSessionsMock).not.toHaveBeenCalled()
    expect(sendTicketEvent).toHaveBeenCalledWith(ticket.id, { type: 'CONTINUE' })
    expect(getTicketByRef(ticket.id)?.status).toBe('PREPARING_EXECUTION_ENV')
  })

  it('allows continue for HTTP 402 provider blocks with a preserved active session', async () => {
    const { app, ticket } = setupContinueTicketApp()
    const previousStatus = 'VERIFYING_PRD_COVERAGE'
    upsertLatestPhaseArtifact(ticket.id, 'prd_winner', 'REFINING_PRD', JSON.stringify({ winnerId: 'test/model' }))
    ensureActivePhaseAttempt(ticket.id, previousStatus)
    recordTicketErrorOccurrence(ticket.id, {
      blockedFromStatus: previousStatus,
      errorMessage: 'Payment Required: {"detail":{"code":"deactivated_workspace"}} (HTTP 402)',
      errorCodes: ['OPENCODE_PROVIDER_ERROR'],
      diagnostics: {
        kind: 'opencode_provider',
        source: 'provider',
        summary: 'Payment Required: {"detail":{"code":"deactivated_workspace"}} (HTTP 402)',
        sessionId: 'ses-continue',
        statusCode: 402,
        isRetryable: false,
        responseBodyPreview: '{"detail":{"code":"deactivated_workspace"}}',
      },
    })
    patchTicket(ticket.id, {
      status: 'BLOCKED_ERROR',
      xstateSnapshot: JSON.stringify({ context: { previousStatus } }),
      errorMessage: 'Payment Required: {"detail":{"code":"deactivated_workspace"}} (HTTP 402)',
    })
    insertActiveOpenCodeSession(ticket.id, previousStatus, 'ses-continue', { step: 'audit', memberId: 'test/model' })
    expect(getTicketByRef(ticket.id)?.availableActions).toContain('continue')

    const response = await app.request(`/api/tickets/${ticket.id}/continue`, { method: 'POST' })

    expect(response.status).toBe(200)
    expect(sendTicketEvent).toHaveBeenCalledWith(ticket.id, { type: 'CONTINUE' })
    expect(hasPendingSessionContinuationForTicketPhase(ticket.id, previousStatus)).toBe(true)
    expect(getTicketByRef(ticket.id)?.status).toBe(previousStatus)
  })

  it.each([401, 403])('continues the existing session after fixing an OpenCode server HTTP %s login failure', async (statusCode) => {
    const { app, ticket } = setupContinueTicketApp()
    const previousStatus = 'PREPARING_EXECUTION_ENV'
    ensureActivePhaseAttempt(ticket.id, previousStatus)
    const errorMessage = 'OpenCode server authentication failed: configured password rejected'
    recordTicketErrorOccurrence(ticket.id, {
      blockedFromStatus: previousStatus, errorMessage, errorCodes: [],
      diagnostics: { kind: 'opencode_session', source: 'opencode', summary: errorMessage, sessionId: 'ses-continue', statusCode },
    })
    patchTicket(ticket.id, { status: 'BLOCKED_ERROR', xstateSnapshot: JSON.stringify({ context: { previousStatus } }), errorMessage })
    insertActiveOpenCodeSession(ticket.id, previousStatus)
    expect(getTicketByRef(ticket.id)?.availableActions).toContain('continue')

    const response = await app.request(`/api/tickets/${ticket.id}/continue`, { method: 'POST' })

    expect(response.status).toBe(200)
    expect(getSessionMock).toHaveBeenCalledWith('ses-continue')
    expect(sendTicketEvent).toHaveBeenCalledWith(ticket.id, { type: 'CONTINUE' })
    expect(hasPendingSessionContinuationForTicketPhase(ticket.id, previousStatus)).toBe(true)
    expect(getTicketByRef(ticket.id)?.status).toBe(previousStatus)
    expect(listPhaseAttempts(ticket.id, previousStatus)).toEqual([expect.objectContaining({ attemptNumber: 1, state: 'active' })])
  })

  it('rejects continue when no matching active OpenCode session row is preserved', async () => {
    const { app, ticket } = setupContinueTicketApp()
    const previousStatus = 'PREPARING_EXECUTION_ENV'
    recordTicketErrorOccurrence(ticket.id, {
      blockedFromStatus: previousStatus,
      errorMessage: 'Usage limit has been reached.',
      errorCodes: [],
      diagnostics: {
        kind: 'opencode_provider',
        source: 'provider',
        summary: 'usage limit has been reached',
        sessionId: 'ses-continue',
        statusCode: 429,
        isRetryable: true,
      },
    })
    patchTicket(ticket.id, {
      status: 'BLOCKED_ERROR',
      xstateSnapshot: JSON.stringify({ context: { previousStatus } }),
      errorMessage: 'Usage limit has been reached.',
    })

    const response = await app.request(`/api/tickets/${ticket.id}/continue`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(getTicketByRef(ticket.id)?.availableActions).not.toContain('continue')
    expect(sendTicketEvent).not.toHaveBeenCalled()
  })

  it('rejects continue for non-blocked tickets', async () => {
    const { app, ticket } = setupContinueTicketApp()

    const response = await app.request(`/api/tickets/${ticket.id}/continue`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(sendTicketEvent).not.toHaveBeenCalled()
  })

  it('rejects continue when previous status is missing', async () => {
    const { app, ticket } = setupContinueTicketApp()
    patchTicket(ticket.id, {
      status: 'BLOCKED_ERROR',
      xstateSnapshot: JSON.stringify({ context: {} }),
      errorMessage: 'Missing previous status',
    })

    const response = await app.request(`/api/tickets/${ticket.id}/continue`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(sendTicketEvent).not.toHaveBeenCalled()
  })

  it('rejects ineligible diagnostics', async () => {
    const { app, ticket } = setupContinueTicketApp()
    const previousStatus = 'PREPARING_EXECUTION_ENV'
    recordTicketErrorOccurrence(ticket.id, {
      blockedFromStatus: previousStatus,
      errorMessage: 'Authentication failed.',
      errorCodes: ['OPENCODE_PROVIDER_AUTH_FAILED'],
      diagnostics: {
        kind: 'opencode_provider',
        source: 'provider',
        summary: 'Authentication failed: API key is invalid.',
        sessionId: 'ses-continue',
        statusCode: 401,
        isRetryable: false,
      },
    })
    patchTicket(ticket.id, {
      status: 'BLOCKED_ERROR',
      xstateSnapshot: JSON.stringify({ context: { previousStatus } }),
      errorMessage: 'Authentication failed.',
    })
    insertActiveOpenCodeSession(ticket.id, previousStatus)

    const response = await app.request(`/api/tickets/${ticket.id}/continue`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(sendTicketEvent).not.toHaveBeenCalled()
  })

  it('rejects continue when another ticket occupies the execution band', async () => {
    const { app, project, ticket } = setupContinueTicketApp()
    const otherTicket = createTicket({
      projectId: project.id,
      title: 'Other execution ticket',
      description: 'Already in coding.',
    })
    patchTicket(otherTicket.id, { status: 'CODING' })
    blockTicketWithContinuableError(ticket.id, 'PREPARING_EXECUTION_ENV')

    const response = await app.request(`/api/tickets/${ticket.id}/continue`, { method: 'POST' })
    const body = await response.json() as { error: string }

    expect(response.status).toBe(409)
    expect(body.error).toBe(
      `${ticket.externalId} can’t enter execution yet because ${otherTicket.externalId} is still running and currently at Implementing. Configured limitation in LoopTroop alpha: Each project may have only one active ticket in the execution band at a time. Finish or cancel ${otherTicket.externalId}, then try again.`,
    )
    expect(sendTicketEvent).not.toHaveBeenCalled()
  })

  it('rejects continue when exact OpenCode lookup says the preserved session is gone', async () => {
    const { app, ticket } = setupContinueTicketApp()
    blockTicketWithContinuableError(ticket.id, 'PREPARING_EXECUTION_ENV')
    getSessionMock.mockResolvedValue(null)

    const response = await app.request(`/api/tickets/${ticket.id}/continue`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(getTicketByRef(ticket.id)?.status).toBe('BLOCKED_ERROR')
    expect(sendTicketEvent).not.toHaveBeenCalled()
  })

  it('reports verification errors when exact OpenCode lookup fails', async () => {
    const { app, ticket } = setupContinueTicketApp()
    blockTicketWithContinuableError(ticket.id, 'PREPARING_EXECUTION_ENV')
    getSessionMock.mockRejectedValue(new Error('OpenCode is unreachable'))

    const response = await app.request(`/api/tickets/${ticket.id}/continue`, { method: 'POST' })
    const body = await response.json() as { error?: string; details?: string }

    expect(response.status).toBe(500)
    expect(body.error).toBe('Continue is not available because the OpenCode session could not be verified')
    expect(body.details).toContain('OpenCode is unreachable')
    expect(getTicketByRef(ticket.id)?.status).toBe('BLOCKED_ERROR')
    expect(sendTicketEvent).not.toHaveBeenCalled()
  })
})
