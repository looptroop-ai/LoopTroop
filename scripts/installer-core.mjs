#!/usr/bin/env node
/**
 * Installs LoopTroop from a GitHub release, verifying the bytes first.
 *
 *   node installer-core.mjs [--version X.Y.Z] [--tarball PATH] [--dry-run]
 *   node installer-core.mjs --binary [--prefix DIR]
 *
 * This is the whole installer. `install.sh` and `install.ps1` are wrappers that
 * find Node, write this file to a temporary directory and run it — everything
 * that could get a decision wrong lives here, once, where it can be tested,
 * rather than twice in two shell dialects. `scripts/sync-installers.mjs`
 * copies this file into both wrappers and CI fails if a copy has drifted.
 *
 * Node is a hard prerequisite either way, so using it for JSON, semver, HTTPS
 * and hashing costs nothing and avoids depending on curl, jq, shasum or
 * certutil being present and behaving the same on three platforms.
 *
 * By default it installs an npm tarball, with npm (D2a): `npm uninstall -g
 * looptroop` and `npm install -g looptroop@latest` keep working afterwards,
 * which would not be true of an installer that unpacked files itself.
 *
 * `--binary` installs the standalone executable instead — one file carrying its
 * own Node — into a directory this installer owns. That mode unpacks files
 * itself, so it has to do by hand everything npm was doing for us: see
 * `installBinary` for why each step is there.
 *
 * Note that `--binary` still needs Node *to install*, because these wrappers are
 * Node programs. What it removes is Node as a requirement to **run** LoopTroop
 * afterwards. Somebody with no Node at all downloads the archive from the
 * releases page and unpacks it; there is nothing this script can do for them.
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = process.env.LOOPTROOP_INSTALL_REPO || 'looptroop-ai/LoopTroop'
// Overridable so the tests can serve a fixture release index from localhost.
const API = process.env.LOOPTROOP_INSTALL_API || 'https://api.github.com'
const MANIFEST_ASSET = 'release-manifest.json'
const TARBALL_PATTERN = /^looptroop-.+\.tgz$/

/**
 * How long a transfer may make no progress before it is abandoned.
 *
 * Two numbers rather than one, because the two kinds of request fail
 * differently. Release metadata is a few hundred kilobytes: it either answers
 * promptly or something is wrong. An asset is up to ~110 MB and may legitimately
 * take many minutes on a domestic link, so what is bounded there is *silence*,
 * not duration — a deadline that restarts on every chunk refuses a connection
 * that died without putting a ceiling on a slow one that is working.
 *
 * Before these existed the installer had no timeout at all, so a stalled
 * connection was indistinguishable from an install in progress, forever.
 */
const METADATA_STALL_MS = 30_000
const DOWNLOAD_STALL_MS = 60_000

/**
 * How much of a response is read before it is refused.
 *
 * The largest thing a release publishes is a standalone archive of about
 * 110 MB, so 512 MiB is four times the largest legitimate payload — big enough
 * that no real release approaches it, small enough that a wrong URL cannot fill
 * this machine's disk or memory before the checksum gets a chance to object.
 */
const MAX_METADATA_BYTES = 32 * 1024 * 1024
const MAX_ASSET_BYTES = 512 * 1024 * 1024

/**
 * How to get a supported Node.
 *
 * The macOS line names the unversioned formula on purpose. `brew install
 * node@24` is keg-only — Homebrew installs it and deliberately does not link it
 * onto PATH, which is why LoopTroop's own tap has to wrap it — so a reader who
 * ran the versioned command would come back to the same "Node is not on your
 * PATH" message with Node installed. `brew install node` is linked, and is
 * always at or above a floor that names a released major.
 */
function nodeHelp(platform) {
  if (platform === 'darwin') return 'brew install node   (or download from https://nodejs.org/)'
  if (platform === 'win32') return 'winget install OpenJS.NodeJS.LTS   (or download from https://nodejs.org/)'
  return 'Use your distribution\'s package or https://github.com/nvm-sh/nvm'
}

/**
 * Refuses to go on, and says why.
 *
 * Thrown rather than `process.exit`ed. Calling `process.exit()` while a fetch
 * connection is still open crashes Node on Windows with 0xC0000409 instead of
 * exiting 1 — so a user who gave a bad checksum, or an old Node, saw a crash
 * where a message belonged. Unwinding to the top and letting the process end on
 * its own gets the message out and the exit code right on every platform.
 */
class InstallError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'InstallError'
    this.detail = detail
  }
}

function fail(message, ...detail) {
  throw new InstallError(message, detail.filter(Boolean))
}

function say(message) {
  process.stdout.write(`${message}\n`)
}

// --- pure decisions -------------------------------------------------------

/**
 * Every option this installer accepts, in both spellings.
 *
 * One table rather than a list per file. The core parses `--version`, the
 * PowerShell wrapper's `param` block declares `-Version`, its forwarding block
 * maps one to the other, and the usage text prints whichever the reader typed.
 * Four places that have to agree about the same set, and they did not: the
 * wrapper forwarded four of the six, so `--dry-run` and `--help` were reachable
 * on macOS and Linux and silently absent on Windows. `tests/installer.test.ts`
 * reads this table and requires the wrapper to carry every row.
 */
export const INSTALL_OPTIONS = [
  {
    sh: '--version',
    ps: '-Version',
    value: 'X.Y.Z',
    help: 'install exactly this release, prereleases included',
  },
  {
    sh: '--tarball',
    ps: '-Tarball',
    value: 'PATH',
    help: 'install an already-downloaded tarball, skipping the network',
  },
  {
    sh: '--binary',
    ps: '-Binary',
    value: null,
    help: 'install the standalone executable instead of the npm package',
  },
  {
    sh: '--prefix',
    ps: '-Prefix',
    value: 'DIR',
    help: () => `where the standalone executable installs (default ${defaultPrefix()})`,
  },
  {
    sh: '--dry-run',
    ps: '-DryRun',
    value: null,
    help: 'say what would be downloaded and installed, then stop',
  },
  {
    sh: '--help',
    ps: '-Help',
    value: null,
    help: 'show this',
  },
]

/**
 * The usage text, in the dialect the reader actually typed.
 *
 * The wrappers take different spellings of one set of options, so a hardcoded
 * `Usage: install.sh` was wrong for everybody who reached this through
 * `install.ps1` — and wrong about every flag with it, since PowerShell does not
 * accept `--version`. The wrapper says which it is through the environment;
 * running the core directly gets the flags the core itself parses.
 */
export function usageLines(style = process.env.LOOPTROOP_INSTALL_STYLE === 'ps1' ? 'ps1' : 'sh') {
  const ps1 = style === 'ps1'
  const program = ps1 ? 'install.ps1' : 'install.sh'
  const spell = (option) => `${ps1 ? option.ps : option.sh}${option.value === null ? '' : ` ${option.value}`}`
  const find = (sh) => INSTALL_OPTIONS.find((option) => option.sh === sh)

  return [
    `Usage: ${program} [${spell(find('--version'))}] [${spell(find('--tarball'))}]`,
    `       ${program} ${spell(find('--binary'))} [${spell(find('--version'))}] [${spell(find('--prefix'))}]`,
    '',
    ...INSTALL_OPTIONS.map((option) => {
      const text = typeof option.help === 'function' ? option.help() : option.help
      return `  ${spell(option).padEnd(17)}${text}`
    }),
  ]
}

export function parseArgs(argv) {
  const options = { version: null, tarball: null, dryRun: false, binary: false, prefix: null }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    // The same three rules `scripts/cli-args.ts` applies to the release
    // scripts, because they are the same three mistakes. This parser had only
    // the first, and the other two were reachable from a shell:
    //
    //   `--prefix ""` — what `--prefix "$DIR"` produces with `DIR` unset — took
    //   the empty string, which `resolve('')` turns into the *current working
    //   directory*, so the standalone executable was installed into whatever
    //   directory the user happened to be in.
    //
    //   `--version -h` took `-h` as the version and asked GitHub for a release
    //   called `v-h`.
    const takeValue = () => {
      const value = argv[index + 1]
      if (value === undefined) fail(`${arg} needs a value, and is the last argument.`)
      if (value === '') fail(`${arg} needs a value, and was given an empty one.`)
      if (value.startsWith('-') && value !== '-') fail(`${arg} needs a value, but is followed by ${value}.`)
      index += 1
      return value
    }

    switch (arg) {
      case '--version': options.version = takeValue().replace(/^v/, ''); break
      case '--tarball': options.tarball = takeValue(); break
      case '--dry-run': options.dryRun = true; break
      case '--binary': options.binary = true; break
      case '--prefix': options.prefix = takeValue(); break
      case '--help':
      case '-h':
        for (const line of usageLines()) say(line)
        process.exit(0)
        break
      default:
        fail(`Unknown option ${arg}.`, 'Run with --help to see what is accepted.')
    }
  }

  // Two different installers, and `--tarball` names an npm tarball. Silently
  // preferring one would install something other than what was asked for.
  if (options.binary && options.tarball !== null) {
    fail('--binary and --tarball cannot be combined.', '--tarball installs an npm tarball; --binary installs the standalone executable.')
  }
  if (options.prefix !== null && !options.binary) {
    fail('--prefix applies only to --binary.', 'The npm install goes wherever npm\'s global prefix points; change it with `npm config set prefix`.')
  }

  return options
}

/**
 * The build of the standalone executable that runs here, or why there is none.
 *
 * Refusing is a first-class outcome rather than an error path. Every one of
 * these platforms has a working LoopTroop through some other channel, so the
 * answer a user needs is which one — not that this failed.
 *
 * `libc` is passed in rather than probed so the refusal can be tested from any
 * machine; `detectLibc` supplies it in real use.
 */
