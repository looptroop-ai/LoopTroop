import { Hono } from 'hono'
import type { Context } from 'hono'
import { readFileNoFollowSync } from '../io/readFile'
import * as path from 'node:path'
import { z } from 'zod'
import { getTicketByRef, getTicketPaths, getLatestPhaseArtifact, isDisplayOnlyMockTicket, resolveTicketContainedPath, writeTicketFile } from '../storage/tickets'
import { ContainedPathError } from '../lib/containedPath'
import { syncTicketRuntimeProjection } from '../storage/ticketRuntimeProjection'
import { clearExecutionSetupState } from '../phases/executionSetup/storage'
import { upsertBeadsApprovalSnapshot } from '../phases/beads/document'
import {
  canonicalizeBeadAliases,
  describeBeadShapeProblem,
  deriveBeadBlocks,
  reconcileStoredBeadStatus,
  validateBeadDependencyGraph,
} from '../phases/beads/beadsFile'
import { contentSha256 } from '../lib/contentHash'
import { parseJsonlContent } from '../io/jsonl'
import { isRecord } from '@shared/typeGuards'
import { commandSpecSchema } from '@shared/commandSpec'
import { isBeadStatus, resolveBeadStatusAlias } from '../phases/beads/types'
import { writeUserEditReceipt } from '../workflow/artifactEditReceipts'

// Minimum schema for fields required by the scheduler and execution engine.
// Other fields pass through without strict validation for forward-compatibility.
const beadStatusSchema = z.string().transform((value, ctx) => {
  const folded = value.trim().toLowerCase()
  if (isBeadStatus(folded)) return folded
  const mapped = resolveBeadStatusAlias(folded)
  if (mapped) return mapped
  if (!folded) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'status must be a non-empty string' })
    return z.NEVER
  }
  // The canonical reader safely retries an unrecognised status as pending;
  // save uses the same recovery rather than persisting a value the scheduler
  // can never run.
  return 'pending'
})

const beadItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: beadStatusSchema,
  priority: z.number().int().min(1),
  // Both spellings in, one spelling out. The interface accepts `blockedBy`
  // because older trackers carry it; refusing it here made a repair typed in
  // the JSONL tab fail with "dependencies.blocked_by: Required" on a file the
  // screen had just rendered as valid.
  dependencies: z.object({
    blocked_by: z.array(z.string()).optional(),
    blockedBy: z.array(z.string()).optional(),
    blocks: z.array(z.string()).optional(),
  }).passthrough()
    .refine((value) => value.blocked_by !== undefined || value.blockedBy !== undefined, {
      message: 'dependencies must include blocked_by',
    })
    .transform(({ blocked_by, blockedBy, blocks, ...unknownDependencies }) => ({
      ...unknownDependencies,
      blocked_by: blocked_by ?? blockedBy ?? [],
      // `blocks` is derived from the authoritative `blocked_by` edges below;
      // an editor or JSONL repair need not carry a stale inverse at all.
      blocks: blocks ?? [],
    })),
  // Commands are deliberately structured. A bare string does not identify its
  // shell, so approval cannot turn it into an implicit shell command safely.
  testCommands: z.array(commandSpecSchema).optional(),
}).passthrough()

const beadsRouter = new Hono()
beadsRouter.onError((error, c) => {
  if (error instanceof ContainedPathError) return c.json({ error: error.message }, 400)
  throw error
})
const FLOW_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/

function isSafeFlowName(flow: string): boolean {
  if (!flow || path.isAbsolute(flow) || flow.includes('\\') || !FLOW_NAME_PATTERN.test(flow)) return false
  return flow.split('/').every((segment) => Boolean(segment) && segment !== '.' && segment !== '..')
}

