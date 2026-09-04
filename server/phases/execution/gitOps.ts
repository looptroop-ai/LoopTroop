// Git operations for bead execution

import { getCurrentBranch } from '../../git/repository'
import { pushBranchRef } from '../../git/push'
import { readWorktreeGitHookPolicy, shouldBypassGitHooks } from '../../git/hookPolicy'
import { withGitIndexRollback } from '../../git/indexSnapshot'
import { REPO_SCOPE_PATHSPECS } from '../../git/pathspecs'
import { runGitSync, runGitSyncOrThrow } from '../../git/runCommand'
import {
  buildGeneratedNoiseWarning,
  classifyWorktreePath,
  getExecutionSetupCommitExcludedRoots,
  summarizeWorktreeChanges,
} from '../../git/worktreeChanges'

interface ResetWorktreeOptions {
  preservePaths?: string[]
}

interface FileAllowOptions {
  excludedRoots?: string[]
  untracked?: boolean
}

export const WORKTREE_RESET_PRESERVE_PATHS = [
  '.ticket',
] as const

export { getExecutionSetupCommitExcludedRoots } from '../../git/worktreeChanges'
import { normalizeRepoPath } from '../../git/worktreeChanges'

export function isAllowedFile(path: string, options: FileAllowOptions = {}): boolean {
  return classifyWorktreePath(path, {
    setupExcludedRoots: options.excludedRoots,
    untracked: options.untracked ?? true,
  }).category === 'committable'
}

export function filterAllowedFiles(files: string[], options: FileAllowOptions = {}): string[] {
  return files.filter((file) => isAllowedFile(file, options))
}

function runGitOp(worktreePath: string, args: string[]): string {
  return runGitSyncOrThrow(worktreePath, args)
}

function runGitOpSafe(
  worktreePath: string,
  args: string[],
): { ok: true; stdout: string } | { ok: false; stdout: string; error: string } {
  const result = runGitSync(worktreePath, args)
  return result.ok
    ? { ok: true, stdout: result.stdout }
    : { ok: false, stdout: '', error: result.errorDetail ?? 'Unknown error' }
}

function probeStagedChanges(
  worktreePath: string,
  paths: string[],
): { hasStagedChanges: boolean; error?: string } {
  const args = ['diff', '--cached', '--quiet']
  if (paths.length) args.push('--', ...paths)
  const result = runGitSync(worktreePath, args)

  if (result.ok) return { hasStagedChanges: false }
  // For `git diff --cached --quiet`, exit code 1 is a normal probe result:
  // staged changes are present and the commit flow should continue.
  if (!result.spawnError && result.status === 1) return { hasStagedChanges: true }
  return { hasStagedChanges: false, error: result.errorDetail }
}

export function recordWorktreeStartCommit(worktreePath: string): string {
  return runGitOp(worktreePath, ['rev-parse', 'HEAD'])
}

/**
 * Record the current HEAD commit SHA before bead execution starts.
 * Used as a reset point if the iteration fails and needs a context wipe.
 */
export function recordBeadStartCommit(worktreePath: string): string {
  return recordWorktreeStartCommit(worktreePath)
}

/**
 * Commit and push changes after a successful bead.
 * Commits Git-visible project changes while excluding LoopTroop/setup roots
 * and untracked generated/local noise. Graceful — logs warnings but doesn't block on push failure.
 *
 * `excludePaths` holds repository-relative paths LoopTroop itself is modifying
 * for the duration of the run — today, a project's `opencode.json` while a step
 * cap is applied. Restoring such a file afterwards puts the worktree right but
 * cannot undo a commit, so the exclusion has to happen here. They are reported
 * as skipped, like every other file left out.
 */
