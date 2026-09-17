import { spawn } from 'node:child_process'
import { findTrustedExecutablePath } from '../lib/executablePath'
import { matchProcess } from '../lib/processIdentity'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * True when the pid is alive. Signal 0 performs the permission and existence
 * check without delivering anything.
 */
export function isProcessAlive(pid: number): boolean {
  // 0 and negatives address a process group rather than one process, so they
  // would report "alive" for a pid that never named a real process.
  if (!Number.isInteger(pid) || pid <= 0) return false

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Resolves true as soon as the process is gone, false when the budget runs out. */
export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await delay(100)
  }
  return !isProcessAlive(pid)
}

/**
 * Asks a process to exit. On POSIX that is SIGTERM, which the daemon handles.
 * Windows has no such signal — `process.kill` there terminates immediately and
 * leaves children orphaned — so this is a no-op on Windows and the caller falls
 * through to the forceful path. `expectedStartToken` is mandatory: `null`
 * means identity is unverifiable, so no signal is attempted.
 */
export function signalTermination(pid: number, expectedStartToken: string | null): boolean {
  if (process.platform === 'win32' || !matchesExpectedProcess(pid, expectedStartToken)) return false
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    // Already gone between the liveness check and the signal.
    return false
  }
}

/**
 * Last resort: kills the process and anything it started.
 *
 * The daemon spawns OpenCode as a child, so killing the daemon alone can leave
 * a server holding the port. On POSIX a detached daemon leads its own process
 * group, and a negative pid addresses exactly that group — a group that does
 * not exist simply fails, so this cannot reach an unrelated process. On Windows
 * `taskkill /T` walks the real child tree. `expectedStartToken` is mandatory;
 * `null` refuses the operation rather than falling back to the pid alone.
 */
export async function killProcessTree(pid: number, expectedStartToken: string | null): Promise<void> {
  if (!matchesExpectedProcess(pid, expectedStartToken)) return

  if (process.platform === 'win32') {
    await runTaskkill(pid, expectedStartToken)
    return
  }

  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch {
    // Not a group leader: a daemon started in the foreground shares its
    // shell's group, which must not be killed. Only the daemon itself, then.
  }

  // The group failure can span a pid exit and reuse. Do not turn the fallback
  // into a direct signal until the recorded process is freshly proven again.
  if (!matchesExpectedProcess(pid, expectedStartToken)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Exited on its own between the check and the signal.
  }
}

function matchesExpectedProcess(pid: number, expectedStartToken: string | null): boolean {
  if (expectedStartToken === null || !isProcessAlive(pid)) return false
  return matchProcess(pid, expectedStartToken).kind === 'same'
}

/** Bounded so a hung taskkill cannot make `stop` hang with it. */
const TASKKILL_TIMEOUT_MS = 10_000

function runTaskkill(pid: number, expectedStartToken: string | null): Promise<void> {
  // Resolved rather than taken from `PATH`: `stop` runs as whoever started the
  // CLI, and the process it is about to force-kill is named by pid. An
  // unresolvable `taskkill` settles immediately and leaves the process running,
  // which is what a missing one already did — the caller reports it from its
  // own liveness check either way.
  const taskkill = findTrustedExecutablePath('taskkill')
  if (taskkill === null || !matchesExpectedProcess(pid, expectedStartToken)) return Promise.resolve()

  return new Promise<void>((done) => {
    const child = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    const timer = setTimeout(() => child.kill(), TASKKILL_TIMEOUT_MS)
    const finish = (): void => {
      clearTimeout(timer)
      done()
    }
    child.once('exit', finish)
    // A missing taskkill leaves the process running; the caller reports that
    // from its own liveness check rather than trusting this to have worked.
    child.once('error', finish)
  })
}
