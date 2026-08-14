#!/usr/bin/env node
/**
 * Installs the Chocolatey package, drives it, and uninstalls it again.
 *
 *   node scripts/smoke-choco.ts --nupkg dist-choco/looptroop.9.9.9.nupkg
 *   node scripts/smoke-choco.ts --from-feed --version 9.9.9
 *
 * The two modes answer two different questions and both are needed.
 *
 * `--nupkg` installs the local file, never the community feed, and proves the
 * package before it is submitted — moderation is unbounded, and a package that
 * installs and then does not run is otherwise discovered by whoever installed
 * it.
 *
 * `--from-feed` installs what Chocolatey actually serves, and is the only check
 * that what moderation approved is what the release meant to publish. It cannot
 * run at release time, because at that point the package has not been reviewed
 * yet; `channel-republish.yml` runs it once moderation clears.
 *
 * Both modes make the same assertions, deliberately. A feed check that only
 * confirmed the version would pass for a package whose channel marker went
 * missing in packaging — and that package installs, runs, and tells every user
 * the wrong command to upgrade it with.
 *
 * The uninstall half is not a formality either. `Install-BinFile` writes a shim
 * into Chocolatey's `bin` directory, which survives the package directory being
 * deleted; an orphaned shim keeps answering `looptroop` with a path that no
 * longer exists, and nothing but this notices.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message: string, ...detail: string[]): never {
  process.stderr.write(`\nFAIL: ${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.stderr.write('\n')
  process.exit(1)
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

function flag(name: string, fallback: string | null = null): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? fallback : process.argv[index + 1]
  if (value === undefined || value === null || value.startsWith('--')) fail(`--${name} is required.`)
  return value
}

interface RunResult { status: number | null, stdout: string, stderr: string }

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv, allowFailure?: boolean } = {}): RunResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    shell: true,
  })
  const output = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  if (result.status !== 0 && options.allowFailure !== true) {
    fail(`${command} ${args.join(' ')} exited ${result.status}.`, output.stdout, output.stderr)
  }
  return output
}

if (process.platform !== 'win32') fail('Chocolatey exists only on Windows.')

const fromFeed = process.argv.includes('--from-feed')
const nupkg = fromFeed ? null : resolve(flag('nupkg'))
if (nupkg !== null && !existsSync(nupkg)) fail(`No package at ${nupkg}.`)

// Explicit for the same reason `build-choco.ts` takes it: a repair runs from a
// checkout whose package.json has moved past the release being repaired.
const version = flag('version', JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version as string)
const work = mkdtempSync(join(tmpdir(), 'looptroop-choco-'))
const configDir = join(work, 'config')
const childEnv = { LOOPTROOP_CONFIG_DIR: configDir, LOOPTROOP_OPENCODE_MODE: 'mock' }

/** Where `Install-BinFile` puts its shims. */
const chocoBin = join(process.env.ChocolateyInstall ?? 'C:\\ProgramData\\chocolatey', 'bin', 'looptroop.exe')

try {
  log(fromFeed
    ? `Installing looptroop ${version} from the community feed...`
    : `Installing ${nupkg} from the local directory...`)
  // `--ignore-dependencies`: Node, git and gh are real dependencies of the
  // package and the runner already has all three. Installing them here would
  // add minutes and prove nothing about this package.
  run('choco', [
    'install', 'looptroop', '--version', version,
    ...(nupkg === null ? [] : ['--source', `"${dirname(nupkg)}"`]),
    '--yes', '--no-progress', '--ignore-dependencies',
  ])

  if (!existsSync(chocoBin)) fail(`The package installed without producing a shim at ${chocoBin}.`)
  log(`  shim created at ${chocoBin}`)

  const reported = run(`"${chocoBin}"`, ['--version'], { env: childEnv }).stdout.trim()
  if (reported !== version) fail(`The installed command reports ${reported || '(nothing)'}, expected ${version}.`)
  log(`  runs, and reports ${version}`)

  // `--json`, so this reads the install check itself rather than searching the
  // whole report for two words that could co-occur in an unrelated remedy line.
  //
  // `doctor` exits non-zero on any failing check and a fresh machine has
  // plenty, so its status is not the assertion; the install check's detail is.
  const doctor = run(`"${chocoBin}"`, ['doctor', '--json'], { env: childEnv, allowFailure: true })
  const report = `${doctor.stdout}${doctor.stderr}`

  let checks: { name?: string, detail?: string }[]
  try {
    checks = JSON.parse(doctor.stdout).checks
  } catch {
    fail('`doctor --json` did not produce parseable JSON.', report.slice(0, 3000))
  }

  const install = checks.find((check) => check.name === 'install')
  if (install === undefined) fail('`doctor --json` reports no install check at all.', report.slice(0, 3000))

  // `${channel} (upgrade: ${command})`, so the channel is the first word.
  if (!/^chocolatey\b/.test(install.detail ?? '')) {
    fail(
      '`doctor` does not report this as a chocolatey install.',
      `It reports: ${install.detail ?? '(no detail)'}`,
      'That means the upgrade command shown to the user is the wrong one.',
    )
  }
  log(`  \`doctor\` reports the chocolatey channel: ${install.detail}`)

  log('Uninstalling...')
  run('choco', ['uninstall', 'looptroop', '--yes', '--no-progress'])

  if (existsSync(chocoBin)) {
    fail(
      `Uninstalling left a shim behind at ${chocoBin}.`,
      'It will keep answering `looptroop` with a path that no longer exists.',
    )
  }
  log('  shim removed')

  log(`\nPASS: ${fromFeed ? 'the community feed serves' : 'chocolatey installs'} ${version}, it runs, `
    + 'it knows which channel it came from, and uninstalling cleans up after itself.')
} finally {
  rmSync(work, { recursive: true, force: true })
}
