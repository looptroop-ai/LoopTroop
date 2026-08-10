// Git operations for bead execution

import { spawnSync } from 'node:child_process'
import { getCurrentBranch } from '../../git/repository'
import { pushBranchRef } from '../../git/push'
import { readWorktreeGitHookPolicy, shouldBypassGitHooks } from '../../git/hookPolicy'
import {
  buildGeneratedNoiseWarning,
  classifyWorktreePath,
  getExecutionSetupCommitExcludedRoots,
  summarizeWorktreeChanges,
} from '../../git/worktreeChanges'

import * as commandLogger from '../../log/commandLogger'

// Tolerates partial vi.mock() factories that omit logCommand.
function logCmd(
  bin: string,
  args: string[],
  result:
    | { ok: true; stdin?: string; stdout?: string; stderr?: string }
    | { ok: false; error: string; stdin?: string; stdout?: string; stderr?: string },
) {
  commandLogger.logCommand?.(bin, args, result)
}

const GIT_OP_MAX_BUFFER_BYTES = 16 * 1024 * 1024

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
  const fullArgs = ['-C', worktreePath, ...args]
  const result = spawnSync('git', fullArgs, {
    encoding: 'utf8',
    maxBuffer: GIT_OP_MAX_BUFFER_BYTES,
  })
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  if (result.status !== 0 || result.error) {
    const detail = result.error?.message ?? ([stdout, stderr].filter(Boolean).join(' | ') || `exit code ${result.status ?? '?'}`)
    logCmd('git', fullArgs, {
      ok: false,
      error: result.error?.message ?? `exit code ${result.status ?? '?'}`,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    })
    throw new Error(detail)
  }
  logCmd('git', fullArgs, { ok: true, stdout: stdout || undefined, stderr: stderr || undefined })
  return stdout
}

function runGitOpSafe(worktreePath: string, args: string[]): { ok: boolean; stdout: string; error?: string } {
  try {
    const stdout = runGitOp(worktreePath, args)
    return { ok: true, stdout }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error'
    return { ok: false, stdout: '', error }
  }
}

function probeStagedChanges(worktreePath: string, paths?: string[]): { hasStagedChanges: boolean; error?: string } {
  const fullArgs = ['-C', worktreePath, 'diff', '--cached', '--quiet']
  if (paths?.length) {
    fullArgs.push('--', ...paths)
  }
  const result = spawnSync('git', fullArgs, {
    encoding: 'utf8',
    maxBuffer: GIT_OP_MAX_BUFFER_BYTES,
  })
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()

  if (result.error) {
    const detail = result.error.message
      ?? ([stdout, stderr].filter(Boolean).join(' | ') || `exit code ${result.status ?? '?'}`)
    logCmd('git', fullArgs, {
      ok: false,
      error: result.error.message,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    })
    return { hasStagedChanges: false, error: detail }
  }

  if (result.status === 0) {
    logCmd('git', fullArgs, { ok: true, stdout: stdout || undefined, stderr: stderr || undefined })
    return { hasStagedChanges: false }
  }

  if (result.status === 1) {
    // For `git diff --cached --quiet`, exit code 1 is a normal probe result:
    // staged changes are present and the commit flow should continue.
    logCmd('git', fullArgs, { ok: false, error: 'exit code 1' })
    return { hasStagedChanges: true }
  }

  const detail = [stdout, stderr].filter(Boolean).join(' | ') || `exit code ${result.status ?? '?'}`
  logCmd('git', fullArgs, {
    ok: false,
    error: `exit code ${result.status ?? '?'}`,
    stdout: stdout || undefined,
    stderr: stderr || undefined,
  })
  return { hasStagedChanges: false, error: detail }
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
 */
export function commitBeadChanges(
  worktreePath: string,
  beadId: string,
  beadTitle: string,
): {
  committed: boolean
  pushed: boolean
  error?: string
  committableFiles?: string[]
  skippedFiles?: string[]
  generatedNoiseWarning?: string
} {
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

  const committableFiles = summary.committable.map(entry => entry.path)
  const skippedFiles = [
    ...summary.looptroopExcluded,
    ...summary.setupExcluded,
    ...summary.generatedNoise,
  ].map(entry => entry.path)
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

  const addResult = runGitOpSafe(worktreePath, ['add', '-v', '--', ...committableFiles])
  if (!addResult.ok) {
    return { committed: false, pushed: false, error: `git add failed: ${addResult.error}` }
  }

  // Check whether the committable paths have staged changes. The index may
  // already contain unrelated files, but workflow commits must stay scoped.
  const stagedProbe = probeStagedChanges(worktreePath, committableFiles)
  if (stagedProbe.error) {
    return { committed: false, pushed: false, error: `git diff --cached --quiet failed: ${stagedProbe.error}` }
  }
  if (!stagedProbe.hasStagedChanges) {
    return {
      committed: false,
      pushed: false,
      committableFiles,
      ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
      ...(generatedNoiseWarning ? { generatedNoiseWarning } : {}),
    }
  }

  const commitMsg = `bead(${beadId}): ${beadTitle}`
  const bypassHooks = shouldBypassGitHooks(readWorktreeGitHookPolicy(worktreePath))
  const commitResult = runGitOpSafe(worktreePath, [
    'commit',
    ...(bypassHooks ? ['--no-verify'] : []),
    '-m',
    commitMsg,
    '--',
    ...committableFiles,
  ])
  if (!commitResult.ok) {
    return { committed: false, pushed: false, error: `git commit failed: ${commitResult.error}` }
  }

  const currentBranch = getCurrentBranch(worktreePath)
  if (!currentBranch) {
    return { committed: true, pushed: false, error: 'git push failed: could not determine current branch' }
  }

  const pushResult = pushBranchRef({
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
 * Excludes .ticket/** to avoid noise from metadata changes.
 * Returns the diff string (empty string if no code changes).
 */
export function captureBeadDiff(worktreePath: string, beadStartCommit: string): string {
  const result = runGitOpSafe(worktreePath, [
    'diff', beadStartCommit, 'HEAD', '--', '.', ':!.ticket',
  ])
  return result.ok ? result.stdout : ''
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
