#!/usr/bin/env node
/**
 * Installs LoopTroop through WinGet from a local manifest, drives it, and
 * uninstalls it again.
 *
 *   node scripts/smoke-winget.ts --zip dist-bundle/looptroop-9.9.9-bundle.zip
 *
 * From manifests rendered here and a bundle served on loopback, never the
 * public `winget-pkgs` repository — the same trick the Homebrew and Scoop
 * smokes use with a throwaway tap and bucket. A submission is a pull request
 * into somebody else's repository and is reviewed by humans, so the package has
 * to be proved before it is offered, not after.
 *
 * What this is really for is the one assumption the WinGet channel rests on:
 * that a `zip` carrying a `portable` pointing at `bin/looptroop.cmd` produces a
 * working `looptroop` command. Nothing else in the pipeline tests that, and it
 * is not obvious — the archive holds a `#!` script, a `.cmd` and a `.ps1`, and
 * only one of them can be shimmed on Windows.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  renderWingetManifests,
  WINGET_IDENTIFIER,
} from './package-manifests.ts'

class SmokeError extends Error {
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

function flag(name: string, fallback: string | null = null): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? fallback : process.argv[index + 1]
  if (value === undefined || value === null || value.startsWith('--')) fail(`--${name} is required.`)
  return value
}

interface RunResult { code: number | null, stdout: string, stderr: string }

/**
 * Always async, never `spawnSync`.
 *
 * A synchronous child blocks this process's event loop, and this process is
 * also the HTTP server the child downloads from — so a `spawnSync` here
 * deadlocks and surfaces as a network timeout rather than as a hang.
 */
function invoke(command: string, args: string[], options: { env?: NodeJS.ProcessEnv, allowFailure?: boolean } = {}): Promise<RunResult> {
  return new Promise((settle, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...options.env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
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

if (process.platform !== 'win32') fail('WinGet exists only on Windows.')

const zipPath = resolve(flag('zip'))
if (!existsSync(zipPath)) fail(`No bundle zip at ${zipPath}.`)

const zipName = basename(zipPath)
const version = /looptroop-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-bundle\.zip$/.exec(zipName)?.[1]
  ?? fail(`Cannot read a version out of ${zipName}.`)
const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex')

const work = mkdtempSync(join(tmpdir(), 'looptroop-winget-'))
const manifestDir = join(work, 'manifests')
const configDir = join(work, 'config')
const childEnv = { LOOPTROOP_CONFIG_DIR: configDir, LOOPTROOP_OPENCODE_MODE: 'mock' }

/**
 * A release-shaped path, so this exercises the URL a real manifest carries
 * rather than a bare file name no release ever produces.
 */
const assetPath = `/looptroop-ai/LoopTroop/releases/download/v${version}/${zipName}`

const server = createServer((request, response) => {
  if (request.url !== assetPath) {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/zip' })
  createReadStream(zipPath).pipe(response)
})

/** Where WinGet puts the alias for a portable package. */
const linkPath = join(
  process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? 'C:\\', 'AppData', 'Local'),
  'Microsoft', 'WinGet', 'Links', 'looptroop.exe',
)

async function main(): Promise<void> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${assetPath}`
  log(`Serving ${zipName} at ${url}\n`)

  mkdirSync(manifestDir, { recursive: true })
  for (const [name, text] of Object.entries(renderWingetManifests({ version, url, sha256 }))) {
    writeFileSync(join(manifestDir, name), text)
  }
  log(`Rendered ${Object.keys(renderWingetManifests({ version, url, sha256 })).length} manifests into ${manifestDir}`)

  // Schema first. A manifest that does not validate is rejected by the
  // submission pipeline before a human ever sees it, and the error there is
  // far less legible than the one here.
  const validated = await invoke('winget', ['validate', '--manifest', manifestDir], { allowFailure: true })
  log(`${validated.stdout}${validated.stderr}`.trim())
  if (validated.code !== 0) fail('`winget validate` rejected the rendered manifests.')
  log('  manifests validate\n')

  // `--skip-dependencies` deliberately. The declaration itself is covered by
  // the golden files and by validation; what this proves is our archive and our
  // shim. Letting WinGet resolve `OpenJS.NodeJS` here would install a second
  // Node on a runner that already has one, cost minutes, and make this job
  // depend on the public WinGet source being reachable.
  log('Installing from the local manifest...')
  await invoke('winget', [
    'install', '--manifest', manifestDir,
    '--accept-package-agreements', '--accept-source-agreements',
    '--disable-interactivity', '--skip-dependencies',
  ])

  if (!existsSync(linkPath)) fail(`WinGet installed without producing an alias at ${linkPath}.`)
  log(`  alias created at ${linkPath}`)

  const reported = (await invoke(linkPath, ['--version'], { env: childEnv })).stdout.trim()
  if (reported !== version) fail(`The installed command reports ${reported || '(nothing)'}, expected ${version}.`)
  log(`  runs, and reports ${version}`)

  // `doctor --json` rather than scraping the human report: this reads the
  // install check itself instead of searching the whole output for two words
  // that could co-occur in an unrelated remedy line.
  const doctor = await invoke(linkPath, ['doctor', '--json'], { env: childEnv, allowFailure: true })
  let checks: { name?: string, detail?: string }[]
  try {
    checks = JSON.parse(doctor.stdout).checks
  } catch {
    fail('`doctor --json` did not produce parseable JSON.', `${doctor.stdout}${doctor.stderr}`.slice(0, 3000))
  }

  const install = checks.find((check) => check.name === 'install')
  if (!/^winget\b/.test(install?.detail ?? '')) {
    fail(
      '`doctor` does not report this as a winget install.',
      `It reports: ${install?.detail ?? '(no install check)'}`,
      'That means the upgrade command shown to the user is the wrong one.',
    )
  }
  log(`  \`doctor\` reports the winget channel: ${install?.detail}`)

  log('\nUninstalling...')
  await invoke('winget', ['uninstall', WINGET_IDENTIFIER, '--disable-interactivity'])

  if (existsSync(linkPath)) {
    fail(
      `Uninstalling left an alias behind at ${linkPath}.`,
      'It will keep answering `looptroop` with a path that no longer exists.',
    )
  }
  log('  alias removed')

  log(`\nPASS: winget installs ${version} from a portable zip, it runs, it knows which `
    + 'channel it came from, and uninstalling cleans up after itself.')
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
