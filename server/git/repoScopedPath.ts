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
 * segment wherever it sits, control characters, and LoopTroop's own directories.
 */

const CONTROL_DIRECTORIES = ['.ticket', '.looptroop'] as const

export function normalizeRepoScopedPath(filePath: string): string | null {
  const trimmed = filePath.trim().replace(/\\/g, '/')
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\n') || trimmed.includes('\r')) return null
  if (trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)) return null

  const withoutDotPrefix = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed
  const segments = withoutDotPrefix.split('/').filter(Boolean)
  if (segments.length === 0) return null
  // Checked per segment rather than by substring: `a/b/..` climbs out just as
  // `../a` does, and a substring test for '/../' misses it.
  if (segments.some((segment) => segment === '.' || segment === '..')) return null

  const normalized = segments.join('/')
  if (CONTROL_DIRECTORIES.some((root) => normalized === root || normalized.startsWith(`${root}/`))) {
    return null
  }

  return normalized
}

/** Normalises a list, dropping what cannot be normalised, and de-duplicates. */
export function uniqueRepoScopedPaths(files: readonly string[]): string[] {
  return [...new Set(
    files.map(normalizeRepoScopedPath).filter((file): file is string => file !== null),
  )]
}
