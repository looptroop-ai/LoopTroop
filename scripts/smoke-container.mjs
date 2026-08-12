#!/usr/bin/env node
/**
 * Drives the container image the way a user would run it, from inside the
 * container.
 *
 * The install smoke test next door proves the tarball works when a person
 * installs it. This proves the image works, which is a different set of claims:
 * that the CLI knows it is in a container and offers `docker pull` rather than
 * `npm install -g`, that the daemon comes up as uid 1000 with an owner-only
 * config directory on a named volume, that the API is still closed without
 * credentials, that git and gh are actually present, and that `docker stop`
 * gets a graceful exit rather than a SIGKILL.
 *
 *   node scripts/smoke-container.mjs --image looptroop:smoke
 *   node scripts/smoke-container.mjs --image ghcr.io/…/looptroop@sha256:… --version 9.9.9
 *
 * Everything runs inside the container, over `docker exec`. Nothing is requested
 * from the host: the daemon binds the container's own loopback on purpose, so a
 * test that published a port and talked to it would be exercising
 * LOOPTROOP_ALLOW_REMOTE_API — the escape hatch — instead of the default anyone
 * gets.
 *
 * Every container start passes LOOPTROOP_OPENCODE_MODE=mock. The image ships
 * without OpenCode deliberately, and a missing OpenCode is fatal before the API
 * binds, so a start left on the default `live` would never become healthy and
 * every assertion below would fail for one uninteresting reason.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures = []
let step = 0

/**
 * Secrets learned during the run, so the diagnostic dumps below cannot be the
 * thing that leaks them. A failing run prints container logs, and the whole
 * point of one of the assertions is that a token must never appear there — a
 * dump that printed it anyway would defeat the check it exists to support.
 */
const secrets = []

function redact(text) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('«redacted»')
  }
  return out.replace(/#bootstrap=[^\s"']+/g, '#bootstrap=«redacted»')
}

function log(message) {
  process.stdout.write(`${message}\n`)
}

function pass(name, detail = '') {
  log(`  ok    ${name}${detail ? `  (${redact(detail)})` : ''}`)
}

function fail(name, detail) {
  failures.push(`${name}: ${redact(detail)}`)
  log(`  FAIL  ${name}  (${redact(detail)})`)
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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Runs docker and captures both streams. Never throws on a non-zero exit: exit
 * codes are part of what is being asserted, so the checks read them.
 *
 * `input` is how a secret gets into the container without ever appearing in an
 * argument vector — neither the host's (visible in `ps`) nor the container's.
 */
function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  if (result.error) {
    return { code: null, stdout: '', stderr: String(result.error.message), combined: String(result.error.message) }
  }
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    combined: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
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
 * An unrecognised argument is fatal rather than ignored: the release passes the
 * registry reference it just published, and a typo silently falling back to a
 * locally built tag would report a pass for bytes nobody looked at.
 */
function parseArgs(argv) {
  let image = 'looptroop:smoke'
  let version = ''
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const take = (name) => {
      const value = argv[i + 1] ?? ''
      i += 1
      if (value.trim() === '') throw new Error(`${name} needs a value`)
      return value
    }
    if (arg === '--image') image = take('--image')
    else if (arg.startsWith('--image=')) image = arg.slice('--image='.length)
    else if (arg === '--version') version = take('--version')
    else if (arg.startsWith('--version=')) version = arg.slice('--version='.length)
    else throw new Error(`unknown argument ${JSON.stringify(arg)} (expected --image <ref> [--version <x.y.z>])`)
  }
  if (image.trim() === '') throw new Error('--image needs a reference')
  return { image, version }
}

// A usage mistake gets one line, not a stack trace: the reader needs the flag
// they got wrong, and nothing in a Node internals trace tells them that.
let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  log(`${error instanceof Error ? error.message : String(error)}`)
  log('usage: node scripts/smoke-container.mjs [--image <ref>] [--version <x.y.z>]')
  process.exit(2)
}

const repoRoot = process.cwd()
const expectedVersion = options.version
  || JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version

// Unique per run so two legs of a matrix on one runner, or a leftover from a
// killed run, cannot collide.
const suffix = randomUUID().slice(0, 8)
const container = `looptroop-smoke-${suffix}`
const volume = `looptroop-smoke-${suffix}`
const scratch = join(tmpdir(), `looptroop-container-smoke-${suffix}`)
const projectDir = join(scratch, 'project')
const hostConfigDir = join(scratch, 'config')

