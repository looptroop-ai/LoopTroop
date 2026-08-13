#!/usr/bin/env node
/**
 * Installs LoopTroop through WinGet from a local manifest, drives it, and
 * uninstalls it again.
 *
 *   node scripts/smoke-winget.ts --archive dist-binary/looptroop-9.9.9-win-x64.zip
 *
 * From manifests rendered here and the archive served on loopback, never the
 * public `winget-pkgs` repository — the same trick the Homebrew and Scoop
 * smokes use with a throwaway tap and bucket. A submission there is a pull
 * request reviewed by humans, so the package has to be proved before it is
 * offered rather than after.
 *
 * This channel installs the standalone binary rather than the bundle the other
 * three take, and not by preference: `winget validate` refuses a portable whose
 * `RelativeFilePath` is anything but an `.exe`, and rejected the bundle's
 * `.cmd` shim outright. That rejection is what this job exists to keep catching.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { renderWingetManifests, WINGET_IDENTIFIER } from './package-manifests.ts'

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

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`--${name} is required.`)
  return value
}

interface RunResult { code: number | null, stdout: string, stderr: string }

/**
 * Always async, never `spawnSync`: this process is also the HTTP server the
 * child downloads from, so a synchronous child deadlocks and surfaces as a
 * network timeout rather than as a hang.
 */
function invoke(command: string, args: string[], options: { allowFailure?: boolean, env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
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

const archivePath = resolve(flag('archive'))
if (!existsSync(archivePath)) fail(`No archive at ${archivePath}.`)

const archiveName = basename(archivePath)
const version = /^looptroop-(.+)-win-x64\.zip$/.exec(archiveName)?.[1]
  ?? fail(`Cannot read a version out of ${archiveName}.`)
const sha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex')

const work = mkdtempSync(join(tmpdir(), 'looptroop-winget-'))
const manifestDir = join(work, 'manifests')
const configDir = join(work, 'config')
const childEnv = { LOOPTROOP_CONFIG_DIR: configDir, LOOPTROOP_OPENCODE_MODE: 'mock' }

/** A release-shaped path, so this exercises the URL a real manifest carries. */
const assetPath = `/looptroop-ai/LoopTroop/releases/download/v${version}/${archiveName}`

const server = createServer((request, response) => {
  if (request.url !== assetPath) {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/zip' })
  createReadStream(archivePath).pipe(response)
})

/** Where WinGet puts the alias for a portable package. */
const linkPath = join(
  process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? 'C:\\', 'AppData', 'Local'),
  'Microsoft', 'WinGet', 'Links', 'looptroop.exe',
)

async function main(): Promise<void> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${assetPath}`
  log(`Serving ${archiveName} at ${url}\n`)

  mkdirSync(manifestDir, { recursive: true })
  const manifests = renderWingetManifests({ version, url, sha256 })
  for (const [name, contents] of Object.entries(manifests)) {
    writeFileSync(join(manifestDir, name), contents)
  }
  log(`Rendered ${Object.keys(manifests).length} manifests`)

  // Schema first. A manifest that does not validate is rejected by the
  // submission pipeline before a human sees it, and the error there is far less
  // legible than the one here.
  const validated = await invoke('winget', ['validate', '--manifest', manifestDir], { allowFailure: true })
  log(`${validated.stdout}${validated.stderr}`.trim())
  if (validated.code !== 0) fail('`winget validate` rejected the rendered manifests.')
  log('  manifests validate\n')

  // `--skip-dependencies`: the declaration is covered by the golden files and
  // by validation. What this proves is our archive and our shim, and resolving
  // git here would make the job depend on the public WinGet source.
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

  // `--json` rather than scraping the human report: this reads the install
  // check itself instead of searching the output for two words that could
  // co-occur in an unrelated remedy line.
  const doctor = await invoke(linkPath, ['doctor', '--json'], { env: childEnv, allowFailure: true })
  let checks: { name?: string, detail?: string }[]
  try {
    checks = JSON.parse(doctor.stdout).checks
  } catch {
    fail('`doctor --json` did not produce parseable JSON.', `${doctor.stdout}${doctor.stderr}`.slice(0, 2000))
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