export async function commitBeadChanges(
  worktreePath: string,
  beadId: string,
  beadTitle: string,
  options: { excludePaths?: readonly string[] } = {},
): Promise<{
  committed: boolean
  pushed: boolean
  error?: string
  committableFiles?: string[]
  skippedFiles?: string[]
  generatedNoiseWarning?: string
}> {
  let summary: ReturnType<typeof summarizeWorktreeChanges>
  try {
    summary = summarizeWorktreeChanges(worktreePath, {
      setupExcludedRoots: getExecutionSetupCommitExcludedRoots(worktreePath),
    })
  } catch (err) {
    return {
      committed: false,
      pushed: false,
      error: err instanceof Error ? err.message : 'Failed to inspect worktree changes',
    }
  }

  const excluded = new Set((options.excludePaths ?? []).map(normalizeRepoPath))
  const committableEntries = summary.committable.filter(entry => !excluded.has(entry.path))
  const committableFiles = committableEntries.map(entry => entry.path)
  // A path git already records as deleted in the index — the source half of a
  // staged rename, or a `git rm` — exists in neither the worktree nor the
  // index, so `git add` fails on it with "did not match any files". It still
  // belongs in the commit pathspec: that is what carries its deletion into the
  // commit, and without it a renamed file is committed twice, once under each
  // name.
  const filesToStage = committableEntries
    .filter(entry => !(entry.indexStatus === 'D' && entry.worktreeStatus === ' '))
    .map(entry => entry.path)
  const skippedFiles = [
    ...[
      ...summary.looptroopExcluded,
      ...summary.setupExcluded,
      ...summary.generatedNoise,
    ].map(entry => entry.path),
    ...summary.committable.map(entry => entry.path).filter(path => excluded.has(path)),
  ]
  const generatedNoiseWarning = summary.generatedNoise.length > 0
    ? buildGeneratedNoiseWarning(summary.generatedNoise)
    : undefined

  if (committableFiles.length === 0) {
    return {
      committed: false,
      pushed: false,
      ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
      ...(generatedNoiseWarning ? { generatedNoiseWarning } : {}),
    }
  }

  const commitMsg = `bead(${beadId}): ${beadTitle}`
  const bypassHooks = shouldBypassGitHooks(readWorktreeGitHookPolicy(worktreePath))

  // `git add` has to run against the real index — a partial commit can only
  // name a path git already knows, so a new file has to be staged first — and
  // the commit that follows can fail. Snapshotting the index means a failure
  // leaves nothing behind: before this, a failed bead commit left its paths
  // staged and the next bead committed them by accident.
  type StageOutcome = { error: string; hasStagedChanges?: undefined } | { hasStagedChanges: boolean; error?: undefined }
  // A refused snapshot surfaces as this function's ordinary failure shape, not
  // as a throw: every other outcome here is reported, and the caller decides.
  let staged: StageOutcome
  try {
    staged = withGitIndexRollback<StageOutcome>(worktreePath, () => {
      if (filesToStage.length > 0) {
        const addResult = runGitOpSafe(worktreePath, ['add', '-v', '--', ...filesToStage])
        if (!addResult.ok) {
          return { keepIndex: false, value: { error: `git add failed: ${addResult.error}` } }
        }
      }
      // Answers "do these paths differ from HEAD", including files git has only
      // just been told about, which `git diff HEAD` cannot report.
      const probe = probeStagedChanges(worktreePath, committableFiles)
      if (probe.error) {
        return { keepIndex: false, value: { error: `git diff --cached --quiet failed: ${probe.error}` } }
      }
      if (!probe.hasStagedChanges) {
        return { keepIndex: false, value: { hasStagedChanges: false } }
      }

      const commitResult = runGitOpSafe(worktreePath, [
        'commit',
        ...(bypassHooks ? ['--no-verify'] : []),
        '-m',
        commitMsg,
        '--',
        ...committableFiles,
      ])
      return commitResult.ok
        ? { keepIndex: true, value: { hasStagedChanges: true } }
        : { keepIndex: false, value: { error: `git commit failed: ${commitResult.error}` } }
    })
  } catch (err) {
    return { committed: false, pushed: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }

  if (staged.error) {
    return { committed: false, pushed: false, error: staged.error }
  }
  if (!staged.hasStagedChanges) {
    return {
      committed: false,
      pushed: false,
      committableFiles,
      ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
      ...(generatedNoiseWarning ? { generatedNoiseWarning } : {}),
    }
  }

  const currentBranch = getCurrentBranch(worktreePath)
  if (!currentBranch) {
    return { committed: true, pushed: false, error: 'git push failed: could not determine current branch' }
  }

  const pushResult = await pushBranchRef({
    projectPath: worktreePath,
    destinationBranch: currentBranch,
    sourceRef: 'HEAD',
    maxRetries: 3,
    bypassHooks,
  })
  if (!pushResult.pushed) {
    return {
      committed: true,
      pushed: false,
      error: pushResult.error,
      committableFiles,
      ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
      ...(generatedNoiseWarning ? { generatedNoiseWarning } : {}),
    }
  }

  return {
    committed: true,
    pushed: true,
    committableFiles,
    ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
    ...(generatedNoiseWarning ? { generatedNoiseWarning } : {}),
  }
}

/**
 * Capture a code-only diff between beadStartCommit and HEAD.
 *
 * Excludes both of LoopTroop's control directories, so the diff is the
 * project's work and nothing else. A git failure is reported as an error
 * rather than as an empty diff: the two are not the same thing, and returning
 * `''` for a failure made a broken bead read downstream as one that changed
 * nothing.
 */
export function captureBeadDiff(
  worktreePath: string,
  beadStartCommit: string,
): { ok: true; diff: string } | { ok: false; error: string } {
  const result = runGitOpSafe(worktreePath, [
    'diff', beadStartCommit, 'HEAD', '--', ...REPO_SCOPE_PATHSPECS,
  ])
  return result.ok ? { ok: true, diff: result.stdout } : { ok: false, error: result.error }
}

export function resetWorktreeToCommit(worktreePath: string, commit: string, options?: ResetWorktreeOptions): void {
  runGitOp(worktreePath, ['reset', '--hard', commit])
  const cleanArgs = ['clean', '-fd']
  for (const path of options?.preservePaths ?? []) {
    cleanArgs.push('-e', path)
  }
  runGitOp(worktreePath, cleanArgs)
}

/**
 * Reset the worktree to the bead start commit on context wipe / new iteration.
 * This ensures the next retry starts from a clean state.
 */
export function resetToBeadStart(worktreePath: string, beadStartCommit: string, options?: ResetWorktreeOptions): void {
  resetWorktreeToCommit(worktreePath, beadStartCommit, options)
}
