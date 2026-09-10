import { commandSpecSchema, type CommandSpec } from '@shared/commandSpec'
import { carriesValue, isRecord } from '@shared/typeGuards'
import type { ManualQaBeadOrigin } from '@/hooks/useTickets'
import { tryParseStructuredContent } from './structuredContent'

export const BEADS_APPROVAL_FOCUS_EVENT = 'beads-approval-focus'

/**
 * A bead exactly as it arrives from the server, with both the camelCase and
 * snake_case spellings the artifact has carried over time and every field
 * optional.
 *
 * This is the wire shape. `NormalizedBead` below is what it becomes once read,
 * with the fields an editor writes to present and single-spelled. Keeping the
 * two named apart is what stops a field added to one from looking
 * interchangeable with the other.
 *
 * The artifact viewer declared this and its parser locally, and
 * `BeadsApprovalNavigator` reached for the same records through a bare
 * `bead as Record<string, unknown>` cast — so the outline and the detail view
 * could disagree about what a bead is.
 */
export interface RawBead {
  [key: string]: unknown
  id?: string
  title?: string
  prdRefs?: string[]
  prd_refs?: string[]
  description?: string
  contextGuidance?: string | {
    patterns?: string[]
    anti_patterns?: string[]
    antiPatterns?: string[]
  }
  context_guidance?: string | {
    patterns?: string[]
    anti_patterns?: string[]
    antiPatterns?: string[]
  }
  acceptanceCriteria?: string[]
  acceptance_criteria?: string[]
  tests?: string[]
  testCommands?: CommandSpec[]
  test_commands?: CommandSpec[]
  testCommandReason?: string
  test_command_reason?: string
  priority?: number
  status?: string
  issueType?: string
  issue_type?: string
  externalRef?: string
  external_ref?: string
  labels?: string[]
  // Both spellings, like every other field: `BEAD_FIELD_ALIASES` reads them
  // and a stored row can carry either.
  dependencies?: {
    blocked_by?: string[]
    blockedBy?: string[]
    blocks?: string[]
  }
  targetFiles?: string[]
  target_files?: string[]
  notes?: string
  iteration?: number
  createdAt?: string
  created_at?: string
  updatedAt?: string
  updated_at?: string
  completedAt?: string
  completed_at?: string
  startedAt?: string
  started_at?: string
  beadStartCommit?: string | null
  bead_start_commit?: string | null
  qaOrigin?: ManualQaBeadOrigin | null
  qa_origin?: ManualQaBeadOrigin | null
}

/**
 * Every spelling each bead field has been written under, most preferred first.
 *
 * A bead reaches the interface from three places — the JSONL tracker, a stored
 * artifact, and a model's structured output — and those have used camelCase and
 * snake_case at different times. The alias list used to be typed out at each
 * read: about twenty of them in the artifact viewer and a dozen more in the
 * approval editor's normalizer. They had already drifted — the editor accepted
 * `blockedBy` beside `blocked_by`, the viewer did not, so the same bead showed
 * dependencies on one screen and none on the other.
 *
 * One table, so adding a spelling is one line and reaches every reader.
 */
export const BEAD_FIELD_ALIASES = {
  id: ['id'],
  title: ['title'],
  description: ['description'],
  status: ['status'],
  notes: ['notes'],
  labels: ['labels'],
  priority: ['priority'],
  iteration: ['iteration'],
  tests: ['tests'],
  dependencies: ['dependencies'],
  prdRefs: ['prdRefs', 'prd_refs', 'prd_references'],
  acceptanceCriteria: ['acceptanceCriteria', 'acceptance_criteria'],
  testCommands: ['testCommands', 'test_commands'],
  testCommandReason: ['testCommandReason', 'test_command_reason'],
  targetFiles: ['targetFiles', 'target_files'],
  issueType: ['issueType', 'issue_type'],
  externalRef: ['externalRef', 'external_ref'],
  createdAt: ['createdAt', 'created_at'],
  updatedAt: ['updatedAt', 'updated_at'],
  completedAt: ['completedAt', 'completed_at'],
  startedAt: ['startedAt', 'started_at'],
  beadStartCommit: ['beadStartCommit', 'bead_start_commit'],
  contextGuidance: ['contextGuidance', 'context_guidance'],
  qaOrigin: ['qaOrigin', 'qa_origin'],
} as const satisfies Record<string, readonly string[]>

