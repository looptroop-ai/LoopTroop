import { lstatSync, realpathSync, readdirSync, rmSync, unlinkSync, type Stats } from 'node:fs'
import { GIT_MUTATION_TIMEOUT_MS, runGitMutationOrThrow, runGitSync } from './runCommand'
import { dirname, join, resolve } from 'node:path'
import { makeOwnerWritableRecursive } from '../io/removal'
import { ContainedPathError, resolveContainedPath } from '../lib/containedPath'
import { classifyWorktreePath, normalizeRepoPath } from './worktreeChanges'

type EntryIdentity = { dev: number; ino: number; birthtimeMs: number }

function entryIdentity(stats: Stats): EntryIdentity {
  return {
    dev: Number(stats.dev),
    ino: Number(stats.ino),
    birthtimeMs: Number(stats.birthtimeMs),
  }
}

function readDirectoryIdentity(path: string): EntryIdentity {
  const stats = lstatSync(path)
  if (!stats.isDirectory()) throw new ContainedPathError(`Managed worktrees root is not a directory: ${path}`)
  return entryIdentity(stats)
}

function sameEntryIdentity(left: EntryIdentity, right: EntryIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
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
  /** Preserve ignored user files; only LoopTroop-owned roots may remain. */
  preserveIgnoredFiles?: boolean
}

/** A pre-start ticket path has no `.git`; only its own `.ticket` skeleton is safe. */
function isOwnGitWorktree(worktreePath: string): boolean {
  let gitEntry: Stats
  try {
    gitEntry = lstatSync(join(worktreePath, '.git'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (gitEntry.isSymbolicLink()) {
    throw new Error(`Refusing to inspect a worktree whose .git entry is a symbolic link: ${worktreePath}`)
  }
  const result = runGitSync(worktreePath, ['rev-parse', '--show-toplevel'], { log: false, trimOutput: false })
  if (!result.ok) throw new Error(`Failed to verify the worktree root: ${result.errorDetail}`)
  let reportedRoot = result.stdout
  if (reportedRoot.endsWith('\n')) reportedRoot = reportedRoot.slice(0, -1)
  if (process.platform === 'win32' && reportedRoot.endsWith('\r')) reportedRoot = reportedRoot.slice(0, -1)
  if (realpathSync.native(reportedRoot) !== realpathSync.native(worktreePath)) {
    throw new Error(`Refusing to inspect a Git repository nested at another path: ${worktreePath}`)
  }
  return true
}

function holdsOnlyTicketSkeleton(worktreePath: string): boolean {
  let entries
  try {
    entries = readdirSync(worktreePath, { withFileTypes: true })
  } catch (error) {
    throw new Error(`Failed to inspect ignored worktree files: ${error instanceof Error ? error.message : String(error)}`)
  }
  return entries.every((entry) => entry.name === '.ticket' && entry.isDirectory() && !entry.isSymbolicLink())
}

function readIgnoredWorktreePaths(worktreePath: string): string[] {
  const result = runGitSync(worktreePath, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '-z',
  ], { trimOutput: false, log: false })
  if (!result.ok) throw new Error(`Failed to inspect ignored worktree files: ${result.errorDetail}`)
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map(normalizeRepoPath)
}

/** Read ignored, untracked entries without losing filenames to line parsing. */
export function getIgnoredWorktreePaths(worktreePath: string): string[] {
  if (!isOwnGitWorktree(worktreePath)) {
    throw new Error(`Refusing to inspect ignored files outside an owned Git worktree: ${worktreePath}`)
  }
  return readIgnoredWorktreePaths(worktreePath)
}

/** Refuse conservative cleanup when ignored user files would otherwise be deleted. */
export function assertNoIgnoredWorktreeFiles(worktreePath: string): void {
  if (!isOwnGitWorktree(worktreePath)) {
    if (holdsOnlyTicketSkeleton(worktreePath)) return
    throw new Error(`Refusing to remove a non-Git worktree containing files outside its .ticket skeleton: ${worktreePath}`)
  }
  const unsafe = readIgnoredWorktreePaths(worktreePath)
    .filter((path) => classifyWorktreePath(path, { untracked: true }).category !== 'looptroopExcluded')
  if (unsafe.length > 0) {
    throw new Error(`Refusing to remove a worktree with ignored files outside LoopTroop roots: ${unsafe.join(', ')}`)
  }
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
  preserveIgnoredFiles = false,
}: RemoveWorktreeOptions): Promise<void> {
  const resolvedWorktreesRoot = resolve(worktreesRoot)
  const resolvedWorktreePath = resolve(worktreePath)
  if (dirname(resolvedWorktreePath) !== resolvedWorktreesRoot) {
    throw new Error(`Refusing to remove path outside the managed worktrees root: ${resolvedWorktreePath}`)
  }

  if (!assertManagedWorktreesRoot(projectRoot, worktreesRoot)) return
  const managedRootIdentity = readDirectoryIdentity(worktreesRoot)
  let stats: ReturnType<typeof lstatSync>
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
  const worktreeIdentity = entryIdentity(stats)
  if (preserveIgnoredFiles) {
    try {
      const currentStats = lstatSync(worktreePath)
      if (!sameEntryIdentity(worktreeIdentity, entryIdentity(currentStats))) {
        throw new ContainedPathError('Worktree target changed during removal')
      }
      assertNoIgnoredWorktreeFiles(worktreePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

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
  if (!sameEntryIdentity(managedRootIdentity, readDirectoryIdentity(worktreesRoot))) {
    throw new ContainedPathError('Managed worktrees root changed during removal')
  }
  if (preserveIgnoredFiles) {
    try {
      const currentStats = lstatSync(worktreePath)
      if (!sameEntryIdentity(worktreeIdentity, entryIdentity(currentStats))) {
        throw new ContainedPathError('Worktree target changed during removal')
      }
      assertNoIgnoredWorktreeFiles(worktreePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  try {
    const currentStats = lstatSync(worktreePath)
    if (!sameEntryIdentity(worktreeIdentity, entryIdentity(currentStats))) {
      throw new ContainedPathError('Worktree target changed during removal')
    }
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
