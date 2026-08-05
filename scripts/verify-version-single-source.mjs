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
  'docs/changelog.md',
  'CHANGELOG.md',
  '.github/releases/',
  'docs/roadmap.md',
  'THIRD-PARTY-NOTICES.md',
  // Documents its own matching rules using an example version.
  'scripts/verify-version-single-source.mjs',
]

/** Files excluded from scanning entirely: binary, generated, or dependency trees. */
const EXCLUDED_PATTERNS = [
  /^node_modules\//,
  /^dist\//,
  /^site\//,
  /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|pdf|zip|tgz)$/i,
  /^public\/web\.css$/,
]

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
if (!version) {
  console.error('FAIL: package.json has no version field.')
  process.exit(1)
}

// Word-boundary match so 0.4.1 does not also match 10.4.1 or 0.4.10.
const versionPattern = new RegExp(String.raw`(?<![\w.])v?${version.replace(/\./g, String.raw`\.`)}(?![\w.])`)

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
    if (versionPattern.test(line)) {
      offenders.push(`${file}:${index + 1}: ${line.trim()}`)
    }
  }
}

console.log(`Checked ${trackedFiles.length} tracked files against version ${version}.`)

if (offenders.length > 0) {
  console.error(`\nFAIL: ${offenders.length} hardcoded version reference(s) found.\n`)
  for (const offender of offenders) console.error(`  ${offender}`)
  console.error('\nDerive the version from package.json instead of writing it literally.')
  console.error('If this location must keep a literal version, add it to ALLOWED_PATHS')
  console.error('in scripts/verify-version-single-source.mjs with a reason.')
  process.exit(1)
}

console.log('PASS: no hardcoded version references outside allowlisted paths.')
