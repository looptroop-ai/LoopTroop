#!/usr/bin/env node
/**
 * Installs a real standalone executable with `installer-core.mjs --binary`,
 * upgrades over it while the daemon is running, and checks what survived.
 *
 *   node scripts/smoke-binary-install.mjs --archive dist-binary/looptroop-9.9.9-linux-x64.tar.gz
 *
 * `tests/installer.test.ts` proves the transaction against a shell script
 * standing in for the executable, which is enough for the decisions and the
 * rollback but cannot be enough for the rest: a shell script is not a 110 MB
 * signed Mach-O, is not a file Windows refuses to overwrite while it runs, and
 * unpacks from a tarball rather than from the zip that Windows actually ships.
 * Every one of those has already produced a defect in this project. So this
 * runs the real thing, on all four targets, from a fixture release served on
 * loopback — the same trick the Homebrew, Scoop and WinGet smokes use.
 *
 * The upgrade-over-a-running-daemon case is the reason this exists at all. It
 * is where Windows refuses to replace a running executable, and where a
 * half-finished installer leaves somebody with no working LoopTroop at the
 * exact moment they were using one.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORE = join(repoRoot, 'scripts', 'installer-core.mjs')
const IS_WINDOWS = process.platform === 'win32'
const EXE = IS_WINDOWS ? '.exe' : ''

class SmokeError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'SmokeError'
    this.detail = detail
  }
}

function fail(message, ...detail) {
  throw new SmokeError(message, detail.filter(Boolean))
}

function log(message) {
  process.stdout.write(`${message}\n`)
}

function flag(name) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`--${name} is required.`)
  return value
}

/**
 * Always async, never `spawnSync`: this process is also the HTTP server the
 * installer downloads from, so a synchronous child deadlocks and surfaces as a
 * network timeout rather than as a hang.
 */
function invoke(command, args, options = {}) {
  return new Promise((settle, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...options.env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 && options.allowFailure !== true) {
        reject(new SmokeError(`${command} ${args.join(' ')} exited ${String(code)}.`, [stdout, stderr]))
        return
      }
      settle({ code, stdout, stderr })
    })
  })
}

const archivePath = resolve(flag('archive'))
if (!existsSync(archivePath)) fail(`No archive at ${archivePath}.`)

const archiveName = basename(archivePath)
// Anchored on the platform tag rather than stopping at the first hyphen: a
// prerelease version contains hyphens of its own.
const parsed = /^looptroop-(.+)-((?:linux|darwin|win)-(?:x64|arm64))\.(?:tar\.gz|zip)$/.exec(archiveName)
if (parsed === null) fail(`Cannot read a version and target out of ${archiveName}.`)
const [, version, target] = parsed

const body = readFileSync(archivePath)
const sha256 = createHash('sha256').update(body).digest('hex')

const work = mkdtempSync(join(tmpdir(), 'looptroop-binary-install-'))
const prefix = join(work, 'prefix')
const configDir = join(work, 'config')
const installed = join(prefix, 'bin', `looptroop${EXE}`)

const childEnv = { LOOPTROOP_CONFIG_DIR: configDir, LOOPTROOP_OPENCODE_MODE: 'mock' }

/**
 * A release index shaped like the real one, carrying this archive and a
 * manifest that records its checksum.
 *
 * The manifest is the point: `--binary` refuses an archive it has no recorded
 * digest for, so serving one without the other would prove nothing about the
 * happy path.
 */
const TAG = `v${version}`
/**
 * A release from before the executables existed, which is not a hypothetical:
 * every release up to 0.5.1 is one, and `--binary` has to refuse them by name
 * rather than by whatever the download of a missing file happens to return.
 */
const OLD_TAG = 'v0.0.1'
const manifest = {
  name: 'looptroop',
  version,
  tarball: `looptroop-${version}.tgz`,
  bytes: 0,
  sha256: '',
  assets: { [archiveName]: { bytes: body.length, sha256 } },
}

let origin = ''

function release(tag, names) {
  return {
    tag_name: tag,
    assets: names.map((name) => ({ name, browser_download_url: `${origin}/download/${tag}/${name}` })),
  }
}

function releaseIndex() {
  return [
    release(TAG, ['release-manifest.json', archiveName]),
    release(OLD_TAG, ['release-manifest.json', 'looptroop-0.0.1.tgz']),
  ]
}

const server = createServer((request, response) => {
  const path = request.url ?? '/'

  if (path.includes('/releases?') || path.endsWith('/releases')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(releaseIndex()))
    return
  }

  const tagged = /\/releases\/tags\/(v[^/?]+)/.exec(path)
  if (tagged !== null) {
    const found = releaseIndex().find((candidate) => candidate.tag_name === tagged[1])
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(found ?? {}))
    return
  }
  if (path.endsWith('/release-manifest.json')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(manifest))
    return
  }
  if (path.endsWith(`/${archiveName}`)) {
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    createReadStream(archivePath).pipe(response)
    return
  }

  response.writeHead(404).end('{}')
})

function install(extraArgs = []) {
  return invoke(process.execPath, [CORE, '--binary', '--prefix', prefix, ...extraArgs], {
    env: {
      ...childEnv,
      LOOPTROOP_INSTALL_API: origin,
      // A real token in the ambient environment would otherwise be sent to a
      // fixture server on localhost.
      GITHUB_TOKEN: '',
      GH_TOKEN: '',
    },
  })
}