export function binaryTarget(platform, arch, libc = 'glibc') {
  const elsewhere = [
    'LoopTroop still installs here through npm:',
    '  npm install -g looptroop',
  ]

  if (platform === 'darwin' && arch === 'x64') {
    return {
      refusal: [
        'There is no standalone executable for Intel Macs.',
        'Node cannot build a single-file executable for darwin-x64 at all — the feature',
        'supports arm64 only — so this is a gap in the runtime, not a build we skipped.',
        '',
        'On an Intel Mac, use Homebrew or npm:',
        '  brew install looptroop-ai/tap/looptroop',
        '  npm install -g looptroop',
      ],
    }
  }

  if (platform === 'linux' && libc === 'musl') {
    return {
      refusal: [
        'There is no standalone executable for musl systems such as Alpine.',
        'Node\'s single-file executables are built against glibc and will not run here.',
        '',
        ...elsewhere,
        '',
        'Or run the container image, which carries everything it needs:',
        '  docker run looptroopai/looptroop:latest',
      ],
    }
  }

  const known = {
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
    'darwin-arm64': 'darwin-arm64',
    'win32-x64': 'win-x64',
  }
  const target = known[`${platform}-${arch}`]
  if (target !== undefined) return { target }

  return {
    refusal: [
      `There is no standalone executable for ${platform}-${arch}.`,
      'The executables are built for linux-x64, linux-arm64, darwin-arm64 and win-x64.',
      '',
      ...elsewhere,
    ],
  }
}

/**
 * glibc or musl.
 *
 * Node's own report carries the runtime glibc version on a glibc system and
 * omits the field entirely on musl, which is the only detection that does not
 * involve running `ldd` and parsing its output — and `ldd` is itself absent from
 * a minimal musl image.
 */
export function detectLibc(report = process.report?.getReport?.()) {
  if (process.platform !== 'linux') return 'glibc'
  return report?.header?.glibcVersionRuntime ? 'glibc' : 'musl'
}

/** What a release calls the standalone archive for a target. */
export function binaryAssetName(version, target) {
  return `looptroop-${version}-${target}${target.startsWith('win') ? '.zip' : '.tar.gz'}`
}

/**
 * The assets a `--binary` install needs, or null.
 *
 * The manifest is as necessary here as for the npm path: it is what carries the
 * checksum, and an archive installed without one is an archive taken on trust
 * from a URL. Releases published before the executables existed carry neither,
 * and are simply not candidates.
 */
export function binaryAssets(release, target) {
  const assets = Array.isArray(release.assets) ? release.assets : []
  const manifest = assets.find((asset) => asset.name === MANIFEST_ASSET)
  const wanted = binaryAssetName(versionOf(release), target)
  const archive = assets.find((asset) => asset.name === wanted)
  return manifest && archive ? { manifest, archive } : null
}

/**
 * Where `--binary` installs when nobody says otherwise.
 *
 * Its own directory rather than somewhere already on PATH, because this mode
 * writes a program *and* the licences that must travel with it — redistributing
 * Node obliges us to ship Node's — and scattering those through `~/.local/bin`
 * would be litter. The same shape `rustup`, `deno` and `bun` use.
 */
export function defaultPrefix(env = process.env, home = homedir()) {
  return env.LOOPTROOP_INSTALL_DIR || join(home, '.looptroop')
}

/** True when `dir` is already on this PATH, so the closing advice can be honest. */
export function onPath(dir, pathValue = process.env.PATH || '') {
  const normalise = (value) => (process.platform === 'win32' ? value.toLowerCase() : value).replace(/[\\/]+$/, '')
  return pathValue.split(delimiter).filter(Boolean).map(normalise).includes(normalise(dir))
}

/**
 * Semver ordering, prereleases below the release they precede.
 *
 * Only what release tags actually use: numeric core plus a dot-separated
 * prerelease, compared numerically where both parts are numeric and
 * lexically otherwise, as the spec requires.
 */
export function compareVersions(left, right) {
  const split = (value) => {
    const [core, pre = null] = String(value).replace(/^v/, '').split('-', 2)
    return { core: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre }
  }

  const a = split(left)
  const b = split(right)

  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }

  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1

  const aParts = a.pre.split('.')
  const bParts = b.pre.split('.')
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const x = aParts[index]
    const y = bParts[index]
    if (x === y) continue
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y)
    if (numeric) return Number(x) - Number(y) < 0 ? -1 : 1
    return x < y ? -1 : 1
  }

  return 0
}

export function versionOf(release) {
  return String(release.tag_name ?? '').replace(/^v/, '')
}

/** The assets an install needs; a release without both is not installable. */
export function installableAssets(release) {
  const assets = Array.isArray(release.assets) ? release.assets : []
  const manifest = assets.find((asset) => asset.name === MANIFEST_ASSET)
  const tarball = assets.find((asset) => TARBALL_PATTERN.test(String(asset.name)))
  return manifest && tarball ? { manifest, tarball } : null
}

/**
 * The release to install: the pinned one, or the newest stable that can
 * actually be installed.
 *
 * "That can actually be installed" is not pedantry. An early release was
 * published with no assets at all, so a walk that stopped at the newest stable
 * tag would resolve to a release with nothing to download — and would do so
 * again for any future release whose asset upload failed halfway.
 *
 * `installable` is a parameter because "installable" means something different
 * per mode: every release since the first carries an npm tarball, but only
 * releases since the executables existed carry an archive for this target, and
 * `--binary` must walk past the ones that do not rather than resolve to a
 * release it cannot install from.
 */
export function selectRelease(releases, pinned = null, installable = installableAssets) {
  const candidates = releases
    .filter((release) => release && release.draft !== true)
    .filter((release) => (pinned === null ? release.prerelease !== true : versionOf(release) === pinned))
    .filter((release) => installable(release) !== null)

  candidates.sort((a, b) => compareVersions(versionOf(b), versionOf(a)))
  return candidates[0] ?? null
}

/**
 * True when `have` satisfies a `>=x.y.z` style floor.
 *
 * An unreadable floor is not "no floor": stripping `not-a-range` down to
 * leftover text and treating that as a zero version accepts every runtime.
 * Same grammar as `parseNodeFloor` — three numeric components, no prerelease
 * suffix — so a malformed manifest fails the install rather than skipping it.
 */
export function satisfiesFloor(have, floor) {
  const match = /^\s*(?:>=\s*)?v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(String(floor))
  if (!match) return false
  return compareVersions(have, `${match[1]}.${match[2]}.${match[3]}`) >= 0
}

// --- effects --------------------------------------------------------------

/**
 * A deadline that restarts every time bytes arrive.
 *
 * `AbortSignal.timeout` would bound the whole request instead, which for a
 * 110 MB archive means choosing between a limit long enough that a dead
 * connection hangs for minutes and one short enough to abandon a slow but
 * working download. What actually goes wrong is a transfer that stops
 * progressing, and that is what this measures.
 */
export function stallGuard(idleMs, what) {
  const controller = new AbortController()
  let timer = null

  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      controller.abort(new Error(`${what} made no progress for ${Math.round(idleMs / 1000)}s.`))
    }, idleMs)
    // Nothing should stay alive merely because this timer is pending.
    timer.unref?.()
  }

  arm()
  return {
    signal: controller.signal,
    touch: arm,
    release: () => clearTimeout(timer),
    /** The abort reason if this guard fired, so the message says "stalled" rather than "aborted". */
    reason: () => (controller.signal.aborted ? String(controller.signal.reason?.message ?? controller.signal.reason) : null),
  }
}

/**
 * Every byte of a response, up to `limit`, handed to `write` as it arrives.
 *
 * `arrayBuffer()` is shorter and is what this used to do, but it buffers
 * whatever the other end sends before anything can object — so the checksum
 * that exists to catch a wrong file only ran once the wrong file was entirely
 * in memory. The declared length is refused up front when there is one, and the
 * running total is checked either way, because a chunked response declares no
 * length at all.
 */
export async function streamBody(response, limit, what, write, touch) {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) {
    fail(`${what} declares ${declared} bytes, and this installer reads at most ${limit}.`, 'Nothing was installed.')
  }

  const reader = response.body?.getReader()
  if (reader === undefined) fail(`${what} arrived with no body.`, 'Nothing was installed.')

  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    touch()
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      fail(`${what} is larger than the ${limit} bytes this installer reads.`, 'Nothing was installed.')
    }
    write(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
  return total
}

async function getJson(url) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'looptroop-installer' }
  // Only to lift the 60-per-hour anonymous rate limit when one happens to be
  // present, as in CI. Never required, never printed.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`

  const guard = stallGuard(METADATA_STALL_MS, 'The request to GitHub')
  try {
    let response
    try {
      response = await fetch(url, { headers, signal: guard.signal })
    } catch (error) {
      fail('Could not reach GitHub.', guard.reason() ?? String(error.message ?? error), 'Check your network and try again.')
    }
    if (!response.ok) {
      fail(
        `GitHub answered ${response.status} for the release list.`,
        response.status === 403 ? 'That is usually the anonymous rate limit; try again in a few minutes.' : '',
      )
    }

    const chunks = []
    try {
      await streamBody(response, MAX_METADATA_BYTES, 'The release list', (chunk) => chunks.push(chunk), guard.touch)
    } catch (error) {
      if (error instanceof InstallError) throw error
      fail('Could not read GitHub\'s answer.', guard.reason() ?? String(error.message ?? error))
    }

    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      fail('GitHub answered with something that is not JSON.', 'Try again in a few minutes.')
    }
  } finally {
    guard.release()
  }
}

