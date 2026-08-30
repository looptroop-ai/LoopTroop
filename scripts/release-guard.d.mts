/**
 * Types for `release-guard.mjs`. It is plain ESM because the release workflow
 * runs it with bare Node before any install step has happened.
 */

/** The workflow inputs the guard decides from. All arrive as strings. */
export interface GuardInputs {
  event: string
  ref: string
  /** `dry_run` as dispatched: the string `'false'` is a request to publish. */
  requested: string
  /** `skip_binaries` as dispatched, again as a string. */
  skipBinaries: string
}

/** What the workflow is allowed to do, and why. */
export interface Guard {
  dryRun: boolean
  skipBinaries: boolean
  /** Emitted as `::warning::` lines, so a forced dry run says so out loud. */
  notes: string[]
}

export function resolveGuard(inputs: GuardInputs): Guard
