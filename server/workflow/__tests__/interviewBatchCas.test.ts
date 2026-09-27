import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BatchResponse } from '../../phases/interview/qa'
import {
  buildPersistedBatch,
  createInterviewSessionSnapshot,
  INTERVIEW_QA_SESSION_ARTIFACT,
  INTERVIEW_SESSION_ARTIFACT,
  parseInterviewSessionSnapshot,
  recordPreparedBatch,
  serializeInterviewSessionSnapshot,
  updateInterviewAnswer,
} from '../../phases/interview/sessionState'
import { opencodeSessions } from '../../db/schema'
import { getOpenCodeAdapter } from '../../opencode/factory'
import { resetTestDb, createTestRepoManager, createInitializedTestTicket } from '../../test/integration'
import { getTicketContext, patchTicket, getLatestPhaseArtifact, upsertLatestPhaseArtifact } from '../../storage/tickets'
import { listOpenCodeSessionsForTicket } from '../../opencode/sessionManager'
import { listSkipEvents } from '../skipReceipts'
import { phaseIntermediate, interviewQASessions } from '../phases/state'

const { submitBatchToSessionMock } = vi.hoisted(() => ({
  submitBatchToSessionMock: vi.fn(),
}))

vi.mock('../../phases/interview/qa', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../phases/interview/qa')>(),
  submitBatchToSession: submitBatchToSessionMock,
}))

import {
  claimInterviewBatch,
  claimInterviewBatchAfterConfirmedStop,
  getPendingInterviewBatchStopToken,
  markInterviewBatchStopPending,
  processInterviewBatchAsync,
  releaseInterviewBatch,
  restoreInterviewQASession,
} from '../phases/interviewPhase'
import { abortTicketWork } from '../phases/state'

const repoManager = createTestRepoManager('interview-batch-cas')

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

