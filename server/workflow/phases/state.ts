import { getOpenCodeAdapter } from '../../opencode/factory'
import type { OpenCodeAdapter } from '../../opencode/adapter'
import type { PhaseIntermediateData } from './types'
import { clearTicketWorkBudget } from '../workBudget'
import { forgetTicketQuestionMemory } from '../questionWindows'
import { clearTicketSessionContinuations } from '../../opencode/sessionContinuation'
import { releaseInterviewBatch } from './interviewPhase'
import { readTicketFile, removeTicketFile, writeTicketFile } from '../../storage/tickets'

export const runningPhases = new Set<string>()
const cancellationPendingTickets = new Set<string>()
let cancellationGenerationSequence = 0
const cancellationGenerations = new Map<string, number>()
const CANCELLATION_PENDING_ARTIFACT = 'runtime/cancellation-pending.json'

/**
 * The OpenCode adapter, resolved on first use rather than at import.
 *
 * This module is reachable from the route graph, so a plain
 * `const adapter = getOpenCodeAdapter()` ran while `server/app.ts` was still
 * being imported — before the daemon had resolved `config.json` and handed the
 * base URL to the OpenCode layer. Every phase then talked to whatever the
 * environment alone said, and `resetOpenCodeAdapter()` could not help: the old
 * instance was already captured in this binding.
 *
 * A proxy rather than a `getAdapter()` function so the 50-odd call sites that
 * treat this as a value — including the ones that pass it to a SessionManager —
 * keep working unchanged. Methods are bound to the real instance so `this`
 * inside the adapter is the adapter and not this proxy.
 */
export const adapter: OpenCodeAdapter = new Proxy({} as OpenCodeAdapter, {
  get: (_target, property) => {
    const instance = getOpenCodeAdapter()
    const value = Reflect.get(instance, property) as unknown
    return typeof value === 'function' ? value.bind(instance) : value
  },
  has: (_target, property) => Reflect.has(getOpenCodeAdapter(), property),
})

export const ticketAbortControllers = new Map<string, AbortController>()
export const interviewQASessions = new Map<string, { sessionId: string; winnerId: string }>()
export const SKIP_ALL_INTERVIEW_COVERAGE_RESPONSE = 'Coverage skipped by user shortcut after marking remaining questions skipped.'
export const phaseIntermediate = new Map<string, PhaseIntermediateData>()

/**
 * Remove in-memory workflow state for a ticket without aborting any active work.
 * Call this when a ticket reaches a terminal state naturally.
 */
export function cleanupTicketState(
  ticketId: string,
  options: { preserveRemoteState?: boolean } = {},
) {
  ticketAbortControllers.delete(ticketId)

  // Clean up runningPhases entries for this ticket
  for (const key of runningPhases) {
    if (key.startsWith(`${ticketId}:`)) {
      runningPhases.delete(key)
    }
  }

  // Clean up phaseIntermediate entries for this ticket
  for (const key of phaseIntermediate.keys()) {
    if (key.startsWith(`${ticketId}:`)) {
      phaseIntermediate.delete(key)
    }
  }

  // Clean up interview QA session
  interviewQASessions.delete(ticketId)

  if (!options.preserveRemoteState) {
    clearTicketCancellationPending(ticketId)
  }

  // Every cancel, completion and restart passes through here. The ledger used
  // to be dropped from the cancel route alone, so a restart — which cancels and
  // then continues the *same* ticket id — carried a leftover depth or
  // suspension into the next run and held its clocks still.
  if (!options.preserveRemoteState) {
    clearTicketWorkBudget(ticketId)
  }

  if (!options.preserveRemoteState) {
    // Per-ticket question bookkeeping outlives the timers themselves, and a
    // ticket that completed without an open question never reached the window
    // teardown that used to be its only clear.
    forgetTicketQuestionMemory(ticketId)

    // Same reasoning, same ticket id. Continuations were cleared only by
    // `abortTicketSessions`, so a ticket that finished naturally — or was
    // cancelled through a path that had no sessions left to abort — kept them
    // for their full thirty-minute life, and a restart of the same ticket
    // reapplied the finished run's retry attempts.
    clearTicketSessionContinuations(ticketId)
  }

  if (!options.preserveRemoteState) {
    // Untokened on purpose: a ticket that has reached a terminal state has no
    // legitimate batch in flight, so whatever claim is on it belongs to a run
    // that is over. This is the one caller allowed to take a claim it does not
    // hold, and it is why the claim's expiry is a backstop rather than the
    // primary recovery path.
    releaseInterviewBatch(ticketId)
  }
}

