import { readFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPersistedBatch,
  createInterviewSessionSnapshot,
  recordPreparedBatch,
} from '../../phases/interview/sessionState'
import type { DraftPhaseResult } from '../../council/types'
import type { deliberateInterview as DeliberateInterview } from '../../phases/interview/deliberate'
import { opencodeSessions } from '../../db/schema'
import { getLatestPhaseArtifact, getTicketContext } from '../../storage/tickets'
import * as atomicWrite from '../../io/atomicWrite'
import { TEST } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { listSkipEvents, writeSkipReceipts } from '../skipReceipts'
import { interviewQASessions, phaseIntermediate } from '../phases/state'
import * as interviewQa from '../../phases/interview/qa'
import { openCodeAuthAdvice } from '../../opencode/connection'

const { checkHealthMock, getSessionMock, deliberateInterviewMock } = vi.hoisted(() => ({
  checkHealthMock: vi.fn(),
  getSessionMock: vi.fn(),
  deliberateInterviewMock: vi.fn(),
}))

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({ checkHealth: checkHealthMock, getSession: getSessionMock }),
  isMockOpenCodeMode: () => process.env.LOOPTROOP_OPENCODE_MODE === 'mock',
}))

vi.mock('../../phases/interview/deliberate', () => ({
  deliberateInterview: deliberateInterviewMock,
}))

import {
  claimInterviewBatch,
  handleInterviewDeliberate,
  handleInterviewQABatch,
  handleMockInterviewQAStart,
  processInterviewBatchAsync,
  readInterviewSessionSnapshotArtifact,
  releaseInterviewBatch,
  writeInterviewSessionSnapshotArtifact,
} from '../phases/interviewPhase'

const repoManager = createTestRepoManager('interview-phase-additional-coverage-')
const originalMockMode = process.env.LOOPTROOP_OPENCODE_MODE

function draftContent(question: string) {
  return [
    'questions:',
    '  - id: Q01',
    '    phase: Foundation',
    `    question: "${question}"`,
  ].join('\n')
}

function answerQuestions(questions: Array<{ id: string }>) {
  return Object.fromEntries(questions.map((question, index) => [question.id, `Answer ${index + 1}.`]))
}

function makeActiveProm4Batch(ticketId: string) {
  const base = createInterviewSessionSnapshot({
    winnerId: TEST.councilMembers[0],
    compiledQuestions: [{ id: 'Q01', phase: 'Foundation', question: 'Which outcome matters most?' }],
    maxInitialQuestions: 1,
  })
  const batch = buildPersistedBatch({
    questions: [{ id: 'Q01', phase: 'Foundation', question: 'Which outcome matters most?' }],
    progress: { current: 1, total: 1 },
    isComplete: false,
    isFinalFreeForm: false,
    aiCommentary: 'Answer the primary question.',
    batchNumber: 1,
  }, 'prom4', base)
  const active = recordPreparedBatch(base, batch)
  writeInterviewSessionSnapshotArtifact(ticketId, active)
  return active
}

