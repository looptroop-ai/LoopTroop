import { broadcaster } from '../../sse/broadcaster'
import { appendLogEvent, createLogEvent, shouldSkipLogEmission } from '../../log/executionLog'
import type { LogEventType, LogSource } from '../../log/types'
import { db as appDb } from '../../db/index'
import { profiles } from '../../db/schema'
import { PROFILE_DEFAULTS } from '../../db/defaults'
import type { StructuredLogFields, StructuredLogAudience, StructuredLogKind, StructuredLogOp } from './types'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

// ── Cached tool log limits from profile ──────────────────────────────────────

export interface ToolLogLimits {
  inputMaxChars: number
  outputMaxChars: number
  errorMaxChars: number
}

const DEFAULT_TOOL_LOG_LIMITS: ToolLogLimits = {
  inputMaxChars: PROFILE_DEFAULTS.toolInputMaxChars,
  outputMaxChars: PROFILE_DEFAULTS.toolOutputMaxChars,
  errorMaxChars: PROFILE_DEFAULTS.toolErrorMaxChars,
}

export const STREAMING_LOG_MIN_INTERVAL_MS = 10
const LIVE_DEBUG_LOG_MAX_CHARS = 8000

let _cachedToolLogLimits: ToolLogLimits = { ...DEFAULT_TOOL_LOG_LIMITS }
let _toolLogLimitsCachedAt = 0
const TOOL_LOG_LIMITS_CACHE_TTL_MS = 30_000

/**
 * Returns the tool log truncation limits from the profile, cached for 30 seconds
 * to avoid a DB read on every stream event.
 */
export function getToolLogLimits(): ToolLogLimits {
  const now = Date.now()
  if (now - _toolLogLimitsCachedAt < TOOL_LOG_LIMITS_CACHE_TTL_MS) {
    return _cachedToolLogLimits
  }
  try {
    const profile = appDb.select().from(profiles).get()
    _cachedToolLogLimits = {
      inputMaxChars: profile?.toolInputMaxChars ?? DEFAULT_TOOL_LOG_LIMITS.inputMaxChars,
      outputMaxChars: profile?.toolOutputMaxChars ?? DEFAULT_TOOL_LOG_LIMITS.outputMaxChars,
      errorMaxChars: profile?.toolErrorMaxChars ?? DEFAULT_TOOL_LOG_LIMITS.errorMaxChars,
    }
  } catch {
    // DB read failed — keep using previous cached values.
  }
  _toolLogLimitsCachedAt = now
  return _cachedToolLogLimits
}

