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
import {
  listOpenCodeNativeLogFiles,
  readOpenCodeNativeLogFile,
  type OpenCodeNativeLogEntry,
  type OpenCodeNativeLogReadLocation,
  type OpenCodeNativeLogReadStats,
} from '../opencode/logDiagnostics'

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
const nativeFileIngests = new Map<string, Promise<void>>()
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
    CREATE TABLE IF NOT EXISTS execution_log_native_snapshots (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      snapshot_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (ticket_id, snapshot_key)
    );
    /*
     * Native history is an append-only generation index. A snapshot stores
     * current/root generation pointers for each file; it never copies the
     * file's rows. A child generation contains an append (or a replacement
     * tail), while its parent retains the already indexed prefix.
     */
    CREATE TABLE IF NOT EXISTS execution_log_native_index_files (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      file_identity TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      scanned_sessions TEXT NOT NULL,
      generation INTEGER NOT NULL,
      indexed_offset INTEGER NOT NULL,
      indexed_lines INTEGER NOT NULL,
      tail_offset INTEGER NOT NULL,
      PRIMARY KEY (ticket_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_execution_log_native_index_files_ticket
      ON execution_log_native_index_files(ticket_id, path);
    CREATE TABLE IF NOT EXISTS execution_log_native_index_versions (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      generation INTEGER NOT NULL,
      parent_generation INTEGER,
      replace_from_line INTEGER NOT NULL,
      file_identity TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      scanned_sessions TEXT NOT NULL,
      indexed_offset INTEGER NOT NULL,
      indexed_lines INTEGER NOT NULL,
      tail_offset INTEGER NOT NULL,
      PRIMARY KEY (ticket_id, path, generation)
    );
    CREATE TABLE IF NOT EXISTS execution_log_native_index_entries (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      generation INTEGER NOT NULL,
      line_number INTEGER NOT NULL,
      byte_offset INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      identity TEXT NOT NULL,
      timestamp_rank INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      sort_key TEXT NOT NULL,
      model_id TEXT,
      entry_json TEXT NOT NULL,
      text_lines INTEGER NOT NULL,
      PRIMARY KEY (ticket_id, path, generation, line_number),
      FOREIGN KEY (ticket_id, path, generation)
        REFERENCES execution_log_native_index_versions(ticket_id, path, generation)
        ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_execution_log_native_index_entries_order
      ON execution_log_native_index_entries(ticket_id, path, generation, session_id,
        timestamp_rank DESC, timestamp DESC, sort_key DESC, line_number DESC);
    CREATE INDEX IF NOT EXISTS idx_execution_log_native_index_entries_global
      ON execution_log_native_index_entries(ticket_id,
        timestamp_rank DESC, timestamp DESC, sort_key DESC, line_number DESC);
    CREATE INDEX IF NOT EXISTS idx_execution_log_native_index_entries_session
      ON execution_log_native_index_entries(ticket_id, session_id, path, generation);
    CREATE TABLE IF NOT EXISTS execution_log_native_snapshot_files (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      snapshot_key TEXT NOT NULL,
      path TEXT NOT NULL,
      generation INTEGER NOT NULL,
      root_generation INTEGER NOT NULL,
      session_ids TEXT NOT NULL,
      PRIMARY KEY (ticket_id, snapshot_key, path),
      FOREIGN KEY (ticket_id, snapshot_key)
        REFERENCES execution_log_native_snapshots(ticket_id, snapshot_key)
        ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_execution_log_native_snapshot_files
      ON execution_log_native_snapshot_files(ticket_id, snapshot_key, path, generation);
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
  nativeSnapshot?: string
}

export const HISTORICAL_LOG_CURSOR_EXPIRED_CODE = 'LOG_CURSOR_EXPIRED'

export class HistoricalLogCursorExpiredError extends Error {
  readonly code = HISTORICAL_LOG_CURSOR_EXPIRED_CODE

  constructor() {
    super('Historical native log cursor expired; restart the history request')
    this.name = 'HistoricalLogCursorExpiredError'
  }
}

export function isHistoricalLogCursorExpiredError(error: unknown): error is HistoricalLogCursorExpiredError {
  return error instanceof HistoricalLogCursorExpiredError
    || (Boolean(error) && typeof error === 'object'
      && (error as { code?: unknown }).code === HISTORICAL_LOG_CURSOR_EXPIRED_CODE)
}

function decodeCursor(cursor?: string): LogCursor | null {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<LogCursor>
    return typeof value.ordinal === 'number' && Number.isSafeInteger(value.ordinal) && value.ordinal >= 0
      && typeof value.timestamp === 'string' && typeof value.mirrorKey === 'string'
      && typeof value.mirrorOccurrence === 'number' && Number.isSafeInteger(value.mirrorOccurrence) && value.mirrorOccurrence >= 0
      && (value.nativeSnapshot === undefined || typeof value.nativeSnapshot === 'string')
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
// Invalid timestamps are deliberately the newest request group so the API's
// oldest-first page payload and export place undated AI rows last.
const AI_START_RANK = `(CASE WHEN ${AI_START_TIMESTAMP} = '' THEN 1 ELSE 0 END)`

// DEBUG is the forensic view: keep ordinary LoopTroop rows, direct debug rows,
// the winning AI mirror, and native OpenCode rows for this ticket's sessions.
// Mirrored AI rows still need one winner, otherwise a finalized response appears
// twice simply because it is stored in both the normal and AI files.
const DEBUG_VISIBLE_ROWS = `(
  p.channel = 'debug'
  OR (p.channel = 'normal' AND (p.ai_visible = 0 OR ${AI_VISIBLE_ROWS}))
  OR (p.channel = 'ai' AND ${AI_VISIBLE_ROWS})
)`

interface DebugProjectionRow {
  entry: Record<string, unknown>
  timestamp: string
  sortKey: string
  occurrence: number
  ordinal: number
  modelId: string | null
}

const DEBUG_TIMESTAMP_RANK_SQL = `(CASE WHEN p.timestamp = '' THEN 1 ELSE 0 END)`
const DEBUG_SORT_KEY_SQL = `(CASE p.channel WHEN 'normal' THEN '0:' WHEN 'debug' THEN '1:' ELSE '2:' END || p.mirror_key)`
const NATIVE_SNAPSHOT_RETENTION = 4

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareSortableTimestamps(a: string, b: string): number {
  const aTime = Date.parse(a)
  const bTime = Date.parse(b)
  if (!Number.isFinite(aTime) && !Number.isFinite(bTime)) return 0
  if (!Number.isFinite(aTime)) return 1
  if (!Number.isFinite(bTime)) return -1
  return aTime - bTime
}

function compareDebugRows(a: DebugProjectionRow, b: DebugProjectionRow): number {
  return compareSortableTimestamps(a.timestamp, b.timestamp)
    || compareStrings(a.sortKey, b.sortKey)
    || a.occurrence - b.occurrence
    || a.ordinal - b.ordinal
}

function debugNewestFirst(a: DebugProjectionRow, b: DebugProjectionRow): number {
  return compareDebugRows(b, a)
}

function mergeDebugRows(
  persisted: DebugProjectionRow[],
  native: DebugProjectionRow[],
  limit: number,
): DebugProjectionRow[] {
  const merged: DebugProjectionRow[] = []
  let persistedIndex = 0
  let nativeIndex = 0
  while (merged.length < limit && (persistedIndex < persisted.length || nativeIndex < native.length)) {
    const persistedRow = persisted[persistedIndex]
    const nativeRow = native[nativeIndex]
    if (!nativeRow || (persistedRow && debugNewestFirst(persistedRow, nativeRow) <= 0)) {
      merged.push(persistedRow!)
      persistedIndex += 1
    } else {
      merged.push(nativeRow)
      nativeIndex += 1
    }
  }
  return merged
}

function nativeSnapshotExists(storage: ProjectionStorage, snapshotKey: string): boolean {
  const row = storage.sqlite.prepare(`
    SELECT 1 AS present FROM execution_log_native_snapshots
    WHERE ticket_id = ? AND snapshot_key = ?
  `).get(storage.context.localTicketId, snapshotKey) as { present?: number } | undefined
  return row?.present === 1
}

function nativeEntryIdentity(entry: OpenCodeNativeLogEntry): string {
  if (entry.nativeIdentity) return entry.nativeIdentity
  // The production reader always supplies a file-and-line identity. This
  // content fallback keeps injected readers deterministic without pretending
  // that a page position is a durable cursor key.
  return `content:${createHash('sha256').update(JSON.stringify(entry)).digest('hex')}`
}

interface NativeFileIndexRow {
  path: string
  file_identity: string
  mtime_ms: number
  size: number
  scanned_sessions: string
  generation: number
  indexed_offset: number
  indexed_lines: number
  tail_offset: number
}

interface NativeGenerationRow {
  path: string
  generation: number
  parent_generation: number | null
  replace_from_line: number
  file_identity: string
  mtime_ms: number
  size: number
  scanned_sessions: string
  indexed_offset: number
  indexed_lines: number
  tail_offset: number
}

interface NativeSnapshotFileRow {
  path: string
  generation: number
  root_generation: number
  session_ids: string
}

function createNativeReadStats(): OpenCodeNativeLogReadStats {
  return {
    startOffset: 0,
    startLine: 0,
    bytesRead: 0,
    linesRead: 0,
    indexedOffset: 0,
    indexedLines: 0,
    tailOffset: 0,
    endedWithNewline: true,
    entriesRead: 0,
  }
}

function parseNativeFileSessions(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((session): session is string => typeof session === 'string' && session.length > 0)
      : []
  } catch {
    return []
  }
}

function nativeGenerationSlices(
  storage: ProjectionStorage,
  file: { path: string; generation: number },
): Array<{ generation: NativeGenerationRow; maxLineExclusive: number }> {
  const select = storage.sqlite.prepare(`
    SELECT path, generation, parent_generation, replace_from_line, file_identity,
      mtime_ms, size, scanned_sessions, indexed_offset, indexed_lines, tail_offset
    FROM execution_log_native_index_versions
    WHERE ticket_id = ? AND path = ? AND generation = ?
  `)
  const slices: Array<{ generation: NativeGenerationRow; maxLineExclusive: number }> = []
  let generation: number | null = file.generation
  let maxLineExclusive = Number.MAX_SAFE_INTEGER
  const seen = new Set<number>()
  while (generation !== null && !seen.has(generation)) {
    seen.add(generation)
    const row = select.get(storage.context.localTicketId, file.path, generation) as NativeGenerationRow | undefined
    if (!row) break
    slices.push({ generation: row, maxLineExclusive })
    maxLineExclusive = Math.min(maxLineExclusive, row.replace_from_line)
    generation = row.parent_generation
  }
  return slices
}

function nativeSnapshotFiles(
  storage: ProjectionStorage,
  snapshotKey: string,
): NativeSnapshotFileRow[] {
  return storage.sqlite.prepare(`
    SELECT path, generation, root_generation, session_ids
    FROM execution_log_native_snapshot_files
    WHERE ticket_id = ? AND snapshot_key = ?
    ORDER BY path
  `).all(storage.context.localTicketId, snapshotKey) as unknown as NativeSnapshotFileRow[]
}

function nativeFileHasSession(
  storage: ProjectionStorage,
  file: NativeFileIndexRow,
  sessionIds: string[],
): boolean {
  const slices = nativeGenerationSlices(storage, {
    path: file.path,
    generation: file.generation,
  })
  const placeholders = sessionIds.map(() => '?').join(', ')
  for (const slice of slices) {
    const clauses = [
      'ticket_id = ?', 'path = ?', 'generation = ?',
      `session_id IN (${placeholders})`,
    ]
    const params: SQLInputValue[] = [
      storage.context.localTicketId,
      file.path,
      slice.generation.generation,
      ...sessionIds,
    ]
    if (slice.maxLineExclusive < Number.MAX_SAFE_INTEGER) {
      clauses.push('line_number < ?')
      params.push(slice.maxLineExclusive)
    }
    const row = storage.sqlite.prepare(`
      SELECT 1 AS present
      FROM execution_log_native_index_entries
      WHERE ${clauses.join(' AND ')}
      LIMIT 1
    `).get(...params) as { present?: number } | undefined
    if (row?.present === 1) return true
  }
  return false
}

async function ingestNativeFilesOnce(
  storage: ProjectionStorage,
  sessionIds: string[],
): Promise<NativeFileIndexRow[]> {
  if (sessionIds.length === 0) return []
  const { sqlite, context } = storage
  const candidates = listOpenCodeNativeLogFiles()
  const candidatePaths = new Set(candidates.map(candidate => candidate.path))
  const existingRows = sqlite.prepare(`
    SELECT path, file_identity, mtime_ms, size, scanned_sessions, generation,
      indexed_offset, indexed_lines, tail_offset
    FROM execution_log_native_index_files
    WHERE ticket_id = ?
  `).all(context.localTicketId) as unknown as NativeFileIndexRow[]
  const existing = new Map(existingRows.map(row => [row.path, row]))
  const requested = new Set(sessionIds)

  const removeMissing = sqlite.prepare(`
    DELETE FROM execution_log_native_index_files WHERE ticket_id = ? AND path = ?
  `)

  for (const row of existingRows) {
    if (!candidatePaths.has(row.path)) {
      removeMissing.run(context.localTicketId, row.path)
    }
  }

  for (const candidate of candidates) {
    const previous = existing.get(candidate.path)
    const scannedSessions = previous ? parseNativeFileSessions(previous.scanned_sessions) : []
    const needsSessionScan = sessionIds.some(sessionId => !scannedSessions.includes(sessionId))
    const candidateIdentity = candidate.fileIdentity ?? ''
    const identityChanged = Boolean(previous && previous.file_identity && candidateIdentity
      && previous.file_identity !== candidateIdentity)
    const truncated = Boolean(previous && candidate.size < previous.size)
    const appended = Boolean(previous && !identityChanged && !truncated && candidate.size > previous.size)
    const rewritten = Boolean(previous && !appended
      && candidate.mtimeMs !== previous.mtime_ms
      && !candidateIdentity
      && !previous.file_identity)
    const changed = !previous || identityChanged || truncated || appended || rewritten
    if (!changed && !needsSessionScan) {
      if (previous && (previous.mtime_ms !== candidate.mtimeMs || previous.file_identity !== candidateIdentity)) {
        sqlite.prepare(`
          UPDATE execution_log_native_index_files
          SET file_identity = ?, mtime_ms = ?, size = ?
          WHERE ticket_id = ? AND path = ?
        `).run(candidateIdentity, candidate.mtimeMs, candidate.size, context.localTicketId, candidate.path)
      }
      continue
    }

    const scanSessions = [...new Set([...scannedSessions, ...sessionIds])]
    const fullReplacement = !previous || identityChanged || truncated || rewritten
    const appendStartOffset = previous
      ? (previous.tail_offset < previous.indexed_offset ? previous.tail_offset : previous.indexed_offset)
      : 0
    const appendStartLine = previous?.indexed_lines ?? 0
    const readOffset = fullReplacement ? 0 : appended ? appendStartOffset : 0
    const readLine = fullReplacement ? 0 : appended ? appendStartLine : 0
    const missingSessions = scanSessions.filter(sessionId => !scannedSessions.includes(sessionId))
    // A newly requested session must be read from byte zero even when the
    // file also appended. The suffix and the missing session's older rows are
    // two independent ranges in one child generation; marking the session
    // scanned after only the suffix would permanently lose its prefix.
    const readPlans: Array<{
      sessionIds: string[]
      startOffset: number
      startLine: number
      endOffset?: number
      endLine?: number
    }> = fullReplacement
      ? [{ sessionIds: scanSessions, startOffset: 0, startLine: 0 }]
      : appended && missingSessions.length > 0
        ? [
            {
              sessionIds: missingSessions,
              startOffset: 0,
              startLine: 0,
              endOffset: appendStartOffset,
              endLine: appendStartLine,
            },
            { sessionIds: scanSessions, startOffset: appendStartOffset, startLine: appendStartLine },
          ]
        : [{
            sessionIds: appended ? scanSessions : missingSessions,
            startOffset: appended ? appendStartOffset : 0,
            startLine: appended ? appendStartLine : 0,
          }]
    const parentGeneration = fullReplacement ? null : previous?.generation ?? null
    const replaceFromLine = fullReplacement
      ? 0
      : appended
        ? readLine
        : Number.MAX_SAFE_INTEGER
    const maxGeneration = sqlite.prepare(`
      SELECT COALESCE(MAX(generation), -1) AS generation
      FROM execution_log_native_index_versions
      WHERE ticket_id = ? AND path = ?
    `).get(context.localTicketId, candidate.path) as { generation?: number }
    const generation = Math.max(Number(maxGeneration.generation ?? -1) + 1, (previous?.generation ?? -1) + 1)
    const stats = createNativeReadStats()
    let sessionSet = new Set<string>()
    const insertVersion = sqlite.prepare(`
      INSERT INTO execution_log_native_index_versions (
        ticket_id, path, generation, parent_generation, replace_from_line,
        file_identity, mtime_ms, size, scanned_sessions,
        indexed_offset, indexed_lines, tail_offset
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertEntry = sqlite.prepare(`
      INSERT INTO execution_log_native_index_entries (
        ticket_id, path, generation, line_number, byte_offset, byte_length,
        session_id, identity, timestamp_rank, timestamp, sort_key, model_id,
        entry_json, text_lines
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertRaw = (raw: OpenCodeNativeLogEntry, location?: OpenCodeNativeLogReadLocation, fallbackIndex = 0) => {
      if (!raw.sessionId || !sessionSet.has(raw.sessionId)) return
      const entry = normalizePersistedLogEntry(raw)
      if (!entry) return
      const identity = nativeEntryIdentity(raw)
      const timestamp = sortableTimestamp(entry.timestamp)
      const lineFromIdentity = raw.nativeIdentity?.slice(raw.nativeIdentity.lastIndexOf(':') + 1)
      const parsedLine = Number(lineFromIdentity)
      const lineNumber = location?.lineNumber ?? (Number.isSafeInteger(parsedLine) && parsedLine >= 0 ? parsedLine : fallbackIndex)
      insertEntry.run(
        context.localTicketId,
        candidate.path,
        generation,
        lineNumber,
        location?.byteOffset ?? 0,
        location?.byteLength ?? 0,
        raw.sessionId,
        identity,
        timestamp === '' ? 1 : 0,
        timestamp,
        '3:native:' + raw.sessionId + ':' + identity,
        typeof entry.modelId === 'string' ? entry.modelId : null,
        JSON.stringify(entry),
        String(entry.content ?? entry.message ?? '').split('\n').length,
      )
    }

    sqlite.transaction(() => {
      insertVersion.run(
        context.localTicketId,
        candidate.path,
        generation,
        parentGeneration,
        replaceFromLine,
        candidateIdentity,
        candidate.mtimeMs,
        candidate.size,
        JSON.stringify(scanSessions),
        readOffset,
        readLine,
        readOffset,
      )
    })()
    try {
      for (const plan of readPlans) {
        sessionSet = new Set(plan.sessionIds)
        const entries = await readOpenCodeNativeLogFile(candidate, plan.sessionIds, {
          startOffset: plan.startOffset,
          startLine: plan.startLine,
          onEntry: (raw, location) => {
            if (plan.endOffset !== undefined && location.byteOffset >= plan.endOffset) return
            insertRaw(raw, location)
          },
          stats,
        })
        // Test doubles and older integrations may not implement the streaming
        // callback. They still feed the same generation without retaining the
        // production reader's complete array.
        for (const [entryIndex, raw] of entries.entries()) {
          const fallbackLine = plan.startLine + entryIndex
          if (plan.endLine !== undefined && fallbackLine >= plan.endLine) continue
          insertRaw(raw, undefined, fallbackLine)
        }
      }
      sqlite.transaction(() => {
        sqlite.prepare(`
          UPDATE execution_log_native_index_versions
          SET indexed_offset = ?, indexed_lines = ?, tail_offset = ?,
            file_identity = ?, mtime_ms = ?, size = ?, scanned_sessions = ?
          WHERE ticket_id = ? AND path = ? AND generation = ?
        `).run(
          stats.indexedOffset,
          stats.indexedLines,
          stats.tailOffset,
          candidateIdentity,
          candidate.mtimeMs,
          candidate.size,
          JSON.stringify(scanSessions),
          context.localTicketId,
          candidate.path,
          generation,
        )
        sqlite.prepare(`
          INSERT INTO execution_log_native_index_files (
            ticket_id, path, file_identity, mtime_ms, size, scanned_sessions,
            generation, indexed_offset, indexed_lines, tail_offset
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(ticket_id, path) DO UPDATE SET
            file_identity = excluded.file_identity, mtime_ms = excluded.mtime_ms,
            size = excluded.size, scanned_sessions = excluded.scanned_sessions,
            generation = excluded.generation, indexed_offset = excluded.indexed_offset,
            indexed_lines = excluded.indexed_lines, tail_offset = excluded.tail_offset
        `).run(
          context.localTicketId,
          candidate.path,
          candidateIdentity,
          candidate.mtimeMs,
          candidate.size,
          JSON.stringify(scanSessions),
          generation,
          stats.indexedOffset,
          stats.indexedLines,
          stats.tailOffset,
        )
      })()
    } catch (error) {
      sqlite.prepare(`
        DELETE FROM execution_log_native_index_versions
        WHERE ticket_id = ? AND path = ? AND generation = ?
      `).run(context.localTicketId, candidate.path, generation)
      throw error
    }
  }

  const rows = sqlite.prepare(`
    SELECT path, file_identity, mtime_ms, size, scanned_sessions, generation,
      indexed_offset, indexed_lines, tail_offset
    FROM execution_log_native_index_files
    WHERE ticket_id = ?
    ORDER BY path
  `).all(context.localTicketId) as unknown as NativeFileIndexRow[]
  // Only files that have been scanned for one of the requested sessions enter
  // a snapshot. The rows remain in generation tables; no manifest copies them.
  return rows.filter(row => nativeFileHasSession(storage, row, [...requested]))
}

/** Coalesce concurrent refresh/export readers for one ticket without caching a
 * mutable snapshot in process memory. The durable file rows and snapshot table
 * remain the source of truth after the operation settles. */
function ingestNativeFiles(
  storage: ProjectionStorage,
  sessionIds: string[],
): Promise<NativeFileIndexRow[]> {
  // Local SQLite ids repeat across projects. Serialize all session sets for one
  // composite ticket: two concurrent scope queries must not both read stale file
  // metadata and let the second transaction replace the first one's rows.
  const ingestKey = storage.context.ticketRef
  const previous = nativeFileIngests.get(ingestKey)
  const ingest = (async () => {
    if (previous) await previous.catch(() => undefined)
    await ingestNativeFilesOnce(storage, sessionIds)
  })()
  const tracked = ingest.then(() => undefined, () => undefined)
  nativeFileIngests.set(ingestKey, tracked)
  const cleanup = () => {
    if (nativeFileIngests.get(ingestKey) === tracked) nativeFileIngests.delete(ingestKey)
  }
  void ingest.then(cleanup, cleanup)
  return ingest.then(() => sqliteNativeFilesForSessions(storage, sessionIds))
}

function sqliteNativeFilesForSessions(
  storage: ProjectionStorage,
  sessionIds: string[],
): NativeFileIndexRow[] {
  return (storage.sqlite.prepare(`
    SELECT path, file_identity, mtime_ms, size, scanned_sessions, generation,
      indexed_offset, indexed_lines, tail_offset
    FROM execution_log_native_index_files
    WHERE ticket_id = ?
    ORDER BY path
  `).all(storage.context.localTicketId) as unknown as NativeFileIndexRow[])
    .filter(row => nativeFileHasSession(storage, row, sessionIds))
}

function nativeSnapshotKey(sessionIds: string[], files: NativeFileIndexRow[]): string {
  return createHash('sha256').update(JSON.stringify({
    sessions: [...new Set(sessionIds)].sort(),
    files: files.map(file => [file.path, file.file_identity, file.mtime_ms, file.size, file.generation]),
  })).digest('hex')
}

/** Drop generations no retained snapshot or current file can reach. Rows in a
 * live append chain remain reachable through its parent pointers; rotation
 * generations have no parent and therefore become collectible as manifests
 * age out. This keeps cursors immutable for the retained window without
 * retaining every successful replacement forever. */
function pruneUnreachableNativeGenerations(storage: ProjectionStorage): void {
  const { sqlite, context } = storage
  const roots = sqlite.prepare(`
    SELECT path, generation
    FROM execution_log_native_index_files
    WHERE ticket_id = ?
    UNION
    SELECT path, generation
    FROM execution_log_native_snapshot_files
    WHERE ticket_id = ?
  `).all(context.localTicketId, context.localTicketId) as Array<{ path: string; generation: number }>
  const selectParent = sqlite.prepare(`
    SELECT parent_generation
    FROM execution_log_native_index_versions
    WHERE ticket_id = ? AND path = ? AND generation = ?
  `)
  const reachable = new Set<string>()
  const pending = roots.map(root => ({ path: root.path, generation: root.generation }))
  while (pending.length > 0) {
    const current = pending.pop()!
    const key = `${current.path}\0${current.generation}`
    if (reachable.has(key)) continue
    reachable.add(key)
    const row = selectParent.get(context.localTicketId, current.path, current.generation) as { parent_generation?: number | null } | undefined
    if (row?.parent_generation !== null && row?.parent_generation !== undefined) {
      pending.push({ path: current.path, generation: row.parent_generation })
    }
  }
  const versions = sqlite.prepare(`
    SELECT path, generation
    FROM execution_log_native_index_versions
    WHERE ticket_id = ?
  `).all(context.localTicketId) as Array<{ path: string; generation: number }>
  const remove = sqlite.prepare(`
    DELETE FROM execution_log_native_index_versions
    WHERE ticket_id = ? AND path = ? AND generation = ?
  `)
  sqlite.transaction(() => {
    for (const version of versions) {
      if (!reachable.has(`${version.path}\0${version.generation}`)) {
        remove.run(context.localTicketId, version.path, version.generation)
      }
    }
  })()
}

function indexNativeSnapshot(
  storage: ProjectionStorage,
  snapshotKey: string,
  files: NativeFileIndexRow[],
  sessionIds: string[],
) {
  const { sqlite, context } = storage
  if (nativeSnapshotExists(storage, snapshotKey)) return
  const insertSnapshot = sqlite.prepare(`
    INSERT OR IGNORE INTO execution_log_native_snapshots (ticket_id, snapshot_key, created_at)
    VALUES (?, ?, ?)
  `)
  const insertFile = sqlite.prepare(`
    INSERT OR IGNORE INTO execution_log_native_snapshot_files (
      ticket_id, snapshot_key, path, generation, root_generation, session_ids
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)
  const selectSnapshots = sqlite.prepare(`
    SELECT snapshot_key, created_at
    FROM execution_log_native_snapshots
    WHERE ticket_id = ?
    ORDER BY created_at DESC, snapshot_key DESC
  `)
  const selectLatestCreated = sqlite.prepare(`
    SELECT COALESCE(MAX(created_at), 0) AS created_at
    FROM execution_log_native_snapshots
    WHERE ticket_id = ?
  `)
  const deleteSnapshotFiles = sqlite.prepare(`
    DELETE FROM execution_log_native_snapshot_files
    WHERE ticket_id = ? AND snapshot_key = ?
  `)
  const deleteSnapshot = sqlite.prepare(`
    DELETE FROM execution_log_native_snapshots
    WHERE ticket_id = ? AND snapshot_key = ?
  `)
  sqlite.transaction(() => {
    const latestCreated = selectLatestCreated.get(context.localTicketId) as { created_at?: number }
    // Use a monotonic manifest sequence in addition to wall-clock time. A
    // clock rollback or millisecond tie must still rank this current manifest
    // newer than the retained history it supersedes.
    const createdAt = Math.max(Date.now(), Number(latestCreated.created_at ?? 0) + 1)
    insertSnapshot.run(context.localTicketId, snapshotKey, createdAt)
    for (const file of files) {
      const slices = nativeGenerationSlices(storage, file)
      const rootGeneration = slices.at(-1)?.generation.generation ?? file.generation
      insertFile.run(
        context.localTicketId,
        snapshotKey,
        file.path,
        file.generation,
        rootGeneration,
        JSON.stringify(sessionIds),
      )
    }
    // Keep the current manifest even when Date.now() ties or moves backwards.
    // The remaining slots use a deterministic newest-created ordering, so a
    // clock adjustment can never evict the manifest that owns this request's
    // current file pointers.
    const manifests = selectSnapshots.all(context.localTicketId) as Array<{ snapshot_key: string; created_at: number }>
    const keepKeys = new Set<string>([snapshotKey])
    for (const manifest of manifests) {
      if (keepKeys.size >= NATIVE_SNAPSHOT_RETENTION) break
      keepKeys.add(manifest.snapshot_key)
    }
    for (const manifest of manifests) {
      if (keepKeys.has(manifest.snapshot_key)) continue
      deleteSnapshotFiles.run(context.localTicketId, manifest.snapshot_key)
      deleteSnapshot.run(context.localTicketId, manifest.snapshot_key)
    }
  })()
  pruneUnreachableNativeGenerations(storage)
}

async function ensureNativeSnapshot(
  storage: ProjectionStorage,
  sessionIds: string[],
): Promise<string> {
  if (sessionIds.length === 0) {
    const snapshotKey = nativeSnapshotKey([], [])
    if (!nativeSnapshotExists(storage, snapshotKey)) {
      storage.sqlite.prepare(`
        INSERT OR IGNORE INTO execution_log_native_snapshots (ticket_id, snapshot_key, created_at)
        VALUES (?, ?, ?)
      `).run(storage.context.localTicketId, snapshotKey, Date.now())
    }
    return snapshotKey
  }
  const files = await ingestNativeFiles(storage, sessionIds)
  const snapshotKey = nativeSnapshotKey(sessionIds, files)
  if (nativeSnapshotExists(storage, snapshotKey)) return snapshotKey
  indexNativeSnapshot(storage, snapshotKey, files, sessionIds)
  return snapshotKey
}

function nativeRowsForPage(
  storage: ProjectionStorage,
  snapshotKey: string,
  query: LogPageQuery,
  before: LogCursor | null,
  limit: number,
): DebugProjectionRow[] {
  const files = nativeSnapshotFiles(storage, snapshotKey)
  if (files.length === 0) return []
  const sessionIds = [...new Set(files.flatMap(file => parseNativeFileSessions(file.session_ids)))]
  if (sessionIds.length === 0) return []
  const sessionPlaceholders = sessionIds.map(() => '?').join(', ')
  const clauses = [
    'e.ticket_id = ?',
    `e.session_id IN (${sessionPlaceholders})`,
    'e.generation >= sf.root_generation',
    'e.generation <= sf.generation',
    `NOT EXISTS (
      SELECT 1
      FROM execution_log_native_index_versions AS newer
      WHERE newer.ticket_id = e.ticket_id
        AND newer.path = e.path
        AND newer.generation > e.generation
        AND newer.generation <= sf.generation
        AND newer.replace_from_line <= e.line_number
    )`,
  ]
  const params: SQLInputValue[] = [
    snapshotKey,
    storage.context.localTicketId,
    ...sessionIds,
  ]
  if (query.modelId) {
    clauses.push('e.model_id = ?')
    params.push(query.modelId)
  }
  if (before) {
    const rank = before.timestamp === '' ? 1 : 0
    // Native identity is part of sort_key, so this row-value predicate is the
    // complete immutable keyset boundary across every generation in a cursor's
    // snapshot. The global order index bounds returned-row materialization;
    // lineage visibility still checks the indexed generation range for each
    // candidate row, which is the honest cost of retaining immutable cursors.
    // ponytail: Keep this simple until profiling shows lineage depth dominates;
    // only then consider compact ancestry in this indexed projection path.
    clauses.push('(e.timestamp_rank, e.timestamp, e.sort_key) < (?, ?, ?)')
    params.push(rank, before.timestamp, before.mirrorKey)
  }
  const fetched = storage.sqlite.prepare(`
    SELECT timestamp, sort_key, model_id, entry_json, e.path, e.generation, e.line_number
    FROM execution_log_native_index_entries AS e
      INDEXED BY idx_execution_log_native_index_entries_global
    JOIN execution_log_native_snapshot_files AS sf
      ON sf.ticket_id = e.ticket_id AND sf.snapshot_key = ? AND sf.path = e.path
    WHERE ${clauses.join(' AND ')}
    ORDER BY e.timestamp_rank DESC, e.timestamp DESC, e.sort_key DESC, e.line_number DESC
    LIMIT ?
  `).all(...params, limit) as Array<{
    timestamp: string
    sort_key: string
    model_id: string | null
    entry_json: string
    path: string
    generation: number
    line_number: number
  }>
  return fetched.map(row => ({
    entry: JSON.parse(row.entry_json) as Record<string, unknown>,
    timestamp: row.timestamp,
    sortKey: row.sort_key,
    occurrence: 0,
    ordinal: 0,
    modelId: row.model_id,
  }))
}

function nativeCountsForSnapshot(
  storage: ProjectionStorage,
  snapshotKey: string,
  modelId?: string,
): { total_entries: number; total_text_lines: number } {
  let totalEntries = 0
  let totalTextLines = 0
  for (const file of nativeSnapshotFiles(storage, snapshotKey)) {
    const sessionIds = parseNativeFileSessions(file.session_ids)
    for (const slice of nativeGenerationSlices(storage, file)) {
      for (const sessionId of sessionIds) {
        const clauses = [
          'ticket_id = ?', 'path = ?', 'generation = ?', 'session_id = ?',
        ]
        const params: SQLInputValue[] = [
          storage.context.localTicketId,
          file.path,
          slice.generation.generation,
          sessionId,
        ]
        if (slice.maxLineExclusive < Number.MAX_SAFE_INTEGER) {
          clauses.push('line_number < ?')
          params.push(slice.maxLineExclusive)
        }
        if (modelId) {
          clauses.push('model_id = ?')
          params.push(modelId)
        }
        const row = storage.sqlite.prepare(`
          SELECT COUNT(*) AS total_entries, COALESCE(SUM(text_lines), 0) AS total_text_lines
          FROM execution_log_native_index_entries
          WHERE ${clauses.join(' AND ')}
        `).get(...params) as { total_entries?: number; total_text_lines?: number }
        totalEntries += Number(row.total_entries ?? 0)
        totalTextLines += Number(row.total_text_lines ?? 0)
      }
    }
  }
  return { total_entries: totalEntries, total_text_lines: totalTextLines }
}

async function queryDebugPage(
  storage: ProjectionStorage,
  query: LogPageQuery,
  before: LogCursor | null,
  clauses: string[],
  params: SQLInputValue[],
) {
  const { sqlite, statements } = storage
  const scopeClauses = [...clauses]
  const scopeParams = [...params]
  if (query.modelId) {
    scopeClauses.push('model_id = ?')
    scopeParams.push(query.modelId)
  }
  // Session ownership is a small indexed projection lookup. The page query
  // below still asks SQLite for only limit+1 rows; it never parses the archive
  // merely to discover native rows for a later page.
  const sessionSql = `SELECT DISTINCT json_extract(p.entry_json, '$.sessionId') AS session_id
    FROM execution_log_projection AS p
    WHERE ${scopeClauses.join(' AND ')}
      AND json_extract(p.entry_json, '$.sessionId') IS NOT NULL
      AND json_extract(p.entry_json, '$.sessionId') != ''
    ORDER BY session_id`
  let sessionStatement = statements.queryPages.get(sessionSql)
  if (!sessionStatement) {
    sessionStatement = sqlite.prepare(sessionSql)
    statements.queryPages.set(sessionSql, sessionStatement)
  }
  let nativeSnapshotKey = before?.nativeSnapshot
  if (before?.nativeSnapshot && !nativeSnapshotExists(storage, before.nativeSnapshot)) {
    // A bounded retention policy may expire a very old cursor. Rebuilding from
    // today's files would silently skip/reorder rows, so make the caller start
    // a fresh history walk instead of returning a false complete page.
    throw new HistoricalLogCursorExpiredError()
  }
  if (!nativeSnapshotKey) {
    const sessionIds = (sessionStatement.all(...scopeParams) as Array<{ session_id: string }>).map(row => row.session_id)
    // Session ownership is resolved from the ticket's persisted rows. Native
    // category/attempt fields never invent phase ownership. The first page
    // does one complete parse when the manifest is new; following pages read
    // this indexed snapshot with LIMIT, so an export never reparses all files.
    nativeSnapshotKey = await ensureNativeSnapshot(storage, sessionIds)
  }

  const pageClauses = [...scopeClauses]
  const pageParams = [...scopeParams]
  if (before) {
    const rank = before.timestamp === '' ? 1 : 0
    pageClauses.push(`(
      ${DEBUG_TIMESTAMP_RANK_SQL} < ?
      OR (${DEBUG_TIMESTAMP_RANK_SQL} = ? AND p.timestamp < ?)
      OR (${DEBUG_TIMESTAMP_RANK_SQL} = ? AND p.timestamp = ? AND ${DEBUG_SORT_KEY_SQL} < ?)
      OR (${DEBUG_TIMESTAMP_RANK_SQL} = ? AND p.timestamp = ? AND ${DEBUG_SORT_KEY_SQL} = ? AND p.mirror_occurrence < ?)
      OR (${DEBUG_TIMESTAMP_RANK_SQL} = ? AND p.timestamp = ? AND ${DEBUG_SORT_KEY_SQL} = ? AND p.mirror_occurrence = ? AND p.ordinal < ?)
    )`)
    pageParams.push(
      rank,
      rank, before.timestamp,
      rank, before.timestamp, before.mirrorKey,
      rank, before.timestamp, before.mirrorKey, before.mirrorOccurrence,
      rank, before.timestamp, before.mirrorKey, before.mirrorOccurrence, before.ordinal,
    )
  }
  const sql = `SELECT ordinal, timestamp AS sort_timestamp, channel, mirror_key, mirror_occurrence, model_id, entry_json
    FROM execution_log_projection AS p
    WHERE ${pageClauses.join(' AND ')} AND ${DEBUG_VISIBLE_ROWS}
    ORDER BY ${DEBUG_TIMESTAMP_RANK_SQL} DESC, p.timestamp DESC, ${DEBUG_SORT_KEY_SQL} DESC,
      p.mirror_occurrence DESC, p.ordinal DESC
    LIMIT ?`
  let statement = statements.queryPages.get(sql)
  if (!statement) {
    statement = sqlite.prepare(sql)
    statements.queryPages.set(sql, statement)
  }
  const persistedRows = statement.all(...pageParams, query.limit + 1) as Array<{
    ordinal: number
    sort_timestamp: string
    channel: string
    mirror_key: string
    mirror_occurrence: number
    model_id: string | null
    entry_json: string
  }>
  const rows: DebugProjectionRow[] = persistedRows.map(row => ({
    entry: JSON.parse(row.entry_json) as Record<string, unknown>,
    timestamp: row.sort_timestamp,
    // The route historically concatenated normal, debug, AI, then native rows.
    // Keep that source order for equal timestamps, with the mirror key providing
    // the same deterministic tie-break within one channel.
    sortKey: `${row.channel === 'normal' ? '0' : row.channel === 'debug' ? '1' : '2'}:${row.mirror_key}`,
    occurrence: row.mirror_occurrence,
    ordinal: row.ordinal,
    modelId: row.model_id,
  }))

  const nativePage = nativeRowsForPage(storage, nativeSnapshotKey, query, before, query.limit + 1)
  let modelIds: string[] = []
  const shouldIncludeTotals = query.includeTotals !== false && before === null
  if (shouldIncludeTotals) {
    const modelSql = `SELECT DISTINCT model_id
      FROM execution_log_projection AS p
      WHERE ${clauses.join(' AND ')} AND ${DEBUG_VISIBLE_ROWS} AND model_id IS NOT NULL
      ORDER BY model_id`
    let modelStatement = statements.queryPages.get(modelSql)
    if (!modelStatement) {
      modelStatement = sqlite.prepare(modelSql)
      statements.queryPages.set(modelSql, modelStatement)
    }
    modelIds = (modelStatement.all(...params) as Array<{ model_id: string }>).map(row => row.model_id)
  }
  let counts: { total_entries: number; total_text_lines: number } | null = null
  if (shouldIncludeTotals) {
    const countSql = `SELECT COUNT(*) AS total_entries, COALESCE(SUM(text_lines), 0) AS total_text_lines
      FROM execution_log_projection AS p
      WHERE ${scopeClauses.join(' AND ')} AND ${DEBUG_VISIBLE_ROWS}`
    let countStatement = statements.queryPages.get(countSql)
    if (!countStatement) {
      countStatement = sqlite.prepare(countSql)
      statements.queryPages.set(countSql, countStatement)
    }
    counts = countStatement.get(...scopeParams) as { total_entries: number; total_text_lines: number }
  }
  let nativeCounts: { total_entries: number; total_text_lines: number } | null = null
  if (shouldIncludeTotals) {
    nativeCounts = nativeCountsForSnapshot(storage, nativeSnapshotKey, query.modelId)
  }
  const page = mergeDebugRows(rows, nativePage, query.limit + 1)
  const hasOlder = page.length > query.limit
  const visiblePage = page.slice(0, query.limit)
  const oldest = visiblePage.at(-1)
  return {
    entries: visiblePage.toReversed().map(row => row.entry),
    olderCursor: hasOlder && oldest ? Buffer.from(JSON.stringify({
      ordinal: oldest.ordinal,
      timestamp: oldest.timestamp,
      mirrorKey: oldest.sortKey,
      mirrorOccurrence: oldest.occurrence,
      nativeSnapshot: nativeSnapshotKey,
    })).toString('base64url') : null,
    hasOlder,
    ...(shouldIncludeTotals ? {
      totalEntries: Number(counts?.total_entries ?? 0) + Number(nativeCounts?.total_entries ?? 0),
      totalTextLines: Number(counts?.total_text_lines ?? 0) + Number(nativeCounts?.total_text_lines ?? 0),
      modelIds,
    } : {}),
  }
}

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
  if (query.view === 'debug') return queryDebugPage(storage, query, before, clauses, params)
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
  if (query.view === 'ai') { clauses.push(AI_VISIBLE_ROWS) }
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
      const rank = before.timestamp === '' ? 1 : 0
      pageClauses.push(`(
        ${AI_START_RANK} < ?
        OR (${AI_START_RANK} = ? AND ${AI_START_TIMESTAMP} < ?)
        OR (${AI_START_RANK} = ? AND ${AI_START_TIMESTAMP} = ? AND p.mirror_key < ?)
        OR (${AI_START_RANK} = ? AND ${AI_START_TIMESTAMP} = ? AND p.mirror_key = ? AND p.mirror_occurrence < ?)
      )`)
      pageParams.push(
        rank,
        rank, before.timestamp,
        rank, before.timestamp, before.mirrorKey,
        rank, before.timestamp, before.mirrorKey, before.mirrorOccurrence,
      )
    } else {
      pageClauses.push('ordinal < ?')
      pageParams.push(before.ordinal)
    }
  }
  const where = pageClauses.join(' AND ')
  const timestamp = query.view === 'ai' ? AI_START_TIMESTAMP : 'timestamp'
  const order = query.view === 'ai'
    ? `${AI_START_RANK} DESC, sort_timestamp DESC, p.mirror_key DESC, p.mirror_occurrence DESC`
    : 'ordinal DESC'
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
      if (query.view === 'ai') {
        if (row.sort_timestamp) entry.timestamp = row.sort_timestamp
        entry._logMirrorKey = row.mirror_key
        entry._logMirrorOccurrence = row.mirror_occurrence
      }
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pages: Array<Record<string, unknown>[]> = []
    let before: string | undefined
    try {
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
    } catch (error) {
      if (!isHistoricalLogCursorExpiredError(error) || attempt > 0) throw error
      // A cursor can expire while a long export walks older pages. Restart the
      // complete export once against one fresh manifest; never return the
      // already-collected prefix as if it were complete.
    }
  }
  throw new HistoricalLogCursorExpiredError()
}
