import { useEffect } from 'react'

/** One of the ticket UI-state scopes that records an acknowledged attention signal. */
export type AttentionScope = 'error_attention' | 'needs_input_attention'

interface SaveAttentionInput {
  ticketId: string
  scope: AttentionScope
  data: { seenSignature: string | null }
}

interface UseAttentionAckOptions {
  /** The ticket being viewed, or undefined while it loads. */
  ticketId: string | undefined
  /** The signal as it stands now: a signature when there is something to acknowledge, else null. */
  signature: string | null
  /** What the server last recorded as acknowledged for this scope. */
  seenSignature: string | null | undefined
  /**
   * Moves whenever the ticket is re-read, so a save that failed is tried again.
   *
   * Both effects used to depend on the whole `ticket` object, which had this
   * property by accident: a poll returning a new identity re-ran them. Depending
   * on the primitives instead is precise, but it costs that retry unless
   * something passed here moves on every read — and a PUT that never landed is
   * invisible, because the local acknowledgment has already stopped the flash
   * on this tab. It would simply be permanent everywhere else.
   *
   * So pass the query's `dataUpdatedAt`, not the ticket's own `updatedAt`: that
   * one moves when the *record* changes, which an unchanged poll does not do.
   */
  retryKey: string | number | undefined
  scope: AttentionScope
  /** Records the acknowledgment locally, so the card stops flashing before the save lands. */
  mark: (ticketId: string, signature: string | null) => void
  /** Forgets the local acknowledgment once the signal is gone. */
  clear: (ticketId: string) => void
  saveUiState: (input: SaveAttentionInput) => void
}

/**
 * Acknowledges an attention signal on the ticket the user is looking at, and
 * persists that acknowledgment so the flashing stays stopped across reloads and
 * other tabs.
 *
 * Written twice with the scope as the only difference — the second copy's
 * comment said as much — so a fix to one was a fix to one. The save is
 * conditional on both sides: re-writing an acknowledgment the server already
 * holds would be a request per render for a value that did not change.
 */
export function useAttentionAck({
  ticketId,
  signature,
  seenSignature,
  retryKey,
  scope,
  mark,
  clear,
  saveUiState,
}: UseAttentionAckOptions): void {
  useEffect(() => {
    if (!ticketId) return

    if (signature) {
      mark(ticketId, signature)
      if (seenSignature !== signature) {
        saveUiState({ ticketId, scope, data: { seenSignature: signature } })
      }
      return
    }

    clear(ticketId)
    // Only when the server is actually holding a signature. `null` is already
    // "nothing acknowledged" and `undefined` is a ticket payload that did not
    // carry the field at all — writing `null` for either records nothing, and
    // since neither value can change in response to the write, `retryKey` would
    // reissue that same request on every poll for as long as the pane is open.
    if (typeof seenSignature === 'string') {
      saveUiState({ ticketId, scope, data: { seenSignature: null } })
    }
  }, [clear, mark, retryKey, saveUiState, scope, seenSignature, signature, ticketId])
}
