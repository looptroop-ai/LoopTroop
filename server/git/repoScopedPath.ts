/**
 * One normaliser for a repository-relative path that git is about to be handed.
 *
 * The final-test audit, the candidate-file audit and the squash path filter each
 * carried their own copy, and the copies were not equivalent: the squash one
 * skipped the backslash conversion and the drive-letter rejection, and tested
 * for `..` with `includes('/../')`, which accepts a trailing `foo/bar/..`. Its
 * output feeds `git add -f` and `git checkout`, so it was the weakest filter in
 * front of the most dangerous commands.
 *
 * Accepts what a genuinely relative path looks like on either platform and
 * rejects everything else: absolute and drive-qualified paths, any `.` or `..`
 * segment wherever it sits, NUL (which cannot be an argv byte), and
 * Git/LoopTroop metadata. Other control bytes remain legal POSIX filename
 * bytes and are kept opaque.
 */

import { lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const CONTROL_DIRECTORIES = ['.git', '.ticket', '.looptroop'] as const

function comparePathPart(value: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? value.toLowerCase()
    : value
}

function traversesSymlink(rootPath: string, normalizedPath: string): boolean {
  if (!isAbsolute(rootPath)) return true

  let current = resolve(rootPath)
  try {
    if (lstatSync(current).isSymbolicLink()) return true
  } catch {
    return true
  }
  const segments = normalizedPath.split('/')
  // A symlink at the final path is still a valid Git entry. Refuse only a
  // symlink ancestor, where resolving the path would leave the worktree.
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) return true
    } catch (error) {
      // Missing descendants cannot redirect this request. Other filesystem
      // errors fail closed because the target cannot be inspected safely.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true
      return false
    }
  }
  return false
}

export function normalizeRepoScopedPath(filePath: string): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) return null
  // Backslash is a separator only on Windows. On POSIX it is an ordinary,
  // legal filename byte and changing it makes a Git-sourced path unaddressable.
  const platformPath = process.platform === 'win32' ? filePath.replace(/\\/g, '/') : filePath
  // Any drive qualifier, slash or not: `C:foo` is a path relative to the
  // *current directory on drive C*, which on Windows is not this worktree, and
  // a bare `C:` is the drive itself. Both were accepted while only `C:/` was
  // rejected.
  if (platformPath.startsWith('/') || /^[A-Za-z]:/.test(platformPath)) return null

  const withoutDotPrefix = platformPath.startsWith('./') ? platformPath.slice(2) : platformPath
  const segments = withoutDotPrefix.split('/').filter(Boolean)
  if (segments.length === 0) return null
  // Checked per segment rather than by substring: `a/b/..` climbs out just as
  // `../a` does, and a substring test for '/../' misses it.
  if (segments.some((segment) => segment === '.' || segment === '..')) return null

  const normalized = segments.join('/')
  const comparable = comparePathPart(normalized)
  if (CONTROL_DIRECTORIES.some((root) => {
    const comparableRoot = comparePathPart(root)
    return comparable === comparableRoot || comparable.startsWith(`${comparableRoot}/`)
  })) {
    return null
  }

  return normalized
}

/** Normalises a list, dropping what cannot be normalised, and de-duplicates. */
export function uniqueRepoScopedPaths(files: readonly string[], rootPath?: string): string[] {
  return [...new Set(
    files
      .map(normalizeRepoScopedPath)
      .filter((file): file is string => file !== null)
      .filter((file) => !rootPath || !traversesSymlink(rootPath, file)),
  )]
}
