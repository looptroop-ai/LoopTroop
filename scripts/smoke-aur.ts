#!/usr/bin/env node
/**
 * Builds, installs, drives and removes the AUR package.
 *
 *   node scripts/smoke-aur.ts --bundle dist-bundle/looptroop-9.9.9-bundle.tar.gz
 *
 * From a `PKGBUILD` rendered here and the bundle served on loopback, never the
 * real AUR — the same trick the Homebrew, Scoop, Chocolatey and WinGet smokes
 * use with throwaway taps and local manifests.
 *
 * ## Why this exists before an account does
 *
 * The AUR is blocked to new registrations, so nothing can be published yet.
 * That makes validation *more* worth doing rather than less: everything a
 * submission would be rejected for can be found without an account, and the
 * alternative is discovering it months later during a release, against a
 * registry with no staging environment.
 *
 * Three things are checked that a reading of the file cannot settle:
 *
 * - **`.SRCINFO` agrees with `PKGBUILD`.** The AUR rejects a push where they
 *   disagree, and ours is rendered rather than generated, so `makepkg
 *   --printsrcinfo` is the only authority on whether the rendering is right.
 * - **`namcap` is quiet.** It is the linter Arch packagers actually run, and it
 *   reports things that are invisible in the source: a dependency that is
 *   already pulled in, a file in a path the distribution reserves.
 * - **The package installs and the command works.** Including that `doctor`
 *   names the AUR upgrade command, which is the whole reason the package
 *   writes a channel marker.
 *
 * Errors fail this; warnings are printed and do not. That distinction matters
 * for the four namcap always emits here, which contradict each other: it reads
 * the launcher's `#!/usr/bin/env node` and asks for a `node` dependency, then
 * says `nodejs` "may not be needed" — because its matcher does not resolve the
 * versioned `nodejs>=24` we declare against the `nodejs` that provides the
 * shebang. Dropping the version would silence it and would also stop expressing
 * the floor the application actually has.
 *
 * Needs `base-devel`, `namcap`, `nodejs` and `git`, and a non-root user,
 * because `makepkg` refuses to run as root.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, join, resolve } from 'node:path'
import { renderAurPackage, AUR_PACKAGE_NAME } from './package-manifests.ts'

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
 * Always async, never `spawnSync`: this process is also the HTTP server
 * `makepkg` downloads the bundle from, so a synchronous child deadlocks and
 * surfaces as a network timeout rather than as a hang.
 */