async function download(url, destination) {
  const guard = stallGuard(DOWNLOAD_STALL_MS, `Downloading ${basename(destination)}`)
  let handle = null

  try {
    let response
    try {
      response = await fetch(url, {
        headers: { 'user-agent': 'looptroop-installer' },
        redirect: 'follow',
        signal: guard.signal,
      })
    } catch (error) {
      fail(`Downloading ${basename(destination)} failed.`, guard.reason() ?? String(error.message ?? error))
    }
    if (!response.ok) fail(`Downloading ${basename(destination)} failed with ${response.status}.`)

    handle = openSync(destination, 'w')
    try {
      await streamBody(response, MAX_ASSET_BYTES, basename(destination), (chunk) => writeSync(handle, chunk), guard.touch)
    } catch (error) {
      if (error instanceof InstallError) throw error
      fail(`Downloading ${basename(destination)} failed.`, guard.reason() ?? String(error.message ?? error))
    }
  } catch (error) {
    // A half-written file is worse than none: the next run would hash it,
    // reject it against the release's checksum, and report a corrupt release
    // rather than an interrupted download.
    if (handle !== null) {
      closeSync(handle)
      handle = null
    }
    discard(destination)
    throw error
  } finally {
    if (handle !== null) closeSync(handle)
    guard.release()
  }
}

/**
 * Where a tool actually lives, rather than whichever `PATH` entry answered first.
 *
 * The body below is **generated** from `server/lib/executablePath.ts` by
 * `scripts/sync-installers.mjs`, with its TypeScript types stripped. This file
 * is embedded verbatim into `install.sh` and `install.ps1`, which run with no
 * repository present and so cannot import anything — and the previous answer to
 * that, a hand-written second copy, is exactly what drifted: the installer
 * searched `PATH` only and ignored the operator override, so the daemon and the
 * installer could resolve different binaries in the same environment. Generating
 * it makes drift impossible to introduce by hand and `npm run installers:check`
 * makes it impossible to merge.
 *
 * Edit `server/lib/executablePath.ts` and run `npm run installers:sync`.
 */
// --- BEGIN executable-path (generated by scripts/sync-installers.mjs; do not edit) ---
/**
 * Where an external tool actually lives, decided here rather than by `PATH`.
 *
 * `spawn('git', …)` names a tool and lets the operating system pick the file.
 * `shell: false` stops the *arguments* being re-parsed; it says nothing about
 * which binary runs. The first directory on `PATH` decides that, and this
 * daemon spawns `git`, `gh` and `opencode` inside a repository whose contents
 * it does not control — so "whatever answered to the name" is a decision worth
 * taking away from the environment.
 *
 * The rule is deliberately not "system directories only". Developers install
 * `git`, `gh`, `node` and `opencode` under a version manager's directory in
 * `~/.nvm`, under `~/.cargo/bin`, `~/.local/bin`, Homebrew and Nix; a resolver
 * that insists on `/usr/bin` closes a static-analysis rule by breaking every
 * version manager. What is refused is a directory anyone on the machine can
 * write to, because that is the case where the name and the file can be made
 * to disagree.
 *
 * `scripts/trusted-tool.ts` answers the same question with a *stricter* policy,
 * and the two are separate on purpose: it guards release jobs that hold
 * publishing credentials, where a hosted runner's `gh` genuinely does live in
 * `/usr/bin` and anything else is a reason to stop. This one guards a developer
 * machine, where it is not.
 *
 * What it does not promise: resolution is followed by a spawn, and the file can
 * be replaced in between. `LOOPTROOP_TRUSTED_EXECUTABLE_DIRS` is an operator
 * telling the daemon where its tools are — it is not a defence against an
 * attacker who can already set this process's environment, and nothing here
 * pretends otherwise.
 *
 * Erasable TypeScript only, and no relative imports. `scripts` modules import
 * this file under Node's type stripping, which rejects `enum`, `namespace` and
 * parameter properties, and `scripts/sync-installers.mjs` strips it into
 * `scripts/installer-core.mjs`, which runs with no repository around it.
 * Neither `tsc` nor vitest catches a violation of either constraint.
 */
import * as trustedFs from 'node:fs'
import * as trustedPath from 'node:path'

/** Directories to search ahead of `PATH`, delimiter-separated, absolute. */
export const TRUSTED_EXECUTABLE_DIRS_ENV = 'LOOPTROOP_TRUSTED_EXECUTABLE_DIRS'

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * A resolution, or the reason there is not one. Never both.
 *
 * `refusedAt` separates the two failures that must not be treated alike: a tool
 * that is *not installed*, where falling back to the bare name only reproduces
 * the ENOENT a caller already reports, and a tool that *is* there in a directory
 * this machine will not run from, where falling back would spawn the very file
 * this module exists to refuse.
 */
                                         
                                                               
                                                            

                                           
                         
                            
                                                                                           
                               
                                                                    
                                              
 

/**
 * A resolved path plus enough of its identity to notice it was replaced.
 *
 * Caching the path alone survives `brew upgrade git`: the daemon keeps spawning
 * a path whose file is now a different program, or on Windows one that no
 * longer exists. Four fields is what it takes to see an in-place upgrade, and a
 * `stat` is noise beside the `spawn` it precedes.
 */
                                   
              
             
             
                 
              
 

const processCache = new Map                          ()

/** Drops every cached resolution. Called on daemon start; otherwise for tests. */
export function resetTrustedExecutableCache()       {
  processCache.clear()
}

/**
 * The directories a tool may be resolved from, in search order.
 *
 * The override is *prepended*, not used to filter `PATH`: an operator naming a
 * directory is telling the daemon where a tool is, and a tool that is not on
 * `PATH` at all is exactly the case they are answering. Filtering `PATH` by the
 * override — the shape this had when it was first written — resolves nothing
 * for the person who set it.
 *
 * Relative entries are dropped rather than resolved. `PATH` conventionally
 * carries `.` and empty segments, both of which mean the current directory, and
 * for a daemon whose current directory is a checkout that is the one location
 * that must never win.
 */
export function trustedSearchDirectories(options                           = {})           {
  const env = options.env ?? process.env
  const pathValue = env.PATH ?? env.Path ?? ''
  const entries = [
    ...(env[TRUSTED_EXECUTABLE_DIRS_ENV] ?? '').split(trustedPath.delimiter),
    ...pathValue.split(trustedPath.delimiter),
  ]

  const seen = new Set        ()
  const directories           = []
  for (const entry of entries) {
    // Windows tolerates `"C:\Program Files\x"` in PATH and strips the quotes
    // itself; `join` does not, and the quoted form resolves to nothing.
    const directory = entry.trim().replace(/^"(.*)"$/, '$1')
    if (directory === '' || !trustedPath.isAbsolute(directory)) continue
    const normalised = trustedPath.resolve(directory)
    if (seen.has(normalised)) continue
    seen.add(normalised)
    directories.push(normalised)
  }
  return directories
}

/**
 * The extensions to try for `name`, on this platform.
 *
 * Windows has no execute bit; `PATHEXT` is what decides that a file is a
 * program, and `CreateProcess` never reads it — which is why a bare `npm`, an
 * `npm.cmd`, is invisible to a direct spawn. A name that already carries an
 * extension is taken as given.
 */
function candidateExtensions(name        , platform                 , env                   )           {
  if (platform !== 'win32') return ['']
  if (/\.[^\\/.]+$/.test(name)) return ['']
  // `||`, not `??`: an empty PATHEXT would leave no extensions to try at all.
  return (env.PATHEXT || DEFAULT_PATHEXT).split(';').map((value) => value.trim()).filter(Boolean)
}

