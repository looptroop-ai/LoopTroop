import { extractLogFingerprint, hasMatchingLogFingerprint } from '@shared/logIdentity'

export type PromptTimeoutKind = 'ai_response' | 'council_response' | 'per_iteration' | 'execution_setup' | 'opencode_prompt'

export interface LogEntry {
  id: string
  entryId: string
  fingerprint?: string
  line: string
  source: string
  status: string
  phaseAttempt?: number
  timestamp?: string
  audience: 'all' | 'ai' | 'debug'
  kind: string
  modelId?: string
  variant?: string
  sessionId?: string
  beadId?: string
  beadIteration?: number
  timeoutMs?: number
  deadlineAt?: string
  timeoutKind?: PromptTimeoutKind
  streaming: boolean
  op: 'append' | 'upsert' | 'finalize'
}

export type LogChannel = 'normal' | 'debug' | 'ai' | 'all'

export interface ServerLogScope {
  channel?: LogChannel
  status?: string
  phase?: string
  phaseAttempt?: number
  lifecycle?: boolean
}

export interface PlainLogOptions {
  source?: string
  status?: string
  timestamp?: string
  audience?: LogEntry['audience']
  kind?: string
  modelId?: string
  variant?: string
  sessionId?: string
  beadId?: string
  beadIteration?: number
  phaseAttempt?: number
  timeoutMs?: number
  deadlineAt?: string
  timeoutKind?: PromptTimeoutKind
  entryId?: string
  fingerprint?: string
  op?: LogEntry['op']
  streaming?: boolean
}

/**
 * The half of the log context that moves as rows arrive: the rows themselves, the
 * loading flags, and the two readers over them. The readers belong here rather than
 * with the actions because their identity is the signal a memo needs — it changes
 * when the rows change and at no other time, so `[getAllLogs]` recomputes a rendered
 * list per batch of lines instead of per render of the provider.
 */
export interface LogStateValue {
  logsByPhase: Record<string, LogEntry[]>
  activePhase: string | null
  isLoadingLogs: boolean
  getLogsForPhase: (phase: string, options?: { phaseAttempt?: number }) => LogEntry[]
  getAllLogs: () => LogEntry[]
  isLoadingLogScope?: (scope: ServerLogScope) => boolean
}

/**
 * The half that does not move. Every member keeps one identity for the lifetime of
 * the provider, so an effect may list it in a dependency array without re-running
 * when a line arrives — which is the whole reason the context is split.
 */
export interface LogActionsValue {
  addLog: (phase: string, line: string, options?: PlainLogOptions) => void
  addLogRecord: (phase: string, data: Record<string, unknown>) => void
  /** Reads the live phase from a ref, so a dispatcher never subscribes to the rows for it. */
  getActivePhase?: () => string | null
  setActivePhase: (phase: string | null) => void
  loadLogsForPhase?: (phase: string, options?: { channel?: LogChannel; phaseAttempt?: number }) => void
  loadAllLogs?: (options?: { channel?: LogChannel }) => void
  clearLogs: () => void
}

export type LogContextValue = LogStateValue & LogActionsValue

export const LOG_STORAGE_PREFIX = 'logs-v2-'
export const LEGACY_LOG_STORAGE_PREFIX = 'logs-'
export const SERVER_LOG_REFRESH_EVENT = 'looptroop:server-log-refresh'
export const INITIAL_LOG_PAGE_LIMIT = 20
export const OLDER_LOG_PAGE_LIMIT = 250

const LOG_TYPE_TAGS: Record<string, string> = {
  state_change: '[SYS]',
  model_output: '[MODEL]',
  test_result: '[TEST]',
  error: '[ERROR]',
  bead_complete: '[BEAD]',
  info: '[SYS]',
  debug: '[DEBUG]',
}

export const serverLogCache = new Map<string, Array<Record<string, unknown>>>()

function normalizeChannel(channel?: LogChannel): LogChannel {
  return channel === 'debug' || channel === 'ai' ? channel : 'normal'
}

