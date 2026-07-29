import { Hono } from 'hono'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { getTicketByRef, getTicketPaths, getLatestPhaseArtifact, isDisplayOnlyMockTicket } from '../storage/tickets'
import { safeAtomicWrite } from '../io/atomicWrite'
import { syncTicketRuntimeProjection } from '../storage/ticketRuntimeProjection'
import { clearExecutionSetupState } from '../phases/executionSetup/storage'
import { upsertBeadsApprovalSnapshot } from '../phases/beads/document'
import { contentSha256 } from '../lib/contentHash'
import { writeUserEditReceipt } from '../workflow/artifactEditReceipts'

// Minimum schema for fields required by the scheduler and execution engine.
// Other fields pass through without strict validation for forward-compatibility.
const beadItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'done', 'error']),
  priority: z.number().int().min(1),
  dependencies: z.object({
    blocked_by: z.array(z.string()),
    blocks: z.array(z.string()),
  }),
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

  if (!fs.existsSync(filePath)) {
    c.header('X-Content-Sha256', contentSha256(''))
    return c.json([])
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  c.header('X-Content-Sha256', contentSha256(content))
  const lines = content.split('\n').filter((line) => line.trim() !== '')
  try {
    const beads = lines.map((line) => JSON.parse(line))
    return c.json(beads)
  } catch {
    return c.json({ error: 'Corrupted JSONL data' }, 500)
  }
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
  for (let i = 0; i < body.length; i++) {
    const result = beadItemSchema.safeParse(body[i])
    if (!result.success) {
      validationErrors.push({ index: i, issues: result.error.issues })
    }
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

  try {
    const beforeRaw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null
    // createdAt is set at approval time, not save time
    const jsonl = body.map((item: unknown) => JSON.stringify(item)).join('\n') + '\n'
    safeAtomicWrite(filePath, jsonl)
    upsertBeadsApprovalSnapshot(ticketId, jsonl)
    const executionSetupInvalidation = clearExecutionSetupState(ticketId)
    writeUserEditReceipt({
      ticketId,
      artifactType: 'beads',
      phase: 'WAITING_BEADS_APPROVAL',
      action: 'save',
      editSurface: 'structured',
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
