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

/** Excludes the orchestrator's own state directory. */
export const EXCLUDE_LOOPTROOP_DIR = ':(top,exclude).looptroop'

/** Excludes the ticket's own artifact directory. */
export const EXCLUDE_TICKET_DIR = ':(top,exclude).ticket'

/** Excludes both control directories, anchored at the repository root. */
export const LOOPTROOP_EXCLUDE_PATHSPECS = [
  EXCLUDE_TICKET_DIR,
  EXCLUDE_LOOPTROOP_DIR,
] as const

/**
 * `.` plus both exclusions — the pathspec list that follows `--` in a command
 * meant to see the whole project and nothing of LoopTroop's.
 */
export const REPO_SCOPE_PATHSPECS = ['.', ...LOOPTROOP_EXCLUDE_PATHSPECS] as const

/**
 * Names one exact file, with no globbing.
 *
 * A path is not a pathspec. Everything after `--` is matched as a *pattern*, so
 * `src/[id].tsx` — an ordinary dynamic-route filename — is read as a character
 * class and matches `src/i.tsx` instead. Verified against git: with the named
 * file absent from both the index and the worktree, `git add -- 'src/[id].tsx'`
 * exits zero having staged a sibling it was never asked to touch, which is the
 * worst shape a bug can take here: silent, and in the commit.
 *
 * `:(literal)` turns the pattern back into a name. Use this for every concrete
 * path handed to git; the exclusions above are the only patterns we mean as
 * patterns.
 *
 * This rule had been written out by hand in four files and applied at nine call
 * sites out of eighteen — the same drift `LOOPTROOP_EXCLUDE_PATHSPECS` was
 * hoisted here to stop.
 */
export function literalPathspec(filePath: string): string {
  return `:(literal)${filePath}`
}
