#!/usr/bin/env node
/**
 * Installs the package the way a user would, then drives the CLI through a full
 * session against that install.
 *
 * Everything else in CI runs against the source tree, where the working
 * directory happens to contain every file the daemon needs. That hides a whole
 * class of defect: a runtime asset the `files` allowlist never packed, a path
 * resolved against the process cwd instead of the module, a `bin` shim that
 * cannot start. Each of those passes every unit test and fails on the first
 * machine that installs the tarball.
 *
 * So this packs, installs globally into a throwaway prefix, and runs from a
 * directory that holds nothing — no repository, no `dist/`, no `node_modules`.
 * If a path is resolved from the wrong base, there is nothing here to find.
 *
 * Written as one script rather than three shell blocks because the matrix
 * includes Windows: `bash` steps are not portable there, and a smoke test that
 * silently skips the platform most likely to break is not worth having.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'

/**
 * Mock OpenCode throughout: a real `opencode serve` is a network install and a
 * second moving part, and none of what this checks is about OpenCode. The
 * daemon must still come up and serve without it.
 */
const CHILD_ENV = { LOOPTROOP_OPENCODE_MODE: 'mock' }

/** Away from 3000 and the OpenCode default, so a busy runner does not collide. */
const PORT = 39117

const failures = []
let step = 0

function log(message) {
  process.stdout.write(`${message}\n`)
}

function pass(name, detail = '') {
  log(`  ok    ${name}${detail ? `  (${detail})` : ''}`)
}

function fail(name, detail) {
  failures.push(`${name}: ${detail}`)
  log(`  FAIL  ${name}  (${detail})`)
}

function check(name, condition, detail) {
  if (condition) pass(name, detail)
  else fail(name, detail)
  return condition
}

function heading(title) {
  step += 1
  log(`\n[${step}] ${title}`)
}

/**
 * Runs a command and captures both streams. Never throws on a non-zero exit:
 * exit codes are part of the contract here, so the assertions read them rather
 * than being interrupted by them.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    ...options,
    env: { ...process.env, ...CHILD_ENV, ...(options.env ?? {}) },
  })
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    combined: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

/** npm is a shell script on POSIX and a .cmd on Windows, so it needs a shell there. */
function npm(args, options = {}) {
  return run(IS_WINDOWS ? 'npm.cmd' : 'npm', args, { shell: IS_WINDOWS, ...options })
}

/**
 * The installed entry point. npm writes a `.cmd` shim on Windows and a symlink
 * on POSIX; invoking the shim is the point, since a broken `bin` mapping is one
 * of the things this is here to catch.
 */
function looptroopPath(prefix) {
  return IS_WINDOWS
    ? join(prefix, 'looptroop.cmd')
    : join(prefix, 'bin', 'looptroop')
}

/**
 * Quotes one argument for `cmd.exe`. Everything is quoted rather than only the
 * values that look like they need it: inside double quotes cmd stops treating
 * `&`, `|`, `^` and friends as syntax, which is the whole point of doing this
 * instead of interpolating into a shell string.
 */
function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

/**
 * Runs the installed launcher.
 *
 * On Windows npm's `bin` entry is `looptroop.cmd`, and a batch file is not an
 * executable image: `CreateProcess` cannot run it, so `spawnSync` with the
 * default `shell: false` came back with a null exit code and empty output for
 * every command — which read as thirteen assertion failures about JSON and
 * health, none of them the actual problem. It has to go through the command
 * interpreter, and `/d /s /c` with one pre-quoted line keeps the argument
 * boundaries we chose rather than letting a shell re-split them.
 */
function runShim(shimPath, args, options = {}) {
  if (!IS_WINDOWS) return run(shimPath, args, options)

  const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
  const line = `"${[shimPath, ...args].map(quoteForCmd).join(' ')}"`
  return run(comspec, ['/d', '/s', '/c', line], { ...options, windowsVerbatimArguments: true })
}

function readJson(text, name) {
  try {
    return JSON.parse(text)
  } catch {
    fail(name, 'output is not valid JSON')
    return null
  }
}

/**
 * Polls until the port answers. The daemon reports ready before returning, so
 * this is only insurance against a slow runner, not part of the contract.
 */
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
 * Anything the daemon spawns that is still alive after `stop`.
 *
 * A supervisor that leaves children behind holds the port and the config lock,
 * which is invisible until the next start fails. Matched on the install prefix
 * so this cannot mistake an unrelated node process on a shared runner for ours.
 */
