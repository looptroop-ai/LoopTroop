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
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

/** The floor `dist/server/cli/launcher.cjs` enforces before it loads anything. */
const REQUIRED_NODE = { major: 24, minor: 15 }

/**
 * What every child gets on top of this process's own environment.
 *
 * The PATH entry is not a convenience. This runs under `sudo`, which replaces
 * PATH with sudoers' `secure_path` however it was invoked — the pinned Node is
 * on PATH *here* only because the workflow resolved it before the sudo. The
 * installed `looptroop` is a symlink to a `#!/usr/bin/env node` script, so the
 * shim resolves its own interpreter from PATH and otherwise picks up whatever
 * the base image happens to ship. When that is below the floor the launcher
 * enforces, it exits 1 in about thirty milliseconds, before a line of the daemon
 * runs — a Node-resolution failure wearing the costume of a read-only one.
 */
const CHILD_ENV = {
  LOOPTROOP_OPENCODE_MODE: 'mock',
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
}

const failures = []
let step = 0
/** Why nothing was verified, when the platform offers no enforced mechanism. */
let skipped = null

const log = (message) => process.stdout.write(`${message}\n`)
const heading = (title) => { step += 1; log(`\n[${step}] ${title}`) }

/**
 * A port nobody is listening on, asked of the kernel rather than picked.
 *
 * This used to be the constant 39118, which turned two different failures into
 * the same output. A daemon left behind by an earlier run — or anything else on
 * that port — answered `/api/health` with `status: "ok"`, so the run reported a
 * pass it had not earned; and when the port was merely occupied, `start` failed
 * with "port in use" while the summary said the daemon would not start from a
 * read-only install. Binding to 0 and reading the port back is still a race in
 * principle, but against a specific number rather than in favour of one.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port from the kernel'))
        else resolve(address.port)
      })
    })
  })
}

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

/**
 * Removes every credential this script could otherwise print into a public CI
 * log, and says where it removed one.
 *
 * `looptroop start` prints a sign-in URL carrying a single-use bootstrap nonce
 * in its fragment, and `daemon.json` holds the daemon's API token. Both are live
 * credentials for a running daemon. This exists because the diagnostics below
 * are only useful if they can be turned on in CI, and output nobody can safely
 * publish is output nobody turns on.
 *
 * Redaction is by shape rather than by value: `[REDACTED]` where a secret was is
 * still a diagnostic, while a line silently dropped reads like a step that never
 * ran. Anything long and opaque goes — a nonce this did not anticipate is worth
 * more to an attacker than to a reader.
 */
function redact(text) {
  return text
    // The whole fragment: everything after `#bootstrap=` is the credential.
    .replace(/#bootstrap=[^\s'"]+/gi, '#bootstrap=[REDACTED]')
    // Any token-, key-, secret- or nonce-shaped assignment, however spelled.
    .replace(/\b(token|secret|nonce|apiToken|api_key|authorization)\b(\s*[:=]\s*"?)([^\s",}]+)/gi,
      (_match, name, separator) => `${name}${separator}[REDACTED]`)
    // A bare hex or base64url run long enough to be a credential rather than a
    // hash fragment someone might actually need to read.
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]')
}

/**
 * Prints command output that a failing step made worth reading.
 *
 * The failure this was added for printed nothing at all: `start succeeds` with
 * `exit 1` and not one line of why, so the only way to learn anything was to
 * push a commit that printed more and wait for CI. Bounded because a daemon log
 * can run to thousands of lines and the useful part is the end.
 */
function showOutput(label, text, lines = 40) {
  const content = redact(text).trimEnd()
  if (!content) {
    log(`  --- ${label}: no output ---`)
    return
  }
  const all = content.split('\n')
  const shown = all.slice(-lines)
  log(`  --- ${label}${all.length > shown.length ? ` (last ${lines} of ${all.length} lines)` : ''} ---`)
  for (const line of shown) log(`  | ${line}`)
  log(`  --- end ${label} ---`)
}

/** The daemon's own log, or a note saying why there is none to show. */
function readLogFile(configDir) {
  const logPath = join(configDir, 'logs', 'daemon.log')
  if (!existsSync(logPath)) return `(no log at ${logPath})`
  try {
    return readFileSync(logPath, 'utf8')
  } catch (error) {
    return `(could not read ${logPath}: ${error.code ?? error.message})`
  }
}

/**
 * The tarball to install, from `--tarball <path>` or `--tarball=<path>`.
 *
 * The release passes the artefact every other job verified, so this exercises
 * the bytes that will actually be published. Without it the script packs its
 * own, which is right for a local run against a working tree but wrong in a
 * release: a pass would describe a tarball nobody ships.
 *
 * An unrecognised argument is fatal rather than ignored: a typo would silently
 * fall through to packing, and the release would report a pass for bytes it
 * never looked at.
 */
