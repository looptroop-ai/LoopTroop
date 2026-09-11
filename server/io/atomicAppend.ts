import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, readSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { ContainedPathError, resolveContainedPath } from '../lib/containedPath'
import { openFileNoFollowSync } from './readFile'

export interface AtomicAppendRange {
  offset: number
  length: number
}

/** Appends one JSONL line and returns the exact byte range written. */
export function safeAtomicAppend(filePath: string, line: string): AtomicAppendRange {
  return append(filePath, line)
}

export function safeAtomicAppendWithin(root: string, relativePath: string, line: string): AtomicAppendRange {
  const canonicalRoot = resolveContainedPath(root, '.')
  const target = resolveContainedPath(canonicalRoot, relativePath, { allowMissingParents: true })
  const check = () => {
    if (resolveContainedPath(canonicalRoot, target, { allowMissingParents: true }) !== target) {
      throw new ContainedPathError('Append destination changed')
    }
  }
  return append(target, line, check)
}

function append(filePath: string, line: string, check?: () => void): AtomicAppendRange {
  check?.()
  mkdirSync(dirname(filePath), { recursive: true })
  check?.()
  const fd = openFileNoFollowSync(filePath, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT)
  try {
    check?.()
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
