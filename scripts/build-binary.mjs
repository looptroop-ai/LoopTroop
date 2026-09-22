#!/usr/bin/env node
/**
 * Builds the standalone executable: LoopTroop with a Node runtime inside it.
 *
 *   node scripts/build-binary.mjs --out dist-binary
 *
 * The point is a LoopTroop that runs on a machine with no Node at all. Homebrew,
 * Scoop and Chocolatey install Node for the user; WinGet's portable installer
 * refuses anything but an `.exe`, and `ubi` and `eget` fetch a binary or
 * nothing. This is what serves those.
 *
 * ## Why the standalone builder pins Node 26.9.0
 *
 * Native `node --build-sea` generation arrived in Node 25.5 and is the
 * maintained path in Node 26.9.0. It writes the final executable directly,
 * including the bundled CommonJS entry point and assets, so there is no
 * preparation blob, copy step or third-party injector to keep in sync.
 *
 * The application and package support Node from the `engines.node` floor
 * up. A standalone executable is different: its embedded runtime is the builder's
 * runtime, so this script refuses every version except Node 26.9.0. The binary
 * CI and release jobs pin that exact runtime; other jobs keep the application
 * floor. This is an explicit binary-toolchain boundary, not a package-engine
 * bump.
 *
 * ## Why CommonJS
 *
 * The injected entry is deliberately CommonJS. It is bundled as CJS — one
 * esbuild flag, and the package already ships a `.cjs` launcher, so nothing
 * about that is new.
 *
 * `import.meta` does not exist in CommonJS output, and six modules read
 * `import.meta.url` — one of them at the top level, where the failure would be
 * a crash before any command runs. The banner below defines it from
 * `__filename`, which is what esbuild's own documentation recommends and what
 * makes those six compile unchanged.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArgumentError, parseArgs, requireNoPositional } from './cli-args.ts'
import { toolPath } from './tool-path.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 1980-01-01, the same fixed timestamp the bundle archives use. */
const FIXED_MTIME = 315_532_800

