import { existsSync, openSync, closeSync, readSync, statSync } from 'node:fs'
import { getProjectDatabase } from '../db/project'
import { getTicketContext, getTicketPaths } from '../storage/tickets'
import { extractLogFingerprint } from '@shared/logIdentity'
import { normalizePersistedLogEntry, classifyPersistedLogEntry, type LogView } from './view'

export type PersistedLogChannel = 'normal' | 'debug' | 'ai'

interface ProjectionRow {
  identity: string
  ordinal: number
  entry_json: string
}

interface ProjectionCursor {
  channel: PersistedLogChannel
  indexed_offset: number
}

function ensureProjectionSchema(ticketId: string) {
  const context = getTicketContext(ticketId)
  if (!context) return null
  const sqlite = getProjectDatabase(context.projectRoot).sqlite
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS execution_log_projection (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      identity TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      phase TEXT NOT NULL,
      phase_attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      classification TEXT NOT NULL,
      model_id TEXT,
      bead_id TEXT,
      entry_json TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      PRIMARY KEY (ticket_id, channel, identity)
    );
    CREATE TABLE IF NOT EXISTS execution_log_projection_cursors (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      indexed_offset INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ticket_id, channel)
    );
    CREATE INDEX IF NOT EXISTS idx_execution_log_projection_query
      ON execution_log_projection(ticket_id, classification, phase, phase_attempt, model_id, ordinal DESC);
  `)
  return { context, sqlite }
}

function identityFor(channel: PersistedLogChannel, entry: Record<string, unknown>, offset: number): string {
  const entryId = typeof entry.entryId === 'string' && entry.entryId.trim()
  if (entryId && entry.op !== 'append') return `entry:${entryId}`
  const fingerprint = extractLogFingerprint(entry)
  if (fingerprint && entry.op === 'append') return `fingerprint:${entry.phase}:${entry.phaseAttempt}:${fingerprint}`
  return `offset:${offset}`
}

function mergeCanonical(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  return {
    ...previous,
    ...next,
    timestamp: typeof previous.timestamp === 'string' ? previous.timestamp : next.timestamp,
  }
}

function indexEntry(ticketId: string, channel: PersistedLogChannel, raw: unknown, offset: number, length: number) {
  const storage = ensureProjectionSchema(ticketId)
  if (!storage) return
  const entry = normalizePersistedLogEntry(raw)
  if (!entry) return
  const { context, sqlite } = storage
  const identity = identityFor(channel, entry, offset)
  const existing = sqlite.prepare(`SELECT identity, ordinal, entry_json FROM execution_log_projection WHERE ticket_id = ? AND channel = ? AND identity = ?`)
    .get(context.localTicketId, channel, identity) as ProjectionRow | undefined
  const canonical = existing ? mergeCanonical(JSON.parse(existing.entry_json), entry) : entry
  const classification = classifyPersistedLogEntry(canonical)
  const ordinal = existing?.ordinal ?? offset
  sqlite.prepare(`
    INSERT INTO execution_log_projection (
      ticket_id, channel, identity, ordinal, timestamp, phase, phase_attempt, status, classification,
      model_id, bead_id, entry_json, byte_offset, byte_length
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticket_id, channel, identity) DO UPDATE SET
      timestamp = excluded.timestamp, phase = excluded.phase, phase_attempt = excluded.phase_attempt,
      status = excluded.status, classification = excluded.classification, model_id = excluded.model_id,
      bead_id = excluded.bead_id, entry_json = excluded.entry_json, byte_offset = excluded.byte_offset,
      byte_length = excluded.byte_length
  `).run(
    context.localTicketId, channel, identity, ordinal, String(canonical.timestamp ?? ''), String(canonical.phase ?? 'unknown'),
    Number(canonical.phaseAttempt ?? 1), String(canonical.status ?? canonical.phase ?? 'unknown'), classification,
    typeof canonical.modelId === 'string' ? canonical.modelId : null,
    typeof canonical.beadId === 'string' ? canonical.beadId : null,
    JSON.stringify(canonical), offset, length,
  )
}

/** Index an append after disk persistence. This is deliberately best-effort: reads catch up any queued tail. */
export function queueProjectionAppend(ticketId: string, channel: PersistedLogChannel, raw: unknown, offset: number, length: number) {
  queueMicrotask(() => {
    try {
      indexEntry(ticketId, channel, raw, offset, length)
      const storage = ensureProjectionSchema(ticketId)
      if (storage) storage.sqlite.prepare(`
        INSERT INTO execution_log_projection_cursors (ticket_id, channel, indexed_offset) VALUES (?, ?, ?)
        ON CONFLICT(ticket_id, channel) DO UPDATE SET indexed_offset = MAX(indexed_offset, excluded.indexed_offset)
      `).run(storage.context.localTicketId, channel, offset + length)
    } catch (error) {
      console.warn(`[logs] projection append deferred for ${ticketId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

function logPath(ticketId: string, channel: PersistedLogChannel): string | null {
  const paths = getTicketPaths(ticketId)
  if (!paths) return null
  return channel === 'debug' ? paths.debugLogPath : channel === 'ai' ? paths.aiLogPath : paths.executionLogPath
}

function readTail(ticketId: string, channel: PersistedLogChannel, start: number) {
  const filePath = logPath(ticketId, channel)
  if (!filePath || !existsSync(filePath)) return 0
  const size = statSync(filePath).size
  if (start >= size) return size
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    let cursor = 0
    while (cursor < buffer.length) {
      const newline = buffer.indexOf(0x0a, cursor)
      if (newline < 0) break // incomplete final line is indexed after it becomes durable
      const line = buffer.subarray(cursor, newline).toString('utf8').trim()
      const length = newline - cursor + 1
      if (line) {
        try { indexEntry(ticketId, channel, JSON.parse(line), start + cursor, length) } catch { /* malformed JSONL is ignored */ }
      }
      cursor = newline + 1
    }
    return start + cursor
  } finally { closeSync(fd) }
}

