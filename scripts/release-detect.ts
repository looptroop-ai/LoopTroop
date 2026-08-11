#!/usr/bin/env node
/**
 * Reports where a release stands, as GitHub Actions job outputs.
 *
 *   npm run release:detect -- [--expected-integrity sha512-…] [--baseline <sha|auto>] [--json]
 *
 * Asks git, the GitHub API and the npm registry what exists for the version in
 * package.json, hands the answers to the resolver in `release-state.ts`, and
 * writes the verdict to $GITHUB_OUTPUT.
 *
 * `--expected-integrity` is optional because this runs *before* the build that
 * would produce it — it gates whether that build happens at all. Without it the
 * byte comparison is deferred to the npm job, which re-reads npm's own
 * dist.integrity after publishing and fails on a mismatch.
 *
 * `--baseline` is which commit's package.json decides whether *this* push is
 * what changed the version. The workflow passes `github.event.before` — the
 * exact pre-push SHA — so a multi-commit push whose bump is not the final
 * commit still releases. Manual dispatch has no push boundary: the workflow
 * passes `auto`, which forces the "changed" lane and lets the remaining gates
 * decide, so a dry run always exercises the build and verification.
 *
 * Only a *genuine* absence is tolerated — an unpublished version, a missing tag,
 * a missing Release. A lookup that fails for any other reason (registry outage,
 * authentication, rate limiting) stops the run as unknown instead of reading as
 * "nothing exists yet", because mistaking an outage for a first release is how
 * a release gets published twice.
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

/**
 * Runs a command, returning null only for a *genuine* absence.
 *
 * `npm view` exits non-zero both for "not found" and for a registry outage,
 * so absence is read from the command's own exit code: 0 means the entity
 * exists, `npm`'s E404 / `gh`'s HTTP 404 mean it does not, and any other
 * failure is an unknown state that must stop detection rather than be read
 * as "absent".
 */
function runLookup(command: string, args: string[]): string | null {
  const result = execFileSync(command, args, {
    encoding: 'utf8',
    // stderr is captured, not discarded. Absence is read *from* stderr — E404
    // for npm, HTTP 404 for gh — so ignoring it would leave every failure
    // looking identical and turn every unpublished version into a hard stop.
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  return result.trim()
}

/** What `npm` prints when the requested version does not exist. */
function isNpm404(stderr: string): boolean {
  return /E404|404 Not Found/.test(stderr)
}

/** What `gh` prints when the requested release does not exist. */
function isGh404(stderr: string): boolean {
  return stderr.includes('not found') || /HTTP 404/.test(stderr)
}

function runOrAbsent(
  command: string,
  args: string[],
  is404: (stderr: string) => boolean,
  what: string,
): string | null {
  try {
    return runLookup(command, args)
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr
    const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : (stderr ?? '')
    if (is404(text)) return null
    fail(`Could not query ${what} (${command} ${args.join(' ')}): ${text.trim() || error}`)
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

const targetSha = runLookup('git', ['rev-parse', 'HEAD'])
if (!targetSha) fail('Could not resolve HEAD.')

/**
 * Whether this push is what changed the version.
 *
 * The baseline is the exact pre-push SHA from `github.event.before`; `HEAD^`
 * is wrong for a rebase merge or a multi-commit push whose bump is not the
 * final commit. A baseline that is not an ancestor (a force-push history, a
 * dispatch with no push boundary) counts as a change and the remaining gates
 * decide, because the version being absent from the known history is not the
 * same as "unchanged".
 */
function versionChangedInPush(baseline: string | null): boolean {
  if (baseline === null || baseline === 'auto') return true

  // Unreadable for any reason — the object is gone after a force-push, the ref
  // is the all-zero SHA of a branch's first push, the file did not exist yet —
  // counts as a change. This is the one lookup that deliberately fails towards
  // "proceed" rather than stopping: it only chooses which lane to enter, and
  // every gate that can do damage (tag mismatch, integrity mismatch, wrong
  // dist-tag) is evaluated after it and stops the run on its own.
  let previous: string | null
  try {
    previous = runLookup('git', ['show', `${baseline}:package.json`])
  } catch {
    return true
  }
  if (previous === null) return true

  try {
    return JSON.parse(previous).version !== manifestVersion
  } catch {
    return true
  }
}

// `^{}` dereferences an annotated tag to the commit it points at, so annotated
// and lightweight tags compare equal against the release commit.
//
// `--quiet` makes a missing ref exit 1 with no stderr, which is the one case
// that means "no tag". Anything that does print to stderr is a real git
// failure — a corrupt object store, an unreadable ref — and stops detection.
const tagSha = readTag(`refs/tags/v${version}^{}`) ?? readTag(`refs/tags/v${version}`)

function readTag(ref: string): string | null {
  return runOrAbsent(
    'git',
    ['rev-parse', '--verify', '--quiet', ref],
    (stderr) => stderr.trim() === '',
    `tag ${ref}`,
  ) || null
}

let releaseExists = false
let releaseIsDraft = false
const releaseJson = runOrAbsent(
  'gh',
  ['release', 'view', `v${version}`, '--json', 'isDraft,tagName'],
  isGh404,
  `release v${version}`,
)
if (releaseJson) {
  try {
    releaseExists = true
    releaseIsDraft = JSON.parse(releaseJson).isDraft === true
  } catch {
    fail(`gh returned unparseable JSON for release v${version}: ${releaseJson}`)
  }
}

// `npm view` exits non-zero for an unpublished version, which is the ordinary
// case for a first release, so absence is read from the command's own E404
// rather than from any non-zero exit.
const integrityRaw = runOrAbsent(
  'npm',
  ['view', `${packageName}@${version}`, 'dist.integrity', '--json'],
  isNpm404,
  `npm version ${version}`,
)
const npmIntegrity = integrityRaw ? integrityRaw.replace(/^"|"$/g, '') : null

let npmDistTags: Record<string, string> | null = null
const distTagsRaw = runOrAbsent(
  'npm',
  ['view', packageName, 'dist-tags', '--json'],
  isNpm404,
  `npm dist-tags for ${packageName}`,
)
if (distTagsRaw) {
  try {
    npmDistTags = JSON.parse(distTagsRaw)
  } catch {
    npmDistTags = null
  }
}

// The workflow passes the exact pre-push SHA; anything else forces the
// "changed" lane so the remaining gates decide.
const baseline = flag('baseline') ?? 'auto'

const facts: ReleaseFacts = {
  version,
  manifestVersion,
  versionChangedInPush: versionChangedInPush(baseline === 'auto' ? null : baseline),
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
  `baseline    ${baseline === 'auto' ? '(auto: forced change)' : baseline}`,
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
