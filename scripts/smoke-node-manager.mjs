#!/usr/bin/env node
/**
 * Installs the packed tarball globally with bun or pnpm, and proves the result
 * knows what it is.
 *
 *   node scripts/smoke-node-manager.mjs bun
 *   node scripts/smoke-node-manager.mjs pnpm
 *
 * The roadmap has claimed since the beginning that `bun add -g` and
 * `pnpm add -g` work natively, and nothing had ever run either. They do — but
 * both installations reported themselves as `npm` and were told to upgrade with
 * `npm install -g`, which does not upgrade either of them: it installs a second
 * copy under npm's prefix and leaves the first one where it was, after which
 * PATH order decides which one answers. That is the Homebrew-upgrade bug in a
 * different manager, and it is what this smoke exists to keep fixed.
 *
 * So the assertion is not "a channel line was printed". It is that `doctor`
 * names *this* manager and offers *its* upgrade command — the weaker assertion
 * passes on exactly the bug being ruled out.
 *
 * The tarball is installed from a local path rather than from the registry.
 * That tests the artifact this commit produces rather than the last published
 * one, and it sidesteps pnpm's release-age window (see below), which would
 * otherwise make the result depend on what day it is.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'
const MANAGER = process.argv[2]

if (MANAGER !== 'bun' && MANAGER !== 'pnpm' && MANAGER !== 'yarn') {
  process.stderr.write('Usage: node scripts/smoke-node-manager.mjs <bun|pnpm|yarn>\n')
  process.exit(1)
}

const failures = []
let step = 0

function heading(text) {
  step += 1
  process.stdout.write(`\n${step}. ${text}\n`)
}

function check(ok, message) {
  process.stdout.write(`  ${ok ? 'ok' : 'FAIL'}  ${message}\n`)
  if (!ok) failures.push(message)
  return ok
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: IS_WINDOWS,
    ...options,
    env: { ...process.env, ...options.env },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

const repoRoot = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
const home = mkdtempSync(join(tmpdir(), `looptroop-${MANAGER}-`))
/** Nothing here to resolve against, so a path taken from the cwd finds nothing. */
const empty = mkdtempSync(join(tmpdir(), 'looptroop-empty-'))

/**
 * Where each manager puts a global install, and how to point it somewhere
 * disposable. Neither may write to the runner's real home: a smoke that leaves
 * a global install behind changes the machine every later job runs on.
 *
 * pnpm refuses to install globally at all when its global bin directory is not
 * on PATH — `pnpm setup` is the documented fix, and setting the variable and
 * the PATH is what that does.
 */
const binDir = join(home, 'bin')

/**
 * Yarn Classic keeps its global tree under `<something>/yarn/global`, and that
 * directory name is the only thing separating it from an npm install — so the
 * disposable folder has to keep that shape or detection would legitimately
 * answer `npm` and this smoke would be testing the wrong thing.
 */
const yarnGlobalFolder = join(home, '.config', 'yarn', 'global')

/**
 * How each manager installs globally, removes again, and is pointed somewhere
 * disposable. None may write to the runner's real home: a smoke that leaves a
 * global install behind changes the machine every later job runs on.
 *
 * Yarn is `yarn global add`, not `yarn add -g`, and it is Yarn **Classic** only
 * — Yarn 2 removed global installs and never replaced them.
 */
const MANAGERS = {
  bun: {
    env: { BUN_INSTALL: home },
    install: (tarball) => ['add', '-g', tarball],
    remove: () => ['remove', '-g', 'looptroop'],
    upgradeCommand: 'bun add -g looptroop@latest',
  },
  pnpm: {
    env: { PNPM_HOME: home },
    install: (tarball) => ['add', '-g', tarball],
    remove: () => ['remove', '-g', 'looptroop'],
    upgradeCommand: 'pnpm add -g looptroop@latest',
  },
  yarn: {
    env: {},
    install: (tarball) => ['global', 'add', tarball, '--global-folder', yarnGlobalFolder, '--prefix', home],
    remove: () => ['global', 'remove', 'looptroop', '--global-folder', yarnGlobalFolder, '--prefix', home],
    upgradeCommand: 'yarn global upgrade looptroop@latest',
  },
}

