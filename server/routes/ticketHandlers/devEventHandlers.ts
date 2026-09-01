import type { Context } from 'hono'
import { getTicketState, sendTicketEvent } from '../../machines/persistence'
import { getTicketByRef } from '../../storage/tickets'
import { getTicketParam, logTicketOperationError } from './routeUtils'
import { devEventSchema } from './schemas'
import { getErrorMessage } from '@shared/typeGuards'

export async function handleDevEvent(c: Context) {
  const enabled = process.env.LOOPTROOP_ENABLE_DEV_EVENT === '1'
  const expectedToken = process.env.LOOPTROOP_DEV_EVENT_TOKEN?.trim()
  if (!enabled || !expectedToken) {
    return c.json({ error: 'Not found' }, 404)
  }

  const suppliedToken = c.req.header('x-looptroop-dev-event-token')?.trim()
  if (suppliedToken !== expectedToken) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const ticketId = getTicketParam(c)
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)

  try {
    const body = await c.req.json()
    const parsed = devEventSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Invalid dev event payload', details: parsed.error.flatten() }, 400)
    }
    sendTicketEvent(ticketId, parsed.data)
  } catch (err) {
    logTicketOperationError(ticketId, 'dev-event failed for ticket', err)
    return c.json({ error: getErrorMessage(err) }, 500)
  }

  const updated = getTicketByRef(ticketId)
  const state = getTicketState(ticketId)
  return c.json({ ticketId, status: updated?.status, state: state?.state })
}
