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
  getPendingQuestionSummary,
  getTicketQuestionState,
  markRequestReplied,
  markRequestSkipped,
  reconcileAgainstPending,
  resetAllQuestionWindows,
  stopTicketTimers,
} from '../questionWindows'
import type { OpenCodeQuestionInfo } from '../../opencode/types'

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
  })

  afterEach(() => {
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
    expect(claimRequestForReply(ticket.id, 'ses_a', 'req_a')).toBe(true)
    // The loser of an answer-versus-expiry race must do nothing at all rather
    // than send a second verdict for a question that already has one.
    expect(claimRequestForReply(ticket.id, 'ses_a', 'req_a')).toBe(false)
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

  it('clamps a window outside the configurable range', () => {
    const ticket = makeTicket()
    const timer = armOrResetTimer({ ticketId: ticket.id, phase: 'CODING', phaseAttempt: 1, windowMs: 5 })
    expect(timer.windowMs).toBe(60_000)
  })
})
