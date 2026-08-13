#!/usr/bin/env node
/**
 * Installs LoopTroop through a package channel, for real, from a throwaway
 * tap or bucket pointing at a locally served bundle.
 *
 *   node scripts/smoke-channel.ts --channel homebrew --bundle looptroop-9.9.9-bundle.tar.gz
 *   node scripts/smoke-channel.ts --channel scoop    --bundle looptroop-9.9.9-bundle.tar.gz
 *
 * Rendering a formula and checking its text proves the text. What it cannot
 * prove is that `brew install` produces a working command — and every mistake
 * available here is of that kind: a keg-only Node that leaves the shebang
 * unresolvable, an `extract_dir` naming a directory the archive does not
 * contain, a shim pointing at a script Windows cannot execute. So this installs
 * it and runs it.
 *
 * Against a local HTTP server rather than a published release, because the
 * point is to test the descriptor before a release exists — and against a
 * throwaway tap and bucket, never the public ones, which a prerelease must not
 * touch.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Channel } from './package-manifests.ts'
import { renderDescriptor } from './package-manifests.ts'
import { createLocalTap, removeLocalTap } from './brew-local-tap.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A tap name nobody publishes to, so a mistake here cannot reach users. */
const LOCAL_TAP = 'looptroop-ai/smoketest' as const

/**
 * Thrown rather than exited, so the HTTP server below is always closed and the
 * message always reaches the log. `process.exit()` with an open handle skips
 * every `finally` and, on Windows, can end the process with a crash code
 * instead of the one that was asked for.
 */
class SmokeError extends Error {
  // Declared and assigned rather than written as a constructor parameter
  // property: this file is run by bare `node`, whose type stripping rejects
  // that syntax outright. Vitest compiles with esbuild and accepts it, so the
  // difference only appears in CI.
  detail: string[]

  constructor(message: string, detail: string[]) {
    super(message)
    this.name = 'SmokeError'
    this.detail = detail
  }
}

function fail(message: string, ...detail: string[]): never {
  throw new SmokeError(message, detail.filter(Boolean))
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`--${name} is required.`)
  return value
}

interface RunResult { status: number | null, stdout: string, stderr: string }

/**
 * Asynchronous, and without a shell.
 *
 * Asynchronous because the package manager downloads the bundle from a server
 * running *in this process*: `spawnSync` blocks the event loop, so the request
 * could never be answered and `scoop install` sat there until it reported "the
 * operation has timed out".
 *
 * Without a shell because everything invoked here is a real executable —
 * `brew`, `pwsh`, a shim — so a shell buys nothing and costs correctness: on
 * Windows `shell: true` hands the whole line to `cmd.exe`, which re-parses it,
 * and a PowerShell script block full of `&` and `{` does not survive that.
 */
function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv, allowFailure?: boolean } = {}): Promise<RunResult> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...options.env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => reject(new SmokeError(`${command} could not be started.`, [String(error)])))
    child.on('close', (status) => {
      if (status !== 0 && options.allowFailure !== true) {
        reject(new SmokeError(`${command} ${args.join(' ')} exited ${status}.`, [stdout, stderr].filter(Boolean)))
        return
      }
      done({ status, stdout, stderr })
    })
  })
}

/** `scoop` is a PowerShell command, so it can only be reached through pwsh. */
function pwsh(script: string, options: { env?: NodeJS.ProcessEnv, allowFailure?: boolean } = {}): Promise<RunResult> {
  return run('pwsh', ['-NoProfile', '-Command', script], options)
}

/**
 * Runs an installed command, whatever kind of file the channel made it.
 *
 * On Windows the shim is a `.cmd`, which Node cannot execute without a shell —
 * and handing the line to `cmd.exe` is what broke this job the first time. So
 * PowerShell runs it instead, with the path and every argument quoted here
 * rather than left to a parser.
 */
function invoke(commandPath: string, args: string[], options: { env?: NodeJS.ProcessEnv, allowFailure?: boolean }): Promise<RunResult> {
  if (process.platform !== 'win32') return run(commandPath, args, options)

  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  return pwsh(`& ${quote(commandPath)} ${args.map(quote).join(' ')}`, options)
}

const channel = flag('channel') as Channel
if (channel !== 'homebrew' && channel !== 'scoop') fail('--channel must be homebrew or scoop.')

// Only meaningful for Homebrew: Scoop's Node is a declared dependency it puts
// on PATH, so removing it would be testing that PATH works.
const stripNode = process.argv.includes('--strip-node') && channel === 'homebrew'

const bundlePath = resolve(flag('bundle'))
if (!existsSync(bundlePath)) fail(`No bundle at ${bundlePath}.`)

const bundleName = basename(bundlePath)
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version as string
const sha256 = createHash('sha256').update(readFileSync(bundlePath)).digest('hex')

const work = mkdtempSync(join(tmpdir(), 'looptroop-channel-'))
const configDir = join(work, 'config')
mkdirSync(configDir)

