import { readFileSync } from 'node:fs'
import { expandStoredLogEntry } from '../log/storedEntry'

export interface PersistedLogEntry {
  content: string
  message: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * A persisted log file as its readers see it. Lines store each text once on disk
 * (server/log/storedEntry.ts); tests that assert on `content` or on a debug payload's
 * text should read through this rather than JSON.parse each line themselves. The type
 * parameter names the shape a test expects; nothing checks it at runtime.
 */
export function readPersistedLogEntries<T = PersistedLogEntry>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => expandStoredLogEntry(JSON.parse(line) as Record<string, unknown>) as T)
}
