/**
 * Stop or restart one council member while the rest of its round keeps going.
 *
 * A council round waits for every member until one shared deadline, so a single
 * slow model can hold the whole step for the full AI response timeout. This
 * module is the handle a person gets on one member: the drafting and voting
 * engines run each member through a round, and the routes reach the live round
 * through the registry at the bottom.
 *
 * A member runs as a series of attempts. An attempt ends in one of three ways:
 *
 * - It settles, with any outcome, `stopped` included. The member then waits
 *   until a person asks for a retry or the round closes.
 * - A person restarts it. The attempt is interrupted, and a new one begins at
 *   once with no gap in which the round could close.
 * - It throws. The round is failing (a cancellation, or a session whose stop
 *   OpenCode would not confirm), and nothing may restart that member.
 *
 * The round closes the moment no member is still working, which is the moment
 * the step would have ended without this module. Restarting a settled member is
 * only possible before that.
 */

import type {
  CouncilMemberControlErrorCode,
  CouncilMemberRetryPart,
} from '@shared/councilMembers'
import type { WorkflowPhaseId } from '@shared/workflowMeta'
import { getErrorMessage } from '@shared/typeGuards'
import { CancelledError, type MemberOutcome } from './types'

export class CouncilMemberControlError extends Error {
  readonly code: CouncilMemberControlErrorCode

  constructor(code: CouncilMemberControlErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CouncilMemberControlError'
    this.code = code
  }
}

export type CouncilMemberInterruption = 'stop' | 'retry'

/** What an interrupted attempt's race rejects with. */
export class CouncilMemberInterruptedError extends Error {
  readonly reason: CouncilMemberInterruption

  constructor(reason: CouncilMemberInterruption) {
    super(reason === 'stop' ? 'Stopped by the user' : 'Restarted by the user')
    this.name = 'CouncilMemberInterruptedError'
    this.reason = reason
  }
}

/** One run of one member, as the engine running it sees it. */
export interface CouncilMemberAttempt {
  /** 1 for the member's first run in the round, then one more per restart. */
  readonly number: number
  /** Aborts when a person stops or restarts this attempt. */
  readonly signal: AbortSignal
  /**
   * Rejects with `CouncilMemberInterruptedError` on a stop or restart.
   *
   * Race it against the work. A prompt can ignore its abort signal, and the
   * person who pressed Stop is waiting on the answer.
   */
  readonly interrupted: Promise<never>
  /** Why this attempt was interrupted, or null while it was not. */
  interruption(): CouncilMemberInterruption | null
  /** Where the restart that began this attempt asked to start. Undefined on a first run. */
  readonly retryPart: CouncilMemberRetryPart | undefined
}

export interface CouncilMemberRestart {
  part: CouncilMemberRetryPart | undefined
}

export interface CouncilRoundOptions<T> {
  /** Without a ticket and a status the round still runs, but nothing can reach it. */
  ticketId?: string
  phase?: WorkflowPhaseId
  memberIds: readonly string[]
  /** The ticket's own signal. Aborting it closes the round. */
  signal?: AbortSignal
  outcomeOf: (result: T) => MemberOutcome
  /** A member's attempt settled and is not being restarted. Record it. */
  onSettled?: (memberId: string, result: T) => void
  /** A member is starting over. Forget what its previous attempt left behind. */
  onRestart?: (memberId: string, restart: CouncilMemberRestart) => void
  /**
   * A member left the round on an error rather than an outcome: its stop was
   * never confirmed, or recording it failed. The round itself fails once the
   * others settle; this lets the live view stop showing the member as working.
   */
  onFailed?: (memberId: string, error: unknown) => void
}

type ResumeDecision =
  | { kind: 'close' }
  /** `started` resolves once the run loop has dealt with the restart. */
  | { kind: 'retry'; part: CouncilMemberRetryPart | undefined; started: Deferred<undefined> }

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve: Deferred<T>['resolve'] = () => undefined
  let reject: Deferred<T>['reject'] = () => undefined
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

