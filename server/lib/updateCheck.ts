import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveAppConfigDir, ensureSecureDir, secureFile } from './appConfigDir'
import { safeAtomicWrite } from '../io/atomicWrite'
import { resolveInstallInfo, isNewerVersion } from './installChannel'

const REGISTRY_URL = 'https://registry.npmjs.org/looptroop/latest'

/** One check a day: an update notice is not worth a request on every command. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

const REQUEST_TIMEOUT_MS = 3_000

interface UpdateCache {
  /**
   * When a lookup was last attempted, whether or not it answered.
   *
   * Separate from `lastCheckedAt`, which is when a version was last learned: an
   * offline machine has attempts and no answers, and it is the attempts that
   * have to be rationed.
   */
  lastAttemptAt: string
  /** When `latestVersion` was learned. Absent until a lookup has answered. */
  lastCheckedAt?: string
  /** The newest version the registry has reported so far. */
  latestVersion?: string
}

export interface UpdateNotice {
  currentVersion: string
  latestVersion: string
  upgradeCommand: string
}

function getCachePath(configDir = resolveAppConfigDir()): string {
  return resolve(configDir, 'update-check.json')
}

/**
 * Tolerates a cache written before failures were recorded, where the only
 * timestamp was the one on a successful answer.
 */
function readCache(configDir?: string): UpdateCache | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getCachePath(configDir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null

    const candidate = parsed as Partial<UpdateCache>
    const lastCheckedAt = typeof candidate.lastCheckedAt === 'string' ? candidate.lastCheckedAt : undefined
    const lastAttemptAt = typeof candidate.lastAttemptAt === 'string' ? candidate.lastAttemptAt : lastCheckedAt
    if (lastAttemptAt === undefined) return null

    return {
      lastAttemptAt,
      ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }),
      ...(typeof candidate.latestVersion === 'string' ? { latestVersion: candidate.latestVersion } : {}),
    }
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
  const lastAttempt = cached ? Date.parse(cached.lastAttemptAt) : Number.NaN
  const isStale = !Number.isFinite(lastAttempt) || now - lastAttempt > CHECK_INTERVAL_MS

  if (isStale) {
    const attemptedAt = new Date(now).toISOString()
    const fetched = await (options.fetchLatest ?? fetchLatestFromRegistry)()

    if (fetched) latestVersion = fetched

    // The attempt is recorded either way. Recording only answers meant a machine
    // that cannot reach the registry — offline, or behind a proxy that swallows
    // the request — never had a fresh timestamp to compare against, so every
    // single command paid the full request timeout again. A failed lookup still
    // keeps whatever the last answer was, rather than nagging or forgetting.
    writeCache({
      lastAttemptAt: attemptedAt,
      ...(fetched
        ? { lastCheckedAt: attemptedAt, latestVersion: fetched }
        : {
            ...(cached?.lastCheckedAt === undefined ? {} : { lastCheckedAt: cached.lastCheckedAt }),
            ...(latestVersion === null ? {} : { latestVersion }),
          }),
    }, options.configDir)
  }

  if (!latestVersion || !isNewerVersion(latestVersion, options.currentVersion)) return null

  return {
    currentVersion: options.currentVersion,
    latestVersion,
    upgradeCommand: resolveInstallInfo({ ...(options.configDir ? { configDir: options.configDir } : {}) }).upgradeCommand,
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
