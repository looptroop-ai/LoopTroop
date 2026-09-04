import { beforeEach, describe, expect, it } from 'vitest'
import { cleanupTicketState } from '../phases/state'
import {
  claimInterviewBatch,
  hasInFlightInterviewBatch,
  releaseInterviewBatch,
} from '../phases/interviewPhase'
import {
  isTicketWorkSuspended,
  resetAllWorkBudgets,
  suspendTicketWork,
} from '../workBudget'
import {
  clearAllPendingSessionContinuationsForTests,
  hasPendingSessionContinuationForTicketPhase,
  requestSessionContinuation,
} from '../../opencode/sessionContinuation'

const TICKET = 'lifecycle-cleanup-ticket'

describe('interview batch claim', () => {
  beforeEach(() => {
    releaseInterviewBatch(TICKET)
  })

  it('admits one claim and refuses the next until it is released', () => {
    expect(claimInterviewBatch(TICKET)).toBe(true)
    // A session existing is not the same as a batch being available: the first
    // request clears currentBatch, and the second used to be accepted anyway.
    expect(claimInterviewBatch(TICKET)).toBe(false)
    expect(hasInFlightInterviewBatch(TICKET)).toBe(true)

    releaseInterviewBatch(TICKET)
    expect(hasInFlightInterviewBatch(TICKET)).toBe(false)
    expect(claimInterviewBatch(TICKET)).toBe(true)
  })

  it('keeps claims separate per ticket', () => {
    expect(claimInterviewBatch(TICKET)).toBe(true)
    expect(claimInterviewBatch(`${TICKET}-other`)).toBe(true)
    releaseInterviewBatch(`${TICKET}-other`)
  })
})

describe('cleanupTicketState', () => {
  beforeEach(() => {
    resetAllWorkBudgets()
  })

  it('drops the work-budget ledger', () => {
    suspendTicketWork(TICKET)
    expect(isTicketWorkSuspended(TICKET)).toBe(true)

    // Every cancel, completion and restart passes through here. Clearing only
    // from the cancel route left a restart — which cancels and then continues
    // the same ticket id — holding the next run's clocks still.
    cleanupTicketState(TICKET)

    expect(isTicketWorkSuspended(TICKET)).toBe(false)
  })

  it('drops pending session continuations', () => {
    clearAllPendingSessionContinuationsForTests()
    requestSessionContinuation({
      ticketId: TICKET,
      phase: 'WAITING_INTERVIEW_ANSWERS',
      sessionId: 'session-lifecycle-1',
      additionalRetryAttempts: 2,
    })
    expect(hasPendingSessionContinuationForTicketPhase(TICKET, 'WAITING_INTERVIEW_ANSWERS')).toBe(true)

    // Only `abortTicketSessions` used to clear these, so a ticket that
    // completed naturally kept them for their full thirty-minute life and a
    // restart of the same ticket id reapplied the finished run's retries.
    cleanupTicketState(TICKET)

    expect(hasPendingSessionContinuationForTicketPhase(TICKET, 'WAITING_INTERVIEW_ANSWERS')).toBe(false)
  })

  it('leaves another ticket\'s continuations alone', () => {
    clearAllPendingSessionContinuationsForTests()
    requestSessionContinuation({
      ticketId: `${TICKET}-other`,
      phase: 'WAITING_INTERVIEW_ANSWERS',
      sessionId: 'session-lifecycle-2',
    })

    cleanupTicketState(TICKET)

    expect(hasPendingSessionContinuationForTicketPhase(`${TICKET}-other`, 'WAITING_INTERVIEW_ANSWERS')).toBe(true)
    clearAllPendingSessionContinuationsForTests()
  })
})