export function getServerLogCacheKey(ticketId: string, scope: ServerLogScope = {}): string {
  const channel = normalizeChannel(scope.channel)
  const target = scope.lifecycle
    ? 'lifecycle'
    : scope.status
      ? `status:${scope.status}`
      : scope.phase
        ? `phase:${scope.phase}`
        : 'lifecycle'
  const attempt = typeof scope.phaseAttempt === 'number' && Number.isFinite(scope.phaseAttempt)
    ? `attempt:${scope.phaseAttempt}`
    : 'attempt:active'
  return `${ticketId}|${channel}|${target}|${attempt}`
}

export function getServerLogsUrl(ticketId: string, scope: ServerLogScope = {}): string {
  const params = new URLSearchParams({
    scope: scope.lifecycle ? 'lifecycle' : 'phase',
    view: scope.channel === 'debug' || scope.channel === 'all'
      ? 'debug'
      : scope.channel === 'ai'
        ? 'ai'
        : 'overview',
    limit: String(INITIAL_LOG_PAGE_LIMIT),
  })
  if (scope.status) params.set('phase', scope.status)
  if (scope.phase) params.set('phase', scope.phase)
  if (typeof scope.phaseAttempt === 'number' && Number.isFinite(scope.phaseAttempt)) {
    params.set('phaseAttempt', String(scope.phaseAttempt))
  }
  return `/api/tickets/${encodeURIComponent(ticketId)}/logs?${params.toString()}`
}

export function clearServerLogCache(ticketId: string) {
  serverLogCache.delete(ticketId)
  for (const key of Array.from(serverLogCache.keys())) {
    if (key.startsWith(`${ticketId}|`)) {
      serverLogCache.delete(key)
    }
  }
}

const LOW_VALUE_GIT_PROBE_PATTERNS = [
  ' symbolic-ref --quiet --short refs/remotes/origin/HEAD',
  ' rev-parse --abbrev-ref HEAD',
  ' show-ref --verify --quiet refs/heads/',
  ' show-ref --verify --quiet refs/remotes/origin/',
  ' diff --cached --quiet',
] as const

const AI_DETAIL_STORED_KINDS = new Set(['text', 'assistant', 'prompt', 'reasoning', 'tool', 'step', 'session', 'error'])

function stringifyForLine(value: unknown, maxLen = 2000): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    const raw = JSON.stringify(value)
    return raw.length > maxLen ? `${raw.slice(0, maxLen)}…[truncated]` : raw
  } catch {
    return String(value)
  }
}

function extractContent(data: Record<string, unknown>): string {
  const directCandidates = [data.content, data.message, data.text]
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }

  const nested = data.data && typeof data.data === 'object'
    ? (data.data as Record<string, unknown>)
    : null
  if (!nested) return ''

  const nestedCandidates = [nested.content, nested.message, nested.text]
  for (const candidate of nestedCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }

  return ''
}

function deriveSource(data: Record<string, unknown>): string {
  if (typeof data.source === 'string' && data.source) return data.source
  if (typeof data.modelId === 'string' && data.modelId) return `model:${data.modelId}`

  const nested = data.data && typeof data.data === 'object'
    ? (data.data as Record<string, unknown>)
    : null
  if (nested) {
    if (typeof nested.source === 'string' && nested.source) return nested.source
    if (typeof nested.modelId === 'string' && nested.modelId) return `model:${nested.modelId}`
  }

  const type = String(data.type ?? 'info')
  if (type === 'debug') return 'debug'
  if (type === 'error') return 'error'
  if (type === 'model_output') return 'opencode'
  return 'system'
}

function deriveAudience(data: Record<string, unknown>, source: string): LogEntry['audience'] {
  if (data.audience === 'all' || data.audience === 'ai' || data.audience === 'debug') return data.audience
  if (source === 'debug') return 'debug'
  if (source === 'opencode' || source.startsWith('model:')) return 'ai'
  return 'all'
}

