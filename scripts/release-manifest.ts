#!/usr/bin/env node
/**
 * Records exactly which bytes a release is made of.
 *
 *   npm run release:manifest -- looptroop-0.5.0.tgz
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
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message: string): never {
  process.stderr.write(`FAIL: ${message}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
const positional = args.filter((value) => !value.startsWith('--'))
if (positional.length !== 1) {
  fail('Usage: npm run release:manifest -- <tarball.tgz> [--out release-manifest.json]')
}

const tarballPath = resolve(positional[0]!)
const outIndex = args.indexOf('--out')
const outPath = outIndex === -1
  ? resolve(repoRoot, 'release-manifest.json')
  : resolve(args[outIndex + 1] ?? fail('--out needs a path'))

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

process.stdout.write([
  `name        ${manifest.name}`,
  `version     ${manifest.version}`,
  `commit      ${commit ?? '(unknown)'}`,
  `tarball     ${manifest.tarball}`,
  `bytes       ${manifest.bytes}`,
  `sha256      ${sha256}`,
  `integrity   ${integrity}`,
  '',
  `Wrote ${outPath.slice(repoRoot.length + 1)}`,
  '',
].join('\n'))
