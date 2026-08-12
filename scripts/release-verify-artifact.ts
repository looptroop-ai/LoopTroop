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
 * an already-published version against the same manifest.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

const positional = args.filter((value, index) => !consumed.has(index) && !value.startsWith('--'))
if (positional.length !== 2) {
  fail('Usage: npm run release:verify-artifact -- <tarball.tgz> <release-manifest.json> [--registry-integrity sha512-…]')
}

const [tarballArg, manifestArg] = positional as [string, string]
const tarballPath = resolve(tarballArg)
const manifestPath = resolve(manifestArg)

let manifest: { version: string, tarball: string, bytes: number, sha256: string, integrity: string }
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
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
  '',
].filter(Boolean).join('\n'))
