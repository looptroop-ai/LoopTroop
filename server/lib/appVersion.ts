import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The application version, compiled in rather than read off disk.
 *
 * Two callers used to resolve `package.json` three levels up from their own
 * module and parse it. That works for an npm install, where the module really
 * does sit inside the package, and produces `0.0.0` everywhere else — most
 * importantly inside a single-file build, where there is no `package.json` on
 * disk at all and the path it would look at is the executable's.
 *
 * `0.0.0` is the worst possible failure here: `--version` still answers, the
 * update check still runs, and both are silently wrong.
 *
 * The build replaces `__LOOPTROOP_VERSION__` with a literal. The filesystem
 * read stays as the fallback for `tsx`, for the test suite, and for anyone
 * running the sources directly — none of which go through a bundler.
 */
declare const __LOOPTROOP_VERSION__: string | undefined

function readFromPackageJson(): string {
  try {
    // dist/server/lib/appVersion.js -> package root is three levels up, and
    // server/lib/appVersion.ts -> two. Both are tried rather than guessing
    // which build this is.
    const here = dirname(fileURLToPath(import.meta.url))
    for (const up of ['../../..', '../..']) {
      try {
        const manifest = JSON.parse(readFileSync(resolve(here, up, 'package.json'), 'utf8')) as { name?: string, version?: string }
        // Any `package.json` will parse; only ours is the right answer. Without
        // this check a bundle sitting inside somebody else's package would
        // report their version.
        if (manifest.name === 'looptroop' && typeof manifest.version === 'string') return manifest.version
      } catch {
        continue
      }
    }
  } catch {
    // Falls through to the placeholder below.
  }
  return '0.0.0'
}

export const APP_VERSION: string = typeof __LOOPTROOP_VERSION__ === 'string'
  ? __LOOPTROOP_VERSION__
  : readFromPackageJson()
