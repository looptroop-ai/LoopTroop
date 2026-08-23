#!/usr/bin/env node
/**
 * Installs a published release the way its documentation tells a user to, from
 * the real feed, and drives it until it serves.
 *
 *   node scripts/smoke-published.mjs --channel npm --version 0.5.7
 *   node scripts/smoke-published.mjs --channel npm --version 0.5.7 --pin --profile gate
 *   node scripts/smoke-published.mjs --plan --tier release
 *
 * The rest of this repository's smoke tests prove that a locally built artefact
 * works. None of them can see a broken publish: a tap that never received its
 * commit, a `bin` mapping that survived `npm pack` and not `npm publish`, a
 * registry serving the previous version behind `@latest`. This one installs
 * what users install.
 *
 * `--version` is required rather than read from package.json. The checkout and
 * the feed are different things, and that difference is the entire subject: a
 * script that reads its own version can only ever test a local build, which is
 * why `smoke-installer.mjs` cannot do this job.
 *
 * WAITING IS NOT RETRYING
 *
 * `awaitPublished` polls the feed's *metadata* for the presence of a version.
 * It never installs anything, never runs an assertion, and never observes a
 * failure it could mask. Once the version is present — or the cap expires —
 * the assertions run exactly once and their result stands. Re-running a failed
 * assertion until it passes would hide the races this exists to find, and
 * AGENTS.md forbids it.
 */
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'

/** GitHub's releases feed, for resolving "latest stable" and for asset probes. */
const REPO = process.env.LOOPTROOP_INSTALL_REPO || 'looptroop-ai/LoopTroop'
const API = process.env.LOOPTROOP_INSTALL_API || 'https://api.github.com'

const POLL_INTERVAL_MS = 15_000

// ---------------------------------------------------------------------------
// The recipe table. One entry per documented install method; the only place a
// channel is defined, so `--plan` and the assertions cannot disagree.
// ---------------------------------------------------------------------------

/**
 * `tier` and `opencode` belong to a *leg*, not to a channel.
 *
 * Two things force this. npm is release-tier on all three operating systems,
 * but Windows must use an npm-installed OpenCode so the `opencode.cmd` launch
 * path is covered — the shape that shipped broken in 0.5.7 and made LoopTroop
 * unusable for anyone on Windows who installed OpenCode from npm. And Homebrew
 * is release-tier on macOS while Linuxbrew is weekly-tier. A single `tier` or
 * `opencode` string per channel cannot express either.
 */
