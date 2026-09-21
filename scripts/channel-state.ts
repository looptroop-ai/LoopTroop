/**
 * Whether to write a descriptor into a package channel, and what that means if
 * something is already there.
 *
 * Every one of these channels is a repository somebody else can also push to —
 * a tap, a bucket, a moderated feed — so "publish this version" is never a
 * simple write. The states below are the ones that actually occur, and each has
 * exactly one safe answer. Pure, and tested, because the unsafe answers are
 * silent: overwriting a newer version downgrades every user on the channel, and
 * overwriting the same version with different bytes makes a hash that somebody
 * already verified stop matching.
 */
import type { ParsedDescriptor } from './package-manifests.ts'
import { REPOSITORY, bundleFileName } from './package-manifests.ts'

export interface DesiredDescriptor {
  version: string
  url: string
  sha256: string
}

export type ChannelDecision =
  /** Nothing there, or nothing readable there. */
  | { action: 'publish', reason: string }
  /** An older version. The ordinary release case. */
  | { action: 'update', reason: string, from: string }
  /** This exact version, byte-for-byte in the fields that matter. */
  | { action: 'noop', reason: string }
  /** This version, pointing somewhere else. Needs a human. */
  | { action: 'conflict', reason: string, differences: string[] }
  /** A newer version than the one being published. */
  | { action: 'refuse', reason: string }

/** Semver ordering with prereleases below the release they precede. */
export function compareVersions(left: string, right: string): number {
  const split = (value: string) => {
    const [core = '', pre = null] = value.replace(/^v/, '').split('-', 2)
    return { core: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre }
  }

  const a = split(left)
  const b = split(right)

  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }

  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1

  const aParts = a.pre.split('.')
  const bParts = b.pre.split('.')
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const x = aParts[index]
    const y = bParts[index]
    if (x === y) continue
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) < Number(y) ? -1 : 1
    return x < y ? -1 : 1
  }

  return 0
}

/**
 * Where a release asset of this project lives.
 *
 * Built from `REPOSITORY` rather than a second copy of the owner and name, so
 * a rename cannot leave the guard disagreeing with the generator that produced
 * the URL it is judging. Not taken from an argument either: "which project's
 * releases may this descriptor serve" is not a decision any caller should get
 * to make. `channel-push.ts` takes a `--repo`, but that is the tap or bucket
 * being *written to*; nothing there constrains where users' bytes come from.
 */
export function releaseAssetUrl(version: string, assetName: string): string {
  return `${REPOSITORY}/releases/download/v${version.replace(/^v/, '')}/${assetName}`
}

