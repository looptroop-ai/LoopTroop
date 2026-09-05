import { isRecord } from '@shared/typeGuards'
import { readJsonlWithDiagnostics } from '../../io/jsonl'
import type { Bead, BeadStatus } from './types'
import { BEAD_STATUSES, isBeadStatus, resolveBeadStatusAlias } from './types'

/**
 * Reconciles a status read back from `beads.jsonl`.
 *
 * Guarding the parser only protects new output. A record written by an earlier
 * release can still hold a status the scheduler does not recognise, and the
 * scheduler stalls silently on one: it runs `pending` and finishes on `done`, so
 * anything else is a bead that never starts and a ticket that never completes.
 * Coercing to `pending` re-runs the bead at worst; leaving it stalls the ticket.
 */
export function reconcileStoredBeadStatus(
  value: unknown,
  beadId: string,
): { status: BeadStatus; warning?: string } {
  if (isBeadStatus(value)) return { status: value }

  const raw = typeof value === 'string' ? value.trim() : ''
  const folded = raw.toLowerCase()
  const mapped: BeadStatus | undefined = resolveBeadStatusAlias(folded)
    ?? (isBeadStatus(folded) ? folded : undefined)
  if (mapped) {
    return { status: mapped, warning: `Bead "${beadId}" had stored status "${raw}"; read as "${mapped}".` }
  }

  return {
    status: 'pending',
    warning: `Bead "${beadId}" had unrecognised stored status ${JSON.stringify(value)}; read as "pending" (expected one of ${BEAD_STATUSES.join(', ')}).`,
  }
}

/**
 * Reads a ticket's bead tracker. Every caller used to `readJsonl<Bead>(path)`,
 * which asserts the shape rather than checking it.
 */
export interface ReadBeadsFileOptions {
  /**
   * What a line that does not parse, or does not describe a bead, means.
   *
   * `skip` (the default) is for the diagnostic reads — prompt context, progress
   * counts — where losing one bead is better than losing the whole file.
   * `fail` is for the authoritative reads, where a silently dropped bead would
   * be reported as an absence: the Manual QA evidence manifest is the one that
   * matters, because a missing line there attaches partial evidence to a prompt
   * and tells nobody.
   */
  malformedEntries?: 'skip' | 'fail'
}

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

/**
 * Every listed key present and holding a list of strings.
 *
 * `dependencies` and `contextGuidance` are reached into without a guard —
 * `bead.dependencies.blocked_by.every(…)` in the scheduler,
 * `bead.contextGuidance.patterns.length` in the prompt builder — so a key that
 * is merely *allowed* is not enough. Accepting `{}` here let the exact
 * TypeError this check exists to prevent through.
 */
const isStringListRecord = (value: unknown, keys: readonly string[]): boolean =>
  isRecord(value) && keys.every((key) => isStringArray(value[key]))

/** Every element an object, which is what the readers of these lists assume. */
const isObjectArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => isRecord(item))

/**
 * A command list, in either shape the renderer accepts.
 *
 * `renderCommandSpec` takes a string or a spec object; it dereferences
 * anything else, so `[null]` reached the coding prompt and threw there.
 */
const isCommandArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' || isRecord(item))

/**
 * Manual QA provenance, as the evidence reader consumes it.
 *
 * `loadQaEvidenceFileParts` does `bead.qaOrigin.sourceItems.flatMap(…)` after
 * its own try block, so a row carrying a `qaOrigin` without `sourceItems`
 * threw a TypeError instead of the manifest's own error.
 */
const isQaOrigin = (value: unknown): boolean =>
  isRecord(value)
  && Array.isArray(value.sourceItems)
  // Down to the lists the loader itself walks: it does
  // `sourceItems.flatMap(item => item.evidence.flatMap(...))`, all of it after
  // the try that turns a bad manifest into a readable error, so an item without
  // `evidence` threw a TypeError from somewhere the operator cannot place.
  && value.sourceItems.every((item) => isRecord(item)
    && Array.isArray(item.evidence)
    && item.evidence.every((entry) => isRecord(entry)))

/**
 * The type each known bead field has to have if it is there at all.
 *
 * Checked rather than cast, which is the whole point of §9.7: readers reach
 * straight into `bead.dependencies.blocked_by`, `bead.contextGuidance.patterns`
 * and `bead.testCommands.length` with no guard, so a row whose field holds the
 * wrong kind of value crashed the scheduler far from the file that caused it.
 *
 * A field that is *absent* is deliberately still accepted. `beads.jsonl` holds
 * rows at more than one stage of their life — the runtime projection reads rows
 * carrying little more than an id, a status and an iteration — so requiring the
 * fully expanded shape here would reject files that work today. This checks
 * what is present; it does not demand what is not.
 *
 * Present, though, means fully formed. A field's *contents* are checked as far
 * as the readers dereference them: an empty `dependencies` object or a
 * `testCommands: [null]` used to pass here and throw somewhere else entirely,
 * which is the failure this table exists to move.
 */
