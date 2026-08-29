import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import { createTicket } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { MockOpenCodeAdapter } from '../../opencode/adapter'
import { SessionManager } from '../../opencode/sessionManager'
import { listSkipEvents } from '../../workflow/skipReceipts'
import {
  getPendingQuestionSummary,
  resetAllQuestionWindows,
} from '../../workflow/questionWindows'
import { isTicketWorkSuspended, resetAllWorkBudgets } from '../../workflow/workBudget'
import { ticketRouter } from '../tickets'

const adapter = new MockOpenCodeAdapter()
vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => adapter,
  isMockOpenCodeMode: () => true,
  resetOpenCodeAdapter: () => undefined,
}))

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-question-routes-',
  files: { 'README.md': '# LoopTroop AI Question Routes Test\n' },
})

const QUESTIONS = [
  { question: 'Which database?', header: 'Storage', options: [{ label: 'SQLite', description: 'Local file' }] },
  { question: 'Which port?', header: 'Port', options: [], custom: true },
]

/**
 * A ticket with a live session and one question outstanding on it.
 *
 * Built through the real session manager and the real adapter rather than by
 * poking the window store, because the defect these tests exist for lived
 * entirely in the seam between the route and the store — the unit tests called
 * the store directly and so could never see it.
 */
async function createTicketWithQuestion(requestId = 'req_route') {
  const project = attachProject({
    folderPath: repoManager.createRepo(),
    name: 'Question Routes',
    shortname: 'QR',
  })
  const ticket = createTicket({
    projectId: project.id,
    title: 'A model has a question',
    description: 'Regression coverage for the answer and skip routes.',
  })
  const session = await new SessionManager(adapter)
    .createSessionForPhase(ticket.id, 'CODING', 1, 'anthropic/claude')
  adapter.mockQuestions.push({
    id: requestId,
    sessionID: session.id,
    questions: QUESTIONS,
  } as (typeof adapter.mockQuestions)[number])
  return { ticket, session }
}

describe('ticketRouter OpenCode questions', () => {
  const app = new Hono()
  app.route('/api', ticketRouter)

  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
    resetAllQuestionWindows()
    resetAllWorkBudgets()
    adapter.mockQuestions = []
    adapter.questionReplies = []
    adapter.questionRejections = []
    adapter.failRejectQuestion = false
    adapter.sessions = []
  })

  afterEach(() => {
    resetAllQuestionWindows()
    resetAllWorkBudgets()
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('answers the question and closes it out locally', async () => {
    const { ticket } = await createTicketWithQuestion()
    // Listing is what arms the window, exactly as the panel does on mount.
    await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/opencode/questions`)
    expect(isTicketWorkSuspended(ticket.id)).toBe(true)

    const res = await app.request(
      `/api/tickets/${encodeURIComponent(ticket.id)}/opencode/questions/req_route/reply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [['SQLite'], ['8080']] }),
      },
    )

    expect(res.status).toBe(200)
    expect(adapter.questionReplies.map((entry) => entry.requestId)).toEqual(['req_route'])
    // The half that used to be missed. The route claimed the request before
    // calling OpenCode, then tried to claim it a second time to finish it —
    // which could never succeed, so the request stayed `resolving` forever and
    // the ticket's clocks stayed suspended with it.
    expect(getPendingQuestionSummary(ticket.id)).toBeNull()
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)
  })

  it('skips the question, resumes the clocks and files a receipt', async () => {
    const { ticket } = await createTicketWithQuestion()
    await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/opencode/questions`)

    const res = await app.request(
      `/api/tickets/${encodeURIComponent(ticket.id)}/opencode/questions/req_route/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'I do not know either.' }),
      },
    )

    expect(res.status).toBe(200)
    expect(adapter.questionRejections.map((entry) => entry.requestId)).toEqual(['req_route'])
    expect(getPendingQuestionSummary(ticket.id)).toBeNull()
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)

    const events = listSkipEvents(ticket.id).filter((event) => event.surface === 'opencode_question')
    const summary = events.find((event) => event.isActionSummary)
    expect(summary?.skippedBy).toBe('user')
    expect(summary?.reason).toBe('I do not know either.')
    expect(summary?.questionContext?.expiry_reason).toBe('user_skipped')
  })

  it('hands the claim back when OpenCode will not take the answer', async () => {
    const { ticket } = await createTicketWithQuestion()
    await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/opencode/questions`)
    adapter.failRejectQuestion = true

    const res = await app.request(
      `/api/tickets/${encodeURIComponent(ticket.id)}/opencode/questions/req_route/reject`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    )

    expect(res.status).toBe(500)
    // Still answerable. A failed send that swallowed the request would leave a
    // question on screen that nothing could ever resolve.
    expect(getPendingQuestionSummary(ticket.id)?.requestCount).toBe(1)
    expect(isTicketWorkSuspended(ticket.id)).toBe(true)
  })

  it('refuses a second verdict for a question that already has one', async () => {
    const { ticket } = await createTicketWithQuestion()
    await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/opencode/questions`)
    const path = `/api/tickets/${encodeURIComponent(ticket.id)}/opencode/questions/req_route/reply`
    const body = JSON.stringify({ answers: [['SQLite'], ['8080']] })

    const first = await app.request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    const second = await app.request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(404)
    expect(adapter.questionReplies).toHaveLength(1)
  })

  it('stops the clock idempotently and never resumes it', async () => {
    const { ticket } = await createTicketWithQuestion()
    await app.request(`/api/tickets/${encodeURIComponent(ticket.id)}/opencode/questions`)
    const path = `/api/tickets/${encodeURIComponent(ticket.id)}/opencode/question-timer/stop`

    const first = await app.request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    const firstBody = await first.json() as { timer?: { stoppedAt?: string; revision?: number } }
    const second = await app.request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    const secondBody = await second.json() as { timer?: { stoppedAt?: string; revision?: number } }

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(firstBody.timer?.stoppedAt).toBeTruthy()
    // A keystroke is not a failure, and it is not a second stop either.
    expect(secondBody.timer?.stoppedAt).toBe(firstBody.timer?.stoppedAt)
    expect(secondBody.timer?.revision).toBe(firstBody.timer?.revision)
  })
})
