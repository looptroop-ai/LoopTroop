/**
 * Version bump logic, kept pure so every rule is testable without touching
 * the working tree.
 *
 * A release starts by writing one version into four places that must agree:
 * `package.json`, both version fields in `package-lock.json`, the changelog
 * heading, and the archived release note. `scripts/verify-version-single-source.mjs`
 * is a required check on the resulting pull request, so a bump that updates
 * three of the four does not produce a reviewable release — it produces a red
 * pull request that cannot be merged.
 *
 * The mutating half lives in `applyBump`; everything above it decides, and is
 * called directly by the tests.
 */

// Extensions are explicit because these scripts run under bare `node`, not tsx.
// Node executes TypeScript directly but does not resolve a missing extension.
import { findRelease, parseChangelog, renderReleaseNotes } from './changelog-release-notes.ts'

/** A parsed release version. `prerelease` is the `N` of `-rc.N`, or null. */
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: number | null
}

/**
 * `MAJOR.MINOR.PATCH` with an optional `-rc.N`.
 *
 * Deliberately narrower than semver: this repository ships stable releases and
 * release candidates, and every other prerelease spelling npm would accept
 * (`-beta`, `-next.1`, build metadata) is a shape no channel here knows how to
 * route. Accepting one would publish it under a dist-tag chosen by accident.
 */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/

/**
 * Numeric identifiers must not carry a leading zero.
 *
 * npm accepts `9.9.9-rc.01` as a string but semver does not define it, so it
 * sorts unpredictably against `rc.1` and `rc.2`. Two publishes later the
 * ordering the `next` dist-tag implies stops matching the ordering users see.
 */
function hasLeadingZero(field: string): boolean {
  return field.length > 1 && field.startsWith('0')
}

export function parseVersion(value: string): ParsedVersion {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new Error(`Version must be a bare string with no surrounding whitespace, got ${JSON.stringify(value)}.`)
  }

  const match = VERSION_PATTERN.exec(value)
  if (!match) {
    throw new Error(
      `Version "${value}" is not MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-rc.N. `
      + 'No leading "v", and no prerelease name other than -rc.N.',
    )
  }

  const [, major, minor, patch, prerelease] = match
  if (major === undefined || minor === undefined || patch === undefined) {
    // `VERSION_PATTERN` has three mandatory groups, so a match always has them.
    // Saying so is better than asserting it away: if the pattern ever gains an
    // optional group in front of these, this fails loudly instead of writing
    // `undefined` into a released version number.
    throw new Error(`Version "${value}" matched the version pattern without its numeric fields.`)
  }

  for (const [label, field] of [['major', major], ['minor', minor], ['patch', patch]] as const) {
    if (hasLeadingZero(field)) {
      throw new Error(`Version "${value}" has a leading zero in its ${label} field, which semver does not define.`)
    }
  }

  if (prerelease !== undefined) {
    if (hasLeadingZero(prerelease)) {
      throw new Error(
        `Version "${value}" has a leading zero in its release-candidate number. `
        + 'Write -rc.1, not -rc.01: npm accepts the string but sorts it unpredictably.',
      )
    }
    if (Number(prerelease) < 1) {
      throw new Error(`Version "${value}" numbers its release candidate from zero; the first candidate is -rc.1.`)
    }
  }

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? null : Number(prerelease),
  }
}

/**
 * Negative when `a` precedes `b`, positive when it follows, zero when equal.
 *
 * Field-by-field on integers rather than lexicographically, so 0.4.10 sorts
 * above 0.4.9 instead of below it. A release candidate precedes the stable
 * release it leads to.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)

  for (const field of ['major', 'minor', 'patch'] as const) {
    if (left[field] !== right[field]) return left[field] - right[field]
  }

  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === null) return 1
  if (right.prerelease === null) return -1
  return left.prerelease - right.prerelease
}

/** True when `candidate` is a release this repository may move on to. */
export function isForwardBump(current: string, candidate: string): boolean {
  return compareVersions(candidate, current) > 0
}

export function assertForwardBump(current: string, candidate: string): void {
  if (current === candidate) {
    throw new Error(`Version ${candidate} is already the current version.`)
  }
  if (!isForwardBump(current, candidate)) {
    throw new Error(
      `Version ${candidate} does not come after the current version ${current}. `
      + 'A release may only move forwards; republishing a version is not possible on npm.',
    )
  }
}

/**
 * The dist-tag a version must publish under.
 *
 * npm tags every publish `latest` unless told otherwise — it does not infer
 * anything from `-rc.N`. Publishing a candidate without this would make it the
 * version `npm i -g looptroop` installs for everyone.
 */
export function distTagFor(version: string): 'latest' | 'next' {
  return parseVersion(version).prerelease === null ? 'latest' : 'next'
}

/** True when the version is a release candidate rather than a stable release. */
export function isPrerelease(version: string): boolean {
  return parseVersion(version).prerelease !== null
}

/**
 * The changelog rewrite a bump performs.
 *
 * `## Unreleased` becomes the released heading and a fresh, empty `Unreleased`
 * takes its place, so the next change has somewhere to land. The released
 * section is returned alongside so the caller can archive it without parsing
 * the result a second time.
 */
export interface ChangelogBump {
  /** The full rewritten changelog. */
  contents: string
  /** Just the newly released section, heading included. */
  releasedSection: string
}

