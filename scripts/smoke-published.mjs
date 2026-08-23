#!/usr/bin/env node
/**
 * Installs a published release the way its documentation tells a user to, from
 * the real feed, and drives it until it serves.
 *
 *   node scripts/smoke-published.mjs --channel npm --version 9.9.9
 *   node scripts/smoke-published.mjs --channel npm --version 9.9.9 --pin --profile gate
 *   node scripts/smoke-published.mjs --plan --tier release
 *
 * The rest of this repository's smoke tests prove that a locally built artefact
 * works. None of them can see a broken publish: a tap that never received its
 * commit, a `bin` mapping that survived `npm pack` and not `npm publish`, a
 * registry serving the previous version behind `@latest`. This one installs
 * what users install.
 *
 * `--version` is required rather than read from package.json. The checkout and
 * the feed are different things, and that difference is the entire subject: a
 * script that reads its own version can only ever test a local build, which is
 * why `smoke-installer.mjs` cannot do this job.
 *
 * WAITING IS NOT RETRYING
 *
 * `awaitPublished` polls the feed's *metadata* for the presence of a version.
 * It never installs anything, never runs an assertion, and never observes a
 * failure it could mask. Once the version is present — or the cap expires —
 * the assertions run exactly once and their result stands. Re-running a failed
 * assertion until it passes would hide the races this exists to find, and
 * AGENTS.md forbids it.
 */
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'

/** GitHub's releases feed, for resolving "latest stable" and for asset probes. */
const REPO = process.env.LOOPTROOP_INSTALL_REPO || 'looptroop-ai/LoopTroop'
const API = process.env.LOOPTROOP_INSTALL_API || 'https://api.github.com'

const POLL_INTERVAL_MS = 15_000

// ---------------------------------------------------------------------------
// The recipe table. One entry per documented install method; the only place a
// channel is defined, so `--plan` and the assertions cannot disagree.
// ---------------------------------------------------------------------------

/**
 * `tier` and `opencode` belong to a *leg*, not to a channel, because Homebrew
 * is release-tier on macOS while Linuxbrew is weekly-tier, and a single `tier`
 * string per channel cannot express that.
 *
 * OPENCODE IS INSTALLED FROM NPM ON EVERY LEG.
 *
 * The launch shape only matters on Windows, and there npm is the interesting
 * one: from the official installer or Scoop `opencode` is an `.exe`, but from
 * npm, bun or pnpm it is `opencode.cmd`, which `CreateProcess` cannot find and
 * which Node refuses to launch directly. A release once shipped a daemon that
 * could not spawn it, leaving LoopTroop unusable for every Windows user who
 * had installed OpenCode that way. On Linux and macOS both routes leave an
 * ordinary executable on PATH and LoopTroop cannot tell them apart, so the
 * official installer would prove nothing extra there.
 *
 * It also removes a real flake. `opencode.ai/install` resolves its version
 * through the GitHub API, and this workflow deliberately gives third-party
 * installers no token — so it ran unauthenticated from a shared runner address
 * and intermittently died on the anonymous rate limit with "Failed to fetch
 * version information". Installing from the npm registry avoids that API
 * entirely without weakening the no-token rule.
 */
