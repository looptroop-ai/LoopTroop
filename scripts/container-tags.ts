/**
 * The decisions behind tagging a released container image, separated from the
 * `docker` calls that carry them out.
 *
 * They live here rather than in the workflow because two workflows make them —
 * the release run and the repair dispatch — and the consequences of the two
 * disagreeing are not symmetrical. A wrong build flag fails loudly; a pre-flight
 * that reads "rate limited" as "tag does not exist" overwrites a published tag
 * and nobody finds out until a user pulls a version and gets another one.
 */

/** `X.Y.Z` with an optional prerelease suffix. No build metadata: nothing in this
 * project produces one, and accepting `+build` would make `X.Y` ambiguous. */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/

/** A sha256 descriptor digest, lowercase hex, as a registry reports it. */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

export interface TagPlan {
  /** True for a stable release, false when the version carries a prerelease. */
  stable: boolean
  /** The `X.Y` series tag, whether or not this release publishes it. */
  series: string
  /** Every tag this release should point at its index, version tag first. */
  tags: string[]
}

/**
 * Which tags a release publishes.
 *
 * The floating tags follow the dist-tag the release resolver computed for npm
 * rather than being derived again from the version, so the two channels cannot
 * end up disagreeing about which release is `latest`. The disagreement is still
 * checked for: this is the only gate in front of the container channel, which —
 * unlike npm — has no publish job of its own to refuse a prerelease taking
 * `latest`.
 *
 * There is deliberately no bare major tag. `looptroopai/looptroop:0` would be a
 * tag whose meaning changes under anyone who pinned it, on every minor release.
 */
export function planTags(version: string, distTag: string): TagPlan {
  const match = VERSION_PATTERN.exec(version)
  if (!match) {
    throw new Error(`'${version}' is not a version this workflow publishes (expected X.Y.Z or X.Y.Z-suffix)`)
  }
  const [, major, minor, , prerelease] = match
  const stable = prerelease === undefined
  const series = `${major}.${minor}`

  if (stable && distTag !== 'latest') {
    throw new Error(`${version} is a stable version but its dist-tag is '${distTag}'`)
  }
  if (!stable && distTag === 'latest') {
    throw new Error(`${version} is a prerelease and must not carry the 'latest' tag`)
  }

  const tags = [version]
  // Stable only. A prerelease taking `0.5` would serve a release candidate to
  // anyone who pinned the series expecting stable patches.
  if (stable) tags.push(series)
  if (distTag === 'latest') tags.push('latest')
  else if (distTag === 'next') tags.push('next')

  return { stable, series, tags }
}

/**
 * The floating tags a prerelease must leave exactly where it found them. Empty
 * for a stable release, which is expected to move both.
 */
export function tagsThatMustNotMove(plan: TagPlan): string[] {
  return plan.stable ? [] : ['latest', plan.series]
}

/**
 * Whether a failed read was refused for asking too often.
 *
 * The one registry failure worth retrying, and the reason it needs naming: it is
 * the only one that is neither an absence nor a reason to stop. Docker Hub
 * rate-limits anonymous requests per IP and hosted runners share IPs, so this
 * decides between "the repository is private" and "come back in twenty seconds".
 */
export function isRateLimited(stderr: string): boolean {
  return /toomanyrequests|too many requests|rate limit|\b429\b/i.test(String(stderr ?? ''))
}

/**
 * Whether a failed registry read means "there is nothing there" or something
 * else entirely.
 *
 * Everything that is not recognisably an absence is `unknown`, and every caller
 * treats `unknown` as a hard stop. An expired token, a DNS failure and Docker
 * Hub's anonymous rate limit all fail the same read that a missing tag fails,
 * and the cost of the two mistakes is not comparable: reading an absence as an
 * error stops a release that could have continued, while reading an error as an
 * absence is how a released tag gets overwritten.
 */
export function classifyRegistryFailure(stderr: string): 'absent' | 'unknown' {
  const text = String(stderr ?? '').toLowerCase()
  // Rate limiting checked first: Docker Hub's 429 body has mentioned "not
  // found" in the past, and a limit is emphatically not an absence.
  if (isRateLimited(text)) return 'unknown'
  const absent = [
    'manifest unknown',
    'manifest_unknown',
    'name_unknown',
    'not found',
    'no such manifest',
    'repository name not known',
    'does not exist',
  ]
  return absent.some((phrase) => text.includes(phrase)) ? 'absent' : 'unknown'
}

/** A `linux/<arch>` entry in a manifest index. */
export interface PlatformEntry {
  digest: string
  os: string
  architecture: string
}

export interface ParsedIndex {
  /** False when the reference is a single image manifest rather than an index. */
  isIndex: boolean
  /** Platform manifests, attestations excluded. */
  platforms: PlatformEntry[]
}

/**
 * The platform manifests an index lists.
 *
 * Attestation manifests carry `unknown/unknown` and are dropped. These builds
 * pass `--provenance=false` precisely so none exist, but filtering keeps the
 * comparison about architectures rather than about how many descriptors the
 * index happens to hold.
 */
export function parseIndex(raw: string): ParsedIndex {
  const index: unknown = JSON.parse(raw)
  const manifests = (index as { manifests?: unknown }).manifests
  if (!Array.isArray(manifests)) return { isIndex: false, platforms: [] }

  const platforms: PlatformEntry[] = []
  for (const entry of manifests) {
    const descriptor = entry as { digest?: unknown; platform?: { os?: unknown; architecture?: unknown } }
    const digest = typeof descriptor.digest === 'string' ? descriptor.digest : ''
    const os = typeof descriptor.platform?.os === 'string' ? descriptor.platform.os : 'unknown'
    const architecture =
      typeof descriptor.platform?.architecture === 'string' ? descriptor.platform.architecture : 'unknown'
    if (architecture === 'unknown') continue
    platforms.push({ digest, os, architecture })
  }
  return { isIndex: true, platforms }
}

/**
 * Whether an index already serves exactly the manifests this run built.
 *
 * Set comparison, not order: a registry is free to list an index's manifests in
 * any order, and an index that carries the right two manifests is this
 * release's index whichever way round they appear.
 */
export function servesExactly(raw: string, built: string[]): { matches: boolean; present: string[]; isIndex: boolean } {
  const { isIndex, platforms } = parseIndex(raw)
  const present = platforms.map((entry) => entry.digest).sort()
  const expected = [...built].sort()
  return {
    isIndex,
    present,
    matches: isIndex && present.length === expected.length && present.every((d, i) => d === expected[i]),
  }
}

/** The manifest an index lists for one platform, or null when it lists none. */
export function platformDigest(raw: string, os: string, architecture: string): string | null {
  const { platforms } = parseIndex(raw)
  const entry = platforms.find((p) => p.os === os && p.architecture === architecture)
  return entry ? entry.digest : null
}
