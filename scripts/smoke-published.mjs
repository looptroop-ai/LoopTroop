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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeWorkDirectory, waitForHealth } from './smoke-lib.mjs'
import { findToolPath, launchTool, planToolLaunch } from './tool-path.ts'
// The published identifier, and where its submissions live, from the module
// that renders the manifests carrying them. `winget-pkgs` derives its directory
// from the identifier, so it is the same in the submission, in the install
// command and in what `doctor` prints — and a second copy here would be the one
// that drifts. The branch name is shared for the same reason: the submitter
// pushes it, and this asks upstream what became of the pull request on it.
import {
  WINGET_FORK,
  WINGET_IDENTIFIER,
  WINGET_UPSTREAM,
  windowsBinaryZipName,
  wingetSubmissionBranch,
} from './package-manifests.ts'

const IS_WINDOWS = process.platform === 'win32'

/** GitHub's releases feed, for resolving "latest stable" and for asset probes. */
/**
 * How long the daemon has to answer `/api/health`.
 *
 * Twice what the local install smoke allows, on purpose: this drives a launcher
 * a package manager has just written, on a filesystem that has never read it,
 * and the first start pays for that. Stated here rather than defaulted in the
 * shared helper, which would give one script's patience to the other two.
 */
const HEALTH_TIMEOUT_MS = 60_000

/**
 * What `looptroop doctor` tells somebody on the standalone binary to run.
 *
 * Genuinely platform-dependent — a piped script cannot take a parameter, so
 * Windows gets the scriptblock form — and asserted by three recipes, which is
 * why it is bound once here. All three had their own copy of both strings, so a
 * change to what the daemon reports had to be made in three places to be made
 * at all.
 */
const binaryUpgradeCommand = (platform) => (platform === 'win32'
  ? powershellInstaller('https://www.looptroop.ovh/install.ps1', ' -Binary')
  : 'curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL https://www.looptroop.ovh/install | sh -s -- --binary')

const REPO = process.env.LOOPTROOP_INSTALL_REPO || 'looptroop-ai/LoopTroop'
const API = process.env.LOOPTROOP_INSTALL_API || 'https://api.github.com'

const POLL_INTERVAL_MS = 15_000

/** The two release names the release tooling can publish. */
const PUBLISHED_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:[1-9]\d*))?$/

/**
 * Accepts a release identifier produced by this repository and rejects
 * everything else.
 *
 * Versions are used as argv entries and, for the two documented installer
 * pipelines, inside a fixed shell program. Keep this allowlist at the boundary
 * shared by command-line and release-API values so neither source can add shell
 * syntax to those programs.
 */
