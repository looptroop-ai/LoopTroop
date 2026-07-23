import type { Context } from 'hono'
import { getTicketParam } from './routeUtils'
import { getAiDetails } from '../../storage/aiTurnMetrics'
import { getTicketByRef, resolvePhaseAttempt } from '../../storage/tickets'

export function handleGetAiDetails(c: Context) {
  const ticketId = getTicketParam(c)
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)

  const scope = c.req.query('scope') ?? 'phase'
  if (scope !== 'phase' && scope !== 'lifecycle') {
    return c.json({ error: 'Invalid scope parameter' }, 400)
  }

  const phase = c.req.query('phase')?.trim()
  if (scope === 'phase' && !phase) {
    return c.json({ error: 'phase is required for phase scope' }, 400)
  }

  const rawPhaseAttempt = c.req.query('phaseAttempt')
  const requestedPhaseAttempt = rawPhaseAttempt === undefined
    ? undefined
    : Number(rawPhaseAttempt)
  if (
    requestedPhaseAttempt !== undefined
    && (!Number.isInteger(requestedPhaseAttempt) || requestedPhaseAttempt < 1)
  ) {
    return c.json({ error: 'Invalid phaseAttempt parameter: must be a positive integer' }, 400)
  }

  const modelId = c.req.query('modelId')?.trim() || undefined
  const phaseAttempt = scope === 'phase'
    ? resolvePhaseAttempt(ticketId, phase!, requestedPhaseAttempt)
    : undefined
  const details = getAiDetails(ticketId, {
    scope,
    ...(phase ? { phase } : {}),
    ...(phaseAttempt !== undefined ? { phaseAttempt } : {}),
    ...(modelId ? { modelId } : {}),
  })
  if (!details) return c.json({ error: 'Ticket not found' }, 404)
  return c.json(details)
}
