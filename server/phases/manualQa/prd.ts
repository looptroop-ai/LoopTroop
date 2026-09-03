import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { parseYamlOrJsonCandidate } from '../../structuredOutput/yamlUtils'

/**
 * The Manual QA view of `prd.yaml`.
 *
 * Manual QA read the approved PRD three ways: the generator validated a local
 * schema and then cast the result to `PrdDocument`, which it does not satisfy;
 * operations reparsed the same file into a second inline shape; and coverage
 * took a `Pick<PrdDocument, 'epics'>` it could only ever be handed by that cast.
 *
 * This is the minimal canonical shape the feature actually needs. `PrdDocument`
 * is structurally assignable to it, so a full PRD still fits, and nothing has to
 * be widened back with a cast.
 */
const manualQaPrdSchema = z.object({
  epics: z.array(z.object({
    id: z.string().trim().min(1),
    title: z.string().optional(),
    user_stories: z.array(z.object({
      id: z.string().trim().min(1),
      title: z.string().optional(),
      acceptance_criteria: z.array(z.string()),
    }).passthrough()),
  }).passthrough()),
}).passthrough()

export interface ManualQaPrdStory {
  id: string
  title?: string
  acceptance_criteria: string[]
}

export interface ManualQaPrdEpic {
  id: string
  title?: string
  user_stories: ManualQaPrdStory[]
}

/**
 * Declared rather than inferred: `z.infer` of a passthrough schema carries an
 * index signature, and `PrdDocument` has none, so a real PRD would not be
 * assignable to the shape Manual QA reads.
 */
export interface ManualQaPrd {
  epics: ManualQaPrdEpic[]
}

export function manualQaPrdPath(ticketDir: string): string {
  return resolve(ticketDir, 'prd.yaml')
}

/**
 * Reads the approved PRD, or throws when it is missing or does not fit the shape.
 *
 * `raw` is the file's own text, for the callers that put the PRD in front of a
 * model: they want the document the user approved, not a re-serialisation of the
 * subset this schema keeps. Reading it through here is what makes a malformed
 * PRD fail the same way for all of them.
 */
export function readManualQaPrd(
  ticketDir: string,
  purpose = 'Manual QA checklist generation',
): ManualQaPrd & { raw: string } {
  const path = manualQaPrdPath(ticketDir)
  if (!existsSync(path)) throw new Error(`Approved PRD is required before ${purpose}.`)
  const raw = readFileSync(path, 'utf8')
  return { ...manualQaPrdSchema.parse(parseYamlOrJsonCandidate(raw)), raw }
}

/**
 * The same read for callers that decorate their output with PRD text and can do
 * without it: a missing or malformed PRD costs them a label, not the operation.
 */
export function tryReadManualQaPrd(ticketDir: string): ManualQaPrd | null {
  try {
    return readManualQaPrd(ticketDir)
  } catch {
    return null
  }
}
