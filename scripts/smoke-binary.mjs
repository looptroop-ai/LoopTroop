#!/usr/bin/env node
/**
 * Unpacks the standalone archive and drives it on a machine pretending to have
 * no Node.
 *
 *   node scripts/smoke-binary.mjs --archive dist-binary/looptroop-9.9.9-linux-x64.tar.gz
 *
 * The whole claim of this artefact is that it needs nothing installed, and
 * every GitHub runner has Node — so a binary that quietly shelled out to one
 * would pass a naive test and fail for the user it exists for. Node is removed
 * from PATH here, which is the only way the claim gets tested at all.
 *
 * The interface is checked properly rather than by fetching one page. A single-
 * file build carries the client inside it, and a build that embedded the
 * document but not its hashed assets serves a 200 for `/` and a blank screen to
 * a human — so every asset the document references is fetched too.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

function fail(message, ...detail) {
  process.stderr.write(`\nFAIL: ${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.stderr.write('\n')
  process.exit(1)
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

const IS_WINDOWS = process.platform === 'win32'

/** Always async: a synchronous child would block the checks that follow it. */
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
        reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`))
        return
      }
      settle({ code, stdout, stderr })
    })
  })
}

/**
 * PATH with every directory holding a `node` removed.
 *
 * This is the entire point of the job. Without it the binary could load Node
 * from the runner and nothing would notice until a user without one tried it.
 */
function pathWithoutNode() {
  const separator = IS_WINDOWS ? ';' : ':'
  return (process.env.PATH ?? '')
    .split(separator)
    .filter((entry) => entry !== ''
      && !existsSync(join(entry, 'node'))
      && !existsSync(join(entry, 'node.exe')))
    .join(separator)
}

const archive = resolve(flag('archive'))
if (!existsSync(archive)) fail(`No archive at ${archive}.`)

// Anchored on the platform tag rather than stopping at the first hyphen: a
// prerelease version contains hyphens too, and a loose pattern reads
// `0.5.1-linux` out of `looptroop-0.5.1-linux-x64`.
const version = /^looptroop-(.+)-(?:linux|darwin|win)-(?:x64|arm64)\./.exec(basename(archive))?.[1]
  ?? fail(`Cannot read a version out of ${basename(archive)}.`)

const work = mkdtempSync(join(tmpdir(), 'looptroop-binsmoke-'))
const configDir = join(work, 'config')
const unpacked = join(work, 'unpacked')

async function main() {
  mkdirSync(unpacked, { recursive: true })

  log(`Unpacking ${basename(archive)}...`)
  if (archive.endsWith('.zip')) {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${unpacked}' -Force`,
    ], { stdio: ['ignore', 'pipe', 'inherit'] })
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', unpacked], { stdio: ['ignore', 'pipe', 'inherit'] })
  }

  const root = join(unpacked, readdirSync(unpacked)[0] ?? fail('The archive unpacked to nothing.'))
  const binary = join(root, IS_WINDOWS ? 'looptroop.exe' : 'looptroop')
  if (!existsSync(binary)) fail(`The archive contains no executable at ${binary}.`)

  // Redistributing the embedded Node means shipping its licence. An archive
  // without it is not one we may publish.
  for (const required of ['LICENSE', 'LICENSE.node.txt', 'THIRD-PARTY-NOTICES.md']) {
    if (!existsSync(join(root, required))) fail(`The archive is missing ${required}.`)
  }
  log('  carries the binary and every licence it must')

  const env = {
    PATH: pathWithoutNode(),
    LOOPTROOP_CONFIG_DIR: configDir,
    LOOPTROOP_OPENCODE_MODE: 'mock',
  }
  log('  (with every node removed from PATH)')

  const reported = (await invoke(binary, ['--version'], { env })).stdout.trim()
  if (reported !== version) fail(`The binary reports ${reported || '(nothing)'}, expected ${version}.`)
  log(`  runs, and reports ${version}`)

  const doctor = await invoke(binary, ['doctor', '--json'], { env, allowFailure: true })
  let checks
  try {
    checks = JSON.parse(doctor.stdout).checks
  } catch {
    fail('`doctor --json` did not produce parseable JSON.', `${doctor.stdout}${doctor.stderr}`.slice(0, 2000))
  }
  const node = checks.find((check) => check.name === 'node')
  log(`  \`doctor\` runs; embedded runtime ${node?.detail ?? '(unreported)'}`)

  log('Starting the daemon...')
  const started = await invoke(binary, ['start'], { env })
  const url = /http:\/\/127\.0\.0\.1:(\d+)/.exec(started.stdout)?.[0]
    ?? fail('`start` printed no address.', started.stdout)

  try {
    const status = await invoke(binary, ['status', '--json'], { env })
    if (!status.stdout.includes(version)) fail('`status` does not report this version.', status.stdout)
    log(`  running at ${url}`)

    const index = await fetch(`${url}/`)
    if (!index.ok) fail(`GET / returned ${index.status}; the interface is not embedded.`)
    const html = await index.text()
    log(`  serves the interface (${html.length} bytes)`)

    // A build that embedded the document but not its assets serves a 200 here
    // and a blank screen to a human.
    const referenced = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1])
    const unique = [...new Set(referenced)]
    if (unique.length === 0) fail('The document references no assets, which cannot be right.')

    const missing = []
    for (const path of unique) {
      const response = await fetch(`${url}${path}`)
      if (!response.ok) missing.push(`${path} -> ${response.status}`)
    }
    if (missing.length > 0) fail(`${missing.length} of ${unique.length} referenced assets are missing.`, ...missing.slice(0, 10))
    log(`  every referenced asset resolves (${unique.length} of ${unique.length})`)

    // A missing asset must 404 rather than fall back to the document, or the
    // browser reports a MIME-type error instead of the real problem.
    const absent = await fetch(`${url}/assets/definitely-not-here-abc123.js`)
    if (absent.status !== 404) fail(`A missing asset returned ${absent.status}, expected 404.`)
    log('  a missing asset 404s rather than returning HTML')
  } finally {
    await invoke(binary, ['stop'], { env, allowFailure: true })
  }

  log(`\nPASS: ${basename(archive)} runs with no Node installed, serves its interface, and stops cleanly.`)
}

try {
  await main()
} finally {
  rmSync(work, { recursive: true, force: true })
}
