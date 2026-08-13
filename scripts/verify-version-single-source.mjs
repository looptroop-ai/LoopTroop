#!/usr/bin/env node
/**
 * Fails if a tracked file hardcodes the application version instead of
 * deriving it from package.json.
 *
 * A naive grep for the version string is useless here: changelogs, release
 * notes and lockfiles legitimately contain it, and package-lock.json contains
 * unrelated dependency versions that happen to match. This checks only files
 * that are expected to derive the version, and allowlists the historical
 * records that must keep literal versions.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Paths that legitimately contain literal version strings. */
const ALLOWED_PATHS = [
  'package.json',
  'package-lock.json',
  'CHANGELOG.md',
  '.github/releases/',
  'THIRD-PARTY-NOTICES.md',
  // Documents its own matching rules using an example version.
  'scripts/verify-version-single-source.mjs',
  // Fixtures for the version comparator itself. The literals are inputs to
  // `isNewerVersion`, not references to this package's version: a case proving
  // 0.4.0 sorts below 0.4.1 has to name both, and stays true after a bump.
  // Scoped to this one file so the rule still binds everywhere else.
  'tests/updateCheck.test.ts',
  // The schema-versioning boundary. It names the release in which schema
  // versioning began — a fixed point in history, not the running version — and
  // is exported once and referenced everywhere that message is produced. Any
  // literal matching the *current* version elsewhere in server/ still fails.
  'server/db/schemaVersion.ts',
  // Fixtures for the release-state resolver and the version comparator. Their
  // literals are inputs to the function under test, not references to this
  // package's version: a case proving that a version already on npm under
  // different bytes hard-stops has to name some version, and a case proving
  // that a bump may only move forwards has to name both ends of it. They stay
  // true after a bump, and a bump must not turn a fixture into a release
  // blocker. Scoped to these two files so the rule still binds everywhere else,
  // including every other test.
  'tests/releaseState.test.ts',
  'tests/versionBump.test.ts',
  // Fixtures for the container tag rules and the release-notes splice, for the
  // same reason. A case proving that a prerelease must not take `latest`, or
  // that a repair must not drag the series backwards, has to name the versions
  // on both sides of the comparison; a case proving the notes carry the right
  // pull command has to name the version being published. None of them is a
  // reference to the version this package is on, and a bump must not turn a
  // fixture into a release blocker.
  'tests/containerTags.test.ts',
  'tests/containerNotes.test.ts',
  // Fixtures for the installer's release selection, for the same reason. The
  // literals are a fake GitHub releases feed handed to `selectRelease`: a case
  // proving the installer skips a newer stable release carrying no assets, and
  // one proving a prerelease is only chosen when asked for by name, both have
  // to name versions on either side of the comparison.
  //
  // Allowlisted before it bites rather than after. The fixtures use 0.6.0 and
  // 0.6.1, so the bump to either would have turned a passing test file into a
  // release blocker — and it would have surfaced as a failing check on the
  // release pull request, which is the worst moment to be reading a version
  // scanner.
  'tests/installer.test.ts',
]

/** Files excluded from scanning entirely: binary, generated, or dependency trees. */
const EXCLUDED_PATTERNS = [
  /^node_modules\//,
  /^dist\//,
  /^site\//,
  /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|pdf|zip|tgz)$/i,
]

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
if (!version) {
  console.error('FAIL: package.json has no version field.')
  process.exit(1)
}

const failures = []

// The lockfile carries the version twice: the top-level field and the root
// package entry. `npm version` updates both, a hand edit usually does not.
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const lockRootVersion = lock.packages?.['']?.version
if (lock.version !== version) {
  failures.push(`package-lock.json "version" is ${lock.version ?? '(missing)'}, expected ${version}.`)
}
if (lockRootVersion !== version) {
  failures.push(`package-lock.json packages[""].version is ${lockRootVersion ?? '(missing)'}, expected ${version}.`)
}

/**
 * The version immediately before the current one, taken from the changelog.
 *
 * This is the string a release bump leaves behind. Scanning only for the new
 * version proves nothing: it is correct by construction the moment it is
 * written, while the outgoing one is what actually goes stale.
 */
function findPreviousVersion() {
  const headings = [...readFileSync('CHANGELOG.md', 'utf8')
    .matchAll(/^##\s+(\d+\.\d+\.\d+(?:-[\w.]+)?)\s*\(/gm)]
    .map((match) => match[1])
  return headings.find((candidate) => candidate !== version) ?? null
}

function versionPattern(value) {
  // Word boundaries so 0.4.1 does not also match 10.4.1 or 0.4.10.
  return new RegExp(String.raw`(?<![\w.])v?${value.replace(/\./g, String.raw`\.`)}(?![\w.])`)
}

const previousVersion = findPreviousVersion()
const scans = [{ label: 'current', value: version, pattern: versionPattern(version) }]
if (previousVersion) {
  scans.push({ label: 'stale previous', value: previousVersion, pattern: versionPattern(previousVersion) })
}

const trackedFiles = run('git', ['ls-files']).split('\n').filter(Boolean)
const offenders = []

for (const file of trackedFiles) {
  if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(file))) continue
  if (ALLOWED_PATHS.some((allowed) => file === allowed || file.startsWith(allowed))) continue

  let contents
  try {
    contents = readFileSync(file, 'utf8')
  } catch {
    continue
  }

  for (const [index, line] of contents.split('\n').entries()) {
    for (const scan of scans) {
      if (scan.pattern.test(line)) {
        offenders.push(`${file}:${index + 1}: [${scan.label} ${scan.value}] ${line.trim()}`)
      }
    }
  }
}

console.log(
  `Checked ${trackedFiles.length} tracked files against version ${version}`
  + `${previousVersion ? ` (and stale ${previousVersion})` : ''}.`,
)

if (failures.length > 0) {
  console.error('\nFAIL: version fields are out of sync.\n')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('\nRun `npm install --package-lock-only` to resync the lockfile.')
}

if (offenders.length > 0) {
  console.error(`\nFAIL: ${offenders.length} hardcoded version reference(s) found.\n`)
  for (const offender of offenders) console.error(`  ${offender}`)
  console.error('\nDerive the version from package.json instead of writing it literally.')
  console.error('If this location must keep a literal version, add it to ALLOWED_PATHS')
  console.error('in scripts/verify-version-single-source.mjs with a reason.')
}

if (failures.length > 0 || offenders.length > 0) process.exit(1)

console.log('PASS: version fields agree and no hardcoded references remain.')
