import { existsSync, statSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type Database from 'better-sqlite3'
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

interface ProjectionStatements {
  selectEntry: Database.Statement
  upsertEntry: Database.Statement
  selectCursor: Database.Statement
  advanceCursor: Database.Statement
  setCursor: Database.Statement
  deleteChannel: Database.Statement
  queryPages: Map<string, Database.Statement>
}

interface ProjectionStorage {
  context: NonNullable<ReturnType<typeof getTicketContext>>
  sqlite: Database.Database
  statements: ProjectionStatements
}

const initializedProjectionDatabases = new WeakSet<Database.Database>()
const projectionStatements = new WeakMap<Database.Database, ProjectionStatements>()
const projectionCatchUps = new Map<string, Promise<void>>()
const PROJECTION_READ_CHUNK_BYTES = 256 * 1024
const PROJECTION_ROWS_PER_YIELD = 250

function prepareProjectionStatements(sqlite: Database.Database): ProjectionStatements {
  const cached = projectionStatements.get(sqlite)
  if (cached) return cached
  const statements: ProjectionStatements = {
    selectEntry: sqlite.prepare(`SELECT identity, ordinal, entry_json FROM execution_log_projection WHERE ticket_id = ? AND channel = ? AND identity = ?`),
    upsertEntry: sqlite.prepare(`
      INSERT INTO execution_log_projection (
        ticket_id, channel, identity, ordinal, timestamp, phase, phase_attempt, status, classification,
        model_id, bead_id, entry_json, byte_offset, byte_length
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticket_id, channel, identity) DO UPDATE SET
        timestamp = excluded.timestamp, phase = excluded.phase, phase_attempt = excluded.phase_attempt,
        status = excluded.status, classification = excluded.classification, model_id = excluded.model_id,
        bead_id = excluded.bead_id, entry_json = excluded.entry_json, byte_offset = excluded.byte_offset,
        byte_length = excluded.byte_length
    `),
    selectCursor: sqlite.prepare(`SELECT channel, indexed_offset FROM execution_log_projection_cursors WHERE ticket_id = ? AND channel = ?`),
    advanceCursor: sqlite.prepare(`
      INSERT INTO execution_log_projection_cursors (ticket_id, channel, indexed_offset) VALUES (?, ?, ?)
      ON CONFLICT(ticket_id, channel) DO UPDATE SET indexed_offset = MAX(indexed_offset, excluded.indexed_offset)
    `),
    setCursor: sqlite.prepare(`
      INSERT INTO execution_log_projection_cursors (ticket_id, channel, indexed_offset) VALUES (?, ?, ?)
      ON CONFLICT(ticket_id, channel) DO UPDATE SET indexed_offset = excluded.indexed_offset
    `),
    deleteChannel: sqlite.prepare('DELETE FROM execution_log_projection WHERE ticket_id = ? AND channel = ?'),
    queryPages: new Map(),
  }
  projectionStatements.set(sqlite, statements)
  return statements
}

function ensureProjectionSchema(ticketId: string): ProjectionStorage | null {
  const context = getTicketContext(ticketId)
  if (!context) return null
  const sqlite = getProjectDatabase(context.projectRoot).sqlite
  if (!initializedProjectionDatabases.has(sqlite)) sqlite.exec(`
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
  initializedProjectionDatabases.add(sqlite)
  return { context, sqlite, statements: prepareProjectionStatements(sqlite) }
}

function identityFor(entry: Record<string, unknown>, offset: number): string {
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

function indexEntry(ticketId: string, channel: PersistedLogChannel, raw: unknown, offset: number, length: number, existingStorage?: ProjectionStorage) {
  const storage = existingStorage ?? ensureProjectionSchema(ticketId)
  if (!storage) return
  const entry = normalizePersistedLogEntry(raw)
  if (!entry) return
  const { context, statements } = storage
  const identity = identityFor(entry, offset)
  const existing = statements.selectEntry.get(context.localTicketId, channel, identity) as ProjectionRow | undefined
  const canonical = existing ? mergeCanonical(JSON.parse(existing.entry_json), entry) : entry
  const classification = classifyPersistedLogEntry(canonical)
  const ordinal = existing?.ordinal ?? offset
  statements.upsertEntry.run(
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
      if (storage) storage.statements.advanceCursor.run(storage.context.localTicketId, channel, offset + length)
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

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

async function readTailCooperatively(
  ticketId: string,
  channel: PersistedLogChannel,
  start: number,
  storage: ProjectionStorage,
): Promise<number> {
  const filePath = logPath(ticketId, channel)
  if (!filePath) return 0
  let size: number
  try { size = (await stat(filePath)).size } catch { return 0 }
  if (start >= size) return size

  const file = await open(filePath, 'r')
  let indexedOffset = start
  let carry = Buffer.alloc(0)
  let batch: Array<{ raw: unknown; offset: number; length: number }> = []
  const indexBatch = storage.sqlite.transaction((entries: typeof batch) => {
    for (const entry of entries) {
      indexEntry(ticketId, channel, entry.raw, entry.offset, entry.length, storage)
    }
  })
  const flushBatch = () => {
    if (batch.length === 0) return
    indexBatch(batch)
    batch = []
  }
  try {
    while (indexedOffset + carry.length < size) {
      const readOffset = indexedOffset + carry.length
      const buffer = Buffer.alloc(Math.min(PROJECTION_READ_CHUNK_BYTES, size - readOffset))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, readOffset)
      if (bytesRead === 0) break
      const combined = carry.length > 0 ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead)
      let cursor = 0
      while (cursor < combined.length) {
        const newline = combined.indexOf(0x0a, cursor)
        if (newline < 0) break
        const line = combined.subarray(cursor, newline).toString('utf8').trim()
        const length = newline - cursor + 1
        if (line) {
          try { batch.push({ raw: JSON.parse(line), offset: indexedOffset + cursor, length }) } catch { /* malformed JSONL is ignored */ }
        }
        cursor = newline + 1
        if (batch.length >= PROJECTION_ROWS_PER_YIELD) {
          flushBatch()
          await yieldToEventLoop()
        }
      }
      flushBatch()
      indexedOffset += cursor
      carry = combined.subarray(cursor)
      storage.statements.advanceCursor.run(storage.context.localTicketId, channel, indexedOffset)
      await yieldToEventLoop()
    }
    return indexedOffset
  } finally {
    await file.close()
  }
}

/** Catch up just the unindexed JSONL suffix; a truncated/replaced file rebuilds its channel. */
async function performLogProjectionCatchUp(ticketId: string) {
  const storage = ensureProjectionSchema(ticketId)
  if (!storage) return
  const { context, statements } = storage
  for (const channel of ['normal', 'debug', 'ai'] as const) {
    const row = statements.selectCursor.get(context.localTicketId, channel) as ProjectionCursor | undefined
    const path = logPath(ticketId, channel)
    const size = path && existsSync(path) ? statSync(path).size : 0
    const start = row?.indexed_offset ?? 0
    if (start > size) {
      statements.deleteChannel.run(context.localTicketId, channel)
      statements.setCursor.run(context.localTicketId, channel, 0)
    }
    const indexedOffset = await readTailCooperatively(ticketId, channel, start > size ? 0 : start, storage)
    statements.advanceCursor.run(context.localTicketId, channel, indexedOffset)
  }
}

/** Catch up an unindexed JSONL suffix once per ticket without blocking unrelated routes. */
export function catchUpLogProjection(ticketId: string): Promise<void> {
  const pending = projectionCatchUps.get(ticketId)
  if (pending) return pending
  const catchUp = performLogProjectionCatchUp(ticketId).finally(() => {
    if (projectionCatchUps.get(ticketId) === catchUp) projectionCatchUps.delete(ticketId)
  })
  projectionCatchUps.set(ticketId, catchUp)
  return catchUp
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

export async function queryLogPage(ticketId: string, query: LogPageQuery) {
  await catchUpLogProjection(ticketId)
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
  const sql = `SELECT ordinal, entry_json FROM execution_log_projection WHERE ${where} ORDER BY ordinal DESC LIMIT ?`
  let statement = storage.statements.queryPages.get(sql)
  if (!statement) {
    statement = sqlite.prepare(sql)
    storage.statements.queryPages.set(sql, statement)
  }
  const rows = statement.all(...params, query.limit + 1) as Array<{ ordinal: number; entry_json: string }>
  const hasOlder = rows.length > query.limit
  const page = rows.slice(0, query.limit)
  const oldest = page.at(-1)
  return {
    entries: page.reverse().map(row => JSON.parse(row.entry_json)),
    olderCursor: hasOlder && oldest ? Buffer.from(JSON.stringify({ ordinal: oldest.ordinal })).toString('base64url') : null,
    hasOlder,
  }
}

export async function exportLogEntries(ticketId: string, query: Omit<LogPageQuery, 'before' | 'limit'>) {
  const page = await queryLogPage(ticketId, { ...query, limit: Number.MAX_SAFE_INTEGER })
  return page?.entries ?? null
}
