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

function fail(message: string, ...detail: string[]): never {
  process.stderr.write(`::error::${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.exit(1)
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

function flag(name: string, required = true): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) {
    if (required) fail(`--${name} is required.`)
    return null
  }
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value.`)
  return value
}

const version = flag('version')!
const manifestPath = resolve(flag('manifest')!)
const assetDir = resolve(flag('dir') ?? '.', '')
const notesPath = resolve(flag('notes')!)
const prerelease = process.argv.includes('--prerelease')
const tag = `v${version}`

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

/** `gh release view` on a tag that has no release exits non-zero. */
function releaseExists(): boolean {
  try {
    execFileSync('gh', ['release', 'view', tag, '--json', 'id'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
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

if (!releaseExists()) {
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
