import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { interviewBatchClaims } from '../../db/schema'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import { createTicket, getTicketContext } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import {
  claimInterviewBatch,
  claimInterviewBatchAfterConfirmedStop,
  claimInterviewBatchStopRecovery,
  getPendingInterviewBatchStop,
  getPendingInterviewBatchStopToken,
  hasInFlightInterviewBatch,
  markInterviewBatchStopPending,
  renewInterviewBatchClaim,
  releaseInterviewBatch,
  releaseInterviewBatchStopRecovery,
} from '../phases/interviewPhase'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-interview-batch-claims-',
  files: { 'README.md': '# LoopTroop interview claim test\n' },
})

function makeTicket(): string {
  const project = attachProject({
    folderPath: repoManager.createRepo(),
    name: 'LoopTroop',
    shortname: 'LOOP',
  })
  return createTicket({ projectId: project.id, title: 'Interview claim', description: 'Claim ownership.' }).id
}

describe('interview batch claim ownership across daemon boots', () => {
  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('reclaims only a foreign claim whose owner is proven dead', () => {
    const ticket = makeTicket()
    const context = getTicketContext(ticket)
    expect(context).not.toBeNull()
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 424242) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      return true
    })
    try {
      context!.projectDb.insert(interviewBatchClaims).values({
        ticketId: context!.localTicketId,
        token: '424242:foreign-boot',
        claimedAt: '2026-09-17T00:00:00.000Z',
        expiresAt: '2099-09-17T01:00:00.000Z',
      }).run()

      expect(hasInFlightInterviewBatch(ticket)).toBe(false)
      const reclaimed = claimInterviewBatch(ticket)
      expect(reclaimed).toBeTruthy()
      expect(kill).toHaveBeenCalledWith(424242, 0)

      releaseInterviewBatch(ticket, reclaimed ?? undefined)
      context!.projectDb.insert(interviewBatchClaims).values({
        ticketId: context!.localTicketId,
        token: '424243:unverified-boot',
        claimedAt: '2026-09-17T00:00:00.000Z',
        expiresAt: '2099-09-17T01:00:00.000Z',
      }).run()
      kill.mockImplementation((pid) => {
        if (pid === 424243) throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
        return true
      })

      expect(claimInterviewBatch(ticket)).toBeNull()
    } finally {
      kill.mockRestore()
    }
  })

  it('keeps an uncertain stop owned until the matching retry confirms it', () => {
    const ticket = makeTicket()
    const claim = claimInterviewBatch(ticket)
    expect(claim).toBeTruthy()

    expect(markInterviewBatchStopPending(ticket, claim ?? '', 'answer')).toBe(true)
    expect(getPendingInterviewBatchStop(ticket)).toBe('answer')
    const pendingToken = getPendingInterviewBatchStopToken(ticket, 'answer')
    expect(pendingToken).toBeTruthy()
    // The marker uses a non-expiring lease. A normal claimant cannot bypass an
    // unverified remote stop by waiting for the ordinary TTL.
    expect(claimInterviewBatch(ticket, 0)).toBeNull()
    expect(claimInterviewBatchAfterConfirmedStop(ticket, 'skip', pendingToken ?? '')).toBeNull()

    const retryClaim = claimInterviewBatchAfterConfirmedStop(ticket, 'answer', pendingToken ?? '')
    expect(retryClaim).toBeTruthy()
    expect(getPendingInterviewBatchStop(ticket)).toBeNull()
    releaseInterviewBatch(ticket, retryClaim ?? undefined)
  })

  it('reserves a pending stop for one lifecycle recovery without clearing the stop fence', () => {
    const ticket = makeTicket()
    const batchClaim = claimInterviewBatch(ticket)
    expect(batchClaim).toBeTruthy()
    expect(markInterviewBatchStopPending(ticket, batchClaim ?? '', 'answer')).toBe(true)

    const recoveryClaim = claimInterviewBatchStopRecovery(ticket, 'answer')
    expect(recoveryClaim).toContain(':recovery:')
    expect(getPendingInterviewBatchStop(ticket)).toBe('answer')
    expect(getPendingInterviewBatchStopToken(ticket, 'answer')).toBeNull()
    expect(claimInterviewBatchStopRecovery(ticket, 'answer')).toBeNull()
    expect(claimInterviewBatch(ticket)).toBeNull()
    expect(renewInterviewBatchClaim(ticket, recoveryClaim ?? '')).toBe(true)

    expect(releaseInterviewBatchStopRecovery(ticket, recoveryClaim ?? '')).toBe(true)
    expect(getPendingInterviewBatchStopToken(ticket, 'answer')).not.toBe(recoveryClaim)
    expect(claimInterviewBatch(ticket)).toBeNull()
  })

  it('recovers only a pending-stop reservation whose daemon boot is proven dead', () => {
    const ticket = makeTicket()
    const context = getTicketContext(ticket)
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 424242) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      return true
    })
    try {
      context!.projectDb.insert(interviewBatchClaims).values({
        ticketId: context!.localTicketId,
        token: 'interview-stop-pending:answer:recovery:424242:old-boot:old-claim',
        claimedAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '9999-12-31T23:59:59.999Z',
      }).run()

      expect(claimInterviewBatch(ticket)).toBeNull()
      const recovered = claimInterviewBatchStopRecovery(ticket, 'answer')
      expect(recovered).toContain(':recovery:')
      expect(getPendingInterviewBatchStop(ticket)).toBe('answer')
      expect(kill).toHaveBeenCalledWith(424242, 0)
    } finally {
      kill.mockRestore()
    }
  })

  it.each(['alive', 'permission-denied'])('reclaims an aged reservation with %s liveness while retaining the stop fence', (liveness) => {
    const ticket = makeTicket()
    const context = getTicketContext(ticket)!
    context.projectDb.insert(interviewBatchClaims).values({
      ticketId: context.localTicketId,
      token: 'interview-stop-pending:answer:recovery:424242:recycled-boot:old-claim',
      claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      expiresAt: '9999-12-31T23:59:59.999Z',
    }).run()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (liveness === 'permission-denied') throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
      return true
    })
    try {
      const recovered = claimInterviewBatchStopRecovery(ticket, 'answer')
      expect(recovered).toContain(':recovery:')
      expect(claimInterviewBatch(ticket)).toBeNull()
      expect(claimInterviewBatchStopRecovery(ticket, 'answer')).toBeNull()
      expect(getPendingInterviewBatchStop(ticket)).toBe('answer')
    } finally { kill.mockRestore() }
  })

  it('promotes the lifecycle stop reservation only after confirmed stop and keeps the resulting claim releasable', () => {
    const ticket = makeTicket()
    const batchClaim = claimInterviewBatch(ticket)
    expect(batchClaim).toBeTruthy()
    expect(markInterviewBatchStopPending(ticket, batchClaim ?? '', 'answer')).toBe(true)

    const recoveryClaim = claimInterviewBatchStopRecovery(ticket, 'answer')
    expect(recoveryClaim).toBeTruthy()
    const confirmedClaim = claimInterviewBatchAfterConfirmedStop(ticket, 'answer', recoveryClaim ?? '')

    expect(confirmedClaim).toBeTruthy()
    expect(getPendingInterviewBatchStop(ticket)).toBeNull()
    expect(claimInterviewBatch(ticket)).toBeNull()
    releaseInterviewBatch(ticket, confirmedClaim ?? undefined)
    const nextClaim = claimInterviewBatch(ticket)
    expect(nextClaim).toBeTruthy()
    releaseInterviewBatch(ticket, nextClaim ?? undefined)
  })

  it('renews only the current lease generation and fences an expired successor', () => {
    const ticket = makeTicket()
    const liveClaim = claimInterviewBatch(ticket, 0)
    expect(liveClaim).toBeTruthy()

    expect(renewInterviewBatchClaim(ticket, liveClaim ?? '')).toBe(true)
    expect(claimInterviewBatch(ticket)).toBeNull()
    releaseInterviewBatch(ticket, liveClaim ?? undefined)

    const expiredClaim = claimInterviewBatch(ticket, 0)
    expect(expiredClaim).toBeTruthy()
    const successorClaim = claimInterviewBatch(ticket)
    expect(successorClaim).toBeTruthy()
    expect(successorClaim).not.toBe(expiredClaim)
    expect(renewInterviewBatchClaim(ticket, expiredClaim ?? '')).toBe(false)
    expect(renewInterviewBatchClaim(ticket, 'missing-claim')).toBe(false)

    releaseInterviewBatch(ticket, successorClaim ?? undefined)
  })

  it('does not turn a non-expiring pending-stop marker back into a lease', () => {
    const ticket = makeTicket()
    const claim = claimInterviewBatch(ticket)
    expect(claim).toBeTruthy()
    expect(markInterviewBatchStopPending(ticket, claim ?? '', 'answer')).toBe(true)
    const pendingToken = getPendingInterviewBatchStopToken(ticket, 'answer')
    expect(pendingToken).toBeTruthy()

    expect(renewInterviewBatchClaim(ticket, pendingToken ?? '')).toBe(false)
    expect(getPendingInterviewBatchStop(ticket)).toBe('answer')
    expect(claimInterviewBatch(ticket, 0)).toBeNull()

    releaseInterviewBatch(ticket, claim ?? undefined)
  })

  it('does not let a delayed confirmation promote a newer same-kind marker', async () => {
    const ticket = makeTicket()
    const firstClaim = claimInterviewBatch(ticket)
    expect(firstClaim).toBeTruthy()
    expect(markInterviewBatchStopPending(ticket, firstClaim ?? '', 'answer')).toBe(true)

    // Confirmation A captured M1 before its remote await. Retry B legitimately
    // promotes M1, starts a new generation, then leaves M2 after its own stop
    // becomes uncertain. A's eventual true result must not release M2.
    const markerM1 = getPendingInterviewBatchStopToken(ticket, 'answer')
    expect(markerM1).toBeTruthy()
    let resolveA: ((confirmed: boolean) => void) | undefined
    const delayedConfirmationA = new Promise<boolean>((resolve) => {
      resolveA = resolve
    })
    const retryB = claimInterviewBatchAfterConfirmedStop(ticket, 'answer', markerM1 ?? '')
    expect(retryB).toBeTruthy()
    expect(markInterviewBatchStopPending(ticket, retryB ?? '', 'answer')).toBe(true)
    const markerM2 = getPendingInterviewBatchStopToken(ticket, 'answer')
    expect(markerM2).toBeTruthy()
    expect(markerM2).not.toBe(markerM1)

    resolveA?.(true)
    expect(await delayedConfirmationA).toBe(true)
    expect(claimInterviewBatchAfterConfirmedStop(ticket, 'answer', markerM1 ?? '')).toBeNull()
    expect(getPendingInterviewBatchStopToken(ticket, 'answer')).toBe(markerM2)
    releaseInterviewBatch(ticket, retryB ?? undefined)
  })
})
