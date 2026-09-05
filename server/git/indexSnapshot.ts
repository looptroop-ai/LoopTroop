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

export class GitIndexSnapshotUnavailableError extends Error {
  constructor(worktreePath: string) {
    super(`The git index for ${worktreePath} could not be snapshotted, so the operation was refused rather than run without a rollback.`)
    this.name = 'GitIndexSnapshotUnavailableError'
  }
}

/**
 * Runs `work` with the index protected, restoring it unless `work` says to keep
 * what it staged. A throw always restores.
 *
 * **Refuses to run at all when the snapshot cannot be taken.** Proceeding
 * without one put back exactly the fault this exists to prevent: `work` stages,
 * the commit fails, and nothing can undo it. A caller that would rather carry
 * on unprotected has to say so, and none does.
 *
 * A restore that itself fails is reported alongside the original failure rather
 * than replacing it — the original is what the operator needs to read first.
 */
export function withGitIndexRollback<T>(
  worktreePath: string,
  work: () => { keepIndex: boolean; value: T },
): T {
  const snapshot = snapshotGitIndex(worktreePath)
  if (!snapshot) throw new GitIndexSnapshotUnavailableError(worktreePath)
  try {
    const outcome = work()
    if (!outcome.keepIndex) restoreQuietly(snapshot, null)
    return outcome.value
  } catch (error) {
    restoreQuietly(snapshot, error)
    throw error
  } finally {
    // Best effort, and never the reason a successful operation fails: removing
    // a temporary directory is not something the caller can act on, and a throw
    // here would replace the outcome — success or the original error — with it.
    try {
      snapshot.dispose()
    } catch (disposeError) {
      console.error('[git] Failed to remove the index snapshot directory.', disposeError)
    }
  }
}

/**
 * Restores, and never lets that throw over the failure that caused it.
 *
 * `originalError` is null on the ordinary "nothing to keep" path, where a
 * restore failure is the only thing that went wrong and is worth surfacing.
 */
function restoreQuietly(snapshot: GitIndexSnapshot, originalError: unknown): void {
  try {
    snapshot.restore()
  } catch (restoreError) {
    if (originalError === null) throw restoreError
    console.error('[git] Failed to restore the index after an error; the original failure follows.', restoreError)
  }
}
