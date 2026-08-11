#!/usr/bin/env node
/**
 * Writes one release version into every file that must agree on it.
 *
 *   npm run release:bump -- 0.5.0
 *   npm run release:bump -- 0.5.0-rc.1 --dry-run
 *
 * Four files, because `scripts/verify-version-single-source.mjs` is a required
 * check on the release pull request and reads all of them:
 *
 *   package.json          the single source of truth
 *   package-lock.json     both the top-level version and packages[""].version
 *   CHANGELOG.md          Unreleased becomes the release; a fresh one replaces it
 *   .github/releases/     the archived note, alongside 0.4.0.md and 0.4.1.md
 *
 * Every decision lives in `version-bump.ts`, which the tests drive directly.
 * This file only reads and writes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertForwardBump,
  bumpChangelog,
  bumpLockfile,
  bumpManifest,
  distTagFor,
  parseVersion,
} from './version-bump.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message: string): never {
  process.stderr.write(`FAIL: ${message}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const positional = args.filter((value) => !value.startsWith('--'))

if (positional.length !== 1) {
  fail('Usage: npm run release:bump -- <version> [--dry-run]')
}

const version = positional[0]!

const paths = {
  manifest: join(repoRoot, 'package.json'),
  lockfile: join(repoRoot, 'package-lock.json'),
  changelog: join(repoRoot, 'CHANGELOG.md'),
  // `.github/releases/`, not `releases/`: that is where the existing notes live
  // and the path `verify:version` allowlists.
  note: join(repoRoot, '.github', 'releases', `${version}.md`),
}

function plan() {
  parseVersion(version)

  const manifestBefore = readFileSync(paths.manifest, 'utf8')
  const current = JSON.parse(manifestBefore).version as string
  assertForwardBump(current, version)

  // UTC, so a release cut late in the evening is not dated tomorrow for some
  // reviewers and today for others.
  const date = new Date().toISOString().slice(0, 10)
  const changelog = bumpChangelog(readFileSync(paths.changelog, 'utf8'), version, date)

  return {
    current,
    date,
    files: [
      [paths.manifest, bumpManifest(manifestBefore, version)],
      [paths.lockfile, bumpLockfile(readFileSync(paths.lockfile, 'utf8'), version)],
      [paths.changelog, changelog.contents],
      [paths.note, changelog.releasedSection],
    ] as const,
  }
}

let resolved: ReturnType<typeof plan>
try {
  resolved = plan()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

const relative = (path: string) => path.slice(repoRoot.length + 1).split('\\').join('/')

process.stdout.write(
  `${resolved.current} -> ${version} (${resolved.date}), publishes under "${distTagFor(version)}"\n\n`,
)

for (const [path, contents] of resolved.files) {
  process.stdout.write(`  ${dryRun ? 'would write' : 'wrote'} ${relative(path)} (${contents.length} bytes)\n`)
  if (!dryRun) writeFileSync(path, contents)
}

process.stdout.write(
  dryRun
    ? '\nDry run: nothing was written.\n'
    : '\nNow run `npm run verify:version` to confirm the four files agree.\n',
)
