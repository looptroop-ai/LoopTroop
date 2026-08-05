import { isAbsolute, resolve } from 'path'
import { homedir, tmpdir } from 'os'
import { isMainThread, threadId } from 'worker_threads'

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test'
    || process.env.VITEST === 'true'
    || process.env.VITEST === '1'
}

export interface AppConfigDirDetection {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

function resolveAgainstCwd(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value)
}

/**
 * Canonical user-space configuration directory for LoopTroop.
 *
 * Resolution order:
 * 1. `LOOPTROOP_CONFIG_DIR` (explicit override, every platform)
 * 2. test-runtime scratch dir (isolated per worker)
 * 3. Windows: `%APPDATA%\looptroop`
 * 4. Unix: `$XDG_CONFIG_HOME/looptroop` or `~/.config/looptroop`
 *
 * XDG_CONFIG_HOME is deliberately ignored on Windows: it is a freedesktop
 * convention, so honouring it there would split a user's data across two
 * locations depending on which shell launched the process.
 */
export function resolveAppConfigDir(detection: AppConfigDirDetection = {}): string {
  const environment = detection.env ?? process.env
  const nodePlatform = detection.platform ?? process.platform

  const configured = environment.LOOPTROOP_CONFIG_DIR?.trim()
  if (configured) return resolveAgainstCwd(configured)

  if (isTestRuntime()) {
    const workerSuffix = `${process.pid}-${isMainThread ? 'main' : `thread-${threadId}`}`
    return resolve(tmpdir(), 'looptroop-vitest', workerSuffix)
  }

  const home = detection.homeDir ?? homedir()

  if (nodePlatform === 'win32') {
    const appData = environment.APPDATA?.trim()
    const baseDir = appData ? resolveAgainstCwd(appData) : resolve(home, 'AppData', 'Roaming')
    return resolve(baseDir, 'looptroop')
  }

  const xdgConfigHome = environment.XDG_CONFIG_HOME?.trim()
  const baseDir = xdgConfigHome ? resolveAgainstCwd(xdgConfigHome) : resolve(home, '.config')
  return resolve(baseDir, 'looptroop')
}