export type BeadField = keyof typeof BEAD_FIELD_ALIASES

/**
 * The spellings a canonical field supersedes.
 *
 * A record can arrive carrying both — `prd_refs` from an older writer and
 * `prdRefs` from a newer one — and an editor that writes only the canonical
 * name leaves the other holding the pre-edit value. Anything a reader takes
 * from the superseded spelling is then stale, silently.
 */
export const SUPERSEDED_BEAD_FIELD_ALIASES: readonly string[] =
  Object.entries(BEAD_FIELD_ALIASES).flatMap(([field, aliases]) => aliases.filter((alias) => alias !== field))

/**
 * Drops a superseded spelling only where the canonical one carries the value.
 *
 * Dropping them all loses data: `normalizeBead` writes canonical names for the
 * fields the editor touches, and nothing else — so a bead storing only
 * `started_at`, `bead_start_commit` or `qa_origin` had them deleted on the next
 * structured save, and `bead_start_commit` is what a safe reset depends on.
 *
 * Unknown fields are untouched, as before.
 */
export function stripSupersededBeadAliases<T extends RawBead>(bead: T): T {
  const canonicalFor = new Map<string, BeadField>()
  for (const [field, aliases] of Object.entries(BEAD_FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (alias !== field) canonicalFor.set(alias, field as BeadField)
    }
  }

  return Object.fromEntries(
    Object.entries(bead).filter(([key]) => {
      const canonical = canonicalFor.get(key)
      // Kept unless the canonical name carries the value: an alias that is the
      // only copy there is is not superseded by anything. `null` carries
      // nothing — it is what a writer leaves when it clears a field, and every
      // reader treats it as absent — so `qaOrigin: null` must not delete the
      // origin stored under the other spelling.
      return canonical === undefined || !carriesValue(bead[canonical])
    }),
  ) as T
}

/**
 * Whether the structured editor can represent this bead's test commands.
 *
 * The editor reads them through the command schema and drops whatever it
 * refuses — including the bare-string form older trackers carry, which the
 * runtime still accepts and migrates when it knows the host's shell. Saving
 * from the editor then wrote the bead back without commands the operator never
 * touched. The browser cannot pick a shell for them, so it declines to edit
 * the bead rather than guessing or deleting.
 */
export function hasUnrepresentableBeadCommands(bead: RawBead): boolean {
  return BEAD_FIELD_ALIASES.testCommands.some((key) => {
    const value = bead[key]
    if (!carriesValue(value)) return false
    if (!Array.isArray(value)) return true
    return value.some((command) => !commandSpecSchema.safeParse(command).success)
  })
}

/**
 * Whether the structured editor can represent this bead's guidance.
 *
 * Guidance is normally patterns and anti-patterns, but some stored beads carry
 * free text instead. The editor has no field for that, so it would show empty
 * lists and write them over the text on save — the same silent replacement the
 * malformed-line handling exists to prevent.
 */
export function hasUnstructuredBeadGuidance(bead: RawBead): boolean {
  // Every spelling, not the first one present: a record carrying a structured
  // `contextGuidance` and free text under `context_guidance` reported
  // structured, and the save then deleted the text.
  return BEAD_FIELD_ALIASES.contextGuidance.some((key) => {
    const value = bead[key]
    if (!carriesValue(value)) return false
    // Free text, or a list of guidance strings: both read as empty lists and
    // save as them.
    if (!isRecord(value)) return true
    // A record is only representable if the editor's two fields are all it
    // holds and both are lists of strings. `{ patterns: 'text' }` and
    // `{ rationale: '…' }` are read as empty and written back as empty, which
    // is the same silent replacement one shape deeper.
    return Object.entries(value).some(([nested, nestedValue]) => {
      const known = GUIDANCE_ALIASES.patterns.includes(nested as never)
        || GUIDANCE_ALIASES.anti_patterns.includes(nested as never)
      if (!known) return true
      return !Array.isArray(nestedValue) || nestedValue.some((item) => typeof item !== 'string')
    })
  })
}

