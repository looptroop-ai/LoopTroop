import { ensureNoTrackedWorktreeChanges, ensureNoUntrackedPathsClobberedBy, ensureNoUntrackedPathsOverwrittenBy } from '../../git/github'
import { literalPathspec, REPO_SCOPE_PATHSPECS } from '../../git/pathspecs'
import { resolveBaseBranchRef } from '../../git/repository'
import { readWorktreeGitHookPolicy, shouldBypassGitHooks } from '../../git/hookPolicy'
import { uniqueRepoScopedPaths } from '../../git/repoScopedPath'
import { GIT_PUSH_MAX_RETRIES, GIT_PUSH_TIMEOUT_MS, gitPushEnv } from '../../git/push'
import { runCommand, runGitSyncOrThrow } from '../../git/runCommand'
import { getErrorMessage } from '@shared/typeGuards'

/**
 * The one runner for this file.
 *
 * There used to be three private copies, none of which set `maxBuffer`, so a
 * diff large enough to succeed in the execution phase truncated here.
 */
function runSquashGit(worktreePath: string, args: string[]): string {
  return runGitSyncOrThrow(worktreePath, args)
}

export interface SquashResult {
  success: boolean
  message: string
  commitHash?: string
  mergeBase?: string
  preSquashHead?: string
  commitCount?: number
}

const GIT_ADD_BATCH_SIZE = 100

const uniqueCandidatePaths = uniqueRepoScopedPaths

function parsePathList(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\t+/).map((part) => part.trim()).filter(Boolean)
      return {
        status: parts[0] ?? '',
        path: parts.at(-1) ?? '',
      }
    })
    .filter((entry) => entry.status && entry.path)
}

export function prepareSquashCandidate(
  worktreePath: string,
  baseBranch: string,
  ticketTitle: string,
  ticketId: string,
  extraFilesToStage: string[] = [],
): SquashResult {
  let preSquashHead: string | undefined
  let resetForSquash = false
  const runGit = (args: string[]) => runSquashGit(worktreePath, args)

  try {
    const baseBranchRef = resolveBaseBranchRef(worktreePath, baseBranch)
    preSquashHead = runGit(['rev-parse', 'HEAD'])
    const mergeBase = runGit(['merge-base', 'HEAD', baseBranchRef])
    const commitCount = Number(runGit(['rev-list', '--count', `${mergeBase}..HEAD`]))
    const committedCandidateFiles = uniqueCandidatePaths(parsePathList(runGit([
      'diff',
      '--name-only',
      '--no-renames',
      `${mergeBase}..${preSquashHead}`,
      '--',
      ...REPO_SCOPE_PATHSPECS,
    ])))
    const explicitFiles = uniqueCandidatePaths(extraFilesToStage)
    const candidateFiles = uniqueCandidatePaths([
      ...committedCandidateFiles,
      ...explicitFiles,
    ])

    if (candidateFiles.length === 0) {
      return {
        success: false,
        message: 'No candidate changes were available to squash',
        mergeBase,
        preSquashHead,
        commitCount,
      }
    }

    runGit(['reset', '--mixed', mergeBase])
    resetForSquash = true

    for (let index = 0; index < candidateFiles.length; index += GIT_ADD_BATCH_SIZE) {
      const batch = candidateFiles.slice(index, index + GIT_ADD_BATCH_SIZE)
      // Candidate paths are explicit, validated delivery decisions. `-f`
      // lets an explicitly declared permanent artifact override a repository
      // ignore rule without sweeping any other ignored/local files.
      runGit(['add', '-v', '-f', '-A', '--', ...batch.map(literalPathspec)])
    }

    const stagedChanges = runGit(['diff', '--cached', '--name-only', '--', ...REPO_SCOPE_PATHSPECS])
    if (!stagedChanges) {
      runGit(['reset', '--mixed', preSquashHead])
      return {
        success: false,
        message: 'No candidate changes were available to squash',
        mergeBase,
        preSquashHead,
        commitCount,
      }
    }

    runGit([
      '-c',
      'user.name=LoopTroop',
      '-c',
      'user.email=looptroop@local',
      'commit',
      ...(shouldBypassGitHooks(readWorktreeGitHookPolicy(worktreePath)) ? ['--no-verify'] : []),
      '-m',
      `${ticketId}: ${ticketTitle}`,
    ])
    const commitHash = runGit(['rev-parse', 'HEAD'])
    resetForSquash = false
    return {
      success: true,
      message: `Prepared candidate commit ${commitHash} from ${commitCount} commit(s) on ${ticketId}`,
      commitHash,
      mergeBase,
      preSquashHead,
      commitCount,
    }
  } catch (error) {
    if (resetForSquash && preSquashHead) {
      try {
        runGit(['reset', '--mixed', preSquashHead])
      } catch {
        // Preserve the original error; caller-level recovery records the failure context.
      }
    }
    return {
      success: false,
      message: getErrorMessage(error),
    }
  }
}

