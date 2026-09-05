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

/** The audience a row belongs to when it does not declare one. */
function inferAudience(record: Record<string, unknown>, type: string): string {
  const source = record.source
  if (source === 'debug' || type === 'debug') return 'debug'
  if (
    source === 'opencode'
    || (typeof source === 'string' && source.startsWith('model:'))
    || type === 'model_output'
  ) return 'ai'
  return 'all'
}

/** The kind a row belongs to when it does not declare one. */
function inferKind(type: string): string {
  if (type === 'test_result') return 'test'
  if (type === 'error') return 'error'
  if (type === 'model_output') return 'text'
  return 'milestone'
}

export interface NormalizePersistedLogEntryOptions {
  /**
   * What to do when a row carries no `audience` or `kind`.
   *
   * `infer` derives them from `type` and `source`, which is what the log HTTP
   * endpoints have always returned. `passthrough` leaves them undefined, which
   * is what the durable projection index stores.
   *
   * The two used to be separate functions, so an older or malformed row could
   * be classified one way by the projection and another by the endpoint reading
   * it back.
   */
  audienceAndKind?: 'infer' | 'passthrough'
}

export function normalizePersistedLogEntry(
  raw: unknown,
  options: NormalizePersistedLogEntryOptions = {},
): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const phase = typeof record.phase === 'string' ? record.phase : typeof record.status === 'string' ? record.status : 'unknown'
  const phaseAttempt = Number(record.phaseAttempt)
  const content = typeof record.content === 'string' ? record.content : typeof record.message === 'string' ? record.message : ''
  const type = typeof record.type === 'string' ? record.type : 'info'
  const infer = options.audienceAndKind === 'infer'
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
    audience: typeof record.audience === 'string'
      ? record.audience
      : (infer ? inferAudience(record, type) : undefined),
    kind: typeof record.kind === 'string'
      ? record.kind
      : (infer ? inferKind(type) : undefined),
    op: typeof record.op === 'string' ? record.op : 'append',
  }
  const fingerprint = extractLogFingerprint(record)
  if (fingerprint) normalized.fingerprint = fingerprint
  return normalized
}
