#!/usr/bin/env node
/**
 * Reports where a release stands, as GitHub Actions job outputs.
 *
 *   npm run release:detect -- [--expected-integrity sha512-…] [--json]
 *
 * Asks git, the GitHub API and the npm registry what exists for the version in
 * package.json, hands the answers to the resolver in `release-state.ts`, and
 * writes the verdict to $GITHUB_OUTPUT. Every lookup tolerates absence: an
 * unpublished version, a missing tag and a missing Release are what a first
 * release looks like, not errors.
 *
 * `--expected-integrity` is optional because this runs *before* the build that
 * would produce it — it gates whether that build happens at all. Without it the
 * byte comparison is deferred to the npm job, which re-reads npm's own
 * dist.integrity after publishing and fails on a mismatch.
 *
 * Exits non-zero only for `conflict`, the states a release must stop on rather
 * than resume past.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Extensions are explicit because these scripts run under bare `node`, not tsx.
// Node executes TypeScript directly but does not resolve a missing extension.
import { distTagFor } from './version-bump.ts'
import { type ReleaseFacts, resolveReleaseState } from './release-state.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message: string): never {
  process.stderr.write(`FAIL: ${message}\n`)
  process.exit(1)
}

/** Runs a command, returning null instead of throwing when it fails. */
function tryRun(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32',
    }).trim()
  } catch {
    return null
  }
}

const args = process.argv.slice(2)
function flag(name: string): string | null {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? null : args[index + 1] ?? null
}

const expectedIntegrity = flag('expected-integrity')

const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
const manifestVersion: string = manifest.version
const packageName: string = manifest.name
const version = flag('version') ?? manifestVersion

const targetSha = tryRun('git', ['rev-parse', 'HEAD'])
if (!targetSha) fail('Could not resolve HEAD.')

/**
 * Whether this push is what changed the version.
 *
 * `HEAD^` is unreadable for the first commit and in a shallow checkout. Both
 * would otherwise read as "unchanged" and skip a legitimate release, so an
 * unreadable parent counts as a change and the remaining gates decide.
 */
function versionChangedInPush(): boolean {
  const previous = tryRun('git', ['show', 'HEAD^:package.json'])
  if (previous === null) return true
  try {
    return JSON.parse(previous).version !== manifestVersion
  } catch {
    return true
  }
}

// `^{}` dereferences an annotated tag to the commit it points at, so annotated
// and lightweight tags compare equal against the release commit.
const tagSha = tryRun('git', ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}^{}`])
  ?? tryRun('git', ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`])

let releaseExists = false
let releaseIsDraft = false
const releaseJson = tryRun('gh', ['release', 'view', `v${version}`, '--json', 'isDraft,tagName'])
if (releaseJson) {
  try {
    releaseExists = true
    releaseIsDraft = JSON.parse(releaseJson).isDraft === true
  } catch {
    fail(`gh returned unparseable JSON for release v${version}: ${releaseJson}`)
  }
}

// `npm view` exits non-zero for an unpublished version, which is the ordinary
// case for a first release, so absence is read from the null rather than
// trusted to a particular exit code.
const integrityRaw = tryRun('npm', ['view', `${packageName}@${version}`, 'dist.integrity', '--json'])
const npmIntegrity = integrityRaw ? integrityRaw.replace(/^"|"$/g, '') : null

let npmDistTags: Record<string, string> | null = null
const distTagsRaw = tryRun('npm', ['view', packageName, 'dist-tags', '--json'])
if (distTagsRaw) {
  try {
    npmDistTags = JSON.parse(distTagsRaw)
  } catch {
    npmDistTags = null
  }
}

const facts: ReleaseFacts = {
  version,
  manifestVersion,
  versionChangedInPush: versionChangedInPush(),
  targetSha,
  tagSha,
  releaseExists,
  releaseIsDraft,
  npmIntegrity,
  expectedIntegrity,
  expectedDistTag: distTagFor(version),
  npmDistTags,
}

const result = resolveReleaseState(facts)

if (args.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ facts, result }, null, 2)}\n`)
}

process.stdout.write([
  '',
  `version     ${version}`,
  `commit      ${targetSha}`,
  `tag         ${tagSha ?? '(none)'}`,
  `release     ${releaseExists ? (releaseIsDraft ? 'draft' : 'published') : '(none)'}`,
  `npm         ${npmIntegrity ?? '(unpublished)'}`,
  `expected    ${expectedIntegrity ?? '(deferred to the npm job)'}`,
  `dist-tag    ${facts.expectedDistTag} -> ${npmDistTags?.[facts.expectedDistTag] ?? '(unset)'}`,
  '',
  `state       ${result.state}`,
  result.reason,
  '',
].join('\n'))

const proceed = ['fresh', 'resume-npm', 'resume-github'].includes(result.state)
const needsNpm = result.state === 'fresh' || result.state === 'resume-npm'

// Booleans are emitted as the strings 'true'/'false' because that is what a
// workflow expression compares against: `if: needs.detect.outputs.x` is truthy
// for the *string* "false", so every consumer must compare explicitly.
const outputPath = process.env.GITHUB_OUTPUT
if (outputPath) {
  appendFileSync(outputPath, [
    `state=${result.state}`,
    `version=${version}`,
    `dist_tag=${facts.expectedDistTag}`,
    `target_sha=${targetSha}`,
    `proceed=${proceed ? 'true' : 'false'}`,
    `needs_npm=${needsNpm ? 'true' : 'false'}`,
    // Free-form prose, so it goes through the heredoc form rather than `k=v`.
    // A reason containing a newline would otherwise be parsed as the start of
    // another output, and one containing `=` would truncate.
    `reason<<RELEASE_DETECT_REASON`,
    result.reason,
    'RELEASE_DETECT_REASON',
    '',
  ].join('\n'))
}

if (result.state === 'conflict') {
  process.stderr.write(`::error::${result.reason}\n`)
  process.exit(1)
}
