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
   * on the primitives instead is what makes the guard below work — but it also
   * means a PUT that never landed is never retried, because none of the values
   * it compares has changed. The local acknowledgment still stops the flash on
   * this tab, so the failure is invisible here and permanent everywhere else.
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
    // `!== null` rather than a truthiness check, and deliberately: `undefined`
    // means the server has never been told, which still needs the write.
    if (seenSignature !== null) {
      saveUiState({ ticketId, scope, data: { seenSignature: null } })
    }
  }, [clear, mark, retryKey, saveUiState, scope, seenSignature, signature, ticketId])
}
