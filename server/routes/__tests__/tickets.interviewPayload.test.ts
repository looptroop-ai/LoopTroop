import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import { createTicket, getLatestPhaseArtifact, patchTicket, upsertLatestPhaseArtifact } from '../../storage/tickets'
import {
  buildPersistedBatch,
  createInterviewSessionSnapshot,
  INTERVIEW_SESSION_ARTIFACT,
  parseInterviewSessionSnapshot,
  recordBatchAnswers,
  recordPreparedBatch,
  serializeInterviewSessionSnapshot,
} from '../../phases/interview/sessionState'
import { contentSha256 } from '../../lib/contentHash'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { ticketRouter } from '../tickets'

const repositories = createFixtureRepoManager({
  templatePrefix: 'looptroop-interview-payload-route-',
  files: { 'README.md': '# Interview payload route test\n' },
})

const app = new Hono()
app.route('/api', ticketRouter)

beforeEach(() => {
  clearProjectDatabaseCache()
  initializeDatabase()
  sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
})

afterAll(() => {
  clearProjectDatabaseCache()
  repositories.cleanup()
})

function createInterviewPayloadTicket() {
  const project = attachProject({
    folderPath: repositories.createRepo(),
    name: 'Interview payload',
    shortname: 'INTPAY',
  })
  return createTicket({
    projectId: project.id,
    title: 'Interview payload ticket',
    description: 'Exercise the interview read route.',
  })
}

