import { copyFileSync, existsSync, renameSync, rmSync, statSync, truncateSync } from 'node:fs'
import { getDaemonLogDir, getDaemonLogPath } from './daemonPaths'
import { ensureSecureDir, secureFile } from './appConfigDir'

/** Rotated once the live log passes this size. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024

/** Rotated files kept besides the live one, oldest discarded first. */
export const MAX_LOG_GENERATIONS = 3

/**
 * How often a running daemon looks at the size of its own log.
 *
 * One stat, so the interval is chosen for how much output can accumulate
 * unnoticed rather than for cost: a minute of a daemon in a crash loop.
 */
export const LOG_CHECK_INTERVAL_MS = 60_000

function rotatedPath(logPath: string, generation: number): string {
  return `${logPath}.${generation}`
}

/** Frees .1 by moving every kept generation up, discarding the oldest. */
function shiftGenerations(logPath: string): void {
  const oldest = rotatedPath(logPath, MAX_LOG_GENERATIONS)
  if (existsSync(oldest)) rmSync(oldest, { force: true })

  for (let generation = MAX_LOG_GENERATIONS - 1; generation >= 1; generation -= 1) {
    const from = rotatedPath(logPath, generation)
    if (existsSync(from)) renameSync(from, rotatedPath(logPath, generation + 1))
  }
}

/** True when the log has grown past the limit, false if it cannot be read. */
function isOversized(logPath: string): boolean {
  try {
    return statSync(logPath).size >= MAX_LOG_BYTES
  } catch {
    return false
  }
}

/**
 * Rotates the daemon log if it has grown past the limit.
 *
 * Called before the log is opened for a new run, not while one is writing: the
 * daemon holds an append handle for its whole lifetime, and renaming underneath
 * it would leave that handle pointing at the rotated file on POSIX and fail
 * outright on Windows.
 */
export function rotateDaemonLog(configDir?: string): void {
  const logPath = getDaemonLogPath(configDir)
  ensureSecureDir(getDaemonLogDir(configDir))

  if (!existsSync(logPath)) return
  if (!isOversized(logPath)) return

  shiftGenerations(logPath)
  renameSync(logPath, rotatedPath(logPath, 1))
}

/**
 * Rotates the log of a daemon that is running right now, by copying it aside
 * and truncating the original in place.
 *
 * Rotation at startup is the whole of the bound only if daemons are restarted,
 * and this one is built not to be: it is detached, it survives logout, and the
 * documented way to use LoopTroop is to start it once and forget it. A daemon
 * whose OpenCode is in a crash loop writes into that log continuously, so the
 * file grows for as long as the machine is up — months, on a laptop that is
 * never asked to restart it.
 *
 * The rename that startup rotation uses is unavailable here: the daemon was
 * spawned with this file as its stdout and holds that descriptor for its whole
 * lifetime, so on POSIX a rename would leave it writing into the rotated file,
 * and on Windows it would fail outright. Copying and truncating keeps the
 * descriptor valid, because it was opened for append and every write seeks to
 * the end — which after a truncation is zero.
 *
 * The cost is the copytruncate race that every implementation of this has:
 * anything written between the copy and the truncation is lost. That is a
 * fraction of a second of log lines every 5MB, and the alternative is either an
 * unbounded file or a daemon that has to be restarted to stay bounded.
 */
export function rotateRunningDaemonLog(configDir?: string): boolean {
  const logPath = getDaemonLogPath(configDir)
  if (!existsSync(logPath)) return false
  if (!isOversized(logPath)) return false

  try {
    shiftGenerations(logPath)
    copyFileSync(logPath, rotatedPath(logPath, 1))
    // The copy holds whatever the live log held, and that is owner-only.
    secureFile(rotatedPath(logPath, 1))
    truncateSync(logPath, 0)
    return true
  } catch {
    // A daemon must not exit because it could not rotate its own log. The file
    // keeps growing, which is the state this whole function improves on but is
    // not worse than what a failure here would replace it with.
    return false
  }
}

/**
 * Keeps a running daemon's log bounded for as long as the daemon lives.
 *
 * The timer is unreferenced: bounding the log is housekeeping, and must never
 * be the reason a process that is otherwise finished stays alive.
 */
export function startDaemonLogRotation(options: {
  configDir?: string
  intervalMs?: number
} = {}): () => void {
  const timer = setInterval(
    () => { rotateRunningDaemonLog(options.configDir) },
    options.intervalMs ?? LOG_CHECK_INTERVAL_MS,
  )
  timer.unref()
  return () => { clearInterval(timer) }
}
