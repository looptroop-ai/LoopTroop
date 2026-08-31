import { spawnSync } from 'node:child_process'

const GIT_TIMEOUT_MS = 30_000
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
  const mergeBaseResult = spawnSync('git', ['-C', worktreePath, 'merge-base', 'HEAD', baseBranch], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
  })
  const mergeBase = mergeBaseResult.status === 0 ? (mergeBaseResult.stdout ?? '').trim() : ''
  if (!mergeBase) return UNAVAILABLE

  const result = spawnSync('git', [
    '-C', worktreePath,
    'diff', '--name-status', '--stat=120,80', `${mergeBase}..HEAD`,
    '--', '.', ':(top,exclude).ticket', ':(top,exclude).looptroop',
  ], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS })
  if (result.status !== 0) return UNAVAILABLE

  return (result.stdout ?? '').trim().slice(0, DIFF_METADATA_LIMIT) || EMPTY
}
