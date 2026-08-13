import { resolve } from 'node:path'
import { isSea } from '../lib/isSea'

/**
 * How `start` hands off to the detached process that becomes the daemon.
 *
 * Its own module rather than living beside either caller: the CLI entry
 * dispatches on it and `startCommand` produces it, and putting it in one of
 * those would make the two import each other.
 */

/**
 * The argument this program re-invokes itself with to become the daemon.
 *
 * Deliberately not a documented command — it is an implementation detail of how
 * a detached child is created, and running it by hand does nothing a user
 * wants. The leading underscores keep it out of the usage text and make an
 * accidental collision with a real command name impossible.
 */
export const DAEMON_ARGV = '__daemon'

/**
 * The arguments to pass `process.execPath` so the child becomes the daemon.
 *
 * `process.execPath` is not the same thing in the two builds, which is the
 * whole reason this exists. Under npm it is `node`, so the script has to be
 * named too — and this used to name a *second* file, `daemonProcess.js`, which
 * sits beside the CLI only because npm unpacks a directory. Inside a
 * single-file build there is no such file and `process.execPath` is the
 * executable itself, so that spawn re-invoked LoopTroop with a path that does
 * not exist as its first argument, and `start` waited out its readiness
 * timeout reporting a failure with no cause.
 *
 * `isSea()` is what separates the two: in a single-file build `argv[1]` is the
 * executable rather than a script, so passing it along would run the binary
 * against itself.
 */
export function daemonArgv(): string[] {
  if (isSea()) return [DAEMON_ARGV]

  // `argv[1]` is the script Node was given — the CLI entry, whatever it is
  // called and wherever it was installed. Read rather than assumed, so this
  // keeps working from `dist/`, from a global install and under `tsx`.
  const entry = process.argv[1]
  if (entry === undefined) throw new Error('Cannot start the daemon: this process has no entry script.')
  return [resolve(entry), DAEMON_ARGV]
}