/** The nested keys, which carry their own spellings. */
const DEPENDENCY_ALIASES = {
  blocked_by: ['blocked_by', 'blockedBy'],
  blocks: ['blocks'],
} as const
const GUIDANCE_ALIASES = {
  patterns: ['patterns'],
  anti_patterns: ['anti_patterns', 'antiPatterns'],
} as const

/**
 * What a reader does with the text it finds.
 *
 * `display` trims and drops what is left empty, which is what every view wants:
 * a criterion that is three spaces is not a criterion. `verbatim` keeps the
 * text exactly as stored, which is what the approval editor needs — an editor
 * that silently reformats what someone typed loses their work on the next save.
 *
 * The two policies are the reason there is no single "the bead shape": they
 * read the same fields and must not agree about whitespace.
 */
export type BeadReadPolicy = 'display' | 'verbatim'

function candidates(bead: RawBead, field: BeadField): unknown[] {
  return BEAD_FIELD_ALIASES[field].map((key) => bead[key])
}

function readStringList(values: unknown[], policy: BeadReadPolicy): string[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue
    const strings = value.filter((item): item is string => typeof item === 'string')
    return policy === 'verbatim'
      ? strings
      : strings.map((item) => item.trim()).filter(Boolean)
  }
  return []
}

/**
 * The first value present under any of a field's spellings, whatever its type.
 *
 * For the two fields a view reads as a whole object rather than through a
 * typed reader: the Manual QA origin and the guidance block, which both have a
 * renderer of their own that decides what an unusable value looks like.
 */
