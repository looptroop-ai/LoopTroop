import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
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
 * How long a conversion claim may sit before another process may take it over.
 *
 * Generous by design: a claim covers two file operations, so anything still
 * holding one after this long is a process that died mid-reclaim rather than one
 * that is merely slow.
 */
const CLAIM_TTL_MS = 30_000

/**
 * The generation name for a lock file that names no owner at all.
 *
 * Cannot collide with a real nonce, which is a `randomUUID` and so contains
 * only hex digits and dashes. The space is what guarantees that, rather than
 * the word being unlikely.
 */
const UNPARSEABLE_GENERATION = 'unparseable lock'

interface ClaimHolder {
  pid: number
  host: string
  at: string
}

interface ConversionClaim {
  release(): void
}

/**
 * Where the right to convert one particular lock generation is registered.
 *
 * Named after the nonce being converted rather than after the lock, so two
 * contenders that judged the *same* stale lock collide here and exactly one
 * proceeds — while a contender still holding a claim on an older generation
 * cannot block one working on the current file. Hashed because the name goes on
 * disk beside a record that is routinely inspected, and a nonce is the token
 * that governs who may release the lock.
 */
function claimPath(lockPath: string, nonce: string): string {
  return `${lockPath}.claim-${createHash('sha256').update(nonce).digest('hex').slice(0, 16)}`
}

/**
 * Removes a claim whose holder can be shown to have gone, and only that one.
 *
 * The removal is itself claimed by renaming: after the first process renames the
 * file away, every other rename fails with ENOENT, so exactly one contender gets
 * to act on it. Deleting the path directly would let two processes both remove
 * it and both go on to create it, which is the doubling this whole mechanism
 * exists to prevent.
 */
function discardAbandonedClaim(path: string): void {
  let holder: ClaimHolder | null = null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) holder = parsed as ClaimHolder
  } catch {
    // Unreadable or half-written: it vouches for nobody.
  }

  const abandoned = holder === null
    || (holder.host === hostname() && !isProcessAlive(holder.pid))
    || Date.now() - Date.parse(holder.at) > CLAIM_TTL_MS

  if (!abandoned) return

  const discarded = `${path}.gone-${randomUUID()}`
  try {
    renameSync(path, discarded)
  } catch {
    // Another contender got there first; theirs to finish.
    return
  }
  rmSync(discarded, { force: true })
}

/**
 * The exclusive right to convert one lock generation, or null when another
 * process holds it.
 *
 * Every path that changes who owns a lock goes through this, so stale recovery
 * is serialized even though the recovery itself is several file operations.
 */
