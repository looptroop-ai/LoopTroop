#!/usr/bin/env node
/**
 * Runs the real installer wrapper the way a user would, against a local tarball.
 *
 *   node scripts/smoke-installer.mjs
 *   node scripts/smoke-installer.mjs --shell powershell   # Windows PowerShell 5.1
 *
 * `install.sh` and `install.ps1` are what `looptroop.ovh/install` serves, and
 * they are the only two files in this repository that nothing else exercises:
 * the core they embed is unit-tested, but a broken heredoc, a missing `param`
 * block or a PowerShell here-string that swallowed its terminator would all pass
 * those tests and fail on a user's first command.
 *
 * `--tarball` rather than the network path: this proves the wrapper, and CI
 * hitting the GitHub API from every runner on every push is both slow and
 * rate-limited. The network path is proved once, against a real release.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shellCommandLine, toolPath } from './tool-path.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = process.platform === 'win32'

function fail(message, ...detail) {
  process.stderr.write(`\nFAIL: ${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.stderr.write('\n')
  process.exit(1)
}

const expectedVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
const work = mkdtempSync(join(tmpdir(), 'looptroop-installer-smoke-'))

try {
  // npm is `npm.cmd` on Windows, so it goes through the shell there — as one
  // command line with the program and every argument quoted by
  // `shellCommandLine`, rather than an array Node joins unquoted.
  const npm = toolPath('npm')
  const packArgs = ['pack', '--pack-destination', work, '--silent']
  const pack = spawnSync(IS_WINDOWS ? shellCommandLine(npm, packArgs) : npm, IS_WINDOWS ? [] : packArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: IS_WINDOWS,
  })
  if (pack.status !== 0) fail('npm pack failed.', pack.stderr || String(pack.error))
  const tarball = join(work, pack.stdout.trim().split('\n').pop().trim())

  // A throwaway npm prefix, so a global install on a shared runner does not
  // outlive this script or collide with the other install smoke test.
  const prefix = join(work, 'prefix')
  mkdirSync(prefix, { recursive: true })

  // `--shell powershell` runs the wrapper under Windows PowerShell 5.1 rather
  // than PowerShell 7. They are different runtimes, and 5.1 is the one preinstalled
  // on Windows — so it is what `irm https://www.looptroop.ovh/install.ps1 | iex`
  // lands in for a user who has never installed pwsh. Testing only pwsh left the
  // documented one-liner's actual runtime unproven.
  const shellArg = process.argv.indexOf('--shell')
  const windowsShell = shellArg === -1 ? 'pwsh' : process.argv[shellArg + 1]
  if (!['pwsh', 'powershell'].includes(windowsShell)) {
    fail(`Unknown --shell "${windowsShell}". Expected pwsh or powershell.`)
  }

  /** The wrapper this platform serves, invoked with the options it takes. */
  function wrapper(...options) {
    return IS_WINDOWS
      ? [toolPath(windowsShell), [
          '-NoProfile',
          // 5.1 defaults to a policy that refuses to run a script from a file;
          // pwsh accepts the flag too, so one argument list serves both.
          '-ExecutionPolicy', 'Bypass',
          '-File', join(repoRoot, 'install.ps1'),
          ...options,
        ]]
      : [toolPath('sh'), [join(repoRoot, 'install.sh'), ...options]]
  }

  /**
   * The two options `install.ps1` did not forward, checked before anything is
   * installed because both are meant to install nothing.
   *
   * On Windows this is the only place they run at all: the wrapper's `param`
   * block is PowerShell, so a test that reads the source can prove the
   * declaration exists and nothing else. They were absent for as long as both
   * wrappers have existed, and every check that could have noticed was reading
   * `install.sh`.
   */
  for (const [label, options, expected] of [
    ['help', IS_WINDOWS ? ['-Help'] : ['--help'], IS_WINDOWS ? 'install.ps1' : 'install.sh'],
    ['dry run', IS_WINDOWS ? ['-DryRun', '-Tarball', tarball] : ['--dry-run', '--tarball', tarball], 'would install'],
  ]) {
    const [probeCommand, probeArgs] = wrapper(...options)
    const probe = spawnSync(probeCommand, probeArgs, {
      encoding: 'utf8',
      env: { ...process.env, npm_config_prefix: prefix, NPM_CONFIG_PREFIX: prefix },
    })
    const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`

    if (probe.status !== 0) fail(`${label} exited ${probe.status}.`, output.trim())
    if (!output.includes(expected)) {
      fail(`${label} did not mention "${expected}".`, output.trim() || '(printed nothing)')
    }
    // Both are meant to stop before touching anything.
    if (readdirSync(prefix).length > 0) {
      fail(`${label} installed something.`, `prefix contains: ${readdirSync(prefix).join(', ')}`)
    }
    process.stdout.write(`  ok  ${label} is forwarded and installs nothing\n`)
  }

  const [command, args] = wrapper(...(IS_WINDOWS ? ['-Tarball', tarball] : ['--tarball', tarball]))

  const install = spawnSync(command, args, {
    encoding: 'utf8',
    // Both spellings. npm reads either, and the macOS runners already export
    // the uppercase one — with both present it is unspecified which wins, which
    // is exactly how this passed on Linux and Windows and installed into the
    // runner's real global prefix on macOS.
    env: { ...process.env, npm_config_prefix: prefix, NPM_CONFIG_PREFIX: prefix },
  })
  // Both streams, always. A wrapper that exits 0 having printed nothing is a
  // failure mode in its own right, and hiding stderr on the success path makes
  // it indistinguishable from a wrapper that worked.
  process.stdout.write(install.stdout ?? '')
  process.stderr.write(install.stderr ?? '')
  if (install.status !== 0) {
    fail(`${command} exited ${install.status}.`, String(install.error ?? ''))
  }
  if ((install.stdout ?? '').trim() === '') {
    fail(`${command} exited 0 without printing anything, which means it did not run the installer.`)
  }

  // npm puts the shim in `<prefix>/bin` on Unix and directly in `<prefix>` on
  // Windows, and either way the installer is only credible if the command it
  // just installed actually runs.
  const candidates = IS_WINDOWS
    ? [join(prefix, 'looptroop.cmd'), join(prefix, 'bin', 'looptroop.cmd')]
    : [join(prefix, 'bin', 'looptroop')]
  const installed = candidates.find((candidate) => existsSync(candidate))
  if (!installed) {
    fail(
      'The installer reported success but installed no `looptroop` command.',
      ...candidates.map((candidate) => `looked at ${candidate}`),
      `prefix contains: ${readdirSync(prefix).join(', ') || '(nothing)'}`,
    )
  }

  const version = spawnSync(IS_WINDOWS ? shellCommandLine(installed, ['--version']) : installed, IS_WINDOWS ? [] : ['--version'], { encoding: 'utf8', shell: IS_WINDOWS })
  if (version.stdout.trim() !== expectedVersion) {
    fail(`The installed command reports ${version.stdout.trim() || '(nothing)'}, expected ${expectedVersion}.`)
  }

  process.stdout.write(`\nPASS: ${IS_WINDOWS ? 'install.ps1' : 'install.sh'} installed ${expectedVersion} on ${process.platform}.\n`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
