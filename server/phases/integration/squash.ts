import { ensureNoTrackedWorktreeChanges, ensureNoUntrackedPathsClobberedBy, ensureNoUntrackedPathsOverwrittenBy } from '../../git/github'
import { literalPathspec, REPO_SCOPE_PATHSPECS } from '../../git/pathspecs'
import { resolveBaseBranchRef } from '../../git/repository'
import { readWorktreeGitHookPolicy, shouldBypassGitHooks } from '../../git/hookPolicy'
import { uniqueRepoScopedPaths } from '../../git/repoScopedPath'
import { parseGitPathListZ } from '../../git/statusPorcelain'
import { runGit, runGitMutationOrThrow } from '../../git/runCommand'
import { getErrorMessage } from '@shared/typeGuards'
import { hasPendingOpencodeStepsRestore, isRootOpencodeConfigPath } from '../execution/opencodeStepsConfig'
import { join } from 'node:path'

/**
 * The one runner for this file.
 *
 * There used to be three private copies, none of which set `maxBuffer`, so a
 * diff large enough to succeed in the execution phase truncated here.
 */
const GIT_MUTATION_COMMANDS = new Set(['add', 'checkout', 'commit', 'merge', 'reset', 'rm'])

async function runSquashGit(worktreePath: string, args: string[]): Promise<string> {
  if (args.some((arg) => GIT_MUTATION_COMMANDS.has(arg))) {
    return runGitMutationOrThrow(worktreePath, args, args.includes('-z') ? { trimOutput: false } : undefined)
  }
  const result = await runGit(worktreePath, args, args.includes('-z') ? { trimOutput: false } : undefined)
  if (!result.ok) throw new Error(result.errorDetail)
  return result.stdout
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

function uniqueCandidatePaths(worktreePath: string, files: readonly string[]): string[] {
  // Explicit candidate paths are later handed to `git add`/`checkout -f`; do
  // not let a symlinked ancestor redirect one outside this worktree.
  return uniqueRepoScopedPaths(files, worktreePath)
}

function parsePathList(output: string): string[] {
  return parseGitPathListZ(output)
}

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
  const fields = parseGitPathListZ(output)
  const entries: Array<{ status: string; path: string }> = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index] ?? ''
    const path = fields[index + 1] ?? ''
    if (status && path) entries.push({ status, path })
  }
  return entries
}

function excludePendingOpencodeConfig(worktreePath: string, files: readonly string[]): string[] {
  const ticketDir = join(worktreePath, '.ticket')
  if (!hasPendingOpencodeStepsRestore(ticketDir, worktreePath)) return [...files]
  return files.filter((file) => !isRootOpencodeConfigPath(file, worktreePath))
}

