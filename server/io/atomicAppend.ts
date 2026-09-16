import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, readSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { ContainedPathError, resolveContainedPath } from '../lib/containedPath'
import { openFileNoFollowSync } from './readFile'

export interface AtomicAppendRange {
  offset: number
  length: number
}

export interface AtomicAppendDeps {
  write: (fd: number, buffer: Uint8Array, offset: number, length: number) => number
}

const defaultDeps: AtomicAppendDeps = {
  write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
}

/** Appends one JSONL line and returns the exact byte range written. */
export function safeAtomicAppend(filePath: string, line: string, deps: AtomicAppendDeps = defaultDeps): AtomicAppendRange {
  return append(filePath, line, undefined, deps)
}

export function safeAtomicAppendWithin(
  root: string,
  relativePath: string,
  line: string,
  deps: AtomicAppendDeps = defaultDeps,
): AtomicAppendRange {
  const canonicalRoot = resolveContainedPath(root, '.')
  const target = resolveContainedPath(canonicalRoot, relativePath, { allowMissingParents: true })
  const check = () => {
    if (resolveContainedPath(canonicalRoot, target, { allowMissingParents: true }) !== target) {
      throw new ContainedPathError('Append destination changed')
    }
  }
  return append(target, line, check, deps)
}

function append(filePath: string, line: string, check: (() => void) | undefined, deps: AtomicAppendDeps): AtomicAppendRange {
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

    const written = Buffer.from(`${prefix}${line}\n`, 'utf8')
    let offset = 0
    while (offset < written.length) {
      const count = deps.write(fd, written, offset, written.length - offset)
      if (count === 0) throw new Error('Atomic append made no progress')
      offset += count
    }
    fsyncSync(fd)
    return { offset: stats.size, length: written.length }
  } finally {
    closeSync(fd)
  }
}
