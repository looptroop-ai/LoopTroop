import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Temp root as the product will see it.
 *
 * `tmpdir()` returns a symlink on macOS (/var -> /private/var) and an 8.3 short
 * name on Windows (RUNNER~1 -> runneradmin). Product code canonicalises paths
 * before storing or comparing them, so a test that records the raw form ends up
 * asserting one spelling against the other.
 */
export function canonicalTmpdir(): string {
  try {
    return realpathSync(tmpdir())
  } catch {
    return tmpdir()
  }
}

/** `mkdtempSync` under a canonicalised temp root. */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(canonicalTmpdir(), prefix))
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
