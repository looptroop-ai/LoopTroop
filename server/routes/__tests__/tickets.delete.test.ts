import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import { createTicket, getTicketByRef, patchTicket } from '../../storage/tickets'
import { ensureActivePhaseAttempt } from '../../storage/ticketPhaseAttempts'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { initializeTicket } from '../../ticket/initialize'

vi.mock('../../workflow/runner', () => ({
  cancelTicket: vi.fn(),
  // Both submission paths take the claim, so the double has to offer it.
  claimInterviewBatch: vi.fn(() => true),
  releaseInterviewBatch: vi.fn(),
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

import { ticketRouter } from '../tickets'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-route-delete-',
  files: {
    'README.md': '# LoopTroop Ticket Route Delete Test\n',
  },
})

describe('ticketRouter DELETE /tickets/:id', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('deletes a terminal ticket after removing its worktree without recreating the reserved path', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Delete route',
      description: 'Regression coverage for lifecycle cleanup.',
    })

    const init = await initializeTicket({
      projectFolder: repoDir,
      externalId: ticket.externalId,
    })

    patchTicket(ticket.id, {
      status: 'COMPLETED',
      branchName: init.branchName,
    })

    const app = new Hono()
    app.route('/api', ticketRouter)

    const worktreePath = init.worktreePath
    const executionLogPath = `${init.ticketDir}/runtime/execution-log.jsonl`
    const debugLogPath = `${init.ticketDir}/runtime/execution-log.debug.jsonl`
    const aiLogPath = `${init.ticketDir}/runtime/execution-log.ai.jsonl`
    mkdirSync(dirname(debugLogPath), { recursive: true })
    writeFileSync(debugLogPath, '{"type":"debug"}\n')
    writeFileSync(aiLogPath, '{"audience":"ai"}\n')

    expect(existsSync(worktreePath)).toBe(true)

    const response = await app.request(`/api/tickets/${ticket.id}`, {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { success?: boolean; ticketId?: string }
    expect(payload).toEqual({
      success: true,
      ticketId: ticket.id,
    })

    expect(getTicketByRef(ticket.id)).toBeUndefined()
    expect(existsSync(worktreePath)).toBe(false)
    expect(existsSync(executionLogPath)).toBe(false)
    expect(existsSync(debugLogPath)).toBe(false)
    expect(existsSync(aiLogPath)).toBe(false)

    const branchResult = spawnSync('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', `refs/heads/${ticket.externalId}`], {
      encoding: 'utf8',
    })
    expect(branchResult.status).not.toBe(0)
  })

  it('deletes a ticket that has phase attempts without a foreign-key constraint failure', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop FK',
      shortname: 'FK',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'FK regression',
      description: 'Ensure ticket_phase_attempts rows are deleted before the ticket row.',
    })

    await initializeTicket({ projectFolder: repoDir, externalId: ticket.externalId })

    // Create a phase attempt row (the child that previously caused FK constraint failures).
    ensureActivePhaseAttempt(ticket.id, 'WAITING_INTERVIEW_APPROVAL')

    patchTicket(ticket.id, { status: 'CANCELED' })

    const app = new Hono()
    app.route('/api', ticketRouter)

    const response = await app.request(`/api/tickets/${ticket.id}`, { method: 'DELETE' })

    expect(response.status).toBe(200)
    const payload = await response.json() as { success?: boolean }
    expect(payload.success).toBe(true)
    expect(getTicketByRef(ticket.id)).toBeUndefined()
  })
})
