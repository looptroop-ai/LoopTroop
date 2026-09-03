import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runGitSync } from './runCommand'

/**
 * A complete copy of a worktree's git index, and the ability to put it back.
 *
 * Recording the *paths* that were staged is not enough to undo a staging step:
 * the index also carries blob contents, file modes, deletions and rename
 * information, and a `git reset` broad enough to clear what was added would
 * throw away whatever else was already staged. Copying the index file keeps
 * all of it, byte for byte.
 *
 * Used where a git command stages something it may then fail to commit — the
 * bead commit and explicit hook validation both do — so a failure leaves the
 * worktree exactly as it was found.
 */
export interface GitIndexSnapshot {
  /** Puts the recorded index back, discarding anything staged since. */
  restore: () => void
  /** Removes the temporary copy. Safe to call after `restore`. */
  dispose: () => void
}

export function snapshotGitIndex(worktreePath: string): GitIndexSnapshot | null {
  // A linked worktree has its own index under .git/worktrees/<name>, which is
  // what --absolute-git-dir resolves to; the main checkout resolves to .git.
  const gitDirectory = runGitSync(worktreePath, ['rev-parse', '--absolute-git-dir'])
  if (!gitDirectory.ok) return null

  const indexPath = resolve(gitDirectory.stdout, 'index')
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'looptroop-index-'))
  const backupPath = resolve(temporaryDirectory, 'index')
  // A repository where nothing has ever been staged has no index file at all;
  // restoring that state means removing whatever we caused to be written.
  const hadIndex = existsSync(indexPath)
  if (hadIndex) {
    try {
      copyFileSync(indexPath, backupPath)
    } catch {
      rmSync(temporaryDirectory, { recursive: true, force: true })
      return null
    }
  }

  return {
    restore: () => {
      if (hadIndex) {
        if (existsSync(backupPath)) copyFileSync(backupPath, indexPath)
        return
      }
      rmSync(indexPath, { force: true })
    },
    dispose: () => rmSync(temporaryDirectory, { recursive: true, force: true }),
  }
}

/**
 * Runs `work` with the index protected, restoring it unless `work` says to keep
 * what it staged. A throw always restores.
 */
export function withGitIndexRollback<T>(
  worktreePath: string,
  work: () => { keepIndex: boolean; value: T },
): T {
  const snapshot = snapshotGitIndex(worktreePath)
  try {
    const outcome = work()
    if (!outcome.keepIndex) snapshot?.restore()
    return outcome.value
  } catch (error) {
    snapshot?.restore()
    throw error
  } finally {
    snapshot?.dispose()
  }
}
