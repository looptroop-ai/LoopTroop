import { Hono } from 'hono'
import type { Context } from 'hono'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { getTicketByRef, getTicketPaths, getLatestPhaseArtifact, isDisplayOnlyMockTicket } from '../storage/tickets'
import { safeAtomicWrite } from '../io/atomicWrite'
import { syncTicketRuntimeProjection } from '../storage/ticketRuntimeProjection'
import { clearExecutionSetupState } from '../phases/executionSetup/storage'
import { upsertBeadsApprovalSnapshot } from '../phases/beads/document'
import { canonicalizeBeadAliases, describeBeadShapeProblem } from '../phases/beads/beadsFile'
import { contentSha256 } from '../lib/contentHash'
import { parseJsonlContent } from '../io/jsonl'
import { isRecord } from '@shared/typeGuards'
import { writeUserEditReceipt } from '../workflow/artifactEditReceipts'

// Minimum schema for fields required by the scheduler and execution engine.
// Other fields pass through without strict validation for forward-compatibility.
const beadItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'done', 'error']),
  priority: z.number().int().min(1),
  // Both spellings in, one spelling out. The interface accepts `blockedBy`
  // because older trackers carry it; refusing it here made a repair typed in
  // the JSONL tab fail with "dependencies.blocked_by: Required" on a file the
  // screen had just rendered as valid.
  dependencies: z.object({
    blocked_by: z.array(z.string()).optional(),
    blockedBy: z.array(z.string()).optional(),
    blocks: z.array(z.string()),
  })
    .refine((value) => value.blocked_by !== undefined || value.blockedBy !== undefined, {
      message: 'dependencies must include blocked_by',
    })
    .transform(({ blocked_by, blockedBy, blocks }) => ({ blocked_by: blocked_by ?? blockedBy ?? [], blocks })),
})

const beadsRouter = new Hono()
const FLOW_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/

function isSafeFlowName(flow: string): boolean {
  if (!flow || path.isAbsolute(flow) || flow.includes('\\') || !FLOW_NAME_PATTERN.test(flow)) return false
  return flow.split('/').every((segment) => Boolean(segment) && segment !== '.' && segment !== '..')
}

function resolveBeadsPath(ticketId: string, flow?: string): { filePath: string } | { error: string; status: 400 | 404 } {
  const paths = getTicketPaths(ticketId)
  if (!paths) return { error: 'Ticket not found', status: 404 }
  const resolvedFlow = flow?.trim() || paths.baseBranch
  if (!isSafeFlowName(resolvedFlow)) {
    return { error: 'Invalid flow parameter', status: 400 }
  }

  const beadsRoot = path.resolve(paths.ticketDir, 'beads')
  const filePath = path.resolve(beadsRoot, resolvedFlow, '.beads', 'issues.jsonl')
  const relativePath = path.relative(beadsRoot, filePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return { error: 'Invalid flow parameter', status: 400 }
  }

  return { filePath }
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
    return fs.readFileSync(filePath, 'utf-8')
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
  setMalformedLineHeaders(c, malformedLines, findUnrepresentableLines(items, itemLines))
  return c.json(items)
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
  const unrepresentableLines = findUnrepresentableLines(items, itemLines)
  setMalformedLineHeaders(c, malformedLines, unrepresentableLines)

  return c.json({ content, items, malformedLines, unrepresentableLines })
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

  // Validate each bead item has the fields required by the scheduler/execution engine
  const validationErrors: Array<{ index: number; issues: z.ZodIssue[] }> = []
  // What gets written: the record as sent, with the dependency spelling the
  // runtime reads. Storing the request verbatim would leave `blockedBy` in the
  // file for the authoritative reader to canonicalise on every read.
  const canonicalBeads: unknown[] = []
  for (let i = 0; i < body.length; i++) {
    const result = beadItemSchema.safeParse(body[i])
    if (!result.success) {
      validationErrors.push({ index: i, issues: result.error.issues })
      continue
    }
    canonicalBeads.push({ ...(body[i] as Record<string, unknown>), dependencies: result.data.dependencies })
  }
  if (validationErrors.length > 0) {
    return c.json({ error: 'Invalid bead item(s)', details: validationErrors }, 400)
  }

  // Check for duplicate IDs
  const ids = body.map((item: { id: string }) => item.id)
  const duplicateIds = ids.filter((id: string, index: number) => ids.indexOf(id) !== index)
  if (duplicateIds.length > 0) {
    return c.json({ error: 'Duplicate bead IDs', details: [...new Set(duplicateIds)] }, 400)
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
  } catch {
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

  try {
    // createdAt is set at approval time, not save time
    const jsonl = canonicalBeads.map((item: unknown) => JSON.stringify(item)).join('\n') + '\n'
    safeAtomicWrite(filePath, jsonl)
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
      afterItemCount: body.length,
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
  } catch {
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
