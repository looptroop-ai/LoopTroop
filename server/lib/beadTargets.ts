import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { isBeadTargetFile, isExternalTargetFile } from '../../shared/beadTargets'

/** Resolve existing parents too: a new file can be beneath an external symlink. */
export function getExternalTargetFiles(targetFiles: unknown, worktreePath: string): string[] {
  if (!Array.isArray(targetFiles)) return []
  const validTargets = targetFiles.filter(isBeadTargetFile)
  let root: string
  try {
    root = realpathSync(worktreePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return validTargets.filter(isExternalTargetFile)
    return validTargets
  }
  const isOutsideRoot = (candidate: string) => {
    const offset = relative(root, candidate)
    return offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)
  }
  return validTargets.filter((target) => {
    if (isExternalTargetFile(target)) return true
    let candidate = root
    const parts = target.split(sep === '\\' ? /[\\/]/ : sep)
    for (const part of parts) {
      if (!part || part === '.') continue
      if (part === '..') {
        candidate = dirname(candidate)
        continue
      }
      const next = `${candidate}${candidate.endsWith(sep) ? '' : sep}${part}`
      try {
        candidate = realpathSync(next)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!['ENOENT', 'ENOTDIR'].includes(code ?? '')) return true
        if (code === 'ENOENT') {
          try {
            if (lstatSync(next, { throwIfNoEntry: false })?.isSymbolicLink()) return true
          } catch {
            return true
          }
        }
        return isOutsideRoot(candidate)
      }
    }
    return isOutsideRoot(candidate)
  })
}
