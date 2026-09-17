import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { interviewBatchClaims } from '../../db/schema'
import { abortTicketSessions } from '../../opencode/sessionManager'
import { getTicketContext, getLatestPhaseArtifact, patchTicket, upsertLatestPhaseArtifact } from '../../storage/tickets'
import {
  buildPersistedBatch,
  createInterviewSessionSnapshot,
  INTERVIEW_QA_SESSION_ARTIFACT,
  INTERVIEW_SESSION_ARTIFACT,
  parseInterviewSessionSnapshot,
  recordPreparedBatch,
  serializeInterviewSessionSnapshot,
} from '../../phases/interview/sessionState'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { getPendingInterviewBatchStop } from '../../workflow/phases/interviewPhase'
import { interviewQASessions } from '../../workflow/phases/state'
import {
  resolveAiResponseTimeoutForTicket,
  resolveStructuredRetryCountForTicket,
} from '../../workflow/phases/helpers'

const { submitBatchToSessionMock, abortTicketSessionsMock } = vi.hoisted(() => ({
  submitBatchToSessionMock: vi.fn(),
  abortTicketSessionsMock: vi.fn(),
}))

vi.mock('../../phases/interview/qa', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../phases/interview/qa')>(),
  submitBatchToSession: submitBatchToSessionMock,
}))

vi.mock('../../opencode/sessionManager', () => ({
  abortTicketSessions: abortTicketSessionsMock,
}))

vi.mock('../../machines/persistence', async () => (await import('../../test/routeMocks')).machinesPersistenceMock())

import type { BatchResponse } from '../../phases/interview/qa'
import { ticketRouter } from '../tickets'

const repoManager = createTestRepoManager('ticket-interview-batch-safety')

function nextBatch(): BatchResponse {
  return {
    questions: [{ id: 'Q02', phase: 'Follow-up', question: 'What next?' }],
    progress: { current: 2, total: 2 },
    isComplete: false,
    isFinalFreeForm: false,
    aiCommentary: 'Continue.',
    batchNumber: 2,
  }
}

describe('answer-batch stop confirmation and retry', () => {
  beforeEach(() => {
    resetTestDb()
    interviewQASessions.clear()
    submitBatchToSessionMock.mockReset()
    abortTicketSessionsMock.mockReset()
    delete process.env.LOOPTROOP_OPENCODE_MODE
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('restores durable batch state on false stop, retries after true stop, and ignores the old worker', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager, {
      title: 'Interview stop retry',
      description: 'Exercise durable stop confirmation.',
    })
    patchTicket(ticket.id, { status: 'WAITING_INTERVIEW_ANSWERS' })
    const base = createInterviewSessionSnapshot({
      winnerId: 'model-a',
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
      aiCommentary: 'Start.',
      batchNumber: 1,
    }, 'prom4', base)
    const original = recordPreparedBatch(base, firstBatch)
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(original),
    )
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_QA_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      JSON.stringify({ sessionId: 'session-1', winnerId: 'model-a' }),
    )
    interviewQASessions.set(ticket.id, { sessionId: 'session-1', winnerId: 'model-a' })

    let resolveOldModel: ((result: BatchResponse) => void) | undefined
    submitBatchToSessionMock
      .mockImplementationOnce(() => new Promise<BatchResponse>((resolve) => {
        resolveOldModel = resolve
      }))
      .mockResolvedValueOnce(nextBatch())
    abortTicketSessionsMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const app = new Hono()
    app.route('/api', ticketRouter)
    const answer = () => app.request(`/api/tickets/${ticket.id}/answer-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchNumber: 1, answers: { Q01: 'The first answer.' } }),
    })

    vi.useFakeTimers()
    try {
      expect((await answer()).status).toBe(202)
      await vi.waitFor(() => expect(submitBatchToSessionMock).toHaveBeenCalledTimes(1))
      expect(parseInterviewSessionSnapshot(
        getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content,
      )?.currentBatch).toBeNull()

      const timeoutMs = resolveAiResponseTimeoutForTicket(ticket.id)
        * (1 + Math.max(0, resolveStructuredRetryCountForTicket(ticket.id)))
        + 60_000
      // The timer callback is deliberately delivered after the durable claim
      // lease has expired. The recovery path must fence the old token, retain
      // the stop marker, and restore the batch before it asks the remote
      // session to stop.
      vi.setSystemTime(Date.now() + timeoutMs + 60_001)
      await vi.advanceTimersByTimeAsync(timeoutMs)
      vi.useRealTimers()
      await vi.waitFor(() => expect(abortTicketSessionsMock).toHaveBeenCalledTimes(1))

      const restored = parseInterviewSessionSnapshot(
        getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content,
      )
      expect(restored?.currentBatch?.batchNumber).toBe(1)
      expect(getPendingInterviewBatchStop(ticket.id)).toBe('answer')
      const context = getTicketContext(ticket.id)
      expect(context?.projectDb.select().from(interviewBatchClaims).get()?.token).toContain('interview-stop-pending:answer:')

      expect((await answer()).status).toBe(202)
      await vi.waitFor(() => expect(submitBatchToSessionMock).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(
        parseInterviewSessionSnapshot(getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content)
          ?.currentBatch?.batchNumber,
      ).toBe(2))
      expect(getPendingInterviewBatchStop(ticket.id)).toBeNull()
      expect(context?.projectDb.select().from(interviewBatchClaims).get()).toBeUndefined()

      // The first fixture deliberately ignores the abort. Its late result must
      // not overwrite the successor created by the confirmed retry.
      resolveOldModel?.(nextBatch())
      await new Promise(resolve => setImmediate(resolve))
      expect(parseInterviewSessionSnapshot(
        getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content,
      )?.currentBatch?.batchNumber).toBe(2)
      expect(abortTicketSessions).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