export function validatePublishedVersion(value) {
  const version = String(value)
  if (!PUBLISHED_VERSION_PATTERN.test(version)) throw new Error(`invalid release version: "${version}"`)
  return version
}

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
    documented: 'curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL https://www.looptroop.ovh/install | sh',
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
      `curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL ${installerUrl('install.sh', version, pin)} | sh${pin ? ` -s -- --version ${version}` : ''}`,
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
    documented: powershellInstaller('https://www.looptroop.ovh/install.ps1'),
    legs: [{ os: 'windows-latest', tier: 'release', opencode: 'npm' }],
    daemon: true,
    pinnable: true,
    port: 39123,
    opencodePort: 39623,
    propagationCapMs: 5 * 60_000,
    publishJob: 'finalize',
    publishHint: 'The website redirects /install.ps1 to the latest release asset.',
    install: ({ version, pin }) => powershellSpec(
      powershellInstaller(installerUrl('install.ps1', version, pin), pin ? ` -Version ${version}` : ''),
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
    documented: 'curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL https://www.looptroop.ovh/install | sh -s -- --binary',
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
      `curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL ${installerUrl('install.sh', version, pin)} | sh -s -- --binary${pin ? ` --version ${version}` : ''}`,
    ),
    // No uninstall command exists for this channel; the documentation says to
    // remove the directory.
    uninstall: () => ({ removePath: binaryPrefix() }),
    published: probeReleaseAsset('install.sh'),
    expect: {
      channel: 'binary',
      upgradeCommand: binaryUpgradeCommand,
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
    documented: 'scoop bucket add looptroop https://github.com/looptroop-ai/scoop-bucket; scoop install looptroop',
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

  // The community feed, once a moderator has let a version through.
  //
  // `publish-chocolatey` submits; it does not publish. Every version is queued
  // for a human, the queue has no deadline, and the first one here took three
  // weeks — so this leg is weekly rather than release-tier, and `moderated`
  // below says what happens when it runs before the queue has moved.
  chocolatey: {
    documented: 'choco install looptroop',
    legs: [{ os: 'windows-latest', tier: 'weekly', opencode: 'npm' }],
    daemon: true,
    // Unlike a tap or a bucket, the feed keeps every approved version.
    pinnable: true,
    port: 39133,
    opencodePort: 39633,
    propagationCapMs: 10 * 60_000,
    publishJob: 'publish-chocolatey',
    publishHint: 'Check community.chocolatey.org/packages/looptroop — an approved version is served, a submitted one is not.',
    moderated: { queue: 'Chocolatey community moderation', graceDays: 14 },
    // Not `provesOwnRuntime`: the nuspec *depends* on nodejs-lts rather than
    // carrying a runtime, exactly as the Scoop manifest does, so stripping Node
    // from PATH would break this correctly.
    //
    // Dependencies are resolved for real, unlike `smoke-choco.ts`, which passes
    // `--ignore-dependencies` because the runner already has Node, git and gh.
    // That is the right trade for a local package check and the wrong one here:
    // the documentation promises this channel installs all three for you, and
    // nothing else ever runs that promise. A wrong dependency id passes every
    // golden-file test and fails the first user.
    install: ({ version, pin }) => ({
      command: 'choco',
      args: [
        'install', 'looptroop',
        ...(pin ? ['--version', version] : []),
        '--yes', '--no-progress',
      ],
      display: pin ? `choco install looptroop --version ${version}` : 'choco install looptroop',
    }),
    uninstall: () => ({ command: 'choco', args: ['uninstall', 'looptroop', '--yes', '--no-progress'] }),
    published: probeChocoVersion,
    latest: () => probeChocoLatest(),
    submission: probeChocoSubmission,
    expect: {
      channel: 'chocolatey',
      upgradeCommand: () => 'choco upgrade looptroop',
      okChecksPre: ['install', 'git', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  },

  // The one channel that is a pull request into somebody else's repository, and
  // the one that installs the standalone executable rather than the bundle:
  // `winget validate` refuses a portable whose `RelativeFilePath` is not an
  // `.exe`, which the bundle's `.cmd` shim is not.
  //
  // Weekly, and `moderated`, for the same reason as Chocolatey — a submission
  // is reviewed by people at Microsoft, and a merged manifest still has to
  // reach the index afterwards.
  winget: {
    documented: `winget install ${WINGET_IDENTIFIER}`,
    legs: [{ os: 'windows-latest', tier: 'weekly', opencode: 'npm' }],
    daemon: true,
    // Every version's manifests stay in `winget-pkgs`, so an older one installs.
    pinnable: true,
    port: 39134,
    opencodePort: 39634,
    propagationCapMs: 10 * 60_000,
    publishJob: 'publish-winget',
    publishHint: 'Check the pull request at microsoft/winget-pkgs — merged is not indexed; the publish pipeline runs after the merge.',
    moderated: { queue: 'the microsoft/winget-pkgs review queue', graceDays: 14 },
    // The zip carries its own Node, so this must run with none on PATH.
    provesOwnRuntime: true,
    // WinGet writes an alias rather than putting the package on PATH, and the
    // directory it writes it to is only on PATH of a shell started afterwards.
    pathHint: () => wingetLinks(),
    // `--scope machine`, symmetrically on both operations, for the reason
    // `smoke-winget.ts` spells out: an elevated runner cannot uninstall a
    // user-scope package, which left an earlier job installing something it
    // could not remove.
    //
    // `--skip-dependencies` stays here, where the Chocolatey leg drops it. The
    // two declarations are not alike: Chocolatey's dependencies are Chocolatey
    // packages it installs in seconds, while WinGet's are Git for Windows and
    // the GitHub CLI — full third-party installers that the runner already has
    // from another source, so resolving them re-installs two applications on
    // every weekly run to prove a declaration that `winget validate` and the
    // golden manifests already check. The cost is that no run here exercises
    // WinGet's dependency resolution, which the installation page states.
    install: ({ version, pin }) => ({
      command: 'winget',
      args: [
        'install', '--id', WINGET_IDENTIFIER, '--exact',
        ...(pin ? ['--version', version] : []),
        '--source', 'winget', '--scope', 'machine', '--skip-dependencies',
        '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
      ],
      display: pin
        ? `winget install ${WINGET_IDENTIFIER} --version ${version}`
        : `winget install ${WINGET_IDENTIFIER}`,
    }),
    uninstall: () => ({
      command: 'winget',
      args: [
        'uninstall', '--id', WINGET_IDENTIFIER, '--exact', '--scope', 'machine',
        '--accept-source-agreements', '--disable-interactivity',
      ],
    }),
    published: probeWingetVersion,
    submission: probeWingetSubmission,
    // A release cut without binaries has nothing for this channel to carry, and
    // `publish-winget` skips for exactly that reason. Without this the weekly
    // leg would go on asking for a version that can never be indexed, once a
    // week, forever.
    requiresReleaseAsset: (version) => windowsBinaryZipName(version),
    // No `latest` probe: asking the client which version it would install is
    // the same command as installing it. An unpinned install takes the newest
    // the index carries, and step 4 asserts what arrived — the same guarantee
    // from the other side, which is how the installer channels handle it too.
    expect: {
      channel: 'winget',
      upgradeCommand: () => `winget upgrade ${WINGET_IDENTIFIER}`,
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
    // THE ADOPT LEG. `startDaemon` has two OpenCode paths: spawn one, or adopt
    // a server that is already listening. Every other leg covers spawn, so
    // without this one the adopt branch of the supervisor is never exercised
    // against a published release — and the code in this driver that supports
    // it would be dead.
    //
    // Deliberately not one of the npm legs: those are the spawn coverage, and
    // the Windows one is the `opencode.cmd` regression guard.
    legs: [{ os: 'ubuntu-latest', tier: 'weekly', opencode: 'adopt' }],
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
    pathHint: () => run('yarn', ['global', 'bin']).stdout.trim() || null,
    install: ({ version, pin }) => ({
      command: 'yarn',
      args: ['global', 'add', pin ? `looptroop@${version}` : 'looptroop'],
    }),
    uninstall: () => ({ command: 'yarn', args: ['global', 'remove', 'looptroop'] }),
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
    // The documented command is `:latest`, so the tag that command resolves is
    // the one that has to have moved. Without this a stale `latest` on Docker
    // Hub stays green forever, because the leg would only ever pull the exact
    // version tag — which is precisely the silent-failure class every other
    // channel's pointer check exists to catch.
    latest: probeDockerHubLatest,
    // The image ships no OpenCode by design, and `smoke-container.mjs` is
    // mock-only for that reason.
    delegate: ({ version }) => ({
      command: 'node',
      args: ['scripts/smoke-container.mjs', '--image', `docker.io/looptroopai/looptroop:${version}`, '--version', version],
      pull: `docker.io/looptroopai/looptroop:${version}`,
    }),
  },

  // ---------------------------------------------------------------------------
  // Channels that exist but are not publicly installable yet.
  // ---------------------------------------------------------------------------
  //
  // Report-only stubs, and activating one is a code change rather than a
  // variable flip. An earlier design had it both ways — stub recipes switched
  // on by a `CHANNEL_*_LIVE` variable — which is incoherent: a variable cannot
  // fill in a recipe nobody wrote. Whichever way it went, the recipe has to be
  // written when the feed goes live, so the honest arrangement is to say so.
  //
  // Chocolatey and WinGet were both stubs here until their first submissions
  // were accepted — `looptroop 0.5.1` on 3 September 2026 and
  // `LoopTroopAI.LoopTroop 0.5.2` on 19 September 2026 — and each went live in
  // the commit that wrote its recipe above, which is the arrangement working.
  // What remains is the AUR, where the obstacle is not a queue: there is no
  // account to publish from.
  //
  // `ci.yml` keeps proving the package itself in the meantime — `aur-package`
  // builds and installs it locally on every change.
  aur: { stub: 'AUR registration is closed upstream', documented: 'yay -S looptroop-bin' },

  'installer-ps1-binary': {
    documented: powershellInstaller('https://www.looptroop.ovh/install.ps1', ' -Binary'),
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
      powershellInstaller(installerUrl('install.ps1', version, pin), ` -Binary${pin ? ` -Version ${version}` : ''}`),
    ),
    uninstall: () => ({ removePath: binaryPrefix() }),
    published: probeReleaseAsset('install.ps1'),
    expect: {
      channel: 'binary',
      upgradeCommand: binaryUpgradeCommand,
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
 * Where WinGet writes the alias for a machine-scope portable package.
 *
 * Machine scope because that is the scope the leg installs with — a user-scope
 * package cannot be uninstalled by an elevated shell, which is what CI is. The
 * directory is on the PATH of a shell started *afterwards*, so this leg has to
 * hand it to the resolver rather than trust its own environment.
 *
 * `||`, not `??`: a set-but-empty variable would make this a relative path.
 */
function wingetLinks() {
  return join(process.env.ProgramFiles || 'C:\\Program Files', 'WinGet', 'Links')
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
            `mkdir -p '${out}' && curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL '${url}' | tar -xz --strip-components=1 -C '${out}' ` +
            `&& chmod +x '${out}/looptroop'`,
          )
    },
    // No uninstall command exists for this channel; the documentation says to
    // remove the directory.
    uninstall: () => ({ removePath: binaryPrefix() }),
    published: probeReleaseAssetNamed(archive),
    expect: {
      channel: 'binary',
      upgradeCommand: binaryUpgradeCommand,
      // No `npm`: a machine on this channel need not have it at all.
      okChecksPre: ['install', 'git', 'opencode cli'],
      okChecksPost: ['opencode', 'daemon', 'port'],
    },
  }
}

/** npm, which `run` resolves to `npm.cmd` on Windows and starts through cmd.exe. */
function npmSpec(args) {
  return { command: 'npm', args }
}

/** A POSIX pipeline. `sh -c` because the documented command is a pipe. */
function shellSpec(line) {
  return { command: 'sh', args: ['-c', line], display: line }
}

/** Capture a complete HTTPS-only script before execution, preserving PowerShell lines. */
function powershellInstaller(url, args = '') {
  return `$script = curl.exe --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL ${url}; if ($LASTEXITCODE -ne 0 -or !$script) { throw "Installer download failed" }; & ([scriptblock]::Create(($script -join "\`n")))${args}`
}

/** Run the Windows command in the preinstalled PowerShell 5.1 runtime. */

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

export function run(command, args, options = {}) {
  // Resolved against the environment the child gets, and started the way the
  // daemon starts a program: a Windows command script — npm.cmd, yarn.cmd, the
  // installed looptroop.cmd — through a resolved cmd.exe with every argument
  // escaped, anything else directly. A tool that cannot be resolved comes back
  // as a run that never started, with the reason.
  const { env: extraEnv, ...spawnOptions } = options
  const env = { ...process.env, ...(extraEnv ?? {}) }
  const launch = planToolLaunch(command, args, { env })
  if (launch.reason !== undefined) return { code: null, stdout: '', stderr: '', combined: launch.reason }
  const result = spawnSync(launch.file, launch.args, {
    encoding: 'utf8',
    ...spawnOptions,
    env,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  })
  // A null status means the process never started. The resolved file can still
  // exist: a missing cwd, interpreter or loader also reports ENOENT. Keep the
  // launch target and the operating-system error together so this cannot be
  // mistaken for a resolver miss.
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const launchFailure = result.error
    ? `${launch.file}: ${result.error.code ?? 'launch failed'}: ${result.error.message ?? String(result.error)}`
    : ''
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    combined: result.status === null && result.error
      ? `${combined}${launchFailure}`
      : combined,
  }
}

/** npm, which `run` resolves to `npm.cmd` on Windows and starts through cmd.exe. */
function npm(args, options = {}) {
  return run('npm', args, options)
}

/**
 * Runs the installed launcher.
 *
 * On Windows the `bin` entry is `looptroop.cmd`, and a batch file is not an
 * executable image: spawned directly it came back with a null exit code and
 * empty output for every command — which read as a dozen assertion failures
 * about JSON and health, none of them the actual problem. `run` starts a
 * command script through cmd.exe, so this is `run` under the name the call
 * sites read best with.
 */
function runShim(shimPath, args, options = {}) {
  return run(shimPath, args, options)
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
 * On Windows this goes through the same PATHEXT-aware resolver as every other
 * tool launch. A `where` result is only text and can choose an extensionless
 * shim that CreateProcess would not run.
 */
export function whichLooptroop(pathHint) {
  const env = pathHint
    ? { PATH: `${pathHint}${IS_WINDOWS ? ';' : ':'}${process.env.PATH ?? ''}` }
    : undefined
  const resolved = findToolPath('looptroop', pathHint ? { env } : undefined)
  return resolved && existsSync(resolved) ? resolved : null
}

/**
 * Strips this workflow's GitHub token from a child process.
 *
 * Applied to the CLI, the daemon and the OpenCode it spawns — the code under
 * test — and to every uninstall command. Handing credentials to the software
 * you are testing is how a test starts passing for a reason that has nothing to
 * do with the software.
 *
 * NOT applied to the install commands any more, which is a reversal worth
 * explaining. `installer-core.mjs` reads `GITHUB_TOKEN || GH_TOKEN`, so running
 * the installers anonymously exercised the path a real user takes. It also put
 * them behind GitHub's 60-per-hour anonymous limit, from an address shared with
 * every other tenant on the runner pool — and the macOS leg failed twice on
 * exactly that, reporting a rate limit as though the release were broken.
 *
 * The anonymous branch is worth covering; a shared rate limit is a bad way to
 * cover it. `tests/installer.test.ts` now drives the installer against a
 * fixture that answers 403 and asserts the message a user actually sees, which
 * is deterministic and tests the thing that matters. The legs are free to
 * authenticate.
 */
const ANONYMOUS = { GITHUB_TOKEN: '', GH_TOKEN: '' }

/** Whether a pid still exists. Signal 0 checks without delivering anything. */
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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

/** The community feed, as both `choco` and the OData entity address it. */
const CHOCO_FEED = 'https://community.chocolatey.org/api/v2/'

/**
 * The version in one `choco search --limit-output` line, or null for none.
 *
 * `choco search` prints `id|version` per match, and this is the supported way
 * to ask the community feed anything: Chocolatey documents the CLI and
 * `chocolatey.lib` as the query interface and reserves the right to refuse
 * custom OData queries. It is also the exact question that matters, because the
 * feed only lists a version a moderator has let through — the entity endpoint
 * answers 200 for a version that has only been submitted, which is what made an
 * earlier revision of this probe report a queued release as published.
 *
 * `--exact` still matches by prefix on some Chocolatey versions, so the id is
 * compared rather than assumed.
 */
export function chocolateySearchVersion(output) {
  for (const line of String(output).split(/\r?\n/)) {
    const [id, version] = line.trim().split('|')
    if (id === 'looptroop' && version) return version
  }
  return null
}

/**
 * What Chocolatey's moderation queue says about a version it does not serve.
 *
 * The one place a custom OData query is still worth making, and the only place
 * it can do no harm: this runs when the leg already knows the feed is not
 * serving the version, and every failure falls back to the release clock. What
 * it buys is the two facts the CLI cannot give — *when* the submission was made
 * and whether it was rejected — and both decide whether waiting is reasonable.
 *
 * Attributes are tolerated on the elements. The live payload writes
 * `<d:PackageStatus>` bare and `<d:Created m:type="Edm.DateTime">` with one, and
 * a proxy or a schema revision may add others.
 */
export function chocolateySubmission(payload) {
  // Two literal patterns rather than one built from a field name. A `RegExp`
  // assembled from a variable is a pattern no scanner can read, and this one
  // bought nothing: both call sites are constants.
  const text = (match) => match?.[1]?.trim() ?? ''
  const status = text(/<d:PackageStatus\b[^>]*>([^<]*)</.exec(payload))
  // `Created` is when the push landed; `Published` stays at 1900-01-01 until a
  // moderator approves, so it cannot time a queue.
  const created = Date.parse(`${text(/<d:Created\b[^>]*>([^<]*)</.exec(payload))}Z`)
  const at = Number.isNaN(created) ? null : created
  if (status === 'Rejected') return { state: 'rejected', at, detail: 'moderation rejected it' }
  if (status === '') return { state: 'absent', at: null, detail: 'the feed has no entry for it' }
  if (status === 'Approved' || status === 'Exempted') return { state: 'served', at, detail: `moderation has it as ${status}` }
  return { state: 'queued', at, detail: `moderation has it as ${status}` }
}

/**
 * Whether Chocolatey serves a version — which is not whether it has one.
 *
 * Asked of `choco` rather than over HTTP, both because that is the supported
 * query path and because it is the same command the republish job already uses
 * to decide whether a version is on the feed.
 */
function probeChocoVersion(_recipe, version) {
  const result = run('choco', [
    'search', 'looptroop', '--exact', '--version', version, '--limit-output', '--source', CHOCO_FEED,
  ])
  // A child that never started is not an answer about the feed. Everything else
  // — including a non-zero exit with no matches, which is how Chocolatey
  // reports "nothing found" — is read from the output.
  if (result.code === null) {
    throw new Error(`choco could not be started: ${result.combined.trim().split('\n')[0]}`)
  }
  return chocolateySearchVersion(result.stdout)
}

/** What an unpinned `choco install looptroop` resolves: the feed's latest. */
function probeChocoLatest() {
  const result = run('choco', ['search', 'looptroop', '--exact', '--limit-output', '--source', CHOCO_FEED])
  if (result.code === null) {
    throw new Error(`choco could not be started: ${result.combined.trim().split('\n')[0]}`)
  }
  return chocolateySearchVersion(result.stdout)
}

/** Chocolatey's queue state for a version, for the moderation decision. */
async function probeChocoSubmission(version) {
  const response = await fetch(`${CHOCO_FEED}Packages(Id='looptroop',Version='${version}')`, {
    headers: { accept: 'application/atom+xml' },
  })
  if (response.status === 404) return { state: 'absent', at: null, detail: 'the feed has no entry for it' }
  if (!response.ok) throw new Error(`Chocolatey feed -> ${response.status}`)
  return chocolateySubmission(await response.text())
}

/**
 * Whether WinGet serves a version, asked of the client rather than of GitHub.
 *
 * A merged manifest is not an installable package. `microsoft/winget-pkgs` says
 * what *will* be indexed; the pipeline that builds the index runs after the
 * merge, and between the two a contents-API probe reports a package `winget
 * install` cannot find. Asking `winget` is the only question whose answer is
 * the one a user gets.
 *
 * A failure is not read by its message. WinGet reports a missing version, a
 * missing package and a source it cannot reach with different hex codes and
 * localised text, so the second question is asked of the client instead: does
 * it know the package at all, with no version named? If it does, only this
 * version is absent, which is exactly what a review in progress looks like. If
 * it does not, something larger is wrong — a broken runner, an unreachable
 * source, an identifier that no longer exists — and that must not wear the
 * moderation skip's clothes for the whole grace period.
 */
function probeWingetVersion(_recipe, version) {
  // `--id` and `--exact`, because a query is matched against several fields and
  // by prefix: `winget show LoopTroopAI.LoopTroop` is one same-prefix package
  // away from an ambiguity error, which `--disable-interactivity` turns into a
  // failure that would read here as "not indexed yet".
  const query = ['--id', WINGET_IDENTIFIER, '--exact']
  const source = ['--source', 'winget', '--accept-source-agreements', '--disable-interactivity']
  const result = run('winget', ['show', ...query, '--version', version, ...source])
  if (result.code === 0) return version
  // A `null` code is a child that never started — a resolver miss, a launch
  // failure — which is not an answer about the feed and must not be read as
  // one. The caller treats a throw as "could not ask" rather than "not there".
  if (result.code === null) {
    throw new Error(`winget could not be started: ${result.combined.trim().split('\n')[0]}`)
  }

  const known = run('winget', ['show', ...query, ...source])
  if (known.code !== 0) {
    throw new Error(
      `winget cannot find ${WINGET_IDENTIFIER} at all (exit ${known.code}): `
      + `${known.combined.trim().split('\n').pop()}`,
    )
  }
  log(`  winget knows ${WINGET_IDENTIFIER} but not ${version} yet (exit ${result.code})`)
  return null
}

/**
 * What became of the submission pull request for a version.
 *
 * Exported for its test. The states are the ones that change the decision: a
 * pull request that is open or merged is a queue doing its job — a merge still
 * waits for the index pipeline — while a closed one was refused and no pull
 * request at all means the release never submitted, which is a failure of ours
 * rather than a wait on somebody else.
 */
export function wingetSubmission(pulls) {
  const pull = (Array.isArray(pulls) ? pulls : [])[0]
  if (!pull) return { state: 'absent', at: null, detail: 'no submission was ever opened for it' }
  const opened = Date.parse(String(pull.created_at ?? ''))
  const at = Number.isNaN(opened) ? null : opened
  if (pull.state === 'open') return { state: 'queued', at, detail: `submitted as #${pull.number}, still open` }
  if (pull.merged_at) return { state: 'queued', at, detail: `#${pull.number} merged; the index refresh follows` }
  return { state: 'rejected', at, detail: `#${pull.number} was closed without merging` }
}

/** WinGet's queue state for a version: the submission pull request upstream. */
async function probeWingetSubmission(version) {
  const head = `${WINGET_FORK.split('/')[0]}:${wingetSubmissionBranch(version)}`
  const pulls = await getJson(
    `${API}/repos/${WINGET_UPSTREAM}/pulls?head=${encodeURIComponent(head)}&state=all&per_page=1`,
  )
  return wingetSubmission(pulls)
}

/**
 * Whether Docker Hub serves a tag, read anonymously.
 *
 * Anonymously on purpose: a private repository is readable by the account that
 * pushed it and by nobody else, so an authenticated probe would pass happily on
 * a repository from which every documented `docker pull` fails for users.
 */
/**
 * Which version `looptroopai/looptroop:latest` currently is.
 *
 * Compared by digest rather than by name, because `latest` is a separate tag
 * pointing at an image, and the only way to ask "what is latest" is to ask
 * which versioned tag shares its digest.
 */
async function probeDockerHubLatest() {
  const tags = await fetch('https://hub.docker.com/v2/repositories/looptroopai/looptroop/tags?page_size=100')
  if (!tags.ok) throw new Error(`Docker Hub tags -> ${tags.status}`)
  const results = (await tags.json()).results ?? []
  const latest = results.find((t) => t.name === 'latest')
  if (!latest) return null
  const match = results.find((t) => t.name !== 'latest' && t.digest && t.digest === latest.digest
    && /^\d+\.\d+\.\d+$/.test(t.name))
  return match?.name ?? null
}

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
    // The CLI, the daemon it starts and the OpenCode it spawns are the code
    // under test. None of them should ever see this workflow's token: it is
    // read-only, but handing credentials to the software you are testing is how
    // a test starts passing for a reason that has nothing to do with the
    // software.
    ...ANONYMOUS,
    LOOPTROOP_CONFIG_DIR: configDir,
    LOOPTROOP_BACKEND_PORT: String(port),
    LOOPTROOP_OPENCODE_BASE_URL: `http://127.0.0.1:${opencodePort}`,
    ...(opencodeMode === 'mock' ? { LOOPTROOP_OPENCODE_MODE: 'mock' } : {}),
  }

  let adopted = null
  // Recorded before anything is installed: the uninstall step refuses to delete
  // a directory it did not create.
  // Optional call: a delegated channel (the container) has no uninstall at all,
  // and calling it unconditionally crashed that leg before it ran.
  const prefixExistedBefore = existsSync(recipe.uninstall?.({ version })?.removePath ?? '\u0000')
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
  // Whether this run started a daemon of its own. The teardown below used to
  // run `stop` unconditionally through `shim()`, which falls back to a bare
  // `looptroop` resolved from PATH — right for the assertions, which are about
  // what a user's shell would run, and wrong for cleanup. A delegated recipe
  // (the container) never installs a launcher at all, and an install that
  // failed leaves whatever the machine already had, so the teardown was
  // stopping somebody else's daemon on the way out.
  let startedDaemon = false
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

      // The other registry's moving tag. `container-verify` pulls GHCR by exact
      // version after every release, and the weekly leg below pulls Docker Hub
      // — so `ghcr.io/...:latest` is the one documented pointer nothing checks,
      // and a repair that retagged only one registry would leave it stale
      // indefinitely. Compared by manifest rather than pulled: this asks where
      // a tag points, which needs no image on disk.
      heading('The GHCR latest tag points at this release')
      const ghcr = `ghcr.io/${REPO.toLowerCase()}`
      const digestOf = (ref) => {
        const out = run('docker', ['manifest', 'inspect', ref])
        return out.code === 0 ? createHash('sha256').update(out.stdout).digest('hex') : null
      }
      const latestDigest = digestOf(`${ghcr}:latest`)
      const versionDigest = digestOf(`${ghcr}:${version}`)
      check(
        'ghcr latest matches this version',
        latestDigest !== null && latestDigest === versionDigest,
        latestDigest === null
          ? `could not read ${ghcr}:latest`
          : `${ghcr}:latest is a different image from :${version}`,
      )

      heading(`Delegate to ${spec.args[0]}`)
      const delegated = run(spec.command, spec.args, { stdio: 'inherit' })
      check('container smoke', delegated.code === 0, `exit ${delegated.code}`)
      return { ok: failures.length === 0, served }
    }

    // Checked before installing, not before cleaning up. The earlier guard only
    // refused to *delete* a pre-existing prefix, by which point the install had
    // already written into it — so a directory this run had no business
    // touching was overwritten and then left in place. On a hosted runner it
    // never exists; run by hand, which `verify:published` is documented for, it
    // is somebody's working installation.
    if (prefixExistedBefore) {
      abort(
        `${recipe.uninstall({ version }).removePath} already exists.`,
        'This channel installs into that directory and would overwrite what is there.',
        'Remove it yourself, or point LOOPTROOP_INSTALL_DIR somewhere disposable.',
      )
      return { ok: false, served }
    }

    heading(`Install: ${recipe.documented}${pin ? ` (pinned to ${version})` : ''}`)
    const spec = recipe.install({ version, pin })
    log(`  $ ${spec.display ?? [spec.command, ...spec.args].join(' ')}`)
    // Authenticated on purpose; see ANONYMOUS. The installers' unauthenticated
    // branch is covered by a unit test rather than by whether a shared runner
    // address has requests left.
    const install = run(spec.command, spec.args, {
      cwd: elsewhere,
      env: spec.env ?? {},
    })
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
      const opencodeLog = join(scratch, 'adopted-opencode.log')
      const logFd = openSync(opencodeLog, 'a')
      // Resolved, then through a shell — not a name handed to the shell to look
      // up. Installed from npm, `opencode` is a shim: `opencode.cmd` on
      // Windows, which Node refuses to launch directly, and on POSIX a symlink
      // into a package directory. The resolver applies PATHEXT and follows the
      // link, so the shell is left with only the part it is needed for, which
      // is the same reasoning the daemon's own supervisor applies.
      //
      // Output goes to a file rather than `ignore`. A server that refuses to
      // start otherwise reports itself as "nothing is listening", which says
      // what happened but nothing about why, and this is a detached process
      // whose stderr is gone the moment it exits.
      const opencodeLaunch = launchTool('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(opencodePort)])
      adopted = spawn(opencodeLaunch.file, opencodeLaunch.args, {
        stdio: ['ignore', logFd, logFd],
        detached: !IS_WINDOWS,
        windowsVerbatimArguments: opencodeLaunch.windowsVerbatimArguments,
        // Somebody else's server. It has no more business holding this
        // workflow's token than the CLI under test does.
        env: { ...process.env, ...ANONYMOUS },
      })
      adopted.unref()
      const up = await waitForOpenCode(opencodePort)
      if (!check('adopted OpenCode is listening', up, `nothing on ${opencodePort} after 4 minutes`)) {
        try {
          log(`  --- ${opencodeLog} ---`)
          for (const line of readFileSync(opencodeLog, 'utf8').trim().split('\n').slice(-15)) log(`  ${line}`)
        } catch {
          log('  (the adopted OpenCode wrote nothing at all)')
        }
        return { ok: false, served }
      }
    }

    heading('The daemon starts on the port it was given')
    if (!(await portIsFree(port))) {
      fail('port is free before start', `${port} is already held — this runner is dirty`)
      return { ok: false, served }
    }
    const started = cli(['start', '--port', String(port)])
    // Recorded before the check, not after: a `start` that failed may still
    // have left something half-up holding the port and the lock, which is
    // exactly what the teardown exists to clear.
    startedDaemon = true
    if (!check('start', started.code === 0, `exit ${started.code}: ${started.combined.trim().slice(-300)}`, `port ${port}`)) {
      return { ok: false, served }
    }

    heading('It answers on the health endpoint')
    const health = await waitForHealth(baseUrl, HEALTH_TIMEOUT_MS)
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

    heading('The daemon state records the port and how it got its OpenCode')
    const statePath = join(configDir, 'daemon.json')
    let managedPid = null
    if (existsSync(statePath)) {
      const state = readJson(readFileSync(statePath, 'utf8'), 'daemon.json')
      check('daemon.json port', state?.port === port, `recorded ${state?.port}, expected ${port}`)

      // Distinguishes a server LoopTroop started from one it found already
      // running. Asserting only that OpenCode is reachable cannot tell those
      // apart — an adopt leg whose pre-started server had died and been
      // replaced by a spawned one would look identical, and the path that leg
      // exists to cover would go untested while reporting success.
      //
      // The field is `status`, NOT `kind`. The supervisor's in-memory
      // `OpenCodeStatus` is discriminated by `kind`, but `describeOpenCode()`
      // maps it to `DaemonState['opencode']` on the way to the state file, and
      // that shape uses `status` — see `describeOpenCodeForStatus` in
      // `commands.ts`, which switches on exactly these values. Reading the
      // in-memory type and assuming it was the persisted one made every leg
      // fail against a perfectly good release.
      const oc = state?.opencode
      if (opencodeMode === 'adopt') {
        check('OpenCode was adopted, not spawned', oc?.status === 'adopted', `daemon recorded status=${oc?.status}`, 'adopted')
      } else if (opencodeMode !== 'mock') {
        check('OpenCode was spawned by the daemon', oc?.status === 'managed', `daemon recorded status=${oc?.status}`, 'managed')
        check('the managed OpenCode has a pid', Number.isInteger(oc?.pid), `pid=${oc?.pid}`, String(oc?.pid ?? ''))
        managedPid = Number.isInteger(oc?.pid) ? oc.pid : null
      }
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
      // A daemon that killed a server it did not start would take a user's own
      // OpenCode down with it.
      check('adopted OpenCode outlived the daemon', await openCodeAnswers(opencodePort), 'the adopted server was killed')
    } else if (opencodeMode !== 'mock') {
      check('managed OpenCode stopped with the daemon', await portIsClosed(opencodePort), `${opencodePort} still answers`)
      // The port closing is not the same as the process being gone: a
      // supervisor that leaked its child would leave it holding the config
      // directory, which only shows up as a mysterious failure on the next run.
      if (managedPid !== null) {
        check('the managed OpenCode process is gone', !processAlive(managedPid), `pid ${managedPid} is still alive`)
      }
    }

    heading('It uninstalls the way the documentation says')
    const removal = recipe.uninstall({ version })
    if (removal.removePath) {
      // The standalone executable has no uninstall command; the documentation
      // says to remove the directory. Asserting the whole prefix is gone, not
      // just the launcher, is the difference between uninstalled and orphaned.
      //
      // Refused when the directory already existed before this run. On a hosted
      // runner it never does, but `verify:published` is documented for use by
      // hand, and there this is a recursive delete of somebody's real
      // installation — one they did not ask a test to remove.
      if (prefixExistedBefore) {
        log(`  skipped  (${removal.removePath} existed before this run; refusing to delete it)`)
        log('  Remove it yourself if you want the uninstall covered here.')
      } else {
        log(`  $ rm -rf ${removal.removePath}`)
        rmSync(removal.removePath, { recursive: true, force: true })
        check('the install prefix is gone', !existsSync(removal.removePath), `${removal.removePath} survived`)
      }
    } else {
      log(`  $ ${removal.display ?? [removal.command, ...removal.args].join(' ')}`)
      const removed = run(removal.command, removal.args, {
        cwd: elsewhere,
        env: { ...ANONYMOUS, ...(removal.env ?? {}) },
      })
      check('uninstall', removed.code === 0, `exit ${removed.code}: ${removed.combined.trim().slice(-200)}`)
    }
    check('the launcher is gone from PATH', whichLooptroop(recipe.pathHint?.()) === null, 'looptroop still resolves')

    return { ok: failures.length === 0, served }
  } finally {
    // Best effort, and never throws. `stop` is attempted even when start failed
    // or timed out: a half-started daemon still holds the port and the lock.
    //
    // Only the executable this run resolved and started, though. Both
    // conditions are needed: `shimPath` is null for a delegated recipe and for
    // an install that never got far enough, and `startedDaemon` is false when
    // this leg stopped before the lifecycle began — in either case there is
    // nothing of ours to stop, and the fallback would stop the machine's own.
    if (shimPath !== null && startedDaemon) {
      try {
        runShim(shimPath, ['stop'], { cwd: elsewhere, env: childEnv, timeout: 30_000 })
      } catch {
        // Nothing to stop.
      }
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
    // Through the shared helper, like every other smoke script: a bare `rmSync`
    // gives a held Windows handle no chance to be released, so the scratch
    // directory was silently left behind on the platform that needs the retries.
    const leftover = removeWorkDirectory(scratch)
    if (leftover) log(`  (could not remove ${scratch}: ${leftover.message})`)
  }
}