interface AttemptControl {
  view: CouncilMemberAttempt
  readonly controller: AbortController
  interruption: CouncilMemberInterruption | null
  retryPart: CouncilMemberRetryPart | undefined
  readonly interrupted: Deferred<never>
  /** Resolves once the run loop has dealt with this attempt's end. */
  readonly done: Deferred<undefined>
}

interface MemberSlot {
  readonly memberId: string
  /** `running` covers the gap between a retry request and the attempt it starts. */
  state: 'running' | 'settled' | 'dead'
  attempts: number
  attempt: AttemptControl | null
  outcome: MemberOutcome | null
  failure: unknown
  resume: ((decision: ResumeDecision) => void) | null
}

function beginAttempt(slot: MemberSlot, part: CouncilMemberRetryPart | undefined): AttemptControl {
  slot.attempts += 1
  slot.state = 'running'
  slot.outcome = null
  const interrupted = createDeferred<never>()
  // Handled here so an attempt that finished without racing it does not
  // surface as an unhandled rejection when it is interrupted later.
  interrupted.promise.catch(() => undefined)
  const control: AttemptControl = {
    view: undefined as unknown as CouncilMemberAttempt,
    controller: new AbortController(),
    interruption: null,
    retryPart: undefined,
    interrupted,
    done: createDeferred<undefined>(),
  }
  control.view = {
    number: slot.attempts,
    signal: control.controller.signal,
    interrupted: interrupted.promise,
    interruption: () => control.interruption,
    retryPart: part,
  }
  slot.attempt = control
  return control
}

function interruptAttempt(
  control: AttemptControl,
  reason: CouncilMemberInterruption,
  part?: CouncilMemberRetryPart,
): void {
  control.interruption = reason
  control.retryPart = part
  // A plain abort, so code below that tells an abort apart by its
  // `AbortError` name keeps doing so.
  control.controller.abort()
  control.interrupted.reject(new CouncilMemberInterruptedError(reason))
}

function requireInterruptibleAttempt(slot: MemberSlot): AttemptControl {
  const control = slot.attempt
  if (!control || control.interruption) {
    throw new CouncilMemberControlError('MEMBER_BUSY', 'That model is already being stopped or restarted.')
  }
  return control
}

/** The refusal for a member that left the round on an error, kept apart from a canceled ticket. */
function throwIfMemberDied(slot: MemberSlot): void {
  if (slot.state !== 'dead') return
  if (slot.failure instanceof CancelledError) {
    throw new CouncilMemberControlError('STEP_NOT_RUNNING', 'The ticket was canceled.', { cause: slot.failure })
  }
  throw new CouncilMemberControlError(
    'STOP_UNCONFIRMED',
    `This model's turn could not be ended cleanly, so the step will stop with an error once the other models finish: ${getErrorMessage(slot.failure)}`,
    { cause: slot.failure },
  )
}

export class CouncilRound<T> {
  private closed = false
  private readonly slots = new Map<string, MemberSlot>()
  private readonly onAbort = () => this.close()

