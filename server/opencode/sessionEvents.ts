/**
 * A session died. Anything holding state keyed on it needs to know.
 *
 * An emitter rather than a direct call because the things that care live above
 * this layer: the AI question windows are workflow state, and having
 * `sessionManager` import them would invert the dependency and close a cycle
 * through storage. There are more than twenty places that abandon a session, so
 * one notification here is also the only version of this that stays correct as
 * a twenty-first is added.
 */

export interface OpenCodeSessionEndedEvent {
  sessionId: string
  /** The composite ticket ref, when the session was owned by one. */
  ticketId: string | undefined
  reason: 'abandoned' | 'aborted'
}

type Listener = (event: OpenCodeSessionEndedEvent) => void

const listeners = new Set<Listener>()

export function onOpenCodeSessionEnded(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitOpenCodeSessionEnded(event: OpenCodeSessionEndedEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      // Session teardown must finish even if a subscriber throws.
    }
  }
}
