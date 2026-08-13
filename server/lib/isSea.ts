import { isSea as nodeIsSea } from 'node:sea'

/**
 * Whether this process is a single-file build rather than Node running scripts.
 *
 * `node:sea` is an ordinary builtin — present whether or not the process is a
 * single-file application, answering `false` when it is not — so this needs no
 * guard and no dynamic import.
 *
 * This says what the *artifact* is, never where it came from. A binary
 * downloaded directly, one installed by WinGet and one installed by Nix are all
 * single-file builds, so `installChannel` stays a separate question with a
 * separate answer.
 */
export function isSea(): boolean {
  try {
    return nodeIsSea()
  } catch {
    // Defensive only: the builtin exists on every Node this package supports.
    return false
  }
}
