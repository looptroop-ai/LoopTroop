import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * A short-lived exclusive lock backed by an `O_EXCL` file.
 *
 * Used where a sequence of read, work, write has to be atomic across
 * *processes*, not just across the callers inside one daemon. An in-process
 * promise chain cannot do that: two daemons opened on the same project share
 * nothing but the filesystem, and the loser of the race silently commits a list
 * built from a stale read.
 *
 * Kept deliberately small. The lock is meant to be held for a filesystem
 * operation or two, and callers wait for it asynchronously so the event loop
 * keeps running while another holder finishes.
 */

export interface FileLockOptions {
  /** How long to keep waiting for the lock. Default 5s. */
  timeoutMs?: number
  /**
   * A lock file untouched for this long is treated as abandoned by a process
   * that died holding it. Default 30s — long enough that a slow but live holder
   * is never robbed, short enough that a crash does not wedge the feature.
   */
  staleMs?: number
  /** Poll interval while waiting. Default 25ms. */
  retryMs?: number
}

const LOCK_FILE_MODE = 0o600

export class FileLockTimeoutError extends Error {
  constructor(readonly lockPath: string) {
    super(`Timed out waiting for the lock at ${lockPath}.`)
    this.name = 'FileLockTimeoutError'
  }
}

/**
 * Writes a token nobody else can guess, and hands it back.
 *
 * The token is what makes release safe. Without one, a holder that ran past
 * `staleMs` — and so had its lock reclaimed by a waiter — went on to delete the
 * *replacement* lock on its way out, letting a third writer into a section the
 * second was still inside.
 */
function tryAcquire(lockPath: string): string | null {
  const token = `${process.pid}:${randomUUID()}`
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
    const fd = openSync(lockPath, 'wx', LOCK_FILE_MODE)
    try {
      writeSync(fd, JSON.stringify({ token, pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() }))
    } finally {
      closeSync(fd)
    }
    return token
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
    throw error
  }
}

/** The token currently in the lock file, or null when it cannot be read. */
function readToken(lockPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const token = (parsed as { token?: unknown }).token
    return typeof token === 'string' ? token : null
  } catch {
    return null
  }
}

/** Removes the lock only while we still hold it. */
function releaseOwned(lockPath: string, token: string): void {
  if (readToken(lockPath) !== token) return
  rmSync(lockPath, { force: true })
}

function discardIfStale(lockPath: string, staleMs: number): void {
  try {
    const stats = statSync(lockPath)
    if (Date.now() - stats.mtimeMs < staleMs) return
    rmSync(lockPath, { force: true })
  } catch {
    // Gone already, or unreadable; the next acquire attempt decides.
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

export async function withFileLock<T>(
  lockPath: string,
  run: () => T | Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const staleMs = options.staleMs ?? 30_000
  const retryMs = options.retryMs ?? 25
  const deadline = Date.now() + timeoutMs

  let token: string | null = null
  for (;;) {
    token = tryAcquire(lockPath)
    if (token) break
    discardIfStale(lockPath, staleMs)
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath)
    await sleep(retryMs)
  }

  try {
    return await run()
  } finally {
    releaseOwned(lockPath, token)
  }
}
