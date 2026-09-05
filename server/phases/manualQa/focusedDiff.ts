import { REPO_SCOPE_PATHSPECS } from '../../git/pathspecs'
import { runGitSync } from '../../git/runCommand'

const DIFF_METADATA_LIMIT = 80_000

const UNAVAILABLE = 'Focused diff metadata unavailable.'
const EMPTY = 'No candidate file metadata was reported.'

/**
 * A name-status and stat summary of the ticket's own changes, for prompting.
 *
 * Both the checklist generator and the fix-bead planner need the same view —
 * everything the worktree changed since it branched, minus LoopTroop's own
 * bookkeeping directories — so they share one implementation rather than two
 * copies that can drift on excludes, timeout or truncation limit.
 */
export function focusedDiffMetadata(worktreePath: string, baseBranch: string): string {
  const mergeBaseResult = runGitSync(worktreePath, ['merge-base', 'HEAD', baseBranch])
  const mergeBase = mergeBaseResult.ok ? mergeBaseResult.stdout : ''
  if (!mergeBase) return UNAVAILABLE

  const result = runGitSync(worktreePath, [
    'diff', '--name-status', '--stat=120,80', `${mergeBase}..HEAD`,
    '--', ...REPO_SCOPE_PATHSPECS,
  ])
  if (!result.ok) return UNAVAILABLE

  return result.stdout.slice(0, DIFF_METADATA_LIMIT) || EMPTY
}
