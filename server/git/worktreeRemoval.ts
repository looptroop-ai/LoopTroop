import { existsSync, lstatSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { runGitSyncOrThrow } from './runCommand'
import { dirname, resolve } from 'node:path'
import { makeOwnerWritableRecursive } from '../io/removal'
import { ContainedPathError, resolveContainedPath } from '../lib/containedPath'

/** Cleanup must not enumerate an alias for either managed directory. */
export function assertManagedWorktreesRoot(projectRoot: string, worktreesRoot: string): string | undefined {
  let canonicalProject: string
  try {
    canonicalProject = realpathSync.native(projectRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const expected = resolve(canonicalProject, '.looptroop', 'worktrees')
  const actual = resolveContainedPath(projectRoot, worktreesRoot, { allowMissingParents: true })
  if (actual !== expected) throw new ContainedPathError('Managed worktrees root must not be a symbolic link')
  return actual
}

type GitCommandRunner = (args: string[]) => void

export interface RemoveWorktreeOptions {
  projectRoot: string
  worktreesRoot: string
  worktreePath: string
  runGit?: GitCommandRunner
}

function runGitCommand(projectRoot: string, args: string[]): void {
  runGitSyncOrThrow(projectRoot, args)
}

/**
 * Removes a LoopTroop-managed Git worktree even when project tooling created
 * read-only files or directories inside it. Symlinks are never followed.
 */
export function removeWorktree({
  projectRoot,
  worktreesRoot,
  worktreePath,
  runGit = (args) => runGitCommand(projectRoot, args),
}: RemoveWorktreeOptions): void {
  const resolvedWorktreesRoot = resolve(worktreesRoot)
  const resolvedWorktreePath = resolve(worktreePath)
  if (dirname(resolvedWorktreePath) !== resolvedWorktreesRoot) {
    throw new Error(`Refusing to remove path outside the managed worktrees root: ${resolvedWorktreePath}`)
  }

  if (!assertManagedWorktreesRoot(projectRoot, worktreesRoot)) return
  let stats
  try {
    stats = lstatSync(worktreePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  // Git resolves aliases to registered worktrees before removing them. Never
  // hand it a link: removing this entry must preserve the destination.
  if (stats.isSymbolicLink()) {
    unlinkSync(worktreePath)
    return
  }
  resolveContainedPath(projectRoot, worktreePath)

  makeOwnerWritableRecursive(worktreePath)

  let gitRemovalFailed = false
  try {
    runGit(['worktree', 'remove', '--force', worktreePath])
  } catch {
    gitRemovalFailed = true
  }

  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true })
  }

  if (gitRemovalFailed) {
    try {
      runGit(['worktree', 'prune'])
    } catch {
      // The filesystem target is already removed; stale Git metadata can be
      // pruned by a later cleanup operation.
    }
  }
}
