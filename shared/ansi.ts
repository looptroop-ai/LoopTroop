/**
 * One implementation of ANSI escape-sequence removal, shared by the SPA, the
 * server phases and the error sanitiser.
 *
 * Terminal output reaches LoopTroop from three directions — OpenCode adapters,
 * shell commands and git — and each can emit the 8-bit C1 forms as well as the
 * familiar `ESC [` / `ESC ]` ones. Stripping only the 7-bit forms leaves stray
 * control characters in bead failure notes and finalisation excerpts, so every
 * caller uses the same superset: OSC (both introducers), CSI (both
 * introducers), and the two-character `ESC @`–`ESC _` escapes.
 */
const ESCAPE = String.fromCodePoint(27)
const BELL = String.fromCodePoint(7)
const C1_CSI = String.fromCodePoint(155)
const C1_OSC = String.fromCodePoint(157)

const ANSI_OSC_SEQUENCE = new RegExp(`(?:${ESCAPE}\\]|${C1_OSC})[^${BELL}]*(?:${BELL}|${ESCAPE}\\\\)`, 'g')
const ANSI_CSI_SEQUENCE = new RegExp(`(?:${ESCAPE}\\[|${C1_CSI})[0-?]*[ -/]*[@-~]`, 'g')
const ANSI_SINGLE_SEQUENCE = new RegExp(`${ESCAPE}[@-_]`, 'g')

/** Removes OSC, CSI (7-bit and C1) and single-character ESC sequences. */
export function stripAnsiSequences(text: string): string {
  return text
    .replace(ANSI_OSC_SEQUENCE, '')
    .replace(ANSI_CSI_SEQUENCE, '')
    .replace(ANSI_SINGLE_SEQUENCE, '')
}
