#!/usr/bin/env node
/**
 * Installs the npm version this repository declares, and proves it took.
 * --prefer-bundled keeps an already reviewed npm major for the Node Current lane;
 * unsupported bundled versions warn and fall back to the declared version.
 *
 * `package.json` names an npm version in `packageManager` and `engines`, but a
 * runner ships whatever npm came bundled with its Node — ubuntu-24.04 images
 * carry 10.9.8 — so every `npm ci` in CI ran on a version the repository does
 * not claim to support. That is the resolver, the lockfile reader and the
 * workspace linker all differing from what a developer runs, which is precisely
 * the class of difference a lockfile exists to remove.
 *
 * Run before `npm ci`, so the install itself happens under the pinned version.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchTool } from './tool-path.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/**
 * npm on Windows is a .cmd shim, which only cmd.exe can run. The shared
 * launcher starts it through a resolved cmd.exe with the path and every
 * argument escaped — `C:\\Program Files\\nodejs\\npm.cmd` split at the space
 * when a shell was handed it unquoted.
 */
function npm(args) {
  const launch = launchTool('npm', args)
  const result = spawnSync(launch.file, launch.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  })
  if (result.error) fail(`npm ${args.join(' ')} could not be started: ${result.error.message}`)
  if (result.status !== 0) fail(`npm ${args.join(' ')} exited ${result.status ?? result.signal}.`)
  return result.stdout.trim()
}

const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))

// Single-sourced from packageManager: a version repeated in the workflow would
// be one more place to forget when it changes.
const declared = /^npm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? '')?.[1]
if (!declared) {
  fail(`package.json "packageManager" must name an exact npm version, not ${JSON.stringify(manifest.packageManager)}.`)
}

// Changing this major requires reviewing the lifecycle policy and its dismissals.
if (!declared.startsWith('12.')) fail('Review .github/security-alert-dispositions.md before changing the npm policy major.')

const current = npm(['--version'])
if (process.argv.includes('--check-policy')) {
  if (!/^12\.\d+\.\d+$/.test(current)) fail(`npm 12 is required for the reviewed install-script policy; found ${current}.`)
  process.stdout.write(`npm ${current} uses the reviewed install-script policy.\n`)
  process.exit(0)
}
if (process.argv.includes('--prefer-bundled')) {
  if (/^12\.\d+\.\d+$/.test(current)) {
    process.stdout.write(`Keeping bundled npm ${current}: its install-script policy is reviewed.\n`)
    process.exit(0)
  }
  process.stdout.write(`::warning::Bundled npm ${current} is outside the reviewed policy. Testing Node with approved npm ${declared} instead.\n`)
}
if (current === declared) {
  process.stdout.write(`npm ${current} already matches package.json.\n`)
  process.exit(0)
}

process.stdout.write(`npm ${current} is installed; package.json declares ${declared}. Installing it.\n`)
npm(['install', '--global', '--ignore-scripts', `npm@${declared}`])

// Asserted rather than assumed: a global install that lands outside PATH leaves
// the old npm in place and would otherwise pass silently.
const installed = npm(['--version'])
if (installed !== declared) {
  fail(`Expected npm ${declared} after installing it, but \`npm --version\` still reports ${installed}.`)
}

process.stdout.write(`npm ${installed} is active.\n`)
