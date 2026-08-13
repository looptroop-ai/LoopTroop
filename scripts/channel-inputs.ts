#!/usr/bin/env node
/**
 * The three values every package channel needs, read out of the release manifest.
 *
 *   node scripts/channel-inputs.ts --manifest release-manifest.json --repo owner/name
 *
 * A formula, a Scoop manifest and a nuspec are each a rendering of `{version,
 * url, sha256}`, and all three of those are recorded by the release. Deriving
 * them here rather than in four workflow jobs means a repair months later
 * reproduces the same descriptor from the same source of truth — which is what
 * makes attaching the rendered files to the release unnecessary.
 *
 * The commit comes out too, because those three values pin the *inputs* to the
 * rendering and not the renderer. Checking it out is what stops a template
 * changed since the release from quietly altering what that release publishes.
 *
 * The URL is constructed rather than looked up. A published release asset lives
 * at a predictable address, and constructing it means this works before the
 * release exists as well as after — the audit step needs it either way.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReleaseManifest } from './release-assets.ts'
import { digestedAssets } from './release-assets.ts'

function fail(message: string, ...detail: string[]): never {
  process.stderr.write(`::error::${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.exit(1)
}

function flag(name: string, fallback: string | null = null): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? fallback : process.argv[index + 1]
  if (value === undefined || value === null || value.startsWith('--')) fail(`--${name} is required.`)
  return value
}

const manifestPath = resolve(flag('manifest', 'release-manifest.json'))
const repo = flag('repo', process.env.GITHUB_REPOSITORY ?? null)

let manifest: ReleaseManifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifest
} catch {
  fail(`Cannot read the release manifest at ${manifestPath}.`)
}

const assets = digestedAssets(manifest)
const bundle = Object.keys(assets).find((name) => name.endsWith('-bundle.tar.gz'))
if (bundle === undefined) {
  fail(
    `${manifestPath} records no bundle.`,
    'A release published before the managed channels existed carries only the npm tarball, and cannot be published to them.',
    `assets: ${Object.keys(assets).join(', ') || '(none)'}`,
  )
}

const output = {
  version: manifest.version,
  bundle,
  sha256: assets[bundle]!.sha256,
  url: `https://github.com/${repo}/releases/download/v${manifest.version}/${bundle}`,
  // The commit this release was built from, so a repair can render descriptors
  // with that release's templates rather than whatever the default branch says
  // today. Empty when the manifest predates the field or the release was built
  // outside a checkout; the caller decides what to do about that, because
  // "reproduce this exactly" and "do something reasonable" are different jobs.
  commit: manifest.commit ?? '',
}

const lines = Object.entries(output).map(([key, value]) => `${key}=${value}`)
// Straight into the step's outputs when there is one, so a workflow does not
// have to parse this back out of the log.
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
process.stdout.write(`${lines.join('\n')}\n`)
