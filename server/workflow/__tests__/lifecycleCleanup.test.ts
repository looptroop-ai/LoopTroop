import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import { createTicket } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
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

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-lifecycle-cleanup-',
  files: {
    'README.md': '# LoopTroop Lifecycle Cleanup Test\n',
  },
})

afterAll(() => {
  clearProjectDatabaseCache()
  repoManager.cleanup()
})

/**
 * A real ticket, because the batch claim now lives in the project database —
 * the point of it being there is that a second daemon can see it.
 */
function makeTicket(title = 'Lifecycle cleanup'): string {
  const project = attachProject({
    folderPath: repoManager.createRepo(),
    name: 'LoopTroop',
    shortname: 'LOOP',
  })
  return createTicket({ projectId: project.id, title, description: 'Lifecycle cleanup test.' }).id
}

function resetDatabase(): void {
  clearProjectDatabaseCache()
  initializeDatabase()
  sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
}

describe('interview batch claim', () => {
  beforeEach(resetDatabase)

  it('admits one claim and refuses the next until it is released', () => {
    const ticket = makeTicket()
    const token = claimInterviewBatch(ticket)
    expect(token).toBeTruthy()
    // A session existing is not the same as a batch being available: the first
    // request clears currentBatch, and the second used to be accepted anyway.
    expect(claimInterviewBatch(ticket)).toBeNull()
    expect(hasInFlightInterviewBatch(ticket)).toBe(true)

    releaseInterviewBatch(ticket, token ?? undefined)
    expect(hasInFlightInterviewBatch(ticket)).toBe(false)
    expect(claimInterviewBatch(ticket)).toBeTruthy()
  })

  it('keeps claims separate per ticket', () => {
    const first = makeTicket('First')
    const second = makeTicket('Second')
    expect(claimInterviewBatch(first)).toBeTruthy()
    expect(claimInterviewBatch(second)).toBeTruthy()
  })

  it('refuses a release from an acquisition that no longer holds the claim', () => {
    const ticket = makeTicket()
    const stale = claimInterviewBatch(ticket, 1)
    expect(stale).toBeTruthy()

    // The first claim has already expired, so a second run takes it over. The
    // first run finishing afterwards must not delete what the second is
    // holding — the fault `server/io/fileLock.ts` carries a token to prevent.
    const current = claimInterviewBatch(ticket)
    expect(current).toBeTruthy()

    releaseInterviewBatch(ticket, stale ?? undefined)
    expect(hasInFlightInterviewBatch(ticket)).toBe(true)

    releaseInterviewBatch(ticket, current ?? undefined)
    expect(hasInFlightInterviewBatch(ticket)).toBe(false)
  })

  it('lets a later run take over a claim whose holder is gone', () => {
    const ticket = makeTicket()
    // A daemon that dies holding a claim releases nothing. The expiry is what
    // stops that from wedging the ticket until someone deletes the row.
    expect(claimInterviewBatch(ticket, 1)).toBeTruthy()
    expect(hasInFlightInterviewBatch(ticket)).toBe(false)
    expect(claimInterviewBatch(ticket)).toBeTruthy()
  })
})

describe('cleanupTicketState', () => {
  let TICKET = ''

  beforeEach(() => {
    resetDatabase()
    resetAllWorkBudgets()
    TICKET = makeTicket()
  })

  it('drops the batch claim, whoever holds it', () => {
    expect(claimInterviewBatch(TICKET)).toBeTruthy()

    // A ticket that has reached a terminal state has no legitimate batch in
    // flight, so the claim on it belongs to a run that is over.
    cleanupTicketState(TICKET)

    expect(hasInFlightInterviewBatch(TICKET)).toBe(false)
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
