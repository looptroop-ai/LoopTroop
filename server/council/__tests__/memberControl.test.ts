import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CouncilMemberInterruptedError,
  hasLiveCouncilRound,
  openCouncilRound,
  resetCouncilRounds,
  retryCouncilMember,
  stopCouncilMember,
  type CouncilMemberAttempt,
} from '../memberControl'
import { CancelledError, type MemberOutcome } from '../types'

const TICKET = 'project-1:TICKET-1'
const PHASE = 'COUNCIL_DELIBERATING' as const

interface Result {
  memberId: string
  outcome: MemberOutcome
  attempt: number
}

/**
 * A member attempt the test settles by hand, or that a stop or restart ends.
 *
 * An interrupted attempt reports `stopped`, as the engines do; the round decides
 * whether that counts (a stop) or is thrown away (a restart).
 */
function controllableAttempts() {
  const finishers = new Map<string, (outcome: MemberOutcome) => void>()
  const failers = new Map<string, (error: Error) => void>()
  const attempts: Array<{ memberId: string; attempt: CouncilMemberAttempt }> = []
  const run = (memberId: string) => (attempt: CouncilMemberAttempt) => {
    attempts.push({ memberId, attempt })
    const work = new Promise<Result>((resolve, reject) => {
      finishers.set(memberId, (outcome) => resolve({ memberId, outcome, attempt: attempt.number }))
      failers.set(memberId, reject)
    })
    return Promise.race([work, attempt.interrupted]).catch((error: unknown) => {
      if (error instanceof CouncilMemberInterruptedError) {
        return { memberId, outcome: 'stopped' as const, attempt: attempt.number }
      }
      throw error
    })
  }
  return {
    run,
    attempts,
    finish: (memberId: string, outcome: MemberOutcome = 'completed') => finishers.get(memberId)?.(outcome),
    fail: (memberId: string, error: Error) => failers.get(memberId)?.(error),
  }
}

