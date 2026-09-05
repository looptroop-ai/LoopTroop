import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTag, openTag, PROTOCOL_TAGS, type ProtocolTag } from '@shared/protocolTags'
import { collectTaggedCandidates } from '../yamlUtils'
import { FINAL_TEST_COMMANDS_END, FINAL_TEST_COMMANDS_MARKER } from '../../phases/finalTest/parser'
import { BEAD_STATUS_END, BEAD_STATUS_MARKER, buildCompletionInstructions } from '../../phases/execution/completionSchema'
import { EXECUTION_SETUP_RESULT_END, EXECUTION_SETUP_RESULT_MARKER } from '../../phases/executionSetup/types'
import { EXECUTION_SETUP_PLAN_RESULT_END, EXECUTION_SETUP_PLAN_RESULT_MARKER } from '../../phases/executionSetupPlan/types'
import { MANUAL_QA_CHECKLIST_TAG } from '../../phases/manualQa/parser'
import { MANUAL_QA_FIX_BEADS_TAG } from '../../phases/manualQa/fixBeads'

/**
 * Every value here is wire protocol: the string the model is told to emit and
 * the string a parser looks for. `PROTOCOL_TAGS` exists so a rename is one edit
 * rather than fifty, and this file is what stops that convenience from turning
 * into a silent rename — a parser looking for a tag the prompt never taught
 * finds nothing and reports a malformed response, which looks exactly like a
 * model having a bad day.
 *
 * The literals below are written out on purpose. Asserting a constant against
 * itself proves nothing.
 */
const FROZEN_TAGS: Record<keyof typeof PROTOCOL_TAGS, string> = {
  INTERVIEW_BATCH: 'INTERVIEW_BATCH',
  INTERVIEW_COMPLETE: 'INTERVIEW_COMPLETE',
  RELEVANT_FILES_RESULT: 'RELEVANT_FILES_RESULT',
  EXECUTION_SETUP_PLAN: 'EXECUTION_SETUP_PLAN',
  EXECUTION_SETUP_RESULT: 'EXECUTION_SETUP_RESULT',
  BEAD_STATUS: 'BEAD_STATUS',
  FINAL_TEST_COMMANDS: 'FINAL_TEST_COMMANDS',
  MANUAL_QA_CHECKLIST: 'MANUAL_QA_CHECKLIST',
  MANUAL_QA_FIX_BEADS: 'MANUAL_QA_FIX_BEADS',
}

