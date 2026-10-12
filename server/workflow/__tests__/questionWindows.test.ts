import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { attachProject } from '../../storage/projects'
import { createTicket } from '../../storage/tickets'
import { listSkipEvents } from '../skipReceipts'
import { createWorkBudget, isTicketWorkSuspended, resetAllWorkBudgets } from '../workBudget'
import {
  armOrResetTimer,
  attachRequest,
  claimRequestForReply,
  clearTicketWindows,
  closeMemberQuestions,
  getPendingQuestionSummary,
  getTicketQuestionState,
  markRequestReplied,
  markRequestSkipped,
  readTimerArtifact,
  reconcileAgainstPending,
  reconcilePendingQuestionsAfterRestart,
  releaseRequestClaim,
  resetAllQuestionWindows,
  stopTicketTimers,
} from '../questionWindows'
import { getTicketContext } from '../../storage/ticketQueries'
import { archiveActivePhaseAttempts, createFreshPhaseAttempts, ensureActivePhaseAttempt } from '../../storage/ticketPhaseAttempts'
import { closeQuestionWait } from '../../storage/questionWaits'
import { questionWaits } from '../../db/schema'
import type { OpenCodeQuestionInfo } from '../../opencode/types'
import { MockOpenCodeAdapter, type OpenCodeAdapter } from '../../opencode/adapter'
import { emitOpenCodeSessionEnded } from '../../opencode/sessionEvents'

const adapter = new MockOpenCodeAdapter()
// The window machinery reaches for the process-wide adapter, so the mock is
// installed for the whole file rather than threaded through every call.
vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => adapter,
  isMockOpenCodeMode: () => true,
  resetOpenCodeAdapter: () => undefined,
}))

/** Lets the expiry's async reject chain settle after the fake clock fires it. */
async function settle() {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
}

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-question-windows-',
  files: { 'README.md': '# LoopTroop AI Questions Test\n' },
})

const QUESTIONS: OpenCodeQuestionInfo[] = [
  { question: 'Which database?', header: 'Storage', options: [{ label: 'SQLite', description: 'Local file' }] },
  { question: 'Which port?', header: 'Port', options: [], custom: true },
]

function makeTicket() {
  const project = attachProject({
    folderPath: repoManager.createRepo(),
    name: 'LoopTroop',
    shortname: 'LOOP',
  })
  return createTicket({
    projectId: project.id,
    title: 'AI questions',
    description: 'A model may stop and ask.',
  })
}

function ask(ticketId: string, overrides: Partial<Parameters<typeof attachRequest>[0]> = {}) {
  return attachRequest({
    ticketId,
    sessionId: 'ses_a',
    requestId: 'req_a',
    memberId: 'anthropic/claude',
    phase: 'CODING',
    phaseAttempt: 1,
    windowMs: 300_000,
    questions: QUESTIONS,
    ...overrides,
  })
}

