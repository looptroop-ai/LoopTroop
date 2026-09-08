import type { CommandSpec } from '@shared/commandSpec'
import { isRecord } from '@shared/typeGuards'
import type { ManualQaBeadOrigin } from '@/hooks/useTickets'
import { tryParseStructuredContent } from './structuredContent'

export const BEADS_APPROVAL_FOCUS_EVENT = 'beads-approval-focus'

/**
 * A bead exactly as it arrives from the server, with both the camelCase and
 * snake_case spellings the artifact has carried over time and every field
 * optional.
 *
 * Named `RawBead`, not `ParsedBead`: `BeadsApprovalEditor` exports a different
 * `ParsedBead` — the normalized shape its editor requires, with those fields
 * mandatory. Two contracts under one name would let a field added to either
 * side look interchangeable with the other.
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
  }
  context_guidance?: string | {
    patterns?: string[]
    anti_patterns?: string[]
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
  dependencies?: {
    blocked_by?: string[]
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
export function filterBeadShaped(entries: unknown[], describePosition: (index: number) => string): RawBead[] {
  return entries.filter((entry, index) => {
    const problem = describeBeadShapeProblem(entry)
    if (!problem) return true
    console.warn(`[beads] Ignored ${describePosition(index)} of the bead artifact: ${problem}.`)
    return false
  }) as RawBead[]
}

/** Positional wording for the array and envelope encodings. */
export function describeBeadEntry(index: number): string {
  return `entry ${index + 1}`
}

function collectBeads(entries: unknown[], describePosition: (index: number) => string): RawBead[] | null {
  const beads = filterBeadShaped(entries, describePosition)
  return beads.length > 0 ? beads : null
}

export function parseBeadsArtifact(content: string): RawBead[] | null {
  const parsed = tryParseStructuredContent(content)
  if (Array.isArray(parsed)) {
    return collectBeads(parsed, describeBeadEntry)
  }
  if (isRecord(parsed) && Array.isArray(parsed.beads)) {
    return collectBeads(parsed.beads, describeBeadEntry)
  }
  if (content.trim().startsWith('{')) {
    return parseBeadsJsonl(content)
  }
  return null
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
function parseBeadsJsonl(content: string): RawBead[] | null {
  const beads: RawBead[] = []
  const lines = content.trim().split('\n')

  lines.forEach((line, index) => {
    if (!line.trim()) return
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      console.warn(`[beads] Ignored line ${index + 1} of the bead artifact: it is not valid JSON.`)
      return
    }
    const problem = describeBeadShapeProblem(entry)
    if (problem) {
      console.warn(`[beads] Ignored line ${index + 1} of the bead artifact: ${problem}.`)
      return
    }
    beads.push(entry as RawBead)
  })

  return beads.length > 0 ? beads : null
}
