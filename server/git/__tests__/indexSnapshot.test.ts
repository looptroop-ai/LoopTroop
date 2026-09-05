import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import { runCommandSync } from '../runCommand'
import { GitIndexSnapshotUnavailableError, snapshotGitIndex, withGitIndexRollback } from '../indexSnapshot'

const roots: string[] = []

function git(cwd: string, ...args: string[]): string {
  const result = runCommandSync('git', args, { cwd, log: false })
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.errorDetail}`)
  return result.stdout
}

function makeRepo(): string {
  const root = makeTempDir('looptroop-index-snapshot-')
  roots.push(root)
  git(root, 'init', '--initial-branch', 'main')
  git(root, 'config', 'user.name', 'LoopTroop')
  git(root, 'config', 'user.email', 'looptroop@local')
  writeFileSync(join(root, 'tracked.txt'), 'one\n')
  git(root, 'add', '--', 'tracked.txt')
  git(root, 'commit', '-m', 'initial')
  return root
}

/** Staged paths, as `git diff --cached --name-only` reports them. */
function stagedPaths(root: string): string[] {
  return git(root, 'diff', '--cached', '--name-only').split('\n').filter(Boolean)
}

afterEach(() => {
  // `removeTempDir`, not a bare `rmSync`: these directories had `git`
  // spawned into them, and Windows refuses to delete a tree whose handles
  // have not been released yet — it retries rather than failing an
  // otherwise-passing test from its own teardown.
  for (const root of roots.splice(0)) removeTempDir(root)
})

describe('withGitIndexRollback', () => {
  it('keeps what the work staged when it asks to', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'added.txt'), 'new\n')

    const value = withGitIndexRollback(root, () => {
      git(root, 'add', '--', 'added.txt')
      return { keepIndex: true, value: 'kept' }
    })

    expect(value).toBe('kept')
    expect(stagedPaths(root)).toEqual(['added.txt'])
  })

  it('unstages what the work staged when it does not', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'added.txt'), 'new\n')

    withGitIndexRollback(root, () => {
      git(root, 'add', '--', 'added.txt')
      return { keepIndex: false, value: undefined }
    })

    expect(stagedPaths(root)).toEqual([])
  })

  it('leaves an unrelated pre-staged edit staged after a failed run', () => {
    // The reason this snapshots the whole index rather than recording paths: a
    // `git reset` broad enough to undo the staging would also throw away work
    // the operator staged by hand before the run.
    const root = makeRepo()
    writeFileSync(join(root, 'tracked.txt'), 'edited by hand\n')
    git(root, 'add', '--', 'tracked.txt')
    writeFileSync(join(root, 'added.txt'), 'new\n')

    expect(() => withGitIndexRollback(root, () => {
      git(root, 'add', '--', 'added.txt')
      throw new Error('commit failed')
    })).toThrow('commit failed')

    expect(stagedPaths(root)).toEqual(['tracked.txt'])
    expect(git(root, 'diff', '--cached', '--', 'tracked.txt')).toContain('edited by hand')
  })

  it('restores a repository that had no index at all', () => {
    const root = makeTempDir('looptroop-index-snapshot-empty-')
    roots.push(root)
    git(root, 'init', '--initial-branch', 'main')
    writeFileSync(join(root, 'added.txt'), 'new\n')

    withGitIndexRollback(root, () => {
      git(root, 'add', '--', 'added.txt')
      return { keepIndex: false, value: undefined }
    })

    expect(git(root, 'status', '--porcelain')).toBe('?? added.txt')
  })

  it('refuses to run when the index cannot be snapshotted', () => {
    // Fail-closed: without a snapshot there is nothing to roll back to, and
    // running anyway is exactly the fault this exists to prevent.
    const root = makeTempDir('looptroop-index-snapshot-nonrepo-')
    roots.push(root)
    let ran = false

    expect(() => withGitIndexRollback(root, () => {
      ran = true
      return { keepIndex: false, value: undefined }
    })).toThrow(GitIndexSnapshotUnavailableError)
    expect(ran).toBe(false)
  })
})

describe('snapshotGitIndex', () => {
  it('reports failure rather than throwing when the path is not a repository', () => {
    const root = makeTempDir('looptroop-index-snapshot-plain-')
    roots.push(root)
    expect(snapshotGitIndex(root)).toBeNull()
  })
})