function deriveKind(data: Record<string, unknown>, type: string, audience: LogEntry['audience']): string {
  if (typeof data.kind === 'string' && data.kind) return data.kind
  if (type === 'error') return 'error'
  if (type === 'test_result') return 'test'
  if (audience === 'ai') return type === 'model_output' ? 'text' : 'session'
  return 'milestone'
}

function deriveModelId(data: Record<string, unknown>, source: string): string | undefined {
  if (typeof data.modelId === 'string' && data.modelId) return data.modelId
  if (source.startsWith('model:')) return source.slice('model:'.length)

  const nested = data.data && typeof data.data === 'object'
    ? (data.data as Record<string, unknown>)
    : null
  if (typeof nested?.modelId === 'string' && nested.modelId) return nested.modelId
  return undefined
}

function deriveOperation(data: Record<string, unknown>): LogEntry['op'] {
  if (data.op === 'append' || data.op === 'upsert' || data.op === 'finalize') return data.op
  return 'append'
}

function deriveTimeoutKind(data: Record<string, unknown>): PromptTimeoutKind | undefined {
  if (
    data.timeoutKind === 'ai_response' ||
    data.timeoutKind === 'council_response' ||
    data.timeoutKind === 'per_iteration' ||
    data.timeoutKind === 'execution_setup' ||
    data.timeoutKind === 'opencode_prompt'
  ) {
    return data.timeoutKind
  }
  return undefined
}

function normalizePhaseAttempt(value: unknown): number | undefined {
  const phaseAttempt = typeof value === 'number' && Number.isFinite(value)
    ? value
    : Number(value)
  return Number.isFinite(phaseAttempt) && phaseAttempt > 0 ? phaseAttempt : undefined
}

function normalizePositiveNumber(value: unknown): number | undefined {
  const normalized = typeof value === 'number' && Number.isFinite(value)
    ? value
    : Number(value)
  return Number.isFinite(normalized) && normalized > 0 ? normalized : undefined
}

function formatLine(type: string, kind: string, content: string, fallback: unknown): string {
  if (kind === 'reasoning' && content) {
    return content
  }
  const tag = LOG_TYPE_TAGS[type] || '[SYS]'
  if (content) {
    return /^\[[A-Z_]+\]/.test(content.trim()) ? content : `${tag} ${content}`
  }
  return `${tag} ${stringifyForLine(fallback)}`
}

export function fallbackEntryId(status: string, source: string, timestamp: string | undefined, line: string): string {
  return `${status}:${source}:${timestamp ?? 'no-ts'}:${line}`
}

