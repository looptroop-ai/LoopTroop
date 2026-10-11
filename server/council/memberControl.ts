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
  /** The number the new attempt will carry. */
  attempt: number
  part: CouncilMemberRetryPart | undefined
  /** How the abandoned attempt stood: `pending` when it was cut off mid-run. */
  previousOutcome: MemberOutcome
}

export interface CouncilRoundOptions<T> {
  /** Without a ticket and a status the round still runs, but nothing can reach it. */
  ticketId?: string | undefined
  phase?: WorkflowPhaseId | undefined
  memberIds: readonly string[]
  /** The ticket's own signal. Aborting it closes the round. */
  signal?: AbortSignal | undefined
  outcomeOf: (result: T) => MemberOutcome
  /** A member's attempt settled and is not being restarted. Record it. */
  onSettled?: (memberId: string, result: T) => void
  /** A member is starting over. Forget what its previous attempt left behind. */
  onRestart?: (memberId: string, restart: CouncilMemberRestart) => void
}

type ResumeDecision =
  | { kind: 'close' }
  | { kind: 'retry'; part: CouncilMemberRetryPart | undefined }

interface AttemptControl {
  view: CouncilMemberAttempt
  readonly controller: AbortController
  interruption: CouncilMemberInterruption | null
  retryPart: CouncilMemberRetryPart | undefined
  readonly reject: (error: Error) => void
  /** Resolves once the run loop has dealt with this attempt's end. */
  readonly done: Promise<void>
  readonly resolveDone: () => void
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
   * Resolves with the member's last settled result. Rejects when an attempt
   * throws, and that member is then out of the round for good.
   */
  async run(memberId: string, runAttempt: (attempt: CouncilMemberAttempt) => Promise<T>): Promise<T> {
    const slot = this.slots.get(memberId)
    if (!slot) throw new Error(`Council member ${memberId} is not part of this round`)
    let part: CouncilMemberRetryPart | undefined
    for (;;) {
      const control = this.beginAttempt(slot, part)
      let result: T
      try {
        result = await runAttempt(control.view)
      } catch (error) {
        slot.state = 'dead'
        slot.failure = error
        slot.attempt = null
        control.resolveDone()
        this.closeIfIdle()
        throw error
      }
      slot.attempt = null
      if (control.interruption === 'retry' && !this.closed) {
        // Started again before `done` resolves, so the person who asked for the
        // restart is answered only once the new attempt is running.
        part = control.retryPart
        this.options.onRestart?.(memberId, {
          attempt: slot.attempts + 1,
          part,
          previousOutcome: 'pending',
        })
        control.resolveDone()
        continue
      }
      slot.state = 'settled'
      slot.outcome = this.options.outcomeOf(result)
      this.options.onSettled?.(memberId, result)
      control.resolveDone()
      const decision = await this.waitForRetryOrClose(slot)
      if (decision.kind === 'close') return result
      part = decision.part
      this.options.onRestart?.(memberId, {
        attempt: slot.attempts + 1,
        part,
        previousOutcome: slot.outcome,
      })
    }
  }

  /**
   * Throws what `stop` or `retry` would refuse with, without doing either.
   *
   * Lets a caller tidy up first (refuse the member's open questions) only when
   * the action itself is going to happen. State can still move before the
   * action runs; the action checks again.
   */
  check(memberId: string, action: CouncilMemberInterruption): void {
    const slot = this.requireLiveSlot(memberId)
    if (action === 'retry' && slot.state === 'settled') {
      if (!slot.resume) {
        throw new CouncilMemberControlError('MEMBER_BUSY', 'That model is already being stopped or restarted.')
      }
      return
    }
    if (slot.state === 'settled') {
      throw new CouncilMemberControlError('MEMBER_FINISHED', 'That model already finished its turn in this step.')
    }
    this.requireInterruptibleAttempt(slot)
  }

  /** Whether the member is mid-attempt, so a session of its own may be open. */
  isWorking(memberId: string): boolean {
    return this.slots.get(memberId)?.attempt != null
  }

  /** Stops a working member and resolves with how its turn ended. */
  async stop(memberId: string): Promise<MemberOutcome> {
    this.check(memberId, 'stop')
    const slot = this.slots.get(memberId)!
    const control = this.requireInterruptibleAttempt(slot)
    this.interrupt(control, 'stop')
    await control.done
    this.throwIfDied(slot)
    return slot.outcome ?? 'stopped'
  }

