import { deserialize, serialize } from 'node:v8'

// Bound both artifact count and retained serialized bytes in the long-lived daemon.
const MAX_ENTRIES = 128
const MAX_BYTES = 8 * 1024 * 1024
const entries = new Map<string, Buffer>()
let retainedBytes = 0

interface CachedParse {
  value: unknown
  repairWarnings: string[]
}

/** Return an independent result, or a miss after evicting an unreadable snapshot. */
export function getCachedParse(key: string): CachedParse | undefined {
  const entry = entries.get(key)
  if (!entry) return undefined
  let parsed: CachedParse
  try {
    // Binary views can point into this buffer. An unpooled copy also prevents
    // callers reaching another result through a returned view's .buffer.
    parsed = deserialize(Uint8Array.from(entry)) as CachedParse
  } catch {
    // V8 can serialize a deep graph that exceeds its deserialization stack.
    entries.delete(key)
    retainedBytes -= entry.byteLength + key.length * 2
    return undefined
  }
  entries.delete(key)
  entries.set(key, entry)
  return parsed
}

/** Snapshot a successful parse within the entry/byte limits; bypass unsupported values. */
export function cacheParse(key: string, value: unknown, repairWarnings: string[]): void {
  let entry: Buffer
  try {
    entry = serialize({ value, repairWarnings })
  } catch {
    // A cache must not reject an artifact the parser accepted (e.g. serialization depth).
    return
  }
  const size = entry.byteLength + key.length * 2
  if (size > MAX_BYTES) return

  const previous = entries.get(key)
  if (previous) {
    retainedBytes -= previous.byteLength + key.length * 2
    entries.delete(key)
  }
  while (entries.size >= MAX_ENTRIES || retainedBytes + size > MAX_BYTES) {
    const oldestKey = entries.keys().next().value!
    retainedBytes -= entries.get(oldestKey)!.byteLength + oldestKey.length * 2
    entries.delete(oldestKey)
  }
  entries.set(key, entry)
  retainedBytes += size
}