/** Best effort, from `finally`: never allowed to mask the real failure. */
function cleanup() {
  docker(['rm', '--force', '--volumes', container])
  docker(['volume', 'rm', '--force', volume])
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // A file the container left root-owned is not a test failure.
  }
}

/** Everything the diagnostics need when a start does not reach healthy. */
function dumpStartFailure() {
  const logs = docker(['logs', '--tail', '80', container])
  log('\n  --- container logs (last 80 lines) ---')
  log(redact(logs.combined).replace(/^/gm, '  '))
  const health = docker(['inspect', '--format', '{{json .State.Health}}', container])
  log('  --- healthcheck state ---')
  log(redact(health.combined).replace(/^/gm, '  '))
  const state = docker(['inspect', '--format', '{{.State.Status}} exit={{.State.ExitCode}}', container])
  log(`  --- state: ${state.stdout.trim()}`)
}

/**
 * Waits for Docker's own verdict rather than for a port.
 *
 * The HEALTHCHECK in the image is what an orchestrator acts on, so asserting on
 * it tests the thing users depend on. It first probes one interval after start,
 * which is why the deadline here is generous: this is not measuring startup.
 */
async function waitForHealthy(label, deadlineMs = 180_000) {
  const deadline = Date.now() + deadlineMs
  let last = ''
  while (Date.now() < deadline) {
    const state = docker([
      'inspect', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
      container,
    ])
    last = state.stdout.trim()
    const [status, health] = last.split('|')
    if (health === 'healthy') return true
    // A container that exited will never become healthy; waiting out the
    // deadline would only turn a clear failure into a slow one.
    if (status === 'exited' || status === 'dead') break
    await sleep(2_000)
  }
  fail(label, `never became healthy (state ${last || 'unknown'})`)
  dumpStartFailure()
  return false
}

/** `docker exec` with no shell in between, so arguments stay as written. */
function exec(args, options = {}) {
  return docker(['exec', container, ...args], options)
}

/** `docker exec` through sh, for the cases that need env expansion or a test. */
function execSh(script, options = {}) {
  return docker(['exec', container, 'sh', '-c', script], options)
}

/**
 * Where the image keeps its config directory, read off the image rather than
 * hardcoded: the Dockerfile is free to move it, and a stale constant here would
 * make the volume assertions test an empty path that happens to be writable.
 */
let configDirInImage = '/home/node/.looptroop'

/** A one-shot `docker run --rm`, with the volume and mock mode already set. */
function runOnce(args, { withVolume = true, entrypoint = null, env = {} } = {}) {
  return docker([
    'run', '--rm',
    ...(entrypoint ? ['--entrypoint', entrypoint] : []),
    '-e', 'LOOPTROOP_OPENCODE_MODE=mock',
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    ...(withVolume ? ['-v', `${volume}:${configDirInImage}`] : []),
    options.image,
    ...args,
  ])
}

// Probed before anything else and reported on its own, because "no Docker here"
// is not a finding about the image and must not be summarised as one.
const dockerVersion = docker(['version', '--format', '{{.Server.Version}}'])
if (dockerVersion.code !== 0) {
  log('This test needs a working Docker daemon, and there is not one here:')
  log(`  ${dockerVersion.combined.trim().split('\n')[0] || 'docker did not run'}`)
  log('\nNothing about the image was checked. Run it where Docker is available.')
  process.exit(1)
}
log(`Docker server ${dockerVersion.stdout.trim()}, image ${options.image}`)