const ALL_TAGS = Object.values(PROTOCOL_TAGS)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('protocol tag names', () => {
  it('are byte-for-byte what they have always been', () => {
    expect(PROTOCOL_TAGS).toEqual(FROZEN_TAGS)
  })

  it('derive the bracket forms the phases publish', () => {
    expect([FINAL_TEST_COMMANDS_MARKER, FINAL_TEST_COMMANDS_END])
      .toEqual(['<FINAL_TEST_COMMANDS>', '</FINAL_TEST_COMMANDS>'])
    expect([BEAD_STATUS_MARKER, BEAD_STATUS_END])
      .toEqual(['<BEAD_STATUS>', '</BEAD_STATUS>'])
    expect([EXECUTION_SETUP_RESULT_MARKER, EXECUTION_SETUP_RESULT_END])
      .toEqual(['<EXECUTION_SETUP_RESULT>', '</EXECUTION_SETUP_RESULT>'])
    expect([EXECUTION_SETUP_PLAN_RESULT_MARKER, EXECUTION_SETUP_PLAN_RESULT_END])
      .toEqual(['<EXECUTION_SETUP_PLAN>', '</EXECUTION_SETUP_PLAN>'])
    expect(MANUAL_QA_CHECKLIST_TAG).toBe('MANUAL_QA_CHECKLIST')
    expect(MANUAL_QA_FIX_BEADS_TAG).toBe('MANUAL_QA_FIX_BEADS')
  })

  /**
   * The bracket form and the bare name are kept as two derivations of one value
   * rather than two constants, so this is what proves the derivation: what
   * `openTag`/`closeTag` write is what `collectTaggedCandidates` reads.
   */
  it.each(ALL_TAGS)('round-trips a payload wrapped in %s', (tag: ProtocolTag) => {
    const payload = `payload-for-${tag}`
    const wrapped = `noise before\n${openTag(tag)}${payload}${closeTag(tag)}\nnoise after`

    expect(collectTaggedCandidates(wrapped, tag)).toEqual([payload])
  })

  it.each(ALL_TAGS)('does not match a different tag than %s', (tag: ProtocolTag) => {
    const others = ALL_TAGS.filter((other) => other !== tag)
    const wrapped = `${openTag(tag)}payload${closeTag(tag)}`

    for (const other of others) {
      expect(collectTaggedCandidates(wrapped, other)).toEqual([])
    }
  })

  /**
   * The example inside the bead completion instructions is built from the marker
   * pair, so this is what proves the two halves still bracket one payload rather
   * than being tested against themselves.
   */
  it('wraps the bead completion example in the marker pair', () => {
    const instructions = buildCompletionInstructions()
    expect(instructions).toContain(`${BEAD_STATUS_MARKER}{"bead_id"`)
    expect(instructions).toContain(`}${BEAD_STATUS_END}`)
  })

  /**
   * The prompt copy is prose the user can edit, so it keeps its literals rather
   * than interpolating the constant into forty sentences. This is the drift gate
   * that makes that safe: a rename that misses the text teaching the tag fails
   * here instead of shipping a phase whose parser looks for something the model
   * was never asked to produce.
   *
   * Asserted against the *source* of those files, not against a rendered
   * template. A rendered one is not evidence: `PROM_CODING` embeds
   * `buildCompletionInstructions()`, which derives its tag from this very
   * constant, so a rendered-text assertion passed happily while the prose around
   * it still said the old name. That is what a mutation probe is for.
   */
  it.each([
    [PROTOCOL_TAGS.INTERVIEW_BATCH, ['server/prompts/index.ts', 'server/phases/interview/qa.ts']],
    [PROTOCOL_TAGS.INTERVIEW_COMPLETE, ['server/prompts/index.ts', 'server/phases/interview/qa.ts']],
    [PROTOCOL_TAGS.RELEVANT_FILES_RESULT, ['server/prompts/index.ts']],
    [PROTOCOL_TAGS.EXECUTION_SETUP_PLAN, ['server/prompts/index.ts', 'server/phases/executionSetupPlan/generator.ts']],
    [PROTOCOL_TAGS.EXECUTION_SETUP_RESULT, ['server/prompts/index.ts', 'server/phases/executionSetup/generator.ts']],
    [PROTOCOL_TAGS.BEAD_STATUS, ['server/prompts/index.ts', 'server/phases/execution/executor.ts', 'shared/workflowMeta.ts']],
    [PROTOCOL_TAGS.FINAL_TEST_COMMANDS, ['server/prompts/index.ts', 'server/phases/finalTest/generator.ts', 'server/workflow/phases/verificationPhase.ts']],
    [PROTOCOL_TAGS.MANUAL_QA_FIX_BEADS, ['server/prompts/index.ts']],
  ])('is still spelled out in every file whose prose teaches %s', (tag: ProtocolTag, files: string[]) => {
    for (const file of files) {
      expect(readFileSync(resolve(repoRoot, file), 'utf8')).toContain(openTag(tag))
    }
  })

  /**
   * The one tag with no prose to guard: its prompt line is built from the
   * constant, which is what the others would look like if the copy were
   * interpolated everywhere. Proven in `manualQa/__tests__/generator.test.ts`,
   * which renders the real prompt.
   */
  it('has no prose copy left to drift for MANUAL_QA_CHECKLIST', () => {
    const prompts = readFileSync(resolve(repoRoot, 'server/prompts/index.ts'), 'utf8')
    expect(prompts).not.toContain(openTag(PROTOCOL_TAGS.MANUAL_QA_CHECKLIST))
  })

  /**
   * The client reads this protocol too, which is why the constant lives in
   * `shared/` rather than under `server/`.
   *
   * `ArtifactContentViewer` unwraps the execution-setup plan envelope before
   * showing it, and had the tag written out. A rename would have moved every
   * server parser and left the viewer matching the old envelope — and its
   * fallback is to show the text unchanged, so the user would have seen a raw
   * `<TAG>` wrapper with no error anywhere. The sweep is the general form: no
   * shipped client file may spell a tag out.
   *
   * Test files are deliberately excluded. Their fixtures are literals on
   * purpose — a fixture built from the constant would wrap whatever the constant
   * currently says and prove nothing about the value.
   */
  it('never spells a tag out in shipped client source', () => {
    const clientFiles = readdirSync(resolve(repoRoot, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((entry) => /\.tsx?$/.test(entry))
      .filter((entry) => !/(^|[\\/])__tests__[\\/]|\.test\.tsx?$|^test[\\/]/.test(entry))

    // A sweep over an empty list passes for the wrong reason.
    expect(clientFiles.length).toBeGreaterThan(100)

    for (const entry of clientFiles) {
      const source = readFileSync(join(repoRoot, 'src', entry), 'utf8')
      for (const tag of ALL_TAGS) {
        expect(`${entry}: ${source.includes(openTag(tag))}`).toBe(`${entry}: false`)
      }
    }
  })

  /** The sweep above passes just as well if the viewer stops unwrapping at all. */
  it('derives the client envelope from the constant', () => {
    const viewer = readFileSync(resolve(repoRoot, 'src/components/workspace/ArtifactContentViewer.tsx'), 'utf8')
    expect(viewer).toContain('openTag(PROTOCOL_TAGS.EXECUTION_SETUP_PLAN)')
    expect(viewer).toContain('closeTag(PROTOCOL_TAGS.EXECUTION_SETUP_PLAN)')
  })
})
