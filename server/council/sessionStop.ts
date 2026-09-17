import type { OpenCodeAdapter } from '../opencode/adapter'
import { SessionManager } from '../opencode/sessionManager'

const COUNCIL_STOP_ATTEMPTS = 2

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
