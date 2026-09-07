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
 * once. `rmSync`'s own `maxRetries` handles most of it, and the budget below is
 * a few seconds in growing steps — enough for the case that kept
 * `hookValidation.test.ts` red on a required lane: a command that hits its
 * timeout is killed with `taskkill /T`, and that walks the process tree *after*
 * returning, so the handles outlive the call that asked for them.
 *
 * `retryDelay` is not that budget divided by `maxRetries`. Node backs off
 * linearly — attempt *n* sleeps `n * retryDelay` — so the wall clock is the
 * triangular sum, `retryDelay * n * (n + 1) / 2`. The 30 retries this asked for
 * were 46.5 seconds of synchronous teardown, not the three the comment claimed,
 * and a teardown that blocks that long turns a warning into a suite that runs
 * out of time. Seven is ~2.8s, which is the figure that was actually wanted.
 *
 * The elapsed time is measured rather than stated, because the stated one was
 * wrong for as long as it was written down.
 *
 * A tree still locked after that is reported and left behind rather than failing
 * the run. The alternative is a red required lane for a runner's timing, and the
 * cost is a directory under the temp root that the runner discards anyway. The
 * warning is deliberately loud: if it starts appearing on POSIX, or on every
 * Windows run rather than the occasional one, something is genuinely leaking a
 * handle and this is where to start.
 *
 * The retry options are inert off Windows — libuv only retries there, so a
 * locked tree on POSIX fails in milliseconds — which is why only the last-resort
 * branch is conditional. Everywhere else, a removal that fails is a real defect.
 */
export function removeTempDir(path: string): void {
  const startedAt = Date.now()
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 7, retryDelay: 100 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    const isWindowsLock = process.platform === 'win32'
      && (code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY')
    if (!isWindowsLock) throw error
    console.warn(
      `[tempDir] leaving ${path} behind: still locked after ${Date.now() - startedAt}ms (${code}). `
      + 'A child process is holding a handle past its own exit.',
    )
  }
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
