/**
 * Types for `smoke-published.mjs`, the driver that installs a shipped release
 * from every live feed the way the documentation tells users to.
 *
 * Written by hand rather than inferred from the source with `allowJs`, because
 * inference collapses `CHANNELS` into a fifteen-member union of object literals
 * that differ in which fields they happen to carry. That is not the contract:
 * the driver branches on `stub` and `delegate` and then calls the rest
 * unconditionally, so the three shapes below are the thing to state.
 */

/** A command the driver runs, as `spawn` arguments rather than a shell string. */
export interface CommandSpec {
  command?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  shell?: boolean
  /** The documented one-liner this spec stands for, for the run log. */
  display?: string
  /** Set by the standalone-executable channels: a directory to delete instead. */
  removePath?: string
}

/** One scheduled run of a channel: an OS, a tier and an OpenCode source. */
export interface ChannelLeg {
  os: string
  tier: string
  opencode: string
}

/** One row of the planned matrix, as the workflow consumes it. */
export interface MatrixLeg {
  key: string
  channel: string
  os: string
  tier: string
  opencode: string
  /** `key (os)` — the matrix is asserted by name, never by count. */
  name: string
}

/** What `looptroop doctor` and `status` must report after this channel installs. */
export interface ChannelExpectation {
  channel: string
  /**
   * A function, not a string: the binary channel's upgrade command differs by
   * platform, so the shape has to allow it everywhere.
   */
  upgradeCommand: (platform: string) => string
  okChecksPre: string[]
  okChecksPost: string[]
}

/** Fields every channel carries, live or not. */
interface ChannelCommon {
  /** Verbatim from the published docs. If those change, this must change too. */
  documented: string
}

/**
 * A channel that exists but is not publicly installable yet.
 *
 * It is never scheduled and has no legs, install or uninstall — it exists so
 * `--plan` can report what is uncovered rather than stay silent about it.
 */
export interface StubChannel extends ChannelCommon {
  /** Why the feed is not live. Its presence is what makes this a stub. */
  stub: string
  legs?: undefined
  delegate?: undefined
  install?: undefined
  uninstall?: undefined
  published?: undefined
  latest?: undefined
  daemon?: undefined
  port?: undefined
  opencodePort?: undefined
  pinnable?: undefined
  propagationCapMs?: undefined
  publishJob?: undefined
  publishHint?: undefined
  expect?: undefined
  provesOwnRuntime?: undefined
  moderated?: undefined
  submission?: undefined
  requiresReleaseAsset?: undefined
}

/**
 * A channel whose publish is a submission to a queue somebody else works.
 *
 * Chocolatey moderates every version and WinGet reviews every manifest, so the
 * feed serving an older release is the expected state for a while after a tag.
 * `graceDays` is how long that stays a deliberate skip rather than a failure.
 */
export interface ModeratedChannel {
  queue: string
  graceDays: number
}

/**
 * What a moderation queue says about a version the feed is not serving.
 *
 * `queued` is the only state that can excuse the absence. `rejected` and
 * `absent` are answers rather than waits, and `served` means the question was
 * asked of a version the feed does carry.
 */
export interface ChannelSubmission {
  state: 'queued' | 'rejected' | 'absent' | 'served'
  /** When the submission was made, in epoch milliseconds, or null if unknown. */
  at: number | null
  /** One clause naming the state, for the skip reason or the failure. */
  detail: string
}

/** Fields shared by the channels that are actually scheduled. */
interface LiveChannel extends ChannelCommon {
  stub?: undefined
  legs: ChannelLeg[]
  pinnable?: boolean
  propagationCapMs?: number
  publishJob?: string
  publishHint?: string
  /**
   * What the feed serves for this version, or null.
   *
   * Takes the recipe as well as the version: every probe is called as
   * `recipe.published(recipe, version)`, and the recipe is how a shared probe
   * knows which channel it is answering for.
   */
  published?: (recipe: ChannelRecipe, version: string) => unknown
  /** Present when the documented command resolves a moving pointer. */
  latest?: () => unknown
  /** Present when a human reviews the submission before the feed serves it. */
  moderated?: ModeratedChannel
  /** Where a moderated channel's queue state is read from. */
  submission?: (version: string) => Promise<ChannelSubmission>
  /** A release asset without which this channel publishes nothing. */
  requiresReleaseAsset?: (version: string) => string
}

/**
 * A channel whose run is handed to another smoke script.
 *
 * It carries no install or uninstall of its own, and no daemon ports: the
 * delegate drives the whole lifecycle.
 */
export interface DelegatedChannel extends LiveChannel {
  delegate: (options: { version?: string }) => CommandSpec & { pull?: string }
  install?: undefined
  uninstall?: undefined
  daemon?: undefined
  port?: undefined
  opencodePort?: undefined
  expect?: undefined
  provesOwnRuntime?: undefined
  // Only the installed-channel flow reads these; a delegate drives its own run.
  moderated?: undefined
  submission?: undefined
  requiresReleaseAsset?: undefined
}

/** A channel this driver installs, probes and removes itself. */
export interface InstalledChannel extends LiveChannel {
  delegate?: undefined
  daemon?: boolean
  /** Its own daemon port, so two channels on one runner cannot collide. */
  port: number
  opencodePort: number
  install: (options: { version?: string, pin?: boolean }) => CommandSpec
  uninstall: (options: { version?: string }) => CommandSpec
  expect: ChannelExpectation
  /** True when the channel ships its own runtime rather than depending on one. */
  provesOwnRuntime?: boolean
}

export type ChannelRecipe = StubChannel | DelegatedChannel | InstalledChannel

/**
 * Throws unless `value` is a plain release version.
 *
 * Versions reach argv and, for the two documented installer pipelines, a fixed
 * shell program — so this is the boundary that keeps shell syntax out of both.
 */
export function validatePublishedVersion(value: unknown): string

export const CHANNELS: Record<string, ChannelRecipe>

/** The version in a `choco search --limit-output` listing, or null for none. */
export function chocolateySearchVersion(output: string): string | null

/** What Chocolatey's moderation queue says, read from one feed entity. */
export function chocolateySubmission(payload: string): ChannelSubmission

/** What became of a WinGet submission, read from upstream's pull requests. */
export function wingetSubmission(pulls: unknown): ChannelSubmission

/**
 * Why a moderated channel's leg is not being run, or null when it must run.
 *
 * Only a queued submission whose wait is known and short excuses a feed that is
 * not serving the version: a skip claims the queue explains the absence, and a
 * rejection, a missing submission or an unreadable age cannot support it.
 */
export function moderationSkipReason(
  moderated: ModeratedChannel,
  facts: {
    version: string
    ageHours: number | null
    serves: string | null
    /**
     * `unknown` is the caller's, not a probe's: it means the queue could not be
     * asked, which is treated as a wait because it is evidence of nothing.
     */
    state?: ChannelSubmission['state'] | 'unknown'
  },
): string | null

/** Where `--binary` puts the standalone executable. */
export function binaryPrefix(): string

/** Resolves the installed launcher from PATH, optionally with a prepended directory. */
export function whichLooptroop(pathHint?: string): string | null

export function planMatrix(options?: {
  tier?: string
  only?: string[]
  skip?: string[]
}): MatrixLeg[]
