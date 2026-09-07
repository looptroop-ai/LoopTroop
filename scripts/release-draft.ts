#!/usr/bin/env node
/**
 * Creates or resumes the draft GitHub release, carrying exactly this build's assets.
 *
 *   node scripts/release-draft.ts --version 9.9.9 --manifest release-manifest.json \
 *     --dir . --notes /tmp/notes.md [--prerelease]
 *
 * A release used to be two files and this was a page of shell that named both
 * of them. It now carries the bundle the managed package channels install and
 * the two installer scripts, and a set that changes between versions is not
 * something to reconcile by hand in bash: the decisions live in
 * `release-assets.ts`, where they are tested, and this drives `gh` around them.
 *
 * Deliberately no `npm ci` in the job that runs this. It holds `contents:
 * write`, and installing a dev tree there would run third-party install scripts
 * in the one job that can create releases and push tags.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AssetDigest, ReleaseManifest } from './release-assets.ts'
import { digestedAssets, manifestDifferences, MANIFEST_ASSET, planDraftAssets, requiredAssets } from './release-assets.ts'
import { isGhNotFound } from './release-state.ts'
import { ArgumentError, parseArgs, requireNoPositional } from './cli-args.ts'
import { resolveTrustedTool } from './trusted-tool.ts'

function fail(message: string, ...detail: string[]): never {
  process.stderr.write(`::error::${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.exit(1)
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

const USAGE = 'Usage: node scripts/release-draft.ts --version X.Y.Z --manifest <path> --dir <dir> --notes <path> [--prerelease]'

// An unknown flag used to be ignored, so a typo in the workflow that invokes
// this ran with the default behaviour and reported success.
const args = (() => {
  try {
    const parsed = parseArgs(process.argv.slice(2), {
      version: 'value',
      manifest: 'value',
      dir: 'value',
      notes: 'value',
      prerelease: 'switch',
    })
    // This script takes options only, and it holds `contents: write`. A stray
    // bare token was collected and never read, so a malformed invocation still
    // created or edited a release.
    requireNoPositional(parsed)
    return parsed
  } catch (error) {
    if (!(error instanceof ArgumentError)) throw error
    fail(error.message, USAGE)
  }
})()

function requiredFlag(name: string): string {
  const value = args.value(name)
  if (value === null) fail(`--${name} is required.`, USAGE)
  return value
}

const version = requiredFlag('version')
const manifestPath = resolve(requiredFlag('manifest'))
const assetDir = resolve(requiredFlag('dir'), '')
const notesPath = resolve(requiredFlag('notes'))
const prerelease = args.switch('prerelease')
const tag = `v${version}`

/**
 * `gh`, resolved once from a directory the runner owns.
 *
 * Naming the tool and letting the operating system search `PATH` lets the first
 * matching directory decide which program receives `contents: write` and the
 * arguments that create, edit and upload to a release. Resolved and checked
 * before the first call so a wrong answer is a refusal rather than a release.
 */
const ghPath = (() => {
  const resolved = resolveTrustedTool('gh')
  if ('refusal' in resolved) fail('Cannot run gh safely.', resolved.refusal)
  return resolved.path
})()

