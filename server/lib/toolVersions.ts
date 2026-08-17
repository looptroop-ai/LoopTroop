import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveAppConfigDir, ensureSecureDir, secureFile } from './appConfigDir'
import { safeAtomicWrite } from '../io/atomicWrite'

/**
 * The newest published version of the tools LoopTroop runs alongside, so
 * `doctor` can show "you have this, the world has that" rather than a bare
 * number nobody can judge.
 *
 * Every lookup is a registry read with no token, cached on disk the same way the
 * release check is: one attempt per interval, failures cached too, and a stale
 * answer preferred over none. `doctor` is run when something is already wrong,
 * which is exactly when the network may be the thing that is wrong — so nothing
 * here is allowed to fail, block, or slow the checks that matter.
 */

/** Same interval as the release check: fresh enough to matter, rare enough to be polite. */
export const TOOL_CHECK_INTERVAL_MS = 15 * 60 * 1000

const REQUEST_TIMEOUT_MS = 3_000

/**
 * Node has no registry API of its own that is cheap to read — `index.json` on
 * nodejs.org is every release ever, hundreds of kilobytes. The `node` package on
 * npm mirrors the release line and answers in about a kilobyte.
 */
const SOURCES = {
  node: 'https://registry.npmjs.org/node/latest',
  npm: 'https://registry.npmjs.org/npm/latest',
  opencode: 'https://registry.npmjs.org/opencode-ai/latest',
} as const

export type ToolName = keyof typeof SOURCES

export type LatestToolVersions = Record<ToolName, string | null>

interface ToolCache {
  lastAttemptAt: string
  versions?: Partial<LatestToolVersions>
}

const EMPTY: LatestToolVersions = { node: null, npm: null, opencode: null }

function getCachePath(configDir = resolveAppConfigDir()): string {
  return resolve(configDir, 'tool-versions.json')
}

function readCache(configDir?: string): ToolCache | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getCachePath(configDir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null

    const candidate = parsed as Partial<ToolCache>
    if (typeof candidate.lastAttemptAt !== 'string') return null

    const versions: Partial<LatestToolVersions> = {}
    for (const name of Object.keys(SOURCES) as ToolName[]) {
      const value = candidate.versions?.[name]
      if (typeof value === 'string' && value !== '') versions[name] = value
    }
    return { lastAttemptAt: candidate.lastAttemptAt, versions }
  } catch {
    return null
  }
}

function writeCache(cache: ToolCache, configDir?: string): void {
  try {
    const cachePath = getCachePath(configDir)
    ensureSecureDir(resolve(cachePath, '..'))
    safeAtomicWrite(cachePath, `${JSON.stringify(cache, null, 2)}\n`)
    secureFile(cachePath)
  } catch {
    // A cache that cannot be written only costs an extra request next time.
  }
}

async function fetchVersion(url: string, fetchImpl: typeof globalThis.fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body = await response.json() as Record<string, unknown>
    return typeof body.version === 'string' && body.version !== '' ? body.version : null
  } catch {
    return null
  }
}

export interface LatestToolVersionOptions {
  configDir?: string
  fetchImpl?: typeof globalThis.fetch
  now?: () => number
}

/** Never rejects, and never takes longer than one request timeout. */
export async function getLatestToolVersions(
  options: LatestToolVersionOptions = {},
): Promise<LatestToolVersions> {
  const now = options.now?.() ?? Date.now()
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const cached = readCache(options.configDir)
  const known: LatestToolVersions = { ...EMPTY, ...cached?.versions }

  const lastAttempt = cached ? Date.parse(cached.lastAttemptAt) : Number.NaN
  if (Number.isFinite(lastAttempt) && now - lastAttempt <= TOOL_CHECK_INTERVAL_MS) return known

  const names = Object.keys(SOURCES) as ToolName[]
  // In parallel: three independent registries, and one being slow should not
  // add its timeout to the other two.
  const results = await Promise.all(names.map((name) => fetchVersion(SOURCES[name], fetchImpl)))

  const versions: LatestToolVersions = { ...known }
  names.forEach((name, index) => {
    // A failed lookup keeps whatever was known before rather than blanking it:
    // an offline machine should still show the last answer it had.
    const fetched = results[index]
    if (fetched !== null && fetched !== undefined) versions[name] = fetched
  })

  writeCache({ lastAttemptAt: new Date(now).toISOString(), versions }, options.configDir)
  return versions
}
