import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import {
  buildPersistedBatch,
  createInterviewSessionSnapshot,
  INTERVIEW_SESSION_ARTIFACT,
  recordBatchAnswers,
  recordPreparedBatch,
  serializeInterviewSessionSnapshot,
} from '../../phases/interview/sessionState'
import { attachProject } from '../../storage/projects'
import {
  createTicket,
  getLatestPhaseArtifact,
  getTicketByRef,
  getTicketPaths,
  patchTicket,
  upsertLatestPhaseArtifact,
} from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { claimInterviewBatch } from '../../workflow/phases/interviewPhase'
import { initializeTicket } from '../../ticket/initialize'

vi.mock('../../opencode/sessionManager', () => ({
  abortTicketSessions: vi.fn(async () => undefined),
}))

vi.mock('../../machines/persistence', async () => {
  const storage = await import('../../storage/tickets')

  return {
    createTicketActor: vi.fn(),
    ensureActorForTicket: vi.fn(() => ({ id: 'mock-actor' })),
    sendTicketEvent: vi.fn((ticketRef: string | number, event: { type: string }) => {
      if (event.type === 'SKIP_ALL_TO_APPROVAL') {
        storage.patchTicket(String(ticketRef), { status: 'WAITING_INTERVIEW_APPROVAL' })
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

import { ticketRouter } from '../tickets'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-ticket-route-skip-',
  files: {
    'README.md': '# LoopTroop Ticket Route Skip Test\n',
  },
})

describe('ticketRouter POST /tickets/:id/skip', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('skips the remaining interview questions and moves the ticket to interview approval', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Skip route',
      description: 'Verify interview skip route.',
    })

    const init = await initializeTicket({
      projectFolder: repoDir,
      externalId: ticket.externalId,
    })

    patchTicket(ticket.id, {
      status: 'WAITING_INTERVIEW_ANSWERS',
      branchName: init.branchName,
    })

    const base = createInterviewSessionSnapshot({
      winnerId: 'openai/gpt-5-mini',
      compiledQuestions: [
        { id: 'Q01', phase: 'Foundation', question: 'What outcome matters most?' },
        { id: 'Q02', phase: 'Structure', question: 'Which constraints are fixed?' },
        { id: 'Q03', phase: 'Assembly', question: 'How will retries be tested?' },
      ],
      maxInitialQuestions: 3,
    })

    const firstBatch = buildPersistedBatch({
      questions: [
        { id: 'Q01', phase: 'Foundation', question: 'What outcome matters most?' },
        { id: 'Q02', phase: 'Structure', question: 'Which constraints are fixed?' },
      ],
      progress: { current: 2, total: 3 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Collect the essentials first.',
      batchNumber: 1,
    }, 'prom4', base)

    const answered = recordBatchAnswers(
      recordPreparedBatch(base, firstBatch),
      {
        Q01: 'Keep imports idempotent.',
        Q02: '',
      },
    )

    const currentBatch = buildPersistedBatch({
      questions: [
        { id: 'Q03', phase: 'Assembly', question: 'How will retries be tested?' },
      ],
      progress: { current: 3, total: 3 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'One final question remains.',
      batchNumber: 2,
    }, 'prom4', answered)

    const activeSnapshot = recordPreparedBatch(answered, currentBatch)
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(activeSnapshot),
    )

    const app = new Hono()
    app.route('/api', ticketRouter)

    const response = await app.request(`/api/tickets/${ticket.id}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: {
          Q03: 'Exercise retries against a flaky upstream fake.',
        },
      }),
    })

    expect(response.status).toBe(200)

    const payload = await response.json() as { status?: string; message?: string }
    expect(payload).toMatchObject({
      status: 'WAITING_INTERVIEW_APPROVAL',
      message: 'Remaining interview questions skipped',
    })
    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_INTERVIEW_APPROVAL')

    const paths = getTicketPaths(ticket.id)
    expect(paths).toBeDefined()
    const interviewYaml = readFileSync(paths!.ticketDir + '/interview.yaml', 'utf-8')
    expect(interviewYaml).toContain('free_text: Exercise retries against a flaky upstream fake.')

    const coverageArtifact = getLatestPhaseArtifact(ticket.id, 'interview_coverage', 'VERIFYING_INTERVIEW_COVERAGE')
    expect(coverageArtifact).toBeDefined()
    expect(coverageArtifact?.content).toContain('"hasGaps":false')
  })

  it('refuses to skip the rest while an answer batch is still being processed', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({ folderPath: repoDir, name: 'LoopTroop', shortname: 'LOOP' })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Skip during batch',
      description: 'Skip-all must not race an in-flight batch.',
    })
    const init = await initializeTicket({ projectFolder: repoDir, externalId: ticket.externalId })
    patchTicket(ticket.id, { status: 'WAITING_INTERVIEW_ANSWERS', branchName: init.branchName })

    const base = createInterviewSessionSnapshot({
      winnerId: 'openai/gpt-5-mini',
      compiledQuestions: [{ id: 'Q01', phase: 'Foundation', question: 'What outcome matters most?' }],
      maxInitialQuestions: 1,
    })
    const batch = buildPersistedBatch({
      questions: [{ id: 'Q01', phase: 'Foundation', question: 'What outcome matters most?' }],
      progress: { current: 1, total: 1 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'One question.',
      batchNumber: 1,
    }, 'prom4', base)
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(recordPreparedBatch(base, batch)),
    )

    // A batch is in flight. Skipping the rest rewrites the session and moves
    // the ticket on; the batch then fails and reverts to its own snapshot,
    // undoing the skip-all entirely. Nothing but this claim stops the overlap —
    // the ticket stays in `WAITING_INTERVIEW_ANSWERS` throughout.
    expect(claimInterviewBatch(ticket.id)).toBeTruthy()

    const app = new Hono()
    app.route('/api', ticketRouter)
    const response = await app.request(`/api/tickets/${ticket.id}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: {}, selectedOptions: {}, skipReasons: {} }),
    })

    expect(response.status).toBe(409)
    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_INTERVIEW_ANSWERS')
  })

  it('refuses a skip reason attached to a question the person answered', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Skip route reasons',
      description: 'A reason only means something attached to a skip.',
    })

    const init = await initializeTicket({
      projectFolder: repoDir,
      externalId: ticket.externalId,
    })

    patchTicket(ticket.id, {
      status: 'WAITING_INTERVIEW_ANSWERS',
      branchName: init.branchName,
    })

    const base = createInterviewSessionSnapshot({
      winnerId: 'openai/gpt-5-mini',
      compiledQuestions: [
        { id: 'Q01', phase: 'Foundation', question: 'What outcome matters most?' },
        { id: 'Q02', phase: 'Structure', question: 'Which constraints are fixed?' },
      ],
      maxInitialQuestions: 2,
    })
    const currentBatch = buildPersistedBatch({
      questions: [
        { id: 'Q01', phase: 'Foundation', question: 'What outcome matters most?' },
        { id: 'Q02', phase: 'Structure', question: 'Which constraints are fixed?' },
      ],
      progress: { current: 1, total: 1 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Both questions at once.',
      batchNumber: 1,
    }, 'prom4', base)

    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(recordPreparedBatch(base, currentBatch)),
    )

    const app = new Hono()
    app.route('/api', ticketRouter)

    const response = await app.request(`/api/tickets/${ticket.id}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: { Q01: 'Answered right here.' },
        skipReasons: { Q01: 'A reason for something that is not being skipped.' },
      }),
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { questionIds?: string[] }
    expect(payload.questionIds).toEqual(['Q01'])
    expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_INTERVIEW_ANSWERS')
  })

  it('carries per-question and bulk reasons into the canonical interview', async () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'LoopTroop',
      shortname: 'LOOP',
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Skip route bulk reason',
      description: 'The bulk reason fills gaps only.',
    })

    const init = await initializeTicket({
      projectFolder: repoDir,
      externalId: ticket.externalId,
    })

    patchTicket(ticket.id, {
      status: 'WAITING_INTERVIEW_ANSWERS',
      branchName: init.branchName,
    })

    const base = createInterviewSessionSnapshot({
      winnerId: 'openai/gpt-5-mini',
      compiledQuestions: [
        { id: 'Q01', phase: 'Foundation', question: 'What outcome matters most?' },
        { id: 'Q02', phase: 'Structure', question: 'Which constraints are fixed?' },
      ],
      maxInitialQuestions: 2,
    })
    const currentBatch = buildPersistedBatch({
      questions: [{ id: 'Q01', phase: 'Foundation', question: 'What outcome matters most?' }],
      progress: { current: 1, total: 2 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'First question.',
      batchNumber: 1,
    }, 'prom4', base)

    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(recordPreparedBatch(base, currentBatch)),
    )

    const app = new Hono()
    app.route('/api', ticketRouter)

    const response = await app.request(`/api/tickets/${ticket.id}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: { Q01: '' },
        skipReasons: { Q01: 'Answered in the ticket description.' },
        bulkSkipReason: 'Shipping before the demo.',
      }),
    })

    expect(response.status).toBe(200)

    const interviewYaml = readFileSync(getTicketPaths(ticket.id)!.ticketDir + '/interview.yaml', 'utf-8')
    expect(interviewYaml).toContain('skip_reason: Answered in the ticket description.')
    expect(interviewYaml).toContain('skip_reason: Shipping before the demo.')
  })
})