function parseArgs(argv) {
  let tarball = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--tarball') {
      tarball = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--tarball=')) {
      tarball = arg.slice('--tarball='.length)
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)} (expected --tarball <path>)`)
    }
  }
  // Given but empty means the caller meant to point at an artefact and lost the
  // path. Packing our own instead would hide that behind a green run.
  if (tarball !== null && tarball.trim() === '') {
    throw new Error('--tarball needs a path')
  }
  return { tarball: tarball ?? '' }
}

const options = parseArgs(process.argv.slice(2))

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'looptroop-readonly-'))
  const prefix = join(scratch, 'prefix')
  const configDir = join(scratch, 'config')
  const emptyCwd = join(scratch, 'cwd')
  for (const dir of [prefix, configDir, emptyCwd]) mkdirSync(dir, { recursive: true })

  const port = await findFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const cli = join(prefix, 'bin', 'looptroop')
  const childEnv = { LOOPTROOP_CONFIG_DIR: configDir }
  let readOnly = null

  try {
    heading('Install the packed tarball into a throwaway prefix')
    // A handed-in tarball is the release artefact every other job verified, and
    // it is installed from where it lies rather than copied into the scratch
    // directory this run deletes.
    let tarballPath
    if (options.tarball) {
      tarballPath = resolve(options.tarball)
      if (!check('the given tarball exists', existsSync(tarballPath), tarballPath)) return
      log(`  installing the given artefact: ${tarballPath}`)
    } else {
      const packed = run('npm', ['pack', '--quiet', '--pack-destination', scratch], { cwd: process.cwd() })
      const packedName = packed.stdout.trim().split('\n').pop()
      if (!check('npm pack produced a tarball', packed.code === 0 && Boolean(packedName), packedName || 'no output')) {
        return
      }
      tarballPath = join(scratch, packedName)
    }
    const installed = run('npm', ['install', '-g', '--prefix', prefix, '--omit=dev', tarballPath])
    if (!check('npm install -g succeeds', installed.code === 0, `exit ${installed.code}`)) {
      showOutput('npm install output', installed.combined)
      return
    }
    check('the bin shim exists', statSync(cli).isFile() || statSync(cli).isSymbolicLink(), cli)

    // Asked before anything is mounted, because the answer is not about the
    // mount. The shim is `#!/usr/bin/env node`, so it runs under whatever Node
    // PATH resolves for the child — not the one running this script. When that
    // is below the floor, the launcher exits 1 immediately and every later check
    // fails for a reason that has nothing to do with the install being
    // read-only. Failing here says which of those two it was.
    //
    // Resolved by spawning `node` rather than by asking a shell, because that is
    // what `env node` and the Windows `.cmd` shim both do, and because a shell
    // under `sudo` is not the shell this script was started from.
    const childNode = run('node', ['-p', 'process.execPath + " " + process.versions.node'])
    const [nodePath, version] = childNode.stdout.trim().split(' ')
    const [major, minor] = (version ?? '').split('.').map((part) => Number.parseInt(part, 10))
    const meetsFloor = major > REQUIRED_NODE.major
      || (major === REQUIRED_NODE.major && minor >= REQUIRED_NODE.minor)
    if (!check('the shim will find a supported Node on PATH', meetsFloor,
      `${nodePath ?? 'no node on PATH'} is ${version ?? 'unreadable'}, ` +
      `floor is ${REQUIRED_NODE.major}.${REQUIRED_NODE.minor}.0`)) {
      return
    }

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
    const started = run(cli, ['start', '--port', String(port)], { cwd: emptyCwd, env: childEnv })
    if (!check('start succeeds', started.code === 0, `exit ${started.code}`)) {
      // Printed here rather than left for someone to reproduce locally: this
      // runs as root behind a bind mount that a developer's machine does not
      // have, so "run it yourself and see" is not available. The daemon's own
      // log holds the reason the CLI only summarises.
      showOutput('start output', started.combined)
      showOutput('daemon log', readLogFile(configDir))
      // Nothing below can mean anything once the daemon is not running, and
      // waiting out the health timeout only delays the report by half a minute.
      return
    }

    const state = JSON.parse(readFileSync(join(configDir, 'daemon.json'), 'utf8'))
    const health = await waitForHealth(baseUrl)
    // The instance id, not just a 200. This asserted only `status === 'ok'`
    // against a fixed port, and passed on a run where the daemon answering was
    // one left behind by an earlier run — the single failure a verifier must
    // never have, since it reports success for code it did not exercise.
    if (!check('the daemon answers, and it is the one this run started',
      health?.status === 'ok' && health.instanceId === state.instanceId,
      `status=${health?.status}, instance ${health?.instanceId === state.instanceId ? 'matches' : 'differs'}`)) {
      showOutput('daemon log', readLogFile(configDir))
      return
    }

    const token = state.apiToken
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
    if (!check('a project can be attached', created.status === 200 || created.status === 201,
      `status ${created.status}: ${redact(JSON.stringify(body) ?? 'no body').slice(0, 200)}`)) {
      showOutput('daemon log', readLogFile(configDir))
    }

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
    if (!check('stop succeeds', stopped.code === 0, `exit ${stopped.code}`)) {
      showOutput('stop output', stopped.combined)
    }

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
    // `stop` goes through the same shim that may not have been able to run at
    // all, and through the same lock logic under test — so it is not evidence
    // that nothing is left. A daemon that survives this script holds a port and
    // an open database for as long as the runner lives, and on a developer's
    // machine that is until they notice. The pid in the state file is the one
    // thing here written by the daemon itself.
    await reapSurvivor(configDir, baseUrl)
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
 * Kills a daemon this run started and could not stop, and says so.
 *
 * Reported rather than silent: needing this means `stop` did not work, which is
 * a defect in its own right even when the read-only property holds. Scoped to
 * the pid in this run's own config directory, so it can only ever reach a daemon
 * this script started.
 */
async function reapSurvivor(configDir, baseUrl) {
  let answering = false
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) })
    answering = response.ok
  } catch {
    // Nothing listening, which is the outcome we want.
  }
  if (!answering) return

  let pid = null
  try {
    pid = JSON.parse(readFileSync(join(configDir, 'daemon.json'), 'utf8')).pid
  } catch {
    // No state file to name an owner.
  }

  failures.push(`a daemon was still running after stop (pid ${pid ?? 'unknown'})`)
  log(`  FAIL  nothing was left running  (pid ${pid ?? 'unknown'} still answering)`)
  if (typeof pid !== 'number') return

  try {
    process.kill(pid, 'SIGKILL')
    log(`  killed leftover daemon pid ${pid}`)
  } catch {
    log(`  could not kill leftover daemon pid ${pid}`)
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