/** The same repository as `owner/name`, which is what `gh --repo` takes. */
export const SOURCE_REPOSITORY = new URL(REPOSITORY).pathname.replace(/^\//, '')

/**
 * Why this descriptor's URL cannot be published, or `null` when it can.
 *
 * `decideChannelWrite` only ever asks whether a version is newer, which is the
 * one question that cannot catch a descriptor whose version is a placeholder:
 * a bogus *high* version reads as an ordinary upgrade and publishes, and a
 * bogus *low* one is refused for the wrong reason. On 2026-09-14 a hand-run of
 * `channel-push.ts` carrying the example values out of its own usage line
 * — version `9.9.9`, `--repo owner/name`, a hash of all `c`s — replaced the
 * live Scoop descriptor for the current release, and `scoop install looptroop`
 * served a 404 for seven days. Neither the version check nor `--force` could
 * undo it: restoring the real version over `9.9.9` reads as a downgrade, which
 * is refused before `force` is consulted.
 *
 * Tying the URL to the version closes both halves. A placeholder version no
 * longer matches the tag in a real asset URL, and a real version cannot be
 * pointed at somebody else's host.
 *
 * `assetName` defaults to the bundle, which is what every channel written
 * through the contents API installs. The publishers that ship a different
 * asset — WinGet's Windows zip — pass their own.
 */
export function checkDescriptorUrl(url: string, version: string, assetName?: string): string | null {
  const release = version.replace(/^v/, '')
  const expected = releaseAssetUrl(release, assetName ?? bundleFileName(release))

  // The whole string, compared literally, rather than a parsed URL's protocol,
  // host and pathname. Those three leave `username`, `password`, `search`,
  // `hash`, `port` and surrounding whitespace unexamined, and the *raw* string
  // is what gets rendered into the descriptor — so a URL carrying a fragment
  // passed a component check and emitted the fragment as further lines of a
  // Homebrew formula, which is arbitrary Ruby in a published tap. An exact
  // comparison is also simpler than enumerating the parts that must be empty,
  // and the release pipeline builds this string the same way, so nothing
  // legitimate is spelled differently.
  if (url === expected) return null

  // Deliberately not echoing what was given. `fail` writes to CI stderr, a
  // rejected URL is the one most likely to carry `user:token@` or a signed
  // query, and this file already refuses to echo a failed command's argv for
  // exactly that reason.
  return `--url must be exactly ${expected}. What was passed did not match and is not repeated here, in case it carries a credential.`
}

export interface DecideOptions {
  /**
   * Lets a repair overwrite the same version with different bytes.
   *
   * Without it, a one-character typo in a published formula would be unfixable
   * without shipping a new version — which is the opposite of what a repair
   * path is for. It is never set by a release, only by an operator dispatching
   * a repair, so the dangerous case stays deliberate.
   */
  force?: boolean
}

export function decideChannelWrite(
  desired: DesiredDescriptor,
  remote: ParsedDescriptor | null,
  options: DecideOptions = {},
): ChannelDecision {
  if (remote === null) {
    return { action: 'publish', reason: 'nothing is published on this channel yet' }
  }

  // A file that exists but says nothing we recognise is not evidence of a
  // version, and guessing would either downgrade users or refuse forever. The
  // release stops and a human looks at it.
  if (remote.version === null) {
    return {
      action: 'conflict',
      reason: 'the published descriptor could not be read',
      differences: ['no version field was found in the file already on the channel'],
    }
  }

  const ordering = compareVersions(desired.version, remote.version)

  if (ordering > 0) {
    return { action: 'update', reason: `${remote.version} is published; this release is newer`, from: remote.version }
  }

  if (ordering < 0) {
    return {
      action: 'refuse',
      reason: `${remote.version} is published, which is newer than ${desired.version}; publishing would downgrade everyone on this channel`,
    }
  }

  const differences: string[] = []
  if (remote.url !== desired.url) differences.push(`url: published ${remote.url ?? '(none)'}, this release ${desired.url}`)
  if (remote.sha256 !== desired.sha256) {
    differences.push(`sha256: published ${remote.sha256 ?? '(none)'}, this release ${desired.sha256}`)
  }

  if (differences.length === 0) {
    return { action: 'noop', reason: `${desired.version} is already published with these exact bytes` }
  }

  if (options.force === true) {
    return { action: 'update', reason: `forced: replacing ${desired.version} in place`, from: remote.version }
  }

  return {
    action: 'conflict',
    reason: `${desired.version} is already published, pointing somewhere else`,
    differences,
  }
}

/** True when the decision means bytes should be written to the channel. */
export function writes(decision: ChannelDecision): boolean {
  return decision.action === 'publish' || decision.action === 'update'
}

export type ChocoPushOutcome =
  /** Accepted. On the community feed that means queued for moderation, not live. */
  | { state: 'submitted' }
  /** This version is already on the feed. A re-run of a partial release lands here. */
  | { state: 'already-published' }
  /** Anything else. */
  | { state: 'failed', reason: string }

/**
 * What `choco push` actually did.
 *
 * Two outcomes have to be told apart from failure. A package accepted onto the
 * community feed is *queued*, not published — moderation is unbounded, and
 * treating "pending review" as a failed release would hold every future release
 * open behind a human at Chocolatey. And a version already on the feed is the
 * ordinary result of re-running a release that failed after this step: a
 * Chocolatey version is immutable once accepted, so there is nothing to retry
 * and nothing wrong.
 */
export function classifyChocoPush(status: number | null, output: string): ChocoPushOutcome {
  const text = output.toLowerCase()

  // Checked before the exit code: this is reported as a failure, and it is the
  // one failure that means the work is already done.
  if (/already exists|version .* already/.test(text) && /package/.test(text)) {
    return { state: 'already-published' }
  }

  if (status === 0) return { state: 'submitted' }

  if (/unauthor|forbidden|api key|apikey/.test(text)) {
    return { state: 'failed', reason: 'the Chocolatey API key was rejected' }
  }

  return { state: 'failed', reason: `choco push exited ${status ?? '?'}` }
}
