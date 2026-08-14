#!/usr/bin/env node
/**
 * Records exactly which bytes a release is made of.
 *
 *   npm run release:manifest -- looptroop-9.9.9.tgz --asset dist-bundle/looptroop-9.9.9-bundle.tar.gz
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
 *
 * A release now carries more than the tarball: the bundle the managed package
 * channels install, and the two installer scripts. Each `--asset` is hashed the
 * same way and recorded in an `assets` map, while the tarball keeps its own
 * top-level fields exactly where they were. That is deliberate — `container-
 * build`, `container-republish`, `release-verify-artifact` and `draft-release`
 * all read the top-level shape, and manifests already published must keep
 * parsing, or repairing an older release stops working.
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

// Repeatable, and each value is a path, so the same by-position exclusion the
// `--out` value needs applies to every one of them.
const extraAssets: string[] = []
for (const [index, value] of args.entries()) {
  if (value !== '--asset') continue
  const path = args[index + 1]
  if (path === undefined || path.startsWith('--')) fail('--asset needs a path')
  extraAssets.push(resolve(path))
  consumed.add(index)
  consumed.add(index + 1)
}

const positional = args.filter((value, index) => !consumed.has(index) && !value.startsWith('--'))
if (positional.length !== 1) {
  fail('Usage: npm run release:manifest -- <tarball.tgz> [--asset <path>]... [--out release-manifest.json]')
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

function digest(path: string): { bytes: number, sha256: string } {
  let contents: Buffer
  try {
    contents = readFileSync(path)
  } catch {
    fail(`Cannot read the asset at ${path}.`)
  }
  if (contents.length === 0) fail(`${path} is empty.`)
  return { bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') }
}

const assets: Record<string, { bytes: number, sha256: string, integrity?: string }> = {
  [basename(tarballPath)]: { bytes: bytes.length, sha256, integrity },
}
for (const path of extraAssets) {
  const name = basename(path)
  if (name in assets) fail(`Two assets are both named ${name}; a release cannot attach either.`)
  assets[name] = digest(path)
}

/**
 * `checksums.sha256`, in the format `sha256sum -c` reads.
 *
 * Rendered from the assets above rather than by hashing the files a second
 * time. A release already has one authority on what it is made of, and a second
 * independent computation is a second thing that can disagree with it.
 *
 * It is written before it is recorded, and it lists neither itself nor the
 * manifest — so there is no file whose own hash has to appear inside it. That
 * is what lets it be an ordinary asset: recorded in `assets` like everything
 * else, and therefore uploaded, resumed, verified and protected against a
 * same-version rewrite by machinery that already exists, with no special case
 * anywhere.
 *
 * Two spaces between hash and name is not cosmetic: `sha256sum` reads one space
 * as text mode and two as binary, and a single space fails on Windows archives.
 */
const CHECKSUMS_ASSET = 'checksums.sha256'
const checksumsPath = resolve(dirname(outPath), CHECKSUMS_ASSET)
if (CHECKSUMS_ASSET in assets) fail(`An asset is already named ${CHECKSUMS_ASSET}.`)

const checksumLines = Object.entries(assets)
  .map(([name, entry]) => `${entry.sha256}  ${name}`)
  .sort()
writeFileSync(checksumsPath, `${checksumLines.join('\n')}\n`)
assets[CHECKSUMS_ASSET] = digest(checksumsPath)

const manifest = {
  name: manifestJson.name,
  version: manifestJson.version,
  commit,
  tarball: basename(tarballPath),
  bytes: bytes.length,
  sha256,
  integrity,
  // Travels with the release so an installer downloaded months earlier still
  // checks the floor of the release it is installing, not the one it shipped
  // with. Copied rather than referenced: the manifest is read on machines that
  // have no checkout.
  engines: manifestJson.engines,
  assets,
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
  'assets',
  ...Object.entries(assets).map(([name, entry]) => `  ${name}  ${entry.bytes} bytes  ${entry.sha256}`),
  '',
  `Wrote ${displayOut}`,
  '',
].join('\n'))