function gh(args: string[]): string {
  return execFileSync(ghPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

/**
 * Whether there is a draft for this tag to resume.
 *
 * Three answers, and the previous version had two. It wrapped `gh release view`
 * in a `try`/`catch` and read *every* failure as "no release", so an expired
 * token, a rate limit or a GitHub outage entered the create path — and if the
 * release did exist, the script went on to edit it, and could upload over it
 * with `--clobber`, without ever having established that it was still a draft.
 * Clobbering a published release replaces bytes somebody may already have
 * downloaded.
 *
 * So: only a confirmed 404 is absence, and the state is read from `isDraft`
 * rather than inferred from the lookup having succeeded.
 */
function draftState(): 'absent' | 'draft' {
  let output: string
  try {
    output = execFileSync(ghPath, ['release', 'view', tag, '--json', 'isDraft'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr
    const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : (stderr ?? '')
    if (isGhNotFound(text)) return 'absent'
    fail(
      `Could not look up the release for ${tag}, and the reason is not that it is absent.`,
      text.trim() || String(error),
      'Nothing was created, edited or uploaded.',
    )
  }

  let parsed: { isDraft?: unknown }
  try {
    parsed = JSON.parse(output) as { isDraft?: unknown }
  } catch {
    fail(`gh returned unparseable JSON for ${tag}: ${output.trim()}`)
  }

  if (parsed.isDraft === true) return 'draft'
  fail(
    `${tag} is already published, so this run has nothing to draft.`,
    'Editing its notes or re-uploading its assets would change a release people can already install.',
    'Release a new version instead.',
  )
}

function digestOf(path: string): AssetDigest {
  const bytes = readFileSync(path)
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

let manifest: ReleaseManifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifest
} catch {
  fail(`Cannot read the release manifest at ${manifestPath}.`)
}

// The artefact is bound to the commit it was built from, and the tag this
// release eventually carries must name that same commit. They are equal by
// construction — every job checks out GITHUB_SHA — so a difference means an
// artefact from somewhere else.
const sha = process.env.GITHUB_SHA ?? ''
if (manifest.commit !== sha) {
  fail(`The artefact was built from '${manifest.commit ?? '(unknown)'}', but this release is cut from ${sha}.`)
}

const required = requiredAssets(manifest)
const localFiles = new Map(required.map((name) => [name, join(assetDir, name)]))

// Everything about to be uploaded, checked against the manifest being uploaded
// with it. A manifest that travelled with the wrong bundle would otherwise be
// published as the record of what this release is.
for (const [name, path] of localFiles) {
  if (name === MANIFEST_ASSET) continue
  const expected = digestedAssets(manifest)[name]!
  let found: AssetDigest
  try {
    found = digestOf(path)
  } catch {
    fail(`${name} is missing from ${assetDir}, and the manifest says this release carries it.`)
  }
  if (found.bytes !== expected.bytes || found.sha256 !== expected.sha256) {
    fail(
      `${name} does not match the manifest built alongside it.`,
      `on disk    ${found.bytes} bytes, sha256 ${found.sha256}`,
      `manifest   ${expected.bytes} bytes, sha256 ${expected.sha256}`,
    )
  }
}
log(`Verified ${required.length} local asset(s) against ${MANIFEST_ASSET}.`)

const uploadArgs = required.map((name) => localFiles.get(name)!)

if (draftState() === 'absent') {
  gh([
    'release', 'create', tag,
    '--draft',
    '--title', tag,
    '--notes-file', notesPath,
    '--target', manifest.commit!,
    ...(prerelease ? ['--prerelease'] : []),
    ...uploadArgs,
  ])
  log(`Created the draft for ${tag} with ${required.length} asset(s).`)
  process.exit(0)
}

log(`Draft for ${tag} already exists; updating it.`)
gh(['release', 'edit', tag, '--notes-file', notesPath, ...(prerelease ? ['--prerelease'] : [])])

const view = JSON.parse(gh(['release', 'view', tag, '--json', 'assets'])) as { assets?: { name: string }[] }
const present = (view.assets ?? []).map((asset) => asset.name)

// Missing anything at all means re-upload everything, so nothing is decided
// from a partial upload. Only when the set looks complete are the bytes read
// back and compared, because leaving them alone is the only outcome that
// depends on what they contain.
let attached: Record<string, AssetDigest> = {}

if (required.every((name) => present.includes(name))) {
  const scratch = mkdtempSync(join(tmpdir(), 'looptroop-draft-'))
  try {
    gh(['release', 'download', tag, ...required.flatMap((name) => ['--pattern', name]), '--dir', scratch, '--clobber'])
    attached = Object.fromEntries(
      Object.keys(digestedAssets(manifest)).map((name) => [name, digestOf(join(scratch, name))]),
    )

    // The drafted manifest against this build's, field by field: two files can
    // agree on every hash and still be manifests for different releases.
    const drafted = JSON.parse(readFileSync(join(scratch, MANIFEST_ASSET), 'utf8')) as ReleaseManifest
    const differences = manifestDifferences(manifest, drafted)
    if (differences.length > 0) {
      fail(
        'The drafted manifest is not the one this build produced.',
        ...differences,
        'A rebuild of the same tree is byte-identical, so the tree changed. Release a new version.',
      )
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const plan = planDraftAssets(manifest, present, attached)

switch (plan.action) {
  case 'leave':
    log('Every drafted asset matches this build; leaving them alone.')
    break
  case 'upload':
    log(`Draft assets are incomplete (missing: ${plan.missing.join(', ')}); uploading all of them.`)
    gh(['release', 'upload', tag, ...uploadArgs, '--clobber'])
    break
  case 'stop':
    fail(
      'The draft carries different bytes under this version.',
      ...plan.problems,
      'Clobbering would replace an artefact somebody may already have downloaded. Release a new version.',
    )
}
