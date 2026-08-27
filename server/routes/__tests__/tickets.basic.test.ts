import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject, type PublicProject } from '../../storage/projects'
import { createTicket, getLatestPhaseArtifact, getTicketByRef, insertPhaseArtifact, patchTicket, type PublicTicket } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'

vi.mock('../../workflow/runner', () => ({
  cancelTicket: vi.fn(),
  handleInterviewQABatch: vi.fn(),
  processInterviewBatchAsync: vi.fn(),
  skipAllInterviewQuestionsToApproval: vi.fn(),
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
import { handleInterviewQABatch } from '../../workflow/runner'
import { ticketRouter } from '../tickets'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-route-basic-',
  files: {
    'README.md': '# LoopTroop Ticket Basic Route Test\n',
  },
})

const app = new Hono()
app.route('/api', ticketRouter)

function createBasicTicket(input: {
  name?: string
  shortname?: string
  title?: string
  description?: string
  priority?: number
} = {}): { project: PublicProject; ticket: PublicTicket } {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: input.name ?? 'Basic Route',
    shortname: input.shortname ?? 'BASIC',
  })
  const ticket = createTicket({
    projectId: project.id,
    title: input.title ?? 'Basic route ticket',
    description: input.description ?? 'Characterization coverage for basic ticket routes.',
    priority: input.priority,
  })

  return { project, ticket }
}

describe('ticketRouter basic ticket routes', () => {
  beforeEach(() => {
    process.env.LOOPTROOP_OPENCODE_MODE = 'mock'
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
    vi.clearAllMocks()
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('lists tickets across projects and supports project filtering', async () => {
    const first = createBasicTicket({
      name: 'Basic Route One',
      shortname: 'BASICA',
      title: 'First listed ticket',
    })
    const second = createBasicTicket({
      name: 'Basic Route Two',
      shortname: 'BASICB',
      title: 'Second listed ticket',
    })

    const allResponse = await app.request('/api/tickets')

    expect(allResponse.status).toBe(200)
    const allTickets = await allResponse.json() as Array<{ id: string; projectId: number; title: string }>
    expect(allTickets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: first.ticket.id,
        projectId: first.project.id,
        title: 'First listed ticket',
      }),
      expect.objectContaining({
        id: second.ticket.id,
        projectId: second.project.id,
        title: 'Second listed ticket',
      }),
    ]))

    const filteredResponse = await app.request(`/api/tickets?projectId=${first.project.id}`)

    expect(filteredResponse.status).toBe(200)
    const filteredTickets = await filteredResponse.json() as Array<{ id: string; projectId: number }>
    expect(filteredTickets).toEqual([
      expect.objectContaining({
        id: first.ticket.id,
        projectId: first.project.id,
      }),
    ])

    const invalidResponse = await app.request('/api/tickets?project=not-a-number')

    expect(invalidResponse.status).toBe(400)
    expect(await invalidResponse.json()).toEqual({ error: 'Invalid project ID' })
  })

  it('returns a single ticket by id and 404 for a missing ticket', async () => {
    const { project, ticket } = createBasicTicket({
      title: 'Fetch me',
      description: 'Single ticket lookup.',
      priority: 4,
    })

    const response = await app.request(`/api/tickets/${ticket.id}`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: ticket.id,
      projectId: project.id,
      externalId: ticket.externalId,
      title: 'Fetch me',
      description: 'Single ticket lookup.',
      priority: 4,
      status: 'DRAFT',
    })

    const missingResponse = await app.request('/api/tickets/missing-ticket')

    expect(missingResponse.status).toBe(404)
    expect(await missingResponse.json()).toEqual({ error: 'Ticket not found' })
  })

  it('exposes cleanup warning summaries from the latest cleanup report', async () => {
    const { ticket } = createBasicTicket()
    insertPhaseArtifact(ticket.id, {
      phase: 'CLEANING_ENV',
      artifactType: 'cleanup_report',
      content: JSON.stringify({
        status: 'warning',
        removedDirs: [],
        removedFiles: [],
        preservedPaths: [],
        errors: ['Failed to remove .ticket/runtime/tmp: EBUSY'],
      }),
    })
    const cleanupReport = getLatestPhaseArtifact(ticket.id, 'cleanup_report', 'CLEANING_ENV')
    expect(cleanupReport).toBeDefined()

    const response = await app.request(`/api/tickets/${ticket.id}`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      cleanup: {
        status: 'warning',
        errorCount: 1,
        latestReportArtifactId: cleanupReport!.id,
      },
    })
  })

  it('patches editable ticket fields while protecting status changes', async () => {
    const { ticket } = createBasicTicket({
      title: 'Original title',
      description: 'Original description.',
      priority: 2,
    })

    const response = await app.request(`/api/tickets/${ticket.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Updated title',
        description: 'Updated description.',
        priority: 5,
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: ticket.id,
      title: 'Updated title',
      description: 'Updated description.',
      priority: 5,
      status: 'DRAFT',
    })
    expect(getTicketByRef(ticket.id)).toMatchObject({
      title: 'Updated title',
      description: 'Updated description.',
      priority: 5,
      status: 'DRAFT',
    })

    const protectedResponse = await app.request(`/api/tickets/${ticket.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'WAITING_INTERVIEW_ANSWERS' }),
    })

    expect(protectedResponse.status).toBe(403)
    expect(await protectedResponse.json()).toEqual({
      error: 'Status field is API-protected. Use workflow actions to change status.',
    })
    expect(getTicketByRef(ticket.id)?.status).toBe('DRAFT')
  })

  it('keeps direct interview answer submission disabled', async () => {
    const { ticket } = createBasicTicket()
    patchTicket(ticket.id, { status: 'WAITING_INTERVIEW_ANSWERS' })

    const response = await app.request(`/api/tickets/${ticket.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: 'Use batch answers.' }),
    })

    expect(response.status).toBe(410)
    expect(await response.json()).toEqual({
      error: 'Direct interview answer submission is no longer supported. Use /answer-batch instead.',
      ticketId: ticket.id,
      status: 'WAITING_INTERVIEW_ANSWERS',
    })
  })

  it('submits an interview answer batch through the synchronous mock route path', async () => {
    const { ticket } = createBasicTicket()
    patchTicket(ticket.id, { status: 'WAITING_INTERVIEW_ANSWERS' })
    vi.mocked(handleInterviewQABatch).mockResolvedValue({
      questions: [
        {
          id: 'Q02',
          phase: 'Follow-up',
          question: 'What should happen next?',
        },
      ],
      progress: { current: 2, total: 3 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Follow-up ready.',
      batchNumber: 2,
    })

    const response = await app.request(`/api/tickets/${ticket.id}/answer-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: {
          Q01: 'Keep the route behavior unchanged.',
        },
        selectedOptions: {
          Q01: ['preserve'],
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      questions: [
        {
          id: 'Q02',
          phase: 'Follow-up',
          question: 'What should happen next?',
        },
      ],
      progress: { current: 2, total: 3 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Follow-up ready.',
      batchNumber: 2,
    })
    expect(handleInterviewQABatch).toHaveBeenCalledWith(
      ticket.id,
      { Q01: 'Keep the route behavior unchanged.' },
      { Q01: ['preserve'] },
      {},
    )
    expect(ensureActorForTicket).toHaveBeenCalledWith(ticket.id)
    expect(sendTicketEvent).toHaveBeenCalledWith(ticket.id, {
      type: 'BATCH_ANSWERED',
      batchAnswers: { Q01: 'Keep the route behavior unchanged.' },
      selectedOptions: { Q01: ['preserve'] },
    })
  })
})
