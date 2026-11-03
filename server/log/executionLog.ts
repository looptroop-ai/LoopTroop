import type { LogEvent, LogEventType, LogSource } from './types'
import { safeAtomicAppendWithin } from '../io/atomicAppend'
import { getTicketStorageContext } from '../storage/tickets'
import { resolvePhaseAttempt } from '../storage/ticketPhaseAttempts'
import { queueProjectionAppend, resolveTicketLogPath, type PersistedLogChannel, type TicketLogStorage } from './projection'
import { compactLogEntryForStorage } from './storedEntry'
import type { WorkflowPhaseId } from '@shared/workflowMeta'
import { relative } from 'node:path'
import { resolveContainedPath } from '../lib/containedPath'

type StructuredLogFields = Omit<LogEvent, 'timestamp' | 'type' | 'ticketId' | 'phase' | 'message' | 'source' | 'status' | 'data'>

// Keys that are promoted to top-level LogEvent fields by pickStructuredFields.
// They are stripped from `data` before serialization to avoid redundant storage.
const STRUCTURED_KEYS: ReadonlySet<string> = new Set([
  'content', 'source', 'status', 'entryId', 'fingerprint', 'op', 'audience',
  'kind', 'modelId', 'variant', 'sessionId', 'beadId', 'beadIteration', 'timeoutMs', 'deadlineAt',
  'timeoutKind', 'streaming', 'phaseAttempt',
])

// Internal-only keys that should never be persisted in the log file.
const INTERNAL_KEYS: ReadonlySet<string> = new Set([
  'suppressDebugMirror',
  'timestamp',
])
const DEFAULT_PHASE_ATTEMPT = 1
const UPSERT_LOG_OPERATION = 'upsert'

