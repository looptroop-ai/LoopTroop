import type { LogEntry } from '@/context/LogContext'

export function countLogTextLines(entries: LogEntry[]): number {
  return entries.reduce(
    (total, entry) => total + (entry.line.length > 0 ? entry.line.split(/\r\n|\r|\n/).length : 0),
    0,
  )
}