async function daemonIsRunning() {
  const status = await invoke(installed, ['status', '--json'], { env: childEnv, allowFailure: true })
  try {
    return JSON.parse(status.stdout).running === true
  } catch {
    return false
  }
}

async function main() {
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${server.address().port}`
  log(`Serving a fixture release for ${version} (${target}) at ${origin}\n`)

  // --- a first install, into nothing -------------------------------------

  log('Installing...')
  const first = await install()
  if (!first.stdout.includes(`Verified sha256 ${sha256}`)) {
    fail('The installer did not report verifying the archive.', first.stdout)
  }
  if (!statSync(installed, { throwIfNoEntry: false })?.isFile()) {
    fail(`Nothing was installed at ${installed}.`, first.stdout, first.stderr)
  }

  const reported = (await invoke(installed, ['--version'], { env: childEnv })).stdout.trim()
  if (reported !== version) fail(`The installed executable reports ${reported || '(nothing)'}, expected ${version}.`)
  log(`  installed at ${installed}, and it reports ${version}`)

  // Shipping this archive redistributes Node, and Node's licence has to travel
  // with it. Beside the program rather than in the directory that goes on PATH.
  for (const file of ['LICENSE', 'LICENSE.node.txt', 'THIRD-PARTY-NOTICES.md']) {
    if (!existsSync(join(prefix, file))) fail(`${file} was not installed beside the executable.`)
  }
  log('  the licences it must redistribute came with it')

  const leftovers = readdirSync(join(prefix, 'bin')).filter((entry) => entry !== `looptroop${EXE}`)
  if (leftovers.length > 0) fail('The install left staging files behind.', leftovers.join(', '))
  if (existsSync(join(prefix, '.install.lock'))) fail('The install left its lock behind.')
  log('  no staging files and no lock left behind')

  const doctor = await invoke(installed, ['doctor', '--json'], { env: childEnv, allowFailure: true })
  let checks
  try {
    checks = JSON.parse(doctor.stdout).checks
  } catch {
    fail('`doctor --json` did not produce parseable JSON.', `${doctor.stdout}${doctor.stderr}`.slice(0, 2000))
  }
  const detail = checks.find((check) => check.name === 'install')?.detail ?? ''
  if (!/^binary\b/.test(detail)) {
    fail('`doctor` does not report this as a binary install.', `It reports: ${detail || '(no install check)'}`)
  }
  log(`  \`doctor\` reports the binary channel: ${detail}`)

  // --- an upgrade, over a running daemon ---------------------------------
  //
  // The case the whole transaction exists for. On Windows this is where the
  // executable cannot be overwritten while it runs; everywhere it is where a
  // careless installer leaves a live old daemon reporting a new version.

  log('\nStarting the daemon, then installing over it...')
  await invoke(installed, ['start'], { env: childEnv })
  if (!await daemonIsRunning()) fail('The daemon did not start, so the upgrade case cannot be exercised.')

  const upgrade = await install()
  try {
    if (!upgrade.stdout.includes('Stopping the running daemon')) {
      fail('The installer replaced the executable without stopping the daemon.', upgrade.stdout)
    }
    if (!upgrade.stdout.includes('Starting it again')) {
      fail('The installer stopped the daemon and did not start it again.', upgrade.stdout)
    }
    log('  stopped the daemon, swapped the executable, started it again')

    if (!await daemonIsRunning()) fail('The daemon is not running after the upgrade.')
    log('  the daemon is running again')

    const after = (await invoke(installed, ['--version'], { env: childEnv })).stdout.trim()
    if (after !== version) fail(`After the upgrade the executable reports ${after || '(nothing)'}.`)
    log(`  the executable still reports ${version}`)

    const stillLeftovers = readdirSync(join(prefix, 'bin')).filter((entry) => entry !== `looptroop${EXE}`)
    if (stillLeftovers.length > 0) fail('The upgrade left files behind.', stillLeftovers.join(', '))
    log('  and the previous copy was cleaned up')
  } finally {
    await invoke(installed, ['stop'], { env: childEnv, allowFailure: true })
  }

  // --- a refusal ----------------------------------------------------------

  const pinned = await install(['--version', OLD_TAG.replace(/^v/, '')])
    .then(() => null)
    .catch((error) => error)
  if (pinned === null) fail('Installing a version the fixture does not carry was expected to fail.')
  if (!`${pinned.detail?.join('') ?? ''}`.includes('carries no')) {
    fail('A release without an executable for this target was refused with the wrong message.', ...(pinned.detail ?? []))
  }
  log('\n  a release carrying no executable for this target is refused by name')

  log(`\nPASS: \`--binary\` installs ${archiveName}, upgrades over a running daemon, `
    + 'and leaves a working install behind.')
}

try {
  await main()
} catch (error) {
  if (!(error instanceof SmokeError)) throw error
  process.stderr.write(`\nFAIL: ${error.message}\n`)
  for (const line of error.detail ?? []) process.stderr.write(`  ${line}\n`)
  process.stderr.write('\n')
  process.exitCode = 1
} finally {
  server.close()
  rmSync(work, { recursive: true, force: true })
}
