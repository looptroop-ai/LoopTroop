/**
 * Types for `smoke-lib.mjs`, which is plain ESM because the smoke scripts that
 * use it are, and because two of them run against an installed release rather
 * than a checkout. Kept beside the source for the same reason
 * `installer-core.d.mts` is: `scripts/` is typechecked, so a `.ts` caller
 * importing an untyped `.mjs` module gets `any` for everything.
 */

/** Whatever `/api/health` returned, or null if it never answered in time. */
export function waitForHealth(baseUrl: string, timeoutMs: number): Promise<unknown>

/** Removes a directory with retries, returning what stopped it or null. */
export function removeWorkDirectory(path: string): Error | null
