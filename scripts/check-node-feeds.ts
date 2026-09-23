#!/usr/bin/env node
/**
 * Fails unless every place a user gets Node from already offers the floor.
 *
 * #135 was a floor above what winget offered: the install script told Windows
 * readers to run `winget install OpenJS.NodeJS.LTS`, which gave them a Node the
 * same script then refused. Renovate raises the floor once a Node release is 90
 * days old, and winget has trailed Node by about 50 days — so the margin is
 * real but not guaranteed. The required Verify job runs this on every pull
 * request that changes `engines.node`, Renovate's or a person's, and turns
 * "probably fine" into a check.
 *
 * Unreadable counts as failing. A feed that cannot be read is not evidence the
 * floor is available there, and the pull request can simply be re-run.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  formatNodeVersion,
  parseNodeFloor,
  parseNodeVersion,
  satisfiesNodeFloor,
  type NodeVersion,
} from '../shared/nodeFloor.ts'
import { chocolateySubmission } from './smoke-published.mjs'

export interface FeedReading {
  feed: string
  /** The newest version the feed offers, or null when it could not be read. */
  offers: string | null
  error?: string
}

/** The newest of a list of version strings, ignoring anything that is not one. */
export function newestVersion(names: readonly string[]): string | null {
  const versions = names.filter((name) => /^\d+\.\d+\.\d+$/.test(name))
  versions.sort((a, b) => {
    const [x, y] = [parseNodeVersion(a), parseNodeVersion(b)]
    return x.major - y.major || x.minor - y.minor || x.patch - y.patch
  })
  return versions.at(-1) ?? null
}

/** winget keeps one directory per version under the package's manifest path. */
export function readWinget(listing: unknown): string | null {
  if (!Array.isArray(listing)) return null
  return newestVersion(listing.map((entry) => String((entry as { name?: unknown }).name ?? '')))
}

/**
 * Chocolatey's OData feed, filtered to the latest version — counted only when
 * moderation has let it through. The feed answers for a version that has merely
 * been submitted, which once had this repository report a queued package as
 * published; `chocolateySubmission` is where that lesson is written down.
 */
export function readChocolatey(xml: string): string | null {
  if (chocolateySubmission(xml).state !== 'served') return null
  return /<d:Version>([^<]+)<\/d:Version>/.exec(xml)?.[1] ?? null
}

/** A Scoop manifest states one version. */
export function readScoop(manifest: unknown): string | null {
  const version = (manifest as { version?: unknown } | null)?.version
  return typeof version === 'string' ? version : null
}

/** Homebrew's formula API; the tap depends on `node@<major>`. */
export function readHomebrew(formula: unknown): string | null {
  const stable = (formula as { versions?: { stable?: unknown } } | null)?.versions?.stable
  return typeof stable === 'string' ? stable : null
}

/** One line per feed that does not offer the floor, or that could not be read. */
export function judgeFeeds(floor: NodeVersion, readings: readonly FeedReading[]): string[] {
  const label = formatNodeVersion(floor)
  return readings.flatMap((reading) => {
    if (reading.offers === null) return [`${reading.feed}: could not be read (${reading.error ?? 'no version found'})`]
    if (!satisfiesNodeFloor(parseNodeVersion(reading.offers), floor)) {
      return [`${reading.feed}: offers ${reading.offers}, below the floor ${label}`]
    }
    return []
  })
}

async function read(feed: string, url: string, parse: (body: string) => string | null, headers: Record<string, string> = {}): Promise<FeedReading> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) return { feed, offers: null, error: `HTTP ${response.status}` }
    const offers = parse(await response.text())
    return offers === null ? { feed, offers, error: 'no approved version in the response' } : { feed, offers }
  } catch (error) {
    return { feed, offers: null, error: error instanceof Error ? error.message : String(error) }
  }
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const engines = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { engines: { node: string } }).engines
  const floor = parseNodeFloor(engines.node)
  // The winget listing comes from GitHub's API, which rate-limits anonymous
  // callers by IP — and CI runners share IPs. A read-only token avoids that.
  const github: Record<string, string> = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}

  const readings = await Promise.all([
    read('winget OpenJS.NodeJS.LTS', 'https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/o/OpenJS/NodeJS/LTS', (body) => readWinget(JSON.parse(body)), github),
    read('Chocolatey nodejs-lts', "https://community.chocolatey.org/api/v2/Packages()?$filter=Id%20eq%20'nodejs-lts'%20and%20IsLatestVersion&$select=Version,PackageStatus", readChocolatey),
    read('Scoop nodejs-lts', 'https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/nodejs-lts.json', (body) => readScoop(JSON.parse(body))),
    read(`Homebrew node@${floor.major}`, `https://formulae.brew.sh/api/formula/node@${floor.major}.json`, (body) => readHomebrew(JSON.parse(body))),
  ])

  for (const reading of readings) process.stdout.write(`  ${reading.feed.padEnd(26)} ${reading.offers ?? '(unreadable)'}\n`)
  const problems = judgeFeeds(floor, readings)
  if (problems.length > 0) {
    process.stderr.write(`FAIL: not every feed offers the Node floor ${formatNodeVersion(floor)} yet:\n`)
    for (const problem of problems) process.stderr.write(`  ${problem}\n`)
    process.exit(1)
  }
  process.stdout.write(`PASS: every feed offers Node ${formatNodeVersion(floor)} or newer.\n`)
}

/**
 * Through `realpath` on both sides, as in `installer-core.mjs`: on macOS a naive
 * comparison is false for a script under a symlinked directory, and for a check
 * like this one "false" means it does nothing and exits 0 — a silent pass.
 */
function isMainModule() {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked)
  } catch {
    return import.meta.url === pathToFileURL(invoked).href
  }
}

if (isMainModule()) await main()
