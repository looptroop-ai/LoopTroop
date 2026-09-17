import { isRecord } from '@shared/typeGuards'
import { commandSpecSchema } from '@shared/commandSpec'
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
   * `fail` (the default) is for authoritative reads, where a silently dropped
   * bead would be reported as an absence. `skip` is for diagnostic reads — board
   * projections and progress counts — where the surviving beads still help an
   * operator see what needs repair.
   */
  malformedEntries?: 'skip' | 'fail'
}

export interface BeadReadDiagnostics {
  /** 1-based lines that were not valid JSON. */
  malformedLines: number[]
  /** 1-based JSON lines that parsed but are not usable bead records. */
  unrepresentableLines: number[]
}

export interface ReadBeadsFileResult {
  beads: Bead[]
  diagnostics: BeadReadDiagnostics
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
 * A command list in the explicit shape the approval/runtime contract accepts.
 *
 * A bare string does not identify its shell, and `renderCommandSpec` otherwise
 * takes an unsafe implicit path; anything else, such as `[null]`, reached the
 * coding prompt and threw there.
 */
const isCommandArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => commandSpecSchema.safeParse(item).success)

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
 * Missing collection members are filled before validation. Present values
 * still need the right types, including each command and nested QA evidence.
 */
const BEAD_FIELD_CHECKS: Record<string, (value: unknown) => boolean> = {
  title: (value) => typeof value === 'string',
  description: (value) => typeof value === 'string',
  issueType: (value) => typeof value === 'string',
  externalRef: (value) => typeof value === 'string',
  // Unknown status strings are reconciled to `pending` below. Keep the shape
  // check about the type; rejecting a string here would turn the reader's
  // existing safe recovery into a dropped bead.
  status: (value) => typeof value === 'string',
  testCommandReason: (value) => typeof value === 'string',
  createdAt: (value) => typeof value === 'string',
  updatedAt: (value) => typeof value === 'string',
  completedAt: (value) => typeof value === 'string',
  startedAt: (value) => typeof value === 'string',
  beadStartCommit: (value) => value === null || typeof value === 'string',
  priority: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 1,
  iteration: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 1,
  prdRefs: isStringArray,
  acceptanceCriteria: isStringArray,
  tests: isStringArray,
  labels: isStringArray,
  targetFiles: isStringArray,
  testCommands: isCommandArray,
  failedIterationNotes: isObjectArray,
  userRetryNotes: isObjectArray,
  finalizationFailureNotes: isObjectArray,
  // Canonicalised before this runs, so only the canonical keys are checked.
  dependencies: (value) => isStringListRecord(value, ['blocked_by', 'blocks']),
  contextGuidance: (value) => isStringListRecord(value, ['patterns', 'anti_patterns']),
  qaOrigin: isQaOrigin,
}

/**
 * The first thing wrong with an entry's shape, or null when nothing is.
 *
 * Exported so the route that reports unusable rows can apply the *same* test:
 * a row this rejects is one the scheduler drops and the approval editor cannot
 * hold, and reporting a narrower set left those rows silently droppable.
 * Canonicalise first — `canonicalizeBeadAliases` — or a record storing only
 * accepted spellings is judged on fields it does not have under those names.
 */