export function emitPhaseLog(
  ticketId: string,
  _ticketExternalId: string,
  phase: WorkflowPhaseId,
  type: LogEventType,
  content: string,
  data?: Record<string, unknown>,
) {
  const source = typeof data?.source === 'string' ? data.source : undefined
  const suppressDebugMirror = data?.suppressDebugMirror === true
  const structuredExtra = {
    ...(typeof data?.entryId === 'string' ? { entryId: data.entryId } : {}),
    ...(typeof data?.fingerprint === 'string' ? { fingerprint: data.fingerprint } : {}),
    ...(typeof data?.op === 'string' ? { op: data.op as StructuredLogOp } : {}),
    ...(typeof data?.audience === 'string' ? { audience: data.audience as StructuredLogAudience } : {}),
    ...(typeof data?.kind === 'string' ? { kind: data.kind as StructuredLogKind } : {}),
    ...(typeof data?.modelId === 'string' ? { modelId: data.modelId } : {}),
    ...(typeof data?.variant === 'string' ? { variant: data.variant } : {}),
    ...(typeof data?.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
    ...(typeof data?.beadId === 'string' ? { beadId: data.beadId } : {}),
    ...(typeof data?.beadIteration === 'number' && Number.isFinite(data.beadIteration) ? { beadIteration: data.beadIteration } : {}),
    ...(typeof data?.streaming === 'boolean' ? { streaming: data.streaming } : {}),
    ...(typeof data?.phaseAttempt === 'number' && Number.isFinite(data.phaseAttempt) ? { phaseAttempt: data.phaseAttempt } : {}),
  }
  const timestamp = new Date().toISOString()
  const emissionData = data ? { ...data, timestamp } : { timestamp }
  if (shouldSkipLogEmission(ticketId, type, phase, content, emissionData, source as LogSource | undefined, phase, structuredExtra)) {
    return
  }

  const event = createLogEvent(
    ticketId,
    type,
    phase,
    content,
    emissionData,
    source as LogSource | undefined,
    phase,
    structuredExtra,
  )
  broadcaster.broadcast(ticketId, 'log', { ...event })
  appendLogEvent(
    ticketId,
    type,
    phase,
    content,
    emissionData,
    source as LogSource | undefined,
    phase,
    structuredExtra,
  )
  // Debug mirrors are broadcast via SSE for the real-time DEBUG tab but NOT
  // persisted to disk — they are near-identical copies of the original entry
  // and account for ~55% of log file bloat. See LOG SIZE BUDGET in executionLog.ts.
  if (type !== 'debug' && !suppressDebugMirror) {
    emitDebugLog(
      ticketId,
      phase,
      `app.${type}`,
      {
        content,
        ...(data ? { data } : {}),
        ...(typeof event.phaseAttempt === 'number' ? { phaseAttempt: event.phaseAttempt } : {}),
      },
      false,
    )
  }
}

export function buildBeadLogFields(beadId?: string, beadIteration?: number): Pick<StructuredLogFields, 'beadId' | 'beadIteration'> {
  return {
    ...(beadId ? { beadId } : {}),
    ...(typeof beadIteration === 'number' && Number.isFinite(beadIteration) ? { beadIteration } : {}),
  }
}

export function emitModelSystemLog(
  ticketId: string,
  ticketExternalId: string,
  phase: WorkflowPhaseId,
  type: LogEventType,
  content: string,
  modelId: string,
  extra?: Record<string, unknown>,
) {
  emitPhaseLog(ticketId, ticketExternalId, phase, type, content, {
    ...(extra ?? {}),
    source: 'system',
    modelId,
  })
}

/**
 * Emit a debug-level log entry.
 *
 * @param persist  Whether to write this entry to the persistent execution log
 *   file. Defaults to `true` for direct calls (unique debug data such as raw
 *   AI responses). Mirror calls from emitPhaseLog pass `false` so the entry
 *   is only broadcast via SSE for the real-time DEBUG tab — this prevents
 *   near-duplicate entries from bloating the log file.
 *   See LOG SIZE BUDGET comment in executionLog.ts.
 */
export function emitDebugLog(
  ticketId: string,
  phase: WorkflowPhaseId,
  message: string,
  payload?: unknown,
  persist = true,
) {
  const payloadText = payload === undefined ? '' : ` ${stringifyForLog(payload)}`
  const content = `[DEBUG] ${message}${payloadText}`
  const liveContent = content.length > LIVE_DEBUG_LOG_MAX_CHARS
    ? `${content.slice(0, LIVE_DEBUG_LOG_MAX_CHARS)}\n... [debug payload truncated for live stream; full entry is available in the debug log]`
    : content
  const debugData = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)
    : (payload !== undefined ? { value: payload } : undefined)
  const timestamp = new Date().toISOString()
  const logData: Record<string, unknown> = debugData ? { ...debugData, timestamp } : { timestamp }
  const structuredExtra = {
    audience: 'debug' as const,
    kind: 'session' as const,
    op: 'append' as const,
    streaming: false,
    ...(typeof logData.phaseAttempt === 'number' && Number.isFinite(logData.phaseAttempt) ? { phaseAttempt: logData.phaseAttempt } : {}),
  }
  if (shouldSkipLogEmission(ticketId, 'debug', phase, content, logData, 'debug', phase, structuredExtra)) {
    return
  }

  // Always broadcast via SSE so the real-time log viewer DEBUG tab works.
  const event = createLogEvent(
    ticketId,
    'debug',
    phase,
    liveContent,
    logData,
    'debug',
    phase,
    structuredExtra,
  )
  broadcaster.broadcast(ticketId, 'log', { ...event })

  // Only persist to disk when this is a direct (non-mirror) debug call.
  if (persist) {
    appendLogEvent(ticketId, 'debug', phase, content, logData, 'debug', phase, structuredExtra)
  }
}

export function stringifyForLog(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function truncateToolDetail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n… (truncated ${value.length - maxChars} chars)`
}

export function stringifyToolDetail(value: unknown, maxChars: number): string {
  if (typeof value === 'string') return truncateToolDetail(value.trimEnd(), maxChars)
  if (value == null) return ''
  try {
    return truncateToolDetail(JSON.stringify(value, null, 2), maxChars)
  } catch {
    return truncateToolDetail(String(value), maxChars)
  }
}

export function normalizeAttachmentMetadata(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`
}

/**
 * A duration for a stream-event log line: `840ms`, `2.35s`, `1m 30s`.
 *
 * Named apart from `formatDurationMs` in `phaseRuntimeSettings.ts`, which
 * renders the same input differently (`1.5m` where this gives `1m 30s`). Both
 * were module-private until the split; both reach the `helpers` barrel now, and
 * two public `formatDuration…` names that disagree is a trap.
 */
export function formatStreamEventDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 2 : 1)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function formatTimestamp(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}
