import { readFileSync, existsSync } from 'fs'
import { safeAtomicWrite } from './atomicWrite'
import { safeAtomicAppend } from './atomicAppend'
import { warnIfVerbose } from '../runtime'

export interface JsonlReadResult<T> {
  items: T[]
  /** 1-based line numbers that did not parse. Empty when the file was clean. */
  malformedLines: number[]
}

/**
 * Reads a JSONL file, reporting which lines could not be parsed.
 *
 * Skipping a bad line is right for diagnostic reads and wrong for authoritative
 * ones — a Manual QA evidence manifest that quietly loses a line attaches
 * partial evidence and says nothing — so the decision belongs to the caller,
 * which needs to know a line was dropped in order to make it.
 */
export function readJsonlWithDiagnostics<T = Record<string, unknown>>(filePath: string): JsonlReadResult<T> {
  if (!existsSync(filePath)) return { items: [], malformedLines: [] }
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n').filter(line => line.trim() !== '')
  const items: T[] = []
  const malformedLines: number[] = []

  for (let i = 0; i < lines.length; i++) {
    try {
      items.push(JSON.parse(lines[i]!) as T)
    } catch {
      const preview = lines[i]!.length > 80 ? lines[i]!.slice(0, 80) + '…' : lines[i]
      warnIfVerbose(`[jsonl] Skipping malformed line ${i + 1} in ${filePath}: ${preview}`)
      malformedLines.push(i + 1)
    }
  }

  return { items, malformedLines }
}

/** Skips malformed lines. Use `readJsonlWithDiagnostics` where that matters. */
export function readJsonl<T = Record<string, unknown>>(filePath: string): T[] {
  return readJsonlWithDiagnostics<T>(filePath).items
}

export function writeJsonl<T>(filePath: string, items: T[]): void {
  const content = items.map(item => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : '')
  safeAtomicWrite(filePath, content)
}

export function appendJsonl<T>(filePath: string, item: T): void {
  safeAtomicAppend(filePath, JSON.stringify(item))
}