/**
 * Waits for a pre-started OpenCode to answer.
 *
 * Generous, and bounded. This is a readiness wait for a prerequisite, not a
 * retry of an assertion: nothing about the release is being judged until it
 * returns. OpenCode's start-up is highly variable — a few seconds on an idle
 * machine, and observed above five minutes on a loaded one — so a tight cap
 * turns a slow prerequisite into a failure report about LoopTroop.
 *
 * The elapsed time is printed on success as well as failure, so a server that
 * is quietly getting slower is visible before it starts timing out.
 */
async function waitForOpenCode(port, timeoutMs = 240_000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    if (await openCodeAnswers(port)) {
      log(`  ready after ${Math.round((Date.now() - started) / 1000)}s`)
      return true
    }
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
    // Stubs are never scheduled. They exist so `--plan` can report what is not
    // covered, which is a standing, accurate statement rather than silence.
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
    leg: null,
  }
  const takesValue = new Set([
    '--channel', '--version', '--opencode', '--profile', '--tier', '--result-file', '--only', '--skip', '--leg',
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
    else if (arg === '--leg') options.leg = value
  }
  return options
}

/**
 * Why a moderated channel's leg is not being run, or null when it must run.
 *
 * Exported for its test, because the cases that matter are the ones nobody
 * reaches by hand.
 *
 * A skip is a claim that a queue explains the absence, and three things cannot
 * support that claim. An age nothing could answer for: counting that as inside
 * the window — which this did first — makes every repeated lookup failure a
 * successful skip, so a submission rejected months ago stays green for as long
 * as the failures last. A rejection: that is an answer, not a wait. And a
 * version with no submission at all, which means the publish never happened and
 * the queue is not the problem.
 *
 * `unknown` — a queue that could not be reached — is treated as a wait, because
 * it is not evidence either way and the age still bounds it. `served`
 * contradicts the feed and belongs on the ordinary path, which polls.
 */
