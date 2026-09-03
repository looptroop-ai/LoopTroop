/**
 * One reader for `git status --porcelain=v1 -z`.
 *
 * The `-z` stream is not one record per field. A rename or copy occupies two
 * NUL-terminated fields — `R  <destination>\0<original>\0` — and both parsers
 * that read this format skipped the second field outright, so the path a file
 * was renamed *from* never reached the caller.
 *
 * That is not cosmetic. The bead commit builds its `git add` list from this
 * output: given a rename it staged the new path and not the deletion of the old
 * one, so the committed tree kept both copies. The final-test audit had the
 * matching hole — a renamed file's disappearance was never audited.
 */

export interface GitStatusRecord {
  indexStatus: string
  worktreeStatus: string
  path: string
  /** Where a renamed or copied destination came from, when git reported one. */
  originalPath?: string
}

/**
 * Splits the stream into records, adding the deletion a rename implies.
 *
 * A rename's source is gone from the worktree, so it is returned as its own
 * `D` record. A copy's source is untouched and is not returned: reporting it
 * as deleted would stage a deletion that never happened.
 */
export function parseGitStatusPorcelainZ(output: string): GitStatusRecord[] {
  const fields = output.split('\0').filter(Boolean)
  const records: GitStatusRecord[] = []

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? ''
    // "XY " plus at least one path character.
    if (field.length < 4) continue

    const indexStatus = field[0] ?? ' '
    const worktreeStatus = field[1] ?? ' '
    const path = field.slice(3)
    const isRenameOrCopy = indexStatus === 'R' || indexStatus === 'C'
    const originalPath = isRenameOrCopy && index + 1 < fields.length ? fields[index + 1] : undefined
    if (isRenameOrCopy && index + 1 < fields.length) index += 1

    records.push({
      indexStatus,
      worktreeStatus,
      path,
      ...(originalPath ? { originalPath } : {}),
    })

    if (indexStatus === 'R' && originalPath) {
      records.push({ indexStatus: 'D', worktreeStatus: ' ', path: originalPath })
    }
  }

  return records
}
