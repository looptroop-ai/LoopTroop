import { extractLogFingerprint } from '@shared/logIdentity'

export type LogView = 'overview' | 'system' | 'command' | 'ai' | 'error' | 'debug'

/** The shared durable/API classifier. Keep this aligned with the visible log tab semantics. */
export function classifyPersistedLogEntry(entry: Record<string, unknown>): Exclude<LogView, 'overview'> {
  const type = String(entry.type ?? '')
  const source = String(entry.source ?? '')
  const audience = String(entry.audience ?? '')
  const content = String(entry.content ?? entry.message ?? '')
  if (type === 'debug' || source === 'debug' || audience === 'debug') return 'debug'
  if (type === 'error' || source === 'error' || String(entry.kind ?? '') === 'error') return 'error'
  if (audience === 'ai' || type === 'model_output' || source === 'opencode' || source.startsWith('model:')) return 'ai'
  if (/^\[CMD\]/.test(content)) return 'command'
  return 'system'
}

export function normalizePersistedLogEntry(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const phase = typeof record.phase === 'string' ? record.phase : typeof record.status === 'string' ? record.status : 'unknown'
  const phaseAttempt = Number(record.phaseAttempt)
  const content = typeof record.content === 'string' ? record.content : typeof record.message === 'string' ? record.message : ''
  const normalized: Record<string, unknown> = {
    ...record,
    phase,
    phaseAttempt: Number.isFinite(phaseAttempt) && phaseAttempt > 0 ? phaseAttempt : 1,
    status: typeof record.status === 'string' ? record.status : phase,
    message: typeof record.message === 'string' ? record.message : content,
    content,
    type: typeof record.type === 'string' ? record.type : 'info',
    audience: typeof record.audience === 'string' ? record.audience : undefined,
    kind: typeof record.kind === 'string' ? record.kind : undefined,
    op: typeof record.op === 'string' ? record.op : 'append',
  }
  const fingerprint = extractLogFingerprint(record)
  if (fingerprint) normalized.fingerprint = fingerprint
  return normalized
}