/** Catch up just the unindexed JSONL suffix; a truncated/replaced file rebuilds its channel. */
export function catchUpLogProjection(ticketId: string) {
  const storage = ensureProjectionSchema(ticketId)
  if (!storage) return
  const { context, sqlite } = storage
  for (const channel of ['normal', 'debug', 'ai'] as const) {
    const row = sqlite.prepare(`SELECT channel, indexed_offset FROM execution_log_projection_cursors WHERE ticket_id = ? AND channel = ?`)
      .get(context.localTicketId, channel) as ProjectionCursor | undefined
    const path = logPath(ticketId, channel)
    const size = path && existsSync(path) ? statSync(path).size : 0
    const start = row?.indexed_offset ?? 0
    if (start > size) {
      sqlite.prepare('DELETE FROM execution_log_projection WHERE ticket_id = ? AND channel = ?').run(context.localTicketId, channel)
    }
    const indexedOffset = readTail(ticketId, channel, start > size ? 0 : start)
    sqlite.prepare(`INSERT INTO execution_log_projection_cursors (ticket_id, channel, indexed_offset) VALUES (?, ?, ?)
      ON CONFLICT(ticket_id, channel) DO UPDATE SET indexed_offset = excluded.indexed_offset`)
      .run(context.localTicketId, channel, indexedOffset)
  }
}

export interface LogPageQuery {
  phase?: string
  phaseAttempt?: number
  scope: 'phase' | 'lifecycle'
  view: LogView
  modelId?: string
  before?: string
  limit: number
}

function decodeCursor(cursor?: string): number | null {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { ordinal?: unknown }
    return typeof value.ordinal === 'number' && Number.isFinite(value.ordinal) ? value.ordinal : null
  } catch { return null }
}

export function isValidLogCursor(cursor?: string): boolean {
  return !cursor || decodeCursor(cursor) !== null
}

export function queryLogPage(ticketId: string, query: LogPageQuery) {
  catchUpLogProjection(ticketId)
  const storage = ensureProjectionSchema(ticketId)
  if (!storage) return null
  const { context, sqlite } = storage
  const before = decodeCursor(query.before)
  const clauses = ['ticket_id = ?']
  const params: unknown[] = [context.localTicketId]
  if (query.scope === 'phase' && query.phase) { clauses.push('phase = ?'); params.push(query.phase) }
  if (typeof query.phaseAttempt === 'number') { clauses.push('phase_attempt = ?'); params.push(query.phaseAttempt) }
  if (query.view === 'debug') { clauses.push("channel = 'debug'") }
  else if (query.view === 'ai') { clauses.push("channel = 'ai'") }
  else { clauses.push("channel = 'normal'") }
  if (query.view !== 'overview') { clauses.push('classification = ?'); params.push(query.view) }
  if (query.modelId) { clauses.push('model_id = ?'); params.push(query.modelId) }
  if (before !== null) { clauses.push('ordinal < ?'); params.push(before) }
  const where = clauses.join(' AND ')
  const rows = sqlite.prepare(`SELECT ordinal, entry_json FROM execution_log_projection WHERE ${where} ORDER BY ordinal DESC LIMIT ?`)
    .all(...params, query.limit + 1) as Array<{ ordinal: number; entry_json: string }>
  const hasOlder = rows.length > query.limit
  const page = rows.slice(0, query.limit)
  const oldest = page.at(-1)
  return {
    entries: page.reverse().map(row => JSON.parse(row.entry_json)),
    olderCursor: hasOlder && oldest ? Buffer.from(JSON.stringify({ ordinal: oldest.ordinal })).toString('base64url') : null,
    hasOlder,
  }
}

export function exportLogEntries(ticketId: string, query: Omit<LogPageQuery, 'before' | 'limit'>) {
  const page = queryLogPage(ticketId, { ...query, limit: Number.MAX_SAFE_INTEGER })
  return page?.entries ?? null
}
