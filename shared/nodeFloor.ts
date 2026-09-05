/**
 * The minimum Node runtime, stated once.
 *
 * `package.json`'s `engines.node` is the only place the number is written by
 * hand. It was written by hand in four more, with three different answers: the
 * launcher compared major.minor against 24.18 and printed `24.18.0`, `doctor`
 * accepted anything from 24.15, and the read-only install verifier agreed with
 * `doctor`. A machine on 24.15–24.17 therefore passed every check the product
 * offered and then hit a launcher that refused to start it.
 *
 * This module is the comparison, not the value: it has no I/O and no floor of
 * its own, so both halves of the app and the packaging scripts can use the same
 * semantics on a floor each resolves for itself.
 *
 * The comparison is patch-level. The floor really is a patch release — 24.18.1
 * carries fixes the app depends on — and comparing only major.minor is what let
 * the launcher tell a user on 24.18.0 that they needed 24.18.0.
 */

export interface NodeVersion {
  major: number
  minor: number
  patch: number
  /**
   * `24.18.1-nightly.0` is *before* `24.18.1`, which is how npm reads
   * `engines.node` and how the installer already reads a runtime. Carrying the
   * flag rather than discarding the suffix is what lets the comparison agree
   * with both.
   */
  prerelease: boolean
}

/**
 * Reads `24.18.1`, `v24.18.1` and `24.18.1-nightly.0` alike; a missing or
 * unreadable component is 0, which can only ever *under*-report a runtime and
 * so fails closed against the floor.
 */
export function parseNodeVersion(raw: string): NodeVersion {
  const text = String(raw).replace(/^v/, '')
  const [core = ''] = text.split('-')
  const [major = 0, minor = 0, patch = 0] = core
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  return { major, minor, patch, prerelease: text.includes('-') }
}

/**
 * `>=24.18.1` and `24.18.1` both read as the same floor.
 *
 * Throws rather than returning `0.0.0`. An unreadable floor is not a lenient
 * floor: `satisfiesNodeFloor` would compare every runtime against zero and pass
 * it, which is the silent bypass the whole module exists to prevent. The value
 * reaches here from `engines.node`, a build-time define or a release manifest,
 * and none of those has a sane fallback — a wrong one has to stop the build,
 * the install or the check rather than quietly disable it.
 */
export function parseNodeFloor(engines: string): NodeVersion {
  const floor = parseNodeVersion(String(engines).replace(/^[^\d]*/, ''))
  if (floor.major <= 0) {
    throw new Error(`Unreadable Node floor: ${JSON.stringify(engines)}. Expected a form like ">=24.18.1".`)
  }
  return floor
}

/** `24.18.1` — the form every message the user reads should print. */
export function formatNodeVersion(version: NodeVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

export function satisfiesNodeFloor(have: NodeVersion, floor: NodeVersion): boolean {
  if (have.major !== floor.major) return have.major > floor.major
  if (have.minor !== floor.minor) return have.minor > floor.minor
  if (have.patch !== floor.patch) return have.patch > floor.patch
  // Same numbers, so the only thing left to separate them is the suffix: a
  // prerelease of the floor is below a floor that has none.
  return !have.prerelease || floor.prerelease
}
