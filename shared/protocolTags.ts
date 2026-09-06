/**
 * The tag names both sides of the model exchange agree on.
 *
 * Every structured phase asks the model to wrap its answer in a named tag and
 * then parses that tag back out. The name was written as a literal in both
 * places and in several more besides — the parser's `collectTaggedCandidates`
 * call, the phase's marker constants, the echo-detection message, the mock
 * adapter, the verification counter — so a rename had to be made in every one
 * of them at once. Missing any single site produces no error at all: a parser
 * looking for a tag the model was never told to emit simply finds nothing and
 * reports a malformed response.
 *
 * The name is written once here. `openTag` and `closeTag` derive the bracket
 * forms, which are proven byte-for-byte against the historical literals in
 * `server/structuredOutput/__tests__/protocolTags.test.ts` — the values are wire
 * protocol and none of them may change.
 *
 * In `shared/` rather than under `server/` because the client reads the protocol
 * as well: `ArtifactContentViewer` unwraps the execution-setup plan envelope
 * before showing it. That was a literal, invisible to a rename, and its fallback
 * is to show the text unchanged — so a missed rename would have shown the user a
 * raw `<TAG>` wrapper with no error raised anywhere.
 *
 * **Not covered here on purpose**: the prompt copy that teaches each tag to the
 * model. Those are prose the user can edit through the Prompts editor, and
 * interpolating a constant into the middle of forty sentences would make them
 * harder to read for no gain the test does not already provide — the same test
 * asserts every tag's literal still appears in the text that teaches it, so a
 * rename that misses the prose fails there rather than in production.
 */

export const PROTOCOL_TAGS = {
  /** One interview turn's batch of questions. */
  INTERVIEW_BATCH: 'INTERVIEW_BATCH',
  /** The final interview artifact. */
  INTERVIEW_COMPLETE: 'INTERVIEW_COMPLETE',
  /** The file survey that seeds bead planning. */
  RELEVANT_FILES_RESULT: 'RELEVANT_FILES_RESULT',
  /** The plan execution setup will carry out. */
  EXECUTION_SETUP_PLAN: 'EXECUTION_SETUP_PLAN',
  /** What execution setup actually achieved. */
  EXECUTION_SETUP_RESULT: 'EXECUTION_SETUP_RESULT',
  /** One bead's completion marker. */
  BEAD_STATUS: 'BEAD_STATUS',
  /** The commands the final test phase should run. */
  FINAL_TEST_COMMANDS: 'FINAL_TEST_COMMANDS',
  /** A generated Manual QA checklist. */
  MANUAL_QA_CHECKLIST: 'MANUAL_QA_CHECKLIST',
  /** Beads generated to fix what Manual QA found. */
  MANUAL_QA_FIX_BEADS: 'MANUAL_QA_FIX_BEADS',
} as const

export type ProtocolTag = (typeof PROTOCOL_TAGS)[keyof typeof PROTOCOL_TAGS]

export function openTag(tag: ProtocolTag): string {
  return `<${tag}>`
}

export function closeTag(tag: ProtocolTag): string {
  return `</${tag}>`
}