try {
  heading('The image is present and describes itself')
  const inspected = docker(['image', 'inspect', '--format', '{{json .Config}}', options.image])
  if (!check('the image exists locally', inspected.code === 0, options.image)) {
    throw new Error(`cannot inspect ${options.image} — build it first, or pull it`)
  }
  const config = readJson(inspected.stdout, 'docker image inspect')
  if (config === null) throw new Error('cannot read the image config')

  const labels = config.Labels ?? {}
  // Every label the Dockerfile declares, asserted by name: `source` is what makes
  // GHCR attach the package to the repository, and a registry page with no
  // description or licence is the kind of omission nobody notices for months.
  const expectedLabels = {
    'org.opencontainers.image.title': (value) => value === 'LoopTroop',
    'org.opencontainers.image.description': (value) => value.length > 20,
    'org.opencontainers.image.source': (value) => value === 'https://github.com/looptroop-ai/LoopTroop',
    'org.opencontainers.image.url': (value) => value.startsWith('https://'),
    'org.opencontainers.image.licenses': (value) => value === 'MIT',
    'org.opencontainers.image.version': (value) => value === expectedVersion,
    'org.opencontainers.image.revision': (value) => /^[0-9a-f]{7,40}$/.test(value),
  }
  for (const [name, accept] of Object.entries(expectedLabels)) {
    const value = typeof labels[name] === 'string' ? labels[name] : ''
    check(`label ${name}`, value !== '' && accept(value), value || 'missing or empty')
  }

  const env = Array.isArray(config.Env) ? config.Env : []
  check('LOOPTROOP_CONTAINER=1 is baked in', env.includes('LOOPTROOP_CONTAINER=1'),
    'the marker the CLI reads to know it is containerised')
  const configDirEntry = env.find((entry) => entry.startsWith('LOOPTROOP_CONFIG_DIR='))
  if (check('LOOPTROOP_CONFIG_DIR is set', configDirEntry !== undefined, configDirEntry ?? 'absent')) {
    configDirInImage = configDirEntry.slice('LOOPTROOP_CONFIG_DIR='.length)
  }
  check('the image runs as uid 1000, not root', config.User === 'node' || config.User === '1000',
    `User=${config.User || '(root)'}`)

  heading('The CLI runs without a daemon')
  const version = docker(['run', '--rm', options.image, '--version'])
  check('--version matches the packed version', version.stdout.trim() === expectedVersion,
    `${version.stdout.trim() || '(nothing)'} vs ${expectedVersion}`)

  heading('A volume that remembers the wrong channel is corrected')
  const created = docker(['volume', 'create', volume])
  check('a named config volume is created', created.code === 0, created.stdout.trim() || created.stderr.trim())
  // No `path` in the record, which is the hardest case: that shape is a
  // deliberate hand-written pin, and it is the one the resolver would otherwise
  // honour wherever the files live. A config volume filled by a global npm
  // install before it was ever mounted here looks exactly like this.
  const seeded = runOnce(
    ['-c', `printf '%s' '{"install":{"channel":"npm"}}' > "$LOOPTROOP_CONFIG_DIR/config.json"`],
    { entrypoint: 'sh' },
  )
  check('the stale npm record is seeded', seeded.code === 0, seeded.stderr.trim() || 'written')

  const doctor = runOnce(['doctor', '--json'])
  const doctorJson = readJson(doctor.stdout, 'doctor --json')
  const install = doctorJson?.checks?.find((entry) => entry.name === 'install')
  check('doctor reports the container channel', install?.detail?.startsWith('container') === true,
    install?.detail ?? 'no install check in the report')
  check('the upgrade command is the docker one', (install?.detail ?? '').includes('docker pull looptroopai/looptroop'),
    install?.detail ?? 'no install check in the report')
  const rewritten = runOnce(['-c', 'cat "$LOOPTROOP_CONFIG_DIR/config.json"'], { entrypoint: 'sh' })
  const rewrittenRecord = rewritten.code === 0
    ? readJson(rewritten.stdout, 'config.json in the volume')?.install
    : null
  // Reported as ignored-versus-corrected because those are different bugs: the
  // resolver answering `container` while the volume still says `npm` would work
  // today and regress the moment the short-circuit order changed.
  check('the stale record was rewritten, not merely ignored',
    rewrittenRecord?.channel === 'container' && typeof rewrittenRecord?.path === 'string',
    `install.channel=${rewrittenRecord?.channel ?? 'absent'}, path ${rewrittenRecord?.path ? 'recorded' : 'absent'}`)

  heading('The daemon starts and Docker calls it healthy')
  const started = docker([
    'run', '--detach',
    '--name', container,
    // The whole reason this script exists as a container test: no published
    // port, so everything below has to go through the container itself.
    '-e', 'LOOPTROOP_OPENCODE_MODE=mock',
    '-v', `${volume}:${configDirInImage}`,
    options.image,
  ])
  if (!check('docker run --detach succeeds', started.code === 0, started.stderr.trim() || started.stdout.trim().slice(0, 12))) {
    throw new Error('the container did not start')
  }
  if (!await waitForHealthy('the container reaches healthy')) {
    throw new Error('the container never became healthy')
  }

  heading('The daemon record is owner-only and holds a usable token')
  const modes = execSh('stat -c "%a" "$LOOPTROOP_CONFIG_DIR" "$LOOPTROOP_CONFIG_DIR/daemon.json"')
  const [dirMode, fileMode] = modes.stdout.trim().split('\n')
  // Checked after start rather than off the image: the daemon creates
  // daemon.json itself, and a volume Docker populated from the image can only
  // prove what the build did.
  check('the config directory is owner-only', dirMode === '700', `mode ${dirMode ?? '?'}`)
  check('daemon.json is owner-only', fileMode === '600', `mode ${fileMode ?? '?'}`)

  const record = execSh('cat "$LOOPTROOP_CONFIG_DIR/daemon.json"')
  const daemonState = readJson(record.stdout, 'daemon.json')
  const apiToken = typeof daemonState?.apiToken === 'string' ? daemonState.apiToken : ''
  secrets.push(apiToken)
  const port = Number.isInteger(daemonState?.port) ? daemonState.port : 3000
  // Compared against the real token, never a fallback: a nullish one would make
  // the leak check below unfindable and it would report ok without having looked.
  check('daemon.json carries an API token', apiToken.length > 0,
    apiToken.length > 0 ? `${apiToken.length} chars` : 'absent, so the checks below cannot run')
  check('the token is safe to put in a curl config', /^[A-Za-z0-9_-]+$/.test(apiToken),
    'base64url, so no quoting hazard')

  const uid = exec(['id', '-u'])
  check('the daemon runs as uid 1000', uid.stdout.trim() === '1000', `uid ${uid.stdout.trim() || '?'}`)

  heading('The API answers inside the container and is closed without credentials')
  const health = exec(['curl', '-fsS', `http://127.0.0.1:${port}/api/health`])
  const healthJson = health.code === 0 ? readJson(health.stdout, '/api/health') : null
  check('/api/health answers', healthJson?.status === 'ok', `status=${healthJson?.status ?? `exit ${health.code}`}`)

  const anonymous = exec([
    'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
    `http://127.0.0.1:${port}/api/projects`,
  ])
  check('an unauthenticated API call is rejected', ['401', '403'].includes(anonymous.stdout.trim()),
    `status ${anonymous.stdout.trim() || `exit ${anonymous.code}`}`)

  // The token arrives on stdin as a curl config, so it is in neither argument
  // vector — not the host's, where `ps` would show it to any local user, and not
  // the container's. This is also why the request is made with curl rather than
  // by publishing a port and using fetch from here.
  const authorized = docker(['exec', '--interactive', container, 'curl', '--config', '-'], {
    input: [
      `url = "http://127.0.0.1:${port}/api/projects"`,
      `header = "x-looptroop-token: ${apiToken}"`,
      'silent',
      'output = "/dev/null"',
      'write-out = "%{http_code}"',
      '',
    ].join('\n'),
  })
  check('the recorded token opens the API', authorized.stdout.trim() === '200',
    `status ${authorized.stdout.trim() || `exit ${authorized.code}`}`)

  heading('The tools the workflow drives are present')
  const git = exec(['git', '--version'])
  check('git works', git.code === 0 && /^git version/.test(git.stdout), git.stdout.trim() || `exit ${git.code}`)
  const gh = exec(['gh', '--version'])
  check('gh works', gh.code === 0 && /gh version/.test(gh.stdout), gh.stdout.trim().split('\n')[0] ?? `exit ${gh.code}`)

  heading('Only the published package is in the image')
  // `files` is an allowlist, and a mispack that shipped the source tree would
  // pass every other check in CI. The install prefix is the one place to look.
  const devTree = execSh('test ! -e /opt/looptroop/lib/node_modules/looptroop/server')
  check('no source tree beside the installed package', devTree.code === 0,
    devTree.code === 0 ? 'server/ absent' : 'server/ present in the install prefix')

  heading('No secret reached the container log')
  const logs = docker(['logs', container])
  check('the log holds no API token', apiToken.length > 0 && !logs.combined.includes(apiToken),
    'token absent from docker logs')
  check('the log holds no sign-in URL', !/#bootstrap=/.test(logs.combined), 'no bootstrap nonce in docker logs')
  check('the log holds no session cookie', !/looptroop_session=/.test(logs.combined), 'no session cookie in docker logs')

  heading('A restart keeps the recorded channel')
  const restarted = docker(['restart', '--time', '25', container])
  check('docker restart succeeds', restarted.code === 0, restarted.stderr.trim() || 'restarted')
  if (await waitForHealthy('the container reaches healthy again')) {
    const again = exec(['looptroop', 'doctor', '--json'])
    const againInstall = readJson(again.stdout, 'doctor --json after restart')
      ?.checks?.find((entry) => entry.name === 'install')
    check('doctor still reports the container channel', againInstall?.detail?.startsWith('container') === true,
      againInstall?.detail ?? 'no install check in the report')
  }

  // Only meaningful where the host uid is neither 0 nor 1000, which is the case
  // on a GitHub runner. Elsewhere it still proves the invocation works.
  heading('A bind-mounted checkout is usable with the documented remediation')
  if (typeof process.getuid !== 'function') {
    log('  skip  not a POSIX host, so there is no uid to mismatch')
  } else {
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(hostConfigDir, { recursive: true })
    writeFileSync(join(projectDir, 'README.md'), '# smoke\n')
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
    for (const args of [
      ['init', '-b', 'main', projectDir],
      ['-C', projectDir, 'add', 'README.md'],
      ['-C', projectDir, '-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke', 'commit', '-m', 'init'],
    ]) {
      spawnSync('git', args, { encoding: 'utf8', env: gitEnv })
    }
    const asHost = [
      'run', '--rm',
      '--user', `${process.getuid()}:${process.getgid()}`,
      '-e', 'LOOPTROOP_OPENCODE_MODE=mock',
      '-e', 'LOOPTROOP_CONFIG_DIR=/workspace/.looptroop',
      // git and the CLI both look for a home; /home/node belongs to uid 1000.
      '-e', 'HOME=/tmp',
      '-v', `${projectDir}:/workspace/project`,
      '-v', `${hostConfigDir}:/workspace/.looptroop`,
    ]
    const status = docker([...asHost, '--entrypoint', 'git', options.image, '-C', '/workspace/project', 'status', '--porcelain'])
    check('git accepts the mounted checkout', status.code === 0 && !/dubious ownership/.test(status.combined),
      status.code === 0 ? 'no ownership complaint' : status.stderr.trim().split('\n')[0] ?? `exit ${status.code}`)
    const redirected = docker([...asHost, options.image, 'doctor', '--json'])
    const redirectedInstall = readJson(redirected.stdout, 'doctor --json with a redirected config dir')
      ?.checks?.find((entry) => entry.name === 'install')
    check('the CLI runs with the config directory redirected',
      redirectedInstall?.detail?.startsWith('container') === true,
      redirectedInstall?.detail ?? 'no install check in the report')
    check('it wrote to the redirected directory, not the volume',
      existsSync(join(hostConfigDir, 'config.json')), 'config.json on the bind mount')
  }

  heading('docker stop is a graceful shutdown, not a kill')
  const stopStarted = Date.now()
  const stopped = docker(['stop', '--time', '25', container])
  const stopElapsed = Date.now() - stopStarted
  check('docker stop succeeds', stopped.code === 0, stopped.stderr.trim() || `${Math.round(stopElapsed / 1000)}s`)
  const exitCode = docker(['inspect', '--format', '{{.State.ExitCode}}', container]).stdout.trim()
  // 137 is SIGKILL: the daemon ignored SIGTERM and Docker ran out of patience,
  // which means an orchestrator restarting it would be truncating its shutdown
  // every time — mid-write to the database, in the worst case.
  check('the daemon exited on SIGTERM rather than being killed', exitCode === '0',
    `exit code ${exitCode || '?'}${exitCode === '137' ? ' (SIGKILL after the grace window)' : ''}`)
  check('it shut down inside the grace window', stopElapsed < 25_000, `${(stopElapsed / 1000).toFixed(1)}s`)
} catch (error) {
  fail('container smoke test', error instanceof Error ? error.message : String(error))
} finally {
  cleanup()
}

log(`\n${'-'.repeat(60)}`)
if (failures.length > 0) {
  log(`FAIL: ${failures.length} problem(s) with ${options.image}.\n`)
  for (const failure of failures) log(`  ${failure}`)
  log('\nThese are defects a user would hit on `docker run`. Neither the unit')
  log('tests nor the install smoke test can show them: one never builds an')
  log('image, and the other installs the tarball on the host.')
  process.exit(1)
}
log(`PASS: ${options.image} started as uid 1000 on a named volume, became`)
log('healthy, served an authenticated API on its own loopback, reported the')
log('container upgrade channel, and shut down cleanly on SIGTERM.')
