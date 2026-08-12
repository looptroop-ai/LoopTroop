#!/usr/bin/env node
/**
 * Unpacks the release bundle and drives the CLI inside it.
 *
 *   node scripts/smoke-bundle.mjs --bundle dist-bundle/looptroop-9.9.9-bundle.tar.gz
 *
 * The bundle is resolved and archived once, on Linux, and then extracted by
 * Homebrew on macOS, by Scoop on Windows and by Chocolatey on Windows. The
 * portability gate in `build-bundle.mjs` proves no package *declares* itself
 * platform-specific; only running the thing proves it works. Without this, the
 * first machine ever to execute those `node_modules` on macOS is a user's.
 *
 * One node script rather than three shell steps, for the reason `smoke-install`
 * gives: `bash` steps are not portable on Windows, and a smoke test that
 * silently skips the platform most likely to break is not worth having.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = process.platform === 'win32'

function fail(message, ...detail) {
  process.stderr.write(`\nFAIL: ${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.stderr.write('\n')
  process.exit(1)
}

const bundleIndex = process.argv.indexOf('--bundle')
if (bundleIndex === -1) fail('Usage: node scripts/smoke-bundle.mjs --bundle <bundle.tar.gz>')
const bundlePath = resolve(process.argv[bundleIndex + 1] ?? fail('--bundle needs a path'))
if (!existsSync(bundlePath)) fail(`No bundle at ${bundlePath}.`)

const expectedVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
const work = mkdtempSync(join(tmpdir(), 'looptroop-bundle-smoke-'))

try {
  const unpacked = join(work, 'unpacked')
  mkdirSync(unpacked)

  // `tar` on all three: Windows has shipped bsdtar as tar.exe since 1803, and
  // extracting with the same tool everywhere is the point of a single archive.
  //
  // The archive is named by basename from its own directory, never by absolute
  // path. GNU tar — which is what a `shell: bash` step on Windows finds first,
  // from Git for Windows — reads `D:\a\...` as a remote host called `D` and
  // fails with "Cannot connect to D: resolve failed".
  const extract = spawnSync('tar', ['-xzf', basename(bundlePath), '-C', unpacked], {
    cwd: dirname(bundlePath),
    encoding: 'utf8',
  })
  if (extract.status !== 0) fail('Extracting the bundle failed.', extract.stderr || String(extract.error))

  const root = join(unpacked, 'looptroop')
  for (const required of ['package.json', 'node_modules', 'dist', 'bin']) {
    if (!existsSync(join(root, required))) fail(`The bundle has no ${required}.`)
  }

  // The wrapper the package channels shim, not `node dist/...`: an executable
  // that npm would have generated and this bundle has to generate itself is
  // exactly what could be missing.
  const wrapper = join(root, 'bin', IS_WINDOWS ? 'looptroop.cmd' : 'looptroop')
  if (!existsSync(wrapper)) fail(`The bundle has no ${IS_WINDOWS ? 'bin/looptroop.cmd' : 'bin/looptroop'}.`)

  // Quoted, and through a shell only on Windows: node cannot execute a `.cmd`
  // directly, and an unquoted path through `cmd.exe` breaks on the first space.
  const invoke = IS_WINDOWS ? `"${wrapper}"` : wrapper
  const version = spawnSync(invoke, ['--version'], { encoding: 'utf8', shell: IS_WINDOWS })
  if (version.status !== 0) {
    fail('The bundled launcher could not run.', version.stderr || String(version.error))
  }
  if (version.stdout.trim() !== expectedVersion) {
    fail(`The bundle reports ${version.stdout.trim()}, this checkout is ${expectedVersion}.`)
  }
  process.stdout.write(`Bundled launcher runs and reports ${expectedVersion}.\n`)

  // Into a throwaway configuration directory, and with OpenCode mocked: this is
  // proving the daemon's own machinery loads from an unpacked bundle, not that
  // the runner has OpenCode. `doctor` exits non-zero on any failing check, so
  // the exit code is not the assertion — producing a report is.
  const configDir = join(work, 'config')
  mkdirSync(configDir)
  const doctor = spawnSync(invoke, ['doctor'], {
    encoding: 'utf8',
    shell: IS_WINDOWS,
    env: { ...process.env, LOOPTROOP_CONFIG_DIR: configDir, LOOPTROOP_OPENCODE_MODE: 'mock' },
  })
  const report = `${doctor.stdout}${doctor.stderr}`
  if (!report.includes('install')) {
    fail('`doctor` produced no install check from the bundled install.', report.slice(0, 2000))
  }
  process.stdout.write('Bundled `doctor` runs and reports on the installation.\n')

  process.stdout.write(`\nPASS: the Linux-built bundle runs on ${process.platform}.\n`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
