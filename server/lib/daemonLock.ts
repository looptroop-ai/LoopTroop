import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getDaemonLockPath } from './daemonPaths'
import { ensureSecureDir, CONFIG_FILE_MODE } from './appConfigDir'
import { dirname } from 'node:path'
import { matchProcess, readProcessStartToken } from './processIdentity'

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
  /**
   * Identifies the process that held `pid` when the lock was taken, so a
   * recycled pid cannot pass for the original owner. Absent when the platform
   * could not say, which is treated as "cannot verify" rather than "matches".
   */
  startToken?: string
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

/**
 * Whether a lock was abandoned rather than merely quiet.
 *
 * A stale heartbeat alone is not evidence on this host. A laptop that slept for
 * an hour resumes with every timer behind, so the running daemon's last
 * heartbeat is old while the daemon itself is perfectly alive — and reclaiming
 * on that basis hands a second daemon the same databases and worktrees. The
 * process either still exists or it does not, and the start token answers that
 * without trusting a recycled pid.
 *
 * The heartbeat still decides for a lock from another machine, where our pid
 * table means nothing, and for one whose identity cannot be established.
 */
function isStale(owner: LockOwner, now: number): boolean {
  const heartbeatExpired = now - Date.parse(owner.heartbeatAt) > STALE_LOCK_MS

  // A lock from another machine cannot be judged by our pid table, so only its
  // heartbeat can tell us whether the owner is gone.
  if (owner.host !== hostname()) return heartbeatExpired
  if (!isProcessAlive(owner.pid)) return true

  switch (matchProcess(owner.pid, owner.startToken).kind) {
    // The exact process that took this lock is still running. However long ago
    // it last wrote a heartbeat, it is not abandoned.
    case 'same':
      return false
    // The pid was recycled: the original owner is gone, whatever holds the
    // number now. Stale immediately rather than after the heartbeat window.
    case 'different':
      return true
    // Neither confirmed nor refuted — an older lock with no token, or a
    // platform that cannot report start times. Fall back to the heartbeat.
    default:
      return heartbeatExpired
  }
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
 * Removes one specific abandoned lock, and only that one.
 *
 * Deleting the path outright is not safe: two processes that both judged the
 * same lock stale would both delete, and the second delete lands on the *new*
 * lock the first one just created. Both then believe they hold it, and two
 * daemons share the databases and worktrees.
 *
 * So the file is moved aside first. Rename is atomic, so whatever a reclaimer
 * ends up holding is exactly one file, and its contents say whether it was the
 * intended victim. A reclaimer that finds it quarantined somebody's live lock
 * puts it straight back and loses the race, which is the correct outcome.
 */
function reclaimStaleLock(lockPath: string, staleNonce: string): boolean {
  const quarantine = `${lockPath}.reclaim-${randomUUID()}`

  try {
    renameSync(lockPath, quarantine)
  } catch {
    // Already gone, or claimed by another reclaimer. Either way, not ours.
    return false
  }

  const moved = readOwner(quarantine)
  if (moved?.nonce === staleNonce) {
    rmSync(quarantine, { force: true })
    return true
  }

  // This is not the lock we judged stale — someone acquired between our read
  // and our rename. Put it back and let the retry see the truth.
  try {
    renameSync(quarantine, lockPath)
  } catch {
    // The path is occupied again, so the owner is present under its own lock.
    rmSync(quarantine, { force: true })
  }
  return false
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

  const startToken = readProcessStartToken(process.pid)
  const owner: LockOwner = {
    nonce: randomUUID(),
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...(startToken === null ? {} : { startToken }),
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeOwner(lockPath, owner)
      return buildHandle(lockPath, owner)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      const existing = readOwner(lockPath)
      if (existing && !isStale(existing, Date.now())) throw new DaemonLockedError(existing)

      if (existing) {
        // Lost the reclaim: whoever won it owns the lock now, so stop here
        // rather than deleting theirs on the next pass.
        if (!reclaimStaleLock(lockPath, existing.nonce)) continue
      } else {
        // Unparseable: it names no owner at all, so it cannot be anyone's.
        rmSync(lockPath, { force: true })
      }
    }
  }

  const existing = readOwner(lockPath)
  if (existing) throw new DaemonLockedError(existing)
  throw new Error(`Could not acquire the LoopTroop daemon lock at ${lockPath}.`)
}

