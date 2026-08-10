import { spawn } from 'node:child_process'
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
 * through to the forceful path.
 */
export function signalTermination(pid: number): boolean {
  if (process.platform === 'win32') return false
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
 * `taskkill /T` walks the real child tree.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return

  if (process.platform === 'win32') {
    await runTaskkill(pid)
    return
  }

  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch {
    // Not a group leader: a daemon started in the foreground shares its
    // shell's group, which must not be killed. Only the daemon itself, then.
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Exited on its own between the check and the signal.
  }
}

/** Bounded so a hung taskkill cannot make `stop` hang with it. */
const TASKKILL_TIMEOUT_MS = 10_000

function runTaskkill(pid: number): Promise<void> {
  return new Promise<void>((done) => {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
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
