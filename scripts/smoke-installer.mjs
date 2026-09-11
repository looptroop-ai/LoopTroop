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
import { execTool, launchTool, toolPath } from './tool-path.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = process.platform === 'win32'

function fail(message, ...detail) {
  process.stderr.write(`\nFAIL: ${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.stderr.write('\n')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const expectedVersion = manifest.version
const work = mkdtempSync(join(tmpdir(), 'looptroop-installer-smoke-'))

try {
  // npm is `npm.cmd` on Windows, so it starts through a resolved cmd.exe there,
  // with every argument escaped — the launcher the daemon uses.
  const pack = launchTool('npm', ['pack', '--pack-destination', work, '--silent'])
  const packed = spawnSync(pack.file, pack.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsVerbatimArguments: pack.windowsVerbatimArguments,
  })
  if (packed.status !== 0) fail('npm pack failed.', packed.stderr || String(packed.error))
  const tarball = join(work, packed.stdout.trim().split('\n').pop().trim())

  // A throwaway npm prefix, so a global install on a shared runner does not
  // outlive this script or collide with the other install smoke test.
  const prefix = join(work, 'prefix')
  mkdirSync(prefix, { recursive: true })

  // Both spellings keep the install isolated even when the runner exports the
  // uppercase one. On Windows, Node's npm.cmd redirects through this prefix;
  // prefer the original global npm shim before switching to the empty prefix.
  const installEnv = { ...process.env, npm_config_prefix: prefix, NPM_CONFIG_PREFIX: prefix }
  if (IS_WINDOWS) {
    const npmPrefix = execTool('npm', ['prefix', '-g']).trim()
    const path = process.env.PATH ?? process.env.Path ?? ''
    delete installEnv.Path
    installEnv.PATH = `${npmPrefix};${path}`
  }
  const isolatedNpm = execTool('npm', ['--version'], { env: installEnv }).trim()
  if (`npm@${isolatedNpm}` !== manifest.packageManager) {
    fail('The isolated installer would use a different npm version.',
      `Expected ${manifest.packageManager}; found npm@${isolatedNpm}.`)
  }

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
      env: installEnv,
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
    env: installEnv,
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

  const probe = launchTool(installed, ['--version'])
  const version = spawnSync(probe.file, probe.args, { encoding: 'utf8', windowsVerbatimArguments: probe.windowsVerbatimArguments })
  if (version.stdout.trim() !== expectedVersion) {
    fail(`The installed command reports ${version.stdout.trim() || '(nothing)'}, expected ${expectedVersion}.`)
  }

  process.stdout.write(`\nPASS: ${IS_WINDOWS ? 'install.ps1' : 'install.sh'} installed ${expectedVersion} on ${process.platform}.\n`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
