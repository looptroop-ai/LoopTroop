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
 * ## Why the two-step flow and not `--build-sea`
 *
 * `node --build-sea` is one command and arrived in Node 25.5. This project
 * pins 24.18.1 everywhere, and 24 has only `--experimental-sea-config` plus
 * `postject`. Building on a newer Node would embed a runtime the test matrix
 * never exercises, which contradicts the floor being a promise on all three
 * platforms — and Node 25 is EOL besides. Revisit at the Node 26 LTS bump,
 * which is already on the floor-bump checklist.
 *
 * A hard constraint follows: the Node that produces the blob must be the same
 * version as the Node it is injected into, so this copies the running
 * executable rather than downloading one.
 *
 * ## Why CommonJS
 *
 * Node 24's SEA runs a CommonJS script and has no `mainFormat`. The entry is
 * therefore bundled as CJS — one esbuild flag, and the package already ships a
 * `.cjs` launcher, so nothing about that is new.
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
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })
}

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outDir = resolve(outIndex === -1 ? join(repoRoot, 'dist-binary') : args[outIndex + 1] ?? fail('--out needs a path'))

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
 * The SEA blob embeds the absolute path of the script it was built from, so a
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
    execFileSync('7z', ['a', '-tzip', '-mx=9', '-mtc=off', '-mta=off', out, ...entries], {
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
    output: join(work, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    // `import()` does not work with the code cache, and every CLI command is a
    // lazy import. Snapshots are incompatible with the rest of this anyway.
    useCodeCache: false,
    useSnapshot: false,
    assets,
  }, null, 2)}\n`)

  process.stdout.write('Preparing the blob...\n')
  run(process.execPath, ['--experimental-sea-config', join(work, 'sea-config.json')], { cwd: work })

  mkdirSync(outDir, { recursive: true })
  rmSync(binaryPath, { force: true })
  copyFileSync(process.execPath, binaryPath)
  chmodSync(binaryPath, 0o755)

  // macOS and Windows binaries are signed, and postject cannot rewrite a signed
  // one. Removing it first is a required step of the documented flow, not a
  // tidy-up: skip it and injection fails, or produces something that will not
  // run.
  if (process.platform === 'darwin') {
    run('codesign', ['--remove-signature', binaryPath])
  }

  process.stdout.write('Injecting...\n')
  run(process.execPath, [
    join(repoRoot, 'node_modules', 'postject', 'dist', 'cli.js'),
    binaryPath,
    'NODE_SEA_BLOB',
    join(work, 'sea-prep.blob'),
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    // The Mach-O segment the blob lives in. Only macOS needs it, and injection
    // fails without it there.
    ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ], { cwd: repoRoot })

  // Ad-hoc, which is free and is not notarization. Without it an arm64 binary
  // will not execute at all: macOS refuses an unsigned one outright.
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