const spec = MANAGERS[MANAGER]
const managerEnv = spec.env

mkdirSync(binDir, { recursive: true })

const childEnv = {
  ...managerEnv,
  PATH: `${binDir}${IS_WINDOWS ? ';' : ':'}${process.env.PATH}`,
  LOOPTROOP_OPENCODE_MODE: 'mock',
  LOOPTROOP_CONFIG_DIR: join(home, 'config'),
}

const shim = join(binDir, IS_WINDOWS ? 'looptroop.cmd' : 'looptroop')

try {
  heading(`pack the tarball this commit produces`)
  const pack = run('npm', ['pack', '--silent'], { cwd: repoRoot })
  const tarball = pack.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
  if (!check(pack.status === 0 && Boolean(tarball), 'npm pack produced a tarball')) {
    process.stderr.write(pack.output)
    throw new Error('pack failed')
  }
  const tarballPath = join(repoRoot, tarball)
  process.stdout.write(`      ${tarball}\n`)

  heading(`install it globally with ${MANAGER}`)
  const install = run(MANAGER, spec.install(tarballPath), { cwd: empty, env: childEnv })
  if (!check(install.status === 0, `${MANAGER} global install succeeded`)) {
    process.stderr.write(install.output)
  }

  heading('the shim it created runs, from a directory holding nothing')
  // Through the shim on PATH, never `node <path>`: the shim is the part that
  // differs between managers and between platforms, so invoking the file
  // directly would skip the only thing this step is here to prove.
  const reported = run('looptroop', ['--version'], { cwd: empty, env: childEnv })
  check(reported.status === 0, 'looptroop --version exited 0')
  check(
    reported.stdout.trim() === version,
    `looptroop --version reported ${version} (got ${JSON.stringify(reported.stdout.trim())})`,
  )

  heading(`doctor names ${MANAGER}, and its own upgrade command`)
  // `doctor` exits non-zero whenever any check fails, and a CI runner has no
  // OpenCode — so the exit code is not the assertion, the install line is.
  const doctor = run('looptroop', ['doctor', '--json'], { cwd: empty, env: childEnv })
  let install_ = null
  try {
    install_ = JSON.parse(doctor.stdout).checks.find((c) => c.name === 'install')
  } catch {
    check(false, `doctor --json emitted parseable JSON (got ${JSON.stringify(doctor.stdout.slice(0, 200))})`)
  }
  if (install_ !== null && install_ !== undefined) {
    // The whole point. Before bun and pnpm had channels of their own, both of
    // these said `npm` and offered `npm install -g looptroop@latest`.
    // Read from the check's structured `install` facts, not by parsing its
    // `detail` sentence. That sentence is prose written for a person and is
    // allowed to be reworded; doing this by string matching meant a display
    // change broke every manager's smoke at once.
    check(
      install_.install?.channel === MANAGER,
      `doctor reports the ${MANAGER} channel (got ${JSON.stringify(install_.install?.channel)})`,
    )
    check(
      install_.install?.upgradeCommand === spec.upgradeCommand,
      `doctor offers ${MANAGER}'s upgrade command, not npm's (got ${JSON.stringify(install_.install?.upgradeCommand)})`,
    )
  }

  heading(`uninstalling with ${MANAGER} removes the shim`)
  const remove = run(MANAGER, spec.remove(), { cwd: empty, env: childEnv })
  check(remove.status === 0, `${MANAGER} global remove succeeded`)
  check(!existsSync(shim), 'the shim is gone')

  rmSync(tarballPath, { force: true })
} finally {
  for (const dir of [home, empty]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // A leftover temp directory is not worth failing a passing smoke over.
    }
  }
}

process.stdout.write(
  failures.length === 0
    ? `\nPASS: ${MANAGER} installs LoopTroop globally, and it knows it.\n`
    : `\nFAIL: ${failures.length} check(s) failed.\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
)
process.exit(failures.length === 0 ? 0 : 1)