const CHANNELS = {
  npm: {
    // Verbatim from README.md. If that changes, this must change with it.
    documented: 'npm install -g looptroop',
    legs: [
      { os: 'ubuntu-latest', tier: 'release', opencode: 'installer' },
      { os: 'macos-latest', tier: 'release', opencode: 'installer' },
      { os: 'windows-latest', tier: 'release', opencode: 'npm' },
    ],
    daemon: true,
    pinnable: true,
    port: 39121,
    opencodePort: 39621,
    propagationCapMs: 3 * 60_000,
    publishJob: 'npm',
    publishHint: 'Check https://www.npmjs.com/package/looptroop?activeTab=versions',
    install: (version, pin) => ['install', '--global', pin ? `looptroop@${version}` : 'looptroop'],
    uninstall: () => ['uninstall', '--global', 'looptroop'],
    manager: 'npm',
    published: probeNpmRegistry,
    expect: {
      channel: 'npm',
      // A function, not a string: the binary channel's command differs by
      // platform, so the shape has to allow it everywhere.
      upgradeCommand: () => 'npm install -g looptroop@latest',
      okChecksPre: ['install', 'git', 'npm', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  },
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const failures = []
let step = 0

function log(message) {
  process.stdout.write(`${redact(message)}\n`)
}

function pass(name, detail = '') {
  log(`  ok    ${name}${detail ? `  (${detail})` : ''}`)
}

function fail(name, detail) {
  failures.push(`${name}: ${redact(String(detail))}`)
  log(`  FAIL  ${name}  (${detail})`)
}

/**
 * `detail` explains a failure, so it is printed only when the check fails.
 *
 * Writing one string for both outcomes produces lines like
 * `ok  daemon.json removed  (state file survived stop)`, which says the
 * opposite of what happened. Where a passing line is worth annotating, pass
 * `passDetail` as well.
 */
function check(name, condition, detail, passDetail = '') {
  if (condition) pass(name, passDetail)
  else fail(name, detail)
  return condition
}

function heading(title) {
  step += 1
  log(`\n[${step}] ${title}`)
}

/** Stops the run with a diagnosis rather than an assertion. */
function abort(message, ...detail) {
  process.stderr.write(`\nFAIL: ${redact(message)}\n`)
  for (const line of detail) if (line) process.stderr.write(`  ${redact(line)}\n`)
  process.stderr.write('\n')
  process.exitCode = 1
}

/**
 * Secrets that must not reach a log line or a result artefact.
 *
 * `start` prints a sign-in URL carrying a one-time code, and the daemon state
 * file carries the API token. Both are short-lived, and both would be readable
 * by anyone who can see a workflow log for as long as the run is retained.
 */
function redact(text) {
  let out = String(text)
  out = out.replace(/#bootstrap=[^\s"']+/g, '#bootstrap=REDACTED')
  out = out.replace(/("?apiToken"?\s*[:=]\s*"?)[A-Za-z0-9._-]+/g, '$1REDACTED')
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = process.env[name]
    if (value && value.length > 6) out = out.split(value).join(`<${name}>`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Process helpers. Copied from smoke-install.mjs rather than shared: there are
// eleven standalone smoke scripts and no helper module, and introducing one
// inside a packaging change would touch all eleven.
// ---------------------------------------------------------------------------

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    ...options,
    env: { ...process.env, ...(options.env ?? {}) },
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
 * Quotes one argument for `cmd.exe`. Everything is quoted rather than only what
 * looks like it needs it: inside double quotes cmd stops treating `&`, `|`, `^`
 * and friends as syntax, which is the point of doing this at all.
 */
function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

/**
 * Runs the installed launcher.
 *
 * On Windows the `bin` entry is `looptroop.cmd`, and a batch file is not an
 * executable image: `CreateProcess` cannot run it, so `spawnSync` with the
 * default `shell: false` returns a null exit code and empty output for every
 * command — which reads as a dozen assertion failures about JSON and health,
 * none of them the actual problem. Four separate defects in this repository
 * share that root cause, so this is copied verbatim rather than re-derived.
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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** True when nothing holds the port. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/** True once nothing answers on the port. */
async function portIsClosed(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portIsFree(port)) return true
    // Windows can hold a just-closed port in TIME_WAIT briefly, which is not
    // the daemon still listening.
    await sleep(500)
  }
  return false
}

async function waitForHealth(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return await response.json()
    } catch {
      // Not listening yet.
    }
    await sleep(250)
  }
  return null
}

// ---------------------------------------------------------------------------
// Feed probes. Read-only. Each returns the version the channel currently
// serves, or null when it serves nothing.
// ---------------------------------------------------------------------------

/**
 * What the registry serves for a version.
 *
 * npm's behaviour for an absent version is not what an earlier draft of this
 * assumed. On npm 11 it exits 1 with `E404` on stderr and nothing on stdout,
 * not 0 with empty output. Both shapes are treated as "not published yet" —
 * but only those two. A registry outage or a network failure must surface as
 * an error rather than be polled until the cap expires and reported as a
 * missing release, which would blame the wrong thing.
 */
function probeNpmRegistry(recipe, version) {
  const result = npm(['view', `looptroop@${version}`, 'version'])
  const printed = result.stdout.trim()
  if (result.code === 0) return printed === '' ? null : printed
  if (/E404|is not in this registry|No match(ing versions)? found/i.test(result.combined)) return null
  throw new Error(`npm view failed (exit ${result.code}): ${result.combined.trim().split('\n')[0]}`)
}

/** What `@latest` resolves to — the assertion that the channel's pointer moved. */
function probeNpmLatest() {
  const result = npm(['view', 'looptroop', 'version'])
  return result.code === 0 ? result.stdout.trim() || null : null
}

async function getJson(url) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'looptroop-published-smoke' }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`${url} -> ${response.status}`)
  return response.json()
}

/**
 * The newest published stable release.
 *
 * Used when no `--version` is given, which is what makes a plain push or a
 * scheduled run usable: neither carries a workflow input. Prereleases are
 * excluded, because every channel except npm ignores them.
 */
async function latestStableVersion() {
  const releases = await getJson(`${API}/repos/${REPO}/releases?per_page=100`)
  const stable = releases.find((r) => r.draft !== true && r.prerelease !== true)
  if (!stable) throw new Error('no stable release found')
  return String(stable.tag_name).replace(/^v/, '')
}

// ---------------------------------------------------------------------------
// Presence polling
// ---------------------------------------------------------------------------

async function awaitPublished(recipe, version) {
  const started = Date.now()
  const deadline = started + recipe.propagationCapMs
  let seen = null
  for (let attempt = 1; ; attempt += 1) {
    seen = await recipe.published(recipe, version)
    log(`  poll ${attempt}: serves ${seen ?? '(nothing)'}`)
    if (seen === version) {
      log(`  present after ${Math.round((Date.now() - started) / 1000)}s`)
      return seen
    }
    if (Date.now() >= deadline) break
    await sleep(POLL_INTERVAL_MS)
  }
  const minutes = Math.round(recipe.propagationCapMs / 60_000)
  abort(
    `${recipe.key} still serves ${seen ?? '(nothing)'} after ${minutes} minutes, expected ${version}.`,
    recipe.publishJob ? `That is what \`${recipe.publishJob}\` was supposed to push.` : '',
    recipe.publishHint ?? '',
  )
  return null
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function runChannel(recipe, options) {
  const { version, pin, profile, opencodeMode } = options
  const gateOnly = profile === 'gate'

  const scratch = mkdtempSync(join(tmpdir(), `looptroop-published-${recipe.key}-`))
  const prefix = join(scratch, 'prefix')
  const configDir = join(scratch, 'config')
  // Every command runs from a directory with nothing in it: a stray package.json
  // or .git in the working directory changes what several commands do.
  const elsewhere = join(scratch, 'elsewhere')
  for (const dir of [prefix, elsewhere]) mkdirSync(dir, { recursive: true })

  const port = recipe.port
  const opencodePort = recipe.opencodePort
  const baseUrl = `http://127.0.0.1:${port}`

  // `LOOPTROOP_BACKEND_PORT` as well as `--port`, because doctor resolves the
  // port from settings rather than from the running daemon: without it the
  // post-start `port` check inspects 3000 and says nothing about this leg.
  //
  // The OpenCode base URL is per-leg for the same reason the daemon port is —
  // a shared runner may already have something on the default 4096, and a leg
  // that talked to it would be reporting on the runner, not the release.
  const childEnv = {
    LOOPTROOP_CONFIG_DIR: configDir,
    LOOPTROOP_BACKEND_PORT: String(port),
    LOOPTROOP_OPENCODE_BASE_URL: `http://127.0.0.1:${opencodePort}`,
    ...(opencodeMode === 'mock' ? { LOOPTROOP_OPENCODE_MODE: 'mock' } : {}),
  }

  let adopted = null
  const shim = () => (IS_WINDOWS ? join(prefix, 'looptroop.cmd') : join(prefix, 'bin', 'looptroop'))
  const cli = (args, extra = {}) =>
    runShim(shim(), args, { cwd: elsewhere, env: { ...childEnv, ...(extra.env ?? {}) }, ...extra })

  try {
    heading(`Feed carries ${version}`)
    const served = await awaitPublished(recipe, version)
    if (served === null) return { ok: false, served: null }

    heading('The channel serves the version under test')
    if (pin) {
      log(`  skipped  (--pin: a pinned install says nothing about the latest pointer)`)
    } else {
      const latest = probeNpmLatest()
      check(
        'latest resolves to the version under test',
        latest === version,
        `${recipe.key} serves ${latest}, this run is testing ${version}`,
      )
    }

    heading(`Install: ${recipe.documented}${pin ? ` (pinned to ${version})` : ''}`)
    const install = npm([...recipe.install(version, pin), '--prefix', prefix], { cwd: elsewhere })
    // A barrier, not an assertion: every later step would otherwise run against
    // whatever the runner already had, and report a pass for software this leg
    // never installed.
    if (install.code !== 0) {
      fail('install', `exit ${install.code}: ${install.combined.trim().split('\n').slice(-3).join(' / ')}`)
      return { ok: false, served }
    }
    pass('install', recipe.documented)

    heading('The installed launcher is where the channel puts it')
    if (!check('shim exists', existsSync(shim()), shim())) return { ok: false, served }

    heading('It reports the published version')
    const printed = cli(['--version'])
    check('--version', printed.stdout.trim() === version, `printed "${printed.stdout.trim()}", expected "${version}"`, version)

    heading('doctor, before start')
    // Not gated on the exit code: doctor exits 1 when any check fails, and the
    // checks are what this reads. Parse either way.
    const pre = cli(['doctor', '--json'])
    const preReport = readJson(pre.stdout, 'doctor --json (pre-start)')
    if (preReport) {
      // The detail reads on both outcomes: `check` prints it whether it passed
      // or failed, so "checks[] is empty" beside an `ok` would be nonsense.
      const count = Array.isArray(preReport.checks) ? preReport.checks.length : 0
      check('doctor reports checks', count > 0, `${count} checks`)
      for (const name of recipe.expect.okChecksPre) {
        const found = preReport.checks.find((c) => c.name === name)
        check(`${name} is ok`, found?.status === 'ok', found ? `${found.status}: ${found.detail}` : 'check absent')
      }
      // Deliberately tolerant. With OpenCode installed but no server running,
      // `judgeOpenCode` returns `warn` on purpose so a fresh install does not
      // read as broken. Requiring `ok` here would fail every leg that lets
      // LoopTroop launch OpenCode itself.
      const oc = preReport.checks.find((c) => c.name === 'opencode')
      check(
        'opencode is not failing before start',
        oc?.status === 'ok' || oc?.status === 'warn',
        oc ? `${oc.status}: ${oc.detail}` : 'check absent',
      )

      const installCheck = preReport.checks.find((c) => c.name === 'install')
      check(
        'install channel',
        installCheck?.install?.channel === recipe.expect.channel,
        `reported ${installCheck?.install?.channel}, expected ${recipe.expect.channel}`,
        recipe.expect.channel,
      )
      const wanted = recipe.expect.upgradeCommand(process.platform)
      check(
        'upgrade command',
        installCheck?.install?.upgradeCommand === wanted,
        `reported "${installCheck?.install?.upgradeCommand}", expected "${wanted}"`,
      )
    }

    if (gateOnly) {
      log('\n  profile=gate: stopping before the daemon lifecycle.')
      return { ok: failures.length === 0, served }
    }

    if (opencodeMode === 'adopt') {
      heading('Pre-start an OpenCode for LoopTroop to adopt')
      adopted = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(opencodePort)], {
        stdio: 'ignore',
        detached: !IS_WINDOWS,
        shell: IS_WINDOWS,
      })
      const up = await waitForOpenCode(opencodePort)
      if (!check('adopted OpenCode is listening', up, `nothing on ${opencodePort}`)) return { ok: false, served }
    }

    heading('The daemon starts on the port it was given')
    if (!(await portIsFree(port))) {
      fail('port is free before start', `${port} is already held — this runner is dirty`)
      return { ok: false, served }
    }
    const started = cli(['start', '--port', String(port)])
    if (!check('start', started.code === 0, `exit ${started.code}: ${started.combined.trim().slice(-300)}`, `port ${port}`)) {
      return { ok: false, served }
    }

    heading('It answers on the health endpoint')
    const health = await waitForHealth(baseUrl)
    check('health status', health?.status === 'ok', `got ${JSON.stringify(health)}`)
    check('health instanceId', typeof health?.instanceId === 'string', 'no instanceId in the health payload')

    heading('It serves the interface, not just the API')
    // A release whose packed client is missing 404s here and nowhere else.
    const root = await fetch(baseUrl, { redirect: 'manual' })
    check('GET /', root.ok, `status ${root.status}`)
    const html = root.ok ? await root.text() : ''
    const asset = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1]
    if (asset) {
      const assetResponse = await fetch(`${baseUrl}${asset}`)
      check('a referenced asset is served', assetResponse.ok, `${asset} -> ${assetResponse.status}`)
    } else {
      fail('a referenced asset is served', 'no /assets/ reference in the served HTML')
    }

    heading('The API refuses an unauthenticated caller')
    // Proves this is LoopTroop answering, not something else that happened to
    // be listening on the port.
    const unauth = await fetch(`${baseUrl}/api/projects`)
    check('unauthenticated /api/projects', unauth.status === 401 || unauth.status === 403, `status ${unauth.status}`)

    heading('status agrees with the daemon')
    const status = cli(['status', '--json'])
    const statusReport = readJson(status.stdout, 'status --json')
    if (statusReport) {
      // The daemon facts are nested under `daemon`; the top level carries
      // `running`, `lastStartFailure` and an optional `update`. The token is
      // redacted there by `redactDaemonState`, which is why this can be logged.
      const daemon = statusReport.daemon ?? {}
      check('status reports running', statusReport.running === true, `running=${statusReport.running}`)
      check('status port', daemon.port === port, `reported ${daemon.port}, expected ${port}`, String(port))
      check(
        'status instanceId matches health',
        daemon.instanceId === health?.instanceId,
        `${daemon.instanceId} vs ${health?.instanceId}`,
      )
      check('status version', daemon.version === version, `reported ${daemon.version}, expected ${version}`, version)
    }

    heading('doctor, after start')
    // The point of installing a real OpenCode. Health answering proves the
    // daemon bound a port; only this proves OpenCode was actually launched or
    // adopted — the 0.5.7 `opencode.cmd` defect is exactly this check.
    const post = cli(['doctor', '--json'])
    const postReport = readJson(post.stdout, 'doctor --json (post-start)')
    if (postReport) {
      for (const name of recipe.expect.okChecksPost) {
        const found = postReport.checks.find((c) => c.name === name)
        check(`${name} is ok after start`, found?.status === 'ok', found ? `${found.status}: ${found.detail}` : 'absent')
      }
    }

    heading('The daemon state records the port it was asked for')
    const statePath = join(configDir, 'daemon.json')
    if (existsSync(statePath)) {
      const state = readJson(readFileSync(statePath, 'utf8'), 'daemon.json')
      check('daemon.json port', state?.port === port, `recorded ${state?.port}, expected ${port}`)
    } else {
      fail('daemon.json exists', statePath)
    }

    heading('It stops cleanly and leaves nothing behind')
    const stopped = cli(['stop'])
    check('stop', stopped.code === 0, `exit ${stopped.code}: ${stopped.combined.trim().slice(-200)}`)
    check('daemon port released', await portIsClosed(port), `${port} still answers`)
    // Checked before the scratch directory is removed: deleting it would hide
    // stale lifecycle state rather than prove it was cleaned up.
    check('daemon.json removed', !existsSync(join(configDir, 'daemon.json')), 'state file survived stop')
    check('daemon.lock removed', !existsSync(join(configDir, 'daemon.lock')), 'lock survived stop')

    // `status --json` exits 1 when nothing is running, which is the correct
    // answer here rather than an error.
    const afterStop = readJson(cli(['status', '--json']).stdout, 'status --json (after stop)')
    if (afterStop) check('status reports stopped', afterStop.running === false, `running=${afterStop.running}`)

    if (opencodeMode === 'adopt') {
      check('adopted OpenCode outlived the daemon', await openCodeAnswers(opencodePort), 'the adopted server was killed')
    } else if (opencodeMode !== 'mock') {
      check('managed OpenCode stopped with the daemon', await portIsClosed(opencodePort), `${opencodePort} still answers`)
    }

    heading('It uninstalls the way the documentation says')
    const removed = npm([...recipe.uninstall(), '--prefix', prefix], { cwd: elsewhere })
    check('uninstall', removed.code === 0, `exit ${removed.code}: ${removed.combined.trim().slice(-200)}`)
    check('the launcher is gone', !existsSync(shim()), `${shim()} survived uninstall`)

    return { ok: failures.length === 0, served }
  } finally {
    // Best effort, and never throws. `stop` is attempted even when start failed
    // or timed out: a half-started daemon still holds the port and the lock.
    try {
      runShim(shim(), ['stop'], { cwd: elsewhere, env: childEnv, timeout: 30_000 })
    } catch {
      // Nothing to stop.
    }
    if (adopted?.pid) {
      try {
        process.kill(IS_WINDOWS ? adopted.pid : -adopted.pid, 'SIGTERM')
      } catch {
        try {
          adopted.kill('SIGTERM')
        } catch {
          // Already gone.
        }
      }
    }
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // A held file on Windows is not worth failing a run over.
    }
  }
}

