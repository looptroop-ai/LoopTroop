import { spawn, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import type { HostPlatform } from '@shared/hostContext'
import { FORCE_KILL_DELAY_MS } from './constants'
import { findTrustedExecutablePath } from './executablePath'
import { readProcessStartToken } from './processIdentity'

export interface ProcessGroupSnapshot {
  leaderPid: number
  leaderToken: string
  groupId: number
  members: Map<number, string>
}

/** Reads a Linux process group id without trusting the executable name. */
function processGroupId(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const commEnd = stat.lastIndexOf(')')
    if (commEnd === -1) return null
    const fields = stat.slice(commEnd + 1).trim().split(/\s+/)
    const group = fields[2]
    return group !== undefined && /^\d+$/.test(group) ? Number(group) : null
  } catch {
    return null
  }
}

/**
 * Captures enough of a detached Linux group to make a delayed kill safe after
 * its leader exits. An empty result means group identity could not be
 * established; the caller may still use the direct-process token while the
 * leader remains alive, but never invents group ownership after it is gone.
 */
export function captureProcessGroup(
  pid: number,
  platform: HostPlatform,
  expectedLeaderToken: string,
): ProcessGroupSnapshot | null {
  if (platform !== 'linux' || process.platform !== 'linux') return null

  // The snapshot is the provenance for a later group kill. It is valid only
  // while the verified original leader is live and its group id is captured. A
  // later call cannot reconstruct ownership from a recycled pid and PGID.
  const leaderToken = readProcessStartToken(pid)
  const groupId = processGroupId(pid)
  // Keep the token check on both sides of the group-id read. If the original
  // exits in that small window and its pid is recycled, the replacement's
  // group must not become the initial snapshot.
  if (leaderToken !== expectedLeaderToken
    || groupId === null
    || readProcessStartToken(pid) !== leaderToken) return null

  const members = new Map<number, string>([[pid, leaderToken]])
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const memberPid = Number(entry)
    if (memberPid === pid || processGroupId(memberPid) !== groupId) continue
    const token = readProcessStartToken(memberPid)
    if (token !== null) members.set(memberPid, token)
  }

  // Enumeration is another asynchronous boundary from the kernel's point of
  // view. Do not retain a snapshot if the original leader disappeared before
  // it was complete; later cleanup then has no unambiguous provenance.
  if (readProcessStartToken(pid) !== leaderToken) return null
  return { leaderPid: pid, leaderToken, groupId, members }
}

/**
 * Extends a verified group snapshot while its original leader is still live.
 * A shell can start descendants after the initial spawn scan; retaining their
 * pid/token pairs before that leader exits lets cleanup remain safe afterwards.
 * Once the leader is gone, no new member is accepted because group-id reuse
 * cannot be distinguished from a late descendant safely.
 */
export function refreshProcessGroup(snapshot: ProcessGroupSnapshot): ProcessGroupSnapshot {
  if (process.platform !== 'linux'
    || readProcessStartToken(snapshot.leaderPid) !== snapshot.leaderToken
    || processGroupId(snapshot.leaderPid) !== snapshot.groupId) return snapshot

  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return snapshot
  }

  const members = new Map(snapshot.members)
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const memberPid = Number(entry)
    if (memberPid === snapshot.leaderPid || processGroupId(memberPid) !== snapshot.groupId) continue
    const token = readProcessStartToken(memberPid)
    if (token !== null) members.set(memberPid, token)
  }

  // Enumeration is another asynchronous boundary from the kernel's point of
  // view. Keep no newly scanned members if the original leader changed while
  // the directory was being read.
  if (readProcessStartToken(snapshot.leaderPid) !== snapshot.leaderToken
    || processGroupId(snapshot.leaderPid) !== snapshot.groupId) return snapshot

  return { ...snapshot, members }
}

/** True only while one captured descendant still belongs to the group. */
export function hasCapturedProcessGroupMember(snapshot: ProcessGroupSnapshot): boolean {
  for (const [pid, token] of snapshot.members) {
    if (pid === snapshot.leaderPid) continue
    if (readProcessStartToken(pid) === token && processGroupId(pid) === snapshot.groupId) return true
  }
  return false
}

/**
 * Signals a captured POSIX group after its original leader has exited.
 *
 * The leader token is the gate: a numeric group id is usable here only when
 * the original leader is definitely gone and the snapshot still names a live
 * descendant. Callers can then require a later group-absence probe before
 * releasing ownership.
 */
export function terminateCapturedProcessGroupAfterLeaderExit(
  snapshot: ProcessGroupSnapshot,
  signal: NodeJS.Signals,
): boolean {
  if (process.platform !== 'linux') return false
  if (readProcessStartToken(snapshot.leaderPid) !== null) return false
  if (!hasCapturedProcessGroupMember(snapshot)) return true
  try {
    process.kill(-snapshot.groupId, signal)
    return true
  } catch {
    return false
  }
}