function resolveBeadsPath(ticketId: string, flow?: string): { filePath: string; relativePath: string } | { error: string; status: 400 | 404 } {
  const paths = getTicketPaths(ticketId)
  if (!paths) return { error: 'Ticket not found', status: 404 }
  const resolvedFlow = flow?.trim() || paths.baseBranch
  if (!isSafeFlowName(resolvedFlow)) {
    return { error: 'Invalid flow parameter', status: 400 }
  }

  const relativePath = `beads/${resolvedFlow}/.beads/issues.jsonl`
  try {
    const filePath = resolveTicketContainedPath(ticketId, relativePath)
    return filePath ? { filePath, relativePath } : { error: 'Ticket not found', status: 404 }
  } catch (error) {
    if (error instanceof ContainedPathError) return { error: 'Invalid flow parameter', status: 400 }
    throw error
  }
}

/** How many damaged line numbers the header carries before it summarises. */
const MALFORMED_LINE_HEADER_LIMIT = 50

/**
 * The lines holding a record the approval editor cannot represent.
 *
 * A line that parses is not yet a bead: `null`, an array, an object with no
 * usable `id`, or one whose fields hold the wrong kind of value. Protecting
 * only the lines that fail to *parse* left those droppable in exactly the way
 * this route stopped dropping the others — the structured editor is built from
 * the records it can read, and saving it writes the rest out of the file.
 *
 * Literally the reader's own test, not a paraphrase of it: checking the id
 * alone let `{"id":"B-1","priority":"high"}` past the banner, out of the
 * editor, and out of the file on the next save — and past approval, into a
 * scheduler that drops it with a warning nobody reads. Aliases are
 * canonicalised first, so a record storing accepted spellings is judged on the
 * fields the reader will actually find.
 */
function findUnrepresentableLines(items: unknown[], itemLines: number[]): number[] {
  return items.flatMap((item, index) => (
    describeBeadShapeProblem(isRecord(item) ? canonicalizeBeadAliases(item) : item) === null
      ? []
      : [itemLines[index] ?? index + 1]
  ))
}

/** Canonical fields for the parsed projection; the raw endpoint keeps bytes separately. */
function canonicalizeParsedItems(items: unknown[]): unknown[] {
  return items.map((item) => {
    if (!isRecord(item)) return item
    const canonical = canonicalizeBeadAliases(item)
    if (typeof canonical.status !== 'string' || typeof canonical.id !== 'string' || !canonical.id.trim()) return canonical
    const reconciled = reconcileStoredBeadStatus(canonical.status, canonical.id)
    if (reconciled.warning) console.warn(`[beads] ${reconciled.warning}`)
    return { ...canonical, status: reconciled.status }
  })
}

/**
 * Names the damaged lines in a header, bounded.
 *
 * A tracker damaged at thousands of lines would otherwise build a header of
 * tens of kilobytes, which proxies drop or truncate — failing the request for
 * exactly the file this route exists to rescue. The count is always exact even
 * when the list is cut short.
 */
function setMalformedLineHeaders(c: Context, malformedLines: number[], unrepresentableLines: number[] = []) {
  if (malformedLines.length > 0) {
    c.header('X-Malformed-Line-Count', String(malformedLines.length))
    c.header('X-Malformed-Lines', formatLineList(malformedLines))
  }
  if (unrepresentableLines.length > 0) {
    c.header('X-Unrepresentable-Line-Count', String(unrepresentableLines.length))
    c.header('X-Unrepresentable-Lines', formatLineList(unrepresentableLines))
  }
}

/**
 * The line numbers, capped, and still only line numbers.
 *
 * Every token stays an integer: a `+N more` tail in a comma-separated list is
 * an element that is not a line, and the first caller to split on the comma
 * would read it as one. The `…-Count` header beside it is exact and always
 * parseable, so the truncation is reported without corrupting the list.
 */
function formatLineList(lines: number[]): string {
  return lines.slice(0, MALFORMED_LINE_HEADER_LIMIT).join(',')
}

