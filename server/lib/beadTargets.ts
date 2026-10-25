import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isBeadTargetFile, isExternalTargetFile } from '../../shared/beadTargets'

/** Resolve existing parents too: a new file can be beneath an external symlink. */
export function getExternalTargetFiles(targetFiles: unknown, worktreePath: string): string[] {
  if (!Array.isArray(targetFiles)) return []
  return targetFiles.filter(isBeadTargetFile).filter((target) => {
    if (isExternalTargetFile(target)) return true
    let candidate = resolve(worktreePath, target)
    try {
      const root = realpathSync(worktreePath)
      for (;;) {
        try {
          const resolved = realpathSync(candidate)
          const offset = relative(root, resolved)
          return offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return true
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) return true
          const parent = dirname(candidate)
          if (parent === candidate) return true
          candidate = parent
        }
      }
    } catch {
      return true
    }
  })
}
