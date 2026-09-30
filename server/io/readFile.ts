import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type BigIntStats } from 'node:fs'
import { ContainedPathError } from '../lib/containedPath'

/** Open a regular, already-contained file; the caller owns the descriptor. */
export function openFileNoFollowSync(filePath: string, flags = constants.O_RDONLY): number {
  const assertFileIdentity = (before: BigIntStats | undefined, opened: BigIntStats, after: BigIntStats): void => {
    const sameIdentity = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino
    if (!opened.isFile() || after.isSymbolicLink()
      || !sameIdentity(opened, after)
      || (before !== undefined && !sameIdentity(before, opened))) {
      throw new ContainedPathError('File changed before it could be opened')
    }
  }

  let before: BigIntStats | undefined
  try {
    before = lstatSync(filePath, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !(flags & constants.O_CREAT)) throw error
  }
  if (before && (!before.isFile() || before.isSymbolicLink())) {
    throw new ContainedPathError('Expected a regular file without a replaced link')
  }
  // Windows has no O_NOFOLLOW. Check identity before consuming any content;
  // this narrows replacement races but cannot pin replaceable ancestors.
  const fd = openSync(filePath, flags | (constants.O_NOFOLLOW ?? 0) | (before ? 0 : constants.O_EXCL))
  try {
    const opened = fstatSync(fd, { bigint: true })
    const after = lstatSync(filePath, { bigint: true })
    assertFileIdentity(before, opened, after)
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/** Read an already-contained path without following a replaced final symlink. */
export function readFileNoFollowSync(filePath: string): string {
  const fd = openFileNoFollowSync(filePath)
  try {
    return readFileSync(fd, 'utf-8')
  } finally {
    closeSync(fd)
  }
}