function fail(message, ...detail) {
  process.stderr.write(`\nFAIL: ${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.stderr.write('\n')
  process.exit(1)
}

function run(command, args, options = {}) {
  return execFileSync(toolPath(command), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })
}

const USAGE = 'Usage: node scripts/build-binary.mjs [--out <dir>]'
let parsedArgs
try {
  parsedArgs = parseArgs(process.argv.slice(2), { out: 'value' })
  requireNoPositional(parsedArgs)
} catch (error) {
  if (!(error instanceof ArgumentError)) throw error
  fail(error.message, USAGE)
}
const outDir = resolve(parsedArgs.value('out') ?? join(repoRoot, 'dist-binary'))

const EMBEDDED_NODE_VERSION = 'v26.9.0'
if (process.version !== EMBEDDED_NODE_VERSION) {
  fail(
    `Standalone binaries must be built with Node ${EMBEDDED_NODE_VERSION}.`,
    `This process is running ${process.version}.`,
    'Use the pinned binary CI/release runtime; there is no legacy SEA fallback.',
  )
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const version = pkg.version

/**
 * The platform tag in the file name. `process.platform` and `process.arch` name
 * the machine this runs on, which is the only machine it can build for: a SEA
 * embeds the running Node, and a cross-built one would have to disable the code
 * cache and still carry the wrong runtime. Each target is built on its own
 * runner instead.
 */
const OS_TAG = { linux: 'linux', darwin: 'darwin', win32: 'win' }[process.platform]
  ?? fail(`No binary target for ${process.platform}.`)
const ARCH_TAG = { x64: 'x64', arm64: 'arm64' }[process.arch]
  ?? fail(`No binary target for ${process.arch}.`)

// macOS x64 is not a supported SEA target — the Node documentation says arm64
// only, and that x64 "is not currently supported and is skipped in the tests".
// Intel Macs keep Homebrew and npm, which work.
if (process.platform === 'darwin' && process.arch === 'x64') {
  fail(
    'Node does not support single-executable applications on macOS x64.',
    'Intel Macs install through Homebrew or npm instead.',
  )
}

const exeSuffix = process.platform === 'win32' ? '.exe' : ''
const binaryName = `looptroop-${version}-${OS_TAG}-${ARCH_TAG}${exeSuffix}`
const binaryPath = join(outDir, binaryName)

if (!existsSync(join(repoRoot, 'dist', 'server', 'cli', 'cli.js'))) {
  fail('dist/ is missing or incomplete.', 'Run `npm run build` first.')
}

const clientDir = join(repoRoot, 'dist', 'client')
if (!existsSync(join(clientDir, 'index.html'))) {
  fail('dist/client is missing.', 'The interface travels inside the executable; run `npm run build` first.')
}

/**
 * A fixed staging path, not a temporary one.
 *
 * The native SEA config embeds the absolute path of the bundled entry, so a
 * `mkdtemp` directory makes every build produce different bytes — proved by
 * building twice and comparing. Inside `node_modules` because that is already
 * ignored by git and by every packaging gate.
 */
const work = join(repoRoot, 'node_modules', '.cache', 'looptroop-binary')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

/** Every built client file, keyed the way `seaAssets.ts` looks them up. */
function clientAssets() {
  const assets = {}

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      // Forward slashes on every platform: the key is a lookup string, not a path.
      else assets[`client/${relative(clientDir, full).split('\\').join('/')}`] = full
    }
  }

  walk(clientDir)
  return assets
}


/**
 * GNU tar, which is not what `tar` means on macOS.
 *
 * The reproducible flags below — `--sort`, `--mtime`, the pax options — are GNU
 * extensions, and macOS ships bsdtar, which rejects them outright. `gtar` is
 * the conventional name for GNU tar where both exist. Checked rather than
 * assumed, because the failure is otherwise a wall of tar usage text in the
 * middle of a build that has already taken minutes.
 */
function gnuTar() {
  for (const candidate of ['gtar', 'tar']) {
    try {
      if (/GNU tar/.test(run(candidate, ['--version']))) return candidate
    } catch {
      continue
    }
  }

  return fail(
    'GNU tar is required to build a reproducible archive.',
    'macOS ships bsdtar, which does not accept --sort or --mtime.',
    'On macOS: brew install gnu-tar',
  )
}

/**
 * The licences we are obliged to redistribute alongside the binary.
 *
 * This executable *contains* a Node runtime, so shipping it means
 * redistributing Node, and Node's licence — which carries the notices of
 * everything Node itself bundles, OpenSSL and ICU among them — has to travel
 * with it. Fetched for the exact version embedded rather than vendored, so it
 * can never describe a different runtime from the one inside.
 *
 * Failing loudly if it cannot be fetched is deliberate. An archive that
 * silently omits it is the one outcome that is not acceptable.
 */
async function nodeLicense() {
  const url = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`
  const response = await fetch(url)
  if (!response.ok) {
    fail(
      `Cannot fetch the licence for the Node runtime being embedded (${process.version}).`,
      `${response.status} from ${url}`,
      'The archive must carry it: shipping this binary redistributes Node.',
    )
  }
  return response.text()
}

/**
 * The binary, its licences, and nothing else, in the format each platform's
 * tooling expects: `.zip` on Windows because that is what WinGet reads and what
 * Windows unpacks natively, `.tar.gz` elsewhere.
 *
 * Reproducible by the same rules as the bundle archives, and for the same
 * reason — a manifest records this hash.
 */
async function writeArchive(binary) {
  const staging = join(work, 'archive', `looptroop-${version}-${OS_TAG}-${ARCH_TAG}`)
  mkdirSync(staging, { recursive: true })

  copyFileSync(binary, join(staging, `looptroop${exeSuffix}`))
  chmodSync(join(staging, `looptroop${exeSuffix}`), 0o755)
  for (const file of ['LICENSE', 'README.md', 'THIRD-PARTY-NOTICES.md']) {
    copyFileSync(join(repoRoot, file), join(staging, file))
  }
  writeFileSync(join(staging, 'LICENSE.node.txt'), await nodeLicense())

  for (const entry of readdirSync(staging)) {
    utimesSync(join(staging, entry), FIXED_MTIME, FIXED_MTIME)
  }
  utimesSync(staging, FIXED_MTIME, FIXED_MTIME)

  const stagingRoot = dirname(staging)
  const name = basename(staging)
  const out = join(outDir, `${name}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`)
  rmSync(out, { force: true })

  if (process.platform === 'win32') {
    // Relative paths, resolved against `cwd`. Absolute ones make 7z store bare
    // file names, which flattens the archive: the smoke test then finds no
    // directory to enter, and WinGet's `RelativeFilePath` — which names
    // `<dir>\\looptroop.exe` — points at nothing.
    //
    // `-mtc=off -mta=off` so creation and access times stay out; the modified
    // time is already fixed, and `TZ=UTC` keeps ZIP's DOS local time stable
    // wherever this runs.
    const entries = readdirSync(staging).sort().map((entry) => `${name}/${entry}`)
    execFileSync(toolPath('7z'), ['a', '-tzip', '-mx=9', '-mtc=off', '-mta=off', out, ...entries], {
      cwd: stagingRoot,
      env: { ...process.env, TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
  } else {
    run(gnuTar(), [
      '--sort=name',
      `--mtime=@${FIXED_MTIME}`,
      '--owner=0', '--group=0', '--numeric-owner',
      '--format=pax',
      '--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime',
      '--use-compress-program=gzip -9 -n',
      '-cf', out,
      '-C', stagingRoot,
      name,
    ], { cwd: repoRoot })
  }

  return out
}

try {
  process.stdout.write('Bundling the entry point...\n')
  const entry = join(work, 'entry.cjs')

  await build({
    entryPoints: [join(repoRoot, 'server', 'cli', 'cli.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    // Nothing external: there is no `node_modules` beside a single file.
    define: {
      __LOOPTROOP_VERSION__: JSON.stringify(version),
      // A single file has no `package.json` beside it, and unlike the version
      // there is no safe placeholder for a floor: without this, `doctor` would
      // throw rather than pass every runtime.
      __LOOPTROOP_NODE_FLOOR__: JSON.stringify(pkg.engines.node),
      // CommonJS has no `import.meta`; the banner supplies one from
      // `__filename`, which is what makes the six modules that read it compile
      // unchanged.
      'import.meta.url': '__LOOPTROOP_META_URL__',
    },
    banner: { js: 'const __LOOPTROOP_META_URL__ = require("node:url").pathToFileURL(__filename).href;' },
    // An `import.meta` esbuild could not rewrite would be an empty object at
    // runtime, so it must never be a warning that scrolls past.
    logOverride: { 'empty-import-meta': 'error' },
    logLevel: 'warning',
  })

  const bundled = readFileSync(entry, 'utf8')
  if (/\bimport\.meta\b/.test(bundled)) {
    fail('The bundle still contains `import.meta`, which is an empty object in CommonJS.')
  }

  const assets = clientAssets()
  process.stdout.write(`Embedding ${Object.keys(assets).length} interface files...\n`)

  writeFileSync(join(work, 'sea-config.json'), `${JSON.stringify({
    main: entry,
    mainFormat: 'commonjs',
    output: binaryPath,
    disableExperimentalSEAWarning: true,
    // `import()` does not work with the code cache, and every CLI command is a
    // lazy import. Snapshots are incompatible with the rest of this anyway.
    useCodeCache: false,
    useSnapshot: false,
    assets,
  }, null, 2)}\n`)

  mkdirSync(outDir, { recursive: true })
  rmSync(binaryPath, { force: true })

  process.stdout.write('Building the native single executable...\n')
  run(process.execPath, ['--build-sea', join(work, 'sea-config.json')], { cwd: work })

  // Ad-hoc signing, which is free and is not notarization. Without it an arm64
  // binary will not execute at all: macOS refuses an unsigned one outright.
  if (process.platform === 'darwin') {
    run('codesign', ['--sign', '-', binaryPath])
  }

  const bytes = readFileSync(binaryPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  const archivePath = await writeArchive(binaryPath)
  const archiveBytes = readFileSync(archivePath)
  const archiveSha = createHash('sha256').update(archiveBytes).digest('hex')

  process.stdout.write([
    '',
    `binary      ${binaryName}`,
    `runtime     ${process.version} (embedded)`,
    `interface   ${Object.keys(assets).length} files`,
    `bytes       ${bytes.length}`,
    `sha256      ${sha256}`,
    '',
    `archive     ${basename(archivePath)}`,
    `bytes       ${archiveBytes.length}`,
    `sha256      ${archiveSha}`,
    `wrote       ${archivePath}`,
    '',
  ].join('\n'))
} finally {
  rmSync(work, { recursive: true, force: true })
}