async function seedInterviewBatch() {
  const { ticket } = await createInitializedTestTicket(repoManager, {
    title: 'Interview batch CAS',
    description: 'Keep paused generation from overwriting a newer answer.',
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
  const batch = buildPersistedBatch({
    questions: [{ id: 'Q01', phase: 'Foundation', question: 'Why?' }],
    progress: { current: 1, total: 2 },
    isComplete: false,
    isFinalFreeForm: false,
    aiCommentary: 'Start.',
    batchNumber: 1,
  }, 'prom4', base)
  const original = recordPreparedBatch(base, batch)
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
  return { ticket, original }
}

async function startInterviewBatch(
  ticketId: string,
  original: Parameters<typeof processInterviewBatchAsync>[2],
) {
  const claim = claimInterviewBatch(ticketId)
  expect(claim).toBeTruthy()
  const processing = processInterviewBatchAsync(
    ticketId,
    { Q01: 'The first answer.' },
    original,
    {},
    {},
    claim ?? undefined,
  )
  await vi.waitFor(() => expect(submitBatchToSessionMock).toHaveBeenCalled())
  return { claim, processing }
}

describe('interview batch durable CAS', () => {
  beforeEach(() => {
    // Every durable write shares one timestamp so a timestamp-only revision
    // check would be indistinguishable from an older generation.
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2099-09-17T00:00:00.000Z')
    resetTestDb()
    phaseIntermediate.clear()
    interviewQASessions.clear()
    submitBatchToSessionMock.mockReset()
    delete process.env.LOOPTROOP_OPENCODE_MODE
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('restores an edited answer after the model rejects', async () => {
    const { ticket, original } = await seedInterviewBatch()
    let rejectModel: ((error: Error) => void) | undefined
    submitBatchToSessionMock.mockImplementation(() => new Promise<BatchResponse>((_, reject) => {
      rejectModel = reject
    }))

    const { processing } = await startInterviewBatch(ticket.id, original)

    const answered = parseInterviewSessionSnapshot(
      getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content,
    )
    expect(answered).not.toBeNull()
    const edited = JSON.parse(JSON.stringify(answered)) as NonNullable<typeof answered>
    edited.answers.Q01!.answer = 'Edited while paused.'
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(edited),
    )

    rejectModel?.(new Error('fixture model rejected'))
    await expect(processing).rejects.toThrow('fixture model rejected')

    const restored = parseInterviewSessionSnapshot(
      getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content,
    )
    expect(restored?.answers.Q01?.answer).toBe('Edited while paused.')
    expect(restored?.currentBatch?.batchNumber).toBe(original.currentBatch?.batchNumber)
  })

  it('reattaches a failed skipped batch without losing a concurrent answer edit or its single history entry', async () => {
    const { ticket, original } = await seedInterviewBatch()
    let rejectModel: ((error: Error) => void) | undefined
    submitBatchToSessionMock.mockImplementation(() => new Promise<BatchResponse>((_, reject) => {
      rejectModel = reject
    }))
    const claim = claimInterviewBatch(ticket.id)
    expect(claim).toBeTruthy()
    const processing = processInterviewBatchAsync(
      ticket.id,
      { Q01: '' },
      original,
      {},
      { Q01: 'Waiting for the right information.' },
      claim ?? undefined,
    )
    await vi.waitFor(() => expect(submitBatchToSessionMock).toHaveBeenCalled())

    const answered = parseInterviewSessionSnapshot(
      getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content,
    )
    expect(answered?.answers.Q01).toMatchObject({ skipped: true, skipReason: 'Waiting for the right information.' })
    const skipEvent = listSkipEvents(ticket.id).find((event) => event.itemId === 'Q01')
    expect(skipEvent).toBeDefined()

    const edited = updateInterviewAnswer(answered!, 'Q01', 'The requirement changed while PROM4 was running.')
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(edited),
    )
    rejectModel?.(new Error('fixture model rejected'))
    await expect(processing).rejects.toThrow('fixture model rejected')

    const restored = parseInterviewSessionSnapshot(
      getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content,
    )
    expect(restored?.answers.Q01).toMatchObject({
      answer: 'The requirement changed while PROM4 was running.',
      skipped: false,
    })
    expect(restored?.currentBatch).toEqual(original.currentBatch)
    expect(restored?.batchHistory).toEqual(original.batchHistory)
    expect(listSkipEvents(ticket.id).some((event) => event.actionId === skipEvent?.actionId)).toBe(false)
  })

  it('reactivates an abandoned PROM4 session when the remote session still exists', async () => {
    const { ticket } = await seedInterviewBatch()
    const context = getTicketContext(ticket.id)
    expect(context).not.toBeNull()
    context!.projectDb.insert(opencodeSessions).values({
      sessionId: 'session-1',
      ticketId: context!.localTicketId,
      phase: 'WAITING_INTERVIEW_ANSWERS',
      state: 'abandoned',
    }).run()
    interviewQASessions.delete(ticket.id)
    const remoteSession = vi.spyOn(getOpenCodeAdapter(), 'getSession').mockResolvedValue({ id: 'session-1' })

    await expect(restoreInterviewQASession(ticket.id)).resolves.toEqual({
      sessionId: 'session-1',
      winnerId: 'model-a',
    })

    expect(remoteSession).toHaveBeenCalledWith('session-1', undefined)
    expect(listOpenCodeSessionsForTicket(ticket.id)).toEqual([
      expect.objectContaining({ sessionId: 'session-1', state: 'active' }),
    ])
    expect(interviewQASessions.get(ticket.id)).toEqual({ sessionId: 'session-1', winnerId: 'model-a' })
  })

  it('drops a cached PROM4 session when its abandoned remote session is gone', async () => {
    const { ticket } = await seedInterviewBatch()
    const context = getTicketContext(ticket.id)
    expect(context).not.toBeNull()
    context!.projectDb.insert(opencodeSessions).values({
      sessionId: 'session-1',
      ticketId: context!.localTicketId,
      phase: 'WAITING_INTERVIEW_ANSWERS',
      state: 'abandoned',
    }).run()
    const remoteSession = vi.spyOn(getOpenCodeAdapter(), 'getSession').mockResolvedValue(null)

    await expect(restoreInterviewQASession(ticket.id)).resolves.toBeNull()

    expect(remoteSession).toHaveBeenCalledWith('session-1', undefined)
    expect(interviewQASessions.has(ticket.id)).toBe(false)
    expect(listOpenCodeSessionsForTicket(ticket.id, ['abandoned'])).toEqual([
      expect.objectContaining({ sessionId: 'session-1', state: 'abandoned' }),
    ])
  })

  it('publishes a successful next batch and releases its claim', async () => {
    const { ticket, original } = await seedInterviewBatch()
    let resolveModel: ((result: BatchResponse) => void) | undefined
    submitBatchToSessionMock.mockImplementation(() => new Promise<BatchResponse>((resolve) => {
      resolveModel = resolve
    }))

    const { claim, processing } = await startInterviewBatch(ticket.id, original)
    resolveModel?.(nextBatch())
    await expect(processing).resolves.toMatchObject({ batchNumber: 2 })

    const published = parseInterviewSessionSnapshot(
      getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content,
    )
    expect(published?.currentBatch?.batchNumber).toBe(2)
    expect(published?.answers.Q01?.answer).toBe('The first answer.')
    releaseInterviewBatch(ticket.id, claim ?? undefined)
  })

  it('cannot publish or roll back after an abort and claim takeover at the same clock tick', async () => {
    const { ticket, original } = await seedInterviewBatch()
    let resolveModel: ((result: BatchResponse) => void) | undefined
    submitBatchToSessionMock.mockImplementation(() => new Promise<BatchResponse>((resolve) => {
      resolveModel = resolve
    }))

    const claim = claimInterviewBatch(ticket.id)
    expect(claim).toBeTruthy()
    const processing = processInterviewBatchAsync(
      ticket.id,
      { Q01: 'The first answer.' },
      original,
      {},
      {},
      claim ?? undefined,
    )
    await vi.waitFor(() => expect(submitBatchToSessionMock).toHaveBeenCalled())

    abortTicketWork(ticket.id)
    expect(markInterviewBatchStopPending(ticket.id, claim ?? '', 'answer')).toBe(true)
    const pendingToken = getPendingInterviewBatchStopToken(ticket.id, 'answer')
    expect(pendingToken).toBeTruthy()
    const successorClaim = claimInterviewBatchAfterConfirmedStop(ticket.id, 'answer', pendingToken ?? '')
    expect(successorClaim).toBeTruthy()

    const intermediate = parseInterviewSessionSnapshot(
      getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content,
    )
    expect(intermediate).not.toBeNull()
    const successorBatch = buildPersistedBatch(nextBatch(), 'prom4', intermediate!)
    const successor = recordPreparedBatch(intermediate!, successorBatch)
    upsertLatestPhaseArtifact(
      ticket.id,
      INTERVIEW_SESSION_ARTIFACT,
      'WAITING_INTERVIEW_ANSWERS',
      serializeInterviewSessionSnapshot(successor),
    )

    resolveModel?.(nextBatch())
    await expect(processing).rejects.toThrow()

    const current = parseInterviewSessionSnapshot(
      getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)?.content,
    )
    expect(current?.currentBatch?.batchNumber).toBe(2)
    expect(current?.answers.Q01?.answer).toBe('The first answer.')
    releaseInterviewBatch(ticket.id, successorClaim ?? undefined)
  })
})
