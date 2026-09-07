/**
 * The pieces every smoke script needs, written once.
 *
 * These scripts each drive an installed LoopTroop through the same lifecycle,
 * so they had each grown their own copy of the same two helpers — three
 * `waitForHealth` implementations differing only in a default timeout and which
 * sleep they called, and four copies of the retry-and-never-throw removal, with
 * four slightly different failure messages.
 *
 * What is *not* shared: `scripts/installer-core.mjs` carries its own copies of
 * some of this and keeps them. It is embedded verbatim into `install.sh` and
 * `install.ps1`, which have to be standalone single files — `curl … | sh`
 * cannot fetch a second one — so it can import nothing at all.
 *
 * Policy stays with the caller. Neither helper here chooses a timeout or
 * decides what to say about a failure, because those genuinely differ per
 * script and a shared default would quietly impose one script's answer on
 * another.
 */
import { rmSync } from 'node:fs'

/**
 * The daemon's health payload once it answers, or null once `timeoutMs` is up.
 *
 * `timeoutMs` is required rather than defaulted. The three callers want 30, 30
 * and 60 seconds, and a default here would be one of those three silently
 * applied to the other two — the published-install smoke waits longer on
 * purpose, because a launcher a package manager just installed may be starting
 * on a cold filesystem.
 */
export async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      // Bounded by the deadline the caller gave, not merely checked against it
      // between attempts. A daemon that accepts the connection and then stalls
      // on headers or on the body leaves an unsignalled `fetch` pending for as
      // long as it likes, so the loop could not return within its own timeout —
      // in a change whose whole subject is that transfers must be bounded.
      // The signal covers `json()` too, since that is still reading the body.
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
      const response = await fetch(`${baseUrl}/api/health`, { signal })
      if (response.ok) return await response.json()
    } catch {
      // Not listening yet, or this attempt ran out of time.
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  return null
}

/**
 * Removes a temporary directory, retrying, and never throwing.
 *
 * Every one of these scripts has just run an executable out of the directory it
 * is about to delete, and Windows does not release the handle the instant a
 * process exits. `force` swallows ENOENT and nothing else, so a plain removal
 * turned a smoke test that had already printed PASS into a failed release.
 *
 * Ten retries with a 100 ms linear backoff, so the last attempt is a second
 * after the one before it and the whole sequence is about five and a half
 * seconds — long enough for a handle to be released, short enough not to look
 * like a hang.
 *
 * Returns what stopped it rather than reporting it, because a leftover
 * temporary directory is litter in some of these scripts and worth a line on
 * stderr in others, and that is the caller's call.
 */
export function removeWorkDirectory(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
