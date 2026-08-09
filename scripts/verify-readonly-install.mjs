#!/usr/bin/env node
/**
 * Runs a full session against an install directory that is genuinely read-only.
 *
 * A global install belongs to the machine, not the user: /usr/local/lib, a
 * Homebrew cellar, C:\Program Files, a container image layer, a directory an
 * administrator has locked down. The daemon must keep every byte of its own
 * state in the config directory and never write beside its own code.
 *
 * The failure this catches is quiet and specific. A cache file, a lock, a log,
 * or a database dropped next to the bundle works perfectly on the developer's
 * machine — where the install is a checkout they own — and fails on the first
 * machine where it is not. Usually at start, sometimes only at the first write,
 * which is worse.
 *
 * Read-only here means read-only, not `chmod a-w`: root ignores mode bits, and
 * CI runs as root or as an administrator on all three platforms. So the
 * directory is made read-only by the mechanism the platform actually enforces —
 * a read-only bind mount on Linux — and the run reports itself skipped rather
 * than faked where that is unavailable. A skipped check that says so is honest;
 * one that passes because nothing was enforced is not.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 39118
const CHILD_ENV = { LOOPTROOP_OPENCODE_MODE: 'mock' }

const failures = []
let step = 0
/** Why nothing was verified, when the platform offers no enforced mechanism. */
let skipped = null

const log = (message) => process.stdout.write(`${message}\n`)
const heading = (title) => { step += 1; log(`\n[${step}] ${title}`) }

function check(name, condition, detail) {
  if (condition) log(`  ok    ${name}${detail ? `  (${detail})` : ''}`)
  else {
    failures.push(`${name}: ${detail}`)
    log(`  FAIL  ${name}  (${detail})`)
  }
  return condition
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
    env: { ...process.env, ...CHILD_ENV, ...(options.env ?? {}) },
  })
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    combined: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

async function waitForHealth(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return await response.json()
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  return null
}

/**
 * Every file under a directory, with the size and mtime that would betray a
 * write. The mount can only prove writes were refused; comparing this before
 * and after proves none landed anywhere the mount did not cover.
 */
function snapshot(root) {
  const entries = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        const stats = statSync(path)
        entries.set(path, `${stats.size}:${stats.mtimeMs}`)
      }
    }
  }
  walk(root)
  return entries
}

function diffSnapshots(before, after) {
  const changed = []
  for (const [path, signature] of after) {
    if (!before.has(path)) changed.push(`added ${path}`)
    else if (before.get(path) !== signature) changed.push(`modified ${path}`)
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.push(`removed ${path}`)
  }
  return changed
}
/**
 * Makes a directory read-only in a way the running user cannot ignore, and
 * returns how to undo it — or null when the platform offers no such mechanism
 * here, which is a skip rather than a failure.
 *
 * Only Linux bind mounts are implemented. macOS needs a disk image and Windows
 * needs an ACL denial that an administrator can still take ownership around;
 * both are enough machinery to be their own source of flakes, and the property
 * under test is not platform-specific — a stray write beside the bundle is
 * wrong everywhere and Linux catches it.
 */
function makeReadOnly(dir) {
  if (process.platform !== 'linux') {
    return { ok: false, why: `no enforced read-only mechanism on ${process.platform}` }
  }

  const bind = run('mount', ['--bind', dir, dir])
  if (bind.code !== 0) {
    return { ok: false, why: 'mount --bind is not permitted here (needs CAP_SYS_ADMIN)' }
  }

  const remount = run('mount', ['-o', 'remount,ro,bind', dir])
  if (remount.code !== 0) {
    run('umount', [dir])
    return { ok: false, why: 'remount read-only failed' }
  }

  return { ok: true, undo: () => run('umount', [dir]) }
}