describe('question windows', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
    resetAllQuestionWindows()
    resetAllWorkBudgets()
    adapter.questionRejections = []
    adapter.failRejectQuestion = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetAllQuestionWindows()
    resetAllWorkBudgets()
    vi.useRealTimers()
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('opens a window and stops the step spending working time', () => {
    const ticket = makeTicket()
    const budget = createWorkBudget({ ticketId: ticket.id, totalMs: 60_000, scope: 'phase_attempt' })

    expect(ask(ticket.id)).toBe(true)
    expect(isTicketWorkSuspended(ticket.id)).toBe(true)

    const state = getTicketQuestionState(ticket.id)
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0]?.questionCount).toBe(2)
    expect(state.timer?.stoppedAt).toBeNull()
    expect(budget.suspended()).toBe(true)
  })

  it('ignores a duplicate asked event rather than suspending twice', () => {
    const ticket = makeTicket()
    expect(ask(ticket.id)).toBe(true)
    expect(ask(ticket.id)).toBe(false)

    markRequestReplied(ticket.id, 'ses_a', 'req_a')
    // One attach, one resume. A double-counted suspension would leave the
    // ticket's clocks stopped for the rest of the run.
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)
  })

  it('counts requests and questions separately', () => {
    const ticket = makeTicket()
    ask(ticket.id)
    ask(ticket.id, { sessionId: 'ses_b', requestId: 'req_b', memberId: 'openai/gpt' })

    expect(getPendingQuestionSummary(ticket.id)).toMatchObject({
      requestCount: 2,
      questionCount: 4,
    })
  })

  it('pushes a running clock back to full when another model asks', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const ticket = makeTicket()
    ask(ticket.id)
    const first = getTicketQuestionState(ticket.id).timer!

    vi.advanceTimersByTime(240_000)
    ask(ticket.id, { sessionId: 'ses_b', requestId: 'req_b' })
    const second = getTicketQuestionState(ticket.id).timer!

    expect(Date.parse(second.deadlineAt) - Date.parse(first.deadlineAt)).toBe(240_000)
    expect(second.resetCount).toBe(1)
  })

  it('does not restart a stopped clock when another model asks', () => {
    const ticket = makeTicket()
    ask(ticket.id)
    stopTicketTimers(ticket.id)

    ask(ticket.id, { sessionId: 'ses_b', requestId: 'req_b' })
    const timer = getTicketQuestionState(ticket.id).timer!
    // Stop is a promise that the run waits for a person. A model arriving later
    // must not quietly break it, or the question being answered could expire.
    expect(timer.stoppedAt).not.toBeNull()
    expect(timer.resetCount).toBe(0)
  })

  it('is idempotent about stopping', () => {
    const ticket = makeTicket()
    ask(ticket.id)
    const first = stopTicketTimers(ticket.id)
    const second = stopTicketTimers(ticket.id)
    expect(second[0]?.stoppedAt).toBe(first[0]?.stoppedAt)
    expect(second[0]?.revision).toBe(first[0]?.revision)
  })

  it('shares one clock across every model in the step', () => {
    const ticket = makeTicket()
    ask(ticket.id)
    ask(ticket.id, { sessionId: 'ses_b', requestId: 'req_b' })

    stopTicketTimers(ticket.id)
    const state = getTicketQuestionState(ticket.id)
    expect(state.requests).toHaveLength(2)
    expect(state.timer?.stoppedAt).not.toBeNull()
    expect(new Set(state.requests.map((request) => request.timerKey)).size).toBe(1)
  })

  it('keeps the clock running for the others when one request resolves', () => {
    const ticket = makeTicket()
    ask(ticket.id)
    ask(ticket.id, { sessionId: 'ses_b', requestId: 'req_b' })

    markRequestReplied(ticket.id, 'ses_a', 'req_a')
    expect(getTicketQuestionState(ticket.id).requests).toHaveLength(1)
    expect(isTicketWorkSuspended(ticket.id)).toBe(true)

    markRequestReplied(ticket.id, 'ses_b', 'req_b')
    expect(getPendingQuestionSummary(ticket.id)).toBeNull()
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)
  })

  it('lets exactly one resolver claim a request', () => {
    const ticket = makeTicket()
    ask(ticket.id)
    // The winner gets the id it later completes the claim with.
    expect(claimRequestForReply(ticket.id, 'ses_a', 'req_a')).toEqual(expect.any(String))
    // The loser of an answer-versus-expiry race must do nothing at all rather
    // than send a second verdict for a question that already has one.
    expect(claimRequestForReply(ticket.id, 'ses_a', 'req_a')).toBeNull()
  })

  it('writes a summary row and one child per unanswered question when skipped', () => {
    const ticket = makeTicket()
    ask(ticket.id)
    markRequestSkipped(ticket.id, 'ses_a', 'req_a', 'I do not know either.')

    const events = listSkipEvents(ticket.id).filter((event) => event.surface === 'opencode_question')
    const summary = events.find((event) => event.isActionSummary)
    const children = events.filter((event) => !event.isActionSummary)

    expect(summary?.itemType).toBe('opencode_question_request')
    expect(children).toHaveLength(2)
    expect(children.map((child) => child.itemId)).toEqual(['req_a:0', 'req_a:1'])
    expect(events.every((event) => event.skippedBy === 'user')).toBe(true)
    expect(summary?.questionContext).toMatchObject({
      request_id: 'req_a',
      session_id: 'ses_a',
      question_count: 2,
      window_ms: 300_000,
      expiry_reason: 'user_skipped',
    })
  })

  it('drops records for questions OpenCode no longer has', () => {
    const ticket = makeTicket()
    ask(ticket.id)
    ask(ticket.id, { sessionId: 'ses_b', requestId: 'req_b' })

    reconcileAgainstPending(ticket.id, new Set(['req_b']))
    const state = getTicketQuestionState(ticket.id)
    expect(state.requests.map((request) => request.requestId)).toEqual(['req_b'])
  })

  it('refuses everything under the system actor when the ticket is canceled', async () => {
    const ticket = makeTicket()
    ask(ticket.id)
    ask(ticket.id, { sessionId: 'ses_b', requestId: 'req_b' })

    await clearTicketWindows(ticket.id, 'ticket_canceled', 'The ticket was canceled while the question was open.')

    expect(getPendingQuestionSummary(ticket.id)).toBeNull()
    // The suspension has to lift too, or it would hold the clocks of whatever
    // runs next on this ticket.
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)

    const events = listSkipEvents(ticket.id).filter((event) => event.surface === 'opencode_question')
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event) => event.skippedBy === 'system')).toBe(true)
    const summary = events.find((event) => event.isActionSummary)
    expect(summary?.questionContext?.expiry_reason).toBe('ticket_canceled')
  })

  it('closes a stopped member\'s questions at once, under the person', () => {
    const ticket = makeTicket()
    ask(ticket.id, { phase: 'DRAFTING_PRD' })
    ask(ticket.id, { sessionId: 'ses_b', requestId: 'req_b', memberId: 'openai/gpt', phase: 'DRAFTING_PRD' })
    const replyClaim = claimRequestForReply(ticket.id, 'ses_a', 'req_a')

    expect(closeMemberQuestions(ticket.id, 'DRAFTING_PRD', 'anthropic/claude', {
      actor: 'user',
      resolution: 'member_stopped',
      reason: 'You stopped this model while its question was open.',
    })).toBe(1)

    // Closed before the stop lands, and not refused: the model is not woken.
    expect(adapter.questionRejections).toEqual([])
    expect(getTicketQuestionState(ticket.id).requests.map((request) => request.requestId)).toEqual(['req_b'])
    const summary = listSkipEvents(ticket.id)
      .find((event) => event.surface === 'opencode_question' && event.isActionSummary)
    expect(summary?.skippedBy).toBe('user')
    expect(summary?.questionContext?.expiry_reason).toBe('member_stopped')
    // A reply already on its way can no longer complete it.
    expect(markRequestReplied(ticket.id, 'ses_a', 'req_a', replyClaim ?? undefined)).toBe(false)
    // The other member is still waiting on a person, so the clocks stay held.
    expect(isTicketWorkSuspended(ticket.id)).toBe(true)

    // The session stop that follows finds nothing left to close.
    emitOpenCodeSessionEnded({ sessionId: 'ses_a', ticketId: ticket.id, reason: 'aborted' })
    expect(listSkipEvents(ticket.id).filter((event) => event.isActionSummary)).toHaveLength(1)
  })

  it('lets the clocks run once a stopped member\'s question was the last one waiting', () => {
    const ticket = makeTicket()
    ask(ticket.id, { phase: 'DRAFTING_BEADS' })

    closeMemberQuestions(ticket.id, 'DRAFTING_BEADS', 'anthropic/claude', {
      actor: 'user',
      resolution: 'member_restarted',
      reason: 'You restarted this model while its question was open.',
    })

    // Even when OpenCode never confirms the stop, nothing still holds every
    // model's clock or waits for an answer.
    expect(getPendingQuestionSummary(ticket.id)).toBeNull()
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)
  })

  it('never brings back a question a stop closed, after this process forgot it', async () => {
    const ticket = makeTicket()
    // A retried step: the question comes in under attempt 2, while the council
    // session's row, which the poll and the restart read, still says 1.
    ensureActivePhaseAttempt(ticket.id, 'DRAFTING_BEADS')
    archiveActivePhaseAttempts(ticket.id, ['DRAFTING_BEADS'], 'test_retry')
    createFreshPhaseAttempts(ticket.id, ['DRAFTING_BEADS'])
    ask(ticket.id, { phase: 'DRAFTING_BEADS', phaseAttempt: 2 })
    closeMemberQuestions(ticket.id, 'DRAFTING_BEADS', 'anthropic/claude', {
      actor: 'user',
      resolution: 'member_stopped',
      reason: 'You stopped this model while its question was open.',
    })
    // OpenCode never confirmed the stop, so it still holds the question. The
    // in-memory record is gone, as after a restart or once its tombstone lapses.
    resetAllQuestionWindows()

    // The poll re-attaches whatever OpenCode lists.
    expect(ask(ticket.id, { phase: 'DRAFTING_BEADS' })).toBe(false)
    expect(getPendingQuestionSummary(ticket.id)).toBeNull()
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)

    // A restart that finds its session gone refuses it, without a second record.
    adapter.mockQuestions = [{ id: 'req_a', sessionID: 'ses_a', questions: QUESTIONS }]
    const result = await reconcilePendingQuestionsAfterRestart({
      projectRoot: getTicketContext(ticket.id)?.projectRoot ?? '',
      owners: [{ sessionId: 'ses_a', ticketId: ticket.id, memberId: 'anthropic/claude', phase: 'DRAFTING_BEADS', phaseAttempt: 1, active: false }],
      windowMsFor: () => 60_000,
    })
    expect(result).toEqual({ reattached: 0, rejected: 1, unverified: 0 })
    expect(listSkipEvents(ticket.id).filter((event) => event.isActionSummary)
      .map((event) => event.questionContext?.expiry_reason)).toEqual(['member_stopped'])
  })

  it('does not close a question twice when its session ends while expiry is telling OpenCode', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const ticket = makeTicket()
    ask(ticket.id)
    ask(ticket.id, { sessionId: 'ses_b', requestId: 'req_b', memberId: 'openai/gpt' })
    const refusals: Array<() => void> = []
    vi.spyOn(adapter, 'rejectQuestion').mockImplementation(() => new Promise<void>((resolve) => {
      refusals.push(resolve)
    }))

    // The wait runs out: expiry takes both and is telling OpenCode about req_a.
    await vi.advanceTimersByTimeAsync(300_000)
    await settle()
    expect(refusals).toHaveLength(1)
    // req_a's session ends meanwhile, and that teardown closes it.
    emitOpenCodeSessionEnded({ sessionId: 'ses_a', ticketId: ticket.id, reason: 'aborted' })
    refusals[0]?.()
    await settle()

    // req_b is still being refused, so a person is still being waited on.
    expect(refusals).toHaveLength(2)
    expect(isTicketWorkSuspended(ticket.id)).toBe(true)
    const summaries = () => listSkipEvents(ticket.id).filter((event) => event.isActionSummary)
    expect(summaries().map((event) => event.questionContext?.expiry_reason)).toEqual(['session_lost'])

    refusals[1]?.()
    await settle()
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)
    expect(summaries().map((event) => event.questionContext?.expiry_reason).sort()).toEqual(['session_lost', 'window_elapsed'])
  })

  it('names the same siblings on every receipt when a session with several questions ends', () => {
    const ticket = makeTicket()
    ask(ticket.id, { phase: 'DRAFTING_PRD' })
    ask(ticket.id, { requestId: 'req_b', phase: 'DRAFTING_PRD' })

    emitOpenCodeSessionEnded({ sessionId: 'ses_a', ticketId: ticket.id, reason: 'aborted' })

    const siblings = listSkipEvents(ticket.id)
      .filter((event) => event.isActionSummary)
      .map((event) => event.questionContext?.sibling_request_ids)
    expect(siblings.sort()).toEqual([['req_a'], ['req_b']])
  })

  it('closes a question whose reply is in flight when its session ends', () => {
    const ticket = makeTicket()
    ask(ticket.id, { phase: 'DRAFTING_BEADS' })
    expect(claimRequestForReply(ticket.id, 'ses_a', 'req_a')).toBeTruthy()

    emitOpenCodeSessionEnded({ sessionId: 'ses_a', ticketId: ticket.id, reason: 'aborted' })

    // Claimed for a reply that can no longer land, the request would otherwise
    // be stranded with the ticket's clocks held still.
    expect(getTicketQuestionState(ticket.id).requests).toEqual([])
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)
    const summary = listSkipEvents(ticket.id)
      .find((event) => event.surface === 'opencode_question' && event.isActionSummary)
    expect(summary?.skippedBy).toBe('system')
    expect(summary?.questionContext?.expiry_reason).toBe('session_lost')
  })

  it('refuses every request on the clock when the wait runs out', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const ticket = makeTicket()
    ask(ticket.id)
    ask(ticket.id, { sessionId: 'ses_b', requestId: 'req_b', memberId: 'openai/gpt' })

    await vi.advanceTimersByTimeAsync(300_000)
    await settle()
    await vi.advanceTimersByTimeAsync(1_500)
    await settle()

    // One clock for both, so both go down together.
    expect(adapter.questionRejections.map((entry) => entry.requestId).sort()).toEqual(['req_a', 'req_b'])
    expect(getPendingQuestionSummary(ticket.id)).toBeNull()
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)

    const events = listSkipEvents(ticket.id).filter((event) => event.surface === 'opencode_question')
    expect(events.every((event) => event.skippedBy === 'timeout')).toBe(true)
    const summaries = events.filter((event) => event.isActionSummary)
    expect(summaries).toHaveLength(2)
    expect(summaries.every((event) => event.questionContext?.expiry_reason === 'window_elapsed')).toBe(true)
    // Each receipt names the others the same expiry covered — including the one
    // refused last, which read live would have found the batch already gone and
    // reported that it went down alone.
    expect(summaries.map((event) => event.questionContext?.sibling_request_ids).sort()).toEqual([
      ['req_a'],
      ['req_b'],
    ])
  })

  it('never expires a stopped clock, however far the fake clock runs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const ticket = makeTicket()
    ask(ticket.id)
    stopTicketTimers(ticket.id)

    await vi.advanceTimersByTimeAsync(3_600_000)
    await settle()

    expect(adapter.questionRejections).toHaveLength(0)
    expect(getPendingQuestionSummary(ticket.id)?.requestCount).toBe(1)
  })

  it('falls back to a confirmed session abort when OpenCode will not take the rejection', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const ticket = makeTicket()
    ask(ticket.id)
    adapter.failRejectQuestion = true

    await vi.advanceTimersByTimeAsync(300_001)
    // The rejection retries with a backoff before giving up, and those delays
    // are on the same fake clock.
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()

    // A confirmed abort is the safe fallback: the remote session cannot keep
    // waiting on the question, so the local receipt can close it out.
    expect(getPendingQuestionSummary(ticket.id)).toBeNull()
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)
    const summary = listSkipEvents(ticket.id)
      .find((event) => event.surface === 'opencode_question' && event.isActionSummary)
    expect(summary?.reason).toMatch(/Could not tell OpenCode/)
  })

  it('retains a pending question when neither rejection nor session abort is confirmed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const ticket = makeTicket()
    ask(ticket.id)
    adapter.failRejectQuestion = true
    vi.spyOn(adapter, 'abortSession').mockResolvedValue(false)

    await vi.advanceTimersByTimeAsync(300_001)
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()

    // The model may still be running. Keep the request visible and the work
    // budget suspended until a later retry can prove the remote stop.
    expect(getPendingQuestionSummary(ticket.id)?.requestIds).toEqual(['req_a'])
    expect(isTicketWorkSuspended(ticket.id)).toBe(true)
    expect(listSkipEvents(ticket.id).filter((event) => event.surface === 'opencode_question')).toHaveLength(0)
  })

  it('retries an unconfirmed expiry on a future deadline and recovers after the stop confirms', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const ticket = makeTicket()
    ask(ticket.id)
    adapter.failRejectQuestion = true
    const abort = vi.spyOn(adapter, 'abortSession')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    await vi.advanceTimersByTimeAsync(300_000)
    await settle()
    await vi.advanceTimersByTimeAsync(1_500)
    await settle()

    const retryDeadline = Date.parse(getTicketQuestionState(ticket.id).timer!.deadlineAt)
    expect(retryDeadline).toBeGreaterThan(Date.now())
    expect(abort).toHaveBeenCalledTimes(1)
    expect(getPendingQuestionSummary(ticket.id)?.requestIds).toEqual(['req_a'])

    await vi.advanceTimersByTimeAsync(retryDeadline - Date.now() - 1)
    await settle()
    expect(abort).toHaveBeenCalledTimes(1)
    expect(getPendingQuestionSummary(ticket.id)?.requestIds).toEqual(['req_a'])

    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(abort).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_500)
    await settle()
    expect(abort).toHaveBeenCalledTimes(2)
    expect(getPendingQuestionSummary(ticket.id)).toBeNull()
  })

  it('retains cleanup windows when cancellation cannot confirm the remote stop', async () => {
    const ticket = makeTicket()
    ask(ticket.id)
    adapter.failRejectQuestion = true
    vi.spyOn(adapter, 'abortSession').mockResolvedValue(false)

    await clearTicketWindows(ticket.id, 'ticket_canceled', 'The ticket was canceled while the question was open.')

    expect(getPendingQuestionSummary(ticket.id)?.requestIds).toEqual(['req_a'])
    expect(isTicketWorkSuspended(ticket.id)).toBe(true)
    expect(listSkipEvents(ticket.id).filter((event) => event.surface === 'opencode_question')).toHaveLength(0)
  })

  it('does not erase a newer question window when cleanup loses ownership during rejection', async () => {
    const ticket = makeTicket()
    ask(ticket.id)
    let cleanupOwned = true
    vi.spyOn(adapter, 'rejectQuestion').mockImplementationOnce(async () => {
      cleanupOwned = false
      expect(ask(ticket.id, { sessionId: 'ses_new', requestId: 'req_new' })).toBe(true)
    })

    const cleared = await clearTicketWindows(
      ticket.id,
      'ticket_canceled',
      'The ticket was canceled while the question was open.',
      () => cleanupOwned,
    )

    expect(cleared).toBe(false)
    expect(getPendingQuestionSummary(ticket.id)?.requestIds).toEqual(['req_new'])
  })

  it('clamps a window outside the configurable range', () => {
    const ticket = makeTicket()
    const timer = armOrResetTimer({ ticketId: ticket.id, phase: 'CODING', phaseAttempt: 1, windowMs: 5 })
    expect(timer.windowMs).toBe(60_000)
  })

  it('does not push the deadline out when the same asked event arrives twice', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const ticket = makeTicket()
    ask(ticket.id)
    const first = getTicketQuestionState(ticket.id).timer!

    vi.advanceTimersByTime(240_000)
    expect(ask(ticket.id)).toBe(false)
    const second = getTicketQuestionState(ticket.id).timer!

    // A replayed frame is not new activity. Treating it as one would buy the
    // question another full window, and a stream that repeats would never expire.
    expect(second.deadlineAt).toBe(first.deadlineAt)
    expect(second.resetCount).toBe(0)
  })

  it('ignores an asked event that arrives after its own answer', () => {
    const ticket = makeTicket()
    ask(ticket.id)
    markRequestReplied(ticket.id, 'ses_a', 'req_a')

    // OpenCode has already been told. A second window here would suspend the
    // ticket's clocks with nothing left that could ever lift the suspension.
    expect(ask(ticket.id)).toBe(false)
    expect(getPendingQuestionSummary(ticket.id)).toBeNull()
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)
  })

  it('expires a request released back past its own deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const ticket = makeTicket()
    ask(ticket.id)

    // The shape of a near-deadline answer: claimed just in time, so expiry saw
    // `resolving` and left it alone — then the send failed.
    const claimId = claimRequestForReply(ticket.id, 'ses_a', 'req_a')
    await vi.advanceTimersByTimeAsync(300_001)
    expect(adapter.questionRejections).toHaveLength(0)

    releaseRequestClaim(ticket.id, 'ses_a', 'req_a', claimId ?? undefined)
    await settle()

    // Without the deadline re-check the request would go back to pending under a
    // timer that had already fired: a bounded wait turned unbounded.
    expect(adapter.questionRejections.map((entry) => entry.requestId)).toEqual(['req_a'])
    expect(getPendingQuestionSummary(ticket.id)).toBeNull()
    expect(isTicketWorkSuspended(ticket.id)).toBe(false)
  })

  it('does not expire a released claim while the clock is stopped', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const ticket = makeTicket()
    ask(ticket.id)
    stopTicketTimers(ticket.id)

    const claimId = claimRequestForReply(ticket.id, 'ses_a', 'req_a')
    await vi.advanceTimersByTimeAsync(3_600_000)
    releaseRequestClaim(ticket.id, 'ses_a', 'req_a', claimId ?? undefined)
    await settle()

    // Stop is a promise that the run waits for a person. A failed send does not
    // withdraw it.
    expect(adapter.questionRejections).toHaveLength(0)
    expect(getPendingQuestionSummary(ticket.id)?.requestCount).toBe(1)
  })

  it('rebuilds a stopped clock from its artifact instead of restarting it', async () => {
    const ticket = makeTicket()
    ask(ticket.id)
    stopTicketTimers(ticket.id)
    const stoppedAt = getTicketQuestionState(ticket.id).timer?.stoppedAt

    // The daemon goes away and comes back: live state gone, artifacts intact.
    resetAllQuestionWindows()
    resetAllWorkBudgets()
    const restored = readTimerArtifact(ticket.id, 'CODING', 1)
    expect(restored?.stoppedAt).not.toBeNull()

    ask(ticket.id, { restore: restored ?? undefined })
    const timer = getTicketQuestionState(ticket.id).timer!
    // A question someone deliberately parked must not start counting down again
    // because the daemon restarted overnight.
    expect(timer.stoppedAt).toBe(stoppedAt)
    await settle()
    expect(adapter.questionRejections).toHaveLength(0)
  })

  it('expires immediately when the deadline passed while the daemon was down', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const ticket = makeTicket()
    ask(ticket.id)
    const restored = readTimerArtifact(ticket.id, 'CODING', 1)

    resetAllQuestionWindows()
    resetAllWorkBudgets()
    // Longer than the window: the wait was already over before we came back.
    vi.setSystemTime(new Date('2026-01-01T02:00:00.000Z'))

    ask(ticket.id, { restore: restored ?? undefined })
    await vi.advanceTimersByTimeAsync(1)
    await settle()

    // Handing it a fresh full window instead would let a restart loop postpone
    // the expiry for as long as the restarts kept coming.
    expect(adapter.questionRejections.map((entry) => entry.requestId)).toEqual(['req_a'])
  })

  it('reconciles questions by trusted session directory and only closes confirmed orphans', async () => {
    const firstTicket = makeTicket()
    const secondTicket = makeTicket()
    const firstContext = getTicketContext(firstTicket.id)!
    const secondContext = getTicketContext(secondTicket.id)!
    adapter.sessions = [
      { id: 'ses_active', projectPath: firstContext.projectRoot, directory: '/tmp/worktree-active' },
      { id: 'ses_orphan', projectPath: secondContext.projectRoot, directory: '/tmp/worktree-orphan' },
    ]
    adapter.mockQuestions = [
      { id: 'req_active', sessionID: 'ses_active', questions: QUESTIONS },
      { id: 'req_orphan', sessionID: 'ses_orphan', questions: QUESTIONS },
    ]
    const listedSessionIds: Array<string | undefined> = []
    vi.spyOn(adapter as OpenCodeAdapter, 'listPendingQuestions').mockImplementation(async (_projectRoot, _signal, sessionId) => {
      listedSessionIds.push(sessionId)
      return adapter.mockQuestions.filter((request) => request.sessionID === sessionId)
    })

    const result = await reconcilePendingQuestionsAfterRestart({
      projectRoot: firstContext.projectRoot,
      owners: [
        { sessionId: 'ses_active', ticketId: firstTicket.id, memberId: null, phase: 'CODING', phaseAttempt: 1, active: true },
        { sessionId: 'ses_orphan', ticketId: secondTicket.id, memberId: null, phase: 'CODING', phaseAttempt: 1, active: false },
      ],
      windowMsFor: () => 60_000,
    })

    expect(listedSessionIds).toEqual(['ses_active', 'ses_orphan'])
    expect(result).toEqual({ reattached: 1, rejected: 1, unverified: 0 })
    expect(getPendingQuestionSummary(firstTicket.id)?.requestIds).toEqual(['req_active'])
    expect(adapter.questionRejections.map((entry) => entry.requestId)).toEqual(['req_orphan'])
  })

  it('reports an unverified owner when restart listing fails', async () => {
    const ticket = makeTicket()
    vi.spyOn(adapter as OpenCodeAdapter, 'listPendingQuestions').mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await reconcilePendingQuestionsAfterRestart({
      projectRoot: getTicketContext(ticket.id)!.projectRoot,
      owners: [{
        sessionId: 'ses_unverified',
        ticketId: ticket.id,
        memberId: null,
        phase: 'CODING',
        phaseAttempt: 1,
        active: true,
      }],
      windowMsFor: () => 60_000,
    })

    expect(result).toEqual({ reattached: 0, rejected: 0, unverified: 1 })
  })

  it('retries an unconfirmed restart orphan on the next sweep', async () => {
    vi.useFakeTimers()
    const ticket = makeTicket()
    const request = {
      id: 'req_restart_orphan',
      sessionID: 'ses_restart_orphan',
      questions: QUESTIONS,
    }
    adapter.mockQuestions = [request]
    adapter.failRejectQuestion = true
    const abort = vi.spyOn(adapter, 'abortSession')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const input = {
      projectRoot: getTicketContext(ticket.id)!.projectRoot,
      owners: [{
        sessionId: request.sessionID,
        ticketId: ticket.id,
        memberId: null,
        phase: 'CODING' as const,
        phaseAttempt: 1,
        active: false,
      }],
      windowMsFor: () => 60_000,
    }

    const firstPromise = reconcilePendingQuestionsAfterRestart(input)
    await vi.runAllTimersAsync()
    await expect(firstPromise).resolves.toEqual({ reattached: 0, rejected: 0, unverified: 1 })
    expect(abort).toHaveBeenCalledTimes(1)
    expect(adapter.mockQuestions).toHaveLength(1)

    const secondPromise = reconcilePendingQuestionsAfterRestart(input)
    await vi.runAllTimersAsync()
    await expect(secondPromise).resolves.toEqual({ reattached: 0, rejected: 1, unverified: 0 })
    expect(abort).toHaveBeenCalledTimes(2)
  })

  it('opens the wait when the question arrives, not when it is answered', () => {
    const ticket = makeTicket()
    ask(ticket.id)

    const context = getTicketContext(ticket.id)!
    // Recorded while it is still happening. Written only on resolution, a
    // question open right now would read as coding time until someone answered
    // it, and a restart mid-wait would lose everything before the restart.
    const open = context.projectDb.select().from(questionWaits).all()
    expect(open).toHaveLength(1)
    expect(open[0]?.endedAt).toBeNull()

    markRequestReplied(ticket.id, 'ses_a', 'req_a')
    const closed = context.projectDb.select().from(questionWaits).all()
    expect(closed).toHaveLength(1)
    expect(Date.parse(closed[0]!.endedAt!)).toBeGreaterThanOrEqual(Date.parse(closed[0]!.startedAt))
  })

  it('closes a wait the previous process left open', () => {
    const ticket = makeTicket()
    ask(ticket.id)
    const context = getTicketContext(ticket.id)!
    expect(context.projectDb.select().from(questionWaits).all()[0]?.endedAt).toBeNull()

    // The daemon goes away mid-wait: live state is gone, the open row is not.
    resetAllQuestionWindows()
    resetAllWorkBudgets()

    // Nothing is waiting on this ticket any more, so the interval is over.
    // Left open it reads as "still waiting, up to now" for the rest of the
    // ticket's life, subtracting all of it from active duration and from the
    // samples the ETA is trained on.
    expect(getPendingQuestionSummary(ticket.id)).toBeNull()
    closeQuestionWait(ticket.id, Date.now())
    expect(context.projectDb.select().from(questionWaits).all()[0]?.endedAt).not.toBeNull()
  })

  it('keeps one interval for two overlapping questions, not two', () => {
    const ticket = makeTicket()
    ask(ticket.id)
    ask(ticket.id, { sessionId: 'ses_b', requestId: 'req_b' })

    const context = getTicketContext(ticket.id)!
    // Two overlapping waits are one stretch of wall time. A row each would
    // subtract the same minutes twice from the ticket's active duration.
    expect(context.projectDb.select().from(questionWaits).all()).toHaveLength(1)

    markRequestReplied(ticket.id, 'ses_a', 'req_a')
    // Still waiting on the second, so the interval stays open.
    expect(context.projectDb.select().from(questionWaits).all()[0]?.endedAt).toBeNull()

    markRequestReplied(ticket.id, 'ses_b', 'req_b')
    const rows = context.projectDb.select().from(questionWaits).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.endedAt).not.toBeNull()
  })
})