function invoke(command: string, args: string[], options: { allowFailure?: boolean, cwd?: string, env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((settle, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...process.env, ...options.env },
    })
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

if (process.platform !== 'linux') fail('makepkg exists only on Linux.')

const bundlePath = resolve(flag('bundle'))
if (!existsSync(bundlePath)) fail(`No bundle at ${bundlePath}.`)

/** The unprivileged account `makepkg` runs as; it refuses to run as root. */
const builder = flag('user', 'builder')

const bundleName = basename(bundlePath)
const version = /^looptroop-(.+)-bundle\.tar\.gz$/.exec(bundleName)?.[1]
  ?? fail(`Cannot read a version out of ${bundleName}.`)
const sha256 = createHash('sha256').update(readFileSync(bundlePath)).digest('hex')

// Under the builder's home rather than /tmp: makepkg writes here as that user,
// and a directory root created elsewhere would need its ownership fixed anyway.
const work = mkdtempSync(join('/home', builder, 'aur-'))
const configDir = join(work, 'config')
const childEnv = { LOOPTROOP_CONFIG_DIR: configDir, LOOPTROOP_OPENCODE_MODE: 'mock' }

/** A release-shaped path, so this exercises the URL a real PKGBUILD carries. */
const assetPath = `/looptroop-ai/LoopTroop/releases/download/v${version}/${bundleName}`

const server = createServer((request, response) => {
  if (request.url !== assetPath) {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/gzip' })
  createReadStream(bundlePath).pipe(response)
})

async function main(): Promise<void> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${assetPath}`
  log(`Serving ${bundleName} at ${url}\n`)

  mkdirSync(work, { recursive: true })
  const rendered = renderAurPackage({ version, url, sha256 })
  for (const [name, contents] of Object.entries(rendered)) {
    writeFileSync(join(work, name), contents)
  }
  // makepkg writes into this directory as the builder, so it has to own it.
  chmodSync(work, 0o777)
  await invoke('chown', ['-R', `${builder}:${builder}`, work])
  log(`Rendered PKGBUILD and .SRCINFO for ${AUR_PACKAGE_NAME} ${version}`)

  const asBuilder = (args: string[], options: { allowFailure?: boolean } = {}) =>
    invoke('sudo', ['-u', builder, '--preserve-env=PATH', ...args], { cwd: work, ...options })

  // 1. `.SRCINFO` must agree with `PKGBUILD`. The AUR rejects a push where it
  //    does not, and ours is rendered rather than generated — so this is the
  //    only thing that says whether the rendering is right.
  const printed = await asBuilder(['makepkg', '--printsrcinfo'])
  if (printed.stdout !== rendered['.SRCINFO']) {
    fail(
      '.SRCINFO does not match what `makepkg --printsrcinfo` produces.',
      'The AUR refuses a push whose .SRCINFO disagrees with its PKGBUILD.',
      'Update renderAurPackage in scripts/package-manifests.ts to match:',
      ...printed.stdout.split('\n').map((line) => `  ${line}`),
    )
  }
  log('  .SRCINFO agrees with the PKGBUILD')

  // 2. namcap on the source. Warnings are advice; errors are refusals.
  const sourceLint = await asBuilder(['namcap', 'PKGBUILD'], { allowFailure: true })
  const sourceErrors = sourceLint.stdout.split('\n').filter((line) => / E: /.test(line))
  if (sourceErrors.length > 0) fail('namcap reports errors in the PKGBUILD.', ...sourceErrors)
  log(`  namcap accepts the PKGBUILD${sourceLint.stdout.trim() === '' ? '' : ` (${sourceLint.stdout.trim().split('\n').length} advisory note(s))`}`)

  // 3. Build it. `-f` so a re-run overwrites rather than refusing.
  log('\nBuilding the package...')
  await asBuilder(['makepkg', '-f', '--noconfirm'])

  const built = readdirSync(work).find((entry) => entry.endsWith('.pkg.tar.zst'))
    ?? fail('makepkg produced no package.', readdirSync(work).join(', '))
  log(`  built ${built}`)

  // 4. namcap on the built package, which sees things the source cannot show:
  //    what actually landed, and where.
  const packageLint = await invoke('namcap', [join(work, built)], { allowFailure: true })
  const packageErrors = packageLint.stdout.split('\n').filter((line) => / E: /.test(line))
  if (packageErrors.length > 0) fail('namcap reports errors in the built package.', ...packageErrors)
  for (const line of packageLint.stdout.split('\n').filter(Boolean)) log(`    ${line}`)
  log('  namcap accepts the built package')

  // 5. Install it for real.
  log('\nInstalling...')
  await invoke('pacman', ['-U', '--noconfirm', join(work, built)])

  if (!existsSync('/usr/bin/looptroop')) fail('The package installed without producing /usr/bin/looptroop.')
  log('  /usr/bin/looptroop exists')

  try {
    const reported = (await invoke('/usr/bin/looptroop', ['--version'], { env: childEnv })).stdout.trim()
    if (reported !== version) fail(`The installed command reports ${reported || '(nothing)'}, expected ${version}.`)
    log(`  runs through the symlink, and reports ${version}`)

    // `--json` rather than scraping the human report: this reads the install
    // check itself instead of searching output for two words that could
    // co-occur in an unrelated remedy line.
    const doctor = await invoke('/usr/bin/looptroop', ['doctor', '--json'], { env: childEnv, allowFailure: true })
    let checks: { name?: string, detail?: string }[]
    try {
      checks = JSON.parse(doctor.stdout).checks
    } catch {
      fail('`doctor --json` did not produce parseable JSON.', `${doctor.stdout}${doctor.stderr}`.slice(0, 2000))
    }

    const install = checks.find((check) => check.name === 'install')
    if (!/^aur\b/.test(install?.detail ?? '')) {
      fail(
        '`doctor` does not report this as an AUR install.',
        `It reports: ${install?.detail ?? '(no install check)'}`,
        'That means the upgrade command shown to the user is the wrong one.',
      )
    }
    log(`  \`doctor\` reports the aur channel: ${install?.detail}`)
  } finally {
    log('\nRemoving...')
    await invoke('pacman', ['-R', '--noconfirm', AUR_PACKAGE_NAME], { allowFailure: true })
  }

  if (existsSync('/usr/bin/looptroop')) {
    fail('Removing the package left /usr/bin/looptroop behind.', 'It will keep answering with a path that no longer exists.')
  }
  if (existsSync(`/usr/lib/${AUR_PACKAGE_NAME}`)) {
    fail(`Removing the package left /usr/lib/${AUR_PACKAGE_NAME} behind.`)
  }
  log('  nothing left behind')

  log(`\nPASS: ${AUR_PACKAGE_NAME} ${version} builds, lints, installs, runs, knows which `
    + 'channel it came from, and removes cleanly.')
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
