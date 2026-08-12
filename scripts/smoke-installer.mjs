#!/usr/bin/env node
/**
 * Runs the real installer wrapper the way a user would, against a local tarball.
 *
 *   node scripts/smoke-installer.mjs
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
  // Quoted only when a shell will parse it. On Unix there is no shell, so the
  // quotes would become part of the path and npm would write nowhere useful.
  const packDestination = IS_WINDOWS ? `"${work}"` : work
  const pack = spawnSync('npm', ['pack', '--pack-destination', packDestination, '--silent'], {
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

  const [command, args] = IS_WINDOWS
    ? ['pwsh', ['-NoProfile', '-File', join(repoRoot, 'install.ps1'), '-Tarball', tarball]]
    : ['sh', [join(repoRoot, 'install.sh'), '--tarball', tarball]]

  const install = spawnSync(command, args, {
    encoding: 'utf8',
    // Both spellings. npm reads either, and the macOS runners already export
    // the uppercase one — with both present it is unspecified which wins, which
    // is exactly how this passed on Linux and Windows and installed into the
    // runner's real global prefix on macOS.
    env: { ...process.env, npm_config_prefix: prefix, NPM_CONFIG_PREFIX: prefix },
  })
  process.stdout.write(install.stdout ?? '')
  if (install.status !== 0) {
    fail(`${command} ${args[args.length - 2]} exited ${install.status}.`, install.stderr || String(install.error))
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

  const version = spawnSync(IS_WINDOWS ? `"${installed}"` : installed, ['--version'], { encoding: 'utf8', shell: IS_WINDOWS })
  if (version.stdout.trim() !== expectedVersion) {
    fail(`The installed command reports ${version.stdout.trim() || '(nothing)'}, expected ${expectedVersion}.`)
  }

  process.stdout.write(`\nPASS: ${IS_WINDOWS ? 'install.ps1' : 'install.sh'} installed ${expectedVersion} on ${process.platform}.\n`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
