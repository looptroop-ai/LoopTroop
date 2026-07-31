import { isAbsolute, resolve } from 'path'
import { homedir, tmpdir } from 'os'
import { isMainThread, threadId } from 'worker_threads'

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test'
    || process.env.VITEST === 'true'
    || process.env.VITEST === '1'
}

/**
 * Canonical user-space configuration directory for LoopTroop.
 *
 * Resolution order:
 * 1. `LOOPTROOP_CONFIG_DIR` (explicit override)
 * 2. test-runtime scratch dir (isolated per worker)
 * 3. `$XDG_CONFIG_HOME/looptroop` or `~/.config/looptroop`
 *
 * On Windows, `homedir()` resolves to the user profile so the path stays valid.
 */
export function resolveAppConfigDir(): string {
  const configured = process.env.LOOPTROOP_CONFIG_DIR?.trim()
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured)
  }

  if (isTestRuntime()) {
    const workerSuffix = `${process.pid}-${isMainThread ? 'main' : `thread-${threadId}`}`
    return resolve(tmpdir(), 'looptroop-vitest', workerSuffix)
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim()
  const baseDir = xdgConfigHome
    ? (isAbsolute(xdgConfigHome) ? xdgConfigHome : resolve(process.cwd(), xdgConfigHome))
    : resolve(homedir(), '.config')
  return resolve(baseDir, 'looptroop')
}
