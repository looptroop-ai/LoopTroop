import type { Context } from 'hono'
import { countSkipEvents, isSkipSurface, type SkipSurface } from '@shared/skipReceipt'
import { getTicketByRef } from '../../storage/tickets'
import { listSkipEvents } from '../../workflow/skipReceipts'
import { getTicketParam } from './routeUtils'

/**
 * Every skip recorded for a ticket, with the counts already computed.
 *
 * Deliberately ticket-wide and attempt-agnostic by default. The artifact list
 * hides archived phase attempts, which is right for what a phase is working
 * from and wrong for an audit trail — a receipt from a retried attempt is still
 * a decision somebody made.
 */
export function handleGetTicketSkips(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)

  const phase = c.req.query('phase')?.trim() || undefined

  const rawSurfaces = c.req.query('surfaces')?.trim()
  let surfaces: SkipSurface[] | undefined
  if (rawSurfaces) {
    const requested = rawSurfaces.split(',').map((value) => value.trim()).filter(Boolean)
    const unknown = requested.filter((value) => !isSkipSurface(value))
    if (unknown.length > 0) {
      return c.json({ error: 'Unknown skip surface', surfaces: unknown }, 400)
    }
    surfaces = requested as SkipSurface[]
  }

  const events = listSkipEvents(ticketId, {
    ...(phase ? { phase } : {}),
    ...(surfaces ? { surfaces } : {}),
  })

  return c.json({
    ticketId,
    events,
    counts: countSkipEvents(events),
  })
}
