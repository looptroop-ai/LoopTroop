#!/usr/bin/env node
/**
 * Installs the npm version this repository declares, and proves it took.
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
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shellCommandLine, toolPath } from './tool-path.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/**
 * npm on Windows is a .cmd shim, which needs a shell to be executable — and a
 * shell re-parses what it is given, so the resolved path and every argument go
 * to it as one quoted command line rather than as an array Node would join
 * unquoted. `C:\\Program Files\\nodejs\\npm.cmd` split at the space otherwise.
 */
function npm(args) {
  const program = toolPath('npm')
  const shell = process.platform === 'win32'
  return execFileSync(shell ? shellCommandLine(program, args) : program, shell ? [] : args, {
    encoding: 'utf8',
    shell,
  }).trim()
}

const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))

// Single-sourced from packageManager: a version repeated in the workflow would
// be one more place to forget when it changes.
const declared = /^npm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? '')?.[1]
if (!declared) {
  fail(`package.json "packageManager" must name an exact npm version, not ${JSON.stringify(manifest.packageManager)}.`)
}

const current = npm(['--version'])
if (current === declared) {
  process.stdout.write(`npm ${current} already matches package.json.\n`)
  process.exit(0)
}

process.stdout.write(`npm ${current} is installed; package.json declares ${declared}. Installing it.\n`)
npm(['install', '--global', `npm@${declared}`])

// Asserted rather than assumed: a global install that lands outside PATH leaves
// the old npm in place and would otherwise pass silently.
const installed = npm(['--version'])
if (installed !== declared) {
  fail(`Expected npm ${declared} after installing it, but \`npm --version\` still reports ${installed}.`)
}

process.stdout.write(`npm ${installed} is active.\n`)
