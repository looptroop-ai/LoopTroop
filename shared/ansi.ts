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
const C1_ST = String.fromCodePoint(156)

/**
 * An OSC sequence, ending at the *first* terminator rather than the last.
 *
 * Three things terminate one: BEL, the two-character `ESC \` string
 * terminator, and the 8-bit C1 string terminator. The body therefore has to
 * exclude all three and be lazy, or a greedy `[^BEL]*` runs straight past an
 * `ESC \` to a BEL later in the text and deletes everything in between —
 * `ESC]0;first ESC\ VISIBLE ESC]0;second BEL tail` returned `tail`, silently
 * eating a real line of build output on its way.
 */
const ANSI_OSC_SEQUENCE = new RegExp(
  `(?:${ESCAPE}\\]|${C1_OSC})(?:(?!${BELL}|${C1_ST}|${ESCAPE}\\\\)[\\s\\S])*?(?:${BELL}|${C1_ST}|${ESCAPE}\\\\)`,
  'g',
)
const ANSI_CSI_SEQUENCE = new RegExp(`(?:${ESCAPE}\\[|${C1_CSI})[0-?]*[ -/]*[@-~]`, 'g')
const ANSI_SINGLE_SEQUENCE = new RegExp(`${ESCAPE}[@-_]`, 'g')

/**
 * A C1 introducer left behind by an unterminated sequence.
 *
 * The 7-bit forms get this for free: an unterminated `ESC ]` is not an OSC
 * match, and the two-character escape rule then removes the `ESC ]` and leaves
 * the payload readable. Nothing did the same for `U+009B` / `U+009D`, so an
 * unterminated 8-bit sequence kept its control character all the way into a
 * bead note. Removing the introducer and keeping the text is the same trade
 * the 7-bit path already makes.
 */
const C1_INTRODUCER = new RegExp(`[${C1_CSI}${C1_OSC}]`, 'g')

/** Removes OSC, CSI (7-bit and C1) and single-character ESC sequences. */
export function stripAnsiSequences(text: string): string {
  return text
    .replace(ANSI_OSC_SEQUENCE, '')
    .replace(ANSI_CSI_SEQUENCE, '')
    .replace(ANSI_SINGLE_SEQUENCE, '')
    .replace(C1_INTRODUCER, '')
}
