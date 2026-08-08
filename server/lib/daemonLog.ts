import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { getDaemonLogDir, getDaemonLogPath } from './daemonPaths'
import { ensureSecureDir } from './appConfigDir'

/** Rotated once the live log passes this size. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024

/** Rotated files kept besides the live one, oldest discarded first. */
export const MAX_LOG_GENERATIONS = 3

function rotatedPath(logPath: string, generation: number): string {
  return `${logPath}.${generation}`
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

  try {
    if (statSync(logPath).size < MAX_LOG_BYTES) return
  } catch {
    return
  }

  // Drop the oldest, then shift each generation up so .1 is always free.
  const oldest = rotatedPath(logPath, MAX_LOG_GENERATIONS)
  if (existsSync(oldest)) rmSync(oldest, { force: true })

  for (let generation = MAX_LOG_GENERATIONS - 1; generation >= 1; generation -= 1) {
    const from = rotatedPath(logPath, generation)
    if (existsSync(from)) renameSync(from, rotatedPath(logPath, generation + 1))
  }

  renameSync(logPath, rotatedPath(logPath, 1))
}
