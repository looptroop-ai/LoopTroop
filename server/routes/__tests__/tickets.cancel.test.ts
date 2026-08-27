import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import { createTicket, DISPLAY_ONLY_MOCK_BRANCH_NAME, getTicketByRef, patchTicket } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { initializeTicket } from '../../ticket/initialize'
import { getTicketAiLogPath, getTicketDebugLogPath, getTicketExecutionLogPath } from '../../storage/paths'
import { listSkipEvents } from '../../workflow/skipReceipts'

vi.mock('../../workflow/runner', () => ({
  cancelTicket: vi.fn(),
  handleInterviewQABatch: vi.fn(),
  processInterviewBatchAsync: vi.fn(async () => undefined),
  skipAllInterviewQuestionsToApproval: vi.fn(),
}))

vi.mock('../../opencode/sessionManager', () => ({
  abortTicketSessions: vi.fn(async () => undefined),
}))

vi.mock('../../opencode/contextBuilder', () => ({
  clearContextCache: vi.fn(),
}))

vi.mock('../../machines/persistence', () => ({
  createTicketActor: vi.fn(),
  ensureActorForTicket: vi.fn(() => ({ id: 'mock-actor' })),
  revertTicketToApprovalStatus: vi.fn(),
  sendTicketEvent: vi.fn(),
  getTicketState: vi.fn(() => null),
  stopActor: vi.fn(() => true),
}))

import { ensureActorForTicket, sendTicketEvent } from '../../machines/persistence'
import { ticketRouter } from '../tickets'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-route-cancel-',
  files: {
    'README.md': '# LoopTroop Ticket Route Cancel Test\n',
  },
})

function createCancelableTicket(repoDir: string) {
  const project = attachProject({
    folderPath: repoDir,
    name: 'CancelTest',
    shortname: 'CNCL',
  })
  const ticket = createTicket({
    projectId: project.id,
    title: 'Cancel route test',
    description: 'Regression coverage for cancel cleanup.',
  })
  const init = initializeTicket({
    projectFolder: repoDir,
    externalId: ticket.externalId,
  })
  patchTicket(ticket.id, {
    status: 'DRAFTING_PRD',
    branchName: init.branchName,
  })
  // Write a real execution log file so we can assert it exists/is removed.
  const logPath = getTicketExecutionLogPath(repoDir, ticket.externalId)
  const debugLogPath = getTicketDebugLogPath(repoDir, ticket.externalId)
  const aiLogPath = getTicketAiLogPath(repoDir, ticket.externalId)
  mkdirSync(dirname(logPath), { recursive: true })
  writeFileSync(logPath, '{"type":"test"}\n')
  writeFileSync(debugLogPath, '{"type":"debug"}\n')
  writeFileSync(aiLogPath, '{"audience":"ai"}\n')
  return { project, ticket, init }
}