/** Proves the mount is enforced, so a later pass cannot be a false negative. */
function confirmEnforced(dir) {
  const probe = run(process.execPath, [
    '-e',
    `try { require('fs').writeFileSync(${JSON.stringify(join(dir, '.write-probe'))}, 'x'); console.log('WROTE') }
     catch (error) { console.log(error.code ?? 'ERROR') }`,
  ])
  return probe.stdout.trim()
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'looptroop-readonly-'))
  const prefix = join(scratch, 'prefix')
  const configDir = join(scratch, 'config')
  const emptyCwd = join(scratch, 'cwd')
  for (const dir of [prefix, configDir, emptyCwd]) mkdirSync(dir, { recursive: true })

  const baseUrl = `http://127.0.0.1:${PORT}`
  const cli = join(prefix, 'bin', 'looptroop')
  const childEnv = { LOOPTROOP_CONFIG_DIR: configDir }
  let readOnly = null

  try {
    heading('Install the packed tarball into a throwaway prefix')
    const packed = run('npm', ['pack', '--quiet', '--pack-destination', scratch], { cwd: process.cwd() })
    const tarball = packed.stdout.trim().split('\n').pop()
    if (!check('npm pack produced a tarball', packed.code === 0 && Boolean(tarball), tarball || 'no output')) {
      return
    }
    const installed = run('npm', ['install', '-g', '--prefix', prefix, '--omit=dev', join(scratch, tarball)])
    check('npm install -g succeeds', installed.code === 0, `exit ${installed.code}`)
    check('the bin shim exists', statSync(cli).isFile() || statSync(cli).isSymbolicLink(), cli)

    heading('Make the install directory genuinely read-only')
    const libDir = join(prefix, 'lib', 'node_modules', 'looptroop')
    const before = snapshot(libDir)
    log(`  ${before.size} file(s) installed under ${libDir}`)

    readOnly = makeReadOnly(libDir)
    if (!readOnly.ok) {
      // A skip is honest on a developer's macOS laptop and a hole in CI, where
      // this is the only job asserting the property at all. `REQUIRED` is set
      // there, so a mount that stops working fails loudly instead of quietly
      // verifying nothing for however long it takes someone to notice.
      if (process.env.LOOPTROOP_READONLY_REQUIRED === '1') {
        failures.push(`read-only mount unavailable where it is required: ${readOnly.why}`)
        log(`  FAIL  the install can be made read-only  (${readOnly.why})`)
      } else {
        skipped = readOnly.why
        log(`\nThis check needs a filesystem the running user cannot write to. Nothing was`)
        log('verified, so nothing is claimed.')
      }
      return
    }

    const probe = confirmEnforced(libDir)
    if (!check('writes into the install are refused', probe === 'EROFS' || probe === 'EACCES',
      `write probe reported ${probe}`)) {
      return
    }
    heading('Start the daemon from the read-only install')
    // Empty cwd, so anything resolved relative to the working directory fails
    // here rather than accidentally finding a file in the checkout.
    const started = run(cli, ['start', '--port', String(PORT)], { cwd: emptyCwd, env: childEnv })
    check('start succeeds', started.code === 0, `exit ${started.code}`)

    const health = await waitForHealth(baseUrl)
    if (!check('the daemon answers', health?.status === 'ok', `status=${health?.status}`)) return

    const token = JSON.parse(readFileSync(join(configDir, 'daemon.json'), 'utf8')).apiToken
    const api = (path, init = {}) => fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-looptroop-token': token, ...(init.headers ?? {}) },
    })

    heading('The interface is served out of the read-only install')
    const document = await fetch(`${baseUrl}/`)
    check('GET / returns the interface', document.status === 200, `status ${document.status}`)

    heading('Attach a project and create data')
    // A real repository: attaching resolves the git root and writes ignore
    // rules, so a fixture directory would not exercise the same paths.
    const repo = join(scratch, 'repo')
    mkdirSync(repo, { recursive: true })
    // The origin remote matters: attach requires one that resolves to
    // github.com. Nothing contacts it — the URL is parsed, and the `gh`
    // permission probe behind it is bounded and degrades to "unknown", so an
    // offline runner reports a warning rather than failing.
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ci@example.com'],
      ['config', 'user.name', 'CI'],
      ['remote', 'add', 'origin', 'https://github.com/looptroop-ai/readonly-check.git'],
      ['commit', '-q', '--allow-empty', '-m', 'initial']]) {
      run('git', args, { cwd: repo })
    }

    const created = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Readonly Check', shortname: 'ROC', folderPath: repo, ignoreMode: 'skip' }),
    })
    const body = await created.json().catch(() => null)
    check('a project can be attached', created.status === 200 || created.status === 201,
      `status ${created.status}: ${JSON.stringify(body)?.slice(0, 200) ?? 'no body'}`)

    const listed = await api('/api/projects')
    const projects = await listed.json().catch(() => [])
    check('the attached project is listed', Array.isArray(projects) && projects.length === 1,
      `${Array.isArray(projects) ? projects.length : 0} project(s)`)

    heading('State landed in the config directory, not beside the code')
    const configFiles = snapshot(configDir)
    check('the config directory holds the database', [...configFiles.keys()].some((path) => path.includes('.sqlite')),
      `${configFiles.size} file(s) under the config dir`)

    heading('Nothing was even refused a write')
    // The snapshot below can only see writes that landed, and on a read-only
    // mount none can. A daemon that tries to write beside its own bundle and
    // swallows the EROFS would leave the tree pristine and still be broken —
    // silently degraded here, and writing where the mount does not protect. The
    // refusal is the evidence, so look for it where the daemon reports errors.
    const logPath = join(configDir, 'logs', 'daemon.log')
    const daemonLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const refusals = daemonLog.split('\n').filter((line) =>
      /\b(EROFS|EACCES|EPERM)\b/.test(line) && line.includes(libDir))
    check('the daemon was never refused a write into its install', refusals.length === 0,
      refusals.length === 0 ? `${daemonLog.split('\n').length} log line(s) clean` : refusals[0].slice(0, 160))

    heading('Stop, and confirm the install was never written to')
    const stopped = run(cli, ['stop'], { cwd: emptyCwd, env: childEnv })
    check('stop succeeds', stopped.code === 0, `exit ${stopped.code}`)

    const changed = diffSnapshots(before, snapshot(libDir))
    check('nothing under the install changed', changed.length === 0,
      changed.length === 0 ? `${before.size} file(s) untouched` : changed.slice(0, 5).join('; '))
  } catch (error) {
    failures.push(`read-only install: ${error instanceof Error ? error.message : String(error)}`)
    log(`  FAIL  ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    try {
      run(join(prefix, 'bin', 'looptroop'), ['stop'], { cwd: emptyCwd, env: childEnv })
    } catch {
      // Already stopped, or never started.
    }
    // Unmount before removing, or the recursive delete walks into a live mount.
    if (readOnly?.ok) readOnly.undo()
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // A held handle is not a test failure.
    }
  }
}

/**
 * Reported after `main` returns, not inside it: several checks bail early with
 * a bare `return`, and a summary written inside the function would be skipped
 * by exactly the failures worth shouting about — exiting 0 with problems on
 * record.
 */
function report() {
  log(`\n${'-'.repeat(60)}`)
  if (failures.length > 0) {
    log(`FAIL: ${failures.length} problem(s) running from a read-only install.\n`)
    for (const failure of failures) log(`  ${failure}`)
    log('\nEverything the daemon writes belongs in the config directory. A write')
    log('beside the bundle fails on every machine where the install is not the')
    log("developer's own checkout.")
    process.exit(1)
  }
  if (skipped) {
    log(`SKIP: nothing was verified (${skipped}).`)
    return
  }
  log('PASS: the daemon started, served, attached a project and stored its data')
  log('without writing a single byte into its own install directory.')
}

await main()
report()