describe('additional interview phase flows', () => {
  beforeEach(() => {
    resetTestDb()
    phaseIntermediate.clear()
    interviewQASessions.clear()
    checkHealthMock.mockReset().mockResolvedValue({ available: true, version: 'test' })
    getSessionMock.mockReset().mockResolvedValue(null)
    deliberateInterviewMock.mockReset()
    delete process.env.LOOPTROOP_OPENCODE_MODE
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
    if (originalMockMode === undefined) delete process.env.LOOPTROOP_OPENCODE_MODE
    else process.env.LOOPTROOP_OPENCODE_MODE = originalMockMode
  })

  it('forwards live draft session, stream, prompt, and progress events into the phase logs', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Preserve live interview draft progress',
    })
    const sendEvent = vi.fn()
    const firstMember = TEST.councilMembers[0]
    const secondMember = TEST.councilMembers[1]
    const firstDraft = draftContent('Which outcome is most important?')
    const secondDraft = draftContent('Which failure case matters?')

    deliberateInterviewMock.mockImplementationOnce(async (...args: Parameters<typeof DeliberateInterview>) => {
      const [
        , , , , , ,
        onSessionLog,
        onStreamEvent,
        onPromptDispatched,
        onDraftProgress,
      ] = args

      onSessionLog?.({
        stage: 'draft',
        memberId: firstMember,
        sessionId: 'draft-session-1',
        response: 'draft response',
        messages: [],
      })
      onStreamEvent?.({
        stage: 'draft',
        memberId: firstMember,
        sessionId: 'draft-session-1',
        event: {
          type: 'step',
          sessionId: 'draft-session-1',
          step: 'start',
          complete: false,
        },
      })
      onPromptDispatched?.({
        stage: 'draft',
        memberId: firstMember,
        event: {
          session: { id: 'draft-session-1' },
          parts: [{ type: 'text', content: 'interview draft prompt' }],
          promptText: 'interview draft prompt',
          promptNumber: 1,
          timeoutKind: 'ai_response',
        },
      })
      onDraftProgress?.({ memberId: firstMember, status: 'session_created', sessionId: 'draft-session-1' })
      onDraftProgress?.({ memberId: 'unexpected-model', status: 'finished', outcome: 'completed' })
      onDraftProgress?.({
        memberId: firstMember,
        status: 'finished',
        outcome: 'completed',
        duration: 12,
        content: firstDraft,
        questionCount: 1,
      })

      return {
        phase: 'interview_draft',
        drafts: [
          { memberId: firstMember, outcome: 'completed', duration: 12, content: firstDraft, questionCount: 1 },
          { memberId: secondMember, outcome: 'completed', duration: 9, content: secondDraft, questionCount: 1 },
        ],
        memberOutcomes: { [firstMember]: 'completed', [secondMember]: 'completed' },
        deadlineReached: false,
      } satisfies DraftPhaseResult
    })

    await handleInterviewDeliberate(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith({ type: 'QUESTIONS_READY', result: expect.any(Object) })
    expect(phaseIntermediate.get(`${ticket.id}:interview`)?.drafts[0]?.content).toBe(firstDraft)
    expect(getLatestPhaseArtifact(ticket.id, 'interview_drafts', 'COUNCIL_DELIBERATING')?.content)
      .toContain('Which outcome is most important?')
    expect(checkHealthMock).toHaveBeenCalledOnce()
    const phaseLog = readFileSync(paths.executionLogPath, 'utf8')
    expect(phaseLog).toContain(`OpenCode draft: ${firstMember} session=draft-session-1`)
    expect(phaseLog).toContain('Step started.')
    expect(phaseLog).toContain('interview draft prompt')
    expect(phaseLog).toContain(`Interview draft session created for ${firstMember}: draft-session-1.`)
  })

  it('tells a server that refused LoopTroop apart from one that is not running', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Explain an OpenCode that refuses LoopTroop',
    })
    // Running, but it wants a password LoopTroop does not have: a restart
    // alone would send the same nothing again.
    checkHealthMock.mockResolvedValueOnce({
      available: false,
      failureKind: 'authentication',
      error: 'OpenCode requires a password, and none is configured (HTTP 401).',
      credentialsSent: false,
    })
    // The advice alone: the error opens with the same sentence, so appending
    // it said everything twice.
    await expect(handleInterviewDeliberate(ticket.id, context, vi.fn(), new AbortController().signal))
      .rejects.toHaveProperty('message', openCodeAuthAdvice(false))

    checkHealthMock.mockResolvedValueOnce({ available: false, failureKind: 'network', error: 'connection refused' })
    await expect(handleInterviewDeliberate(ticket.id, context, vi.fn(), new AbortController().signal))
      .rejects.toThrow('OpenCode server is not running. Restart LoopTroop (`looptroop restart`) so it starts OpenCode again.')
    expect(deliberateInterviewMock).not.toHaveBeenCalled()
  })

  it('words a refusal that does not say what was sent the way the model screen does', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Word an unexplained OpenCode refusal like the model screen',
    })
    // Assuming a password was sent told people with none configured to check it.
    vi.stubEnv('OPENCODE_PASSWORD', '')
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', '')
    try {
      checkHealthMock.mockResolvedValueOnce({ available: false, failureKind: 'authentication', error: 'HTTP 401' })
      await expect(handleInterviewDeliberate(ticket.id, context, vi.fn(), new AbortController().signal))
        .rejects.toHaveProperty('message', openCodeAuthAdvice(false))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('persists failed draft outcomes and blocks the interview when council quorum is not met', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Stop interview drafting when council quorum fails',
    })
    const drafts = TEST.councilMembers.map((memberId) => ({
      memberId,
      outcome: 'failed' as const,
      duration: 5,
      content: '',
      error: 'Provider unavailable.',
    }))
    deliberateInterviewMock.mockResolvedValueOnce({
      phase: 'interview_draft',
      drafts,
      memberOutcomes: Object.fromEntries(drafts.map(({ memberId, outcome }) => [memberId, outcome])),
      deadlineReached: false,
    } satisfies DraftPhaseResult)
    const sendEvent = vi.fn()

    await expect(handleInterviewDeliberate(ticket.id, context, sendEvent, new AbortController().signal))
      .rejects.toThrow('Council quorum not met for interview_draft')

    expect(getLatestPhaseArtifact(ticket.id, 'interview_drafts', 'COUNCIL_DELIBERATING')).toBeTruthy()
    expect(phaseIntermediate.has(`${ticket.id}:interview`)).toBe(false)
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('advances a mock interview through its follow-up batch and writes the completed canonical artifact', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Complete a mock interview',
    })
    process.env.LOOPTROOP_OPENCODE_MODE = 'mock'

    await handleMockInterviewQAStart(ticket.id, context)
    const initial = readInterviewSessionSnapshotArtifact(ticket.id)
    expect(initial?.currentBatch?.batchNumber).toBe(1)

    const followUp = await handleInterviewQABatch(
      ticket.id,
      answerQuestions(initial!.currentBatch!.questions),
    )
    expect(followUp).toMatchObject({ batchNumber: 2, isComplete: false, questions: [{ id: 'tradeoffs' }] })

    const followUpSnapshot = readInterviewSessionSnapshotArtifact(ticket.id)
    const completed = await handleInterviewQABatch(
      ticket.id,
      answerQuestions(followUpSnapshot!.currentBatch!.questions),
    )

    expect(completed).toMatchObject({ batchNumber: 2, isComplete: true, questions: [] })
    expect(readInterviewSessionSnapshotArtifact(ticket.id)?.completedAt).toBeTruthy()
    expect(readFileSync(`${paths.ticketDir}/interview.yaml`, 'utf8')).toContain('free_text: Answer 1.')
  })

  it('finishes a coverage follow-up batch, updates the canonical interview, and clears the stale PROM4 session', async () => {
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Commit interview coverage follow-up',
    })
    const question = { id: 'Q02', phase: 'Coverage', question: 'Which boundary remains unclear?' }
    const base = createInterviewSessionSnapshot({
      winnerId: TEST.councilMembers[0],
      compiledQuestions: [{ id: 'Q01', phase: 'Foundation', question: 'What outcome matters most?' }],
      maxInitialQuestions: 1,
    })
    const batch = buildPersistedBatch({
      questions: [question],
      progress: { current: 1, total: 1 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Clarify the remaining boundary.',
      batchNumber: 2,
    }, 'coverage', base)
    writeInterviewSessionSnapshotArtifact(ticket.id, recordPreparedBatch(base, batch))
    interviewQASessions.set(ticket.id, { sessionId: 'stale-prom4-session', winnerId: TEST.councilMembers[0] })
    const claim = claimInterviewBatch(ticket.id)
    expect(claim).toBeTruthy()

    try {
      const result = await handleInterviewQABatch(ticket.id, { Q02: 'The existing API owns that boundary.' }, {}, {}, undefined, claim ?? undefined)

      expect(result).toMatchObject({
        batchNumber: 2,
        isComplete: true,
        aiCommentary: 'Coverage follow-up answers captured. Re-running coverage.',
      })
      expect(readInterviewSessionSnapshotArtifact(ticket.id)?.answers.Q02?.answer).toBe('The existing API owns that boundary.')
      expect(readInterviewSessionSnapshotArtifact(ticket.id)?.completedAt).toBeTruthy()
      expect(interviewQASessions.has(ticket.id)).toBe(false)
      expect(readFileSync(`${paths.ticketDir}/interview.yaml`, 'utf8'))
        .toContain('The existing API owns that boundary.')
    } finally {
      releaseInterviewBatch(ticket.id, claim ?? undefined)
    }
  })

  it('rejects answers when no interview batch is active', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager, {
      title: 'Reject answers without an active interview batch',
    })

    await expect(handleInterviewQABatch(ticket.id, { Q01: 'An answer without a question batch.' }))
      .rejects.toThrow('No active interview batch for this ticket')
  })

  it('persists a replacement PROM4 session when a submitted batch has no reusable session', async () => {
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Restart an interview session after its persisted session is unavailable',
    })
    makeActiveProm4Batch(ticket.id)
    const claim = claimInterviewBatch(ticket.id)
    expect(claim).toBeTruthy()
    const firstBatch = {
      questions: [{ id: 'Q02', phase: 'Structure', question: 'Which boundary should remain fixed?' }],
      progress: { current: 2, total: 3 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Continue with one boundary question.',
      batchNumber: 2,
      structuredOutput: {
        repairApplied: true,
        repairWarnings: ['Repaired interview batch field tag at batch_number, payload line 1: "<batch_number>2</batch_number>" -> "batch_number: 2".'],
        autoRetryCount: 0,
      },
    }
    const start = vi.spyOn(interviewQa, 'startInterviewSession').mockResolvedValue({
      sessionId: 'replacement-prom4-session',
      firstBatch,
    })

    try {
      const result = await handleInterviewQABatch(
        ticket.id,
        { Q01: 'The main outcome is stable behavior.' },
        {},
        {},
        {},
        claim ?? undefined,
      )

      expect(start).toHaveBeenCalledOnce()
      expect(result).toMatchObject({ batchNumber: 2, questions: [{ id: 'Q02' }] })
      expect(interviewQASessions.get(ticket.id)).toEqual({
        sessionId: 'replacement-prom4-session',
        winnerId: TEST.councilMembers[0],
      })
      const phaseLog = readFileSync(paths.executionLogPath, 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line))
      expect(phaseLog).toContainEqual(expect.objectContaining({
        phase: 'WAITING_INTERVIEW_ANSWERS',
        modelId: TEST.councilMembers[0],
        sessionId: 'replacement-prom4-session',
        content: `Interview output normalization repairs:\n${firstBatch.structuredOutput.repairWarnings[0]}`,
        data: expect.objectContaining({ structuredOutput: firstBatch.structuredOutput }),
      }))
      expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'interview_qa_session')!.content)).toEqual({
        sessionId: 'replacement-prom4-session',
        winnerId: TEST.councilMembers[0],
      })
    } finally {
      start.mockRestore()
      releaseInterviewBatch(ticket.id, claim ?? undefined)
    }
  })

  it('commits the completed PROM4 snapshot and canonical interview after the final answer', async () => {
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Complete a PROM4 interview after its final answer',
    })
    const active = makeActiveProm4Batch(ticket.id)
    interviewQASessions.set(ticket.id, { sessionId: 'prom4-session', winnerId: active.winnerId })
    const claim = claimInterviewBatch(ticket.id)
    expect(claim).toBeTruthy()
    const submit = vi.spyOn(interviewQa, 'submitBatchToSession').mockResolvedValue({
      questions: [],
      progress: { current: 1, total: 1 },
      isComplete: true,
      isFinalFreeForm: false,
      aiCommentary: 'The interview is complete.',
      batchNumber: 1,
    })

    try {
      const result = await handleInterviewQABatch(
        ticket.id,
        { Q01: 'The main outcome is stable behavior.' },
        {},
        {},
        {},
        claim ?? undefined,
      )

      expect(submit).toHaveBeenCalledOnce()
      expect(result).toMatchObject({ isComplete: true, batchNumber: 1 })
      expect(readInterviewSessionSnapshotArtifact(ticket.id)).toMatchObject({
        completedAt: expect.any(String),
        answers: { Q01: { answer: 'The main outcome is stable behavior.' } },
      })
      expect(readFileSync(`${paths.ticketDir}/interview.yaml`, 'utf8')).toContain('The main outcome is stable behavior.')
    } finally {
      submit.mockRestore()
      releaseInterviewBatch(ticket.id, claim ?? undefined)
    }
  })

  it('restores the active PROM4 batch when writing its completed canonical interview fails', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager, {
      title: 'Restore an interview batch after canonical write failure',
    })
    const active = makeActiveProm4Batch(ticket.id)
    interviewQASessions.set(ticket.id, { sessionId: 'prom4-session', winnerId: active.winnerId })
    const claim = claimInterviewBatch(ticket.id)
    expect(claim).toBeTruthy()
    const submit = vi.spyOn(interviewQa, 'submitBatchToSession').mockResolvedValue({
      questions: [],
      progress: { current: 1, total: 1 },
      isComplete: true,
      isFinalFreeForm: false,
      aiCommentary: 'The interview is complete.',
      batchNumber: 1,
    })
    const originalSafeWrite = atomicWrite.safeAtomicWriteWithin
    const failCanonicalWrite = vi.spyOn(atomicWrite, 'safeAtomicWriteWithin').mockImplementation((...args) => {
      if (String(args[1]).includes('interview.yaml')) throw new Error('injected final canonical write failure')
      return originalSafeWrite(...args)
    })

    try {
      await expect(processInterviewBatchAsync(
        ticket.id,
        { Q01: 'The main outcome is stable behavior.' },
        active,
        {},
        {},
        claim ?? undefined,
      )).rejects.toThrow('injected final canonical write failure')

      expect(readInterviewSessionSnapshotArtifact(ticket.id)).toEqual(active)
      expect(getLatestPhaseArtifact(ticket.id, 'interview_batch_in_flight', 'WAITING_INTERVIEW_ANSWERS')).toBeUndefined()
    } finally {
      failCanonicalWrite.mockRestore()
      submit.mockRestore()
      releaseInterviewBatch(ticket.id, claim ?? undefined)
    }
  })

  it('cleans up an uncommitted skip receipt when the PROM4 snapshot claim is stale', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager, {
      title: 'Discard a skip receipt after the interview claim expires',
    })
    makeActiveProm4Batch(ticket.id)
    const actionId = 'stale-prom4-skip-attempt'
    writeSkipReceipts({
      ticketId: ticket.id,
      surface: 'interview_question',
      itemType: 'interview_question',
      phase: 'WAITING_INTERVIEW_ANSWERS',
      ticketStatusBefore: 'WAITING_INTERVIEW_ANSWERS',
      actionId,
      items: [{ itemId: 'Q01', reason: 'The answer needs more investigation.' }],
    })
    const receipt = { actionId }

    await expect(handleInterviewQABatch(
      ticket.id,
      { Q01: '' },
      {},
      { Q01: 'The answer needs more investigation.' },
      receipt,
      'expired-claim-token',
    )).rejects.toThrow('Interview batch changed or its claim expired before processing started')

    expect(receipt.actionId).toBeUndefined()
    expect(listSkipEvents(ticket.id).some((event) => event.actionId === actionId)).toBe(false)
    expect(getLatestPhaseArtifact(ticket.id, 'interview_batch_in_flight', 'WAITING_INTERVIEW_ANSWERS')).toBeUndefined()
  })

  it('replays persisted mock batches after the abandoned mock session is gone', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Resume a mock interview after restart',
    })
    process.env.LOOPTROOP_OPENCODE_MODE = 'mock'
    await handleMockInterviewQAStart(ticket.id, context)
    delete process.env.LOOPTROOP_OPENCODE_MODE

    const persistedContext = getTicketContext(ticket.id)
    expect(persistedContext).toBeTruthy()
    persistedContext!.projectDb.insert(opencodeSessions).values({
      sessionId: 'mock-session',
      ticketId: persistedContext!.localTicketId,
      phase: 'WAITING_INTERVIEW_ANSWERS',
      state: 'abandoned',
    }).run()
    interviewQASessions.delete(ticket.id)

    const claim = claimInterviewBatch(ticket.id)
    expect(claim).toBeTruthy()
    const initial = readInterviewSessionSnapshotArtifact(ticket.id)
    try {
      const firstReplay = await handleInterviewQABatch(
        ticket.id,
        answerQuestions(initial!.currentBatch!.questions),
        {},
        {},
        undefined,
        claim ?? undefined,
      )
      expect(firstReplay).toMatchObject({ batchNumber: 2, isComplete: false, questions: [{ id: 'tradeoffs' }] })
      expect(getSessionMock).toHaveBeenCalledWith('mock-session', expect.any(AbortSignal))

      const followUp = readInterviewSessionSnapshotArtifact(ticket.id)
      const secondReplay = await handleInterviewQABatch(
        ticket.id,
        answerQuestions(followUp!.currentBatch!.questions),
        {},
        {},
        undefined,
        claim ?? undefined,
      )
      expect(secondReplay).toMatchObject({ batchNumber: 3, isComplete: false, questions: [{ id: 'final_notes' }] })

      const finalBatch = readInterviewSessionSnapshotArtifact(ticket.id)
      const completed = await handleInterviewQABatch(
        ticket.id,
        answerQuestions(finalBatch!.currentBatch!.questions),
        {},
        {},
        undefined,
        claim ?? undefined,
      )

      expect(completed).toMatchObject({ batchNumber: 3, isComplete: true, questions: [] })
      expect(readInterviewSessionSnapshotArtifact(ticket.id)?.completedAt).toBeTruthy()
      expect(readFileSync(`${paths.ticketDir}/interview.yaml`, 'utf8')).toContain('free_text: Answer 1.')
    } finally {
      releaseInterviewBatch(ticket.id, claim ?? undefined)
    }
  })
})