export const CHANNELS = {
  npm: {
    // Verbatim from README.md. If that changes, this must change with it.
    documented: 'npm install -g looptroop',
    legs: [
      { os: 'ubuntu-latest', tier: 'release', opencode: 'npm' },
      { os: 'macos-latest', tier: 'release', opencode: 'npm' },
      // The `.cmd` shape, and the reason this is real OpenCode rather than mock.
      { os: 'windows-latest', tier: 'release', opencode: 'npm' },
    ],
    daemon: true,
    pinnable: true,
    port: 39121,
    opencodePort: 39621,
    propagationCapMs: 3 * 60_000,
    publishJob: 'npm',
    publishHint: 'Check https://www.npmjs.com/package/looptroop?activeTab=versions',
    install: ({ version, pin }) =>
      npmSpec(['install', '--global', pin ? `looptroop@${version}` : 'looptroop']),
    uninstall: () => npmSpec(['uninstall', '--global', 'looptroop']),
    published: probeNpmRegistry,
    latest: async () => probeNpmLatest(),
    expect: {
      channel: 'npm',
      // A function, not a string: the binary channel's command differs by
      // platform, so the shape has to allow it everywhere.
      upgradeCommand: () => 'npm install -g looptroop@latest',
      okChecksPre: ['install', 'git', 'npm', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  },

  // The POSIX one-liner, through the website. `install.sh` and `install.ps1`
  // are the only two files in the repository that nothing else exercises
  // end-to-end: `smoke-installer.mjs` runs the wrappers against a *local*
  // tarball and says so in its header — "the network path is proved once,
  // against a real release". This is that proof, and until now it existed only
  // for PowerShell.
  'installer-sh': {
    documented: 'curl -fsSL https://www.looptroop.ovh/install | sh',
    legs: [
      { os: 'ubuntu-latest', tier: 'release', opencode: 'npm' },
      { os: 'macos-latest', tier: 'release', opencode: 'npm' },
    ],
    daemon: true,
    pinnable: true,
    port: 39122,
    opencodePort: 39622,
    propagationCapMs: 5 * 60_000,
    publishJob: 'finalize',
    publishHint: 'The website redirects /install to the latest release asset; check the release has install.sh attached.',
    install: ({ version, pin }) => shellSpec(
      `curl -fsSL ${installerUrl('install.sh', version, pin)} | sh${pin ? ` -s -- --version ${version}` : ''}`,
    ),
    // The installer's default mode hands the verified tarball to `npm install
    // -g`, precisely so that npm's own uninstall keeps working.
    uninstall: () => npmSpec(['uninstall', '--global', 'looptroop']),
    published: probeReleaseAsset('install.sh'),
    expect: {
      // `npm`, not some "installer" channel. The installer writes no marker
      // file, so `detectFromShape` classifies it by where the module sits — and
      // in default mode that is under `node_modules/looptroop/`. Anyone
      // "correcting" this to `installer-sh` will break the leg.
      channel: 'npm',
      upgradeCommand: () => 'npm install -g looptroop@latest',
      okChecksPre: ['install', 'git', 'npm', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  },

  // The same wrapper under Windows PowerShell 5.1 rather than PowerShell 7.
  // They are different runtimes, and 5.1 is the one that ships with Windows —
  // so it is what the documented one-liner lands in for anyone who has never
  // installed pwsh.
  'installer-ps1': {
    documented: 'irm https://www.looptroop.ovh/install.ps1 | iex',
    legs: [{ os: 'windows-latest', tier: 'release', opencode: 'npm' }],
    daemon: true,
    pinnable: true,
    port: 39123,
    opencodePort: 39623,
    propagationCapMs: 5 * 60_000,
    publishJob: 'finalize',
    publishHint: 'The website redirects /install.ps1 to the latest release asset.',
    install: ({ version, pin }) => powershellSpec(
      pin
        // A piped script cannot be given a parameter, so a pinned run needs the
        // scriptblock form — the same shape `installChannel.ts` uses for the
        // binary upgrade command.
        ? `& ([scriptblock]::Create((irm ${installerUrl('install.ps1', version, pin)}))) -Version ${version}`
        : 'irm https://www.looptroop.ovh/install.ps1 | iex',
    ),
    uninstall: () => npmSpec(['uninstall', '--global', 'looptroop']),
    published: probeReleaseAsset('install.ps1'),
    expect: {
      channel: 'npm',
      upgradeCommand: () => 'npm install -g looptroop@latest',
      okChecksPre: ['install', 'git', 'npm', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  },

  // `--binary` installs the standalone executable — one file carrying its own
  // Node runtime — into `~/.looptroop`. Documented as a way to *install*, not
  // only to upgrade.
  'installer-sh-binary': {
    documented: 'curl -fsSL https://www.looptroop.ovh/install | sh -s -- --binary',
    legs: [{ os: 'ubuntu-latest', tier: 'weekly', opencode: 'npm' }],
    daemon: true,
    pinnable: true,
    port: 39124,
    opencodePort: 39624,
    propagationCapMs: 5 * 60_000,
    publishJob: 'binary',
    publishHint: 'Check the release carries looptroop-<version>-linux-x64.tar.gz.',
    pathHint: () => join(binaryPrefix(), 'bin'),
    install: ({ version, pin }) => shellSpec(
      `curl -fsSL ${installerUrl('install.sh', version, pin)} | sh -s -- --binary${pin ? ` --version ${version}` : ''}`,
    ),
    // No uninstall command exists for this channel; the documentation says to
    // remove the directory.
    uninstall: () => ({ removePath: binaryPrefix() }),
    published: probeReleaseAsset('install.sh'),
    expect: {
      channel: 'binary',
      // Genuinely platform-dependent: a piped script cannot take a parameter,
      // so Windows gets the scriptblock form. One string here would fail on one
      // of the two operating systems.
      upgradeCommand: (platform) => platform === 'win32'
        ? '& ([scriptblock]::Create((irm https://www.looptroop.ovh/install.ps1))) -Binary'
        : 'curl -fsSL https://www.looptroop.ovh/install | sh -s -- --binary',
      // No `npm` check: the standalone binary carries its own runtime and a
      // machine using it need not have npm at all, so asserting it would be
      // testing the runner.
      okChecksPre: ['install', 'git', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  },

  // The real tap, after `publish-homebrew` has pushed to it. `ci.yml` proves
  // the *formula* against a throwaway local tap on every change; only this can
  // fail when the push itself did not land, which is invisible until a user
  // types the documented command.
  homebrew: {
    documented: 'brew install looptroop-ai/tap/looptroop',
    legs: [
      { os: 'macos-latest', tier: 'release', opencode: 'npm' },
      // Linuxbrew is a genuinely different dependency path, not a second
      // platform — it builds more from source and resolves `node@24` its own way.
      { os: 'ubuntu-latest', tier: 'weekly', opencode: 'npm' },
    ],
    daemon: true,
    // A tap carries one formula, so an older version simply is not installable.
    pinnable: false,
    port: 39126,
    opencodePort: 39626,
    propagationCapMs: 10 * 60_000,
    publishJob: 'publish-homebrew',
    publishHint: 'Check looptroop-ai/homebrew-tap commits — if the commit is there, brew\'s fetch is stale; if not, the push failed.',
    // The bundle carries its own locked dependency tree and the formula puts
    // keg-only node@24 on PATH itself, so the launcher must work with no Node
    // of its own on PATH. On a runner that already has one, a formula that
    // forgot the wrapper would pass anyway and fail for the user who does not.
    provesOwnRuntime: true,
    install: () => ({ command: 'brew', args: ['install', '--formula', 'looptroop-ai/tap/looptroop'], env: HOMEBREW_ENV }),
    uninstall: () => ({ command: 'brew', args: ['uninstall', '--formula', 'looptroop'], env: HOMEBREW_ENV }),
    published: probeTapFormula,
    latest: () => probeTapFormula(),
    expect: {
      channel: 'homebrew',
      upgradeCommand: () => 'brew upgrade looptroop',
      // No `npm`: Homebrew installs its own Node, and a machine on this channel
      // need not have npm at all, so asserting it would test the runner.
      okChecksPre: ['install', 'git', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  },

  // Two documented steps, not one: adding the bucket is part of the install.
  scoop: {
    documented: 'scoop bucket add looptroop … ; scoop install looptroop',
    legs: [{ os: 'windows-latest', tier: 'release', opencode: 'npm' }],
    daemon: true,
    pinnable: false,
    port: 39127,
    opencodePort: 39627,
    propagationCapMs: 10 * 60_000,
    publishJob: 'publish-scoop',
    publishHint: 'Check looptroop-ai/scoop-bucket commits.',
    // Not `provesOwnRuntime`: the manifest *depends* on nodejs-lts rather than
    // carrying a runtime, so removing Node from PATH would break it correctly.
    install: () => powershellSpec(
      'scoop bucket add looptroop https://github.com/looptroop-ai/scoop-bucket; scoop install looptroop',
    ),
    uninstall: () => powershellSpec('scoop uninstall looptroop; scoop bucket rm looptroop'),
    published: probeScoopManifest,
    latest: () => probeScoopManifest(),
    expect: {
      channel: 'scoop',
      upgradeCommand: () => 'scoop update looptroop',
      okChecksPre: ['install', 'git', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  },


  // The same npm package through a different global store. The bug this exists
  // for is real and has shipped: bun and pnpm both reported channel `npm` and
  // offered `npm install -g`, which installs a *second* copy under npm's prefix
  // and leaves the first where it was — so which one answers depends on PATH
  // order. Asserting only that a channel line was printed passes on exactly
  // that defect, which is why `upgradeCommand` is asserted too.
  bun: {
    documented: 'bun add -g looptroop',
    legs: [{ os: 'ubuntu-latest', tier: 'weekly', opencode: 'npm' }],
    daemon: true,
    pinnable: true,
    port: 39128,
    opencodePort: 39628,
    propagationCapMs: 3 * 60_000,
    publishJob: 'npm',
    install: ({ version, pin }) => ({
      command: 'bun',
      args: ['add', '-g', pin ? `looptroop@${version}` : 'looptroop'],
    }),
    uninstall: () => ({ command: 'bun', args: ['remove', '-g', 'looptroop'] }),
    published: probeNpmRegistry,
    latest: async () => probeNpmLatest(),
    expect: {
      channel: 'bun',
      upgradeCommand: () => 'bun add -g looptroop@latest',
      okChecksPre: ['install', 'git', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  },

  pnpm: {
    documented: 'pnpm add -g looptroop',
    legs: [{ os: 'ubuntu-latest', tier: 'weekly', opencode: 'npm' }],
    daemon: true,
    pinnable: true,
    port: 39129,
    opencodePort: 39629,
    propagationCapMs: 3 * 60_000,
    publishJob: 'npm',
    // pnpm refuses to resolve a tag to a version published in the last 24
    // hours — a supply-chain protection, on by default, and documented to
    // users in `installChannel.ts`. Unpinned inside that window it would
    // install the *previous* release and fail an assertion that is working
    // correctly, so the leg reports itself as not run instead.
    holdHours: 24,
    install: ({ version, pin }) => ({
      command: 'pnpm',
      args: ['add', '-g', pin ? `looptroop@${version}` : 'looptroop'],
    }),
    uninstall: () => ({ command: 'pnpm', args: ['remove', '-g', 'looptroop'] }),
    published: probeNpmRegistry,
    latest: async () => probeNpmLatest(),
    expect: {
      channel: 'pnpm',
      upgradeCommand: () => 'pnpm add -g looptroop@latest',
      okChecksPre: ['install', 'git', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  },

  // Yarn Classic only. Yarn 2 removed `yarn global` and never replaced it, so a
  // LoopTroop installed by Yarn is by definition a 1.x install.
  yarn: {
    documented: 'yarn global add looptroop',
    legs: [{ os: 'ubuntu-latest', tier: 'weekly', opencode: 'npm' }],
    daemon: true,
    pinnable: true,
    port: 39130,
    opencodePort: 39630,
    propagationCapMs: 3 * 60_000,
    publishJob: 'npm',
    // Yarn does not put its global binaries on PATH, and says nothing about it:
    // the add reports success and then `looptroop` is not a command. The
    // documentation tells users to add this themselves, so it is part of the
    // install rather than test scaffolding.
    pathHint: () => run('yarn', ['global', 'bin'], { shell: IS_WINDOWS }).stdout.trim() || null,
    install: ({ version, pin }) => ({
      command: 'yarn',
      args: ['global', 'add', pin ? `looptroop@${version}` : 'looptroop'],
      shell: IS_WINDOWS,
    }),
    uninstall: () => ({ command: 'yarn', args: ['global', 'remove', 'looptroop'], shell: IS_WINDOWS }),
    published: probeNpmRegistry,
    latest: async () => probeNpmLatest(),
    expect: {
      channel: 'yarn',
      upgradeCommand: () => 'yarn global upgrade looptroop@latest',
      okChecksPre: ['install', 'git', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  },

  // The archive straight off the releases page, with no installer involved.
  //
  // Not a duplicate of `installer-sh-binary`: `installer-core.mjs` is itself a
  // Node program and says so, refusing to run without Node on PATH. A user who
  // has no Node at all — the entire audience for a standalone executable —
  // cannot use the installer, and downloading this archive is their only route.
  // Nothing else covers it.
  'binary-linux-x64': binaryChannel('linux-x64', 'ubuntu-latest', 39131, 39631),
  'binary-win-x64': binaryChannel('win-x64', 'windows-latest', 39132, 39632),

  // Docker Hub only, and weekly only.
  //
  // `container-verify` already pulls the published GHCR tag on both
  // architectures after every release and runs `smoke-container.mjs` against
  // it, so a second GHCR leg here would re-run that verbatim. What nobody
  // covers is a runtime pull from Docker Hub: the release job inspects it
  // anonymously but never runs what it serves, and `docker pull
  // looptroopai/looptroop:latest` is the command in the README.
  //
  // Delegated rather than reimplemented. `smoke-container.mjs` drives the image
  // through a fuller lifecycle than this driver can from outside it — Docker's
  // own health verdict, an unprivileged uid, a named volume, SIGTERM handling —
  // and two sets of assertions about one artefact would only drift.
  container: {
    documented: 'docker pull looptroopai/looptroop:latest',
    legs: [{ os: 'ubuntu-latest', tier: 'weekly', opencode: 'none' }],
    pinnable: true,
    propagationCapMs: 5 * 60_000,
    publishJob: 'container-manifest',
    publishHint: 'Check hub.docker.com/r/looptroopai/looptroop/tags.',
    published: probeDockerHubTag,
    // The image ships no OpenCode by design, and `smoke-container.mjs` is
    // mock-only for that reason.
    delegate: ({ version }) => ({
      command: 'node',
      args: ['scripts/smoke-container.mjs', '--image', `docker.io/looptroopai/looptroop:${version}`, '--version', version],
      pull: `docker.io/looptroopai/looptroop:${version}`,
    }),
  },

  'installer-ps1-binary': {
    documented: '& ([scriptblock]::Create((irm https://www.looptroop.ovh/install.ps1))) -Binary',
    legs: [{ os: 'windows-latest', tier: 'weekly', opencode: 'npm' }],
    daemon: true,
    pinnable: true,
    port: 39125,
    opencodePort: 39625,
    propagationCapMs: 5 * 60_000,
    publishJob: 'binary',
    publishHint: 'Check the release carries looptroop-<version>-win-x64.zip.',
    pathHint: () => join(binaryPrefix(), 'bin'),
    install: ({ version, pin }) => powershellSpec(
      `& ([scriptblock]::Create((irm ${installerUrl('install.ps1', version, pin)}))) -Binary${pin ? ` -Version ${version}` : ''}`,
    ),
    uninstall: () => ({ removePath: binaryPrefix() }),
    published: probeReleaseAsset('install.ps1'),
    expect: {
      channel: 'binary',
      upgradeCommand: (platform) => platform === 'win32'
        ? '& ([scriptblock]::Create((irm https://www.looptroop.ovh/install.ps1))) -Binary'
        : 'curl -fsSL https://www.looptroop.ovh/install | sh -s -- --binary',
      okChecksPre: ['install', 'git', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  },
}

// ---------------------------------------------------------------------------
// Command specs. A recipe describes *what to run*; `runChannel` runs it.
// ---------------------------------------------------------------------------

/**
 * Where `--binary` puts the standalone executable.
 *
 * The same resolution the installer uses, so the two cannot disagree about
 * what to remove. Deliberately *not* the configuration directory, which lives
 * under `~/.config/looptroop` (or `%APPDATA%`) — a test asserts they are
 * different, because this path is passed to a recursive delete.
 */
export function binaryPrefix() {
  return process.env.LOOPTROOP_INSTALL_DIR || join(homedir(), '.looptroop')
}

/**
 * A standalone-executable channel: fetch the release archive, unpack it, run it.
 *
 * The archive is downloaded and extracted with the tools a user has — `tar` on
 * POSIX, PowerShell's `Expand-Archive` on Windows — rather than through the
 * installer, which is the point: the installer needs Node, and this channel
 * exists for machines that have none.
 */
function binaryChannel(target, os, port, opencodePort) {
  const archive = (version) => target === 'win-x64'
    ? `looptroop-${version}-win-x64.zip`
    : `looptroop-${version}-${target}.tar.gz`
  const dest = () => join(binaryPrefix(), 'bin')

  return {
    documented: `download looptroop-<version>-${target} from the releases page`,
    legs: [{ os, tier: 'weekly', opencode: 'npm' }],
    daemon: true,
    pinnable: true,
    port,
    opencodePort,
    propagationCapMs: 5 * 60_000,
    publishJob: 'binary',
    publishHint: `Check the release carries ${archive('<version>')}.`,
    // The whole claim of this channel: one file with a Node runtime inside it.
    provesOwnRuntime: true,
    pathHint: dest,
    // Both archives wrap their contents in a `looptroop-<version>-<target>/`
    // directory, so the executable has to be lifted out of it — `tar` can strip
    // the level itself, `Expand-Archive` cannot and needs the inner folder
    // copied out afterwards.
    install: ({ version }) => {
      const url = `https://github.com/${REPO}/releases/download/v${version}/${archive(version)}`
      const out = dest()
      const inner = `looptroop-${version}-${target}`
      return target === 'win-x64'
        ? powershellSpec(
            `New-Item -ItemType Directory -Force -Path '${out}' | Out-Null; ` +
            `Invoke-WebRequest -Uri '${url}' -OutFile "$env:TEMP\\lt.zip"; ` +
            `Expand-Archive -Force -Path "$env:TEMP\\lt.zip" -DestinationPath "$env:TEMP\\lt"; ` +
            `Copy-Item -Force -Recurse "$env:TEMP\\lt\\${inner}\\*" '${out}'`,
          )
        : shellSpec(
            `mkdir -p '${out}' && curl -fsSL '${url}' | tar -xz --strip-components=1 -C '${out}' ` +
            `&& chmod +x '${out}/looptroop'`,
          )
    },
    // No uninstall command exists for this channel; the documentation says to
    // remove the directory.
    uninstall: () => ({ removePath: binaryPrefix() }),
    published: probeReleaseAssetNamed(archive),
    expect: {
      channel: 'binary',
      upgradeCommand: (platform) => platform === 'win32'
        ? '& ([scriptblock]::Create((irm https://www.looptroop.ovh/install.ps1))) -Binary'
        : 'curl -fsSL https://www.looptroop.ovh/install | sh -s -- --binary',
      // No `npm`: a machine on this channel need not have it at all.
      okChecksPre: ['install', 'git', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  }
}

/** npm is a shell script on POSIX and a `.cmd` on Windows, so it needs a shell there. */
function npmSpec(args) {
  return { command: IS_WINDOWS ? 'npm.cmd' : 'npm', args, shell: IS_WINDOWS }
}

/** A POSIX pipeline. `sh -c` because the documented command is a pipe. */
function shellSpec(line) {
  return { command: 'sh', args: ['-c', line], display: line }
}

/**
 * Windows PowerShell 5.1 — `powershell.exe`, never `pwsh`.
 *
 * They are different runtimes and 5.1 is the one preinstalled on Windows, so it
 * is where `irm … | iex` lands for anyone who has never installed PowerShell 7.
 * `$ProgressPreference` is silenced first because `irm`'s progress bar makes a
 * download take minutes on a runner.
 */
function powershellSpec(line) {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `$ProgressPreference = 'SilentlyContinue'; ${line}`],
    display: line,
  }
}

/**
 * Where to fetch an installer wrapper from.
 *
 * Unpinned runs use the documented website URL, which is the path a user takes
 * and which also exercises the redirect. A pinned run cannot: the website
 * always points at `releases/latest`, so it would pair the *newest* wrapper
 * with an older payload and prove nothing about the release being reproduced.
 */
function installerUrl(asset, version, pin) {
  return pin
    ? `https://github.com/${REPO}/releases/download/v${version}/${asset}`
    : `https://www.looptroop.ovh/${asset === 'install.sh' ? 'install' : asset}`
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const failures = []
let step = 0

function log(message) {
  process.stdout.write(`${redact(message)}\n`)
}

function pass(name, detail = '') {
  log(`  ok    ${name}${detail ? `  (${detail})` : ''}`)
}

function fail(name, detail) {
  failures.push(`${name}: ${redact(String(detail))}`)
  log(`  FAIL  ${name}  (${detail})`)
}

/**
 * `detail` explains a failure, so it is printed only when the check fails.
 *
 * Writing one string for both outcomes produces lines like
 * `ok  daemon.json removed  (state file survived stop)`, which says the
 * opposite of what happened. Where a passing line is worth annotating, pass
 * `passDetail` as well.
 */
function check(name, condition, detail, passDetail = '') {
  if (condition) pass(name, passDetail)
  else fail(name, detail)
  return condition
}

function heading(title) {
  step += 1
  log(`\n[${step}] ${title}`)
}

/** Stops the run with a diagnosis rather than an assertion. */
function abort(message, ...detail) {
  process.stderr.write(`\nFAIL: ${redact(message)}\n`)
  for (const line of detail) if (line) process.stderr.write(`  ${redact(line)}\n`)
  process.stderr.write('\n')
  process.exitCode = 1
}

/**
 * Secrets that must not reach a log line or a result artefact.
 *
 * `start` prints a sign-in URL carrying a one-time code, and the daemon state
 * file carries the API token. Both are short-lived, and both would be readable
 * by anyone who can see a workflow log for as long as the run is retained.
 */
function redact(text) {
  let out = String(text)
  out = out.replace(/#bootstrap=[^\s"']+/g, '#bootstrap=REDACTED')
  out = out.replace(/("?apiToken"?\s*[:=]\s*"?)[A-Za-z0-9._-]+/g, '$1REDACTED')
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = process.env[name]
    if (value && value.length > 6) out = out.split(value).join(`<${name}>`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Process helpers. Copied from smoke-install.mjs rather than shared: there are
// eleven standalone smoke scripts and no helper module, and introducing one
// inside a packaging change would touch all eleven.
// ---------------------------------------------------------------------------

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    ...options,
    env: { ...process.env, ...(options.env ?? {}) },
  })
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    combined: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

/** npm is a shell script on POSIX and a .cmd on Windows, so it needs a shell there. */
function npm(args, options = {}) {
  return run(IS_WINDOWS ? 'npm.cmd' : 'npm', args, { shell: IS_WINDOWS, ...options })
}

/**
 * Quotes one argument for `cmd.exe`. Everything is quoted rather than only what
 * looks like it needs it: inside double quotes cmd stops treating `&`, `|`, `^`
 * and friends as syntax, which is the point of doing this at all.
 */
function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

/**
 * Runs the installed launcher.
 *
 * On Windows the `bin` entry is `looptroop.cmd`, and a batch file is not an
 * executable image: `CreateProcess` cannot run it, so `spawnSync` with the
 * default `shell: false` returns a null exit code and empty output for every
 * command — which reads as a dozen assertion failures about JSON and health,
 * none of them the actual problem. Four separate defects in this repository
 * share that root cause, so this is copied verbatim rather than re-derived.
 */
function runShim(shimPath, args, options = {}) {
  if (!IS_WINDOWS) return run(shimPath, args, options)

  const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
  const line = `"${[shimPath, ...args].map(quoteForCmd).join(' ')}"`
  return run(comspec, ['/d', '/s', '/c', line], { ...options, windowsVerbatimArguments: true })
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
 * Where the shell would find `looptroop`, or null.
 *
 * `pathHint` is prepended for channels that install somewhere a fresh process
 * has not been told about: the standalone installer writes into `~/.looptroop`
 * and edits a shell profile, which this process never sources.
 *
 * On Windows `where` prints every match, one per line, and the first is the one
 * that would run.
 */
function whichLooptroop(pathHint) {
  const env = pathHint
    ? { PATH: `${pathHint}${IS_WINDOWS ? ';' : ':'}${process.env.PATH ?? ''}` }
    : {}
  const probe = IS_WINDOWS
    ? run('where', ['looptroop'], { shell: true, env })
    : run('sh', ['-c', 'command -v looptroop'], { env })
  if (probe.code !== 0) return null
  const first = probe.stdout.split('\n').map((line) => line.trim()).find(Boolean)
  return first && existsSync(first) ? first : null
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** A PATH with every directory holding a `node` removed. */
function pathWithoutNode() {
  const separator = IS_WINDOWS ? ';' : ':'
  return (process.env.PATH ?? '')
    .split(separator)
    .filter((entry) => entry !== '' && !existsSync(join(entry, 'node')) && !existsSync(join(entry, 'node.exe')))
    .join(separator)
}

/** True when nothing holds the port. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/** True once nothing answers on the port. */
async function portIsClosed(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portIsFree(port)) return true
    // Windows can hold a just-closed port in TIME_WAIT briefly, which is not
    // the daemon still listening.
    await sleep(500)
  }
  return false
}

async function waitForHealth(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return await response.json()
    } catch {
      // Not listening yet.
    }
    await sleep(250)
  }
  return null
}

// ---------------------------------------------------------------------------
// Feed probes. Read-only. Each returns the version the channel currently
// serves, or null when it serves nothing.
// ---------------------------------------------------------------------------

/**
 * What the registry serves for a version.
 *
 * npm's behaviour for an absent version is not what an earlier draft of this
 * assumed. On npm 11 it exits 1 with `E404` on stderr and nothing on stdout,
 * not 0 with empty output. Both shapes are treated as "not published yet" —
 * but only those two. A registry outage or a network failure must surface as
 * an error rather than be polled until the cap expires and reported as a
 * missing release, which would blame the wrong thing.
 */
function probeNpmRegistry(recipe, version) {
  const result = npm(['view', `looptroop@${version}`, 'version'])
  const printed = result.stdout.trim()
  if (result.code === 0) return printed === '' ? null : printed
  if (/E404|is not in this registry|No match(ing versions)? found/i.test(result.combined)) return null
  throw new Error(`npm view failed (exit ${result.code}): ${result.combined.trim().split('\n')[0]}`)
}

/**
 * Presence of a named asset on the release for a version.
 *
 * The installer wrappers and the standalone archives are release assets, so
 * "has this published yet" means "does the tag exist and carry this file".
 * Returns the version when both are true, so the caller compares like for like
 * with every other channel.
 */
function probeReleaseAsset(asset) {
  return async (_recipe, version) => {
    let release
    try {
      release = await getJson(`${API}/repos/${REPO}/releases/tags/v${version}`)
    } catch (error) {
      // A tag that does not exist yet is "not published", which is what the
      // poll is for. Anything else is a real failure and must not be swallowed
      // into a propagation timeout that blames the release.
      if (/-> 404/.test(String(error.message))) return null
      throw error
    }
    if (release.draft === true) return null
    return (release.assets ?? []).some((a) => a.name === asset) ? version : null
  }
}

/**
 * Homebrew's environment for an install.
 *
 * `HOMEBREW_DOWNLOAD_CONCURRENCY=1` is not tuning: the concurrent downloader's
 * progress display is what once reported "unknown install step: run", a message
 * about its own state machine rather than about the formula, which made a real
 * failure unreadable. The rest keep brew from auto-updating mid-install or
 * emitting hints that bury the actual output.
 */
const HOMEBREW_ENV = {
  HOMEBREW_DOWNLOAD_CONCURRENCY: '1',
  HOMEBREW_NO_ENV_HINTS: '1',
  HOMEBREW_NO_AUTO_UPDATE: '1',
  HOMEBREW_NO_ANALYTICS: '1',
}

/**
 * The version the published tap serves, read from the formula itself.
 *
 * Read over HTTP rather than through `brew info`, because the question this
 * answers is "has `publish-homebrew` pushed yet" and the tap is a git
 * repository — its file contents are exactly what `brew update` will fetch.
 * Whether brew's *local* index is stale is a different question, and one the
 * installed-version assertion answers from the other side.
 */
async function probeTapFormula(_recipe, _version) {
  const response = await fetch('https://raw.githubusercontent.com/looptroop-ai/homebrew-tap/main/Formula/looptroop.rb')
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`tap formula -> ${response.status}`)
  const body = await response.text()
  return body.match(/\/releases\/download\/v(\d+\.\d+\.\d+[^/]*)\//)?.[1] ?? null
}

/** The version the published Scoop bucket serves. Same reasoning as the tap. */
async function probeScoopManifest(_recipe, _version) {
  const response = await fetch('https://raw.githubusercontent.com/looptroop-ai/scoop-bucket/main/bucket/looptroop.json')
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`scoop manifest -> ${response.status}`)
  return JSON.parse(await response.text()).version ?? null
}

/**
 * Whether Docker Hub serves a tag, read anonymously.
 *
 * Anonymously on purpose: a private repository is readable by the account that
 * pushed it and by nobody else, so an authenticated probe would pass happily on
 * a repository from which every documented `docker pull` fails for users.
 */
async function probeDockerHubTag(_recipe, version) {
  const response = await fetch(`https://hub.docker.com/v2/repositories/looptroopai/looptroop/tags/${version}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Docker Hub -> ${response.status}`)
  return (await response.json()).name ?? null
}

/** As `probeReleaseAsset`, for assets whose name carries the version. */
function probeReleaseAssetNamed(nameFor) {
  return async (recipe, version) => probeReleaseAsset(nameFor(version))(recipe, version)
}

/** What `@latest` resolves to — the assertion that the channel's pointer moved. */
function probeNpmLatest() {
  const result = npm(['view', 'looptroop', 'version'])
  return result.code === 0 ? result.stdout.trim() || null : null
}

async function getJson(url) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'looptroop-published-smoke' }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`${url} -> ${response.status}`)
  return response.json()
}

/**
 * The newest published stable release.
 *
 * Used when no `--version` is given, which is what makes a plain push or a
 * scheduled run usable: neither carries a workflow input. Prereleases are
 * excluded, because every channel except npm ignores them.
 */
async function latestStableVersion() {
  const releases = await getJson(`${API}/repos/${REPO}/releases?per_page=100`)
  const stable = releases.find((r) => r.draft !== true && r.prerelease !== true)
  if (!stable) throw new Error('no stable release found')
  return String(stable.tag_name).replace(/^v/, '')
}

// ---------------------------------------------------------------------------
// Presence polling
// ---------------------------------------------------------------------------

async function awaitPublished(recipe, version) {
  const started = Date.now()
  const deadline = started + recipe.propagationCapMs
  let seen = null
  for (let attempt = 1; ; attempt += 1) {
    seen = await recipe.published(recipe, version)
    log(`  poll ${attempt}: serves ${seen ?? '(nothing)'}`)
    if (seen === version) {
      log(`  present after ${Math.round((Date.now() - started) / 1000)}s`)
      return seen
    }
    if (Date.now() >= deadline) break
    await sleep(POLL_INTERVAL_MS)
  }
  const minutes = Math.round(recipe.propagationCapMs / 60_000)
  abort(
    `${recipe.key} still serves ${seen ?? '(nothing)'} after ${minutes} minutes, expected ${version}.`,
    recipe.publishJob ? `That is what \`${recipe.publishJob}\` was supposed to push.` : '',
    recipe.publishHint ?? '',
  )
  return null
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function runChannel(recipe, options) {
  const { version, pin, profile, opencodeMode } = options
  const gateOnly = profile === 'gate'

  const scratch = mkdtempSync(join(tmpdir(), `looptroop-published-${recipe.key}-`))
  const configDir = join(scratch, 'config')
  // Every command runs from a directory with nothing in it: a stray package.json
  // or .git in the working directory changes what several commands do.
  const elsewhere = join(scratch, 'elsewhere')
  mkdirSync(elsewhere, { recursive: true })

  const port = recipe.port
  const opencodePort = recipe.opencodePort
  const baseUrl = `http://127.0.0.1:${port}`

  // `LOOPTROOP_BACKEND_PORT` as well as `--port`, because doctor resolves the
  // port from settings rather than from the running daemon: without it the
  // post-start `port` check inspects 3000 and says nothing about this leg.
  //
  // The OpenCode base URL is per-leg for the same reason the daemon port is —
  // a shared runner may already have something on the default 4096, and a leg
  // that talked to it would be reporting on the runner, not the release.
  const childEnv = {
    LOOPTROOP_CONFIG_DIR: configDir,
    LOOPTROOP_BACKEND_PORT: String(port),
    LOOPTROOP_OPENCODE_BASE_URL: `http://127.0.0.1:${opencodePort}`,
    ...(opencodeMode === 'mock' ? { LOOPTROOP_OPENCODE_MODE: 'mock' } : {}),
  }

  let adopted = null
  // Resolved from PATH after the install, never guessed from a prefix.
  //
  // Every channel puts the launcher somewhere different — npm's global bin,
  // Homebrew's Cellar, a Scoop shim, `~/.looptroop` for the standalone binary —
  // and passing `--prefix` to force a common location would change the code
  // path under test for the installers, where the prefix flag is itself a
  // documented option. Asking the operating system where `looptroop` is, is
  // both channel-agnostic and what a user's shell does.
  let shimPath = null
  const shim = () => shimPath ?? 'looptroop'
  const cli = (args, extra = {}) =>
    runShim(shim(), args, { cwd: elsewhere, env: { ...childEnv, ...(extra.env ?? {}) }, ...extra })

  try {
    heading(`Feed carries ${version}`)
    const served = await awaitPublished(recipe, version)
    if (served === null) return { ok: false, served: null }

    heading('The channel serves the version under test')
    if (pin) {
      log('  skipped  (--pin: a pinned install says nothing about the latest pointer)')
    } else if (recipe.latest) {
      const latest = await recipe.latest()
      check(
        'latest resolves to the version under test',
        latest === version,
        `${recipe.key} serves ${latest}, this run is testing ${version}`,
        version,
      )
    } else {
      // Channels whose documented command always takes the newest release —
      // the installer wrappers resolve it themselves — have no separate pointer
      // to check. Step 4 catches a stale one: it asserts the *installed*
      // version, which is the same guarantee arrived at from the other side.
      log('  n/a  (this channel resolves the newest release itself; step 4 asserts what arrived)')
    }

    if (recipe.delegate) {
      const spec = recipe.delegate({ version })
      heading(`Pull ${spec.pull}`)
      // Pulled explicitly rather than left to the smoke script, so a registry
      // that does not serve the tag fails here and says so, instead of failing
      // somewhere inside a container lifecycle.
      const pulled = run('docker', ['pull', spec.pull], { cwd: elsewhere })
      if (!check('docker pull', pulled.code === 0, pulled.combined.trim().slice(-300), spec.pull)) {
        return { ok: false, served }
      }

      heading(`Delegate to ${spec.args[0]}`)
      const delegated = run(spec.command, spec.args, { stdio: 'inherit' })
      check('container smoke', delegated.code === 0, `exit ${delegated.code}`)
      return { ok: failures.length === 0, served }
    }

    heading(`Install: ${recipe.documented}${pin ? ` (pinned to ${version})` : ''}`)
    const spec = recipe.install({ version, pin })
    log(`  $ ${spec.display ?? [spec.command, ...spec.args].join(' ')}`)
    const install = run(spec.command, spec.args, { cwd: elsewhere, shell: spec.shell ?? false, env: spec.env ?? {} })
    // A barrier, not an assertion: every later step would otherwise run against
    // whatever the runner already had, and report a pass for software this leg
    // never installed.
    if (install.code !== 0) {
      fail('install', `exit ${install.code}: ${install.combined.trim().split('\n').slice(-3).join(' / ')}`)
      return { ok: false, served }
    }
    pass('install', recipe.documented)

    heading('The installed launcher is on PATH')
    shimPath = whichLooptroop(recipe.pathHint?.())
    if (!check('looptroop is on PATH', shimPath !== null, 'nothing named looptroop resolved after the install', shimPath ?? '')) {
      return { ok: false, served }
    }

    heading('It reports the published version')
    const printed = cli(['--version'])
    check('--version', printed.stdout.trim() === version, `printed "${printed.stdout.trim()}", expected "${version}"`, version)

    if (recipe.provesOwnRuntime) {
      heading('It carries its own Node runtime')
      // The entire claim of this channel. On a runner that already has Node,
      // a package that forgot to ship or wire up its own would pass every other
      // assertion here and fail for the user who has none.
      //
      // Only `--version` runs this way. The daemon lifecycle needs an OpenCode
      // to spawn, and an npm-installed OpenCode is a Node program — hiding Node
      // from that would be testing the wrong thing.
      const withoutNode = cli(['--version'], { env: { PATH: pathWithoutNode() } })
      check(
        'runs with no Node on PATH',
        withoutNode.stdout.trim() === version,
        `exit ${withoutNode.code}: ${withoutNode.combined.trim().slice(-200)}`,
        version,
      )
    }

    heading('doctor, before start')
    // Not gated on the exit code: doctor exits 1 when any check fails, and the
    // checks are what this reads. Parse either way.
    const pre = cli(['doctor', '--json'])
    const preReport = readJson(pre.stdout, 'doctor --json (pre-start)')
    if (preReport) {
      // The detail reads on both outcomes: `check` prints it whether it passed
      // or failed, so "checks[] is empty" beside an `ok` would be nonsense.
      const count = Array.isArray(preReport.checks) ? preReport.checks.length : 0
      check('doctor reports checks', count > 0, `${count} checks`)
      for (const name of recipe.expect.okChecksPre) {
        const found = preReport.checks.find((c) => c.name === name)
        check(`${name} is ok`, found?.status === 'ok', found ? `${found.status}: ${found.detail}` : 'check absent')
      }
      // Deliberately tolerant. With OpenCode installed but no server running,
      // `judgeOpenCode` returns `warn` on purpose so a fresh install does not
      // read as broken. Requiring `ok` here would fail every leg that lets
      // LoopTroop launch OpenCode itself.
      const oc = preReport.checks.find((c) => c.name === 'opencode')
      check(
        'opencode is not failing before start',
        oc?.status === 'ok' || oc?.status === 'warn',
        oc ? `${oc.status}: ${oc.detail}` : 'check absent',
      )

      const installCheck = preReport.checks.find((c) => c.name === 'install')
      check(
        'install channel',
        installCheck?.install?.channel === recipe.expect.channel,
        `reported ${installCheck?.install?.channel}, expected ${recipe.expect.channel}`,
        recipe.expect.channel,
      )
      const wanted = recipe.expect.upgradeCommand(process.platform)
      check(
        'upgrade command',
        installCheck?.install?.upgradeCommand === wanted,
        `reported "${installCheck?.install?.upgradeCommand}", expected "${wanted}"`,
      )
    }

    if (gateOnly) {
      log('\n  profile=gate: stopping before the daemon lifecycle.')
      return { ok: failures.length === 0, served }
    }

    if (opencodeMode === 'adopt') {
      heading('Pre-start an OpenCode for LoopTroop to adopt')
      adopted = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(opencodePort)], {
        stdio: 'ignore',
        detached: !IS_WINDOWS,
        shell: IS_WINDOWS,
      })
      const up = await waitForOpenCode(opencodePort)
      if (!check('adopted OpenCode is listening', up, `nothing on ${opencodePort}`)) return { ok: false, served }
    }

    heading('The daemon starts on the port it was given')
    if (!(await portIsFree(port))) {
      fail('port is free before start', `${port} is already held — this runner is dirty`)
      return { ok: false, served }
    }
    const started = cli(['start', '--port', String(port)])
    if (!check('start', started.code === 0, `exit ${started.code}: ${started.combined.trim().slice(-300)}`, `port ${port}`)) {
      return { ok: false, served }
    }

    heading('It answers on the health endpoint')
    const health = await waitForHealth(baseUrl)
    check('health status', health?.status === 'ok', `got ${JSON.stringify(health)}`)
    check('health instanceId', typeof health?.instanceId === 'string', 'no instanceId in the health payload')

    heading('It serves the interface, not just the API')
    // A release whose packed client is missing 404s here and nowhere else.
    const root = await fetch(baseUrl, { redirect: 'manual' })
    check('GET /', root.ok, `status ${root.status}`)
    const html = root.ok ? await root.text() : ''
    const asset = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1]
    if (asset) {
      const assetResponse = await fetch(`${baseUrl}${asset}`)
      check('a referenced asset is served', assetResponse.ok, `${asset} -> ${assetResponse.status}`)
    } else {
      fail('a referenced asset is served', 'no /assets/ reference in the served HTML')
    }

    heading('The API refuses an unauthenticated caller')
    // Proves this is LoopTroop answering, not something else that happened to
    // be listening on the port.
    const unauth = await fetch(`${baseUrl}/api/projects`)
    check('unauthenticated /api/projects', unauth.status === 401 || unauth.status === 403, `status ${unauth.status}`)

    heading('status agrees with the daemon')
    const status = cli(['status', '--json'])
    const statusReport = readJson(status.stdout, 'status --json')
    if (statusReport) {
      // The daemon facts are nested under `daemon`; the top level carries
      // `running`, `lastStartFailure` and an optional `update`. The token is
      // redacted there by `redactDaemonState`, which is why this can be logged.
      const daemon = statusReport.daemon ?? {}
      check('status reports running', statusReport.running === true, `running=${statusReport.running}`)
      check('status port', daemon.port === port, `reported ${daemon.port}, expected ${port}`, String(port))
      check(
        'status instanceId matches health',
        daemon.instanceId === health?.instanceId,
        `${daemon.instanceId} vs ${health?.instanceId}`,
      )
      check('status version', daemon.version === version, `reported ${daemon.version}, expected ${version}`, version)
    }

    heading('doctor, after start')
    // The point of installing a real OpenCode. Health answering proves the
    // daemon bound a port; only this proves OpenCode was actually launched or
    // adopted — the `opencode.cmd` launch defect is exactly this check.
    const post = cli(['doctor', '--json'])
    const postReport = readJson(post.stdout, 'doctor --json (post-start)')
    if (postReport) {
      for (const name of recipe.expect.okChecksPost) {
        const found = postReport.checks.find((c) => c.name === name)
        check(`${name} is ok after start`, found?.status === 'ok', found ? `${found.status}: ${found.detail}` : 'absent')
      }
    }

    heading('The daemon state records the port it was asked for')
    const statePath = join(configDir, 'daemon.json')
    if (existsSync(statePath)) {
      const state = readJson(readFileSync(statePath, 'utf8'), 'daemon.json')
      check('daemon.json port', state?.port === port, `recorded ${state?.port}, expected ${port}`)
    } else {
      fail('daemon.json exists', statePath)
    }

    heading('It stops cleanly and leaves nothing behind')
    const stopped = cli(['stop'])
    check('stop', stopped.code === 0, `exit ${stopped.code}: ${stopped.combined.trim().slice(-200)}`)
    check('daemon port released', await portIsClosed(port), `${port} still answers`)
    // Checked before the scratch directory is removed: deleting it would hide
    // stale lifecycle state rather than prove it was cleaned up.
    check('daemon.json removed', !existsSync(join(configDir, 'daemon.json')), 'state file survived stop')
    check('daemon.lock removed', !existsSync(join(configDir, 'daemon.lock')), 'lock survived stop')

    // `status --json` exits 1 when nothing is running, which is the correct
    // answer here rather than an error.
    const afterStop = readJson(cli(['status', '--json']).stdout, 'status --json (after stop)')
    if (afterStop) check('status reports stopped', afterStop.running === false, `running=${afterStop.running}`)

    if (opencodeMode === 'adopt') {
      check('adopted OpenCode outlived the daemon', await openCodeAnswers(opencodePort), 'the adopted server was killed')
    } else if (opencodeMode !== 'mock') {
      check('managed OpenCode stopped with the daemon', await portIsClosed(opencodePort), `${opencodePort} still answers`)
    }

    heading('It uninstalls the way the documentation says')
    const removal = recipe.uninstall({ version })
    if (removal.removePath) {
      // The standalone executable has no uninstall command; the documentation
      // says to remove the directory. Asserting the whole prefix is gone, not
      // just the launcher, is the difference between uninstalled and orphaned.
      log(`  $ rm -rf ${removal.removePath}`)
      rmSync(removal.removePath, { recursive: true, force: true })
      check('the install prefix is gone', !existsSync(removal.removePath), `${removal.removePath} survived`)
    } else {
      log(`  $ ${removal.display ?? [removal.command, ...removal.args].join(' ')}`)
      const removed = run(removal.command, removal.args, { cwd: elsewhere, shell: removal.shell ?? false, env: removal.env ?? {} })
      check('uninstall', removed.code === 0, `exit ${removed.code}: ${removed.combined.trim().slice(-200)}`)
    }
    check('the launcher is gone from PATH', whichLooptroop(recipe.pathHint?.()) === null, 'looptroop still resolves')

    return { ok: failures.length === 0, served }
  } finally {
    // Best effort, and never throws. `stop` is attempted even when start failed
    // or timed out: a half-started daemon still holds the port and the lock.
    try {
      runShim(shim(), ['stop'], { cwd: elsewhere, env: childEnv, timeout: 30_000 })
    } catch {
      // Nothing to stop.
    }
    if (adopted?.pid) {
      try {
        process.kill(IS_WINDOWS ? adopted.pid : -adopted.pid, 'SIGTERM')
      } catch {
        try {
          adopted.kill('SIGTERM')
        } catch {
          // Already gone.
        }
      }
    }
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // A held file on Windows is not worth failing a run over.
    }
  }
}

async function waitForOpenCode(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await openCodeAnswers(port)) return true
    await sleep(500)
  }
  return false
}

async function openCodeAnswers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/config`)
    // Any answer proves something is serving; a password-protected server
    // answers 401 and is still a running OpenCode.
    return response.status < 500
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Matrix planning. Derived from CHANNELS so the workflow and the recipes can
// never disagree about what exists.
// ---------------------------------------------------------------------------

export function planMatrix({ tier = 'release', only = [], skip = [] } = {}) {
  const legs = []
  for (const [key, recipe] of Object.entries(CHANNELS)) {
    if (only.length > 0 && !only.includes(key)) continue
    // A channel whose publish job failed is not scheduled at all. Running it
    // would fail on the version it serves and report a second time on an
    // incident the release report already names.
    if (skip.includes(key)) continue
    if (recipe.stub) continue
    for (const leg of recipe.legs) {
      if (tier === 'release' && leg.tier !== 'release') continue
      legs.push({
        key,
        channel: key,
        os: leg.os,
        tier: leg.tier,
        opencode: leg.opencode,
        name: `${key} (${leg.os})`,
      })
    }
  }
  return legs
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    channel: null,
    version: null,
    pin: false,
    opencode: null,
    profile: 'full',
    tier: 'release',
    resultFile: null,
    plan: false,
    only: [],
    skip: [],
  }
  const takesValue = new Set([
    '--channel', '--version', '--opencode', '--profile', '--tier', '--result-file', '--only', '--skip',
  ])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--pin') {
      options.pin = true
      continue
    }
    if (arg === '--plan') {
      options.plan = true
      continue
    }
    if (!takesValue.has(arg)) {
      // Unknown arguments are fatal. A typo that fell through would report a
      // pass for a channel nobody tested, which is worse than no test at all.
      throw new Error(`unknown argument: ${arg}`)
    }
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`${arg} needs a value`)
    i += 1
    if (arg === '--channel') options.channel = value
    else if (arg === '--version') options.version = value.replace(/^v/, '')
    else if (arg === '--opencode') options.opencode = value
    else if (arg === '--profile') options.profile = value
    else if (arg === '--tier') options.tier = value
    else if (arg === '--result-file') options.resultFile = value
    else if (arg === '--only') options.only = value.split(',').map((s) => s.trim()).filter(Boolean)
    else if (arg === '--skip') options.skip = value.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return options
}

/** How long ago a release was published, in hours, or null if unknown. */
async function releaseAgeHours(version) {
  try {
    const release = await getJson(`${API}/repos/${REPO}/releases/tags/v${version}`)
    const at = Date.parse(release.published_at ?? release.created_at ?? '')
    return Number.isNaN(at) ? null : (Date.now() - at) / 3_600_000
  } catch {
    return null
  }
}

/**
 * Records a leg that was deliberately not run.
 *
 * Without a result file the reporter cannot tell "not run on purpose" from
 * "died before it could report", and prints SETUP FAILED for a healthy channel.
 */
function writeSkipResult(options, recipe, version, reason) {
  if (!options.resultFile) return
  writeFileSync(options.resultFile, `${JSON.stringify({
    channel: recipe.key,
    os: process.platform,
    arch: process.arch,
    version,
    served: null,
    profile: options.profile,
    ok: true,
    skipped: reason,
    failures: [],
    durationMs: 0,
  }, null, 2)}\n`)
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    abort(String(error.message))
    return
  }

  if (!['full', 'gate'].includes(options.profile)) {
    abort(`--profile must be full or gate, got "${options.profile}"`)
    return
  }
  if (!['release', 'weekly', 'all'].includes(options.tier)) {
    abort(`--tier must be release, weekly or all, got "${options.tier}"`)
    return
  }

  if (options.plan) {
    const legs = planMatrix({ tier: options.tier, only: options.only, skip: options.skip })
    const payload = JSON.stringify({ include: legs })
    if (process.env.GITHUB_OUTPUT) {
      writeFileSync(process.env.GITHUB_OUTPUT, `matrix=${payload}\n`, { flag: 'a' })
    }
    log(`matrix=${payload}`)
    if (options.skip.length > 0) log(`\nNot scheduled (publish did not succeed): ${options.skip.join(', ')}`)
    log(`\n${legs.length} leg(s) for tier "${options.tier}":`)
    for (const leg of legs) log(`  ${leg.name.padEnd(30)} tier=${leg.tier} opencode=${leg.opencode}`)
    return
  }

  const recipe = CHANNELS[options.channel]
  if (!recipe) {
    abort(`unknown channel "${options.channel}"`, `known: ${Object.keys(CHANNELS).join(', ')}`)
    return
  }
  recipe.key = options.channel

  // An absent --version resolves to the newest stable release. That is what
  // makes a push-triggered or scheduled run possible at all: neither carries a
  // workflow input. Everything else passes it explicitly.
  let version = options.version
  if (!version) {
    try {
      version = await latestStableVersion()
      log(`No --version given; resolved the latest stable release: ${version}`)
    } catch (error) {
      abort(`could not resolve the latest stable release: ${error.message}`)
      return
    }
  }

  // pnpm's supply-chain hold, and any future channel with one. Reported as a
  // deliberate skip rather than run and failed: inside the window the manager
  // is behaving exactly as documented, and the assertion that would fail is
  // correct.
  if (recipe.holdHours && !options.pin) {
    const age = await releaseAgeHours(version)
    if (age !== null && age < recipe.holdHours) {
      const reason = `${recipe.key} holds a release for ${recipe.holdHours}h; this one is ${Math.round(age)}h old`
      log(`\n${recipe.key}: not run (${reason})`)
      writeSkipResult(options, recipe, version, reason)
      return
    }
  }

  if (options.pin && recipe.pinnable === false) {
    // Not a failure, and not a silent skip either: without a result file the
    // reporter cannot tell "deliberately not run" from "died before it could
    // report", and would print SETUP FAILED for a healthy channel.
    const reason = '--pin; this channel serves one version at a time'
    log(`\n${recipe.key}: not run (${reason})`)
    writeSkipResult(options, recipe, version, reason)
    return
  }

  const opencodeMode = options.opencode ?? 'installer'
  log(`\nChannel ${recipe.key} | version ${version} | profile ${options.profile} | opencode ${opencodeMode}`)
  log(`Documented command: ${recipe.documented}`)

  const startedAt = Date.now()
  let result = { ok: false, served: null }
  try {
    result = await runChannel(recipe, { version, pin: options.pin, profile: options.profile, opencodeMode })
  } catch (error) {
    fail('unexpected error', error?.stack ?? String(error))
  }

  const summary = {
    channel: recipe.key,
    os: process.platform,
    arch: process.arch,
    version,
    served: result.served,
    profile: options.profile,
    ok: result.ok && failures.length === 0,
    failures,
    durationMs: Date.now() - startedAt,
  }

  if (options.resultFile) {
    try {
      writeFileSync(options.resultFile, `${redact(JSON.stringify(summary, null, 2))}\n`)
    } catch (error) {
      log(`  (could not write ${options.resultFile}: ${error.message})`)
    }
  }

  log('')
  if (summary.ok) {
    const did = options.profile === 'gate'
      ? 'installs and reports itself correctly from its published feed'
      : 'installs, serves and uninstalls from its published feed'
    log(`PASS: ${recipe.key} ${version} ${did}.`)
  } else {
    log(`FAIL: ${recipe.key} ${version} — ${failures.length} assertion(s) failed:`)
    for (const entry of failures) log(`  - ${entry}`)
    process.exitCode = 1
  }
}

// `--plan` is importable for tests; running the file drives a channel.
if (process.argv[1] && process.argv[1].endsWith('smoke-published.mjs')) {
  await main()
}