function isExecutableFile(path        , platform                 )          {
  if (!trustedFs.statSync(path, { throwIfNoEntry: false })?.isFile()) return false
  // Windows has no execute bit and PATHEXT has already chosen the extension by
  // the time this runs. Read from the platform passed in rather than the real
  // one, so the rules can be exercised off the platform they describe.
  if (platform === 'win32') return true
  try {
    trustedFs.accessSync(path, trustedFs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Whether `directory` sits on a Windows drive mounted into WSL.
 *
 * DrvFs reports mode `0777` for every file it shows, so a world-writable test
 * fails for a Windows-side Git under `/mnt/c` and for every other Windows tool
 * a WSL developer uses — the mode is not describing permissions, it is
 * describing a filesystem that has none to report. The mode check is therefore
 * skipped here, and only here.
 *
 * Decided from the mount table rather than by matching `/mnt/`, because `/mnt`
 * is an ordinary directory that anything may be mounted under, and a rule that
 * trusts a path prefix is a rule an attacker can satisfy with a `mkdir`. The
 * longest matching mount point wins, as the kernel would resolve it.
 */
function isWindowsDriveMount(directory        , mountTable        )          {
  let bestPoint = ''
  let bestType = ''
  for (const line of mountTable.split('\n')) {
    const fields = line.split(' ')
    const point = fields[1]
    const type = fields[2]
    if (point === undefined || type === undefined) continue
    // /proc/mounts octal-escapes spaces and tabs in mount points.
    const decoded = point.replace(/\\(\d{3})/g, (_, code        ) => String.fromCharCode(parseInt(code, 8)))
    const covers = decoded === '/' || directory === decoded || directory.startsWith(`${decoded}/`)
    if (!covers || decoded.length < bestPoint.length) continue
    bestPoint = decoded
    bestType = type
  }
  // `drvfs` is WSL1 and WSL2's default; `9p` and `virtiofs` are what WSL2 has
  // used for the same mounts across builds. All three are a Windows filesystem
  // seen through a translation layer, and none of them reports a real mode.
  return bestType === 'drvfs' || bestType === '9p' || bestType === 'virtiofs'
}

function readMountTableFromProc()         {
  try {
    return trustedFs.readFileSync('/proc/mounts', 'utf8')
  } catch {
    // No mount table is not WSL. Falling back to "trust it" here would make an
    // unreadable file the way past the check.
    return ''
  }
}

/**
 * Directories Windows programs are legitimately installed into.
 *
 * `fs.stat` mode is meaningless on NTFS — everything reports `0777` — so
 * "user-owned and not world-writable" cannot be the Windows test. What is left
 * that Node can see is *where* the file is, so the rule is a location one: the
 * system roots, or somewhere under this user's own profile, which is where
 * every Windows version manager puts things (scoop, nvm-windows, npm's global
 * prefix, `%LOCALAPPDATA%\Programs`). Anything else — `C:\temp`, a network
 * share, a directory inside a checkout — is refused, and named by the override
 * if it is deliberate.
 */
function windowsTrustedRoots(env                   )           {
  const root = (value                    , fallback        )         => {
    const candidate = value?.trim()
    // `??` is not enough: an unset-but-present variable is the empty string,
    // and `resolve('')` is the current working directory — which would make the
    // checkout a trusted root.
    return candidate !== undefined && candidate !== '' && trustedPath.win32.isAbsolute(candidate) ? candidate : fallback
  }
  const userProfile = root(env.USERPROFILE, 'C:\\Users\\Default')
  return [
    root(env.ProgramFiles, 'C:\\Program Files'),
    root(env['ProgramFiles(x86)'], 'C:\\Program Files (x86)'),
    root(env.ProgramData, 'C:\\ProgramData'),
    root(env.SystemRoot, 'C:\\Windows'),
    userProfile,
    root(env.LOCALAPPDATA, trustedPath.win32.join(userProfile, 'AppData\\Local')),
    root(env.APPDATA, trustedPath.win32.join(userProfile, 'AppData\\Roaming')),
  ]
}

/**
 * Whether `path` is inside `root`, by path segment.
 *
 * `startsWith` is a hole: `/usr/bin-of-mine` starts with `/usr/bin`, so a
 * directory that merely shares a prefix with a trusted one passes. `relative()`
 * asks the question actually being asked.
 */
function isWithin(root        , path        , platform                 )          {
  const fold = (value        )         => (platform === 'win32' ? value.toLowerCase() : value)
  const from = fold(trustedPath.resolve(root))
  const to = fold(path)
  if (from === to) return true
  const step = trustedPath.relative(from, to)
  return step !== '' && !step.startsWith('..') && !trustedPath.isAbsolute(step)
}

/** Why a directory is not trusted, or `null` when it is. */
function directoryRefusal(
  directory        ,
  platform                 ,
  env                   ,
  readMountTable              ,
  namedByOperator         ,
)                {
  const stats = trustedFs.statSync(directory, { throwIfNoEntry: false })
  if (!stats?.isDirectory()) return 'it is not a directory'

  if (platform === 'win32') {
    // "A known-safe *or explicitly configured* directory" — and on Windows the
    // second half carries real weight, because there is no permission check to
    // fall back on. `fs.stat` mode is 0777 for everything on NTFS, so an
    // operator naming a directory is the only signal available for a tool that
    // lives somewhere this list does not know about. On POSIX the override is
    // *not* excused the mode check, because there the mode means something.
    if (namedByOperator) return null
    return windowsTrustedRoots(env).some((root) => isWithin(root, directory, platform))
      ? null
      : 'it is outside the system and user-profile directories'
  }

  const worldWritable = (stats.mode & 0o002) !== 0
  if (worldWritable && !isWindowsDriveMount(directory, readMountTable())) return 'it is writable by any user on this machine'

  // A directory owned by neither root nor this user is one somebody else can
  // refill. `getuid` is absent only on Windows, which returned above.
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== 0 && stats.uid !== uid) return `it is owned by uid ${stats.uid}`
  return null
}

/**
 * The file `name` would run as, if it is one this daemon is willing to spawn.
 *
 * A hit in an untrusted directory is refused rather than skipped. Carrying on
 * down `PATH` would resolve to a *different* program than the one the operating
 * system would have run — silently, and differently from every other tool on
 * the machine, which is worse than saying no.
 */
export function resolveTrustedExecutable(
  name        ,
  options                           = {},
)                              {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const readMountTable = options.readMountTable ?? readMountTableFromProc

  if (name === '') return { reason: 'An empty program name cannot be resolved.' }
  if (/[\\/]/.test(name) || trustedPath.isAbsolute(name)) {
    return { reason: `'${name}' is a path, not a program name; resolve it against its intended root instead.` }
  }

  const directories = trustedSearchDirectories({ env })
  const namedByOperator = new Set(
    trustedSearchDirectories({ env: { [TRUSTED_EXECUTABLE_DIRS_ENV]: env[TRUSTED_EXECUTABLE_DIRS_ENV] ?? '', PATH: '' } }),
  )
  const extensions = candidateExtensions(name, platform, env)
  const cache = options.cache === undefined ? processCache : options.cache
  const cacheKey = `${platform}\u0000${name}\u0000${extensions.join(';')}\u0000${directories.join(trustedPath.delimiter)}`

  const cached = cache?.get(cacheKey)
  if (cached) {
    const stats = trustedFs.statSync(cached.path, { throwIfNoEntry: false })
    if (
      stats?.isFile()
      && stats.dev === cached.dev
      && stats.ino === cached.ino
      && stats.mtimeMs === cached.mtimeMs
      && stats.size === cached.size
    ) {
      return { path: cached.path }
    }
    // Replaced in place, or gone. Resolve again rather than reporting either.
    cache?.delete(cacheKey)
  }

  for (const directory of directories) {
    const refusal = directoryRefusal(directory, platform, env, readMountTable, namedByOperator.has(directory))
    for (const extension of extensions) {
      const candidate = trustedPath.join(directory, `${name}${extension}`)
      if (!isExecutableFile(candidate, platform)) continue
      if (refusal !== null) {
        return {
          reason: `${name} resolves to ${candidate}, in a directory this daemon does not trust: ${refusal}.`
            + ` Set ${TRUSTED_EXECUTABLE_DIRS_ENV} to a directory holding a trusted ${name} if that location is deliberate.`,
          refusedAt: candidate,
        }
      }
      // The *search* directory is what has to be trusted, not the symlink's
      // target: Homebrew and Nix both put a link in a trusted directory
      // pointing into a store nobody would list. `realpath` afterwards, so the
      // path that gets spawned is the file itself and the cache can tell when
      // an upgrade replaced it.
      let resolved        
      try {
        resolved = trustedFs.realpathSync(candidate)
      } catch {
        continue
      }
      const stats = trustedFs.statSync(resolved, { throwIfNoEntry: false })
      if (!stats?.isFile()) continue
      cache?.set(cacheKey, {
        path: resolved,
        dev: stats.dev,
        ino: stats.ino,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      })
      return { path: resolved }
    }
  }

  return {
    reason: `${name} was not found in any trusted directory on PATH.`
      + ` Install it, or set ${TRUSTED_EXECUTABLE_DIRS_ENV} to the directory holding it.`,
  }
}

/**
 * The path to `name`, or `null` if there is not a trusted one.
 *
 * Callers pass the result straight to `spawn`, and a `null` means the tool is
 * unavailable — the same condition as it not being installed, reported through
 * whatever the caller already does about that. Nothing that used to degrade
 * becomes fatal because of this module.
 */
export function findTrustedExecutablePath(name        , options                           = {})                {
  return resolveTrustedExecutable(name, options).path ?? null
}

/**
 * As `resolveTrustedExecutable`, but accepting a program a caller named by
 * absolute path.
 *
 * The trust question is about `PATH` choosing the file. An absolute path is the
 * caller choosing it — `process.execPath`, a plan that names a tool outright —
 * and there is no search to hijack, so what is checked is only that the path
 * names an executable file. It is still `realpath`ed, so the spawn and any
 * later diagnostic agree on which file ran.
 *
 * A *relative* path is refused rather than resolved. Which directory it is
 * relative to is the caller's decision and differs per call site: the daemon's
 * working directory is a checkout, and quietly picking that would be the
 * current-directory hole in a different shape. Callers that have an intended
 * root resolve against it and pass the absolute result.
 */
export function resolveTrustedProgram(
  program        ,
  options                           = {},
)                              {
  const platform = options.platform ?? process.platform
  if (!trustedPath.isAbsolute(program)) return resolveTrustedExecutable(program, options)
  if (!isExecutableFile(program, platform)) return { reason: `${program} is not an executable file.` }
  // Named outright and present: there is no search to hijack, so the only
  // question left was whether it is a program at all.
  try {
    return { path: trustedFs.realpathSync(program) }
  } catch {
    return { reason: `${program} could not be resolved to a real path.` }
  }
}

/** The path to `name`, or an error saying why there is not one. */
export function requireTrustedExecutablePath(name        , options                           = {})         {
  const resolution = resolveTrustedExecutable(name, options)
  if (resolution.path === undefined) throw new Error(resolution.reason)
  return resolution.path
}
// --- END executable-path ---

/**
 * One cmd.exe token, quoted only when leaving it bare would change it.
 *
 * Quoting everything is the obvious version and it is wrong for a batch file.
 * `cmd` hands a `.cmd` shim its arguments as written, so `%1` becomes
 * `"--version"` with the quotes still attached and a shim that compares
 * `if "%1"=="--version"` stops matching. Real `npm.cmd` only forwards `%*` to
 * Node, whose own parser strips them, which is why this went unnoticed — but the
 * next shim need not be so forgiving.
 *
 * So: quote what would otherwise be split or interpreted — whitespace, and the
 * characters `cmd` treats as syntax — and leave everything else exactly as the
 * caller wrote it. The same rule `dev-preflight.mjs` and `dev-maintenance.ts`
 * already use.
 */
export function quoteForCmd(value) {
  const text = String(value)
  if (!/[\s&|<>^()"]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * Runs a command without a shell re-reading its arguments.
 *
 * `shell: true` on Windows was the previous answer and it is wrong in a way
 * that bites ordinary machines. Node joins the file and arguments with spaces
 * and quotes none of them, so `npm install -g C:\Users\Ada Lovelace\AppData\
 * Local\Temp\looptroop-install-x\looptroop-1.2.3.tgz` reached npm as four
 * arguments — every account whose name contains a space, which is most of them.
 * The same re-parsing is what lets a path be read as a shell operator.
 *
 * A shell is needed on Windows for one reason only: `npm` and `looptroop` are
 * `.cmd` shims there, batch files rather than executable images, and Node has
 * refused to spawn one without a shell since the BatBadBut fix. So the shell is
 * used only when the resolver actually finds a shim, and its command line is
 * built here with explicit quoting rather than by joining on spaces.
 *
 * The name is resolved on *every* platform, not only Windows. `PATH` deciding
 * which `tar` unpacks a downloaded archive, or which `npm` installs it, is the
 * same hole on Linux — it just had no shim problem to make it visible.
 *
 * `smoke-published.mjs` carries the same helper. It is repeated rather than
 * imported because this file is embedded verbatim into `install.sh` and
 * `install.ps1` and cannot import anything at all.
 */
function runTool(command, args, options = {}) {
  const resolved = findTrustedExecutablePath(command)
  // Leaving an unresolved name to fail as ENOENT is deliberate: the caller's own
  // message about a missing tool is better advice than one invented here, and
  // every caller of this has one.
  if (resolved === null) {
    return spawnSync(command, args, { ...options, shell: false })
  }

  // A real executable image, or any POSIX file: spawn it directly.
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(resolved)) {
    return spawnSync(resolved, args, { ...options, shell: false })
  }

  // `/d` skips AutoRun commands from the registry, `/s` makes cmd strip only
  // the outermost pair of quotes and take the rest verbatim, and
  // `windowsVerbatimArguments` stops Node adding a second layer of its own.
  //
  // The executable is always quoted — it is a full path, and the usual place
  // for a Windows tool is under `C:\Program Files`. The arguments are quoted
  // only where they need it, so a shim reading `%1` sees what the caller wrote.
  const line = `"${[`"${resolved}"`, ...args.map(quoteForCmd)].join(' ')}"`
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
    ...options,
    shell: false,
    windowsVerbatimArguments: true,
  })
}

function npmVersion() {
  const probe = runTool('npm', ['--version'], { encoding: 'utf8' })
  return probe.status === 0 ? String(probe.stdout).trim() : null
}

/**
 * Checked against the floor the release itself records, not one baked in here:
 * an installer that hardcodes the requirement is wrong for every release but
 * the one it shipped with. Manifests written before `engines` existed simply
 * carry no floor, and are not treated as failing one.
 */
function checkRuntime(engines) {
  if (!engines) return

  if (engines.node && !satisfiesFloor(process.versions.node, engines.node)) {
    fail(
      `LoopTroop needs Node ${engines.node}; this is ${process.versions.node}.`,
      nodeHelp(process.platform),
      'LoopTroop will not install Node for you.',
    )
  }

  const npm = npmVersion()
  if (npm === null) fail('npm is not on PATH, and installing needs it.', 'It ships with Node; reinstall Node.')
  if (engines.npm && !satisfiesFloor(npm, engines.npm)) {
    fail(`LoopTroop needs npm ${engines.npm}; this is ${npm}.`, `Upgrade with: npm install -g npm@${engines.npm.replace(/^[^\d]*/, '')}`)
  }
}

/**
 * The file on disk against what the release says it should be.
 *
 * Read in chunks rather than with `readFileSync`. The download streams to disk
 * precisely so a 110 MB archive is never held in memory, and hashing it by
 * reading the whole thing back put it there anyway — undoing the bound a few
 * lines after establishing it, at the moment the machine is least likely to
 * have the headroom.
 */
function verifyBytes(file, manifest) {
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  let size = 0
  const handle = openSync(file, 'r')
  try {
    for (;;) {
      const read = readSync(handle, chunk, 0, chunk.length, null)
      if (read === 0) break
      hash.update(chunk.subarray(0, read))
      size += read
    }
  } finally {
    closeSync(handle)
  }
  const sha256 = hash.digest('hex')

  if (typeof manifest.bytes === 'number' && size !== manifest.bytes) {
    fail(`${basename(file)} is ${size} bytes; the release records ${manifest.bytes}.`, 'Nothing was installed.')
  }
  if (sha256 !== manifest.sha256) {
    fail(
      `${basename(file)} does not match the checksum this release published.`,
      `computed ${sha256}`,
      `expected ${manifest.sha256}`,
      'Nothing was installed.',
    )
  }

  say(`Verified sha256 ${sha256}`)
}

function installGlobally(tarball) {
  say(`Installing with npm...`)
  const result = runTool('npm', ['install', '-g', tarball, '--no-audit', '--no-fund'], {
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    // "npm could not be started" and "npm ran and refused" are different
    // problems with different remedies, and this reported both as the second.
    // The Windows resolver regression surfaced as "If that was a permissions
    // error, point npm at a directory you own" when npm had never launched at
    // all, which sent the reader looking in the wrong place entirely.
    if (result.error) {
      fail(
        'npm could not be started.',
        String(result.error.message ?? result.error),
        result.error.code === 'ENOENT'
          ? 'It was not found on your PATH. It ships with Node; reinstall Node.'
          : '',
        'Nothing was installed.',
      )
    }

    fail(
      'npm could not install LoopTroop globally.',
      process.platform === 'win32'
        ? 'If that was a permissions error, point npm at a directory you own:'
        : 'If that was a permissions error, point npm at a directory you own rather than using sudo:',
      '  npm config set prefix ' + (process.platform === 'win32' ? '%USERPROFILE%\\.npm-global' : '~/.npm-global'),
      process.platform === 'win32'
        ? '  then add %USERPROFILE%\\.npm-global to your PATH and open a new terminal'
        : '  export PATH="$HOME/.npm-global/bin:$PATH"',
    )
  }
}

// --- the standalone executable ---------------------------------------------
//
// Everything below exists because this mode unpacks files itself. The npm path
// hands the hard parts to npm; this one owns them, and each of these steps is
// here because skipping it breaks an *upgrade* rather than a first install —
// which is the case that matters, since it lands on somebody already using the
// program.

const EXE = process.platform === 'win32' ? '.exe' : ''

/**
 * Removes something if it can, and never throws. A leftover is not a failure.
 *
 * Retried, because most of what this removes is an executable that was running
 * moments ago and Windows does not release a handle the instant a process
 * exits. `force` swallows ENOENT and nothing else, so without the retries a
 * successful install could end by reporting EPERM.
 */
function discard(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    return true
  } catch {
    return false
  }
}

/**
 * Unpacks the release archive.
 *
 * `tar` reads both formats on all three platforms — GNU tar on Linux, bsdtar on
 * macOS, and bsdtar shipped with Windows since 1803, which reads zip too — and
 * all of them detect the compression from the file rather than the flags.
 * PowerShell is the fallback for a Windows old enough to lack it.
 */
function extractArchive(archive, into) {
  mkdirSync(into, { recursive: true })

  // Through `runTool`, so the tool that unpacks a downloaded archive is one this
  // machine trusts rather than whichever `PATH` entry answered first. An
  // unresolvable `tar` falls through to the same fallback a failing one does.
  const tar = runTool('tar', ['-xf', archive, '-C', into], { encoding: 'utf8' })
  if (tar.status === 0) return

  if (process.platform === 'win32') {
    const quote = (value) => `'${value.replace(/'/g, "''")}'`
    const powershell = runTool('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(into)} -Force`,
    ], { encoding: 'utf8' })
    if (powershell.status === 0) return
  }

  fail(
    `Could not unpack ${basename(archive)}.`,
    String(tar.stderr || tar.error?.message || '').trim(),
    'Nothing was installed.',
  )
}

/**
 * Runs `action` with nobody else installing into `dir` at the same time.
 *
 * Two installers in one directory is not hypothetical — a user re-running a
 * curl pipe because the first looked stuck is exactly how it happens — and the
 * interleaving that costs you is one process renaming the backup into place
 * while the other is mid-swap, which ends with no working executable at all.
 *
 * A lock left by a killed process would otherwise wedge the directory forever,
 * so one older than the longest plausible install is taken rather than obeyed.
 */
function withInstallLock(dir, action) {
  const lock = join(dir, '.install.lock')
  const STALE_AFTER = 15 * 60 * 1000
  // Not the pid: pids are reused, and two installers started a second apart on
  // a busy machine can hold the same one after a wrap. A token nobody else can
  // reproduce makes "is this still my lock?" answerable.
  const token = `${process.pid}-${randomUUID()}`

  const take = () => {
    writeFileSync(lock, `${token} ${new Date().toISOString()}\n`, { flag: 'wx' })
  }
  const holdsOurs = () => {
    try {
      return readFileSync(lock, 'utf8').startsWith(`${token} `)
    } catch {
      return false
    }
  }

  /**
   * Clears a lock left by a killed run, or refuses.
   *
   * The obvious version — see it is old, delete it, create a new one — is not
   * safe with two installers in the directory: both see the same stale lock,
   * both delete it, both create one, and the second deletes the first's *new*
   * lock on its way past. Both then believe they hold it.
   *
   * `rename` is the fix, because exactly one process can rename a given file:
   * whoever wins takes custody of the old lock and the losers get ENOENT and
   * fall through to `take()`, where `wx` decides between them. Custody also
   * makes the staleness test sound — the age is read from a file nobody else
   * can still be touching — and a lock that turns out to be fresh is renamed
   * back rather than destroyed.
   */
  const clearStaleLock = () => {
    const observed = statSync(lock, { throwIfNoEntry: false })
    if (observed === undefined) return
    if (Date.now() - observed.mtimeMs < STALE_AFTER) {
      fail(
        'Another install is already running in this directory.',
        `Its lock is at ${lock}.`,
        'Wait for it to finish, or delete that file if you are sure nothing is running.',
      )
    }

    const aside = `${lock}.stale-${token}`
    try {
      renameSync(lock, aside)
    } catch (error) {
      // Somebody else got there first. Their `take()` and ours now race on
      // `wx`, which is exactly the outcome this is trying to reach.
      if (error.code === 'ENOENT') return
      throw error
    }

    const owned = statSync(aside, { throwIfNoEntry: false })
    const age = Date.now() - (owned?.mtimeMs ?? 0)
    if (owned !== undefined && age < STALE_AFTER) {
      // It was refreshed between the check above and the rename, so it belongs
      // to a live install after all. Put it back before refusing.
      renameSync(aside, lock)
      fail(
        'Another install is already running in this directory.',
        `Its lock is at ${lock}.`,
        'Wait for it to finish, or delete that file if you are sure nothing is running.',
      )
    }

    say(`Clearing a stale install lock (${Math.round(age / 60000)} minutes old).`)
    discard(aside)
  }

  try {
    take()
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    clearStaleLock()
    try {
      take()
    } catch (retry) {
      if (retry.code !== 'EEXIST') throw retry
      fail(
        'Another install took the lock in this directory first.',
        `Its lock is at ${lock}.`,
        'Wait for it to finish and run this again.',
      )
    }
  }

  try {
    return action()
  } finally {
    // Only ours. Removing a lock we do not hold is the same mistake the
    // takeover above exists to prevent, reached from the other end.
    if (holdsOurs()) discard(lock)
  }
}

/**
 * What `status --json` says, or null if the copy cannot say it.
 *
 * Two questions are asked of this, and they are not the same question — which
 * is the mistake that made a live-but-unresponsive daemon read as stopped, and
 * then, in fixing that, made an unresponsive one read as successfully started.
 * The document is parsed once here and the two questions are asked separately
 * below.
 */
function daemonStatus(binary) {
  // The exit code is not the answer — `status` reports a stopped daemon by
  // saying so, and how it scores that is its business — so this reads the
  // document and ignores the code.
  const probe = spawnSync(binary, ['status', '--json'], { encoding: 'utf8', timeout: 30_000 })
  try {
    const status = JSON.parse(probe.stdout)
    return {
      answering: status.running === true,
      // A process that is alive and not talking. `status --json` reports it as
      // `running: false` with the pid here, deliberately: the CLI's own comment
      // says the split exists because "every installer reads `running` as
      // answering, and it must keep meaning exactly that".
      present: status.running === true || (status.notAnswering ?? null) !== null,
    }
  } catch {
    return null
  }
}

/**
 * Is there a LoopTroop process at all — answering or not? Null if it cannot say.
 *
 * This is the question the *stop* decision asks. Reading only `running` called
 * a live process holding the port "stopped": nothing was stopped, nothing was
 * restarted, the executable was replaced underneath it, and the daemon started
 * afterwards could not bind.
 */
function daemonPresent(binary) {
  return daemonStatus(binary)?.present ?? null
}

/**
 * Is the daemon up and answering? Null if it cannot say.
 *
 * This is the question the *start* decision asks, and it is deliberately
 * stricter than `daemonPresent`. A process that came up and never answered is
 * exactly the failure the restart check exists to catch, so counting it as
 * started would report a broken upgrade as a successful one and skip the
 * rollback.
 */
function daemonAnswering(binary) {
  return daemonStatus(binary)?.answering ?? null
}


/** True when the executable at `binary` runs at all. */
function executableRuns(binary) {
  return spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 60_000 }).status === 0
}