export async function prepareSquashCandidate(
  worktreePath: string,
  baseBranch: string,
  ticketTitle: string,
  ticketId: string,
  extraFilesToStage: string[] = [],
): Promise<SquashResult> {
  let preSquashHead: string | undefined
  let resetForSquash = false
  const runGit = (args: string[]) => runSquashGit(worktreePath, args)

  try {
    const baseBranchRef = resolveBaseBranchRef(worktreePath, baseBranch)
    preSquashHead = await runGit(['rev-parse', 'HEAD'])
    const mergeBase = await runGit(['merge-base', 'HEAD', baseBranchRef])
    const commitCount = Number(await runGit(['rev-list', '--count', `${mergeBase}..HEAD`]))
    const committedCandidateFiles = uniqueCandidatePaths(worktreePath, parsePathList(await runGit([
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      `${mergeBase}..${preSquashHead}`,
      '--',
      ...REPO_SCOPE_PATHSPECS,
    ])))
    const explicitFiles = uniqueCandidatePaths(worktreePath, extraFilesToStage)
    const candidateFiles = excludePendingOpencodeConfig(worktreePath, uniqueCandidatePaths(worktreePath, [
      ...committedCandidateFiles,
      ...explicitFiles,
    ]))

    if (candidateFiles.length === 0) {
      return {
        success: false,
        message: 'No candidate changes were available to squash',
        mergeBase,
        preSquashHead,
        commitCount,
      }
    }

    await runGit(['reset', '--mixed', mergeBase])
    resetForSquash = true

    for (let index = 0; index < candidateFiles.length; index += GIT_ADD_BATCH_SIZE) {
      const batch = candidateFiles.slice(index, index + GIT_ADD_BATCH_SIZE)
      // Candidate paths are explicit, validated delivery decisions. `-f`
      // lets an explicitly declared permanent artifact override a repository
      // ignore rule without sweeping any other ignored/local files.
      await runGit(['add', '-v', '-f', '-A', '--', ...batch.map(literalPathspec)])
    }

    const stagedChanges = parsePathList(await runGit(['diff', '--cached', '--name-only', '-z', '--', ...REPO_SCOPE_PATHSPECS]))
    if (stagedChanges.length === 0) {
      await runGit(['reset', '--mixed', preSquashHead])
      return {
        success: false,
        message: 'No candidate changes were available to squash',
        mergeBase,
        preSquashHead,
        commitCount,
      }
    }

    await runGit([
      '-c',
      'user.name=LoopTroop',
      '-c',
      'user.email=looptroop@local',
      'commit',
      ...(shouldBypassGitHooks(readWorktreeGitHookPolicy(worktreePath)) ? ['--no-verify'] : []),
      '-m',
      `${ticketId}: ${ticketTitle}`,
    ])
    const commitHash = await runGit(['rev-parse', 'HEAD'])
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
        await runGit(['reset', '--mixed', preSquashHead])
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

export async function rewriteCandidateCommitWithFiles(
  worktreePath: string,
  mergeBase: string,
  candidateCommitSha: string,
  ticketTitle: string,
  ticketId: string,
  includedFiles: string[],
): Promise<SquashResult> {
  let preRewriteHead: string | undefined
  let resetForRewrite = false
  const runGit = (args: string[]) => runSquashGit(worktreePath, args)

  try {
    preRewriteHead = await runGit(['rev-parse', 'HEAD'])
    const candidateFiles = excludePendingOpencodeConfig(worktreePath, uniqueCandidatePaths(worktreePath, includedFiles))

    if (candidateFiles.length === 0) {
      return {
        success: false,
        message: 'Candidate file audit did not leave any files to include',
        mergeBase,
        preSquashHead: preRewriteHead,
      }
    }

    const changedFiles = new Set(parsePathList(await runGit([
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
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

    const nameStatus = parseNameStatus(await runGit([
      'diff',
      '--name-status',
      '--no-renames',
      '-z',
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

    await runGit(['reset', '--hard', mergeBase])
    resetForRewrite = true

    for (let index = 0; index < presentFiles.length; index += GIT_ADD_BATCH_SIZE) {
      const batch = presentFiles.slice(index, index + GIT_ADD_BATCH_SIZE)
      await runGit(['checkout', candidateCommitSha, '--', ...batch.map(literalPathspec)])
    }
    for (let index = 0; index < deletedFiles.length; index += GIT_ADD_BATCH_SIZE) {
      const batch = deletedFiles.slice(index, index + GIT_ADD_BATCH_SIZE)
      await runGit(['rm', '-f', '--ignore-unmatch', '--', ...batch.map(literalPathspec)])
    }

    const stagedChanges = parsePathList(await runGit(['diff', '--cached', '--name-only', '-z', '--', ...REPO_SCOPE_PATHSPECS]))
    if (stagedChanges.length === 0) {
      await runGit(['reset', '--hard', preRewriteHead])
      return {
        success: false,
        message: 'No candidate changes were available after file audit filtering',
        mergeBase,
        preSquashHead: preRewriteHead,
      }
    }

    await runGit([
      '-c',
      'user.name=LoopTroop',
      '-c',
      'user.email=looptroop@local',
      'commit',
      ...(shouldBypassGitHooks(readWorktreeGitHookPolicy(worktreePath)) ? ['--no-verify'] : []),
      '-m',
      `${ticketId}: ${ticketTitle}`,
    ])
    const commitHash = await runGit(['rev-parse', 'HEAD'])
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
        await runGit(['reset', '--hard', preRewriteHead])
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
