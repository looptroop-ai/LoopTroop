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
  /** `gh` publishes GitHub releases, so the newest one is the answer. */
  gh: 'https://api.github.com/repos/cli/cli/releases/latest',
  /**
   * git has no release feed — the GitHub mirror publishes tags and nothing
   * else, so the newest stable tag is the closest thing to "current git".
   * Release candidates (`v2.55.0-rc1`) are excluded by the shape of the match.
   */
  git: 'https://api.github.com/repos/git/git/tags?per_page=100',
} as const

export type ToolName = keyof typeof SOURCES

export type LatestToolVersions = Record<ToolName, string | null>

/** Highest `MAJOR.MINOR.PATCH`, ignoring anything with a suffix. */
function newestStableTag(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null
  const versions = tags
    .map((tag) => (tag as { name?: unknown }).name)
    .filter((name): name is string => typeof name === 'string')
    .map((name) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [Number(match[1]), Number(match[2]), Number(match[3])] as const)

  if (versions.length === 0) return null
  // Sorted here rather than trusting the API's order, which is not documented
  // to be by version and is not, for a repository with thousands of tags.
  const [major, minor, patch] = versions.sort((a, b) =>
    b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0]!
  return `${major}.${minor}.${patch}`
}

interface ToolCache {
  lastAttemptAt: string
  versions?: Partial<LatestToolVersions>
}

const EMPTY: LatestToolVersions = { node: null, npm: null, opencode: null, gh: null, git: null }

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

/**
 * Three answer shapes behind one call: npm's registry returns `{ version }`, a
 * GitHub release returns `{ tag_name }`, and a tag listing returns an array to
 * pick the newest stable entry from.
 */
async function fetchVersion(
  name: ToolName,
  url: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'LoopTroop-doctor' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body: unknown = await response.json()

    if (name === 'git') return newestStableTag(body)
    if (name === 'gh') {
      const tag = (body as { tag_name?: unknown }).tag_name
      return typeof tag === 'string' && tag !== '' ? tag.replace(/^v/, '') : null
    }
    const version = (body as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : null
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
  // In parallel: independent endpoints, and one being slow should not add its
  // timeout to the others.
  const results = await Promise.all(names.map((name) => fetchVersion(name, SOURCES[name], fetchImpl)))

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
