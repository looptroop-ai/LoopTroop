import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export class ContainedPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContainedPathError'
  }
}

export interface ContainedPathOptions {
  /** Permit a missing final component, but require its parents to exist. */
  allowMissing?: boolean
  /** Permit a missing tail of directories and the final component. */
  allowMissingParents?: boolean
}

function invalidPath(value: string): boolean {
  // Backslashes are filenames on POSIX. Only reject foreign rooted/drive paths;
  // native path operations already normalize both separators on Windows.
  return value.includes('\0') || (process.platform !== 'win32' && /^(?:[a-z]:|\\)/i.test(value))
}

/** Advisory lexical check only; use resolveContainedPath for filesystem access. */
export function escapesRoot(root: string, candidate: string): boolean {
  if (invalidPath(root) || invalidPath(candidate)) return true
  const offset = relative(resolve(root), resolve(root, candidate))
  return offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)
}

/**
 * Resolve within an existing, canonical root. Symlinks and junctions are
 * accepted only when their existing canonical destination remains inside it.
 * Missing entries retain ENOENT unless explicitly permitted; other filesystem
 * errors are never treated as missing entries.
 *
 * This is a point-in-time check: Node exposes no portable openat/renameat API,
 * so another process can still replace an ancestor before the caller's I/O.
 * Callers must revalidate after mkdir and use no-follow opens where available.
 */
export function resolveContainedPath(root: string, candidate: string, options: ContainedPathOptions = {}): string {
  if (invalidPath(root) || invalidPath(candidate)) throw new ContainedPathError('Invalid contained path')
  const canonicalRoot = realpathSync.native(root)
  // Absolute callers may still use the configured root's symlink spelling.
  const target = isAbsolute(candidate) && !escapesRoot(root, candidate)
    ? resolve(canonicalRoot, relative(resolve(root), candidate))
    : resolve(canonicalRoot, candidate)
  if (escapesRoot(canonicalRoot, target)) throw new ContainedPathError('Path escapes root')

  const offset = relative(canonicalRoot, target)
  const parts = offset ? offset.split(sep) : []
  let current = canonicalRoot
  for (let index = 0; index < parts.length; index++) {
    current = resolve(current, parts[index]!)
    let stats
    try {
      stats = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT'
        && (options.allowMissingParents || (options.allowMissing && index === parts.length - 1))) {
        return resolve(current, ...parts.slice(index + 1))
      }
      throw error
    }
    if (stats.isSymbolicLink()) {
      try {
        current = realpathSync.native(current)
      } catch (error) {
        if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw new ContainedPathError('Symbolic link destination is missing or cyclic')
        }
        throw error
      }
      if (escapesRoot(canonicalRoot, current)) throw new ContainedPathError('Symbolic link escapes root')
    }
  }
  return current
}
