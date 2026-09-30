import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type BigIntStats } from 'node:fs'
import { ContainedPathError } from '../lib/containedPath'

/** Open a regular, already-contained file; the caller owns the descriptor. */
export function openFileNoFollowSync(filePath: string, flags = constants.O_RDONLY): number {
  const getBeforeIdentity = (): BigIntStats | undefined => {
    try {
      return lstatSync(filePath, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (flags & constants.O_CREAT) !== 0) return undefined
      throw error
    }
  }
  const assertBeforeIdentity = (before: BigIntStats | undefined): void => {
    if (before && !before.isFile()) throw new ContainedPathError('Expected a regular file without a replaced link')
  }
  const getOpenFlags = (before: BigIntStats | undefined): number =>
    flags | (constants.O_NOFOLLOW ?? 0) | (before ? 0 : constants.O_EXCL)
  const assertFileIdentity = (before: BigIntStats | undefined, opened: BigIntStats, after: BigIntStats): void => {
    const sameIdentity = (left: BigIntStats | undefined, right: BigIntStats) =>
      left === undefined || (left.dev === right.dev && left.ino === right.ino)
    const validIdentity = [opened.isFile(), after.isFile(), sameIdentity(opened, after), sameIdentity(before, opened)].every(Boolean)
    if (!validIdentity) {
      throw new ContainedPathError('File changed before it could be opened')
    }
  }

  const before = getBeforeIdentity()
  assertBeforeIdentity(before)
  // Windows has no O_NOFOLLOW. Check identity before consuming any content;
  // this narrows replacement races but cannot pin replaceable ancestors.
  const fd = openSync(filePath, getOpenFlags(before))
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