/**
 * Removes a lock whose owner was killed rather than allowed to release it.
 *
 * Scoped to one pid on this host so a caller that force-killed a daemon cannot
 * delete the lock of a different one that started in the meantime; without it
 * the next start would wait out the full stale window for nothing.
 *
 * The pid must also no longer be that daemon: a killed process the caller just
 * waited on is gone, and a pid that now matches a live process is either a
 * recycled number or a daemon that survived the kill. Removing the lock in
 * either case would let a second daemon start alongside a running one, so a live
 * pid is only cleared once its identity says it is somebody else's process.
 * Where identity cannot be established the lock stays and the next start waits
 * out the stale window — slow, but never two daemons.
 */
export function clearLockOwnedBy(pid: number, configDir?: string): void {
  const lockPath = getDaemonLockPath(configDir)
  const owner = readOwner(lockPath)
  if (owner?.pid !== pid || owner.host !== hostname()) return
  // Still alive and not provably a different process: not debris.
  if (isProcessAlive(pid) && matchProcess(pid, owner.startToken).kind !== 'different') return
  rmSync(lockPath, { force: true })
}

/**
 * Removes a lock only if nobody holds it, and reports which it was.
 *
 * `stop` runs this when the daemon it expected is not answering, and "not
 * answering" is not "not running": a daemon still opening its database, or
 * wedged, or listening on a port the state file no longer describes, holds the
 * lock and is very much alive. Deleting it there would let a second daemon start
 * on the same databases and worktrees, which is the failure the lock exists to
 * prevent. So the same judgement that governs acquisition governs this.
 */
export type StaleLockRelease =
  | { kind: 'absent' }
  | { kind: 'removed' }
  | { kind: 'held', owner: LockOwner }

export function releaseStaleLock(configDir?: string): StaleLockRelease {
  const lockPath = getDaemonLockPath(configDir)
  const existing = readOwner(lockPath)

  if (existing === null) {
    // Nothing there, or a file that names no owner and so cannot be anyone's.
    if (!existsSync(lockPath)) return { kind: 'absent' }
    rmSync(lockPath, { force: true })
    return { kind: 'removed' }
  }

  if (!isStale(existing, Date.now())) return { kind: 'held', owner: existing }
  if (reclaimStaleLock(lockPath, existing.nonce)) return { kind: 'removed' }

  // Lost the reclaim, so somebody holds it now. Report whoever that is.
  const current = readOwner(lockPath)
  return current === null ? { kind: 'absent' } : { kind: 'held', owner: current }
}

function buildHandle(lockPath: string, owner: LockOwner): AcquiredLock {
  let released = false

  return {
    owner,
    path: lockPath,
    heartbeat() {
      if (released) return
      // Only refresh a lock still carrying our nonce. A daemon whose lock was
      // reclaimed while it was suspended would otherwise write itself back over
      // the new owner's file, leaving two daemons each believing they hold it.
      if (readOwner(lockPath)?.nonce !== owner.nonce) return

      const next: LockOwner = { ...owner, heartbeatAt: new Date().toISOString() }
      try {
        // Rewritten in place: an atomic replace would swap the inode and could
        // clobber a lock another process legitimately took after a reclaim.
        const fd = openSync(lockPath, 'r+')
        try {
          const encoded = `${JSON.stringify(next, null, 2)}\n`
          writeSync(fd, encoded, 0)
          // The record is fixed-shape, but a shorter one would otherwise leave
          // the tail of the previous write behind and produce invalid JSON.
          ftruncateSync(fd, Buffer.byteLength(encoded))
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