const UNRELEASED_HEADING = /^##\s+Unreleased\s*$/gm

/**
 * The note under `## Unreleased` explaining what the section is for.
 *
 * It describes the placeholder, not the release, so it is carried up into the
 * new empty section rather than shipped as the first line of the release.
 */
const UNRELEASED_NOTE = '> Changes merged since the last versioned release that have not yet shipped in a tagged version.'

/**
 * Refuses a bump whose notes the release workflow could not publish.
 *
 * The bump and the publish read the same section through different code, and the
 * publish is the stricter of the two: it needs `Release Highlights` or `Summary`
 * to carry entries, because that is the body of the GitHub Release. Discovering
 * that at publish time costs a release cycle — the bump commit, the pull request
 * and its required checks all exist by then — so the renderer is run here, over
 * the exact section about to be written, and its own error is surfaced.
 *
 * The renderer's own message is quoted rather than paraphrased, so the reason a
 * bump was refused is the same sentence the release would have failed with.
 */
function assertReleaseNotesWouldRender(releasedSection: string, version: string): void {
  try {
    renderReleaseNotes(findRelease(parseChangelog(releasedSection), version))
  } catch (error) {
    throw new Error(
      `The "## Unreleased" section cannot be published as release notes: ${(error as Error).message} `
      + 'Add the user-facing entries under "### Release Highlights" (or "### Summary"); the '
      + 'per-category sections below it are for contributors and are not published.',
    )
  }
}

export function bumpChangelog(contents: string, version: string, date: string): ChangelogBump {
  const headings = [...contents.matchAll(UNRELEASED_HEADING)]

  if (headings.length === 0) {
    throw new Error(
      'CHANGELOG.md has no "## Unreleased" heading, so there is nothing to release. '
      + 'Every change merged since the last release should be listed under it.',
    )
  }
  if (headings.length > 1) {
    throw new Error(
      `CHANGELOG.md has ${headings.length} "## Unreleased" headings; expected exactly one. `
      + 'Merge them before releasing, or the release notes will only describe one of them.',
    )
  }

  const existing = new RegExp(String.raw`^##\s+${version.replace(/\./g, String.raw`\.`)}\s*\(`, 'm')
  if (existing.test(contents)) {
    throw new Error(`CHANGELOG.md already has a "## ${version}" section. This version has been released before.`)
  }

  const headingStart = headings[0]!.index!
  const headingEnd = headingStart + headings[0]![0].length

  // The released section runs to the next level-2 heading, which is the
  // previous release. There is always one: the changelog is never empty by the
  // time a release is cut, and `findRelease` would fail loudly if it were.
  const rest = contents.slice(headingEnd)
  const nextHeading = /^##\s+/m.exec(rest)
  const bodyEnd = nextHeading ? headingEnd + nextHeading.index : contents.length

  const body = contents.slice(headingEnd, bodyEnd)
  const releasedBody = body.replace(UNRELEASED_NOTE, '').replace(/^\n+/, '\n\n').trimEnd()

  // Any list item at all means the section is not blank, but it does not mean a
  // release can be cut from it. The workflow publishes `renderReleaseNotes`,
  // which reads `Release Highlights` or `Summary` and throws when neither has
  // entries — so entries under `### Fixed` alone satisfy this check and fail the
  // release two steps later, after the bump commit and the PR already exist.
  //
  // Checked by running the real renderer over the section this bump is about to
  // write, rather than by restating its rule here: a second copy of the rule is
  // a second thing to drift.
  const releasedHeading = `## ${version} (${date})`
  const releasedSection = `${releasedHeading}\n${releasedBody}\n`
  assertReleaseNotesWouldRender(releasedSection, version)

  const freshUnreleased = `## Unreleased\n\n${UNRELEASED_NOTE}\n\n`

  return {
    contents: contents.slice(0, headingStart) + freshUnreleased + releasedSection + '\n' + contents.slice(bodyEnd),
    releasedSection,
  }
}

/**
 * Both places `package-lock.json` records this package's own version.
 *
 * `npm version` writes both; a hand edit or a naive script writes the first and
 * leaves `packages[""].version` behind, which `verify:version` rejects and
 * `npm ci` then reinstates on the next install — so the release pull request
 * fails its own required check.
 */
export function bumpLockfile(contents: string, version: string): string {
  const lock: { version?: string, packages?: Record<string, { version?: string }> } = JSON.parse(contents)

  if (lock.packages?.[''] === undefined) {
    throw new Error('package-lock.json has no root package entry (packages[""]), so its version cannot be set.')
  }

  lock.version = version
  lock.packages[''].version = version

  // Two-space indent and a trailing newline is what npm itself writes; anything
  // else turns every release into a whole-file diff.
  return `${JSON.stringify(lock, null, 2)}\n`
}

/**
 * `package.json` with only the version replaced.
 *
 * Text substitution rather than parse-and-stringify: the manifest's key order
 * and formatting are reviewed material, and round-tripping it through JSON
 * would reformat the file in the same commit that changes the version.
 */
export function bumpManifest(contents: string, version: string): string {
  const pattern = /^(\s*"version"\s*:\s*)"[^"]*"/m
  if (!pattern.test(contents)) {
    throw new Error('package.json has no "version" field to bump.')
  }
  return contents.replace(pattern, `$1"${version}"`)
}