/**
 * The tracker's bytes, or `null` when there is no tracker at all.
 *
 * Reads and handles "not found" rather than asking whether the path exists: an
 * existence check on a path built from a request parameter is a filesystem
 * oracle (`tssecurity:S6549`), and it is also a window — the file can be
 * created or removed between the check and the read. One call answers both.
 *
 * `null` and `''` are different answers: a save needs to tell "no file yet",
 * which nothing can be lost from, apart from an empty one that another writer
 * may already own.
 */
function readBeadsContentOrNull(filePath: string): string | null {
  try {
    return readFileNoFollowSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** As above, with an absent tracker read as an empty one. */
function readBeadsContent(filePath: string): string {
  return readBeadsContentOrNull(filePath) ?? ''
}

function countJsonlItems(content: string | null): number | null {
  if (content == null) return null
  return content.split('\n').filter((line) => line.trim() !== '').length
}

interface BeadValidationError {
  index: number
  line: number
  issues: string[]
}

function readClientSourceLines(c: Context, itemCount: number): number[] | null {
  const raw = c.req.header('X-Source-Lines')
  if (raw === undefined) return null
  if (itemCount === 0 && raw.trim() === '') return []

  const tokens = raw.split(',').map((token) => token.trim())
  if (tokens.length !== itemCount || tokens.some((token) => !/^[1-9]\d*$/.test(token))) {
    throw new Error(
      'X-Source-Lines must contain exactly '
      + itemCount
      + ' positive line number'
      + (itemCount === 1 ? '' : 's')
      + '.',
    )
  }
  const lines = tokens.map(Number)
  if (lines.some((line) => !Number.isSafeInteger(line))) {
    throw new Error('X-Source-Lines contains a line number that is too large.')
  }
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]! <= lines[index - 1]!) {
      throw new Error('X-Source-Lines must be strictly increasing.')
    }
  }
  return lines
}

function formatBeadValidationDetails(errors: readonly BeadValidationError[]): string {
  return errors.flatMap(({ line, issues }) => issues.map((issue) => `Line ${line}: ${issue}`)).join('; ')
}

beadsRouter.get('/tickets/:id/beads', (c) => {
  const ticketId = c.req.param('id')
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)

  const flow = c.req.query('flow')
  const resolved = resolveBeadsPath(ticketId, flow)
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status)
  const { filePath } = resolved

  const content = readBeadsContent(filePath)
  c.header('X-Content-Sha256', contentSha256(content))
  // One line that will not parse used to fail the whole request, so an
  // approval screen lost every bead in the tracker to a single damaged row —
  // the one situation where seeing the rest is what lets someone repair it.
  // The lines that did parse are returned; the ones that did not are named in
  // a header, by their line number in the file.
  const { items, itemLines, malformedLines } = parseJsonlContent(content, filePath)
  const canonicalItems = canonicalizeParsedItems(items)
  setMalformedLineHeaders(c, malformedLines, findUnrepresentableLines(canonicalItems, itemLines))
  return c.json(canonicalItems)
})

/**
 * The same tracker as bytes, for the screen that has to repair it.
 *
 * The array above cannot carry a line that did not parse, so a client that
 * rebuilds the file from it writes the damage away. This returns the file as
 * stored, the records that parsed, and the lines that did not, so the editor
 * can show the damaged text in place and save a repair rather than a deletion.
 */
beadsRouter.get('/tickets/:id/beads/raw', (c) => {
  const ticketId = c.req.param('id')
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)

  const resolved = resolveBeadsPath(ticketId, c.req.query('flow'))
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status)
  const { filePath } = resolved

  const content = readBeadsContent(filePath)
  c.header('X-Content-Sha256', contentSha256(content))
  const { items, itemLines, malformedLines } = parseJsonlContent(content, filePath)
  const canonicalItems = canonicalizeParsedItems(items)
  const unrepresentableLines = findUnrepresentableLines(canonicalItems, itemLines)
  setMalformedLineHeaders(c, malformedLines, unrepresentableLines)

  return c.json({ content, items: canonicalItems, malformedLines, unrepresentableLines })
})

