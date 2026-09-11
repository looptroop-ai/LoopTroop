import { closeSync, constants, openSync, readFileSync } from 'node:fs'

/** Read an already-contained path without following a replaced final symlink. */
export function readFileNoFollowSync(filePath: string): string {
  const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    return readFileSync(fd, 'utf-8')
  } finally {
    closeSync(fd)
  }
}