export function moderationSkipReason({ queue, graceDays }, { version, ageHours, serves, state = 'queued' }) {
  if (state !== 'queued' && state !== 'unknown') return null
  if (ageHours === null || ageHours >= graceDays * 24) return null
  const waiting = `${version} is waiting on ${queue}`
  return serves === null ? waiting : `${waiting}; the feed serves ${serves}`
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
    leg: options.leg ?? `${recipe.key} (${process.platform})`,
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
    for (const leg of legs) log(`  ${leg.name.padEnd(38)} tier=${leg.tier} opencode=${leg.opencode}`)

    // Printed on every plan, including green ones. A channel nobody mentions is
    // indistinguishable from a channel nobody covers.
    const stubs = Object.entries(CHANNELS).filter(([, recipe]) => recipe.stub)
    if (stubs.length > 0) {
      log('\nNot covered:')
      for (const [key, recipe] of stubs) log(`  ${key.padEnd(38)} ${recipe.stub}`)
    }
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
  try {
    version = validatePublishedVersion(version)
  } catch (error) {
    abort(error.message)
    return
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

  // Chocolatey and WinGet publish by joining a queue a human works through, so
  // a release reaches those feeds days or weeks after it is tagged. Inside that
  // window the channel is behaving exactly as documented and the assertion that
  // would fail is a correct one, so the leg reports itself as not run — the
  // same bargain pnpm's hold makes.
  //
  // Bounded, because from here "still in review" and "rejected, and nobody
  // noticed" look identical unless the queue is asked. `submission` is what
  // asks: a rejection, or a version nobody ever submitted, stops being a wait
  // immediately, and the clock runs from when the submission was made rather
  // than from when the release was tagged. Those are different dates whenever a
  // channel is repaired after the fact, which is what `channel-republish.yml`
  // exists for — a submission made today against a month-old release would
  // otherwise be overdue the moment it was pushed.
  //
  // `notServed` carries the verdict out. When the feed is known not to serve
  // the version, nothing downstream can pass, so the leg fails here with the
  // reason instead of polling a feed that has nothing for ten minutes and
  // aborting with a message the report cannot see.
  let notServed = null
  if (recipe.moderated) {
    // A release that carries nothing for this channel is neither a wait nor a
    // failure. `publish-winget` skips a release cut without binaries, and
    // without this the leg would ask for a version that can never exist.
    if (recipe.requiresReleaseAsset) {
      const asset = recipe.requiresReleaseAsset(version)
      const carried = await probeReleaseAsset(asset)(recipe, version).catch(() => 'unknown')
      if (carried === null) {
        const reason = `v${version} carries no ${asset}, so there is nothing for ${recipe.key} to serve`
        log(`\n${recipe.key}: not run (${reason})`)
        writeSkipResult(options, recipe, version, reason)
        return
      }
    }

    let serving = null
    let answered = true
    try {
      serving = await recipe.published(recipe, version)
    } catch (error) {
      // A probe that could not answer is not evidence of a queue, and not
      // evidence against one either. Fall through to the ordinary run, where
      // `awaitPublished` asks again and a throw there fails loudly.
      log(`  (could not ask ${recipe.key} what it serves: ${error.message})`)
      answered = false
    }
    if (answered && serving !== version) {
      // Both of these are optional and both talk to something outside this
      // process, so both are guarded. `try`/`catch` rather than `.catch`,
      // because a probe may be synchronous — Chocolatey's now runs `choco` —
      // and a synchronous throw never reaches a promise handler.
      let submission = null
      if (recipe.submission) {
        try {
          submission = await recipe.submission(version)
        } catch (error) {
          log(`  (could not ask ${recipe.key} about the submission: ${error.message})`)
        }
      }
      // The submission clock where the queue keeps one, the release clock
      // otherwise. Both are hours, and both can come back unknown.
      const ageHours = submission?.at != null
        ? (Date.now() - submission.at) / 3_600_000
        : await releaseAgeHours(version)
      // What the feed does serve, for the report. `serving` cannot say: a
      // presence probe answers about the version it was asked about and returns
      // null for every other state, so a reason built from it read "the feed
      // serves (nothing)" even while Chocolatey was serving an earlier release.
      let serves = null
      if (recipe.latest) {
        try {
          serves = await recipe.latest()
        } catch (error) {
          log(`  (could not ask ${recipe.key} what it serves: ${error.message})`)
        }
      }
      const state = submission?.state ?? 'unknown'
      const reason = moderationSkipReason(recipe.moderated, { version, ageHours, serves, state })
      if (reason !== null) {
        log(`\n${recipe.key}: not run (${reason})`)
        writeSkipResult(options, recipe, version, reason)
        return
      }
      // Only where the queue has actually answered. A submission that is
      // `served` contradicts the feed — an approval minutes old that the search
      // index has not caught up with — and one nobody could ask about says
      // nothing at all; both belong on the ordinary path, where the propagation
      // poll gives the feed its ten minutes before anyone calls it a failure.
      const answeredFinally = state === 'rejected' || state === 'absent'
        || (state === 'queued' && (ageHours === null || ageHours >= recipe.moderated.graceDays * 24))
      if (answeredFinally) {
        const days = ageHours === null ? null : Math.round(ageHours / 24)
        const clauses = [submission.detail]
        // A rejection is dated but not overdue, and a version nobody submitted
        // has no clock at all, so only a queued one is measured against the
        // grace period. Saying "past the grace period" about a rejection would
        // name the wrong reason for the failure.
        if (state === 'queued') {
          clauses.push(days === null
            ? 'and how long it has been waiting cannot be read'
            : `for ${days} days, past the ${recipe.moderated.graceDays}-day grace period`)
        } else if (state === 'rejected' && days !== null) {
          clauses.push(`${days} days ago`)
        }
        if (serves !== null) clauses.push(`the feed serves ${serves}`)
        notServed = clauses.join('; ')
      }
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

  const opencodeMode = options.opencode ?? 'npm'
  log(`\nChannel ${recipe.key} | version ${version} | profile ${options.profile} | opencode ${opencodeMode}`)
  log(`Documented command: ${recipe.documented}`)

  const startedAt = Date.now()
  let result = { ok: false, served: null }
  if (notServed !== null) {
    // Recorded through `fail` rather than `abort`, which prints to stderr and
    // leaves `failures` empty — the report renders that array, so an aborted
    // leg reaches the reader as a FAIL with no reason attached.
    fail(`${recipe.key} does not serve ${version}`, notServed)
  } else {
    try {
      result = await runChannel(recipe, { version, pin: options.pin, profile: options.profile, opencodeMode })
    } catch (error) {
      fail('unexpected error', error?.stack ?? String(error))
    }
  }

  const summary = {
    channel: recipe.key,
    // The name the plan gave this leg — `npm (macos-latest)` — not
    // `process.platform`, which says `darwin` and cannot be matched back to a
    // runner label. Without it the reporter can only match by channel, and
    // pins a failure on whichever operating system it happens to find first.
    leg: options.leg ?? `${recipe.key} (${process.platform})`,
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