export function readBeadValue(bead: RawBead, field: BeadField): unknown {
  for (const value of candidates(bead, field)) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

export function readBeadStringList(bead: RawBead, field: BeadField, policy: BeadReadPolicy): string[] {
  return readStringList(candidates(bead, field), policy)
}

export function readBeadString(bead: RawBead, field: BeadField, policy: BeadReadPolicy): string {
  for (const value of candidates(bead, field)) {
    if (typeof value !== 'string') continue
    if (policy === 'verbatim') return value
    if (value.trim()) return value.trim()
  }
  return ''
}

export function readBeadNumber(bead: RawBead, field: BeadField): number | null {
  for (const value of candidates(bead, field)) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/**
 * No policy argument: a command is validated by its schema, not read as text,
 * and the schema trims and defaults whichever way it was stored. Trimming is
 * not this reader's decision to make.
 */
export function readBeadCommands(bead: RawBead, field: BeadField): CommandSpec[] {
  for (const value of candidates(bead, field)) {
    if (!Array.isArray(value)) continue
    return value.flatMap((command) => {
      const parsed = commandSpecSchema.safeParse(command)
      return parsed.success ? [parsed.data] : []
    })
  }
  return []
}

function readNested(
  source: unknown,
  aliases: Record<string, readonly string[]>,
  policy: BeadReadPolicy,
): Record<string, string[]> {
  const record = isRecord(source) && !Array.isArray(source) ? source : {}
  const result: Record<string, string[]> = {}
  for (const [key, keyAliases] of Object.entries(aliases)) {
    result[key] = readStringList(keyAliases.map((alias) => record[alias]), policy)
  }
  return result
}

export function readBeadDependencies(bead: RawBead, policy: BeadReadPolicy): { blocked_by: string[]; blocks: string[] } {
  const read = readNested(bead.dependencies, DEPENDENCY_ALIASES, policy)
  return { blocked_by: read.blocked_by ?? [], blocks: read.blocks ?? [] }
}

export function readBeadGuidance(bead: RawBead, policy: BeadReadPolicy): { patterns: string[]; anti_patterns: string[] } {
  const source = BEAD_FIELD_ALIASES.contextGuidance
    .map((key) => bead[key])
    .find((value) => isRecord(value))
  const read = readNested(source, GUIDANCE_ALIASES, policy)
  return { patterns: read.patterns ?? [], anti_patterns: read.anti_patterns ?? [] }
}

/**
 * A bead with the fields an editor requires present and single-spelled.
 *
 * `RawBead` is the wire shape — every field optional, both spellings, whatever
 * else the row carried. This is what it becomes once read: the same record,
 * with the fields the approval editor writes to normalized onto it. It lives
 * beside the wire type it is derived from and the alias table that derives it.
 */
export interface NormalizedBead extends RawBead {
  id: string
  title: string
  description: string
  issueType?: string
  externalRef?: string
  prdRefs: string[]
  acceptanceCriteria: string[]
  tests: string[]
  testCommands: CommandSpec[]
  testCommandReason?: string
  targetFiles: string[]
  contextGuidance: { patterns: string[]; anti_patterns: string[] }
  dependencies: { blocked_by: string[]; blocks: string[] }
}

/**
 * Reads every aliased field once, onto the canonical spelling.
 *
 * Unknown fields are kept: a bead carries more than the editor shows, and the
 * save path writes the whole record back.
 */
export function normalizeBead(bead: RawBead, policy: BeadReadPolicy): NormalizedBead {
  const testCommandReason = readBeadString(bead, 'testCommandReason', policy)
  const issueType = readBeadString(bead, 'issueType', policy)
  const externalRef = readBeadString(bead, 'externalRef', policy)
  return {
    ...bead,
    id: readBeadString(bead, 'id', policy),
    title: readBeadString(bead, 'title', policy),
    description: readBeadString(bead, 'description', policy),
    // Read-only in the editor, but read raw there before this: a bead stored
    // with `issue_type` showed its type in the artifact view and fell back to
    // the default in the editor. Written only when the bead has one, so a save
    // does not add empty strings to every record it touches.
    ...(issueType ? { issueType } : {}),
    ...(externalRef ? { externalRef } : {}),
    prdRefs: readBeadStringList(bead, 'prdRefs', policy),
    acceptanceCriteria: readBeadStringList(bead, 'acceptanceCriteria', policy),
    tests: readBeadStringList(bead, 'tests', policy),
    testCommands: readBeadCommands(bead, 'testCommands'),
    ...(testCommandReason ? { testCommandReason } : {}),
    targetFiles: readBeadStringList(bead, 'targetFiles', policy),
    contextGuidance: readBeadGuidance(bead, policy),
    dependencies: readBeadDependencies(bead, policy),
  }
}

/**
 * Is this entry usable as a bead?
 *
 * The same test the server applies in `describeBeadShapeProblem`: an object
 * with a usable id. Applied to every encoding, not just JSONL — the array and
 * envelope forms used to be cast straight through, so `[null]` reached the
 * viewer's field readers and threw, and `[42]` rendered as a bead with
 * placeholder values.
 */
export function isBeadShaped(entry: unknown): entry is RawBead {
  return isRecord(entry) && typeof entry.id === 'string' && entry.id.trim().length > 0
}

/** Why an entry is not usable, worded the way the server words it. */
function describeBeadShapeProblem(entry: unknown): string | null {
  if (!isRecord(entry)) return 'entry is not an object'
  if (typeof entry.id !== 'string' || !entry.id.trim()) return 'no usable id'
  return null
}

/**
 * The bead list every surface must agree on.
 *
 * **Every consumer has to use this one.** The artifact view, the approval
 * outline, the approval editor and the bead counts each index into the result
 * — the outline's focus anchors are positions in this list — so a surface that
 * filters differently, or not at all, sends the reader to the wrong bead or
 * shows a count the detail view contradicts. Filtering in one renderer and not
 * the others is exactly the skew this replaced.
 */
export function filterBeadShaped(
  entries: unknown[],
  describePosition: (index: number) => string,
  options: { warn?: boolean } = {},
): RawBead[] {
  const warn = options.warn ?? true
  return entries.filter((entry, index) => {
    const problem = describeBeadShapeProblem(entry)
    if (!problem) return true
    if (warn) console.warn(`[beads] Ignored ${describePosition(index)} of the bead artifact: ${problem}.`)
    return false
  }) as RawBead[]
}

/** Positional wording for the array and envelope encodings. */
export function describeBeadEntry(index: number): string {
  return `entry ${index + 1}`
}

/**
 * Whether this content holds a bead collection at all, and which beads survived.
 *
 * `parseBeadsArtifact` returns `null` both for "this is not a bead artifact" and
 * for "it is one, and every entry was rejected". The counter needs to tell them
 * apart: the first should fall back to counting YAML ids, the second must count
 * zero, or it reports beads over a viewer showing raw text.
 */
function readBeadCollection(content: string, warn: boolean): { recognized: boolean; beads: RawBead[] } {
  const parsed = tryParseStructuredContent(content)
  if (Array.isArray(parsed)) {
    return { recognized: true, beads: filterBeadShaped(parsed, describeBeadEntry, { warn }) }
  }
  if (isRecord(parsed) && Array.isArray(parsed.beads)) {
    return { recognized: true, beads: filterBeadShaped(parsed.beads, describeBeadEntry, { warn }) }
  }
  // Recognised by finding a bead line, not by the document's first character:
  // a tracker whose *first* line is damaged still starts with damage, and
  // testing that character alone hid every intact bead behind it.
  const jsonlBeads = parseBeadsJsonl(content, warn)
  if (jsonlBeads) return { recognized: true, beads: jsonlBeads }
  if (content.trim().startsWith('{')) return { recognized: true, beads: [] }
  return { recognized: false, beads: [] }
}

export function parseBeadsArtifact(content: string): RawBead[] | null {
  const { beads } = readBeadCollection(content, true)
  return beads.length > 0 ? beads : null
}

/**
 * Read a JSONL bead tracker the way the server reads one.
 *
 * The previous version returned `null` for the whole artifact the moment any
 * single line failed to parse, so one damaged line hid every intact bead — the
 * opposite of `server/phases/beads/beadsFile.ts`, which skips the bad entry,
 * warns with the file's own line number, and keeps the rest. It also accepted
 * any JSON object as a bead, so a payload like `{"status":"pending"}` rendered
 * as a fabricated one-bead artifact instead of falling back to raw text.
 *
 * Bead shape is judged the same way the server judges it: an object with a
 * usable `id`. Returning `null` when nothing survives is what sends the caller
 * to the raw view.
 */
function parseBeadsJsonl(content: string, warn = true): RawBead[] | null {
  const beads: RawBead[] = []
  // Not `content.trim().split(…)`: trimming first renumbers everything after a
  // leading blank line, so a warning pointed at a different line from the one
  // the server reports for the same content. Blank lines are skipped in place.
  const lines = content.split('\n')

  lines.forEach((line, index) => {
    if (!line.trim()) return
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      if (warn) console.warn(`[beads] Ignored line ${index + 1} of the bead artifact: it is not valid JSON.`)
      return
    }
    const problem = describeBeadShapeProblem(entry)
    if (problem) {
      if (warn) console.warn(`[beads] Ignored line ${index + 1} of the bead artifact: ${problem}.`)
      return
    }
    beads.push(entry as RawBead)
  })

  return beads.length > 0 ? beads : null
}

/**
 * How many beads a bead artifact holds, counted the way the artifact view
 * renders it.
 *
 * The two copies this replaces had drifted: one early-returned `0` for content
 * that parsed to a single JSON object, before reaching its own JSONL branch,
 * while the other fell through and returned `1`. Same stored artifact, a "0
 * beads" chip beside a viewer showing one card.
 *
 * Uses the parser rather than re-deriving the encodings, so a count can never
 * again disagree with the list underneath it. The regex is the last resort for
 * YAML the parser declines, where a count is better than nothing.
 */
export function countBeadsInContent(content: string): number {
  // Silent: a count is drawn on every render of a summary chip, and the parser's
  // diagnostics belong to the one place that actually reads the artifact.
  const { recognized, beads } = readBeadCollection(content, false)
  // A recognized collection whose entries were all rejected counts zero. Falling
  // through to the regex here would report beads over a viewer showing raw text
  // — the count-versus-list disagreement this function exists to prevent.
  if (recognized) return beads.length
  return (content.match(/^\s*-\s+id\s*:/gm) ?? []).length
}