// Mocked OpenCode and a throwaway configuration directory: this is proving that
// the channel produced a working command, not that the runner has OpenCode.
const childEnv = { LOOPTROOP_CONFIG_DIR: configDir, LOOPTROOP_OPENCODE_MODE: 'mock' }

/**
 * Served at the path a release asset actually has, not just by name.
 *
 * The formula states no `version` — `brew audit --strict` rejects one the URL
 * already carries — so Homebrew scans it out of the URL, and the `/v<version>/`
 * component is part of what it scans. A bare `/looptroop-x.y.z-bundle.tar.gz`
 * would be testing a URL shape no release ever produces.
 */
const assetPath = `/looptroop-ai/LoopTroop/releases/download/v${version}/${bundleName}`

const server = createServer((request, response) => {
  if (request.url !== assetPath) {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/gzip' })
  createReadStream(bundlePath).pipe(response)
})

/**
 * A PATH with every directory holding a `node` removed.
 *
 * This is what proves the Homebrew wrapper. `node@24` is keg-only, so the
 * formula has to put the keg's `node` on PATH itself; on a runner that already
 * has Node, a formula that forgot to would pass anyway and fail for the user
 * who does not.
 */
function pathWithoutNode(): string {
  const separator = process.platform === 'win32' ? ';' : ':'
  const kept = (process.env.PATH ?? '')
    .split(separator)
    .filter((entry) => entry !== '' && !existsSync(join(entry, 'node')) && !existsSync(join(entry, 'node.exe')))
  return kept.join(separator)
}

/** Asserts the installed command works and knows how it was installed. */
async function assertInstalled(commandPath: string): Promise<void> {
  const env = stripNode ? { ...childEnv, PATH: pathWithoutNode() } : childEnv
  if (stripNode) log('  (with every other node removed from PATH)')

  const reported = (await invoke(commandPath, ['--version'], { env })).stdout.trim()
  if (reported !== version) fail(`The installed command reports ${reported || '(nothing)'}, expected ${version}.`)
  log(`  runs, and reports ${version}`)

  // `doctor` exits non-zero on any failing check, and a fresh machine has
  // plenty; what is being asserted is the line it prints about this install.
  const doctor = await invoke(commandPath, ['doctor'], { env, allowFailure: true })
  const report = `${doctor.stdout}${doctor.stderr}`
  if (!new RegExp(`install\\b.*\\b${channel}\\b`).test(report)) {
    fail(
      `\`doctor\` does not report this as a ${channel} install.`,
      'That means the upgrade command shown to the user is the wrong one.',
      report.slice(0, 3000),
    )
  }
  log(`  \`doctor\` reports the ${channel} channel`)
}

async function main(): Promise<void> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${assetPath}`
  const descriptor = renderDescriptor(channel, { version, url, sha256 })
  log(`Serving ${bundleName} at ${url}\n`)

  if (channel === 'homebrew') {
    const tapDir = createLocalTap(LOCAL_TAP)
    writeFileSync(join(tapDir, 'Formula', 'looptroop.rb'), descriptor)
    log(descriptor)

    log(`Installing ${LOCAL_TAP}/looptroop...`)
    await run('brew', ['install', '--formula', '--verbose', `${LOCAL_TAP}/looptroop`], {
      env: {
        // The concurrent downloader's progress display is what reported
        // "unknown install step: run" — a message about its own state machine
        // rather than about the formula. One download at a time keeps the
        // failure, if there is one, legible.
        HOMEBREW_DOWNLOAD_CONCURRENCY: '1',
        HOMEBREW_NO_ENV_HINTS: '1',
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_ANALYTICS: '1',
      },
    })

    const prefix = (await run('brew', ['--prefix'])).stdout.trim()
    await assertInstalled(join(prefix, 'bin', 'looptroop'))

    await run('brew', ['uninstall', '--formula', `${LOCAL_TAP}/looptroop`], { allowFailure: true })
    removeLocalTap(LOCAL_TAP)
  } else {
    // Scoop installs straight from a manifest file, so no bucket has to exist —
    // and the public bucket is never touched.
    const manifestPath = join(work, 'looptroop.json')
    writeFileSync(manifestPath, descriptor)

    log('Installing from a local Scoop manifest...')
    await pwsh(`scoop install '${manifestPath.replaceAll("'", "''")}'`)

    const shim = (await pwsh('(Get-Command looptroop).Source')).stdout.trim()
    if (shim === '') fail('Scoop installed without producing a `looptroop` command.')
    await assertInstalled(shim)

    await pwsh('scoop uninstall looptroop', { allowFailure: true })
  }

  log(`\nPASS: ${channel} installs ${version} and it runs.`)
}

try {
  await main()
} catch (error) {
  if (!(error instanceof SmokeError)) throw error
  process.stderr.write(`\nFAIL: ${error.message}\n`)
  for (const line of error.detail) process.stderr.write(`  ${line}\n`)
  process.stderr.write('\n')
  process.exitCode = 1
} finally {
  server.close()
  rmSync(work, { recursive: true, force: true })
}
