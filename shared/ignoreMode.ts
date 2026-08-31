/**
 * How LoopTroop's own working files are kept out of a project's git history.
 *
 * `repo` writes to the tracked `.gitignore`, `local` writes to
 * `.git/info/exclude`, `skip` leaves the repository alone. The SPA, the server
 * and the CLI all persist and read these values, so the union, the default and
 * both guard shapes live here rather than being spelled out on each side.
 */
export const IGNORE_MODES = ['repo', 'local', 'skip'] as const

export type IgnoreMode = (typeof IGNORE_MODES)[number]

export const DEFAULT_IGNORE_MODE: IgnoreMode = 'local'

/** Type guard for use where a boolean is wanted. */
export function isIgnoreMode(value: unknown): value is IgnoreMode {
  return (IGNORE_MODES as readonly unknown[]).includes(value)
}

/** Narrowing variant for use where an unknown value should become `null`. */
export function normalizeIgnoreMode(value: unknown): IgnoreMode | null {
  return isIgnoreMode(value) ? value : null
}