function pickStructuredFields(data?: Record<string, unknown>): Partial<LogEvent> {
  if (!data) return {}
  return {
    ...(typeof data.content === 'string' ? { content: data.content } : {}),
    ...(typeof data.source === 'string' ? { source: data.source as LogSource } : {}),
    ...(typeof data.status === 'string' ? { status: data.status } : {}),
    ...(typeof data.entryId === 'string' ? { entryId: data.entryId } : {}),
    ...(typeof data.fingerprint === 'string' ? { fingerprint: data.fingerprint } : {}),
    ...(typeof data.op === 'string' ? { op: data.op as LogEvent['op'] } : {}),
    ...(typeof data.audience === 'string' ? { audience: data.audience as LogEvent['audience'] } : {}),
    ...(typeof data.kind === 'string' ? { kind: data.kind as LogEvent['kind'] } : {}),
    ...(typeof data.modelId === 'string' ? { modelId: data.modelId } : {}),
    ...(typeof data.variant === 'string' ? { variant: data.variant } : {}),
    ...(typeof data.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
    ...(typeof data.beadId === 'string' ? { beadId: data.beadId } : {}),
    ...(typeof data.beadIteration === 'number' && Number.isFinite(data.beadIteration) ? { beadIteration: data.beadIteration } : {}),
    ...(typeof data.timeoutMs === 'number' && Number.isFinite(data.timeoutMs) ? { timeoutMs: data.timeoutMs } : {}),
    ...(typeof data.deadlineAt === 'string' ? { deadlineAt: data.deadlineAt } : {}),
    ...(typeof data.timeoutKind === 'string' ? { timeoutKind: data.timeoutKind as LogEvent['timeoutKind'] } : {}),
    ...(typeof data.streaming === 'boolean' ? { streaming: data.streaming } : {}),
    ...(typeof data.phaseAttempt === 'number' && Number.isFinite(data.phaseAttempt) ? { phaseAttempt: data.phaseAttempt } : {}),
  }
}

/**
 * Strip redundant and internal-only keys from the data object before
 * persisting. Structured fields are already promoted to top-level event
 * properties; keeping them in `data` doubles storage for every entry.
 */
function cleanDataForPersistence(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined
  const cleaned: Record<string, unknown> = {}
  let hasKeys = false
  for (const [key, value] of Object.entries(data)) {
    if (STRUCTURED_KEYS.has(key) || INTERNAL_KEYS.has(key)) continue
    cleaned[key] = value
    hasKeys = true
  }
  return hasKeys ? cleaned : undefined
}

function isDebugEvent(event: Pick<LogEvent, 'type' | 'source' | 'audience'>): boolean {
  return event.type === 'debug' || event.source === 'debug' || event.audience === 'debug'
}

function isAiDetailEvent(event: Pick<LogEvent, 'audience' | 'type' | 'source'>): boolean {
  return !isDebugEvent(event) && event.audience === 'ai'
}

function isDebugLogInput(type: LogEventType, source?: LogSource, extra?: Partial<StructuredLogFields>): boolean {
  return type === 'debug' || source === 'debug' || extra?.audience === 'debug'
}

function resolvePhaseAttemptSafely(
  ticketId: string,
  phase: WorkflowPhaseId,
  phaseAttempt?: number,
): number {
  if (typeof phaseAttempt === 'number' && Number.isFinite(phaseAttempt) && phaseAttempt > 0) {
    return phaseAttempt
  }
  try {
    return resolvePhaseAttempt(ticketId, phase, phaseAttempt)
  } catch {
    return DEFAULT_PHASE_ATTEMPT
  }
}

/*
 * ── LOG SIZE BUDGET ──────────────────────────────────────────────────────
 *
 * The execution-log.jsonl, execution-log.debug.jsonl, and execution-log.ai.jsonl
 * files are preserved as audit/debug evidence and are never automatically
 * truncated. To keep normal logs from growing unbounded:
 *
 * 1. STREAMING UPSERTS ARE NOT PERSISTED AT ALL. Intermediate streaming
 *    snapshots (op='upsert' + streaming=true, with an entryId) are delivered to
 *    the UI over SSE and written to no file — not the normal log and not the AI
 *    detail log, because `appendLogEvent` returns before reaching either. Only
 *    the final 'finalize' event is written, and that is what restores the AI tab
 *    when a ticket is reopened. Without this split, a 5-minute streaming
 *    session produces ~90 progressive snapshots with quadratic content growth
 *    in the normal lifecycle log.
 *
 * 2. DEBUG MIRROR ENTRIES ARE NOT PERSISTED. emitPhaseLog() auto-creates a
 *    debug copy of every non-debug log entry. These mirrors are broadcast
 *    via SSE for the real-time DEBUG tab but are NOT written to disk. Direct
 *    emitDebugLog() calls (e.g., opencode response logging) still persist to
 *    execution-log.debug.jsonl. See the `persist` parameter on emitDebugLog in
 *    helpers.ts.
 *
 * 3. REDUNDANT DATA FIELDS ARE STRIPPED. Structured fields already promoted
 *    to top-level event properties (entryId, sessionId, etc.) and internal
 *    flags (suppressDebugMirror) are removed from `data` before serializing.
 *
 * 4. EACH TEXT IS STORED ONCE. `content` is left out when it equals `message`,
 *    and a debug line keeps its plain-object payload only in `data` (flagged
 *    `payloadInData`). Every reader expands lines back to the full shape with
 *    expandStoredLogEntry (storedEntry.ts). This halves the normal and AI logs
 *    and cuts the debug log to about a third.
 *
 * The real-time log viewer is unaffected because it receives all events via
 * SSE, which is independent of disk persistence.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function appendLogEvent(
  ticketId: string,
  type: LogEventType,
  phase: WorkflowPhaseId,
  message: string,
  data?: Record<string, unknown>,
  source?: LogSource,
  status?: string,
  extra?: Partial<StructuredLogFields>,
) {
  const isDebugLog = isDebugLogInput(type, source, extra)
  const structured: Partial<LogEvent> = isDebugLog ? {} : pickStructuredFields(data)
  // Streaming upserts are NOT persisted — only delivered via SSE (see budget
  // note above). The finalize event carries the complete final content.
  // Decided first, from the same merge the event uses: a streaming model sends
  // up to 100 of these a second, and resolving the ticket for each one took a
  // fifth of the server's time while models were writing.
  const routing: Partial<LogEvent> = { ...structured, ...extra }
  if (routing.op === UPSERT_LOG_OPERATION && routing.streaming && routing.entryId) {
    return
  }
  const timestamp = typeof data?.timestamp === 'string' ? data.timestamp : new Date().toISOString()
  const phaseAttempt = extra?.phaseAttempt
    ?? structured.phaseAttempt
    ?? resolvePhaseAttemptSafely(ticketId, phase, typeof data?.phaseAttempt === 'number' ? data.phaseAttempt : undefined)
  const event: LogEvent = {
    timestamp,
    type,
    ticketId,
    phase,
    phaseAttempt,
    message,
    content: !isDebugLog && typeof data?.content === 'string' ? data.content : message,
    ...(source != null ? { source } : structured.source ? { source: structured.source } : {}),
    ...(status != null ? { status } : structured.status ? { status: structured.status } : {}),
    ...structured,
    ...extra,
  }
  event.data = isDebugEvent(event) ? data : cleanDataForPersistence(data)

  const fingerprint = typeof event.fingerprint === 'string' && event.fingerprint
    ? event.fingerprint
    : undefined

  // Only the storage location: the full ticket paths also resolve the worktree,
  // setup and beads paths and read the ticket metadata, none of which an append uses.
  const storage = getTicketStorageContext(ticketId)
  if (!storage) {
    throw new Error(`Ticket not found for execution log append: ${ticketId}`)
  }
  const primaryChannel: PersistedLogChannel = isDebugEvent(event) ? 'debug' : 'normal'

  if (isAiDetailEvent(event)) {
    appendEventToChannel(ticketId, storage, 'ai', event, phase, phaseAttempt, fingerprint)
  }

  appendEventToChannel(ticketId, storage, primaryChannel, event, phase, phaseAttempt, fingerprint)
}

const MAX_PERSISTED_FINGERPRINTS_PER_TICKET = 256
const MAX_FINGERPRINT_TICKETS = 100
const persistedFingerprintsByTicket = new Map<string, Map<string, number>>()

function appendEventToChannel(
  ticketId: string,
  storage: TicketLogStorage,
  channel: PersistedLogChannel,
  event: LogEvent,
  phase: WorkflowPhaseId,
  phaseAttempt: number,
  fingerprint?: string,
): void {
  if (fingerprint && hasPersistedFingerprint(ticketId, channel, phase, phaseAttempt, fingerprint)) {
    return
  }

  const logPath = resolveTicketLogPath(storage, channel)
  // Each text is written once; readers expand the line (server/log/storedEntry.ts).
  // The projection gets the same compact object, so live indexing and a catch-up
  // from disk see identical input.
  const stored = compactLogEntryForStorage(event as unknown as Record<string, unknown>)
  const serialized = JSON.stringify(stored)
  const canonicalRoot = resolveContainedPath(storage.projectRoot, '.')
  const range = safeAtomicAppendWithin(canonicalRoot, relative(canonicalRoot, logPath), serialized)
  queueProjectionAppend(ticketId, channel, stored, range.offset, range.length)
  if (fingerprint) {
    rememberPersistedFingerprint(ticketId, channel, phase, phaseAttempt, fingerprint)
  }
}

function buildFingerprintScopeKey(channel: 'emit' | PersistedLogChannel, phase: WorkflowPhaseId, phaseAttempt: number, fingerprint: string): string {
  return `${channel}:${phase}:${phaseAttempt}:${fingerprint}`
}

function hasPersistedFingerprint(ticketId: string, channel: 'emit' | PersistedLogChannel, phase: WorkflowPhaseId, phaseAttempt: number, fingerprint: string): boolean {
  const key = buildFingerprintScopeKey(channel, phase, phaseAttempt, fingerprint)
  return persistedFingerprintsByTicket.get(ticketId)?.has(key) ?? false
}

function rememberPersistedFingerprint(ticketId: string, channel: 'emit' | PersistedLogChannel, phase: WorkflowPhaseId, phaseAttempt: number, fingerprint: string): void {
  // Evict oldest ticket buckets if the outer map exceeds max size
  if (!persistedFingerprintsByTicket.has(ticketId) && persistedFingerprintsByTicket.size >= MAX_FINGERPRINT_TICKETS) {
    const oldestTicketKey = persistedFingerprintsByTicket.keys().next().value
    if (oldestTicketKey !== undefined) persistedFingerprintsByTicket.delete(oldestTicketKey)
  }

  const bucket = persistedFingerprintsByTicket.get(ticketId) ?? new Map<string, number>()
  const scopedKey = buildFingerprintScopeKey(channel, phase, phaseAttempt, fingerprint)
  if (bucket.has(scopedKey)) {
    bucket.delete(scopedKey)
  }
  bucket.set(scopedKey, Date.now())

  while (bucket.size > MAX_PERSISTED_FINGERPRINTS_PER_TICKET) {
    const oldest = bucket.keys().next().value
    if (!oldest) break
    bucket.delete(oldest)
  }

  persistedFingerprintsByTicket.set(ticketId, bucket)
}

export function clearTicketFingerprints(ticketId: string): void {
  persistedFingerprintsByTicket.delete(ticketId)
}

export function shouldSkipLogEmission(
  ticketId: string,
  type: LogEventType,
  phase: WorkflowPhaseId,
  message: string,
  data?: Record<string, unknown>,
  source?: LogSource,
  status?: string,
  extra?: Partial<StructuredLogFields>,
): boolean {
  const event = createLogEvent(ticketId, type, phase, message, data, source, status, extra)
  const phaseAttempt = event.phaseAttempt ?? DEFAULT_PHASE_ATTEMPT
  const fingerprint = typeof event.fingerprint === 'string' && event.fingerprint
    ? event.fingerprint
    : undefined

  if (fingerprint && hasPersistedFingerprint(ticketId, 'emit', phase, phaseAttempt, fingerprint)) {
    return true
  }

  if (fingerprint) {
    rememberPersistedFingerprint(ticketId, 'emit', phase, phaseAttempt, fingerprint)
  }

  return false
}

export function createLogEvent(
  ticketId: string,
  type: LogEventType,
  phase: WorkflowPhaseId,
  message: string,
  data?: Record<string, unknown>,
  source?: LogSource,
  status?: string,
  extra?: Partial<StructuredLogFields>,
): LogEvent {
  const isDebugLog = isDebugLogInput(type, source, extra)
  const structured: Partial<LogEvent> = isDebugLog ? {} : pickStructuredFields(data)
  const timestamp = typeof data?.timestamp === 'string' ? data.timestamp : new Date().toISOString()
  const phaseAttempt = extra?.phaseAttempt
    ?? structured.phaseAttempt
    ?? resolvePhaseAttemptSafely(ticketId, phase, typeof data?.phaseAttempt === 'number' ? data.phaseAttempt : undefined)
  return {
    timestamp,
    type,
    ticketId,
    phase,
    phaseAttempt,
    message,
    content: !isDebugLog && typeof data?.content === 'string' ? data.content : message,
    ...(source != null ? { source } : structured.source ? { source: structured.source } : {}),
    ...(status != null ? { status } : structured.status ? { status: structured.status } : {}),
    data,
    ...structured,
    ...extra,
  }
}
