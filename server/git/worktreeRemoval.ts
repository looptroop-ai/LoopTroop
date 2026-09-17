import { lstatSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { GIT_MUTATION_TIMEOUT_MS, runGitMutationOrThrow } from './runCommand'
import { dirname, resolve } from 'node:path'
import { makeOwnerWritableRecursive } from '../io/removal'
import { ContainedPathError, resolveContainedPath } from '../lib/containedPath'

type DirectoryIdentity = { dev: number; ino: number }

function readDirectoryIdentity(path: string): DirectoryIdentity {
  const stats = lstatSync(path)
  if (!stats.isDirectory()) throw new ContainedPathError(`Managed worktrees root is not a directory: ${path}`)
  return { dev: Number(stats.dev), ino: Number(stats.ino) }
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

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

type GitCommandRunner = (args: string[]) => Promise<void>

export interface RemoveWorktreeOptions {
  projectRoot: string
  worktreesRoot: string
  worktreePath: string
  runGit?: GitCommandRunner
}

async function runGitCommand(projectRoot: string, args: string[]): Promise<void> {
  await runGitMutationOrThrow(projectRoot, args, { timeoutMs: GIT_MUTATION_TIMEOUT_MS })
}

/**
 * Removes a LoopTroop-managed Git worktree even when project tooling created
 * read-only files or directories inside it. Symlinks are never followed.
 */
export async function removeWorktree({
  projectRoot,
  worktreesRoot,
  worktreePath,
  runGit = (args) => runGitCommand(projectRoot, args),
}: RemoveWorktreeOptions): Promise<void> {
  const resolvedWorktreesRoot = resolve(worktreesRoot)
  const resolvedWorktreePath = resolve(worktreePath)
  if (dirname(resolvedWorktreePath) !== resolvedWorktreesRoot) {
    throw new Error(`Refusing to remove path outside the managed worktrees root: ${resolvedWorktreePath}`)
  }

  if (!assertManagedWorktreesRoot(projectRoot, worktreesRoot)) return
  const managedRootIdentity = readDirectoryIdentity(worktreesRoot)
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
    await runGit(['worktree', 'remove', '--force', worktreePath])
  } catch {
    gitRemovalFailed = true
  }

  // Git is awaited above and may have allowed another cleanup process to
  // replace the parent. Revalidate both containment and directory identity
  // before the fallback can recursively remove anything through that path.
  if (!assertManagedWorktreesRoot(projectRoot, worktreesRoot)) return
  if (!sameDirectoryIdentity(managedRootIdentity, readDirectoryIdentity(worktreesRoot))) {
    throw new ContainedPathError('Managed worktrees root changed during removal')
  }

  try {
    const currentStats = lstatSync(worktreePath)
    if (currentStats.isSymbolicLink()) unlinkSync(worktreePath)
    else rmSync(worktreePath, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  if (gitRemovalFailed) {
    try {
      await runGit(['worktree', 'prune'])
    } catch {
      // The filesystem target is already removed; stale Git metadata can be
      // pruned by a later cleanup operation.
    }
  }
}
