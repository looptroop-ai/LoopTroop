import type { Context } from 'hono'
import { and, desc, eq, lte } from 'drizzle-orm'
import { z } from 'zod'
import { getTicketParam } from './routeUtils'
import {
  exportLogEntries,
  HISTORICAL_LOG_CURSOR_EXPIRED_CODE,
  isHistoricalLogCursorExpiredError,
  isValidLogCursor,
  queryLogPage,
} from '../../log/projection'
import type { LogView } from '../../log/view'
import { getTicketByRef, getTicketContext, type PublicTicket } from '../../storage/tickets'
import { ticketStatusHistory } from '../../db/schema'
import { sanitizeDiagnosticText, sanitizeDiagnosticValue } from '@shared/errorDiagnostics'

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
  const errorOccurrenceId = c.req.query('errorOccurrenceId')
  if (errorOccurrenceId !== undefined && (!/^\d+$/.test(errorOccurrenceId) || !Number.isSafeInteger(Number(errorOccurrenceId)) || Number(errorOccurrenceId) < 1)) {
    return { error: 'Invalid errorOccurrenceId parameter: must be a positive integer' } as const
  }
  const rawStartedAt = c.req.query('startedAt')
  const rawEndedAt = c.req.query('endedAt')
  for (const [name, value] of [['startedAt', rawStartedAt], ['endedAt', rawEndedAt]]) {
    if (value !== undefined && !z.iso.datetime({ offset: true }).safeParse(value).success) {
      return { error: `Invalid ${name} parameter: must be an ISO timestamp` } as const
    }
  }
  const startedAt = rawStartedAt === undefined ? undefined : new Date(rawStartedAt).toISOString()
  const endedAt = rawEndedAt === undefined ? undefined : new Date(rawEndedAt).toISOString()
  if (startedAt && endedAt && startedAt > endedAt) {
    return { error: 'Invalid failure window: startedAt must not be after endedAt' } as const
  }
  return {
    scope,
    view: view as LogView,
    phase: c.req.query('phase'),
    phaseAttempt,
    modelId: c.req.query('modelId'),
    beadId: c.req.query('beadId'),
    before,
    limit,
    errorOccurrenceId,
    startedAt,
    endedAt,
  } as const
}

function resolveErrorOccurrenceQuery(ticketId: string, ticket: PublicTicket, query: Exclude<ReturnType<typeof parseQuery>, { error: string }>) {
  if (query.errorOccurrenceId === undefined) return query
  const occurrence = ticket.errorOccurrences.find(candidate => candidate.id === Number(query.errorOccurrenceId))
  if (!occurrence) return null
  const context = getTicketContext(ticketId)
  if (!context) throw new Error('Could not load the ticket context for error occurrence logs')
  const phaseEntry = context.projectDb.select({ changedAt: ticketStatusHistory.changedAt })
    .from(ticketStatusHistory)
    .where(and(
      eq(ticketStatusHistory.ticketId, context.localTicketId),
      eq(ticketStatusHistory.newStatus, occurrence.blockedFromStatus),
      lte(ticketStatusHistory.changedAt, occurrence.occurredAt),
    ))
    .orderBy(desc(ticketStatusHistory.id))
    .get()
  const previousOccurrence = ticket.errorOccurrences
    .filter(candidate => candidate.occurrenceNumber < occurrence.occurrenceNumber)
    .sort((left, right) => right.occurrenceNumber - left.occurrenceNumber)[0]
  const startedAt = [phaseEntry?.changedAt, previousOccurrence?.resolvedAt ?? previousOccurrence?.occurredAt]
    .filter((time): time is string => Boolean(time))
    .sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1) ?? ticket.createdAt
  return {
    ...query,
    scope: 'phase' as const,
    phase: occurrence.blockedFromStatus,
    phaseAttempt: undefined,
    modelId: undefined,
    beadId: undefined,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(occurrence.occurredAt).toISOString(),
  }
}

export async function handleGetTicketLogs(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const parsedQuery = parseQuery(c, true)
  if ('error' in parsedQuery) return c.json({ error: parsedQuery.error }, 400)
  const query = resolveErrorOccurrenceQuery(ticketId, ticket, parsedQuery)
  if (!query) return c.json({ error: 'Error occurrence not found' }, 404)
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
  return c.json({
    ...page,
    entries: query.startedAt || query.endedAt ? page.entries.map(entry => sanitizeDiagnosticValue(entry)) : page.entries,
    boundary: {
      phase: query.phase ?? null,
      phaseAttempt: query.phaseAttempt ?? null,
      ...(query.startedAt || query.endedAt ? {
        ...(query.errorOccurrenceId === undefined ? {} : { errorOccurrenceId: query.errorOccurrenceId }),
        startedAt: query.startedAt,
        endedAt: query.endedAt,
      } : {}),
    },
  })
}

export async function handleExportTicketLogs(c: Context) {
  const ticketId = getTicketParam(c)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const parsedQuery = parseQuery(c, false)
  if ('error' in parsedQuery) return c.json({ error: parsedQuery.error }, 400)
  const query = resolveErrorOccurrenceQuery(ticketId, ticket, parsedQuery)
  if (!query) return c.json({ error: 'Error occurrence not found' }, 404)
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
    const line = timestamp ? `[${timestamp}] ${content}` : content
    return query.startedAt || query.endedAt ? sanitizeDiagnosticText(line) : line
  }).join('\n')
  return c.text(text, 200, { 'Content-Type': 'text/plain; charset=utf-8' })
}
