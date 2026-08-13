#!/usr/bin/env node
/**
 * Builds the Chocolatey package, bundle and all.
 *
 *   node scripts/build-choco.ts --bundle looptroop-9.9.9-bundle.tar.gz \
 *     --url https://…/looptroop-9.9.9-bundle.tar.gz --out dist-choco
 *
 * The archive travels inside the nupkg rather than being downloaded at install
 * time. That costs ~25 MB in the package and buys two things: an install that
 * needs nothing but the feed, and a repair that can redistribute the exact bytes
 * a release published without depending on a GitHub asset still being reachable.
 * Chocolatey's moderators expect a package carrying binaries to say where they
 * came from, which is what VERIFICATION.txt is for — and `--url` is recorded
 * there rather than fetched from.
 *
 * Windows only: `choco pack` needs the Chocolatey CLI, and every other release
 * job runs on ubuntu.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bundleFileName,
  renderChocolateyInstall,
  renderChocolateyUninstall,
  renderNuspec,
  renderVerification,
} from './package-manifests.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message: string, ...detail: string[]): never {
  process.stderr.write(`\nFAIL: ${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.stderr.write('\n')
  process.exit(1)
}

function flag(name: string, fallback: string | null = null): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? fallback : process.argv[index + 1]
  if (value === undefined || value === null || value.startsWith('--')) fail(`--${name} is required.`)
  return value
}

const bundlePath = resolve(flag('bundle'))
if (!existsSync(bundlePath)) fail(`No bundle at ${bundlePath}.`)

const outDir = resolve(flag('out', join(repoRoot, 'dist-choco')))
// Explicit, with the checkout only as a fallback. A repair of an older release
// runs from the default branch, whose package.json has moved on — reading the
// version from there would build a package claiming to be a version this bundle
// is not.
const version = flag('version', JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version as string)
const url = flag('url')
const sha256 = createHash('sha256').update(readFileSync(bundlePath)).digest('hex')

if (basename(bundlePath) !== bundleFileName(version)) {
  fail(
    `The bundle is named ${basename(bundlePath)}, but the package would be ${version}.`,
    `The install script looks for ${bundleFileName(version)} by name, so the two must agree.`,
  )
}

// The digest above is computed from whatever file was handed over, so on its own
// it only proves the package is self-consistent — a corrupt or substituted
// bundle would be hashed just as happily and shipped with a verification file
// that agrees with it perfectly.
//
// This is the check Homebrew gets for free from `brew audit --online`, which
// fetches the URL and compares. Chocolatey carries the bundle *inside* the
// package rather than fetching it, so nothing downstream ever compares these
// bytes against the release again: whatever goes in here is what users get, and
// this is the last point at which it can be checked at all.
//
// Optional, because the release workflow builds the bundle and packs it in one
// run with no download in between. A repair downloads it, and passes this.
const expected = process.argv.includes('--expect-sha256') ? flag('expect-sha256') : null
if (expected !== null && expected !== sha256) {
  fail(
    'The bundle does not match the checksum the release recorded for it.',
    `expected ${expected}`,
    `actual   ${sha256}`,
    'Packing this would embed bytes that release never published.',
  )
}

const inputs = { version, url, sha256 }
const stagingDir = join(outDir, 'package')
const toolsDir = join(stagingDir, 'tools')

rmSync(stagingDir, { recursive: true, force: true })
mkdirSync(toolsDir, { recursive: true })

writeFileSync(join(stagingDir, 'looptroop.nuspec'), renderNuspec(inputs))
writeFileSync(join(toolsDir, 'chocolateyInstall.ps1'), renderChocolateyInstall(version))
writeFileSync(join(toolsDir, 'chocolateyUninstall.ps1'), renderChocolateyUninstall())
writeFileSync(join(toolsDir, 'VERIFICATION.txt'), renderVerification(inputs))
// Required beside VERIFICATION.txt for any package shipping binaries, and a
// copy rather than a link so the package is readable offline.
copyFileSync(join(repoRoot, 'LICENSE'), join(toolsDir, 'LICENSE.txt'))
copyFileSync(bundlePath, join(toolsDir, bundleFileName(version)))

process.stdout.write(`Staged ${stagingDir}\n`)

try {
  execFileSync('choco', ['pack', join(stagingDir, 'looptroop.nuspec'), '--output-directory', outDir], {
    encoding: 'utf8',
    stdio: 'inherit',
    shell: true,
  })
} catch {
  fail('`choco pack` failed.', 'It needs the Chocolatey CLI, which exists only on the Windows runners.')
}

const nupkg = join(outDir, `looptroop.${version}.nupkg`)
if (!existsSync(nupkg)) fail(`choco pack reported success but produced no ${basename(nupkg)}.`)

const bytes = readFileSync(nupkg)
process.stdout.write([
  '',
  `nupkg       ${basename(nupkg)}`,
  `bytes       ${bytes.length}`,
  `sha256      ${createHash('sha256').update(bytes).digest('hex')}`,
  `bundle      ${sha256}`,
  '',
].join('\n'))