function openRound(memberIds: string[], signal?: AbortSignal) {
  const settled: Result[] = []
  const restarts: Array<{ memberId: string; part: unknown }> = []
  const failed: Array<{ memberId: string; error: unknown }> = []
  const round = openCouncilRound<Result>({
    ticketId: TICKET,
    phase: PHASE,
    memberIds,
    signal,
    outcomeOf: (result) => result.outcome,
    onSettled: (_memberId, result) => settled.push(result),
    onRestart: (memberId, restart) => restarts.push({ memberId, ...restart }),
    onFailed: (memberId, error) => failed.push({ memberId, error }),
  })
  return { round, settled, restarts, failed }
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

describe('council member control', () => {
  afterEach(() => {
    resetCouncilRounds()
  })

  it('stops one working member and lets the others carry on', async () => {
    const control = controllableAttempts()
    const { round, settled } = openRound(['a', 'b'])
    const runs = Promise.all([round.run('a', control.run('a')), round.run('b', control.run('b'))])

    await expect(stopCouncilMember(TICKET, PHASE, 'a')).resolves.toBe('stopped')
    expect(control.attempts.find((entry) => entry.memberId === 'a')!.attempt.signal.aborted).toBe(true)
    expect(settled).toEqual([{ memberId: 'a', outcome: 'stopped', attempt: 1 }])
    expect(hasLiveCouncilRound(TICKET, PHASE)).toBe(true)

    control.finish('b')
    await expect(runs).resolves.toEqual([
      { memberId: 'a', outcome: 'stopped', attempt: 1 },
      { memberId: 'b', outcome: 'completed', attempt: 1 },
    ])
    expect(hasLiveCouncilRound(TICKET, PHASE)).toBe(false)
  })

  it('ends the round as soon as the last working member is stopped', async () => {
    const control = controllableAttempts()
    const { round } = openRound(['a', 'b'])
    const runs = Promise.all([round.run('a', control.run('a')), round.run('b', control.run('b'))])
    control.finish('a')
    await flush()

    await stopCouncilMember(TICKET, PHASE, 'b')
    await expect(runs).resolves.toEqual([
      { memberId: 'a', outcome: 'completed', attempt: 1 },
      { memberId: 'b', outcome: 'stopped', attempt: 1 },
    ])
    expect(round.isClosed).toBe(true)
  })

  it('refuses to stop a member that already finished, or one already being stopped', async () => {
    const control = controllableAttempts()
    const { round } = openRound(['a', 'b'])
    void round.run('a', control.run('a'))
    void round.run('b', control.run('b'))
    control.finish('a')
    await flush()

    const beforeInterrupt = vi.fn()
    await expect(stopCouncilMember(TICKET, PHASE, 'a', beforeInterrupt)).rejects.toMatchObject({ code: 'MEMBER_FINISHED' })
    expect(beforeInterrupt).not.toHaveBeenCalled()

    const first = stopCouncilMember(TICKET, PHASE, 'b')
    await expect(stopCouncilMember(TICKET, PHASE, 'b')).rejects.toMatchObject({ code: 'MEMBER_BUSY' })
    await first
  })

  it('refuses members it does not know and rounds that are not running', async () => {
    const control = controllableAttempts()
    const { round } = openRound(['a'])
    const run = round.run('a', control.run('a'))

    await expect(stopCouncilMember(TICKET, PHASE, 'nobody')).rejects.toMatchObject({ code: 'UNKNOWN_MEMBER' })
    await expect(stopCouncilMember(TICKET, 'DRAFTING_BEADS', 'a')).rejects.toMatchObject({ code: 'STEP_NOT_RUNNING' })

    control.finish('a')
    await run
    await expect(retryCouncilMember(TICKET, PHASE, 'a')).rejects.toMatchObject({ code: 'STEP_NOT_RUNNING' })
  })

  it('restarts a working member at once, without recording the abandoned attempt', async () => {
    const control = controllableAttempts()
    const { round, settled, restarts } = openRound(['a', 'b'])
    const runA = round.run('a', control.run('a'))
    void round.run('b', control.run('b'))

    const beforeInterrupt = vi.fn(() => {
      // Runs right before the interruption, in the same synchronous step.
      expect(control.attempts.find((entry) => entry.memberId === 'a')?.attempt.interruption()).toBeNull()
    })
    await retryCouncilMember(TICKET, PHASE, 'a', 'prd_draft', beforeInterrupt)
    expect(beforeInterrupt).toHaveBeenCalledTimes(1)

    const attemptsOfA = control.attempts.filter((entry) => entry.memberId === 'a')
    expect(attemptsOfA.map((entry) => entry.attempt.number)).toEqual([1, 2])
    expect(attemptsOfA[0]!.attempt.interruption()).toBe('retry')
    expect(attemptsOfA[1]!.attempt.retryPart).toBe('prd_draft')
    expect(attemptsOfA[1]!.attempt.signal.aborted).toBe(false)
    expect(restarts).toEqual([{ memberId: 'a', part: 'prd_draft' }])
    expect(settled).toEqual([])

    control.finish('a')
    control.finish('b')
    await expect(runA).resolves.toEqual({ memberId: 'a', outcome: 'completed', attempt: 2 })
  })

  it('restarts a member that already finished while another is still working', async () => {
    const control = controllableAttempts()
    const { round, settled, restarts } = openRound(['a', 'b'])
    const runA = round.run('a', control.run('a'))
    const runB = round.run('b', control.run('b'))
    control.finish('a', 'completed')
    await flush()

    // A settled member has nothing to interrupt, but the hook still runs, right
    // before the restart begins, so anything it left open is closed in time.
    const beforeInterrupt = vi.fn(() => {
      expect(restarts).toEqual([])
    })
    await retryCouncilMember(TICKET, PHASE, 'a', undefined, beforeInterrupt)
    await flush()
    expect(beforeInterrupt).toHaveBeenCalledTimes(1)
    expect(restarts).toEqual([{ memberId: 'a', part: undefined }])

    // B finishing no longer closes the round: A is working again.
    control.finish('b')
    await flush()
    expect(round.isClosed).toBe(false)

    control.finish('a', 'invalid_output')
    await expect(runA).resolves.toEqual({ memberId: 'a', outcome: 'invalid_output', attempt: 2 })
    await expect(runB).resolves.toEqual({ memberId: 'b', outcome: 'completed', attempt: 1 })
    // The earlier finished draft is gone for good.
    expect(settled.filter((result) => result.memberId === 'a')).toEqual([
      { memberId: 'a', outcome: 'completed', attempt: 1 },
      { memberId: 'a', outcome: 'invalid_output', attempt: 2 },
    ])
  })

  it('reports a stop whose session could not be confirmed, and closes once the rest settle', async () => {
    const control = controllableAttempts()
    const { round, failed } = openRound(['a', 'b'])
    const runA = round.run('a', async (attempt) => {
      await attempt.interrupted.catch(() => {})
      throw new Error('Could not confirm abort of OpenCode session s-1')
    })
    const runB = round.run('b', control.run('b'))

    await expect(stopCouncilMember(TICKET, PHASE, 'a')).rejects.toMatchObject({ code: 'STOP_UNCONFIRMED' })
    await expect(runA).rejects.toThrow('Could not confirm abort')
    // The live view hears the member is gone, so it no longer shows it working.
    expect(failed.map((entry) => entry.memberId)).toEqual(['a'])
    // The round still runs for the others, so the refusal names the member's
    // failure rather than claiming the step is over.
    await expect(retryCouncilMember(TICKET, PHASE, 'a')).rejects.toMatchObject({ code: 'STOP_UNCONFIRMED' })

    control.finish('b')
    await runB
    expect(round.isClosed).toBe(true)
  })

  it('answers a stop whose result could not be recorded instead of leaving it hanging', async () => {
    const control = controllableAttempts()
    const failed: string[] = []
    const round = openCouncilRound<Result>({
      ticketId: TICKET,
      phase: PHASE,
      memberIds: ['a', 'b'],
      outcomeOf: (result) => result.outcome,
      onSettled: (memberId) => {
        if (memberId === 'a') throw new Error('artifact write failed')
      },
      onFailed: (memberId) => failed.push(memberId),
    })
    const runA = round.run('a', control.run('a'))
    const runB = round.run('b', control.run('b'))

    await expect(stopCouncilMember(TICKET, PHASE, 'a')).rejects.toMatchObject({ code: 'STOP_UNCONFIRMED' })
    await expect(runA).rejects.toThrow('artifact write failed')
    expect(failed).toEqual(['a'])

    control.finish('b')
    await expect(runB).resolves.toMatchObject({ outcome: 'completed' })
    expect(round.isClosed).toBe(true)
  })

  it('lets the round close when restarting a finished member cannot be recorded', async () => {
    const control = controllableAttempts()
    const round = openCouncilRound<Result>({
      ticketId: TICKET,
      phase: PHASE,
      memberIds: ['a', 'b'],
      outcomeOf: (result) => result.outcome,
      onRestart: () => {
        throw new Error('artifact reset failed')
      },
    })
    const runA = round.run('a', control.run('a'))
    const runB = round.run('b', control.run('b'))
    control.finish('a')
    await flush()

    // Answered with the failure, not a success for a restart that never began.
    await expect(retryCouncilMember(TICKET, PHASE, 'a')).rejects.toMatchObject({ code: 'STOP_UNCONFIRMED' })
    await expect(runA).rejects.toThrow('artifact reset failed')

    control.finish('b')
    await expect(runB).resolves.toMatchObject({ outcome: 'completed' })
    expect(round.isClosed).toBe(true)
  })

  it('refuses a second action on a member as soon as the first one is accepted', async () => {
    const control = controllableAttempts()
    const { round } = openRound(['a', 'b'])
    void round.run('a', control.run('a'))
    void round.run('b', control.run('b'))

    // The first action is reserved synchronously, with nothing awaited between
    // its checks and the interruption.
    const first = retryCouncilMember(TICKET, PHASE, 'a')
    await expect(stopCouncilMember(TICKET, PHASE, 'a')).rejects.toMatchObject({ code: 'MEMBER_BUSY' })
    await first
    expect(control.attempts.filter((entry) => entry.memberId === 'a').map((entry) => entry.attempt.number)).toEqual([1, 2])
  })

  it('says the ticket was canceled when a cancellation ends the member being stopped', async () => {
    const { round } = openRound(['a'])
    const runA = round.run('a', async (attempt) => {
      await attempt.interrupted.catch(() => {})
      throw new CancelledError()
    })
    await expect(stopCouncilMember(TICKET, PHASE, 'a')).rejects.toMatchObject({ code: 'STEP_NOT_RUNNING' })
    await expect(runA).rejects.toBeInstanceOf(CancelledError)
  })

  it('closes on the ticket signal and releases members waiting for a retry', async () => {
    const control = controllableAttempts()
    const abort = new AbortController()
    const { round } = openRound(['a', 'b'], abort.signal)
    const runA = round.run('a', control.run('a'))
    void round.run('b', control.run('b'))
    control.finish('a')
    await flush()

    abort.abort()
    await expect(runA).resolves.toEqual({ memberId: 'a', outcome: 'completed', attempt: 1 })
    expect(round.isClosed).toBe(true)
    expect(hasLiveCouncilRound(TICKET, PHASE)).toBe(false)
  })

  it('answers a restart of a finished member that a cancel overtakes', async () => {
    const control = controllableAttempts()
    const abort = new AbortController()
    const { round, restarts } = openRound(['a', 'b'], abort.signal)
    const runA = round.run('a', control.run('a'))
    void round.run('b', control.run('b'))
    control.finish('a')
    await flush()

    // The cancel lands before the run loop wakes up for the restart.
    const retry = retryCouncilMember(TICKET, PHASE, 'a')
    abort.abort()
    await expect(retry).resolves.toBeUndefined()
    await expect(runA).resolves.toMatchObject({ outcome: 'completed', attempt: 1 })
    expect(restarts).toEqual([])
  })

  it('leaves the newer round in charge when an older one closes late', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const older = openRound(['a'])
    const newer = openRound(['a'])
    expect(warn).toHaveBeenCalledTimes(1)
    older.round.close()
    expect(hasLiveCouncilRound(TICKET, PHASE)).toBe(true)
    newer.round.close()
    expect(hasLiveCouncilRound(TICKET, PHASE)).toBe(false)
    warn.mockRestore()
  })
})
