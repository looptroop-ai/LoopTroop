import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Temp root as the product will see it.
 *
 * `tmpdir()` returns a symlink on macOS (/var -> /private/var) and an 8.3 short
 * name on Windows (RUNNER~1 -> runneradmin). Product code canonicalises paths
 * before storing or comparing them, so a test that records the raw form ends up
 * asserting one spelling against the other.
 *
 * `.native` matters: plain realpathSync resolves symlinks but leaves 8.3 names
 * untouched, so only the native call agrees with the product on Windows.
 */
export function canonicalTmpdir(): string {
  try {
    return realpathSync.native(tmpdir())
  } catch {
    return tmpdir()
  }
}

/** `mkdtempSync` under a canonicalised temp root. */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(canonicalTmpdir(), prefix))
}

/**
 * Removes a temporary tree, waiting out a Windows handle that has not closed.
 *
 * POSIX unlinks a file other processes still have open. Windows refuses, and a
 * test that spawned `git`, a hook command or any other child into the directory
 * it is about to delete is racing that child's handles being released — the
 * process has exited, but the handles have not necessarily gone with it, and a
 * virus scanner walking the tree holds its own. The removal then throws EPERM
 * from an `afterEach`, which vitest reports as a failing test with a real name
 * and a real assertion, in a file that is working perfectly.
 *
 * That is a Windows-only failure signature this repository has chased more than
 * once. `rmSync`'s own `maxRetries` handles it — 500ms in short steps, which is
 * far longer than a released handle takes and short enough that a genuinely
 * stuck tree still fails the run.
 *
 * The options are inert off Windows, so this is the right call everywhere and
 * there is nothing to make conditional.
 */
export function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

/**
 * Pins line-ending behaviour for a test repository.
 *
 * Git for Windows defaults to `autocrlf=true` and rewrites content on
 * checkout, so byte-for-byte assertions fail there and nowhere else.
 */
export function pinGitLineEndings(repoDir: string): void {
  execFileSync('git', ['-C', repoDir, 'config', 'core.autocrlf', 'false'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repoDir, 'config', 'core.eol', 'lf'], { stdio: 'pipe' })
}