/** Keep a failed cancel from allowing a local phase to start again. */
export function markTicketCancellationPending(ticketId: string): void {
  cancellationPendingTickets.add(ticketId)
  cancellationGenerations.set(ticketId, ++cancellationGenerationSequence)
  try {
    writeTicketFile(ticketId, CANCELLATION_PENDING_ARTIFACT, `${JSON.stringify({
      state: 'pending',
      requestedAt: new Date().toISOString(),
    })}\n`)
  } catch (error) {
    // Keep the process-local guard even if the ticket workspace is temporarily
    // unavailable. A restart cannot recover this guard without the marker, so
    // durable session rows remain the only restart evidence; never infer
    // ownership from an arbitrary project file.
    console.warn(`[workflow] Could not persist cancellation pending marker for ticket ${ticketId}:`, error)
  }
}

/**
 * Identifies the cancellation pass currently allowed to mutate a ticket.
 * Clearing and re-marking a ticket advances the identity, so an older async
 * cleanup cannot regain ownership merely because a later cancel is pending.
 */
export function getTicketCancellationGeneration(ticketId: string): number {
  return cancellationGenerations.get(ticketId) ?? 0
}

export function isTicketCancellationPending(ticketId: string): boolean {
  if (cancellationPendingTickets.has(ticketId)) return true
  try {
    const raw = readTicketFile(ticketId, CANCELLATION_PENDING_ARTIFACT)
    if (raw === null) return false
    const parsed: unknown = JSON.parse(raw)
    const pending = typeof parsed === 'object'
      && parsed !== null
      && (parsed as Record<string, unknown>).state === 'pending'
    if (!pending) throw new Error('cancellation pending marker has an invalid state')
    return true
  } catch (error) {
    // A malformed or unreadable marker is uncertainty about an outstanding
    // cancellation, not evidence that it is safe to start work again.
    console.warn(`[workflow] Could not read cancellation pending marker for ticket ${ticketId}:`, error)
    return true
  }
}

export function clearTicketCancellationPending(ticketId: string): boolean {
  try {
    if (!removeTicketFile(ticketId, CANCELLATION_PENDING_ARTIFACT)) return false
  } catch (error) {
    console.warn(`[workflow] Could not clear cancellation pending marker for ticket ${ticketId}:`, error)
    return false
  }
  cancellationPendingTickets.delete(ticketId)
  cancellationGenerations.delete(ticketId)
  return true
}

/**
 * Cancel all running phases for a ticket by aborting its AbortController.
 * Cleans up in-memory phase state for the ticket.
 */
export function cancelTicket(ticketId: string) {
  const controller = ticketAbortControllers.get(ticketId)
  if (controller) {
    controller.abort()
  }

  // The controller is local, but the session can still be editing remotely.
  // Keep question/continuation bookkeeping until the caller has confirmed the
  // remote stop; otherwise a reset or replacement can race the old session.
  cleanupTicketState(ticketId, { preserveRemoteState: true })
}

export function abortTicketWork(ticketId: string) {
  const controller = ticketAbortControllers.get(ticketId)
  if (controller) {
    controller.abort()
    ticketAbortControllers.delete(ticketId)
  }
}

export function getOrCreateAbortSignal(ticketId: string): AbortSignal {
  let controller = ticketAbortControllers.get(ticketId)
  if (!controller) {
    controller = new AbortController()
    ticketAbortControllers.set(ticketId, controller)
  }
  return controller.signal
}