  /**
   * Starts a member over with a fresh attempt.
   *
   * A working member is interrupted first, and this resolves once its session
   * is confirmed stopped and the new attempt is running. A settled member starts
   * again straight away.
   */
  async retry(memberId: string, part?: CouncilMemberRetryPart): Promise<void> {
    const slot = this.requireLiveSlot(memberId)
    if (slot.state === 'settled') {
      const resume = slot.resume
      if (!resume) {
        throw new CouncilMemberControlError('MEMBER_BUSY', 'That model is already being stopped or restarted.')
      }
      // Marked running before the run loop wakes, so a member settling in the
      // meantime cannot close the round under this restart.
      slot.resume = null
      slot.state = 'running'
      resume({ kind: 'retry', part })
      return
    }
    const control = this.requireInterruptibleAttempt(slot)
    this.interrupt(control, 'retry', part)
    await control.done
    this.throwIfDied(slot)
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

  private beginAttempt(slot: MemberSlot, part: CouncilMemberRetryPart | undefined): AttemptControl {
    slot.attempts += 1
    slot.state = 'running'
    slot.outcome = null
    const controller = new AbortController()
    let reject: (error: Error) => void = () => {}
    const interrupted = new Promise<never>((_resolve, rejectInterrupted) => {
      reject = rejectInterrupted
    })
    // Handled here so an attempt that finished without racing it does not
    // surface as an unhandled rejection when it is interrupted later.
    interrupted.catch(() => {})
    let resolveDone: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const control: AttemptControl = {
      view: undefined as unknown as CouncilMemberAttempt,
      controller,
      interruption: null,
      retryPart: undefined,
      reject,
      done,
      resolveDone,
    }
    control.view = {
      number: slot.attempts,
      signal: controller.signal,
      interrupted,
      interruption: () => control.interruption,
      retryPart: part,
    }
    slot.attempt = control
    return control
  }

  private interrupt(
    control: AttemptControl,
    reason: CouncilMemberInterruption,
    part?: CouncilMemberRetryPart,
  ): void {
    control.interruption = reason
    control.retryPart = part
    // A plain abort, so code below that tells an abort apart by its
    // `AbortError` name keeps doing so.
    control.controller.abort()
    control.reject(new CouncilMemberInterruptedError(reason))
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
    if (this.closed || slot.state === 'dead') {
      throw new CouncilMemberControlError('STEP_NOT_RUNNING', 'This step is no longer running.')
    }
    return slot
  }

  private requireInterruptibleAttempt(slot: MemberSlot): AttemptControl {
    const control = slot.attempt
    if (!control || control.interruption) {
      throw new CouncilMemberControlError('MEMBER_BUSY', 'That model is already being stopped or restarted.')
    }
    return control
  }

  private throwIfDied(slot: MemberSlot): void {
    if (slot.state !== 'dead') return
    if (slot.failure instanceof CancelledError) {
      throw new CouncilMemberControlError('STEP_NOT_RUNNING', 'The ticket was canceled.', { cause: slot.failure })
    }
    throw new CouncilMemberControlError(
      'STOP_UNCONFIRMED',
      `OpenCode did not confirm that the model stopped, so the step will stop with an error: ${getErrorMessage(slot.failure)}`,
      { cause: slot.failure },
    )
  }
}

export function openCouncilRound<T>(options: CouncilRoundOptions<T>): CouncilRound<T> {
  return new CouncilRound(options)
}

// ── Registry ─────────────────────────────────────────────────────────────────

/** What the routes may do with a live round, whatever its members return. */
interface CouncilRoundHandle {
  readonly isClosed: boolean
  check(memberId: string, action: CouncilMemberInterruption): void
  isWorking(memberId: string): boolean
  stop(memberId: string): Promise<MemberOutcome>
  retry(memberId: string, part?: CouncilMemberRetryPart): Promise<void>
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

export function hasLiveCouncilRound(ticketId: string, phase: WorkflowPhaseId): boolean {
  return rounds.has(roundKey(ticketId, phase))
}

/**
 * Throws what a stop or retry of this member would refuse with right now, and
 * says whether the member is mid-attempt (so it may have open questions).
 */
export function checkCouncilMemberControl(
  ticketId: string,
  phase: WorkflowPhaseId,
  memberId: string,
  action: CouncilMemberInterruption,
): { working: boolean } {
  const round = requireRound(ticketId, phase)
  round.check(memberId, action)
  return { working: round.isWorking(memberId) }
}

export async function stopCouncilMember(ticketId: string, phase: WorkflowPhaseId, memberId: string): Promise<MemberOutcome> {
  return requireRound(ticketId, phase).stop(memberId)
}

export async function retryCouncilMember(
  ticketId: string,
  phase: WorkflowPhaseId,
  memberId: string,
  part?: CouncilMemberRetryPart,
): Promise<void> {
  return requireRound(ticketId, phase).retry(memberId, part)
}

/** Test seam. Never called from production paths. */
export function resetCouncilRounds(): void {
  for (const round of [...rounds.values()]) round.close()
  rounds.clear()
}
