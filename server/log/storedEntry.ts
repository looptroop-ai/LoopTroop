/**
 * Persisted log lines keep each text once (see LOG SIZE BUDGET in executionLog.ts):
 *
 * - `content` is left out when it is the same text as `message`;
 * - a debug line whose payload is a plain object keeps only its label in `message`,
 *   because the payload itself is stored in `data`; it is flagged `payloadInData`.
 *
 * Every reader of a persisted line goes through `expandStoredLogEntry`, which puts
 * both texts back, so the API, the log viewer and exports see the full shape.
 */
export const PAYLOAD_IN_DATA_FIELD = 'payloadInData'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/**
 * Whether a debug payload can live only in `data`: `expandStoredLogEntry` rebuilds
 * the text as `JSON.stringify(data without timestamp)`, which equals the payload
 * text exactly when the payload is a plain object that serialized as JSON and had
 * no `timestamp` of its own (the emitter adds one to `data`).
 */
export function canStoreDebugPayloadInData(payload: unknown, payloadText: string): boolean {
  return isPlainRecord(payload) && !Object.hasOwn(payload, 'timestamp') && payloadText.startsWith('{')
}

/** The line written to disk: `content` only when it differs from `message`. */
export function compactLogEntryForStorage<T extends Record<string, unknown>>(entry: T): T {
  if (entry.content === undefined || entry.content !== entry.message) return entry
  const { content: _content, ...rest } = entry
  return rest as T
}

/** A persisted line in the full shape it had before it was stored once. */
export function expandStoredLogEntry<T extends Record<string, unknown>>(entry: T): T {
  let expanded: Record<string, unknown> = entry
  if (entry[PAYLOAD_IN_DATA_FIELD] === true) {
    const { [PAYLOAD_IN_DATA_FIELD]: _flag, ...rest } = entry as Record<string, unknown>
    const data: Record<string, unknown> = isPlainRecord(rest.data) ? rest.data : {}
    const { timestamp: _timestamp, ...payload } = data
    const label = typeof rest.message === 'string' ? rest.message : ''
    const message = `${label} ${JSON.stringify(payload)}`
    expanded = rest.content === undefined || rest.content === label ? { ...rest, message, content: message } : { ...rest, message }
  } else if (entry.content === undefined && typeof entry.message === 'string') {
    expanded = { ...entry, content: entry.message }
  }
  return expanded as T
}