function takeConversionClaim(lockPath: string, generation: string): ConversionClaim | null {
  const path = claimPath(lockPath, generation)

  try {
    const holder: ClaimHolder = { pid: process.pid, host: hostname(), at: new Date().toISOString() }
    const fd = openSync(path, 'wx', CONFIG_FILE_MODE)
    try {
      writeSync(fd, `${JSON.stringify(holder)}\n`)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    discardAbandonedClaim(path)
    return null
  }

  return {
    release() {
      rmSync(path, { force: true })
    },
  }
}

/**
 * Replaces an abandoned lock with a new owner in one step.
 *
 * The canonical path is never free at any point. An earlier version moved the
 * stale file aside, inspected it, and put it back if it turned out to be
 * somebody's live lock — but between the move and the restore the lock path did
 * not exist, so a third process could take it exclusively and start a daemon,
 * and the restore then wrote straight over that lock. Three contenders were
 * enough for two of them to believe they held the same databases and worktrees.
 *
 * So the new record is staged under a unique name and renamed over the old one.
 * Rename is atomic and never exposes an empty path, and the conversion claim
 * makes sure only one process is doing it to this generation of the lock.
 */
function convertStaleLock(lockPath: string, staleNonce: string, owner: LockOwner): boolean {
  const claim = takeConversionClaim(lockPath, staleNonce)
  if (!claim) return false

  const staging = `${lockPath}.staging-${randomUUID()}`
  try {
    // Re-read under the claim: the generation may have been converted between
    // the read that judged it stale and the claim being granted, and taking a
    // lock that somebody else already replaced is exactly the doubling above.
    if (readOwner(lockPath)?.nonce !== staleNonce) return false

    writeOwner(staging, owner)
    renameSync(staging, lockPath)
    return true
  } catch {
    return false
  } finally {
    rmSync(staging, { force: true })
    claim.release()
  }
}

/**
 * Removes an abandoned lock, leaving the path free for the next start.
 *
 * Same claim, same re-read: `stop` runs this after deciding a lock has no live
 * owner, and without the claim two callers could both delete — the second one
 * landing on whatever fresh lock the first one's caller had already created.
 *
 * A null generation means the file named no owner at all, which is its own
 * generation: the check is then that it is still unparseable.
 */
function removeStaleLock(lockPath: string, generation: string | null): boolean {
  const claim = takeConversionClaim(lockPath, generation ?? UNPARSEABLE_GENERATION)
  if (!claim) return false

  try {
    const current = readOwner(lockPath)
    const unchanged = generation === null ? current === null : current?.nonce === generation
    if (!unchanged) return false

    rmSync(lockPath, { force: true })
    return true
  } catch {
    return false
  } finally {
    claim.release()
  }
}

/**
 * Replaces a lock file that names no owner at all.
 *
 * Under the same serialization as a real conversion: an unparseable file is
 * debris, but two processes both deleting it and both creating their own would
 * leave the second delete landing on the first one's new lock.
 */
function convertUnparseableLock(lockPath: string, owner: LockOwner): boolean {
  const claim = takeConversionClaim(lockPath, UNPARSEABLE_GENERATION)
  if (!claim) return false

  const staging = `${lockPath}.staging-${randomUUID()}`
  try {
    if (readOwner(lockPath) !== null) return false

    writeOwner(staging, owner)
    renameSync(staging, lockPath)
    return true
  } catch {
    return false
  } finally {
    rmSync(staging, { force: true })
    claim.release()
  }
}

/** Enough passes for every contender in a realistic race to settle. */
const ACQUIRE_ATTEMPTS = 8

/**
 * Takes the single-instance daemon lock, or throws DaemonLockedError when
 * another live daemon holds it. A lock left behind by a crashed run is
 * converted to this run's ownership in one atomic step, so a concurrent
 * reclaimer can never find the path unoccupied and hand it to a third process.
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

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      writeOwner(lockPath, owner)
      return buildHandle(lockPath, owner)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      const existing = readOwner(lockPath)
      if (existing && !isStale(existing, Date.now())) throw new DaemonLockedError(existing)

      const converted = existing
        ? convertStaleLock(lockPath, existing.nonce, owner)
        : convertUnparseableLock(lockPath, owner)

      // The lock now carries our nonce, written in the same step that removed
      // the old one — there is no second acquisition to lose.
      if (converted) return buildHandle(lockPath, owner)
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
  // Through the same serialization as every other removal, and scoped to the
  // generation just judged: an unscoped delete here would land on whatever lock
  // a start that raced this `stop` had already written to the same path.
  removeStaleLock(lockPath, owner.nonce)
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
    if (removeStaleLock(lockPath, UNPARSEABLE_GENERATION)) return { kind: 'removed' }
    // Somebody converted it while we looked; report whoever owns it now.
    const current = readOwner(lockPath)
    return current === null ? { kind: 'absent' } : { kind: 'held', owner: current }
  }

  if (!isStale(existing, Date.now())) return { kind: 'held', owner: existing }
  if (removeStaleLock(lockPath, existing.nonce)) return { kind: 'removed' }

  // Lost the race, so somebody holds it now. Report whoever that is.
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
