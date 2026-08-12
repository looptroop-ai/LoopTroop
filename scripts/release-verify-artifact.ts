#!/usr/bin/env node
/**
 * Refuses a tarball whose bytes are not the ones the build produced.
 *
 *   npm run release:verify-artifact -- looptroop-9.9.9.tgz release-manifest.json
 *
 * Run at the top of every job that receives the tarball as an artifact, before
 * installing or publishing it. Comparing only after publishing would prove what
 * npm stored, not that the right bytes reached it — and by then the version is
 * immutable.
 *
 * Optionally `--registry-integrity <sha512-…>` to compare what npm reports for
 * an already-published version against the same manifest, and `--assets-dir
 * <dir>` to check every other asset the release carries — the bundle the
 * managed package channels install and the two installer scripts — against the
 * digests the same manifest records for them.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ReleaseManifest } from './release-assets.ts'
import { digestedAssets } from './release-assets.ts'

function fail(message: string): never {
  process.stderr.write(`::error::${message}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)

// Read before the positional filter, and its value excluded by position: an
// integrity string does not start with `--`, so filtering on that alone counted
// it as a third positional and the usage check rejected every invocation using
// the flag. Same trap as `--out` in release-manifest.ts.
const registryIndex = args.indexOf('--registry-integrity')
const registryIntegrity = registryIndex === -1 ? null : args[registryIndex + 1] ?? null
const consumed = new Set(registryIndex === -1 ? [] : [registryIndex, registryIndex + 1])

const assetsIndex = args.indexOf('--assets-dir')
const assetsDir = assetsIndex === -1 ? null : args[assetsIndex + 1] ?? null
if (assetsIndex !== -1) {
  if (assetsDir === null || assetsDir.startsWith('--')) fail('--assets-dir needs a path.')
  consumed.add(assetsIndex)
  consumed.add(assetsIndex + 1)
}

const positional = args.filter((value, index) => !consumed.has(index) && !value.startsWith('--'))
if (positional.length !== 2) {
  fail('Usage: npm run release:verify-artifact -- <tarball.tgz> <release-manifest.json> [--registry-integrity sha512-…] [--assets-dir <dir>]')
}

const [tarballArg, manifestArg] = positional as [string, string]
const tarballPath = resolve(tarballArg)
const manifestPath = resolve(manifestArg)

let manifest: ReleaseManifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifest
} catch {
  fail(`Cannot read the release manifest at ${manifestPath}.`)
}

let bytes: Buffer
try {
  bytes = readFileSync(tarballPath)
} catch {
  fail(`Cannot read the tarball at ${tarballPath}.`)
}

const sha256 = createHash('sha256').update(bytes).digest('hex')
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`

const failures: string[] = []

if (bytes.length !== manifest.bytes) {
  failures.push(`size is ${bytes.length} bytes, the manifest records ${manifest.bytes}`)
}
if (sha256 !== manifest.sha256) {
  failures.push(`sha256 is ${sha256}, the manifest records ${manifest.sha256}`)
}
if (integrity !== manifest.integrity) {
  failures.push(`integrity is ${integrity}, the manifest records ${manifest.integrity}`)
}

// npm's own value for a published version. Compared against the manifest rather
// than against a freshly computed digest, so this also catches a manifest that
// travelled with the wrong tarball.
if (registryIntegrity !== null && registryIntegrity !== manifest.integrity) {
  failures.push(`the registry reports ${registryIntegrity}, the manifest records ${manifest.integrity}`)
}

// Every other asset the release carries, from the same manifest. The tarball is
// the one npm consumes and so gets the checks above; these are the ones a
// package channel installs, and a bundle that travelled with the wrong manifest
// would otherwise be caught only by whoever installed it.
const otherAssets: string[] = []
if (assetsDir !== null) {
  for (const [name, expected] of Object.entries(digestedAssets(manifest))) {
    if (name === manifest.tarball) continue

    let contents: Buffer
    try {
      contents = readFileSync(join(resolve(assetsDir), name))
    } catch {
      failures.push(`${name} is recorded in the manifest but missing from ${assetsDir}`)
      continue
    }

    const assetSha = createHash('sha256').update(contents).digest('hex')
    if (contents.length !== expected.bytes) {
      failures.push(`${name} is ${contents.length} bytes, the manifest records ${expected.bytes}`)
    }
    if (assetSha !== expected.sha256) {
      failures.push(`${name} has sha256 ${assetSha}, the manifest records ${expected.sha256}`)
    }
    otherAssets.push(`  ${name.padEnd(34)} ${assetSha}`)
  }
}

if (failures.length > 0) {
  process.stderr.write(`\nFAIL: ${manifest.tarball} is not the artifact this release built.\n\n`)
  for (const failure of failures) process.stderr.write(`  ${failure}\n`)
  process.stderr.write('\nDo not publish it. Re-run the build job and investigate the difference.\n')
  process.exit(1)
}

process.stdout.write([
  `PASS: ${manifest.tarball} matches the release manifest.`,
  `  version     ${manifest.version}`,
  `  bytes       ${bytes.length}`,
  `  sha256      ${sha256}`,
  `  integrity   ${integrity}`,
  registryIntegrity === null ? '' : `  registry    ${registryIntegrity} (matches)`,
  ...(otherAssets.length === 0 ? [] : ['  and every other asset this release carries:', ...otherAssets]),
  '',
].filter(Boolean).join('\n'))
