import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, writeSync } from 'fs'
import { dirname } from 'path'

export interface AtomicAppendRange {
  offset: number
  length: number
}

/** Appends one JSONL line and returns the exact byte range written. */
export function safeAtomicAppend(filePath: string, line: string): AtomicAppendRange {
  mkdirSync(dirname(filePath), { recursive: true })

  const fd = openSync(filePath, 'a+')
  try {
    const stats = fstatSync(fd)
    let prefix = ''

    if (stats.size > 0) {
      const trailingByte = Buffer.alloc(1)
      readSync(fd, trailingByte, 0, 1, stats.size - 1)
      if (trailingByte.toString('utf-8') !== '\n') {
        prefix = '\n'
      }
    }

    const written = `${prefix}${line}\n`
    writeSync(fd, written, undefined, 'utf-8')
    fsyncSync(fd)
    return { offset: stats.size, length: Buffer.byteLength(written) }
  } finally {
    closeSync(fd)
  }
}
