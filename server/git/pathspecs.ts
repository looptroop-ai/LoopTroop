/**
 * The pathspecs that keep LoopTroop's own control data out of a diff.
 *
 * `.ticket` and `.looptroop` hold the orchestrator's state, not the project's
 * work, so every diff, audit and delivery command has to exclude them. The
 * exclusions were written out by hand at nine call sites and had already
 * drifted: one of them excluded `.ticket` only, and with the unanchored `:!`
 * form, so a bead diff captured LoopTroop's own files and a nested directory
 * called `.ticket` anywhere in the tree was skipped by mistake.
 *
 * `:(top,...)` anchors the pattern at the repository root, which is what makes
 * the exclusion mean "the control directory" rather than "any path with that
 * name".
 */

/** Excludes both control directories, anchored at the repository root. */
export const LOOPTROOP_EXCLUDE_PATHSPECS = [
  ':(top,exclude).ticket',
  ':(top,exclude).looptroop',
] as const

/**
 * `.` plus both exclusions — the pathspec list that follows `--` in a command
 * meant to see the whole project and nothing of LoopTroop's.
 */
export const REPO_SCOPE_PATHSPECS = ['.', ...LOOPTROOP_EXCLUDE_PATHSPECS] as const
