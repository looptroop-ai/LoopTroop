import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { ContainedPathError, escapesRoot, resolveContainedPath } from '../lib/containedPath'
import { safeAtomicWriteWithin, type SafeAtomicWriteOptions } from '../io/atomicWrite'

/** Resolve from the project so a replaced worktrees directory cannot become a trusted root. */
export function resolveProjectTicketContainedPath(
  projectRoot: string,
  externalId: string,
  relativePath: string,
  kind: 'read' | 'remove' = 'read',
): string {
  if (!externalId || externalId === '.' || externalId === '..' || /[\\/\0:]/.test(externalId)) {
    throw new ContainedPathError('Invalid ticket path')
  }
  if (relativePath.includes('\0') || isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)
    || relativePath.startsWith('\\') || relativePath.split(/[\\/]/).includes('..')) {
    throw new ContainedPathError('File path must stay within the ticket directory')
  }
  const ticketRelative = join('.looptroop', 'worktrees', externalId, '.ticket')
  // Reads preserve the absent-artifact response; writes may create its parents.
  const options = { allowMissingParents: true }
  const worktree = resolveContainedPath(projectRoot, join('.looptroop', 'worktrees', externalId), options)
  const ticketRoot = resolveContainedPath(projectRoot, ticketRelative, options)
  if (escapesRoot(worktree, ticketRoot)) throw new ContainedPathError('Ticket directory must stay within its worktree')
  // Removal acts on the directory entry itself: resolving a final link before
  // recursive rm could delete the directory it points to, including the ticket.
  const checkedRelative = kind === 'remove' ? dirname(relativePath) : relativePath
  const target = resolveContainedPath(projectRoot, join(ticketRelative, checkedRelative), options)
  if (escapesRoot(ticketRoot, target)) throw new ContainedPathError('File path must stay within the ticket directory')
  if (kind === 'remove') {
    const name = basename(relativePath)
    if (!name || name === '.' || name === '..') throw new ContainedPathError('Cannot remove the ticket root')
    return join(target, name)
  }
  return target
}

export function writeProjectTicketFile(
  projectRoot: string,
  externalId: string,
  relativePath: string,
  content: string,
  options?: SafeAtomicWriteOptions,
): void {
  const target = resolveProjectTicketContainedPath(projectRoot, externalId, relativePath)
  const root = resolveContainedPath(projectRoot, '.')
  safeAtomicWriteWithin(root, relative(root, target), content, options)
}
