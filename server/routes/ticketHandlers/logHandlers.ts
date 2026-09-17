import type { Context } from 'hono'
import { getTicketParam } from './routeUtils'
import {
  exportLogEntries,
  HISTORICAL_LOG_CURSOR_EXPIRED_CODE,
  isHistoricalLogCursorExpiredError,
  isValidLogCursor,
  queryLogPage,
} from '../../log/projection'
import type { LogView } from '../../log/view'
import { getTicketByRef } from '../../storage/tickets'

const LOG_VIEWS = new Set<LogView>(['overview', 'system', 'command', 'ai', 'error', 'debug'])

function parseQuery(c: Context, allowCursor: boolean) {
  const scope = c.req.query('scope') ?? 'phase'
  if (scope !== 'phase' && scope !== 'lifecycle') return { error: 'Invalid scope parameter' } as const
  const view = c.req.query('view') ?? 'overview'
  if (!LOG_VIEWS.has(view as LogView)) return { error: 'Invalid view parameter' } as const
  const rawAttempt = c.req.query('phaseAttempt')
  const phaseAttempt = rawAttempt === undefined ? undefined : Number(rawAttempt)
  if (phaseAttempt !== undefined && (!Number.isInteger(phaseAttempt) || phaseAttempt < 1)) {
    return { error: 'Invalid phaseAttempt parameter: must be a positive integer' } as const
  }
  const rawLimit = c.req.query('limit')
  const limit = rawLimit === undefined ? 20 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return { error: 'Invalid limit parameter: must be an integer from 1 to 500' } as const
  const before = allowCursor ? c.req.query('before') : undefined
  if (allowCursor && !isValidLogCursor(before)) return { error: 'Invalid before cursor' } as const
  return {
    scope,
    view: view as LogView,
    phase: c.req.query('phase'),
    phaseAttempt,
    modelId: c.req.query('modelId'),
    beadId: c.req.query('beadId'),
    before,
    limit,
  } as const
}

export async function handleGetTicketLogs(c: Context) {
  const ticketId = getTicketParam(c)
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)
  const query = parseQuery(c, true)
  if ('error' in query) return c.json({ error: query.error }, 400)
  let page
  try {
    page = await queryLogPage(ticketId, query)
  } catch (error) {
    if (isHistoricalLogCursorExpiredError(error)) {
      return c.json({
        error: HISTORICAL_LOG_CURSOR_EXPIRED_CODE,
        code: HISTORICAL_LOG_CURSOR_EXPIRED_CODE,
        message: 'The log history changed while it was loading. Retry to start a fresh history walk.',
      }, 409)
    }
    throw error
  }
  if (!page) return c.json({ error: 'Ticket not found' }, 404)
  return c.json({ ...page, boundary: { phase: query.phase ?? null, phaseAttempt: query.phaseAttempt ?? null } })
}

export async function handleExportTicketLogs(c: Context) {
  const ticketId = getTicketParam(c)
  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)
  const query = parseQuery(c, false)
  if ('error' in query) return c.json({ error: query.error }, 400)
  let entries
  try {
    entries = await exportLogEntries(ticketId, query)
  } catch (error) {
    if (isHistoricalLogCursorExpiredError(error)) {
      return c.json({
        error: HISTORICAL_LOG_CURSOR_EXPIRED_CODE,
        code: HISTORICAL_LOG_CURSOR_EXPIRED_CODE,
        message: 'The log history changed while it was exporting. Retry to start a fresh export.',
      }, 409)
    }
    throw error
  }
  if (!entries) return c.json({ error: 'Ticket not found' }, 404)
  const text = entries.map((entry) => {
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : ''
    const content = typeof entry.content === 'string'
      ? entry.content
      : typeof entry.message === 'string' ? entry.message : ''
    return timestamp ? `[${timestamp}] ${content}` : content
  }).join('\n')
  return c.text(text, 200, { 'Content-Type': 'text/plain; charset=utf-8' })
}
