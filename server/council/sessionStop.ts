import type { OpenCodeAdapter } from '../opencode/adapter'
import { SessionManager } from '../opencode/sessionManager'
import { SDK_OPERATION_TIMEOUT_MS } from '../lib/constants'

const COUNCIL_STOP_ATTEMPTS = 2

export type CouncilSessionWaitOutcome = 'session_ready' | 'execution_settled' | 'timed_out'

/**
 * Give a late session-create callback a bounded chance to publish its id.
 *
 * A prompt request may ignore its abort signal forever, but cleanup cannot
 * wait forever for that request to settle before sending the remote stop. If
 * creation has not published an id within the normal SDK operation window,
 * the caller must preserve the unresolved ownership rather than claiming that
 * cleanup succeeded.
 */
export async function waitForCouncilSession(
  sessionReady: Promise<void>,
  executionSettled: Promise<void>,
  timeoutMs: number = SDK_OPERATION_TIMEOUT_MS,
): Promise<CouncilSessionWaitOutcome> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      sessionReady.then(() => 'session_ready' as const),
      executionSettled.then(() => 'execution_settled' as const),
      new Promise<CouncilSessionWaitOutcome>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timed_out'), timeoutMs)
        timeoutHandle.unref?.()
      }),
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

/**
 * Stops the session of a council member whose turn was cut short, wherever that
 * session got to.
 *
 * The turn may have a session mid-prompt, or one still being created: its id
 * then arrives through the create callback, or is found through its ownership
 * row. A prompt that already returned has nothing left running. Resolves with
 * whether the stop is confirmed and the id it settled on, if any.
 */
export async function stopCutShortCouncilSession(input: {
  adapter: OpenCodeAdapter
  sessionManager: SessionManager | null
  role: 'drafter' | 'voter'
  promptReturned: boolean
  /** The turn's own record of its session, falling back to the ownership row. */
  findSessionId: () => string | undefined
  sessionReady: Promise<void>
  executionSettled: Promise<void>
  /** Whether a create for this turn may still be in flight with no row yet. */
  hasUnresolvedOwnership: () => boolean
}): Promise<{ stopped: boolean; sessionId: string | undefined }> {
  if (input.promptReturned) return { stopped: true, sessionId: input.findSessionId() }
  let sessionId = input.findSessionId()
  if (!sessionId) {
    // A prompt can ignore its local abort signal. Give its session-create
    // callback a bounded chance to publish the id, but never wait for the
    // prompt itself before attempting the remote stop.
    const waitOutcome = await waitForCouncilSession(input.sessionReady, input.executionSettled)
    sessionId = input.findSessionId()
    if (!sessionId) {
      if (waitOutcome !== 'execution_settled') return { stopped: false, sessionId }
      return { stopped: !input.hasUnresolvedOwnership(), sessionId }
    }
  }
  return {
    stopped: await confirmCouncilSessionStopped(input.adapter, input.sessionManager, sessionId, input.role),
    sessionId,
  }
}

/**
 * Confirm a council session is stopped without waiting for its prompt promise.
 *
 * OpenCode may leave a prompt request pending after its local AbortSignal fires.
 * The remote session still has to be stopped, and the caller may not wait for
 * that request to settle before sending the stop.
 */
export async function confirmCouncilSessionStopped(
  adapter: OpenCodeAdapter,
  sessionManager: SessionManager | null,
  sessionId: string,
  role: 'drafter' | 'voter',
): Promise<boolean> {
  for (let attempt = 0; attempt < COUNCIL_STOP_ATTEMPTS; attempt += 1) {
    try {
      const stopped = sessionManager
        ? await sessionManager.abortAndAbandonSession(sessionId)
        : await adapter.abortSession(sessionId)
      if (stopped) return true
    } catch (error) {
      console.warn(`[council/${role}] Failed to abort OpenCode session ${sessionId}:`, error)
    }
  }
  return false
}
