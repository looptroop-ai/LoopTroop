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
  /** Every tag this run should point at its index, version tag first. */
  tags: string[]
  /**
   * Every floating tag this run is *not* writing, which it must therefore leave
   * exactly where it found it.
   *
   * Derived rather than listed: it is the whole floating universe minus what is
   * being written, so a run can never quietly move a tag it did not plan to. A
   * stable release must not disturb `next`; a prerelease must not disturb
   * `latest` or the series; a repair that has no authority to move any of them
   * must not disturb all three.
   */
  mustNotMove: string[]
}

/** Every tag whose meaning is "whichever release is currently X". */
function floatingUniverse(series: string): string[] {
  return ['latest', 'next', series]
}

function withMustNotMove(stable: boolean, series: string, tags: string[]): TagPlan {
  return { stable, series, tags, mustNotMove: floatingUniverse(series).filter((tag) => !tags.includes(tag)) }
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

  return withMustNotMove(stable, series, tags)
}

/**
 * The same plan with the floating tags cut down to the ones named.
 *
 * A release is publishing the newest thing there is, so every floating tag it
 * plans is one it should move. A repair is not: it is republishing a version
 * that may be years behind, and the plan above would have it take `latest` and
 * the series back with it — a repair of 0.5.0 after 0.8.0 shipped would make
 * `docker pull looptroopai/looptroop` serve 0.5.0 again. So a repair names
 * exactly which floating tags it has evidence for, and every one it does not
 * name moves from "write it" to "prove it did not move".
 *
 * Naming a tag the release rules would not have allowed is refused rather than
 * trimmed: the caller believing a prerelease may take `latest` is a fault in the
 * caller, not something to silently correct.
 */
export function restrictFloating(plan: TagPlan, floating: string[]): TagPlan {
  const allowed = plan.tags.slice(1)
  for (const tag of floating) {
    if (!floatingUniverse(plan.series).includes(tag)) {
      throw new Error(`'${tag}' is not a floating tag (expected latest, next or ${plan.series})`)
    }
    if (!allowed.includes(tag)) {
      throw new Error(`'${tag}' is not a tag this version may carry; the release rules allow ${allowed.join(' ') || 'none'}`)
    }
  }
  const tags = [plan.tags[0]!, ...allowed.filter((tag) => floating.includes(tag))]
  return withMustNotMove(plan.stable, plan.series, tags)
}

/**
 * The floating tags whose current value proves they belong to this version.
 *
 * npm is the authority, because it is the channel that has a publish job with an
 * opinion: `latest` and `next` are exactly what npm's dist-tags say they are, so
 * a repair moves a container floating tag only where the package registry
 * already agrees it points at this version. The series has no npm equivalent, so
 * it is decided by ordering — the tag belongs to this version only if no later
 * stable release shares the series.
 *
 * Everything unproven is simply absent from the result, which makes it a tag the
 * repair must leave alone.
 */
export function authoritativeFloating(
  version: string,
  series: string,
  distTags: { latest?: string, next?: string },
  publishedVersions: string[],
): string[] {
  const floating: string[] = []
  if (distTags.latest === version) floating.push('latest')
  if (distTags.next === version) floating.push('next')

  // Stable only, matching the release rules: a prerelease never holds the series.
  const isStable = !version.includes('-')
  if (isStable) {
    const newest = publishedVersions
      .filter((candidate) => !candidate.includes('-') && candidate.startsWith(`${series}.`))
      .reduce((best: string | null, candidate) => (best === null || comparePatch(candidate, best) > 0 ? candidate : best), null)
    if (newest === version) floating.push(series)
  }
  return floating
}

/** Patch-level ordering within one series, numeric so 0.4.10 follows 0.4.9. */
function comparePatch(a: string, b: string): number {
  const patch = (value: string): number => Number(value.split('.')[2] ?? '0')
  return patch(a) - patch(b)
}

/** The floating tags a run must leave exactly where it found them. */
export function tagsThatMustNotMove(plan: TagPlan): string[] {
  return plan.mustNotMove
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

/** What an image says about itself, from the labels the Dockerfile sets. */
export interface Provenance {
  version: string | null
  revision: string | null
}

/** The OCI labels out of an image config, as `imagetools inspect --format
 * '{{json .Image}}'` prints it for a single-platform manifest. */
export function readImageProvenance(rawConfig: string): Provenance {
  const config: unknown = JSON.parse(rawConfig)
  const labels = (config as { config?: { Labels?: Record<string, unknown> } }).config?.Labels ?? {}
  const read = (key: string): string | null => (typeof labels[key] === 'string' ? labels[key] : null)
  return {
    version: read('org.opencontainers.image.version'),
    revision: read('org.opencontainers.image.revision'),
  }
}

/**
 * Whether an already-published image is this release's own.
 *
 * The question a repair has to answer that bytes alone cannot: a rebuild of the
 * same release does not reproduce the same digests, because the base image and
 * the Debian and GitHub CLI repositories it installs from all move. So an index
 * already sitting on the version tag with digests this run did not produce is
 * either the earlier publish of this very release — the thing a repair exists to
 * finish — or something else entirely, and the two have to be told apart before
 * anything is written.
 *
 * The labels answer it, because the image carries the version and the commit it
 * was built from and nothing else in this repository writes that tag. Both must
 * match: a version alone would accept an image built from another commit.
 */
export function isOurRelease(provenance: Provenance, version: string, revision: string): boolean {
  if (provenance.version === null || provenance.revision === null) return false
  return provenance.version === version && provenance.revision === revision
}

/** The architectures every image this project publishes must carry, and only these. */
export const REQUIRED_PLATFORMS = ['linux/amd64', 'linux/arm64'] as const

/**
 * Why an index is not one of ours, or null when its shape is right.
 *
 * Checked before an existing index is ever copied anywhere. "It parses and has
 * some manifests" is not enough to inherit a release from: an index carrying one
 * architecture pulls confusingly for half the world, and one carrying a third
 * would have this project publishing something it never built.
 */
export function platformProblem(platforms: PlatformEntry[]): string | null {
  const present = platforms.map((entry) => `${entry.os}/${entry.architecture}`).sort()
  const expected = [...REQUIRED_PLATFORMS].sort()
  if (present.length !== expected.length || present.some((value, i) => value !== expected[i])) {
    return `carries ${present.join(' ') || '(nothing)'}, expected exactly ${expected.join(' ')}`
  }
  if (new Set(platforms.map((entry) => entry.digest)).size !== platforms.length) {
    return 'lists the same manifest for more than one architecture'
  }
  return null
}

/** The manifest an index lists for one platform, or null when it lists none. */
export function platformDigest(raw: string, os: string, architecture: string): string | null {
  const { platforms } = parseIndex(raw)
  const entry = platforms.find((p) => p.os === os && p.architecture === architecture)
  return entry ? entry.digest : null
}