function survivingChildren(prefix) {
  const needle = prefix.toLowerCase()
  if (IS_WINDOWS) {
    const listed = run('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | Select-Object -ExpandProperty CommandLine',
    ])
    return listed.stdout.split('\n').filter((line) => line.toLowerCase().includes(needle))
  }
  const listed = run('ps', ['-A', '-o', 'command='])
  return listed.stdout.split('\n').filter((line) => line.toLowerCase().includes(needle))
}

/**
 * Best-effort teardown, run from `finally` and from CI's `if: always()`.
 *
 * Never allowed to throw: a failure here would mask the assertion failure that
 * is the actual news, and would leave the temporary tree behind either way.
 */
function cleanup(prefix, configDir, scratch) {
  try {
    if (prefix && existsSync(looptroopPath(prefix))) {
      runShim(looptroopPath(prefix), ['stop'], { env: { LOOPTROOP_CONFIG_DIR: configDir } })
    }
  } catch {
    // Already gone, or never started.
  }
  for (const path of [scratch]) {
    try {
      if (path) rmSync(path, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // A runner that holds a handle open is not a test failure.
    }
  }
}
const repoRoot = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'looptroop-smoke-'))
const prefix = join(scratch, 'prefix')
// Unique per job, so a matrix leg cannot read another leg's daemon record.
const configDir = join(scratch, 'config')
// Deliberately empty: nothing here for a cwd-relative path to resolve against.
const elsewhere = join(scratch, 'elsewhere')
const baseUrl = `http://127.0.0.1:${PORT}`

mkdirSync(elsewhere, { recursive: true })
mkdirSync(configDir, { recursive: true })

let bin = ''