/**
 * Stops the daemon and waits for it to actually be gone.
 *
 * "Confirm exit" rather than "ask it to stop": on Windows the file cannot be
 * replaced while a process holds it open, and on every platform an upgrade that
 * swaps the executable under a live daemon leaves a running old version that
 * `--version` will cheerfully misreport as the new one.
 *
 * Confirmed *stopped*, not merely "not confirmed running". `daemonPresent` has
 * three answers and this used to accept two of them, so a probe that could not
 * say anything counted as success and the swap went ahead under a daemon nobody
 * had established was down.
 */
function stopDaemon(binary) {
  say('Stopping the running daemon...')
  spawnSync(binary, ['stop'], { stdio: 'inherit', timeout: 60_000 })

  return waitFor(() => daemonPresent(binary) === false, 30_000)
}

/**
 * Brings the installed copy to a state where replacing it is safe, and says
 * whether its daemon has to be running again afterwards.
 *
 * The three answers of `daemonPresent` need three branches, and treating the
 * third as "stopped" was the bug: an upgrade could swap the executable under a
 * live daemon and then not restart it, leaving the old version serving while
 * `looptroop --version` reported the new one.
 *
 * The unknown case is resolved rather than refused. Refusing would be the
 * strictest reading, but it wedges the one person who most needs to reinstall —
 * somebody whose installed executable is broken can never make it answer a
 * probe, and so could never install over it. So: an executable that cannot even
 * print its own version is not serving anything and is replaced; one that runs
 * but will not report is asked to stop and must then *confirm* it is stopped,
 * and is started again afterwards because this may well have taken a live
 * service down.
 */