function isOwnedChildLive(child: ChildProcess): boolean {
  return (child.exitCode === null || child.exitCode === undefined)
    && (child.signalCode === null || child.signalCode === undefined)
}

function terminateOwnedChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!isOwnedChildLive(child)) return
  try { child.kill(signal) } catch { /* best effort */ }
}

function currentPlatform(): HostPlatform {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  return 'linux'
}

/**
 * Signals a spawned command and everything it started.
 *
 * A shell command's children are the point: killing only the shell leaves a
 * test runner or a dev server holding the port. POSIX gets the negated pid, so
 * the signal goes to the process group the runner asked for when it spawned
 * detached; Windows has no such thing, so it goes through `taskkill /T`.
 * Falling back to `child.kill` covers the case where the group is already gone.
 */
export function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: HostPlatform = currentPlatform(),
  expectedStartToken?: string | null,
): ChildProcess | undefined {
  if (!child.pid) return undefined
  const pid = child.pid

  // Callers that retained a pid across an asynchronous boundary can opt into
  // an identity check. Git's synchronous helper intentionally omits the
  // option: its existing direct descendant-cleanup contract must remain
  // unchanged.
  if (expectedStartToken !== undefined
    && (expectedStartToken === null || readProcessStartToken(pid) !== expectedStartToken)) {
    return undefined
  }

  if (platform === 'windows') {
    // `taskkill` lives in `%SystemRoot%\system32`; resolving it means the tree
    // is killed by that file rather than by whatever `PATH` offers first. If it
    // cannot be resolved this falls through to `child.kill`, which is the same
    // degradation as `taskkill` failing to spawn — the tree survives, and the
    // caller's own liveness check is what reports that.
    const taskkill = findTrustedExecutablePath('taskkill')
    if (taskkill !== null) {
      return spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
        .on('error', () => undefined)
    }
    if (expectedStartToken !== undefined
      && (expectedStartToken === null || readProcessStartToken(pid) !== expectedStartToken)) {
      return undefined
    }
    child.kill(signal)
    return undefined
  }

  try {
    process.kill(-pid, signal)
  } catch {
    // A process-group failure is exactly where a recycled pid could otherwise
    // turn into a direct signal. Re-read the token immediately before that
    // fallback when the caller supplied one.
    if (expectedStartToken !== undefined
      && (expectedStartToken === null || readProcessStartToken(pid) !== expectedStartToken)) {
      return undefined
    }
    child.kill(signal)
  }
  return undefined
}

/** Kills a previously captured group, retaining proof after its leader exits. */
function terminateCapturedProcessGroup(
  snapshot: ProcessGroupSnapshot,
  child: ChildProcess,
  signal: NodeJS.Signals,
  expectedLeaderToken: string,
): void {
  const currentLeader = readProcessStartToken(snapshot.leaderPid)
  if (currentLeader === snapshot.leaderToken) {
    terminateProcessTree(child, signal, 'linux', expectedLeaderToken)
    return
  }

  // Once the leader is gone, a captured descendant with the original token
  // is the remaining provenance. Do not fall back to signalling the old pid:
  // only the group id is safe to use here, and only while that proof remains.
  if (currentLeader !== null) return
  if (!hasCapturedProcessGroupMember(snapshot)) {
    // A transient identity-probe failure can hide a still-live leader. Its
    // ChildProcess handle remains a direct ownership proof, so use that
    // handle rather than abandoning the launch; never turn the uncertainty
    // into a numeric group or pid signal.
    terminateOwnedChild(child, signal)
    return
  }
  try {
    process.kill(-snapshot.groupId, signal)
  } catch {
    // There is no live original leader to which a direct fallback could be
    // safely addressed. The group signal's failure is therefore terminal.
  }
}

/**
 * Asks a process tree to stop, then makes it.
 *
 * On POSIX the delay separates "would not stop" from "was not given a chance
 * to": SIGTERM lets a runner flush its output and remove its own temporary
 * files, and SIGKILL after the grace period covers the one that ignores it.
 * Windows has no graceful rung here: its first operation is taskkill /T /F,
 * and the delayed operation is only a guarded retry. The timer is unref'd so a
 * command that exits on the first signal does not hold the event loop open for
 * the remainder of the delay.
 *
 * Callers that retain the child across an async timeout should pass the start
 * token captured immediately after spawn. Without it, a child object whose pid
 * was recycled before this function ran cannot be distinguished from its
 * replacement.
 */
