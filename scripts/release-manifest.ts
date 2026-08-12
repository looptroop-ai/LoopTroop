#!/usr/bin/env node
/**
 * Records exactly which bytes a release is made of.
 *
 *   npm run release:manifest -- looptroop-9.9.9.tgz
 *
 * The tarball is packed once and then travels between jobs, machines and
 * platforms as an artifact. Every job that consumes it recomputes these hashes
 * and refuses to continue if they differ, so a truncated download or a
 * substituted artifact fails before it can be published rather than after.
 *
 * Both hashes, because they answer different questions. `integrity` is what npm
 * itself stores and is what the post-publish check compares against, so it must
 * be produced the way npm produces it: base64 SRI, not hex. `sha256` is what a
 * human can verify from a checksum file with the tool already on their machine.
 * npm's `dist.shasum` is neither — it is SHA-1 — so nothing here is ever
 * compared against it.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message: string): never {
  process.stderr.write(`FAIL: ${message}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)

// `--out` takes a value, and that value is a path, so it does not start with
// `--`. A plain "not a flag" filter therefore counted it as a second positional
// and the usage check rejected every invocation that used the flag this script
// documents. The flag's value is excluded by position instead.
const outIndex = args.indexOf('--out')
const outPath = outIndex === -1
  ? resolve(repoRoot, 'release-manifest.json')
  : resolve(args[outIndex + 1] ?? fail('--out needs a path'))
const consumed = new Set(outIndex === -1 ? [] : [outIndex, outIndex + 1])

const positional = args.filter((value, index) => !consumed.has(index) && !value.startsWith('--'))
if (positional.length !== 1) {
  fail('Usage: npm run release:manifest -- <tarball.tgz> [--out release-manifest.json]')
}

const tarballPath = resolve(positional[0]!)

let bytes: Buffer
try {
  bytes = readFileSync(tarballPath)
} catch {
  fail(`Cannot read ${tarballPath}. Run \`npm pack\` first.`)
}

if (statSync(tarballPath).size === 0) {
  fail(`${tarballPath} is empty.`)
}

const manifestJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))

const sha256 = createHash('sha256').update(bytes).digest('hex')
// Base64 SRI, matching npm's own `dist.integrity`. A hex digest would compare
// unequal against every published package no matter how correct the bytes are.
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`

const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
})()

const manifest = {
  name: manifestJson.name,
  version: manifestJson.version,
  commit,
  tarball: basename(tarballPath),
  bytes: bytes.length,
  sha256,
  integrity,
}

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)

// Shortened for the log only while the path is genuinely inside the repository.
// Slicing the root's length off any absolute path mangles one that is not:
// `--out /tmp/staging/release-manifest.json` printed as `release-manifest.json`,
// naming a file in the checkout that this run never wrote. Harmless while `--out`
// was unusable; reachable now that it works.
const relativeOut = relative(repoRoot, outPath)
const displayOut = relativeOut === '' || relativeOut.startsWith('..') || isAbsolute(relativeOut)
  ? outPath
  : relativeOut

process.stdout.write([
  `name        ${manifest.name}`,
  `version     ${manifest.version}`,
  `commit      ${commit ?? '(unknown)'}`,
  `tarball     ${manifest.tarball}`,
  `bytes       ${manifest.bytes}`,
  `sha256      ${sha256}`,
  `integrity   ${integrity}`,
  '',
  `Wrote ${displayOut}`,
  '',
].join('\n'))