function settleDaemon(installed) {
  const state = daemonPresent(installed)

  if (state === true) {
    if (!stopDaemon(installed)) {
      fail(
        'The LoopTroop daemon did not stop, so the executable was left alone.',
        'Stop it yourself and run this again:',
        `  ${installed} stop`,
        'Nothing was installed.',
      )
    }
    return { wasRunning: true }
  }

  if (state === false) return { wasRunning: false }

  if (!executableRuns(installed)) {
    say('The installed copy does not run, so there is no daemon of its to stop.')
    return { wasRunning: false }
  }

  say('The installed copy would not report whether its daemon is running; stopping it to be sure...')
  const stopped = spawnSync(installed, ['stop'], { stdio: 'inherit', timeout: 60_000 })

  // Not `stopDaemon`, which requires a *confirmed* stopped state from the
  // status probe. A copy whose `status` output cannot be read will never
  // confirm anything, so demanding it here would wedge the upgrade forever
  // rather than once — the state it refuses over is the state this branch
  // started in.
  //
  // But "the probe did not say `true`" is not evidence either: an unreadable
  // probe returns null, which satisfies that on the first poll, so the wait
  // proved nothing and the swap went ahead on no information at all. `stop`'s
  // own exit code is the evidence that was being thrown away. Exit 0 is the
  // program stating that it stopped, which is as affirmative as this branch can
  // get; anything else, with a probe that still cannot answer, means nothing was
  // established and the executable is left alone.
  // A daemon that says outright it is still running gets the same grace a
  // confirmed-running one does. An unreadable probe satisfies this on the first
  // poll, which is why it cannot be the only check.
  if (!waitFor(() => daemonPresent(installed) !== true, 30_000)) {
    fail(
      'The LoopTroop daemon is still running after being asked to stop.',
      'Replacing the executable now would leave the old version serving and reporting the new one\'s version.',
      'Stop it yourself and run this again:',
      `  ${installed} stop`,
      'Nothing was installed.',
    )
  }

  // Neither source of evidence produced anything: the probe still cannot say,
  // and `stop` reported that it failed. Refuse rather than swap on nothing.
  if (stopped.status !== 0 && daemonPresent(installed) !== false) {
    fail(
      'The installed copy will not say whether its daemon is running, and `stop` did not succeed.',
      `\`${basename(installed)} stop\` exited ${String(stopped.status ?? stopped.signal ?? 'without a status')}.`,
      'Replacing the executable now could leave the old version serving and reporting the new one\'s version.',
      'Stop it yourself and run this again, or remove the install directory and install afresh:',
      `  ${installed} stop`,
      'Nothing was installed.',
    )
  }

  // It was asked to stop from an unknown state and said it stopped, so it may
  // well have been serving. Starting it again is the outcome that cannot leave
  // an outage behind.
  return { wasRunning: true }
}

/**
 * Starts the daemon and waits until it is actually answering.
 *
 * The exit code of `start` is not the answer. It detaches, so it can report
 * success and then die a second later — and this is called at the point where
 * the difference decides whether an upgrade rolls back.
 */
function startDaemon(binary) {
  spawnSync(binary, ['start'], { stdio: 'inherit', timeout: 120_000 })

  // 30s: a daemon that is coming up answers in about two, so this is already
  // an order of magnitude of headroom. Waiting longer would not rescue a build
  // that is going to fail — it would only make every rollback slower to reach.
  return waitFor(() => daemonAnswering(binary) === true, 30_000)
}

