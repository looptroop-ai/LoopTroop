import { existsSync, statSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import type { Database, Statement } from '../db/sqliteShim'
import { getProjectDatabase } from '../db/project'
import { getTicketContext, getTicketPaths } from '../storage/tickets'
import { extractLogFingerprint } from '@shared/logIdentity'
import { getLogModelId, isAiLogEntry } from '@shared/logClassification'
import { normalizePersistedLogEntry, classifyPersistedLogEntry, type LogView } from './view'
import { getErrorMessage } from '@shared/typeGuards'

export type PersistedLogChannel = 'normal' | 'debug' | 'ai'

interface ProjectionRow {
  identity: string
  ordinal: number
  entry_json: string
  mirror_occurrence: number
}

interface ProjectionCursor {
  channel: PersistedLogChannel
  indexed_offset: number
}

interface ProjectionStatements {
  selectEntry: Statement
  countMirrors: Statement
  upsertEntry: Statement
  selectCursor: Statement
  advanceCursor: Statement
  setCursor: Statement
  deleteChannel: Statement
  queryPages: Map<string, Statement>
}

interface ProjectionStorage {
  context: NonNullable<ReturnType<typeof getTicketContext>>
  sqlite: Database
  statements: ProjectionStatements
}

const initializedProjectionDatabases = new WeakSet<Database>()
const projectionStatements = new WeakMap<Database, ProjectionStatements>()
const projectionCatchUps = new Map<string, Promise<void>>()
const PROJECTION_READ_CHUNK_BYTES = 256 * 1024
const PROJECTION_ROWS_PER_YIELD = 250

function prepareProjectionStatements(sqlite: Database): ProjectionStatements {
  const cached = projectionStatements.get(sqlite)
  if (cached) return cached
  const statements: ProjectionStatements = {
    selectEntry: sqlite.prepare(`SELECT identity, ordinal, entry_json, mirror_occurrence FROM execution_log_projection WHERE ticket_id = ? AND channel = ? AND identity = ?`),
    countMirrors: sqlite.prepare(`SELECT COUNT(*) AS count FROM execution_log_projection WHERE ticket_id = ? AND channel = ? AND mirror_key = ?`),
    upsertEntry: sqlite.prepare(`
      INSERT INTO execution_log_projection (
        ticket_id, channel, identity, ordinal, timestamp, phase, phase_attempt, status, classification,
        model_id, bead_id, entry_json, byte_offset, byte_length,
        ai_visible, mirror_key, mirror_occurrence, updated_timestamp, text_lines
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticket_id, channel, identity) DO UPDATE SET
        timestamp = excluded.timestamp, phase = excluded.phase, phase_attempt = excluded.phase_attempt,
        status = excluded.status, classification = excluded.classification, model_id = excluded.model_id,
        bead_id = excluded.bead_id, entry_json = excluded.entry_json, byte_offset = excluded.byte_offset,
        byte_length = excluded.byte_length, ai_visible = excluded.ai_visible,
        updated_timestamp = excluded.updated_timestamp, text_lines = excluded.text_lines
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
      ai_visible INTEGER NOT NULL,
      mirror_key TEXT NOT NULL,
      mirror_occurrence INTEGER NOT NULL,
      updated_timestamp TEXT NOT NULL,
      text_lines INTEGER NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_execution_log_projection_bead
      ON execution_log_projection(ticket_id, channel, phase, phase_attempt, bead_id, ordinal DESC);
    CREATE INDEX IF NOT EXISTS idx_execution_log_projection_ai
      ON execution_log_projection(ticket_id, ai_visible, model_id, phase, phase_attempt, bead_id);
    CREATE INDEX IF NOT EXISTS idx_execution_log_projection_mirror
      ON execution_log_projection(ticket_id, mirror_key, mirror_occurrence, channel, updated_timestamp, timestamp);
  `)
  initializedProjectionDatabases.add(sqlite)
  return { context, sqlite, statements: prepareProjectionStatements(sqlite) }
}

function identityFor(entry: Record<string, unknown>, offset: number): string {
  const entryId = typeof entry.entryId === 'string' && entry.entryId.trim()
  if (entryId && entry.op !== 'append') return `entry:${entry.phase}:${entry.phaseAttempt}:${entryId}`
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

function sortableTimestamp(value: unknown): string {
  const time = Date.parse(String(value ?? ''))
  return Number.isFinite(time) ? new Date(time).toISOString() : ''
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
  const aiVisible = isAiLogEntry(canonical)
  const mirrorKey = aiVisible && identity.startsWith('offset:')
    ? `record:${createHash('sha256').update(JSON.stringify(entry)).digest('hex')}`
    : identity
  // Anonymous identical appends remain separate events. Pair the nth copy in
  // each file so a failed second append does not hide an unmatched AI record.
  const occurrence = existing?.mirror_occurrence
    ?? (mirrorKey.startsWith('record:')
      ? (statements.countMirrors.get(context.localTicketId, channel, mirrorKey) as { count: number }).count
      : 0)
  const content = String(canonical.content ?? canonical.message ?? '')
  statements.upsertEntry.run(
    context.localTicketId, channel, identity, ordinal, sortableTimestamp(canonical.timestamp), String(canonical.phase ?? 'unknown'),
    Number(canonical.phaseAttempt ?? 1), String(canonical.status ?? canonical.phase ?? 'unknown'), classification,
    getLogModelId(canonical),
    typeof canonical.beadId === 'string' ? canonical.beadId : null,
    JSON.stringify(canonical), offset, length, Number(aiVisible), mirrorKey, occurrence,
    sortableTimestamp(entry.timestamp), content ? content.split('\n').length : 0,
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
      console.warn(`[logs] projection append deferred for ${ticketId}: ${getErrorMessage(error)}`)
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
  beadId?: string
  before?: string
  limit: number
  includeTotals?: boolean
}

interface LogCursor {
  ordinal: number
  timestamp: string
  mirrorKey: string
  mirrorOccurrence: number
}

function decodeCursor(cursor?: string): LogCursor | null {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<LogCursor>
    return typeof value.ordinal === 'number' && Number.isSafeInteger(value.ordinal) && value.ordinal >= 0
      && typeof value.timestamp === 'string' && typeof value.mirrorKey === 'string'
      && typeof value.mirrorOccurrence === 'number' && Number.isSafeInteger(value.mirrorOccurrence) && value.mirrorOccurrence >= 0
      ? value as LogCursor : null
  } catch { return null }
}

export function isValidLogCursor(cursor?: string): boolean {
  return !cursor || decodeCursor(cursor) !== null
}

// The two disk appends are independent. Keep the latest surviving canonical
// revision from either file, with AI winning a timestamp tie, and pair mirrors
// before counting or paginating. The lookup uses the mirror index, not JSON.
const AI_VISIBLE_ROWS = `ai_visible = 1 AND channel IN ('normal', 'ai') AND NOT EXISTS (
  SELECT 1 FROM execution_log_projection AS mirror
  WHERE mirror.ticket_id = p.ticket_id AND mirror.mirror_key = p.mirror_key
    AND mirror.mirror_occurrence = p.mirror_occurrence
    AND mirror.channel IN ('normal', 'ai') AND mirror.channel != p.channel
    AND (mirror.updated_timestamp > p.updated_timestamp
      OR (mirror.updated_timestamp = p.updated_timestamp AND mirror.channel = 'ai'))
)`

// A finalization can survive in only one file. Its first appearance in either
// file anchors the row, even when a later page sees a different winning mirror.
const AI_START_TIMESTAMP = `(SELECT MIN(origin.timestamp) FROM execution_log_projection AS origin
  WHERE origin.ticket_id = p.ticket_id AND origin.mirror_key = p.mirror_key
    AND origin.mirror_occurrence = p.mirror_occurrence AND origin.channel IN ('normal', 'ai'))`

export async function queryLogPage(ticketId: string, query: LogPageQuery) {
  await catchUpLogProjection(ticketId)
  const storage = ensureProjectionSchema(ticketId)
  if (!storage) return null
  const { context, sqlite } = storage
  const before = decodeCursor(query.before)
  const shouldIncludeTotals = query.includeTotals !== false && before === null
  const clauses = ['ticket_id = ?']
  const params: SQLInputValue[] = [context.localTicketId]
  if (query.scope === 'phase' && query.phase) { clauses.push('phase = ?'); params.push(query.phase) }
  if (typeof query.phaseAttempt === 'number') { clauses.push('phase_attempt = ?'); params.push(query.phaseAttempt) }
  if (query.beadId) { clauses.push('bead_id = ?'); params.push(query.beadId) }
  let modelIds: string[] | undefined
  if (shouldIncludeTotals) {
    // Tabs describe the whole scope, even when the selected view or model has
    // no rows on this page. Use the same explicit-id precedence as model rows.
    const modelSql = `
      SELECT DISTINCT model_id
      FROM execution_log_projection AS p
      WHERE ${clauses.join(' AND ')} AND ${AI_VISIBLE_ROWS} AND model_id IS NOT NULL
      ORDER BY model_id
    `
    let modelStatement = storage.statements.queryPages.get(modelSql)
    if (!modelStatement) {
      modelStatement = sqlite.prepare(modelSql)
      storage.statements.queryPages.set(modelSql, modelStatement)
    }
    modelIds = (modelStatement.all(...params) as Array<{ model_id: string }>).map(row => row.model_id)
  }
  if (query.view === 'debug') { clauses.push("channel = 'debug'") }
  else if (query.view === 'ai') { clauses.push(AI_VISIBLE_ROWS) }
  else { clauses.push("channel = 'normal'") }
  // The overview backs the ALL tab. Apply its visible-row rules before LIMIT
  // so a page of commands or AI detail-only rows cannot produce an apparently
  // empty ALL tab while older visible history exists.
  if (query.view === 'overview') {
    clauses.push(`(
      classification = 'system'
      OR classification = 'error'
      OR json_extract(entry_json, '$.kind') = 'prompt'
      OR (
        classification = 'ai'
        AND json_extract(entry_json, '$.audience') = 'ai'
        AND json_extract(entry_json, '$.kind') = 'text'
        AND (
          COALESCE(json_extract(entry_json, '$.streaming'), 0) = 0
          OR json_extract(entry_json, '$.op') = 'append'
        )
      )
    )`)
  }
  if (query.view !== 'overview' && query.view !== 'ai') {
    clauses.push('classification = ?')
    params.push(query.view)
  }
  if (query.modelId) {
    clauses.push('model_id = ?')
    params.push(query.modelId)
  }
  const countWhere = clauses.join(' AND ')
  const countSql = `
    SELECT
      COUNT(*) AS total_entries,
      COALESCE(SUM(text_lines), 0) AS total_text_lines
    FROM execution_log_projection AS p
    WHERE ${countWhere}
  `
  let counts: { total_entries: number; total_text_lines: number } | null = null
  if (shouldIncludeTotals) {
    let countStatement = storage.statements.queryPages.get(countSql)
    if (!countStatement) {
      countStatement = sqlite.prepare(countSql)
      storage.statements.queryPages.set(countSql, countStatement)
    }
    counts = countStatement.get(...params) as { total_entries: number; total_text_lines: number }
  }

  const pageClauses = [...clauses]
  const pageParams = [...params]
  if (before !== null) {
    if (query.view === 'ai') {
      pageClauses.push(`(${AI_START_TIMESTAMP}, mirror_key, mirror_occurrence) < (?, ?, ?)`)
      pageParams.push(before.timestamp, before.mirrorKey, before.mirrorOccurrence)
    } else {
      pageClauses.push('ordinal < ?')
      pageParams.push(before.ordinal)
    }
  }
  const where = pageClauses.join(' AND ')
  const timestamp = query.view === 'ai' ? AI_START_TIMESTAMP : 'timestamp'
  const order = query.view === 'ai' ? 'sort_timestamp DESC, mirror_key DESC, mirror_occurrence DESC' : 'ordinal DESC'
  const sql = `SELECT ordinal, ${timestamp} AS sort_timestamp, mirror_key, mirror_occurrence, entry_json FROM execution_log_projection AS p WHERE ${where} ORDER BY ${order} LIMIT ?`
  let statement = storage.statements.queryPages.get(sql)
  if (!statement) {
    statement = sqlite.prepare(sql)
    storage.statements.queryPages.set(sql, statement)
  }
  const rows = statement.all(...pageParams, query.limit + 1) as Array<{
    ordinal: number; sort_timestamp: string; mirror_key: string; mirror_occurrence: number; entry_json: string
  }>
  const hasOlder = rows.length > query.limit
  const page = rows.slice(0, query.limit)
  const oldest = page.at(-1)
  return {
    entries: page.reverse().map(row => {
      const entry = JSON.parse(row.entry_json)
      if (query.view === 'ai' && row.sort_timestamp) entry.timestamp = row.sort_timestamp
      return entry
    }),
    olderCursor: hasOlder && oldest ? Buffer.from(JSON.stringify({
      ordinal: oldest.ordinal, timestamp: oldest.sort_timestamp,
      mirrorKey: oldest.mirror_key, mirrorOccurrence: oldest.mirror_occurrence,
    })).toString('base64url') : null,
    hasOlder,
    ...(counts ? {
      totalEntries: counts.total_entries,
      totalTextLines: counts.total_text_lines,
      modelIds,
    } : {}),
  }
}

/**
 * How many rows one export query pulls.
 *
 * There is no cap on the export itself: this walks every page to the end, because
 * `useTicketHistoricalLogs`, `PhaseLogPanel` and `FullLogView` all treat this endpoint
 * as the ticket's complete record, and a limit with no truncation signal in the payload
 * would make a large export quietly lie about being whole. What the paging removes is
 * the single statement that asked SQLite for a ticket's entire history at once and held
 * the event loop for as long as that took.
 */
const EXPORT_PAGE_SIZE = 500

export async function exportLogEntries(
  ticketId: string,
  query: Omit<LogPageQuery, 'before' | 'limit'>,
  // Overridable so the page boundary can be exercised without writing five hundred rows.
  { pageSize = EXPORT_PAGE_SIZE }: { pageSize?: number } = {},
) {
  // A page size below 1 asks SQLite for nothing, which reads back as a ticket with no
  // history — an empty export where a complete one was expected, and no error anywhere.
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`exportLogEntries pageSize must be a positive integer, received ${pageSize}`)
  }

  // Pages run newest-first and each page is ordered oldest-first inside itself, so the
  // pages are collected in reverse and flipped once at the end. For a ticket that is not
  // being written to, the body is byte-for-byte what the single unbounded query
  // produced; for one still running, the walk moves toward older rows only, so it sees
  // the same prefix the one-shot query would have.
  const pages: Array<Record<string, unknown>[]> = []
  let before: string | undefined

  for (;;) {
    const page = await queryLogPage(ticketId, {
      ...query,
      limit: pageSize,
      includeTotals: false,
      ...(before ? { before } : {}),
    })
    // Losing the ticket midway leaves a prefix, not an export. Three call sites read
    // this endpoint as the whole record, so half of one must not come back looking
    // complete — the same reason there is no row cap here.
    if (!page) return null

    pages.push(page.entries)
    if (!page.hasOlder || !page.olderCursor) break
    before = page.olderCursor
  }

  return pages.reverse().flat()
}