beadsRouter.put('/tickets/:id/beads', async (c) => {
  const ticketId = c.req.param('id')
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  if (isDisplayOnlyMockTicket(ticket)) {
    return c.json({ error: 'Display-only mock tickets are board-only and cannot run workflow actions' }, 409)
  }
  if (ticket.status !== 'WAITING_BEADS_APPROVAL') {
    return c.json({ error: 'Ticket is not waiting for beads approval' }, 409)
  }

  const flow = c.req.query('flow')
  const body = await c.req.json()
  if (!Array.isArray(body)) {
    return c.json({ error: 'Request body must be a JSON array' }, 400)
  }
  let sourceLines: number[] | null
  try {
    sourceLines = readClientSourceLines(c, body.length)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid X-Source-Lines header' }, 400)
  }

  // Validate each bead item has the fields required by the scheduler/execution engine.
  // JSONL clients send the source line for each parsed row; structured clients
  // have no source file positions, so their output line is its array position.
  const validationErrors: BeadValidationError[] = []
  // What gets written: the record as sent, with aliases canonicalised and the
  // dependency spelling the runtime reads. Unknown top-level and dependency
  // keys remain on the record for newer readers.
  const canonicalBeads: Array<Record<string, unknown>> = []
  for (let i = 0; i < body.length; i++) {
    const input = isRecord(body[i]) ? canonicalizeBeadAliases(body[i]) : null
    const result = beadItemSchema.safeParse(input)
    if (!result.success) {
      validationErrors.push({
        index: i,
        line: sourceLines?.[i] ?? i + 1,
        issues: result.error.issues.map((issue) => {
          const field = issue.path.length > 0 ? issue.path.join('.') : 'bead'
          return `${field}: ${issue.message}`
        }),
      })
      continue
    }
    const canonical = { ...(input ?? {}), ...result.data, dependencies: result.data.dependencies } as Record<string, unknown>
    const shapeProblem = describeBeadShapeProblem(canonical)
    if (shapeProblem) {
      validationErrors.push({ index: i, line: sourceLines?.[i] ?? i + 1, issues: [shapeProblem] })
      continue
    }
    canonicalBeads.push(canonical)
  }
  if (validationErrors.length > 0) {
    return c.json({
      error: 'Invalid bead item(s)',
      details: formatBeadValidationDetails(validationErrors),
      validationErrors,
    }, 400)
  }

  // Check for duplicate IDs after aliases and field validation have produced
  // the exact records that would be stored.
  const ids = canonicalBeads.map((item) => item.id as string)
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (duplicateIds.length > 0) {
    return c.json({ error: 'Duplicate bead IDs', details: [...new Set(duplicateIds)] }, 400)
  }

  // blocked_by is authoritative. A user edit may omit or carry a stale blocks
  // list; derive the inverse from the edges the scheduler actually follows,
  // while retaining unknown dependency metadata.
  const storedBeads = deriveBeadBlocks(canonicalBeads)
  const graphErrors = validateBeadDependencyGraph(storedBeads.map((bead) => ({
    id: bead.id as string,
    dependencies: bead.dependencies as { blocked_by: string[]; blocks: string[] },
  })))
  if (graphErrors.length > 0) {
    return c.json({
      error: 'Invalid bead dependency graph',
      details: graphErrors.join('; '),
    }, 400)
  }

  const resolved = resolveBeadsPath(ticketId, flow)
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status)
  const { filePath } = resolved

  // Inside the error boundary with the write it guards: the precondition needs
  // a read, and a read that fails for any reason other than "no file" — a
  // permission, a path that became a directory — has to become this route's
  // own 500 rather than an unhandled throw.
  let beforeRaw: string | null
  try {
    beforeRaw = readBeadsContentOrNull(filePath)
  } catch (error) {
    if (error instanceof ContainedPathError) throw error
    return c.json({ error: 'Failed to read the existing bead plan' }, 500)
  }

  // Optimistic concurrency, the same guard approval already applies. Without
  // it a save built on a stale read overwrites whatever landed in between —
  // including a repair of the very lines the reader could not parse. Required
  // whenever there is a file to overwrite; a first write has nothing to lose.
  if (beforeRaw !== null) {
    const expectedContentSha256 = c.req.header('X-Content-Sha256')
    if (!expectedContentSha256) {
      return c.json({ error: 'Missing X-Content-Sha256 header for an existing bead plan' }, 428)
    }
    const currentContentSha256 = contentSha256(beforeRaw)
    if (expectedContentSha256 !== currentContentSha256) {
      return c.json({
        error: 'Bead plan changed since it was read',
        expectedContentSha256,
        currentContentSha256,
      }, 409)
    }
  }

  // The structured editor is built from rows it can represent. Refuse that
  // surface while the stored file has damaged rows, even when a direct client
  // supplies the current hash; only the JSONL repair surface can carry those
  // rows without silently dropping them.
  if (beforeRaw !== null && c.req.header('X-Edit-Surface') !== 'jsonl') {
    const { items, itemLines, malformedLines } = parseJsonlContent(beforeRaw, filePath)
    const unrepresentableLines = findUnrepresentableLines(canonicalizeParsedItems(items), itemLines)
    if (malformedLines.length > 0 || unrepresentableLines.length > 0) {
      return c.json({
        error: 'Damaged bead plan must be repaired in JSONL mode',
        details: 'The structured editor cannot preserve every stored row.',
        malformedLines,
        unrepresentableLines,
      }, 422)
    }
  }

  try {
    // createdAt is set at approval time, not save time
    const jsonl = storedBeads.map((item) => JSON.stringify(item)).join('\n') + '\n'
    writeTicketFile(ticketId, resolved.relativePath, jsonl)
    upsertBeadsApprovalSnapshot(ticketId, jsonl)
    const executionSetupInvalidation = clearExecutionSetupState(ticketId)
    writeUserEditReceipt({
      ticketId,
      artifactType: 'beads',
      phase: 'WAITING_BEADS_APPROVAL',
      action: 'save',
      // Which tab the save came from, as the client reports it. Hardcoding
      // `structured` mislabelled every JSONL repair — the flow this route
      // now mostly serves.
      editSurface: c.req.header('X-Edit-Surface') === 'jsonl' ? 'jsonl' : 'structured',
      statusBeforeEdit: ticket.status,
      statusAfterEdit: getTicketByRef(ticketId)?.status ?? null,
      beforeRaw,
      afterRaw: jsonl,
      beforeItemCount: countJsonlItems(beforeRaw),
      afterItemCount: storedBeads.length,
      invalidation: {
        ...executionSetupInvalidation,
        invalidatedPhases: [
          'GENERATING_EXECUTION_SETUP_PLAN',
          'WAITING_EXECUTION_SETUP_APPROVAL',
          'PREPARING_EXECUTION_ENV',
        ],
        clearedExecutionSetupState: executionSetupInvalidation.removedArtifacts > 0 || executionSetupInvalidation.removedFiles.length > 0,
      },
    })
    syncTicketRuntimeProjection(ticketId)
    c.header('X-Content-Sha256', contentSha256(jsonl))
  } catch (error) {
    if (error instanceof ContainedPathError) throw error
    return c.json({ error: 'Failed to write file' }, 500)
  }

  return c.json({ success: true })
})

const BEAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/

beadsRouter.get('/tickets/:id/beads/:beadId/diff', (c) => {
  const ticketId = c.req.param('id')
  const beadId = c.req.param('beadId')

  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)
  if (!beadId || !BEAD_ID_PATTERN.test(beadId)) {
    return c.json({ error: 'Invalid bead ID' }, 400)
  }

  const artifact = getLatestPhaseArtifact(ticketId, `bead_diff:${beadId}`, 'CODING')
  if (!artifact) {
    return c.json({ diff: '', captured: false })
  }

  return c.json({ diff: artifact.content ?? '', captured: true })
})

export { beadsRouter }
