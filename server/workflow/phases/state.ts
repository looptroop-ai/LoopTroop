import { getOpenCodeAdapter } from '../../opencode/factory'
import type { OpenCodeAdapter } from '../../opencode/adapter'
import type { PhaseIntermediateData } from './types'
import { clearTicketWorkBudget } from '../workBudget'
import { forgetTicketQuestionMemory } from '../questionWindows'

export const runningPhases = new Set<string>()

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
export function cleanupTicketState(ticketId: string) {
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

  // Every cancel, completion and restart passes through here. The ledger used
  // to be dropped from the cancel route alone, so a restart — which cancels and
  // then continues the *same* ticket id — carried a leftover depth or
  // suspension into the next run and held its clocks still.
  clearTicketWorkBudget(ticketId)

  // Per-ticket question bookkeeping outlives the timers themselves, and a
  // ticket that completed without an open question never reached the window
  // teardown that used to be its only clear.
  forgetTicketQuestionMemory(ticketId)
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

  cleanupTicketState(ticketId)
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
