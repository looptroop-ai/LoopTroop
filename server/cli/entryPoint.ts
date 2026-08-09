import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Whether this module is the file Node was told to run, rather than one imported
 * by something else.
 *
 * The obvious spelling — comparing `import.meta.url` with
 * `` `file://${process.argv[1]}` `` — is wrong on Windows and quietly so. A
 * module URL there is `file:///C:/path/daemonProcess.js` while `argv[1]` is
 * `C:\path\daemonProcess.js`, so the two never match: three slashes against two,
 * backslashes against forward, and a drive letter that belongs after the
 * authority. The detached daemon then loads its own module, runs nothing, and
 * exits silently — `looptroop start` waits out its full readiness timeout and
 * reports a failure with no cause in the log.
 *
 * Comparing filesystem paths instead makes the platform's own rules do the work:
 * `fileURLToPath` handles the drive letter, the slashes and any percent-encoding
 * (a path containing a space arrives as `%20` in the URL and a literal space in
 * argv), and `resolve` normalises the argument the shell passed.
 */
export function isEntryPoint(moduleUrl: string, entryPath: string | undefined): boolean {
  if (!entryPath) return false

  try {
    return fileURLToPath(moduleUrl) === resolve(entryPath)
  } catch {
    // A module URL that is not a file:// URL cannot be an entry point.
    return false
  }
}