export function describeBeadShapeProblem(entry: unknown): string | null {
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
export function normalizeBeadCollections<T extends object>(bead: T): T {
  const record = bead as Record<string, unknown>
  const dependencies = record.dependencies === undefined
    ? { blocked_by: [], blocks: [] }
    : isRecord(record.dependencies)
      ? { blocked_by: [], blocks: [], ...record.dependencies }
      : record.dependencies
  const contextGuidance = record.contextGuidance === undefined
    ? { patterns: [], anti_patterns: [] }
    : isRecord(record.contextGuidance)
      ? { patterns: [], anti_patterns: [], ...record.contextGuidance }
      : record.contextGuidance
  if (dependencies === record.dependencies && contextGuidance === record.contextGuidance) return bead
  return { ...record, dependencies, contextGuidance } as T
}

/**
 * Every spelling a stored bead may carry, mapped to the name readers use.
 *
 * The interface accepts both spellings of every field — older writers used
 * snake_case throughout — and this reader is what the scheduler and the coding
 * prompt run on. Without this the two disagree, and not gently: `formatBeadContext`
 * dereferences `acceptanceCriteria`, `targetFiles`, `tests` and `testCommands`
 * unguarded, so a bead stored with `acceptance_criteria` and nothing else
 * reached the prompt as `undefined` and threw there. The quieter ones are
 * worse: an alias-only `bead_start_commit` blocks a retry with a false cause,
 * alias-only timestamps resume the wrong bead, and an alias-only `qa_origin`
 * drops the Manual QA evidence with no warning at all.
 *
 * Kept in step with the interface's own table in `src/lib/beadsDocument.ts`
 * for editable fields, which `beadsFile.test.ts` asserts. Runtime-only retry
 * and finalisation notes live here as well because older writers persisted
 * those fields without exposing them in the editor.
 */
export const BEAD_FIELD_ALIASES: Record<string, string> = {
  prd_refs: 'prdRefs',
  prd_references: 'prdRefs',
  acceptance_criteria: 'acceptanceCriteria',
  test_commands: 'testCommands',
  test_command_reason: 'testCommandReason',
  target_files: 'targetFiles',
  issue_type: 'issueType',
  external_ref: 'externalRef',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  completed_at: 'completedAt',
  started_at: 'startedAt',
  bead_start_commit: 'beadStartCommit',
  context_guidance: 'contextGuidance',
  failed_iteration_notes: 'failedIterationNotes',
  user_retry_notes: 'userRetryNotes',
  finalization_failure_notes: 'finalizationFailureNotes',
  qa_origin: 'qaOrigin',
}

/** The nested keys, which carry spellings of their own. */
export const NESTED_BEAD_FIELD_ALIASES: Array<[field: string, canonical: string, alias: string]> = [
  ['dependencies', 'blocked_by', 'blockedBy'],
  ['contextGuidance', 'anti_patterns', 'antiPatterns'],
]

/**
 * Moves the spellings a record may carry onto the canonical ones.
 *
 * Only where the canonical key is absent: a record carrying both keeps the
 * one every reader already uses, including an intentional empty value. Runs before the shape check, so a bead is
 * judged on the fields readers will actually find.
 */
export function canonicalizeBeadAliases(entry: Record<string, unknown>): Record<string, unknown> {
  let result = entry
  for (const [alias, canonical] of Object.entries(BEAD_FIELD_ALIASES)) {
    if (!Object.hasOwn(result, alias)) continue
    if (Object.hasOwn(result, canonical) && result[canonical] !== undefined && result[canonical] !== null) {
      // Known aliases are not unknown data. Keeping both lets a stale alias
      // win on the next writer, so discard it once the canonical value exists.
      const { [alias]: _ignored, ...rest } = result
      result = rest
      continue
    }
    if (result[alias] === undefined || result[alias] === null) continue
    const { [alias]: aliased, ...rest } = result
    result = { ...rest, [canonical]: aliased }
  }

  for (const [field, canonical, alias] of NESTED_BEAD_FIELD_ALIASES) {
    const value = result[field]
    if (!isRecord(value)) continue
    if (!Object.hasOwn(value, alias)) continue
    if (Object.hasOwn(value, canonical) && value[canonical] !== undefined && value[canonical] !== null) {
      const { [alias]: _ignored, ...rest } = value
      result = { ...result, [field]: rest }
      continue
    }
    if (value[alias] === undefined || value[alias] === null) continue
    const { [alias]: aliased, ...rest } = value
    result = { ...result, [field]: { ...rest, [canonical]: aliased } }
  }
  return result
}

/** Rebuilds the inverse dependency field from authoritative `blocked_by` edges. */
export function deriveBeadBlocks<T extends Record<string, unknown>>(records: readonly T[]): T[] {
  const blocksById = new Map<string, string[]>()
  const normalized = records.map((record) => {
    const canonical = normalizeBeadCollections(canonicalizeBeadAliases(record))
    const dependencies = isRecord(canonical.dependencies) ? canonical.dependencies : {}
    const blockedBy = Array.isArray(dependencies.blocked_by)
      ? dependencies.blocked_by.filter((dependency): dependency is string => typeof dependency === 'string')
      : []
    const id = typeof canonical.id === 'string' ? canonical.id : ''
    if (id && !blocksById.has(id)) blocksById.set(id, [])
    return { canonical, dependencies, blockedBy, id }
  })

  for (const { blockedBy, id } of normalized) {
    if (!id) continue
    for (const dependency of blockedBy) {
      const blocks = blocksById.get(dependency)
      if (blocks && !blocks.includes(id)) blocks.push(id)
    }
  }

  return normalized.map(({ canonical, dependencies, blockedBy, id }) => ({
    ...canonical,
    dependencies: {
      ...dependencies,
      blocked_by: blockedBy,
      blocks: blocksById.get(id) ?? [],
    },
  } as unknown as T))
}

export type {
  BeadDependencyGraphEntry,
  BeadDependencyGraphValidation,
} from './dependencyGraph'
export {
  inspectBeadDependencyGraph,
  validateBeadDependencyGraph,
} from './dependencyGraph'

export function readBeadsFileWithDiagnostics(path: string, options: ReadBeadsFileOptions = {}): ReadBeadsFileResult {
  const failClosed = options.malformedEntries !== 'skip'
  const { items, itemLines, malformedLines } = readJsonlWithDiagnostics<unknown>(path)
  if (failClosed && malformedLines.length > 0) {
    throw new Error(`Bead file ${path} has unparseable JSON at line(s) ${malformedLines.join(', ')}.`)
  }
  const diagnostics: BeadReadDiagnostics = {
    malformedLines: [...malformedLines],
    unrepresentableLines: [],
  }
  const beads: Bead[] = []
  items.forEach((entry, index) => {
    // The line in the file, not the position among the entries that parsed:
    // blank and malformed lines sit between them, so the index named the wrong
    // record in exactly the files where the message mattered.
    const line = itemLines[index] ?? index + 1
    // `readJsonl<Bead>` casts rather than checks, so a `null` line threw on
    // `.status` and took the whole tracker with it, and any other non-object
    // became a `Bead` with no id that later code compared against.
    const canonical = isRecord(entry)
      ? normalizeBeadCollections(canonicalizeBeadAliases(entry))
      : entry
    const problem = describeBeadShapeProblem(canonical)
    if (problem) {
      if (failClosed) {
        throw new Error(`Bead file ${path} has an entry at line ${line} with ${problem}.`)
      }
      diagnostics.unrepresentableLines.push(line)
      console.warn(`[beads] Ignored the entry at line ${line} of ${path}: ${problem}.`)
      return
    }
    const bead = canonical as unknown as Bead
    const reconciled = reconcileStoredBeadStatus(bead.status, bead.id)
    if (!reconciled.warning) {
      beads.push(bead)
      return
    }
    console.warn(`[beads] ${reconciled.warning}`)
    beads.push({ ...bead, status: reconciled.status })
  })
  return { beads, diagnostics }
}

export function readBeadsFile(path: string, options: ReadBeadsFileOptions = {}): Bead[] {
  return readBeadsFileWithDiagnostics(path, options).beads
}
