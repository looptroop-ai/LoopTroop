import type { Context } from 'hono'
import {
  createTicketActor,
  stopActor,
} from '../../machines/persistence'
import { abortTicketSessions } from '../../opencode/sessionManager'
import { clearContextCache } from '../../opencode/contextBuilder'
import { broadcaster } from '../../sse/broadcaster'
import { cancelTicket } from '../../workflow/runner'
import { getProjectContextById } from '../../storage/projects'
import {
  createTicket as createTicketRecord,
  deleteTicket as deleteStoredTicket,
  getTicketByRef,
  listTickets,
  updateTicket,
} from '../../storage/tickets'
import { getErrorMessage } from '@shared/typeGuards'
import { isTerminalWorkflowStatus } from '@shared/workflowMeta'
import {
  emitRoutePhaseLog,
  getProfileDefaults,
  getRequiredRouteParam,
  getTicketParam,
  logTicketOperationError,
} from './routeUtils'
import { createTicketSchema, updateTicketSchema } from './schemas'
import { resolveStoredWorkflowPhase } from '@shared/workflowMeta'

export function handleListTickets(c: Context) {
  const projectId = c.req.query('project') ?? c.req.query('projectId')
  const parsedProjectId = projectId ? Number(projectId) : undefined
  if (projectId && Number.isNaN(parsedProjectId)) {
    return c.json({ error: 'Invalid project ID' }, 400)
  }
  return c.json(listTickets(parsedProjectId))
}

export async function handleGetTicket(c: Context) {
  const ticketId = getRequiredRouteParam(c, 'id')
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  return c.json(ticket)
}

export async function handleCreateTicket(c: Context) {
  const body = await c.req.json()
  const parsed = createTicketSchema.safeParse(body)
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors
    const message = Object.entries(fieldErrors)
      .map(([field, errors]) => `${field}: ${(errors as string[]).join(', ')}`)
      .join('; ')
    return c.json({ error: 'Invalid input', details: parsed.error.flatten(), message }, 400)
  }

  let result: ReturnType<typeof createTicketRecord>
  try {
    result = createTicketRecord(parsed.data)
  } catch (err) {
    if (err instanceof Error && err.message === 'Project not found') {
      return c.json({ error: 'Project not found' }, 404)
    }
    if (err instanceof Error && err.message.startsWith('Invalid createTicket input:')) {
      return c.json({ error: 'Invalid input', message: err.message }, 400)
    }
    return c.json({ error: 'Failed to create ticket', details: getErrorMessage(err) }, 500)
  }

  const projectContext = getProjectContextById(result.projectId)
  const profile = getProfileDefaults()
  createTicketActor(result.id, {
    ticketId: result.id,
    projectId: result.projectId,
    externalId: result.externalId,
    title: result.title,
    maxIterations: projectContext?.project.maxIterations ?? profile?.maxIterations ?? undefined,
  })

  return c.json(getTicketByRef(result.id) ?? result, 201)
}

export async function handlePatchTicket(c: Context) {
  const ticketId = getTicketParam(c)
  const body = await c.req.json()

  if ('status' in body) {
    return c.json({ error: 'Status field is API-protected. Use workflow actions to change status.' }, 403)
  }

  const parsed = updateTicketSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.flatten() }, 400)
  }

  const existing = getTicketByRef(ticketId)
  if (!existing) return c.json({ error: 'Ticket not found' }, 404)

  try {
    const result = updateTicket(ticketId, parsed.data)
    return c.json(result ?? existing)
  } catch (err) {
    if (err instanceof Error && err.message.includes('only be changed while the ticket is in DRAFT')) {
      return c.json({ error: err.message }, 409)
    }
    throw err
  }
}

export async function handleDeleteTicket(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  if (!isTerminalWorkflowStatus(ticket.status)) {
    return c.json({ error: 'Only completed or canceled tickets can be deleted' }, 409)
  }

  try {
    cancelTicket(ticketId)
    stopActor(ticketId)
    await abortTicketSessions(ticketId)
    clearContextCache(ticketId)

    emitRoutePhaseLog(ticketId, resolveStoredWorkflowPhase(ticket.status), 'info', `Deleting ticket ${ticket.externalId}: removing worktree, branch, and database records.`)
    const deleted = deleteStoredTicket(ticketId)
    if (!deleted) return c.json({ error: 'Ticket not found' }, 404)

    broadcaster.clearTicket(ticketId)
    return c.json({ success: true, ticketId })
  } catch (err) {
    logTicketOperationError(ticketId, 'Failed to delete ticket', err)
    return c.json({ error: 'Failed to delete ticket', details: getErrorMessage(err) }, 500)
  }
}