export function rewriteCandidateCommitWithFiles(
  worktreePath: string,
  mergeBase: string,
  candidateCommitSha: string,
  ticketTitle: string,
  ticketId: string,
  includedFiles: string[],
): SquashResult {
  let preRewriteHead: string | undefined
  let resetForRewrite = false
  const runGit = (args: string[]) => runSquashGit(worktreePath, args)

  try {
    preRewriteHead = runGit(['rev-parse', 'HEAD'])
    const candidateFiles = uniqueCandidatePaths(includedFiles)

    if (candidateFiles.length === 0) {
      return {
        success: false,
        message: 'Candidate file audit did not leave any files to include',
        mergeBase,
        preSquashHead: preRewriteHead,
      }
    }

    const changedFiles = new Set(parsePathList(runGit([
      'diff',
      '--name-only',
      '--no-renames',
      `${mergeBase}..${candidateCommitSha}`,
      '--',
      ...REPO_SCOPE_PATHSPECS,
    ])))
    const includedChangedFiles = candidateFiles.filter((file) => changedFiles.has(file))

    if (includedChangedFiles.length === 0) {
      return {
        success: false,
        message: 'Candidate file audit did not include any changed files',
        mergeBase,
        preSquashHead: preRewriteHead,
      }
    }

    const nameStatus = parseNameStatus(runGit([
      'diff',
      '--name-status',
      '--no-renames',
      `${mergeBase}..${candidateCommitSha}`,
      '--',
      ...includedChangedFiles.map(literalPathspec),
    ]))
    const deletedFiles = nameStatus
      .filter((entry) => entry.status.startsWith('D'))
      .map((entry) => entry.path)
    const presentFiles = includedChangedFiles.filter((file) => !deletedFiles.includes(file))

    // The rewrite starts by discarding everything back to the merge base, so
    // tracked uncommitted work is about to be destroyed. Failing first sends
    // the caller down its git-recovery receipt path, which records what was in
    // the way.
    //
    // Tracked changes only: `reset --hard` does not remove untracked files, and
    // the earlier phases deliberately leave untracked local-only output on
    // disk. Refusing on that would block delivery over files this step cannot
    // harm.
    ensureNoTrackedWorktreeChanges(worktreePath, 'the candidate rewrite')
    // The exception, and the reason the relaxation above is not the whole
    // check: where the merge base tracks a path, the reset writes its content
    // over whatever untracked file is sitting there.
    ensureNoUntrackedPathsClobberedBy(worktreePath, mergeBase, 'the candidate rewrite')
    // The reset is only half of what this writes: the checkouts below restore
    // every file the candidate *adds*, and `git checkout <sha> -- <path>`
    // replaces an untracked file just as silently. Asked here, before the reset
    // moves HEAD, because "does HEAD track this?" is what separates a file the
    // rewrite is meant to write from local-only output standing in its way.
    ensureNoUntrackedPathsOverwrittenBy(worktreePath, presentFiles, 'the candidate rewrite')

    runGit(['reset', '--hard', mergeBase])
    resetForRewrite = true

    for (let index = 0; index < presentFiles.length; index += GIT_ADD_BATCH_SIZE) {
      const batch = presentFiles.slice(index, index + GIT_ADD_BATCH_SIZE)
      runGit(['checkout', candidateCommitSha, '--', ...batch.map(literalPathspec)])
    }
    for (let index = 0; index < deletedFiles.length; index += GIT_ADD_BATCH_SIZE) {
      const batch = deletedFiles.slice(index, index + GIT_ADD_BATCH_SIZE)
      runGit(['rm', '-f', '--ignore-unmatch', '--', ...batch.map(literalPathspec)])
    }

    const stagedChanges = runGit(['diff', '--cached', '--name-only', '--', ...REPO_SCOPE_PATHSPECS])
    if (!stagedChanges) {
      runGit(['reset', '--hard', preRewriteHead])
      return {
        success: false,
        message: 'No candidate changes were available after file audit filtering',
        mergeBase,
        preSquashHead: preRewriteHead,
      }
    }

    runGit([
      '-c',
      'user.name=LoopTroop',
      '-c',
      'user.email=looptroop@local',
      'commit',
      ...(shouldBypassGitHooks(readWorktreeGitHookPolicy(worktreePath)) ? ['--no-verify'] : []),
      '-m',
      `${ticketId}: ${ticketTitle}`,
    ])
    const commitHash = runGit(['rev-parse', 'HEAD'])
    resetForRewrite = false
    return {
      success: true,
      message: `Prepared filtered candidate commit ${commitHash} from ${candidateCommitSha}`,
      commitHash,
      mergeBase,
      preSquashHead: preRewriteHead,
      commitCount: 1,
    }
  } catch (error) {
    if (resetForRewrite && preRewriteHead) {
      try {
        runGit(['reset', '--hard', preRewriteHead])
      } catch {
        // Preserve the original error; caller-level recovery records the failure context.
      }
    }
    return {
      success: false,
      message: getErrorMessage(error),
      mergeBase,
      preSquashHead: preRewriteHead,
    }
  }
}

export interface PushResult {
  pushed: boolean
  error?: string
}

/** Asynchronous: it reaches the remote, and the remote is what stalls. */
export async function pushSquashedCandidate(worktreePath: string): Promise<PushResult> {
  const bypassHooks = shouldBypassGitHooks(readWorktreeGitHookPolicy(worktreePath))
  for (let attempt = 1; attempt <= GIT_PUSH_MAX_RETRIES; attempt++) {
    const result = await runCommand('git', [
      '-C', worktreePath, 'push', ...(bypassHooks ? ['--no-verify'] : []),
    ], { timeoutMs: GIT_PUSH_TIMEOUT_MS, env: gitPushEnv() })
    if (result.ok) return { pushed: true }
    if (attempt === GIT_PUSH_MAX_RETRIES) {
      return { pushed: false, error: `git push failed after ${GIT_PUSH_MAX_RETRIES} attempts: ${result.errorDetail}` }
    }
  }
  return { pushed: false, error: 'push failed' }
}