export function terminateProcessTreeWithEscalation(
  child: ChildProcess,
  platform: HostPlatform | undefined,
  expectedStartToken: string | null,
  capturedGroup?: ProcessGroupSnapshot | null,
): void {
  const resolvedPlatform = platform ?? currentPlatform()
  const pid = child.pid
  if (pid === undefined) return

  // A ChildProcess handle is an ownership proof for the direct child even
  // when the platform cannot report a start token. It is not proof for an
  // arbitrary numeric pid, so only signal through the handle and never use a
  // process-group or taskkill fallback in this branch.
  if (expectedStartToken === null) {
    const isLive = () => (
      (child.exitCode === null || child.exitCode === undefined)
      && (child.signalCode === null || child.signalCode === undefined)
    )
    if (!isLive()) return
    try {
      // The handle proves the direct child, while Windows' `taskkill /T`
      // proves the descendant walk. Calling child.kill() alone leaves a
      // command's server/tree alive after its wrapper exits.
      if (resolvedPlatform === 'windows') terminateProcessTree(child, 'SIGTERM', resolvedPlatform)
      else child.kill('SIGTERM')
    } catch { return }
    const timer = setTimeout(() => {
      if (!isLive()) return
      try {
        if (resolvedPlatform === 'windows') terminateProcessTree(child, 'SIGKILL', resolvedPlatform)
        else child.kill('SIGKILL')
      } catch { /* best effort */ }
    }, FORCE_KILL_DELAY_MS)
    child.once?.('exit', () => clearTimeout(timer))
    timer.unref()
    return
  }

  // The token must match before the first signal. In particular, no late
  // process-group scan is allowed to turn a recycled pid into our group.
  const currentToken = readProcessStartToken(pid)
  if (currentToken !== expectedStartToken
    && !(currentToken === null && capturedGroup !== null && capturedGroup !== undefined)) return

  let snapshot = capturedGroup ?? captureProcessGroup(pid, resolvedPlatform, expectedStartToken)
  if (snapshot !== null && currentToken === expectedStartToken) {
    snapshot = refreshProcessGroup(snapshot)
  }
  const directToken = expectedStartToken

  if (snapshot !== null && currentToken === null) {
    terminateCapturedProcessGroup(snapshot, child, 'SIGTERM', expectedStartToken)
  } else {
    terminateProcessTree(child, 'SIGTERM', resolvedPlatform, expectedStartToken)
  }
  const escalationTimer = setTimeout(() => {
    // A ChildProcess keeps its numeric pid after exit. If the leader is still
    // alive, a changed start token means that number was recycled. If it has
    // exited, retain the timer for captured descendants, but never use an old
    // group id with no remaining proof of our original group.
    if (pid === undefined || child.pid !== pid) return

    if (resolvedPlatform === 'windows') {
      // The first Windows call already uses taskkill /T /F; this second call
      // is only a bounded retry. There is no safe retry target if identity was
      // unavailable when the timeout began.
      if (directToken === null || readProcessStartToken(pid) !== directToken) return
      terminateProcessTree(child, 'SIGKILL', resolvedPlatform, directToken)
      return
    }

    if (snapshot !== null) {
      const currentLeader = readProcessStartToken(pid)
      if (currentLeader === directToken) snapshot = refreshProcessGroup(snapshot)
      if (snapshot.leaderToken === currentLeader) {
        terminateCapturedProcessGroup(snapshot, child, 'SIGKILL', directToken)
      } else if (currentLeader === null) {
        // A null probe with a still-readable leader stat can be transient.
        // The retained ChildProcess handle is safe for the direct leader, but
        // the unknown identity is not enough to reuse the numeric group id.
        // If the leader's stat is gone, a captured descendant is the only
        // remaining group proof and the group kill remains safe.
        if (processGroupId(pid) === null && hasCapturedProcessGroupMember(snapshot)) {
          terminateCapturedProcessGroup(snapshot, child, 'SIGKILL', directToken)
        } else {
          terminateOwnedChild(child, 'SIGKILL')
        }
      }
      return
    }

    // On a platform without group enumeration, identity still protects a
    // living leader. If it has gone away there is no evidence left that the
    // numeric group id belongs to us, so decline the delayed group kill.
    if (directToken === null || readProcessStartToken(pid) !== directToken) return
    terminateProcessTree(child, 'SIGKILL', resolvedPlatform, directToken)
  }, FORCE_KILL_DELAY_MS)
  // A direct child that exits without descendants needs no delayed work. Keep
  // the timer only when a captured descendant still proves the group belongs
  // to this launch; that is the leader-exit case the snapshot exists for.
  child.once?.('exit', () => {
    // Keep a captured timer through leader exit. Refreshes run only while the
    // leader is still verified, so a descendant created after the final scan
    // remains unproven and is intentionally not signalled.
    if (snapshot === null) clearTimeout(escalationTimer)
  })
  escalationTimer.unref()
}
