import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveAppConfigDir, ensureSecureDir, secureFile } from './appConfigDir'
import { safeAtomicWrite } from '../io/atomicWrite'
import { getInstallInfo, isNewerVersion } from './installChannel'

const REGISTRY_URL = 'https://registry.npmjs.org/looptroop/latest'

/** One check a day: an update notice is not worth a request on every command. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

const REQUEST_TIMEOUT_MS = 3_000

interface UpdateCache {
  lastCheckedAt: string
  latestVersion: string
}

export interface UpdateNotice {
  currentVersion: string
  latestVersion: string
  upgradeCommand: string
}

function getCachePath(configDir = resolveAppConfigDir()): string {
  return resolve(configDir, 'update-check.json')
}

function readCache(configDir?: string): UpdateCache | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getCachePath(configDir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as Partial<UpdateCache>
    if (typeof candidate.lastCheckedAt !== 'string' || typeof candidate.latestVersion !== 'string') return null
    return candidate as UpdateCache
  } catch {
    return null
  }
}

function writeCache(cache: UpdateCache, configDir?: string): void {
  try {
    const cachePath = getCachePath(configDir)
    ensureSecureDir(resolve(cachePath, '..'))
    safeAtomicWrite(cachePath, `${JSON.stringify(cache, null, 2)}\n`)
    secureFile(cachePath)
  } catch {
    // A cache that cannot be written only costs an extra request next time.
  }
}

export interface CheckForUpdateOptions {
  currentVersion: string
  configDir?: string
  /** Injected by tests so no network request is made. */
  fetchLatest?: () => Promise<string | null>
  now?: () => number
}

async function fetchLatestFromRegistry(): Promise<string | null> {
  try {
    const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) return null
    const body = await response.json() as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

/**
 * Returns a notice only when a newer version exists.
 *
 * Notify-only by design: LoopTroop never updates itself, because a tool that
 * rewrites its own binary while orchestrating someone's repository is a much
 * worse failure than being one version behind.
 */
export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateNotice | null> {
  const now = options.now?.() ?? Date.now()
  const cached = readCache(options.configDir)

  let latestVersion = cached?.latestVersion ?? null
  const lastChecked = cached ? Date.parse(cached.lastCheckedAt) : Number.NaN
  const isStale = !Number.isFinite(lastChecked) || now - lastChecked > CHECK_INTERVAL_MS

  if (isStale) {
    const fetched = await (options.fetchLatest ?? fetchLatestFromRegistry)()
    // A failed lookup keeps the previous answer rather than nagging offline users.
    if (fetched) {
      latestVersion = fetched
      writeCache({ lastCheckedAt: new Date(now).toISOString(), latestVersion: fetched }, options.configDir)
    }
  }

  if (!latestVersion || !isNewerVersion(latestVersion, options.currentVersion)) return null

  return {
    currentVersion: options.currentVersion,
    latestVersion,
    upgradeCommand: getInstallInfo().upgradeCommand,
  }
}

export function formatUpdateNotice(notice: UpdateNotice): string {
  return [
    '',
    `LoopTroop ${notice.latestVersion} is available (you have ${notice.currentVersion}).`,
    `  ${notice.upgradeCommand}`,
    '',
  ].join('\n')
}