/** Polls until `condition` holds, or gives up. */
function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() >= deadline) return false
    // No timers: this is a synchronous stretch, and `Atomics.wait` is the one
    // sleep that does not need the event loop to turn.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
}

/**
 * Puts `staged` at `installed`, keeping whatever was there until the new one
 * has proved it runs.
 *
 * Two renames rather than a copy over the top. `rename` within a directory is
 * atomic, so no reader ever sees a half-written file, and it is the one
 * operation permitted on a *running* executable on Windows — which cannot be
 * overwritten or deleted, but can be moved out of the way.
 */
function swapIntoPlace(staged, installed, backup) {
  const incoming = `${installed}.incoming-${process.pid}`

  // Copied into the destination directory first so the rename that matters is
  // same-filesystem. Across devices `rename` is EXDEV, and the fallback for
  // that is a copy — which is exactly the non-atomic write being avoided.
  copyFileSync(staged, incoming)
  chmodSync(incoming, 0o755)

  const had = existsSync(installed)
  if (had) renameSync(installed, backup)

  try {
    renameSync(incoming, installed)
  } catch (error) {
    discard(incoming)
    if (had) renameSync(backup, installed)
    throw error
  }

  return had
}

/**
 * Installs the standalone executable, transactionally.
 *
 * Transactional meaning: at every moment during this, `looptroop` on the user's
 * PATH is either the old working version or the new working version. There is
 * no window where it is a half-written file, and no outcome where a failure
 * partway leaves nothing installed.
 */
function installBinary(archive, { version, prefix }) {
  const bin = join(prefix, 'bin')
  mkdirSync(bin, { recursive: true })

  return withInstallLock(prefix, () => {
    const installed = join(bin, `looptroop${EXE}`)
    const backup = join(bin, `.looptroop-previous-${process.pid}${EXE}`)

    // Anything an earlier run left behind: a backup or a staging copy from one
    // that was killed, and the rejected executable from one that rolled back.
    // Sweeping at the start rather than the end is what bounds this to a single
    // leftover — the most recent failure stays inspectable, which is the one
    // anybody would want, and the ~110 MB before it does not accumulate.
    //
    // Not fatal if something will not go. A leftover is inert, and refusing an
    // install over one would be worse than leaving it.
    //
    // With one exception. A backup is only spare when there is a working
    // executable beside it; with `installed` missing, that backup *is* the
    // user's copy of LoopTroop. A rollback whose restore failed leaves exactly
    // that state and tells them where the backup is — and re-running the
    // installer, which is what anyone would do next, used to delete it here
    // before the fresh install had proved anything. Staging and rejected copies
    // are still swept: neither is anybody's only copy.
    const nothingInstalled = !existsSync(installed)
    for (const entry of readdirSync(bin)) {
      const isBackup = /^\.looptroop-previous-\d+/.test(entry)
      if (isBackup && nothingInstalled) continue
      if (isBackup || /\.(incoming|rejected)-\d+$/.test(entry)) {
        discard(join(bin, entry))
      }
    }

    const unpacked = join(dirname(archive), 'unpacked')
    extractArchive(archive, unpacked)

    const root = join(unpacked, basename(archive).replace(/\.(tar\.gz|zip)$/, ''))
    const staged = join(root, `looptroop${EXE}`)
    if (!statSync(staged, { throwIfNoEntry: false })?.isFile()) {
      fail(`${basename(archive)} does not contain looptroop${EXE} where it should.`, 'Nothing was installed.')
    }

    const { wasRunning } = existsSync(installed) ? settleDaemon(installed) : { wasRunning: false }

    let replaced
    try {
      replaced = swapIntoPlace(staged, installed, backup)
    } catch (error) {
      // `swapIntoPlace` already put the old executable back, but the daemon was
      // stopped before it ran — so leaving here without starting it again is the
      // same outage the rollback path exists to prevent, reached by a different
      // route. Windows makes this the *likeliest* route, not a remote one: it is
      // where a locked file lands.
      const restored = wasRunning ? startDaemon(installed) : null

      fail(
        `Could not replace ${installed}.`,
        String(error.message ?? error),
        process.platform === 'win32'
          ? 'On Windows a running program cannot be replaced; check nothing else is using it.'
          : '',
        'Nothing was installed; the previous version is untouched.',
        restored === true ? 'Its daemon is running again.' : '',
        restored === false
          ? `Its daemon did not start again. Start it with: ${installed} start`
          : '',
      )
    }

    // The install is not finished until the thing that was installed runs. A
    // truncated download is caught by the checksum, but an executable that is
    // whole and still cannot start here — wrong architecture, a macOS signature
    // the kernel refuses, a missing glibc symbol — passes every earlier check
    // and fails at the only moment the user is watching.
    /**
     * Undoes the swap and puts the user back where they started — *including*
     * the daemon.
     *
     * Restoring the executable is only half of it. This ran `stop` on a service
     * that was up, so a rollback that restores the file and returns leaves the
     * old version installed and not running, which is an outage caused by an
     * upgrade that reported failure — the worst of both. The restart is
     * therefore part of the rollback, and whether it worked is reported rather
     * than assumed.
     */
    const rollBack = (reason, ...detail) => {
      const quarantine = `${installed}.rejected-${process.pid}`
      discard(quarantine)
      renameSync(installed, quarantine)

      // Two renames, and the second one can fail — a Windows lock, a permission
      // change, a full disk. Unguarded, that left the good executable sitting in
      // quarantine with nothing at `installed`: no version installed at all,
      // from the path whose entire purpose is to put the previous one back. If
      // the restore will not go, the rejected file goes back where it was, so
      // the user is left with *something* rather than nothing.
      if (replaced) {
        try {
          renameSync(backup, installed)
        } catch (restoreError) {
          // Put the rejected file back rather than leave nothing installed. It
          // does not work — that is why this path was reached — but a program
          // that fails is recoverable, and an absent one is not.
          let putBack = false
          try {
            renameSync(quarantine, installed)
            putBack = true
          } catch {
            // Nothing left to try; the message says where each copy ended up.
          }

          fail(
            reason,
            ...detail,
            `Your previous version could not be put back: ${String(restoreError.message ?? restoreError)}`,
            `It is at ${backup}.`,
            // Named where it actually is. Saying "at <quarantine>" after a
            // successful put-back sends the reader to a path with nothing at it.
            putBack
              ? `The version that failed is back at ${installed}, so the command runs but does not work.`
              : `The version that failed is at ${quarantine}, and nothing is installed at ${installed}.`,
            `Move ${backup} to ${installed} to recover.`,
          )
        }
      }

      const restored = replaced && wasRunning ? startDaemon(installed) : null

      fail(
        reason,
        ...detail,
        replaced ? 'Your previous version is back in place.' : '',
        restored === true ? 'It is running again.' : '',
        restored === false
          ? `It did not start again. Start it yourself with: ${installed} start`
          : '',
        `The rejected file is at ${quarantine} if you want to look at it.`,
      )
    }

    const probe = spawnSync(installed, ['--version'], { encoding: 'utf8', timeout: 60_000 })
    const reported = probe.status === 0 ? String(probe.stdout).trim() : null

    if (reported !== version) {
      rollBack(
        replaced
          ? `The new executable did not run, so ${version} was rolled back.`
          : 'The downloaded executable does not run here.',
        reported === null
          ? `\`looptroop --version\` exited ${String(probe.status ?? probe.signal)}: ${String(probe.stderr || probe.error?.message || '').trim().slice(0, 400)}`
          : `\`looptroop --version\` reported ${reported}, expected ${version}.`,
      )
    }

    // Restarted here rather than after this function returns, because here the
    // backup still exists and the lock is still held. `--version` succeeding
    // proves the file runs; it does not prove the daemon comes up, and those
    // are different failures — a build that starts and immediately exits passes
    // the first and fails the second. Confirming it before discarding the only
    // copy of the working version is what makes this an upgrade you can undo.
    if (wasRunning) {
      say('Starting it again...')
      if (!startDaemon(installed)) {
        rollBack(
          `${version} installed but its daemon would not start, so it was rolled back.`,
          'The executable runs and reports the right version; it does not stay up.',
        )
      }
    }

    // Node's licence travels with Node, and this archive carries a copy of Node.
    // It goes beside the program because that is where it has to be for the
    // install to be a lawful redistribution, not because anyone will read it.
    //
    // Copied here, after the executable transaction has committed, rather than
    // before it. Copied first, every one of these files landed in the prefix
    // ahead of the daemon check, the swap, the version probe and the restart —
    // so a rollback restored the executable and said "your previous version is
    // back in place" beside the *new* version's licences and notices. The
    // executable is the only thing with a rollback, so it is the only thing
    // that may be written before the install is known to have worked.
    const strays = []
    for (const file of readdirSync(root)) {
      if (file === `looptroop${EXE}`) continue
      try {
        copyFileSync(join(root, file), join(prefix, file))
      } catch {
        strays.push(file)
      }
    }
    if (strays.length > 0) {
      // Not a rollback. The program is installed, verified and running; what
      // failed is documentation that travels beside it, and undoing a working
      // upgrade over that would be the worse outcome. Said out loud so it is
      // not a silent omission.
      say(`Note: could not update ${strays.join(', ')} in ${prefix}.`)
    }

    discard(backup)
    return { installed, wasRunning }
  })
}

