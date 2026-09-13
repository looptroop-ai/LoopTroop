interface LogClassificationFields {
  type?: unknown
  source?: unknown
  audience?: unknown
  kind?: unknown
  modelId?: unknown
  sessionId?: unknown
  line?: unknown
  content?: unknown
  message?: unknown
}

export function getLogModelId(entry: LogClassificationFields): string | null {
  if (typeof entry.modelId === 'string' && entry.modelId) return entry.modelId
  return typeof entry.source === 'string' && entry.source.startsWith('model:')
    ? entry.source.slice('model:'.length) || null
    : null
}

function hasAiAttribution(entry: LogClassificationFields): boolean {
  return entry.type === 'model_output' || entry.audience === 'ai' || entry.source === 'opencode'
    || getLogModelId(entry) !== null || (typeof entry.sessionId === 'string' && entry.sessionId !== '')
}

export function isDebugLogEntry(entry: LogClassificationFields): boolean {
  if (entry.type === 'debug' || entry.source === 'debug' || entry.audience === 'debug') return true
  // Model prose can quote diagnostic tags, including at the start of a line.
  if (hasAiAttribution(entry)) return false
  const content = entry.line ?? entry.content ?? entry.message
  return typeof content === 'string' && content.trimStart().startsWith('[DEBUG]')
}

/** AI transcripts include attributed system/session milestones without reclassifying their SYS rows. */
export function isAiLogEntry(entry: LogClassificationFields): boolean {
  return !isDebugLogEntry(entry) && hasAiAttribution(entry)
}