describe('ticketRouter interview payload route', () => {
  it('returns 404 when the ticket does not exist', async () => {
    const response = await app.request('/api/tickets/missing-ticket/interview')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Ticket not found' })
  })

  it('returns an empty payload before interview artifacts exist', async () => {
    const ticket = createInterviewPayloadTicket()

    const response = await app.request(`/api/tickets/${ticket.id}/interview`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      winnerId: null,
      raw: null,
      contentSha256: null,
      document: null,
      session: null,
      questions: [],
    })
  })

  it('uses validated compiled content when no session is persisted', async () => {
    const ticket = createInterviewPayloadTicket()
    const refinedContent = 'questions:\n  - id: Q01\n    question: Why?\n'
    upsertLatestPhaseArtifact(ticket.id, 'interview_compiled', 'DRAFTING_PRD', JSON.stringify({
      winnerId: 'openai/gpt-5-mini',
      refinedContent,
      questions: [{ id: 'Q01', phase: 'Foundation', question: 'Why?' }],
      questionCount: 1,
    }))

    const response = await app.request(`/api/tickets/${ticket.id}/interview`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      winnerId: 'openai/gpt-5-mini',
      raw: refinedContent,
      contentSha256: contentSha256(refinedContent),
      document: null,
      session: null,
      questions: [],
    })
  })

  it('keeps the persisted session view and raw content if the compiled artifact is malformed', async () => {
    const ticket = createInterviewPayloadTicket()
    const base = createInterviewSessionSnapshot({
      winnerId: 'openai/session-winner',
      compiledQuestions: [{ id: 'Q01', phase: 'Foundation', question: 'Why?' }],
      maxInitialQuestions: 1,
    })
    const batch = buildPersistedBatch({
      questions: [{ id: 'Q01', phase: 'Foundation', question: 'Why?' }],
      progress: { current: 1, total: 1 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'First question.',
      batchNumber: 1,
    }, 'prom4', base)
    const session = recordPreparedBatch(base, batch)
    const malformedCompiledContent = '{ not valid JSON'
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(session),
    )
    upsertLatestPhaseArtifact(
      ticket.id,
      'interview_compiled',
      'DRAFTING_PRD',
      malformedCompiledContent,
    )

    const response = await app.request(`/api/tickets/${ticket.id}/interview`)
    const body = await response.json() as {
      winnerId: string | null
      raw: string | null
      contentSha256: string | null
      session: { winnerId: string } | null
      questions: Array<{ id: string; status: string; question: string }>
    }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      winnerId: 'openai/session-winner',
      raw: malformedCompiledContent,
      contentSha256: contentSha256(malformedCompiledContent),
      session: { winnerId: 'openai/session-winner' },
      questions: [{ id: 'Q01', status: 'current', question: 'Why?' }],
    })
  })

  it('records and resolves a skip when editing an answer from a previous batch', async () => {
    const ticket = createInterviewPayloadTicket()
    patchTicket(ticket.id, { status: 'WAITING_INTERVIEW_ANSWERS' })
    const base = createInterviewSessionSnapshot({
      winnerId: 'openai/session-winner',
      compiledQuestions: [
        { id: 'Q01', phase: 'Foundation', question: 'Why?' },
        { id: 'Q02', phase: 'Follow-up', question: 'What next?' },
      ],
      maxInitialQuestions: 2,
    })
    const firstBatch = buildPersistedBatch({
      questions: [{ id: 'Q01', phase: 'Foundation', question: 'Why?' }],
      progress: { current: 1, total: 2 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'First question.',
      batchNumber: 1,
    }, 'prom4', base)
    const answeredFirstBatch = recordBatchAnswers(
      recordPreparedBatch(base, firstBatch),
      { Q01: 'The original answer.' },
    )
    const secondBatch = buildPersistedBatch({
      questions: [{ id: 'Q02', phase: 'Follow-up', question: 'What next?' }],
      progress: { current: 2, total: 2 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Follow-up question.',
      batchNumber: 2,
    }, 'prom4', answeredFirstBatch)
    const session = recordPreparedBatch(answeredFirstBatch, secondBatch)
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(session),
    )

    const edit = (answer: string, skipReason?: string) => app.request(`/api/tickets/${ticket.id}/edit-answer`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchNumber: 2,
        questionId: 'Q01',
        answer,
        ...(skipReason ? { skipReason } : {}),
      }),
    })

    const skipped = await edit('', 'No longer relevant')
    expect(skipped.status).toBe(200)
    expect(await skipped.json()).toMatchObject({
      success: true,
      questions: expect.arrayContaining([
        expect.objectContaining({ id: 'Q01', status: 'skipped', answer: '', skipReason: 'No longer relevant' }),
      ]),
    })
    expect(parseInterviewSessionSnapshot(
      getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT, 'WAITING_INTERVIEW_ANSWERS')?.content,
    )?.answers.Q01).toMatchObject({ skipped: true, skipReason: 'No longer relevant' })

    const answered = await edit('Keep the original decision.')
    expect(answered.status).toBe(200)
    expect(await answered.json()).toMatchObject({
      success: true,
      questions: expect.arrayContaining([
        expect.objectContaining({ id: 'Q01', status: 'answered', answer: 'Keep the original decision.' }),
      ]),
    })
    expect(parseInterviewSessionSnapshot(
      getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT, 'WAITING_INTERVIEW_ANSWERS')?.content,
    )?.answers.Q01).toMatchObject({ skipped: false, answer: 'Keep the original decision.' })
  })

  it('rejects stale edit batches and question ids absent from the session', async () => {
    const ticket = createInterviewPayloadTicket()
    patchTicket(ticket.id, { status: 'WAITING_INTERVIEW_ANSWERS' })
    const base = createInterviewSessionSnapshot({
      winnerId: 'openai/session-winner',
      compiledQuestions: [{ id: 'Q01', phase: 'Foundation', question: 'Why?' }],
      maxInitialQuestions: 1,
    })
    const batch = buildPersistedBatch({
      questions: [{ id: 'Q01', phase: 'Foundation', question: 'Why?' }],
      progress: { current: 1, total: 1 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'First question.',
      batchNumber: 1,
    }, 'prom4', base)
    const sessionContent = serializeInterviewSessionSnapshot(recordPreparedBatch(base, batch))
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      sessionContent,
    )

    const edit = (batchNumber: number, questionId: string) => app.request(`/api/tickets/${ticket.id}/edit-answer`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchNumber, questionId, answer: 'Edited answer.' }),
    })

    const stale = await edit(2, 'Q01')
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'Interview batch is stale; refresh before editing' })

    const unknownQuestion = await edit(1, 'Q99')
    expect(unknownQuestion.status).toBe(404)
    expect(await unknownQuestion.json()).toEqual({ error: 'No existing answer for question Q99' })
    expect(getLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
    )?.content).toBe(sessionContent)
  })
})