async function main(argv) {
  const options = parseArgs(argv)
  const workDir = mkdtempSync(resolve(tmpdir(), 'looptroop-install-'))

  // A signal is not an error this can unwind through: the process ends where it
  // stands, so the `finally` below never runs and an interrupted install leaves
  // its downloads behind. Every one of these leaks a directory that may hold a
  // 110 MB archive, and Ctrl+C during a download is the ordinary way somebody
  // changes their mind.
  //
  // Re-raised rather than exited, with the listener removed first so the second
  // delivery takes the default action. A caller that sent a signal expects the
  // 128+signal status back, not an ordinary exit code chosen here.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      discard(workDir)
      process.removeAllListeners(signal)
      process.kill(process.pid, signal)
    })
  }
  // What we resolved and installed, so the closing message can be checked
  // against it. Stays null for `--tarball`, where a local file is taken on
  // trust and there is no release to name a version.
  let intended = null
  // How to get `looptroop` on PATH, which is a different answer per mode: npm
  // has a global bin directory it can be asked about, and `--binary` has one we
  // chose. Filled in by whichever branch runs.
  let pathAdvice = [
    'Open a new terminal, or add npm\'s global bin directory to PATH: npm prefix -g',
  ]
  // Where this run put the program, when it chose. Null for the npm path, where
  // npm chose and the honest answer is `npm prefix -g`.
  let installedPath = null

  try {
    if (options.binary) {
      const decision = binaryTarget(process.platform, process.arch, detectLibc())
      if (decision.refusal) fail('There is no standalone executable for this platform.', ...decision.refusal)

      const prefix = resolve(options.prefix ?? defaultPrefix())
      const url = options.version === null
        ? `${API}/repos/${REPO}/releases?per_page=100`
        : `${API}/repos/${REPO}/releases/tags/v${options.version}`
      const payload = await getJson(url)
      const releases = Array.isArray(payload) ? payload : [payload]

      const release = selectRelease(releases, options.version, (candidate) => binaryAssets(candidate, decision.target))
      if (release === null) {
        fail(
          options.version === null
            ? `No published release carries a ${decision.target} executable yet.`
            : `Release v${options.version} carries no ${decision.target} executable.`,
          `Looked at ${releases.length} release(s) of ${REPO}.`,
          'Releases from before the standalone executables existed carry only the npm package.',
        )
      }

      const { manifest: manifestAsset, archive: archiveAsset } = binaryAssets(release, decision.target)
      intended = versionOf(release)
      say(`Installing LoopTroop ${intended} (${decision.target}) into ${prefix}`)

      // No `checkRuntime` here, deliberately. The floor a release records is the
      // Node it needs to *run*, and this executable carries its own — so
      // enforcing it would refuse to install, on the grounds of a missing Node,
      // the one build that does not need one.
      const manifestPath = resolve(workDir, MANIFEST_ASSET)
      await download(manifestAsset.browser_download_url, manifestPath)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

      const digest = manifest.assets?.[archiveAsset.name]
      if (!digest) {
        fail(
          `The release manifest for ${intended} records no checksum for ${archiveAsset.name}.`,
          'Installing it would mean trusting a download with nothing to check it against.',
        )
      }

      const archivePath = resolve(workDir, archiveAsset.name)
      if (options.dryRun) {
        say(`would download ${archiveAsset.browser_download_url}`)
        say(`would verify sha256 ${digest.sha256}`)
        say(`would install ${archiveAsset.name} into ${join(prefix, 'bin')}`)
        return
      }

      say(`Downloading ${archiveAsset.name}...`)
      await download(archiveAsset.browser_download_url, archivePath)
      verifyBytes(archivePath, digest)

      // The daemon, if there was one, is already back up: `installBinary`
      // restarts it before letting go of the backup, so that a daemon which
      // will not start is a rollback rather than an outage.
      const { installed, wasRunning } = installBinary(archivePath, { version: intended, prefix })
      installedPath = installed
      say(`Installed ${installed}${wasRunning ? ', and the daemon is running again' : ''}`)

      const bin = join(prefix, 'bin')
      pathAdvice = onPath(bin)
        ? [`It is installed at ${installed}, and ${bin} is already on your PATH.`]
        : process.platform === 'win32'
          ? [
            `Add ${bin} to your PATH, then open a new terminal:`,
            `  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${bin}', 'User')`,
          ]
          : [
            `Add ${bin} to your PATH, then open a new terminal:`,
            `  echo 'export PATH="${bin}:$PATH"' >> ~/.profile`,
          ]
    } else if (options.tarball !== null) {
      const local = resolve(options.tarball)
      if (!statSync(local, { throwIfNoEntry: false })?.isFile()) fail(`No such tarball: ${local}`)
      say(`Installing from ${local} (local file: no checksum to compare against).`)
      if (options.dryRun) return say(`would install ${local}`)
      installGlobally(local)
    } else {
      // 100 is the API's maximum page size, and this deliberately reads one
      // page rather than paginating. The endpoint returns newest first and the
      // answer is normally the first entry, so paging further would only matter
      // if the hundred most recent releases in a row carried no installable
      // assets — which would mean something far more wrong than a lookup.
      //
      // The failure is loud either way: an unfound release is an error naming
      // how many were examined, never a quiet fallback to something older.
      const url = options.version === null
        ? `${API}/repos/${REPO}/releases?per_page=100`
        : `${API}/repos/${REPO}/releases/tags/v${options.version}`
      const payload = await getJson(url)
      const releases = Array.isArray(payload) ? payload : [payload]

      const release = selectRelease(releases, options.version)
      if (release === null) {
        fail(
          options.version === null
            ? 'No published release carries installable assets yet.'
            : `Release v${options.version} has no installable assets.`,
          `Looked at ${releases.length} release(s) of ${REPO}.`,
        )
      }

      const { manifest: manifestAsset, tarball: tarballAsset } = installableAssets(release)
      intended = versionOf(release)
      say(`Installing LoopTroop ${intended}`)

      const manifestPath = resolve(workDir, MANIFEST_ASSET)
      await download(manifestAsset.browser_download_url, manifestPath)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

      checkRuntime(manifest.engines)

      const tarballPath = resolve(workDir, tarballAsset.name)
      if (options.dryRun) {
        say(`would download ${tarballAsset.browser_download_url}`)
        say(`would verify sha256 ${manifest.sha256}`)
        say(`would install ${tarballAsset.name}`)
        return
      }

      say(`Downloading ${tarballAsset.name}...`)
      await download(tarballAsset.browser_download_url, tarballPath)
      verifyBytes(tarballPath, manifest)
      installGlobally(tarballPath)
    }
  } finally {
    // Through `discard`, which retries and never throws. Failing to remove a
    // temporary directory must not turn an install that worked into one that
    // reports an error — and on Windows, after unpacking and running an
    // executable, that is a real possibility rather than a theoretical one.
    discard(workDir)
  }

  // Advisory only. `doctor` exits non-zero until OpenCode is set up, which is
  // the normal state seconds after installing, so a failing check here would
  // report a broken install that is not broken.
  //
  // This runs the bare command, deliberately: the question it answers is what
  // the user's shell will do when they type `looptroop`, not whether files
  // landed on disk. But that means the answer can come from a different copy
  // earlier in PATH, so it is checked against what was actually installed
  // rather than reported as though it must be the same thing. Reporting it
  // blindly claimed a successful install of whatever version happened to
  // answer — including, when npm's global bin is not on PATH at all, an older
  // copy that the install never touched.
  const probe = runTool('looptroop', ['--version'], { encoding: 'utf8' })
  const reported = probe.status === 0 ? String(probe.stdout).trim() : null
  say('')
  if (reported === null) {
    say('Installed, but `looptroop` is not on your PATH yet.')
    for (const line of pathAdvice) say(line)
  } else if (intended === null || reported === intended) {
    say(`Installed: looptroop ${reported}`)
  } else {
    say(`Installed: looptroop ${intended}`)
    say('')
    say(`But \`looptroop\` on your PATH is ${reported}, so another copy comes first.`)
    if (installedPath !== null) say(`This install is at ${installedPath}.`)
    say(`Find it with: ${process.platform === 'win32' ? 'where looptroop' : 'command -v looptroop'}`)
  }
  say('')
  // `open` rather than `setup`: LoopTroop is used through its interface, and
  // `open` starts the daemon itself and lands the user in it. `setup` attaches a
  // project from the terminal, which is a thing you may never need to do.
  say('Next: run `looptroop doctor` to check this machine, then `looptroop open`.')
}

/**
 * Is this file the program being run, rather than something imported?
 *
 * Through `realpath` on both sides, which is not pedantry. The wrappers write
 * this file into the system temporary directory and run it from there, and on
 * macOS that directory is reached through `/var`, a symlink to `/private/var`.
 * Node resolves symlinks when it records `import.meta.url` and does not when it
 * records `argv[1]`, so a naive comparison is false on exactly one platform —
 * and a false answer here is not an error, it is a program that does nothing at
 * all and exits 0. The installer "succeeded" and installed nothing.
 */
function isMainModule() {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked)
  } catch {
    // Either path may not exist under an unusual loader; fall back to comparing
    // them unresolved rather than refusing to run.
    return import.meta.url === pathToFileURL(invoked).href
  }
}

if (isMainModule()) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof InstallError)) throw error
    process.stderr.write(`\nlooptroop install: ${error.message}\n`)
    for (const line of error.detail) process.stderr.write(`  ${line}\n`)
    process.stderr.write('\n')
    // Not `process.exit`: see InstallError. The process ends once the last
    // handle closes, which for a finished fetch is immediately.
    process.exitCode = 1
  }
}