const BEAD_FIELD_CHECKS: Record<string, (value: unknown) => boolean> = {
  title: (value) => typeof value === 'string',
  description: (value) => typeof value === 'string',
  issueType: (value) => typeof value === 'string',
  externalRef: (value) => typeof value === 'string',
  testCommandReason: (value) => typeof value === 'string',
  createdAt: (value) => typeof value === 'string',
  updatedAt: (value) => typeof value === 'string',
  completedAt: (value) => typeof value === 'string',
  startedAt: (value) => typeof value === 'string',
  beadStartCommit: (value) => value === null || typeof value === 'string',
  priority: (value) => typeof value === 'number' && Number.isFinite(value),
  iteration: (value) => typeof value === 'number' && Number.isFinite(value),
  prdRefs: isStringArray,
  acceptanceCriteria: isStringArray,
  tests: isStringArray,
  labels: isStringArray,
  targetFiles: isStringArray,
  testCommands: isCommandArray,
  failedIterationNotes: isObjectArray,
  userRetryNotes: isObjectArray,
  finalizationFailureNotes: isObjectArray,
  dependencies: (value) => isStringListRecord(value, ['blocked_by', 'blocks']),
  contextGuidance: (value) => isStringListRecord(value, ['patterns', 'anti_patterns']),
  qaOrigin: isQaOrigin,
}

/** The first thing wrong with an entry's shape, or null when nothing is. */
function describeBeadShapeProblem(entry: unknown): string | null {
  if (!isRecord(entry)) return 'entry is not an object'
  if (typeof entry.id !== 'string' || !entry.id.trim()) return 'no usable id'
  for (const [field, isValid] of Object.entries(BEAD_FIELD_CHECKS)) {
    if (entry[field] === undefined) continue
    if (!isValid(entry[field])) return `field "${field}" has the wrong type`
  }
  return null
}

/**
 * Fills in the two nested collections the `Bead` type declares as required.
 *
 * A row that has not reached expansion carries neither, and rejecting it would
 * refuse files that work — but thirteen readers dereference
 * `dependencies.blocked_by` and `contextGuidance.patterns` without a guard, and
 * defaulting at each of them is thirteen chances to miss one. An empty list is
 * the only thing "no dependencies" can mean, and it is exactly what the
 * expansion phase writes, so this normalises to the declared type rather than
 * inventing anything.
 */
function normalizeBeadCollections(bead: Bead): Bead {
  const dependencies = bead.dependencies ?? { blocked_by: [], blocks: [] }
  const contextGuidance = bead.contextGuidance ?? { patterns: [], anti_patterns: [] }
  if (dependencies === bead.dependencies && contextGuidance === bead.contextGuidance) return bead
  return { ...bead, dependencies, contextGuidance }
}

export function readBeadsFile(path: string, options: ReadBeadsFileOptions = {}): Bead[] {
  const failClosed = options.malformedEntries === 'fail'
  const { items, itemLines, malformedLines } = readJsonlWithDiagnostics<unknown>(path)
  if (failClosed && malformedLines.length > 0) {
    throw new Error(`Bead file ${path} has unparseable JSON at line(s) ${malformedLines.join(', ')}.`)
  }
  return items.flatMap((entry, index) => {
    // The line in the file, not the position among the entries that parsed:
    // blank and malformed lines sit between them, so the index named the wrong
    // record in exactly the files where the message mattered.
    const line = itemLines[index] ?? index + 1
    // `readJsonl<Bead>` casts rather than checks, so a `null` line threw on
    // `.status` and took the whole tracker with it, and any other non-object
    // became a `Bead` with no id that later code compared against.
    const problem = describeBeadShapeProblem(entry)
    if (problem) {
      if (failClosed) {
        throw new Error(`Bead file ${path} has an entry at line ${line} with ${problem}.`)
      }
      console.warn(`[beads] Ignored the entry at line ${line} of ${path}: ${problem}.`)
      return []
    }
    const bead = normalizeBeadCollections(entry as unknown as Bead)
    const reconciled = reconcileStoredBeadStatus(bead.status, bead.id)
    if (!reconciled.warning) return [bead]
    console.warn(`[beads] ${reconciled.warning}`)
    return [{ ...bead, status: reconciled.status }]
  })
}