  constructor(private readonly options: CouncilRoundOptions<T>) {
    for (const memberId of options.memberIds) {
      this.slots.set(memberId, {
        memberId,
        state: 'running',
        attempts: 0,
        attempt: null,
        outcome: null,
        failure: undefined,
        resume: null,
      })
    }
    if (options.ticketId && options.phase) registerRound(options.ticketId, options.phase, this)
    if (options.signal?.aborted) {
      this.close()
    } else {
      options.signal?.addEventListener('abort', this.onAbort, { once: true })
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Runs one member until the round closes.
   *
   * Resolves with the member's last settled result. Rejects when an attempt,
   * or the recording of its end, throws; that member is then out of the round
   * for good, and anyone waiting on it is answered rather than left hanging.
   */
  async run(memberId: string, runAttempt: (attempt: CouncilMemberAttempt) => Promise<T>): Promise<T> {
    const slot = this.slots.get(memberId)
    if (!slot) throw new Error(`Council member ${memberId} is not part of this round`)
    let part: CouncilMemberRetryPart | undefined
    for (;;) {
      const control = beginAttempt(slot, part)
      let result: T
      try {
        result = await runAttempt(control.view)
        slot.attempt = null
        if (control.interruption === 'retry' && !this.closed) {
          // Started again before `done` resolves, so the person who asked for
          // the restart is answered only once the new attempt is running.
          part = control.retryPart
          this.options.onRestart?.(memberId, { part })
          control.done.resolve(undefined)
          continue
        }
        slot.outcome = this.options.outcomeOf(result)
        this.options.onSettled?.(memberId, result)
        slot.state = 'settled'
        control.done.resolve(undefined)
      } catch (error) {
        this.failMember(slot, error)
        control.done.resolve(undefined)
        throw error
      }
      const decision = await this.waitForRetryOrClose(slot)
      // Only a canceled ticket closes a round under a member it is restarting.
      if (decision.kind === 'close' || this.closed) {
        slot.state = 'settled'
        if (decision.kind === 'retry') decision.started.resolve(undefined)
        return result
      }
      part = decision.part
      try {
        this.options.onRestart?.(memberId, { part })
      } catch (error) {
        this.failMember(slot, error)
        throw error
      } finally {
        decision.started.resolve(undefined)
      }
    }
  }

  /**
   * Stops a working member and resolves with how its turn ended.
   *
   * `beforeInterrupt` runs after the checks and right before the interruption,
   * in the same synchronous step, so nothing can claim or finish the member in
   * between.
   */
  async stop(memberId: string, beforeInterrupt?: () => void): Promise<MemberOutcome> {
    const slot = this.requireLiveSlot(memberId)
    if (slot.state === 'settled') {
      throw new CouncilMemberControlError('MEMBER_FINISHED', 'That model already finished its turn in this step.')
    }
    const control = requireInterruptibleAttempt(slot)
    beforeInterrupt?.()
    interruptAttempt(control, 'stop')
    await control.done.promise
    throwIfMemberDied(slot)
    return slot.outcome ?? 'stopped'
  }

  /**
   * Starts a member over with a fresh attempt.
   *
   * A working member is interrupted first. Either way this resolves once the
   * restart is recorded and the new attempt is running, and rejects when the
   * member left the round instead: its stop was never confirmed, or recording
   * the restart failed. `beforeInterrupt` runs after the checks and right
   * before the restart, as for a stop.
   */
  async retry(memberId: string, part?: CouncilMemberRetryPart, beforeInterrupt?: () => void): Promise<void> {
    const slot = this.requireLiveSlot(memberId)
    if (slot.state === 'settled') {
      const resume = slot.resume
      if (!resume) {
        throw new CouncilMemberControlError('MEMBER_BUSY', 'That model is already being stopped or restarted.')
      }
      beforeInterrupt?.()
      // Marked running before the run loop wakes, so a member settling in the
      // meantime cannot close the round under this restart.
      slot.resume = null
      slot.state = 'running'
      const started = createDeferred<undefined>()
      resume({ kind: 'retry', part, started })
      await started.promise
      throwIfMemberDied(slot)
      return
    }
    const control = requireInterruptibleAttempt(slot)
    beforeInterrupt?.()
    interruptAttempt(control, 'retry', part)
    await control.done.promise
    throwIfMemberDied(slot)
  }

  /** Ends the round: every settled member returns its result. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.options.signal?.removeEventListener('abort', this.onAbort)
    if (this.options.ticketId && this.options.phase) {
      unregisterRound(this.options.ticketId, this.options.phase, this)
    }
    for (const slot of this.slots.values()) {
      const resume = slot.resume
      slot.resume = null
      resume?.({ kind: 'close' })
    }
  }

  private failMember(slot: MemberSlot, error: unknown): void {
    slot.state = 'dead'
    slot.failure = error
    slot.attempt = null
    if (!(error instanceof CancelledError)) {
      try {
        this.options.onFailed?.(slot.memberId, error)
      } catch (reportError) {
        console.warn(`[council] Could not record why ${slot.memberId} left the round:`, reportError)
      }
    }
    this.closeIfIdle()
  }

  private waitForRetryOrClose(slot: MemberSlot): Promise<ResumeDecision> {
    if (this.closed) return Promise.resolve({ kind: 'close' })
    const decision = new Promise<ResumeDecision>((resolve) => {
      slot.resume = resolve
    })
    this.closeIfIdle()
    return decision
  }

  private closeIfIdle(): void {
    for (const slot of this.slots.values()) {
      if (slot.state === 'running') return
    }
    this.close()
  }

  private requireLiveSlot(memberId: string): MemberSlot {
    const slot = this.slots.get(memberId)
    if (!slot) {
      throw new CouncilMemberControlError('UNKNOWN_MEMBER', `${memberId} is not on this step's council.`)
    }
    throwIfMemberDied(slot)
    if (this.closed) {
      throw new CouncilMemberControlError('STEP_NOT_RUNNING', 'This step is no longer running.')
    }
    return slot
  }
}

export function openCouncilRound<T>(options: CouncilRoundOptions<T>): CouncilRound<T> {
  return new CouncilRound(options)
}

// ── Registry ─────────────────────────────────────────────────────────────────

/** What the routes may do with a live round, whatever its members return. */
interface CouncilRoundHandle {
  readonly isClosed: boolean
  stop(memberId: string, beforeInterrupt?: () => void): Promise<MemberOutcome>
  retry(memberId: string, part?: CouncilMemberRetryPart, beforeInterrupt?: () => void): Promise<void>
  close(): void
}

/** `ticketId` + status → the round running there. One status runs one round at a time. */
const rounds = new Map<string, CouncilRoundHandle>()

function roundKey(ticketId: string, phase: WorkflowPhaseId): string {
  return `${ticketId}\u0000${phase}`
}

function registerRound(ticketId: string, phase: WorkflowPhaseId, round: CouncilRoundHandle): void {
  const key = roundKey(ticketId, phase)
  const previous = rounds.get(key)
  // A replaced round is one whose handler already left without closing it. It
  // can no longer be reached, so the newer round takes the key.
  if (previous && previous !== round && !previous.isClosed) {
    console.warn(`[council] A second ${phase} round started for ${ticketId}; the newer one takes the controls`)
  }
  rounds.set(key, round)
}

function unregisterRound(ticketId: string, phase: WorkflowPhaseId, round: CouncilRoundHandle): void {
  const key = roundKey(ticketId, phase)
  if (rounds.get(key) === round) rounds.delete(key)
}

function requireRound(ticketId: string, phase: WorkflowPhaseId): CouncilRoundHandle {
  const round = rounds.get(roundKey(ticketId, phase))
  if (!round) {
    throw new CouncilMemberControlError('STEP_NOT_RUNNING', 'This step is no longer running.')
  }
  return round
}

/** Test seam: whether a round of that status is registered for the ticket. */
export function hasLiveCouncilRound(ticketId: string, phase: WorkflowPhaseId): boolean {
  return rounds.has(roundKey(ticketId, phase))
}

/**
 * Stops one working member of a live round. `beforeInterrupt` runs once the
 * stop is certain to happen, right before the member is interrupted.
 */
export async function stopCouncilMember(
  ticketId: string,
  phase: WorkflowPhaseId,
  memberId: string,
  beforeInterrupt?: () => void,
): Promise<MemberOutcome> {
  return await requireRound(ticketId, phase).stop(memberId, beforeInterrupt)
}

/**
 * Restarts one member of a live round. `beforeInterrupt` runs once the restart
 * is certain to happen, right before it does.
 */
export async function retryCouncilMember(
  ticketId: string,
  phase: WorkflowPhaseId,
  memberId: string,
  part?: CouncilMemberRetryPart,
  beforeInterrupt?: () => void,
): Promise<void> {
  await requireRound(ticketId, phase).retry(memberId, part, beforeInterrupt)
}

/** Test seam. Never called from production paths. */
export function resetCouncilRounds(): void {
  for (const round of [...rounds.values()]) round.close()
  rounds.clear()
}
