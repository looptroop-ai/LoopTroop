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
