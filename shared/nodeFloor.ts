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
}

/**
 * Reads `24.18.1`, `v24.18.1` and `24.18.1-nightly` alike; a missing or
 * unreadable component is 0, which can only ever *under*-report a runtime and
 * so fails closed against the floor.
 */
export function parseNodeVersion(raw: string): NodeVersion {
  const [major = 0, minor = 0, patch = 0] = String(raw)
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  return { major, minor, patch }
}

/** `>=24.18.1` and `24.18.1` both read as the same floor. */
export function parseNodeFloor(engines: string): NodeVersion {
  return parseNodeVersion(String(engines).replace(/^[^\d]*/, ''))
}

/** `24.18.1` — the form every message the user reads should print. */
export function formatNodeVersion(version: NodeVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

export function satisfiesNodeFloor(have: NodeVersion, floor: NodeVersion): boolean {
  if (have.major !== floor.major) return have.major > floor.major
  if (have.minor !== floor.minor) return have.minor > floor.minor
  return have.patch >= floor.patch
}
