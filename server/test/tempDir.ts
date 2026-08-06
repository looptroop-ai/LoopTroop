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
