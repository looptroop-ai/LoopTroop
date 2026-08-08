import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getDaemonLockPath } from './daemonPaths'
import { ensureSecureDir, CONFIG_FILE_MODE } from './appConfigDir'
import { dirname } from 'node:path'

/**
 * Identifies one daemon run. `nonce` distinguishes this acquisition from any
 * other, so a lock is only ever released by the run that took it.
 */
export interface LockOwner {
  nonce: string
  pid: number
  host: string
  startedAt: string
  heartbeatAt: string
}

export interface AcquiredLock {
  owner: LockOwner
  path: string
  heartbeat(): void
  release(): void
}

export class DaemonLockedError extends Error {
  constructor(readonly owner: LockOwner) {
    super(
      `LoopTroop is already running (pid ${owner.pid} on ${owner.host}, started ${owner.startedAt}). ` +
      'Use `looptroop status` to inspect it, or `looptroop stop` to shut it down.',
    )
    this.name = 'DaemonLockedError'
  }
}

/** A lock whose heartbeat is older than this is treated as abandoned. */
export const STALE_LOCK_MS = 60_000

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as Partial<LockOwner>
    if (typeof candidate.nonce !== 'string' || typeof candidate.pid !== 'number') return null
    return candidate as LockOwner
  } catch {
    return null
  }
}

/**
 * True when the pid is alive. Signal 0 performs the permission and existence
 * check without delivering anything.
 */
function isProcessAlive(pid: number): boolean {
  // 0 and negatives address a process group rather than one process, so they
  // would report "alive" for a lock that never named a real owner.
  if (!Number.isInteger(pid) || pid <= 0) return false

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isStale(owner: LockOwner, now: number): boolean {
  // A lock from another machine cannot be judged by our pid table, so only its
  // heartbeat can tell us whether the owner is gone.
  if (owner.host !== hostname()) {
    return now - Date.parse(owner.heartbeatAt) > STALE_LOCK_MS
  }
  if (!isProcessAlive(owner.pid)) return true
  return now - Date.parse(owner.heartbeatAt) > STALE_LOCK_MS
}

function writeOwner(lockPath: string, owner: LockOwner): void {
  // 'wx' fails when the file exists, which is what makes acquisition exclusive:
  // two processes racing here cannot both succeed.
  const fd = openSync(lockPath, 'wx', CONFIG_FILE_MODE)
  try {
    writeSync(fd, `${JSON.stringify(owner, null, 2)}\n`)
  } finally {
    closeSync(fd)
  }
}

/**
 * Takes the single-instance daemon lock, or throws DaemonLockedError when
 * another live daemon holds it. A lock left behind by a crashed run is
 * reclaimed, then re-acquired exclusively so a concurrent reclaim cannot
 * hand the same lock to two processes.
 */
export function acquireDaemonLock(configDir?: string): AcquiredLock {
  const lockPath = getDaemonLockPath(configDir)
  ensureSecureDir(dirname(lockPath))

  const owner: LockOwner = {
    nonce: randomUUID(),
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeOwner(lockPath, owner)
      return buildHandle(lockPath, owner)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      const existing = readOwner(lockPath)
      // An unparseable lock cannot identify a live owner, so treat it as debris.
      if (existing && !isStale(existing, Date.now())) throw new DaemonLockedError(existing)

      rmSync(lockPath, { force: true })
    }
  }

  const existing = readOwner(lockPath)
  if (existing) throw new DaemonLockedError(existing)
  throw new Error(`Could not acquire the LoopTroop daemon lock at ${lockPath}.`)
}

function buildHandle(lockPath: string, owner: LockOwner): AcquiredLock {
  let released = false

  return {
    owner,
    path: lockPath,
    heartbeat() {
      if (released) return
      const next: LockOwner = { ...owner, heartbeatAt: new Date().toISOString() }
      try {
        // Rewritten in place: an atomic replace would swap the inode and could
        // clobber a lock another process legitimately took after a reclaim.
        const fd = openSync(lockPath, 'r+')
        try {
          writeSync(fd, `${JSON.stringify(next, null, 2)}\n`, 0)
        } finally {
          closeSync(fd)
        }
      } catch {
        // A missing lock file is reported by release(), not here.
      }
    },
    release() {
      if (released) return
      released = true
      // Only remove a lock still carrying our nonce: a stale-reclaim may have
      // handed it to someone else while we were shutting down.
      const current = readOwner(lockPath)
      if (current?.nonce === owner.nonce) rmSync(lockPath, { force: true })
    },
  }
}