try {
  heading('Pack the tarball')
  const packed = npm(['pack', '--json'], { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 })
  if (packed.code !== 0) {
    fail('npm pack', `exited ${packed.code}: ${packed.stderr.trim().split('\n').slice(-3).join(' ')}`)
    throw new Error('cannot continue without a tarball')
  }
  const [packResult] = readJson(packed.stdout, 'npm pack --json') ?? []
  const tarball = resolve(repoRoot, packResult?.filename ?? '')
  check('tarball exists', existsSync(tarball), packResult?.filename ?? 'no filename reported')

  heading('Install it globally into a throwaway prefix')
  // --omit=dev because that is what a user gets. A runtime import that is
  // really a devDependency fails here and nowhere else.
  const installed = npm(['install', '-g', '--prefix', prefix, '--omit=dev', tarball], { cwd: scratch })
  // The tarball is a build artefact in the working tree; remove it either way.
  rmSync(tarball, { force: true })
  if (installed.code !== 0) {
    fail('npm install -g', `exited ${installed.code}: ${installed.stderr.trim().split('\n').slice(-5).join(' ')}`)
    throw new Error('cannot continue without an install')
  }
  bin = looptroopPath(prefix)
  check('bin shim exists', existsSync(bin), bin)
  // Every command below runs from `elsewhere` with the throwaway config dir, so
  // nothing can quietly reach the checkout or the developer's real config.
  const at = { cwd: elsewhere, env: { LOOPTROOP_CONFIG_DIR: configDir } }
  const cli = (...args) => runShim(bin, args, at)

  heading('Metadata commands work without a daemon')
  const version = cli('--version')
  const expected = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  check('--version matches the manifest', version.stdout.trim() === expected,
    `${version.stdout.trim() || '(nothing)'} vs ${expected}`)
  const help = cli('--help')
  check('--help lists commands', help.code === 0 && help.stdout.includes('looptroop <command>'),
    `exit ${help.code}`)
  const unknown = cli('nonsense-command')
  check('unknown command fails', unknown.code === 1, `exit ${unknown.code}`)

  heading('doctor reports before anything has started')
  const doctor = cli('doctor', '--json')
  const doctorJson = readJson(doctor.stdout, 'doctor --json')
  check('doctor --json parses', doctorJson !== null, `exit ${doctor.code}`)
  if (doctorJson) {
    check('doctor reports checks', Array.isArray(doctorJson.checks) && doctorJson.checks.length > 0,
      `${doctorJson.checks?.length ?? 0} check(s)`)
    check('doctor reports the install channel',
      doctorJson.checks?.some((entry) => entry.id === 'install' || entry.name === 'install'),
      'install check present')
  }

  heading('status before start')
  const idle = cli('status')
  check('status says not running', idle.combined.includes('not running'), idle.combined.trim().split('\n')[0] ?? '')
  const idleJson = readJson(cli('status', '--json').stdout, 'status --json (stopped)')
  check('status --json reports running: false', idleJson?.running === false, `running=${idleJson?.running}`)
  heading('Start the detached daemon')
  const started = cli('start', '--port', String(PORT))
  check('start succeeds', started.code === 0, `exit ${started.code}`)
  // The nonce in the URL is a credential; assert on the shape, never print it.
  check('start prints a sign-in URL', /#bootstrap=/.test(started.stdout), 'bootstrap URL present')

  const health = await waitForHealth(baseUrl)
  check('/api/health answers', health?.status === 'ok', `status=${health?.status}`)
  check('health reports an instance id', typeof health?.instanceId === 'string', 'instanceId present')

  heading('The daemon serves its own interface')
  // The whole reason this job exists: in a checkout the built client sits under
  // the working directory, so a path resolved from the wrong base still finds
  // it. Here it cannot, and a 404 means the install is broken for every user.
  const document = await fetch(`${baseUrl}/`)
  const html = await document.text()
  check('GET / returns the interface', document.status === 200, `status ${document.status}`)
  check('GET / is HTML', (document.headers.get('content-type') ?? '').includes('text/html'),
    document.headers.get('content-type') ?? 'no content-type')
  check('the document is the built index', html.includes('<div id="root"'), `${html.length} bytes`)

  const assetPath = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
  if (check('the document references a hashed asset', assetPath !== undefined, assetPath ?? 'none found')) {
    const asset = await fetch(`${baseUrl}${assetPath}`)
    check('the hashed asset is served', asset.status === 200, `status ${asset.status}`)
    check('the asset is cached immutably',
      (asset.headers.get('cache-control') ?? '').includes('immutable'),
      asset.headers.get('cache-control') ?? 'no cache-control')
  }

  const deepLink = await fetch(`${baseUrl}/tickets/does-not-exist/detail`)
  check('deep links fall back to the document', deepLink.status === 200, `status ${deepLink.status}`)
  const missingAsset = await fetch(`${baseUrl}/assets/index-missing.js`)
  check('a missing asset 404s rather than returning HTML', missingAsset.status === 404,
    `status ${missingAsset.status}`)

  heading('The API is closed without credentials')
  const anonymous = await fetch(`${baseUrl}/api/projects`)
  check('an unauthenticated API call is rejected', anonymous.status === 401 || anonymous.status === 403,
    `status ${anonymous.status}`)

  heading('The bootstrap exchange hands out a session')
  // Read from daemon.json rather than scraping the printed URL: the token is
  // what a browser exchanges, and the record is where the daemon publishes it.
  const record = readJson(readFileSync(join(configDir, 'daemon.json'), 'utf8'), 'daemon.json')
  check('daemon.json records this port', record?.port === PORT, `port=${record?.port}`)
  if (!IS_WINDOWS) {
    // The record holds the API token, so it must not be group- or world-readable.
    const mode = statSync(join(configDir, 'daemon.json')).mode & 0o777
    check('daemon.json is owner-only', mode === 0o600, `mode ${mode.toString(8)}`)
  }

  const minted = await fetch(`${baseUrl}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'x-looptroop-token': record?.apiToken ?? '' },
  })
  const nonce = (await minted.json().catch(() => ({}))).nonce
  check('an authenticated caller can mint a nonce', minted.status === 200 && typeof nonce === 'string',
    `status ${minted.status}`)

  const exchanged = await fetch(`${baseUrl}/api/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ nonce }),
  })
  const cookie = exchanged.headers.get('set-cookie') ?? ''
  check('the nonce exchanges for a session cookie', exchanged.status === 200 && cookie.length > 0,
    `status ${exchanged.status}`)
  check('the session cookie is HttpOnly', /HttpOnly/i.test(cookie), 'HttpOnly present')

  const replayed = await fetch(`${baseUrl}/api/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ nonce }),
  })
  check('a nonce cannot be replayed', replayed.status === 401, `status ${replayed.status}`)

  const withSession = await fetch(`${baseUrl}/api/projects`, {
    headers: { cookie: cookie.split(';')[0] ?? '' },
  })
  check('the session cookie opens the API', withSession.status === 200, `status ${withSession.status}`)
  heading('status and logs against a running daemon')
  const runningJson = readJson(cli('status', '--json').stdout, 'status --json (running)')
  check('status --json reports running: true', runningJson?.running === true, `running=${runningJson?.running}`)
  check('status --json agrees with health', runningJson?.daemon?.instanceId === health?.instanceId,
    'instance id matches')
  check('status --json redacts the API token', !JSON.stringify(runningJson ?? {}).includes(record?.apiToken ?? ' '),
    'no token in status output')

  const logs = cli('logs', '--lines', '20')
  check('logs prints the daemon log', logs.code === 0 && logs.stdout.trim().length > 0, `exit ${logs.code}`)
  const logText = readFileSync(join(configDir, 'logs', 'daemon.log'), 'utf8')
  // The standing rule: no secret may reach the log, which gets pasted into issues.
  check('the log holds no API token', !logText.includes(record?.apiToken ?? ' '), 'token absent from log')
  check('the log holds no bootstrap nonce', !/#bootstrap=/.test(logText), 'no sign-in URL in log')

  heading('restart keeps the daemon usable')
  const restarted = cli('restart', '--port', String(PORT))
  check('restart succeeds', restarted.code === 0, `exit ${restarted.code}`)
  const afterRestart = await waitForHealth(baseUrl)
  check('the daemon answers after restart', afterRestart?.status === 'ok', `status=${afterRestart?.status}`)
  check('restart produced a new instance', afterRestart?.instanceId !== health?.instanceId,
    'instance id changed')

  heading('clean refuses to run while the daemon holds worktrees')
  const cleanWhileUp = cli('clean')
  check('clean refuses while running', cleanWhileUp.code === 1, `exit ${cleanWhileUp.code}`)
  check('clean says to stop first', /looptroop stop/.test(cleanWhileUp.combined), 'points at stop')

  heading('stop releases everything')
  const stopped = cli('stop')
  check('stop succeeds', stopped.code === 0, `exit ${stopped.code}`)

  const afterStop = cli('status')
  check('status says not running again', afterStop.combined.includes('not running'),
    afterStop.combined.trim().split('\n')[0] ?? '')
  check('the lock is released', !existsSync(join(configDir, 'daemon.lock')), 'daemon.lock removed')

  let refused = null
  try {
    refused = await fetch(`${baseUrl}/api/health`)
  } catch {
    // Expected: nothing is listening.
  }
  check('the port is no longer served', refused === null, refused ? `still answering ${refused.status}` : 'refused')

  heading('clean runs once the daemon is down')
  const clean = cli('clean')
  check('clean succeeds with no daemon', clean.code === 0, `exit ${clean.code}`)
  check('clean removes nothing without --apply', !/^\s*removing\b/m.test(clean.stdout), 'listed only')

  heading('No child processes survived')
  const survivors = survivingChildren(prefix)
  check('nothing from the install is still running', survivors.length === 0,
    survivors.length === 0 ? 'none' : `${survivors.length} surviving process(es)`)
  // Foreground is a different code path — no detach, no reparenting, and the
  // signal handlers do the shutdown that the detached path does over HTTP.
  // Linux only: it needs a real SIGTERM, which Windows does not have.
  if (process.platform === 'linux') {
    heading('The foreground daemon starts and shuts down on SIGTERM')
    const foreground = join(scratch, 'fg-config')
    mkdirSync(foreground, { recursive: true })
    const { spawn } = await import('node:child_process')
    const child = spawn(bin, ['start', '--foreground', '--port', String(PORT + 1)], {
      cwd: elsewhere,
      env: { ...process.env, ...CHILD_ENV, LOOPTROOP_CONFIG_DIR: foreground },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })

    const fgHealth = await waitForHealth(`http://127.0.0.1:${PORT + 1}`)
    check('the foreground daemon answers', fgHealth?.status === 'ok', `status=${fgHealth?.status}`)
    check('the foreground daemon prints no secret in its output', !/#bootstrap=/.test(output),
      'no sign-in URL on stdout')

    const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
    child.kill('SIGTERM')
    const outcome = await Promise.race([
      exited,
      new Promise((done) => setTimeout(() => done(null), 15_000)),
    ])
    check('SIGTERM shuts the foreground daemon down', outcome !== null,
      outcome === null ? 'still running after 15s' : `exit ${outcome.code ?? outcome.signal}`)
    if (outcome === null) child.kill('SIGKILL')
    check('the foreground lock is released', !existsSync(join(foreground, 'daemon.lock')),
      'daemon.lock removed')
  }
} catch (error) {
  fail('smoke test', error instanceof Error ? error.message : String(error))
} finally {
  cleanup(prefix, configDir, scratch)
}

log(`\n${'-'.repeat(60)}`)
if (failures.length > 0) {
  log(`FAIL: ${failures.length} problem(s) with the installed package.\n`)
  for (const failure of failures) log(`  ${failure}`)
  log('\nThese are defects a user would hit on install. The source tree cannot')
  log('show them, because it already contains every file the daemon needs.')
  process.exit(1)
}
log(`PASS: the installed package started, served its interface, authenticated a`)
log('browser, restarted, stopped, and left nothing running.')

