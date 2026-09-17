import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { SkipEvent, SkipEventCounts } from '@shared/skipReceipt'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import {
  archiveActivePhaseAttempts,
  createFreshPhaseAttempts,
  createTicket,
  ensureActivePhaseAttempt,
  patchTicket,
} from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { initializeTicket } from '../../ticket/initialize'
import { writeSkipReceipts } from '../../workflow/skipReceipts'
import { ticketRouter } from '../tickets'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-route-skips-',
  files: {
    'README.md': '# LoopTroop Ticket Skips Route Test\n',
  },
})

async function setupTicket() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({ folderPath: repoDir, name: 'LoopTroop', shortname: 'LOOP' })
  const ticket = createTicket({
    projectId: project.id,
    title: 'Skips route',
    description: 'The audit trail is readable over HTTP.',
  })
  const init = await initializeTicket({ projectFolder: repoDir, externalId: ticket.externalId })
  patchTicket(ticket.id, { status: 'WAITING_INTERVIEW_ANSWERS', branchName: init.branchName })

  const app = new Hono()
  app.route('/api', ticketRouter)
  return { app, ticket }
}

describe('ticketRouter GET /tickets/:id/skips', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('returns the whole ticket, including receipts from archived attempts', async () => {
    const { app, ticket } = await setupTicket()
    ensureActivePhaseAttempt(ticket.id, 'WAITING_INTERVIEW_ANSWERS')
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_all',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'attempt-one',
      summary: { itemType: 'interview_batch', reason: 'Shipping before the demo.' },
      items: [
        { itemId: 'Q01', reason: 'Answered in the description.' },
        { itemId: 'Q02', reason: null },
      ],
    })

    archiveActivePhaseAttempts(ticket.id, ['WAITING_INTERVIEW_ANSWERS'], 'test_retry')
    createFreshPhaseAttempts(ticket.id, ['WAITING_INTERVIEW_ANSWERS'])
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_question',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'attempt-two',
      items: [{ itemId: 'Q03', reason: 'Out of scope.' }],
    })

    const response = await app.request(`/api/tickets/${ticket.id}/skips`)
    expect(response.status).toBe(200)

    const payload = await response.json() as { events: SkipEvent[]; counts: SkipEventCounts }
    expect(payload.events.map((event) => event.itemId)).toEqual([null, 'Q01', 'Q02', 'Q03'])
    // Two actions, three items — the bulk summary row is not a fourth skip.
    expect(payload.counts).toEqual({
      actions: 2,
      items: 3,
      itemsWithReason: 2,
      itemsWithoutReason: 1,
    })
  })

  it('filters to a single surface and refuses an unknown one', async () => {
    const { app, ticket } = await setupTicket()
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_question',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId: 'one',
      items: [{ itemId: 'Q01', reason: 'A reason.' }],
    })

    const filtered = await app.request(`/api/tickets/${ticket.id}/skips?surfaces=cancel_ticket`)
    expect((await filtered.json() as { events: SkipEvent[] }).events).toEqual([])

    const rejected = await app.request(`/api/tickets/${ticket.id}/skips?surfaces=not_a_surface`)
    expect(rejected.status).toBe(400)
  })

  it('returns 404 for a ticket that does not exist', async () => {
    const { app } = await setupTicket()
    const response = await app.request('/api/tickets/1:MISSING-9/skips')
    expect(response.status).toBe(404)
  })

  it.each(['', 'has spaces', ':starts-with-punctuation', 'ümlaut', 'a'.repeat(161)])('rejects UI state action IDs outside the Manual QA contract: %j', async (actionId) => {
    const { app, ticket } = await setupTicket()
    const response = await app.request(`/api/tickets/${ticket.id}/ui-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'manual-qa', data: {}, expectedRevision: null, actionId }),
    })

    expect(response.status).toBe(400)
  })

  it('accepts the Manual QA action ID charset and 160-character limit at the real UI-state route', async () => {
    const { app, ticket } = await setupTicket()
    const actionId = `manual-qa_submit:v1.${'x'.repeat(140)}`
    expect(actionId).toHaveLength(160)
    const response = await app.request(`/api/tickets/${ticket.id}/ui-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'manual-qa', data: { ready: true }, expectedRevision: null, actionId }),
    })

    expect(response.status).toBe(200)
  })
})
