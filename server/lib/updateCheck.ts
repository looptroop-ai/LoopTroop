import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveAppConfigDir, ensureSecureDir, secureFile } from './appConfigDir'
import { safeAtomicWrite } from '../io/atomicWrite'
import { resolveInstallInfo, isNewerVersion, type InstallChannel } from './installChannel'

const LATEST_RELEASE_URL = 'https://api.github.com/repos/looptroop-ai/LoopTroop/releases/latest'

/** Refresh often enough for release-day discovery without taxing GitHub on every command. */
export const CHECK_INTERVAL_MS = 15 * 60 * 1000

const REQUEST_TIMEOUT_MS = 3_000

export interface ReleaseDetails {
  version: string
  name: string
  url: string
  publishedAt: string | null
  notes: string
}

interface UpdateCache {
  lastAttemptAt: string
  lastCheckedAt?: string
  latestVersion?: string
  release?: ReleaseDetails
}

export interface UpdateStatus {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  checkedAt: string | null
  installChannel: InstallChannel
  upgradeCommand: string
  upgradeFirst?: string
  postUpgradeCommand?: string
  upgradeNote?: string
  release: ReleaseDetails | null
}

export interface UpdateNotice {
  currentVersion: string
  latestVersion: string
  upgradeCommand: string
  upgradeFirst?: string
  postUpgradeCommand?: string
  upgradeNote?: string
}

function getCachePath(configDir = resolveAppConfigDir()): string {
  return resolve(configDir, 'update-check.json')
}

function isReleaseDetails(value: unknown): value is ReleaseDetails {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ReleaseDetails>
  return typeof candidate.version === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.url === 'string'
    && (candidate.publishedAt === null || typeof candidate.publishedAt === 'string')
    && typeof candidate.notes === 'string'
}

/** Tolerates cache files written by the older npm-version-only checker. */
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
      ...(isReleaseDetails(candidate.release) ? { release: candidate.release } : {}),
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
  /** Version-only injection retained for focused tests and offline callers. */
  fetchLatest?: () => Promise<string | null>
  /** Full release injection used by tests that exercise changelog metadata. */
  fetchRelease?: () => Promise<ReleaseDetails | null>
  now?: () => number
}

async function fetchLatestRelease(): Promise<ReleaseDetails | null> {
  try {
    const response = await fetch(LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'LoopTroop-update-check',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body = await response.json() as Record<string, unknown>
    if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string') return null
    const version = body.tag_name.replace(/^v/, '')
    return {
      version,
      name: typeof body.name === 'string' && body.name ? body.name : `LoopTroop ${version}`,
      url: body.html_url,
      publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
      notes: typeof body.body === 'string' ? body.body : '',
    }
  } catch {
    return null
  }
}

export async function getUpdateStatus(options: CheckForUpdateOptions): Promise<UpdateStatus> {
  const now = options.now?.() ?? Date.now()
  const cached = readCache(options.configDir)
  let latestVersion = cached?.latestVersion ?? null
  let release = cached?.release ?? null
  let checkedAt = cached?.lastCheckedAt ?? null
  const lastAttempt = cached ? Date.parse(cached.lastAttemptAt) : Number.NaN
  const isStale = !Number.isFinite(lastAttempt) || now - lastAttempt > CHECK_INTERVAL_MS

  if (isStale) {
    const attemptedAt = new Date(now).toISOString()
    const fetchedRelease = options.fetchRelease
      ? await options.fetchRelease()
      : options.fetchLatest
        ? await options.fetchLatest().then((version) => version === null ? null : {
            version,
            name: `LoopTroop ${version}`,
            url: `https://github.com/looptroop-ai/LoopTroop/releases/tag/v${version}`,
            publishedAt: null,
            notes: '',
          })
        : await fetchLatestRelease()

    if (fetchedRelease) {
      release = fetchedRelease
      latestVersion = fetchedRelease.version
      checkedAt = attemptedAt
    }

    writeCache({
      lastAttemptAt: attemptedAt,
      ...(checkedAt === null ? {} : { lastCheckedAt: checkedAt }),
      ...(latestVersion === null ? {} : { latestVersion }),
      ...(release === null ? {} : { release }),
    }, options.configDir)
  }

  const install = resolveInstallInfo({ ...(options.configDir ? { configDir: options.configDir } : {}) })
  return {
    currentVersion: options.currentVersion,
    latestVersion,
    updateAvailable: latestVersion !== null && isNewerVersion(latestVersion, options.currentVersion),
    checkedAt,
    installChannel: install.channel,
    upgradeCommand: install.upgradeCommand,
    ...(install.upgradeFirst === undefined ? {} : { upgradeFirst: install.upgradeFirst }),
    ...(install.postUpgradeCommand === undefined ? {} : { postUpgradeCommand: install.postUpgradeCommand }),
    ...(install.upgradeNote === undefined ? {} : { upgradeNote: install.upgradeNote }),
    release,
  }
}

/** Returns a notice only when a newer published GitHub release exists. */
export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateNotice | null> {
  const status = await getUpdateStatus(options)
  if (!status.updateAvailable || status.latestVersion === null) return null
  return {
    currentVersion: status.currentVersion,
    latestVersion: status.latestVersion,
    upgradeCommand: status.upgradeCommand,
    ...(status.upgradeFirst === undefined ? {} : { upgradeFirst: status.upgradeFirst }),
    ...(status.postUpgradeCommand === undefined ? {} : { postUpgradeCommand: status.postUpgradeCommand }),
    ...(status.upgradeNote === undefined ? {} : { upgradeNote: status.upgradeNote }),
  }
}

export function formatUpdateNotice(notice: UpdateNotice): string {
  return [
    '',
    `LoopTroop ${notice.latestVersion} is available (you have ${notice.currentVersion}).`,
    ...(notice.upgradeFirst === undefined ? [] : [`  ${notice.upgradeFirst}`]),
    `  ${notice.upgradeCommand}`,
    ...(notice.postUpgradeCommand === undefined ? [] : [`  ${notice.postUpgradeCommand}`]),
    ...(notice.upgradeNote === undefined ? [] : [`  ${notice.upgradeNote}`]),
    '',
  ].join('\n')
}

export function formatUpdateStatusNotice(status: UpdateStatus): string {
  if (!status.updateAvailable || status.latestVersion === null) return ''
  return formatUpdateNotice(status as UpdateNotice & { latestVersion: string })
}
