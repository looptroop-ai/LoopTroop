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
import { TEST } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { interviewQASessions, phaseIntermediate } from '../phases/state'

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
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
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
          type: 'text',
          sessionId: 'draft-session-1',
          text: 'draft stream output',
          streaming: false,
          complete: true,
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