async function waitForOpenCode(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await openCodeAnswers(port)) return true
    await sleep(500)
  }
  return false
}

async function openCodeAnswers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/config`)
    // Any answer proves something is serving; a password-protected server
    // answers 401 and is still a running OpenCode.
    return response.status < 500
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Matrix planning. Derived from CHANNELS so the workflow and the recipes can
// never disagree about what exists.
// ---------------------------------------------------------------------------

export function planMatrix({ tier = 'release', only = [] } = {}) {
  const legs = []
  for (const [key, recipe] of Object.entries(CHANNELS)) {
    if (only.length > 0 && !only.includes(key)) continue
    if (recipe.stub) continue
    for (const leg of recipe.legs) {
      if (tier === 'release' && leg.tier !== 'release') continue
      legs.push({
        key,
        channel: key,
        os: leg.os,
        tier: leg.tier,
        opencode: leg.opencode,
        name: `${key} (${leg.os})`,
      })
    }
  }
  return legs
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    channel: null,
    version: null,
    pin: false,
    opencode: null,
    profile: 'full',
    tier: 'release',
    resultFile: null,
    plan: false,
    only: [],
  }
  const takesValue = new Set(['--channel', '--version', '--opencode', '--profile', '--tier', '--result-file', '--only'])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--pin') {
      options.pin = true
      continue
    }
    if (arg === '--plan') {
      options.plan = true
      continue
    }
    if (!takesValue.has(arg)) {
      // Unknown arguments are fatal. A typo that fell through would report a
      // pass for a channel nobody tested, which is worse than no test at all.
      throw new Error(`unknown argument: ${arg}`)
    }
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`${arg} needs a value`)
    i += 1
    if (arg === '--channel') options.channel = value
    else if (arg === '--version') options.version = value.replace(/^v/, '')
    else if (arg === '--opencode') options.opencode = value
    else if (arg === '--profile') options.profile = value
    else if (arg === '--tier') options.tier = value
    else if (arg === '--result-file') options.resultFile = value
    else if (arg === '--only') options.only = value.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    abort(String(error.message))
    return
  }

  if (!['full', 'gate'].includes(options.profile)) {
    abort(`--profile must be full or gate, got "${options.profile}"`)
    return
  }
  if (!['release', 'weekly', 'all'].includes(options.tier)) {
    abort(`--tier must be release, weekly or all, got "${options.tier}"`)
    return
  }

  if (options.plan) {
    const legs = planMatrix({ tier: options.tier, only: options.only })
    const payload = JSON.stringify({ include: legs })
    if (process.env.GITHUB_OUTPUT) {
      writeFileSync(process.env.GITHUB_OUTPUT, `matrix=${payload}\n`, { flag: 'a' })
    }
    log(`matrix=${payload}`)
    log(`\n${legs.length} leg(s) for tier "${options.tier}":`)
    for (const leg of legs) log(`  ${leg.name.padEnd(30)} tier=${leg.tier} opencode=${leg.opencode}`)
    return
  }

  const recipe = CHANNELS[options.channel]
  if (!recipe) {
    abort(`unknown channel "${options.channel}"`, `known: ${Object.keys(CHANNELS).join(', ')}`)
    return
  }
  recipe.key = options.channel

  // An absent --version resolves to the newest stable release. That is what
  // makes a push-triggered or scheduled run possible at all: neither carries a
  // workflow input. Everything else passes it explicitly.
  let version = options.version
  if (!version) {
    try {
      version = await latestStableVersion()
      log(`No --version given; resolved the latest stable release: ${version}`)
    } catch (error) {
      abort(`could not resolve the latest stable release: ${error.message}`)
      return
    }
  }

  if (options.pin && recipe.pinnable === false) {
    log(`\n${recipe.key}: not run (--pin; this channel serves one version at a time)`)
    return
  }

  const opencodeMode = options.opencode ?? 'installer'
  log(`\nChannel ${recipe.key} | version ${version} | profile ${options.profile} | opencode ${opencodeMode}`)
  log(`Documented command: ${recipe.documented}`)

  const startedAt = Date.now()
  let result = { ok: false, served: null }
  try {
    result = await runChannel(recipe, { version, pin: options.pin, profile: options.profile, opencodeMode })
  } catch (error) {
    fail('unexpected error', error?.stack ?? String(error))
  }

  const summary = {
    channel: recipe.key,
    os: process.platform,
    arch: process.arch,
    version,
    served: result.served,
    profile: options.profile,
    ok: result.ok && failures.length === 0,
    failures,
    durationMs: Date.now() - startedAt,
  }

  if (options.resultFile) {
    try {
      writeFileSync(options.resultFile, `${redact(JSON.stringify(summary, null, 2))}\n`)
    } catch (error) {
      log(`  (could not write ${options.resultFile}: ${error.message})`)
    }
  }

  log('')
  if (summary.ok) {
    const did = options.profile === 'gate'
      ? 'installs and reports itself correctly from its published feed'
      : 'installs, serves and uninstalls from its published feed'
    log(`PASS: ${recipe.key} ${version} ${did}.`)
  } else {
    log(`FAIL: ${recipe.key} ${version} — ${failures.length} assertion(s) failed:`)
    for (const entry of failures) log(`  - ${entry}`)
    process.exitCode = 1
  }
}

// `--plan` is importable for tests; running the file drives a channel.
if (process.argv[1] && process.argv[1].endsWith('smoke-published.mjs')) {
  await main()
}
