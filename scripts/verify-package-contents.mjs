#!/usr/bin/env node
/**
 * Fails if the published tarball would be missing something it needs, or
 * carrying something it should not.
 *
 * `files` is an allowlist of prefixes, which makes both mistakes silent. Add a
 * runtime asset outside `dist/` and the tarball simply lacks it; the package
 * installs cleanly and fails on the user's machine. Point `bin` somewhere the
 * allowlist does not reach and `npm install -g` produces a command that cannot
 * start. Neither shows up in a test run against the source tree, because the
 * source tree has every file.
 *
 * So this asks npm what it would actually pack, and checks that list against
 * what the manifest promises: every entry point resolves inside the tarball,
 * the documents a redistributed package must carry are present, and nothing
 * from the working tree rode along.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * Documents every published package must carry: the licence it is offered
 * under, the notices for what it redistributes, and the two files a user reads
 * before and after upgrading.
 *
 * npm adds `package.json`, `README.md` and `LICENSE` on its own whatever `files`
 * says, so those three are asserted rather than guarded — they are here to
 * state the contract, and they hold even if the allowlist forgets them. The
 * rest are only in the tarball because `files` names them, and drop out
 * silently when it stops.
 */
const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'CHANGELOG.md',
  // The interface the daemon serves. Its absence is invisible until a browser
  // asks for it, which is after the user has already installed and started.
  'dist/client/index.html',
]

/**
 * Things that exist in a working tree and must never be published.
 *
 * Sources and sourcemaps are not secret, but they are not what this package
 * distributes, and shipping them makes the tarball a second, unversioned copy
 * of the repository. `.env` and local databases are a different matter: those
 * are the developer's own machine, and no released artefact may contain them.
 */
const FORBIDDEN = [
  { pattern: /(^|\/)\.env(\.|$)/, reason: 'local environment file' },
  { pattern: /\.map$/, reason: 'sourcemap' },
  { pattern: /\.tsbuildinfo$/, reason: 'TypeScript build cache' },
  { pattern: /(^|\/)(__tests__|tests)\//, reason: 'test directory' },
  { pattern: /\.test\.[cm]?[jt]sx?$/, reason: 'test file' },
  { pattern: /\.sqlite(-wal|-shm)?$/, reason: 'database file' },
  { pattern: /(^|\/)node_modules\//, reason: 'dependency tree' },
  // Emitted by the vite plugin purely so the notices generator can read it.
  { pattern: /(^|\/)bundled-packages\.json$/, reason: 'build-time manifest' },
]

/** Where a published file may live: the build output, or a document at the root. */
const ALLOWED_ROOTS = [/^dist\//, /^[^/]+$/]

function readPackedFiles() {
  // --dry-run so nothing is written; --json so this reads a list rather than
  // scraping the human-readable notice output, which changes between npm
  // releases.
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  // npm 11 reports an array of packed tarballs here; npm 12 reports an object
  // keyed by package name. Reading only the array shape throws "is not
  // iterable" on npm 12 and fails this required check for a reason that names
  // neither npm nor the change.
  const parsed = JSON.parse(raw)
  const result = Array.isArray(parsed)
    ? parsed[0]
    : parsed?.files
      ? parsed
      : Object.values(parsed ?? {})[0]
  if (!result?.files) throw new Error('npm pack --json returned no file list')
  return result.files.map((file) => file.path)
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const packed = readPackedFiles()
const present = new Set(packed)
const failures = []

if (manifest.private) {
  failures.push('package.json still has "private": true, so this package cannot be published.')
}

// The entry points, taken from the manifest rather than hardcoded: a rename
// that forgets the `files` list is exactly the mistake this is here to catch.
for (const [name, target] of Object.entries(manifest.bin ?? {})) {
  if (!present.has(target)) {
    failures.push(`bin "${name}" points at ${target}, which the tarball does not contain.`)
  }
}
if (manifest.main && !present.has(manifest.main)) {
  failures.push(`"main" points at ${manifest.main}, which the tarball does not contain.`)
}

for (const required of REQUIRED_FILES) {
  if (!present.has(required)) failures.push(`Missing from the tarball: ${required}`)
}

for (const path of packed) {
  for (const { pattern, reason } of FORBIDDEN) {
    if (pattern.test(path)) failures.push(`Should not be published (${reason}): ${path}`)
  }
  if (!ALLOWED_ROOTS.some((allowed) => allowed.test(path))) {
    failures.push(`Outside the published layout (expected dist/ or a root document): ${path}`)
  }
}

console.log(`Checked ${packed.length} file(s) npm would pack for ${manifest.name}@${manifest.version}.`)

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} packaging problem(s).\n`)
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('\nAdjust "files" in package.json, or the build, so the tarball matches what the')
  console.error('package promises. Run `npm pack --dry-run` to see the full list.')
  process.exit(1)
}

console.log('PASS: the tarball carries every entry point and nothing from the working tree.')
