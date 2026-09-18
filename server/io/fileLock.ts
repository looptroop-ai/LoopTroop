import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from '../db/sqliteShim'

/**
 * A short-lived cross-process lock backed by SQLite's native transaction lock.
 *
 * The database file is persistent and app-owned. The connection holding the
 * `BEGIN IMMEDIATE` transaction is the claim: SQLite releases it when the
 * connection closes, including when its process dies, so there is no stale
 * file to guess about or unlink while another process may own it.
 */
export interface FileLockOptions {
  /** How long to keep waiting for the lock. Default 5s. */
  timeoutMs?: number
  /** Poll interval while waiting. Default 25ms. */
  retryMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_RETRY_MS = 25

export class FileLockTimeoutError extends Error {
  constructor(readonly lockPath: string) {
    super(`Timed out waiting for the lock at ${lockPath}.`)
    this.name = 'FileLockTimeoutError'
  }
}

function duration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback
}

function isBusy(error: unknown): boolean {
  const candidate = error as NodeJS.ErrnoException
  return candidate.code === 'SQLITE_BUSY'
    || (candidate.code === 'ERR_SQLITE_ERROR' && /database(?: table)? is locked/i.test(String(candidate.message)))
}

function tryAcquire(lockPath: string): Database | null {
  mkdirSync(dirname(lockPath), { recursive: true })
  let database: Database | undefined
  try {
    database = new Database(lockPath)
    // A native busy wait would block this process's event loop. Failed
    // attempts return immediately and the caller yields between retries.
    database.pragma('busy_timeout = 0')
    database.exec('BEGIN IMMEDIATE')
    return database
  } catch (error) {
    try { database?.close() } catch { /* preserve the acquisition error */ }
    if (isBusy(error)) return null
    throw error
  }
}

function release(database: Database): void {
  try { database.exec('ROLLBACK') } catch { /* close still releases a live transaction */ }
  try { database.close() } catch { /* preserve the callback result/error */ }
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

const sleepSync = (ms: number) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export async function withFileLock<T>(
  lockPath: string,
  run: () => T | Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = duration(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const retryMs = duration(options.retryMs, DEFAULT_RETRY_MS)
  const deadline = Date.now() + timeoutMs
  let database: Database | null = null

  while (database === null) {
    database = tryAcquire(lockPath)
    if (database !== null) break
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath)
    await sleep(Math.min(retryMs, Math.max(0, deadline - Date.now())))
  }

  try {
    return await run()
  } finally {
    release(database)
  }
}

/** Synchronous counterpart for the append path, whose byte range is synchronous. */
export function withFileLockSync<T>(
  lockPath: string,
  run: () => T,
  options: FileLockOptions = {},
): T {
  const timeoutMs = duration(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const retryMs = duration(options.retryMs, DEFAULT_RETRY_MS)
  const deadline = Date.now() + timeoutMs
  let database: Database | null = null

  while (database === null) {
    database = tryAcquire(lockPath)
    if (database !== null) break
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath)
    sleepSync(Math.min(retryMs, Math.max(0, deadline - Date.now())))
  }

  try {
    return run()
  } finally {
    release(database)
  }
}