export function normalizeLogRecord(data: Record<string, unknown>, fallbackPhase: string): LogEntry {
  const type = String(data.type ?? 'info')
  const source = deriveSource(data)
  const audience = deriveAudience(data, source)
  const kind = deriveKind(data, type, audience)
  const status = String(data.status ?? data.phase ?? fallbackPhase)
  const timestamp = typeof data.timestamp === 'string' ? data.timestamp : undefined
  const fingerprint = extractLogFingerprint(data)
  const line = formatLine(type, kind, extractContent(data), data)
  const entryId = typeof data.entryId === 'string' && data.entryId
    ? data.entryId
    : fallbackEntryId(status, source, timestamp, line)
  const modelId = deriveModelId(data, source)
  const nested = data.data && typeof data.data === 'object'
    ? (data.data as Record<string, unknown>)
    : null
  const variant = typeof data.variant === 'string' && data.variant.trim()
    ? data.variant
    : typeof nested?.variant === 'string' && nested.variant.trim()
      ? nested.variant
      : undefined
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined
  const beadId = typeof data.beadId === 'string' ? data.beadId : undefined
  const beadIteration = normalizePositiveNumber(data.beadIteration ?? nested?.beadIteration)
  const timeoutMs = typeof data.timeoutMs === 'number' && Number.isFinite(data.timeoutMs)
    ? data.timeoutMs
    : undefined
  const deadlineAt = typeof data.deadlineAt === 'string' && data.deadlineAt
    ? data.deadlineAt
    : undefined
  const timeoutKind = deriveTimeoutKind(data)
  const op = deriveOperation(data)
  const streaming = typeof data.streaming === 'boolean' ? data.streaming : op !== 'append'
  const phaseAttempt = normalizePhaseAttempt(data.phaseAttempt)

  return {
    id: entryId,
    entryId,
    line,
    source,
    status,
    ...(phaseAttempt !== undefined ? { phaseAttempt } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    audience,
    kind,
    ...(modelId ? { modelId } : {}),
    ...(variant ? { variant } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(beadId ? { beadId } : {}),
    ...(beadIteration !== undefined ? { beadIteration } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(deadlineAt ? { deadlineAt } : {}),
    ...(timeoutKind ? { timeoutKind } : {}),
    streaming,
    op,
  }
}

export function normalizeStoredEntry(entry: Partial<LogEntry>, fallbackStatus: string): LogEntry {
  const rawKind = typeof entry.kind === 'string' ? entry.kind : undefined
  const hasModelIdentity = Boolean(entry.modelId || entry.sessionId)
  const shouldRestoreAiDetailShape = hasModelIdentity && rawKind != null && AI_DETAIL_STORED_KINDS.has(rawKind)
  const source = String(entry.source ?? (shouldRestoreAiDetailShape ? (entry.modelId ? `model:${String(entry.modelId)}` : 'opencode') : 'system'))
  const status = String(entry.status ?? fallbackStatus)
  const line = String(entry.line ?? '')
  const timestamp = entry.timestamp ? String(entry.timestamp) : undefined
  const fingerprint = extractLogFingerprint(entry as Record<string, unknown>)
  const timeoutMs = typeof entry.timeoutMs === 'number' && Number.isFinite(entry.timeoutMs)
    ? entry.timeoutMs
    : undefined
  const deadlineAt = typeof entry.deadlineAt === 'string' && entry.deadlineAt
    ? entry.deadlineAt
    : undefined
  const timeoutKind = deriveTimeoutKind(entry as Record<string, unknown>)
  const phaseAttempt = normalizePhaseAttempt(entry.phaseAttempt)
  const beadIteration = normalizePositiveNumber(entry.beadIteration)
  const audience = entry.audience === 'all' || entry.audience === 'ai' || entry.audience === 'debug'
    ? entry.audience
    : source === 'debug'
      ? 'debug'
      : source === 'opencode' || source.startsWith('model:')
        ? 'ai'
        : shouldRestoreAiDetailShape
          ? 'ai'
          : 'all'
  const entryId = String(entry.entryId ?? entry.id ?? fallbackEntryId(status, source, timestamp, line))

  return {
    id: entryId,
    entryId,
    line,
    source,
    status,
    ...(phaseAttempt !== undefined ? { phaseAttempt } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    audience,
    kind: String(rawKind ?? (audience === 'ai' ? 'text' : 'milestone')),
    ...(entry.modelId ? { modelId: String(entry.modelId) } : {}),
    ...(entry.variant ? { variant: String(entry.variant) } : {}),
    ...(entry.sessionId ? { sessionId: String(entry.sessionId) } : {}),
    ...(entry.beadId ? { beadId: String(entry.beadId) } : {}),
    ...(beadIteration !== undefined ? { beadIteration } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(deadlineAt ? { deadlineAt } : {}),
    ...(timeoutKind ? { timeoutKind } : {}),
    streaming: Boolean(entry.streaming),
    op: entry.op === 'upsert' || entry.op === 'finalize' ? entry.op : 'append',
  }
}

export function isDebugLogEntry(entry: Pick<LogEntry, 'audience' | 'source' | 'line'>): boolean {
  return entry.audience === 'debug' || entry.source === 'debug' || entry.line.includes('[DEBUG]')
}

export function compareTimestamps(a?: string, b?: string): number {
  const at = a ? Date.parse(a) : Number.NaN
  const bt = b ? Date.parse(b) : Number.NaN
  if (Number.isNaN(at) && Number.isNaN(bt)) return 0
  if (Number.isNaN(at)) return 1
  if (Number.isNaN(bt)) return -1
  return at - bt
}

function timestampDistanceMs(a?: string, b?: string): number | null {
  const at = a ? Date.parse(a) : Number.NaN
  const bt = b ? Date.parse(b) : Number.NaN
  if (Number.isNaN(at) || Number.isNaN(bt)) return null
  return Math.abs(at - bt)
}

/**
 * Two rows are the same moment only when both actually carry one. `compareTimestamps`
 * answers `0` for a pair it could not parse as well, because it exists to order rows and
 * undated ones have no order — but read as equality that says two unrelated events with
 * the same text are one event, and the second is dropped. Rows that really are identical
 * still collapse: an undated entry's fallback id is built from its own text.
 */
function isSameLogMoment(a?: string, b?: string): boolean {
  return timestampDistanceMs(a, b) === 0
}

function isWithinLogMoments(a: string | undefined, b: string | undefined, toleranceMs: number): boolean {
  const distance = timestampDistanceMs(a, b)
  return distance !== null && distance <= toleranceMs
}

/**
 * Row identity for folding pages or overlaying live rows onto restored ones.
 *
 * Scoped by phase attempt because entry ids are only unique within one: a retried
 * phase re-emits its milestones under the same `milestone:<phase>:started` id, and
 * keying on the bare id folds two archived attempts into a single row. Entries from
 * before attempts were recorded share the `active` namespace, which is the bare id.
 */
export function getLogEntryIdentity(entry: LogEntry): string {
  return `id:${entry.phaseAttempt ?? 'active'}:${entry.entryId}`
}

export function isCommandLine(line: string): boolean {
  return line.startsWith('[CMD] $ ')
}

export function isLowValueGitProbeLine(line: string): boolean {
  return isCommandLine(line)
    && line.includes('$ git ')
    && LOW_VALUE_GIT_PROBE_PATTERNS.some((pattern) => line.includes(pattern))
}

export function isBenignGitProbeErrorLine(line: string): boolean {
  if (!isLowValueGitProbeLine(line)) return false

  if (line.includes('origin/HEAD not set') || line.includes('ref not found')) {
    return true
  }

  if (line.includes(' diff --cached --quiet')) {
    return line.includes('staged changes present') || line.includes('error: exit code 1')
  }

  return false
}

export function mergeEntry(bucket: LogEntry[], entry: LogEntry): LogEntry[] {
  const sameAttempt = (existing: LogEntry) => existing.phaseAttempt === entry.phaseAttempt
  const hasSameIdentity = (existing: LogEntry) => hasMatchingLogFingerprint(existing, entry) || existing.entryId === entry.entryId
  const legacyExistingIndex = entry.phaseAttempt !== undefined
    ? bucket.findIndex(existing => existing.phaseAttempt === undefined && hasSameIdentity(existing))
    : -1
  let existingIndex = bucket.findIndex(existing => sameAttempt(existing) && hasSameIdentity(existing))
  if (existingIndex === -1 && legacyExistingIndex >= 0) {
    existingIndex = legacyExistingIndex
  }

  if (entry.op === 'append') {
    if (existingIndex >= 0) {
      const existing = bucket[existingIndex]!
      const isTextFallbackForStreamingEntry =
        existing.kind === 'text'
        && entry.kind === 'text'
        && existing.source === entry.source
        && existing.status === entry.status
        && existing.line === entry.line
        && existing.streaming

      if (isTextFallbackForStreamingEntry) {
        const next = [...bucket]
        next[existingIndex] = {
          ...existing,
          ...entry,
          // A terminal non-streaming fallback append should stop the UI stream state
          // even if a later finalize for the same canonical row still arrives.
          streaming: false,
        }
        return next
      }

      if (legacyExistingIndex === existingIndex) {
        const next = [...bucket]
        next[existingIndex] = {
          ...existing,
          ...entry,
          timestamp: existing.timestamp ?? entry.timestamp,
        }
        return next
      }

      if (hasMatchingLogFingerprint(existing, entry)) {
        return bucket
      }
    }

    const isDuplicate = bucket.some(existing =>
      sameAttempt(existing)
      && (hasMatchingLogFingerprint(existing, entry)
      || (
        existing.line === entry.line
        && existing.source === entry.source
        && existing.status === entry.status
        && (
          existing.entryId === entry.entryId
          || isSameLogMoment(existing.timestamp, entry.timestamp)
          || (
            isLowValueGitProbeLine(existing.line)
            && isLowValueGitProbeLine(entry.line)
            && isWithinLogMoments(existing.timestamp, entry.timestamp, 2000)
          )
        )
      )))
    if (isDuplicate) return bucket

    return [...bucket, entry]
  }

  if (existingIndex === -1) return [...bucket, entry]

  const next = [...bucket]
  next[existingIndex] = {
    ...next[existingIndex],
    ...entry,
    // Preserve the original start timestamp — streaming upserts and finalize
    // events carry a fresh server timestamp, but the UI should always display
    // when the entry first appeared, not when it was last updated.
    timestamp: next[existingIndex]!.timestamp ?? entry.timestamp,
    streaming: entry.op === 'finalize' ? false : entry.streaming,
  }
  return next
}

/**
 * Merges a restored page and live rows in one indexed pass. Incoming rows win
 * for canonical upserts/finalization, while the original start timestamp is
 * retained. This function is deliberately side-effect free: restored rows
 * never pass through the live persistence or broadcast path.
 */
export function mergeEntriesBatch(base: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  if (base.length === 0) return incoming.slice().sort((a, b) => compareTimestamps(a.timestamp, b.timestamp))
  if (incoming.length === 0) return base.slice().sort((a, b) => compareTimestamps(a.timestamp, b.timestamp))

  const result: LogEntry[] = []
  const indexes = new Map<string, number>()
  const aliases = (entry: LogEntry) => [
    getLogEntryIdentity(entry),
    ...(entry.fingerprint ? [`fp:${entry.phaseAttempt ?? 'active'}:${entry.fingerprint}`] : []),
  ]
  const add = (entry: LogEntry, incomingRow: boolean) => {
    const keys = aliases(entry)
    const index = keys.map(key => indexes.get(key)).find((value): value is number => value !== undefined)
    if (index === undefined) {
      const nextIndex = result.length
      result.push(entry)
      for (const key of keys) indexes.set(key, nextIndex)
      return
    }

    if (!incomingRow) return
    const existing = result[index]!
    const merged: LogEntry = {
      ...existing,
      ...entry,
      timestamp: existing.timestamp ?? entry.timestamp,
      streaming: entry.op === 'finalize' ? false : entry.streaming,
    }
    result[index] = merged
    for (const key of aliases(merged)) indexes.set(key, index)
  }

  for (const entry of base) add(entry, false)
  for (const entry of incoming) add(entry, true)
  return result.sort((a, b) => compareTimestamps(a.timestamp, b.timestamp))
}

export function formatLogLine(data: Record<string, unknown>): { line: string; source: string } {
  const normalized = normalizeLogRecord(data, String(data.status ?? data.phase ?? 'unknown'))
  return { line: normalized.line, source: normalized.source }
}

export function clearPersistedTicketLogs(ticketId: string) {
  clearServerLogCache(ticketId)

  if (typeof window === 'undefined') return

  const prefixes = [`${LOG_STORAGE_PREFIX}${ticketId}-`, `${LEGACY_LOG_STORAGE_PREFIX}${ticketId}-`]
  const keysToRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && prefixes.some(prefix => key.startsWith(prefix))) {
      keysToRemove.push(key)
    }
  }
  keysToRemove.forEach(key => localStorage.removeItem(key))
}