describe('ticketRouter POST /tickets/:id/cancel', () => {
  const app = new Hono()
  app.route('/api', ticketRouter)

  beforeEach(() => {
    vi.clearAllMocks()
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('cancels a ticket without cleanup when no body is sent', async () => {
    const repoDir = repoManager.createRepo()
    const { ticket, init } = createCancelableTicket(repoDir)
    const worktreePath = init.worktreePath

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as Record<string, unknown>
    expect(payload.message).toBe('Cancel action accepted')

    // Ticket still exists in DB.
    expect(getTicketByRef(ticket.id)).toBeDefined()
    // Worktree is preserved.
    expect(existsSync(worktreePath)).toBe(true)
    // Execution log is preserved.
    const logPath = getTicketExecutionLogPath(repoDir, ticket.externalId)
    const debugLogPath = getTicketDebugLogPath(repoDir, ticket.externalId)
    const aiLogPath = getTicketAiLogPath(repoDir, ticket.externalId)
    expect(existsSync(logPath)).toBe(true)
    expect(existsSync(debugLogPath)).toBe(true)
    expect(existsSync(aiLogPath)).toBe(true)
  })

  it('removes only the execution logs when deleteLog=true and deleteContent=false', async () => {
    const repoDir = repoManager.createRepo()
    const { ticket, init } = createCancelableTicket(repoDir)
    const logPath = getTicketExecutionLogPath(repoDir, ticket.externalId)
    const debugLogPath = getTicketDebugLogPath(repoDir, ticket.externalId)
    const aiLogPath = getTicketAiLogPath(repoDir, ticket.externalId)

    expect(existsSync(logPath)).toBe(true)
    expect(existsSync(debugLogPath)).toBe(true)
    expect(existsSync(aiLogPath)).toBe(true)

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteContent: false, deleteLog: true }),
    })

    expect(response.status).toBe(200)
    // Ticket still exists.
    expect(getTicketByRef(ticket.id)).toBeDefined()
    // Worktree still exists.
    expect(existsSync(init.worktreePath)).toBe(true)
    // Logs are removed.
    expect(existsSync(logPath)).toBe(false)
    expect(existsSync(debugLogPath)).toBe(false)
    expect(existsSync(aiLogPath)).toBe(false)
  })

  it('removes the worktree and branch when deleteContent=true', async () => {
    const repoDir = repoManager.createRepo()
    const { ticket, init } = createCancelableTicket(repoDir)
    const logPath = getTicketExecutionLogPath(repoDir, ticket.externalId)
    const debugLogPath = getTicketDebugLogPath(repoDir, ticket.externalId)
    const aiLogPath = getTicketAiLogPath(repoDir, ticket.externalId)

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteContent: true, deleteLog: false }),
    })

    expect(response.status).toBe(200)
    // Ticket still exists in DB.
    expect(getTicketByRef(ticket.id)).toBeDefined()
    // Worktree is gone.
    expect(existsSync(init.worktreePath)).toBe(false)
    expect(existsSync(logPath)).toBe(false)
    expect(existsSync(debugLogPath)).toBe(false)
    expect(existsSync(aiLogPath)).toBe(false)
    // Branch is removed.
    const branchResult = spawnSync(
      'git',
      ['-C', repoDir, 'show-ref', '--verify', '--quiet', `refs/heads/${ticket.externalId}`],
      { encoding: 'utf8' },
    )
    expect(branchResult.status).not.toBe(0)
  })

  it('removes worktree and log when both deleteContent and deleteLog are true', async () => {
    const repoDir = repoManager.createRepo()
    const { ticket, init } = createCancelableTicket(repoDir)
    const logPath = getTicketExecutionLogPath(repoDir, ticket.externalId)
    const debugLogPath = getTicketDebugLogPath(repoDir, ticket.externalId)
    const aiLogPath = getTicketAiLogPath(repoDir, ticket.externalId)

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteContent: true, deleteLog: true }),
    })

    expect(response.status).toBe(200)
    expect(getTicketByRef(ticket.id)).toBeDefined()
    expect(existsSync(init.worktreePath)).toBe(false)
    expect(existsSync(logPath)).toBe(false)
    expect(existsSync(debugLogPath)).toBe(false)
    expect(existsSync(aiLogPath)).toBe(false)
  })

  it('completely deletes the ticket and all files when deleteTicket=true', async () => {
    const repoDir = repoManager.createRepo()
    const { ticket, init } = createCancelableTicket(repoDir)
    const logPath = getTicketExecutionLogPath(repoDir, ticket.externalId)
    const debugLogPath = getTicketDebugLogPath(repoDir, ticket.externalId)
    const aiLogPath = getTicketAiLogPath(repoDir, ticket.externalId)

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteTicket: true }),
    })

    expect(response.status).toBe(200)
    // The ticket record is completely deleted from DB.
    expect(getTicketByRef(ticket.id)).toBeUndefined()
    // Worktree and logs are gone.
    expect(existsSync(init.worktreePath)).toBe(false)
    expect(existsSync(logPath)).toBe(false)
    expect(existsSync(debugLogPath)).toBe(false)
    expect(existsSync(aiLogPath)).toBe(false)
  })


  it('keeps the cancel reason on the ticket row and in the skip trail', async () => {
    const repoDir = repoManager.createRepo()
    const { ticket } = createCancelableTicket(repoDir)

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Requirements changed before implementation started.' }),
    })

    expect(response.status).toBe(200)
    expect(getTicketByRef(ticket.id)?.cancelReason).toBe('Requirements changed before implementation started.')

    const events = listSkipEvents(ticket.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      surface: 'cancel_ticket',
      itemType: 'ticket',
      phase: 'DRAFTING_PRD',
      reason: 'Requirements changed before implementation started.',
    })
  })

  it('keeps the reason on the ticket row when the artifacts are deleted with it', async () => {
    const repoDir = repoManager.createRepo()
    const { ticket } = createCancelableTicket(repoDir)

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteContent: true, reason: 'Abandoned in favour of a smaller change.' }),
    })

    expect(response.status).toBe(200)
    // The column survives. The receipt does not, and the dialog promises exactly that.
    expect(getTicketByRef(ticket.id)?.cancelReason).toBe('Abandoned in favour of a smaller change.')
    expect(listSkipEvents(ticket.id)).toHaveLength(0)
  })

  it('rejects a malformed cancel payload instead of cancelling with defaults', async () => {
    const repoDir = repoManager.createRepo()
    const { ticket } = createCancelableTicket(repoDir)

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'x'.repeat(20_001) }),
    })

    expect(response.status).toBe(400)
    expect(getTicketByRef(ticket.id)?.status).toBe('DRAFTING_PRD')
    expect(sendTicketEvent).not.toHaveBeenCalled()
  })


  it('keeps receipts when only the logs are deleted', async () => {
    const repoDir = repoManager.createRepo()
    const { ticket } = createCancelableTicket(repoDir)

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteLog: true, reason: 'Wrong branch.' }),
    })

    expect(response.status).toBe(200)
    // deleteLog is a log redaction, not an artifact deletion. Both the column
    // and the receipt survive it.
    expect(getTicketByRef(ticket.id)?.cancelReason).toBe('Wrong branch.')
    expect(listSkipEvents(ticket.id)).toHaveLength(1)
    expect(existsSync(getTicketExecutionLogPath(repoDir, ticket.externalId))).toBe(false)
  })

  it('leaves no skip trail at all when the ticket itself is deleted', async () => {
    const repoDir = repoManager.createRepo()
    const { ticket } = createCancelableTicket(repoDir)

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteTicket: true, reason: 'Created by mistake.' }),
    })

    expect(response.status).toBe(200)
    // Nothing survives deleting the ticket, and the dialog does not pretend
    // otherwise — it disables the reason field entirely.
    expect(getTicketByRef(ticket.id)).toBeUndefined()
    expect(listSkipEvents(ticket.id)).toHaveLength(0)
  })

  it('normalizes a whitespace-only cancel reason to null', async () => {
    const repoDir = repoManager.createRepo()
    const { ticket } = createCancelableTicket(repoDir)

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '   \n  ' }),
    })

    expect(response.status).toBe(200)
    expect(getTicketByRef(ticket.id)?.cancelReason ?? null).toBeNull()
  })

  it('returns 404 when the ticket does not exist', async () => {
    const response = await app.request('/api/tickets/nonexistent-id/cancel', {
      method: 'POST',
    })
    expect(response.status).toBe(404)
  })

  it('returns 409 when trying to cancel a terminal ticket', async () => {
    const repoDir = repoManager.createRepo()
    const { ticket } = createCancelableTicket(repoDir)
    patchTicket(ticket.id, { status: 'CANCELED' })

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
    })
    expect(response.status).toBe(409)
  })

  it('cancels display-only mock tickets without hydrating workflow actors', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'MockCancel',
      shortname: 'MOCK',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Mock cancel route test',
      description: 'Display-only mock tickets should still be cancelable.',
    })
    patchTicket(ticket.id, {
      branchName: DISPLAY_ONLY_MOCK_BRANCH_NAME,
      status: 'SCANNING_RELEVANT_FILES',
      errorMessage: 'Synthetic progress state',
    })

    const response = await app.request(`/api/tickets/${ticket.id}/cancel`, {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as Record<string, unknown>
    expect(payload.message).toBe('Cancel action accepted')
    expect(payload.status).toBe('CANCELED')
    expect(getTicketByRef(ticket.id)).toMatchObject({
      status: 'CANCELED',
      isDisplayOnlyMock: true,
      availableActions: [],
      errorMessage: null,
    })
    expect(ensureActorForTicket).not.toHaveBeenCalled()
    expect(sendTicketEvent).not.toHaveBeenCalled()
  })
})
