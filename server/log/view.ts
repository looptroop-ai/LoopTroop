import { extractLogFingerprint } from '@shared/logIdentity'
import { isAiLogEntry, isDebugLogEntry } from '@shared/logClassification'
import { expandStoredLogEntry } from './storedEntry'

export type LogView = 'overview' | 'system' | 'command' | 'ai' | 'error' | 'debug' | 'activity'

/** The shared durable/API classifier. Keep this aligned with the visible log tab semantics. */
export function classifyPersistedLogEntry(entry: Record<string, unknown>): Exclude<LogView, 'overview' | 'activity'> {
  const type = String(entry.type ?? '')
  const source = String(entry.source ?? '')
  const audience = String(entry.audience ?? '')
  const content = String(entry.content ?? entry.message ?? '')
  if (isDebugLogEntry(entry)) return 'debug'
  if (type === 'error' || source === 'error' || String(entry.kind ?? '') === 'error') return 'error'
  if (isAiLogEntry({ type, source, audience })) return 'ai'
  if (/^\[CMD\]/.test(content)) return 'command'
  return 'system'
}

/** The audience a row belongs to when it does not declare one. */
function inferAudience(record: Record<string, unknown>, type: string): string {
  const source = typeof record.source === 'string' && record.source
    ? record.source
    : typeof record.modelId === 'string' && record.modelId
      ? `model:${record.modelId}`
      : type === 'model_output' ? 'opencode' : type === 'debug' ? 'debug' : 'system'
  if (source === 'debug') return 'debug'
  if (source === 'opencode' || source.startsWith('model:')) return 'ai'
  return 'all'
}

/** The kind a row belongs to when it does not declare one. */
function inferKind(type: string, audience: string): string {
  if (type === 'test_result') return 'test'
  if (type === 'error') return 'error'
  if (audience === 'ai') return type === 'model_output' ? 'text' : 'session'
  return 'milestone'
}

/**
 * A stored line in the shape the API returns: texts stored once are expanded first
 * (storedEntry.ts), then omitted display fields are inferred. Used both to index a
 * row and to return it, and idempotent, so it can run on an already-normalized row.
 */
export function normalizePersistedLogEntry(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const record = expandStoredLogEntry(raw as Record<string, unknown>)
  const phase = typeof record.phase === 'string' ? record.phase : typeof record.status === 'string' ? record.status : 'unknown'
  const phaseAttempt = Number(record.phaseAttempt)
  const content = typeof record.content === 'string' ? record.content : typeof record.message === 'string' ? record.message : ''
  const type = typeof record.type === 'string' ? record.type : 'info'
  const audience = typeof record.audience === 'string' ? record.audience : inferAudience(record, type)
  const normalized: Record<string, unknown> = {
    ...record,
    phase,
    // Attempts are 1-based, so anything else is a malformed row rather than a
    // meaningful value to filter on.
    phaseAttempt: Number.isFinite(phaseAttempt) && phaseAttempt > 0 ? phaseAttempt : 1,
    status: typeof record.status === 'string' ? record.status : phase,
    message: typeof record.message === 'string' ? record.message : content,
    content,
    type,
    audience,
    kind: typeof record.kind === 'string'
      ? record.kind
      : inferKind(type, audience),
    op: typeof record.op === 'string' ? record.op : 'append',
  }
  const fingerprint = extractLogFingerprint(record)
  if (fingerprint) normalized.fingerprint = fingerprint
  return normalized
}
