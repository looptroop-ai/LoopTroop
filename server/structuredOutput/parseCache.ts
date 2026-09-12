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

export function getCachedParse(key: string): CachedParse | undefined {
  const entry = entries.get(key)
  if (!entry) return undefined
  entries.delete(key)
  entries.set(key, entry)
  // Binary views can point into this buffer. An unpooled copy also prevents
  // callers reaching another result through a returned view's .buffer.
  return deserialize(Uint8Array.from(entry)) as CachedParse
}

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
