import { dirname, resolve, sep } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readSettingsFile, writeSettingsFile } from './appSettings'
import { isSea } from './isSea'

import type { InstallChannel } from '@shared/installChannel'
export type { InstallChannel }

export interface InstallInfo {
  channel: InstallChannel
  /** Exact command that upgrades this installation. */
  upgradeCommand: string
  /**
   * A command that must be run before `upgradeCommand`, where one is required.
   *
   * Kept separate rather than joined into one line, because no single joining
   * operator works in both shells a Windows user might be in: `&&` is a
   * PowerShell 7 operator and a parse error in the built-in PowerShell 5.1,
   * while `;` chains in PowerShell and does not in `cmd.exe`. Two commands
   * printed on two lines are correct everywhere.
   */
  upgradeFirst?: string
  /** Run after upgrading so a background daemon loads the new files. */
  postUpgradeCommand?: string
  /** Channel-specific context that cannot be expressed as one safe command. */
  upgradeNote?: string
}

/**
 * What has to happen before the upgrade command can work.
 *
 * Only WinGet has one: Windows refuses to replace a running executable, and
 * the daemon holds this one open. The `--binary` installer stops the daemon
 * itself, and the other channels replace files the daemon does not lock.
 */
const UPGRADE_PREREQUISITES: Partial<Record<InstallChannel, string>> = {
  winget: 'looptroop stop',
}

const POST_UPGRADE_COMMANDS: Partial<Record<InstallChannel, string>> = {
  npm: 'looptroop restart',
  bun: 'looptroop restart',
  pnpm: 'looptroop restart',
  yarn: 'looptroop restart',
  homebrew: 'looptroop restart',
  scoop: 'looptroop restart',
  chocolatey: 'looptroop restart',
  winget: 'looptroop open',
  aur: 'looptroop restart',
  source: 'looptroop restart',
}

const UPGRADE_NOTES: Partial<Record<InstallChannel, string>> = {
  pnpm: 'pnpm may hold a newly published version for about 24 hours; retry later or install the exact version shown.',
  homebrew: 'If Homebrew has not indexed this release yet, retry after the channel publish finishes.',
  scoop: 'If Scoop has not indexed this release yet, retry after the channel publish finishes.',
  chocolatey: 'Chocolatey releases can remain unavailable while community moderation is pending.',
  winget: 'WinGet releases can lag GitHub while the manifest is reviewed and indexed.',
  aur: 'AUR releases can lag GitHub until the package update is published.',
  binary: 'The standalone installer stops and restarts a running LoopTroop daemon automatically.',
  container: 'The image tag can briefly lag the GitHub release. After pulling it, recreate the LoopTroop container with the same volumes, ports, and environment settings.',
  unknown: 'Restart a running LoopTroop daemon after upgrading so it loads the new version.',
}

const UPGRADE_COMMANDS: Record<InstallChannel, string> = {
  npm: 'npm install -g looptroop@latest',
  // Their own commands, not npm's. All three install the same package from the
  // same registry, but each keeps its global tree somewhere the others do not
  // look — so `npm install -g` run against a bun or pnpm installation does not
  // upgrade it. It installs a *second* copy under npm's prefix and leaves the
  // first where it was, and which one answers then depends on PATH order.
  bun: 'bun add -g looptroop@latest',
  pnpm: 'pnpm add -g looptroop@latest',
  // Yarn Classic only. Yarn 2 and later removed `yarn global` outright — there
  // is no global install in modern Yarn, and no replacement for one — so a
  // LoopTroop installed by Yarn is by definition a 1.x install, and this is the
  // command that upgrades it.
  yarn: 'yarn global upgrade looptroop@latest',
  homebrew: 'brew upgrade looptroop',
  scoop: 'scoop update looptroop',
  chocolatey: 'choco upgrade looptroop',
  // Preceded by `looptroop stop`; see UPGRADE_PREREQUISITES.
  winget: 'winget upgrade LoopTroopAI.LoopTroop',
  // No single command exists here: pacman does not touch the AUR, and which
  // helper does is the user's choice. `yay` is the most widely installed, and
  // naming one that works beats a sentence that tells them nothing they did
  // not already know.
  aur: 'yay -Syu looptroop-bin   (or your AUR helper of choice)',
  // The installer's own `--binary` mode, which replaces the executable in
  // place: it stops the daemon, swaps the file, checks the new one runs, rolls
  // back if it does not, and starts the daemon again if it had been running.
  //
  // Windows gets the scriptblock form rather than `irm | iex`, because a piped
  // script cannot be given a parameter and this one needs `-Binary`.
  binary: process.platform === 'win32'
    ? '& ([scriptblock]::Create((irm https://www.looptroop.ovh/install.ps1))) -Binary'
    : 'curl -fsSL https://www.looptroop.ovh/install | sh -s -- --binary',
  container: 'docker pull looptroopai/looptroop:latest',
  source: 'git pull && npm install && npm run build',
  unknown: 'See https://www.looptroop.ovh for upgrade instructions',
}

/**
 * File an installer may drop at the package root to state the channel outright.
 *
 * Homebrew, Scoop and Chocolatey all extract the same bundle, so nothing about
 * the files themselves distinguishes them; only the manager that unpacked them
 * knows, and this is where it says so. Deliberately at the package root rather
 * than beside this module, because detection runs from `dist/server/lib` and an
 * installer has no business knowing that.
 */
export const INSTALL_CHANNEL_MARKER = '.install-channel'

/** Depth is bounded so a detached or unusual layout cannot walk to `/` slowly. */
const PACKAGE_ROOT_SEARCH_DEPTH = 12

/**
 * The directory holding this package's `package.json`, walking up from `dir`.
 *
 * Every install layout puts the manifest at the root of whatever was unpacked —
 * a Cellar keg's `libexec`, a Scoop app directory, `node_modules/looptroop`, a
 * checkout — so this is the one anchor that is the same shape everywhere.
 */
function findPackageRoot(dir: string): string | null {
  let current = resolve(dir)

  for (let depth = 0; depth < PACKAGE_ROOT_SEARCH_DEPTH; depth += 1) {
    if (existsSync(resolve(current, 'package.json'))) return current

    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }

  return null
}

function readChannelMarker(packageRoot: string | null): InstallChannel | null {
  if (packageRoot === null) return null

  let raw: string
  try {
    raw = readFileSync(resolve(packageRoot, INSTALL_CHANNEL_MARKER), 'utf8')
  } catch {
    return null
  }

  const value = raw.trim().toLowerCase()
  // `unknown` is refused rather than honoured: it is what a truncated or garbage
  // file also looks like, and honouring it would suppress better evidence.
  return value !== 'unknown' && isInstallChannel(value) ? value : null
}

/**
 * Evidence written by whoever installed this copy, which therefore cannot be
 * stale in the way a path or a remembered answer can.
 */
function detectFromMarkers(moduleDir: string): InstallChannel | null {
  // Containers set this at build time; nothing else does.
  if (process.env.LOOPTROOP_CONTAINER === '1') return 'container'

  return readChannelMarker(findPackageRoot(moduleDir))
}

/**
 * Evidence inferred from where the files landed, for installs that left no
 * marker — every npm install, and anything predating the marker.
 */
function detectFromShape(moduleDir: string): InstallChannel {
  const normalized = moduleDir.split(sep).join('/')

  // Path patterns first, because a package manager that unpacked a binary owns
  // its directory and that is stronger evidence than the artifact's own shape.
  // `isSea()` only says *what* this is, never where it came from — a binary
  // from WinGet, from a tarball and from Nix are all single-file builds.

  // Only the Cellar, never a bare `/homebrew/`: on a Mac whose Node came from
  // Homebrew, a plain `npm install -g` lands in
  // `/opt/homebrew/lib/node_modules/looptroop`, which the loose pattern called
  // `homebrew` and answered with `brew upgrade looptroop` — a command that fails
  // because no such formula is installed. The Cellar path covers Linuxbrew too.
  if (/\/Cellar\/looptroop\//i.test(normalized)) return 'homebrew'
  if (/\/scoop\/apps\/looptroop\//i.test(normalized)) return 'scoop'
  if (/\/ProgramData\/chocolatey\//i.test(normalized)) return 'chocolatey'
  // WinGet unpacks a portable archive and runs nothing afterwards, so unlike
  // the other three it cannot leave a marker file behind. The install path is
  // the only evidence there is, and WinGet owns this directory outright.
  //
  // Both `Packages` and `Links`, because a portable is reached through an alias
  // WinGet puts in `Links` and the running executable resolves to that rather
  // than to the unpacked copy. Matching only `Packages` made a WinGet install
  // report itself as a plain downloaded binary — right about the artifact,
  // wrong about the upgrade command, which is the whole point of asking.
  //
  // Not `/Microsoft/WinGet/`, because only a *user*-scope install lives under
  // `%LOCALAPPDATA%\Microsoft\WinGet`. A machine-scope one lives at
  // `C:\Program Files\WinGet\Links`, with no `Microsoft` in the path at all —
  // so the narrower pattern reported every machine-wide install as a plain
  // downloaded binary, and gave those users the wrong upgrade command.
  //
  // Still anchored on the two directories WinGet owns rather than on the word
  // alone: a checkout that merely sits inside a directory called `winget` —
  // `winget-pkgs`, for one, which is exactly what somebody working on this
  // package would have — must not be read as an install.
  if (/\/WinGet\/(Links|Packages)(\/|$)/i.test(normalized)) return 'winget'

  // bun and pnpm before npm, because a global install by either of them also
  // lands in a directory called `node_modules/looptroop` and the npm rule below
  // would claim it. Getting that wrong is not cosmetic: it answers with
  // `npm install -g`, which does not upgrade a bun or pnpm installation — it
  // creates a second one under npm's prefix. That is the Homebrew-upgrade bug
  // again, and it was measured, not predicted: both managers reported `npm`.
  //
  // pnpm links a global install out of its content-addressable store, so the
  // *resolved* path of the running module is inside `store/v<n>/links/…` and
  // never the `global/v<n>/…` directory its shim names. Node resolves symlinks
  // when it loads a module, so the store path is what detection actually sees.
  if (/\/store\/v\d+\/links\/.*\/node_modules\/looptroop\//i.test(normalized)) return 'pnpm'
  // The virtual store, for a layout that keeps the package inside `.pnpm`.
  if (/\/\.pnpm\/looptroop@/i.test(normalized)) return 'pnpm'
  // bun's global tree is always `<BUN_INSTALL>/install/global`, whatever
  // `BUN_INSTALL` points at — the doubled `install/global` is bun's, not npm's.
  if (/\/install\/global\/node_modules\/looptroop\//i.test(normalized)) return 'bun'
  // Yarn Classic keeps its global tree in a plain `node_modules`, so only the
  // directory above it tells the two apart: `~/.config/yarn/global` on Linux and
  // macOS, `%LOCALAPPDATA%\Yarn\Data\global` on Windows. Measured, like the
  // others — `yarn global dir` reports `…/.config/yarn/global`, and the module
  // resolves to `<that>/node_modules/looptroop`.
  if (/\/yarn\/(data\/)?global\/node_modules\/looptroop\//i.test(normalized)) return 'yarn'

  if (/\/node_modules\/looptroop\//.test(normalized)) return 'npm'

  // A checkout has the sources a published package never ships.
  const packageRoot = findPackageRoot(moduleDir)
  if (packageRoot !== null && existsSync(resolve(packageRoot, 'server')) && existsSync(resolve(packageRoot, '.git'))) {
    return 'source'
  }

  // Last, and only once every path has been ruled out. A single-file build that
  // no package manager owns was downloaded and put somewhere by hand, and
  // `binary` is the honest answer for it. Checked here rather than first
  // precisely because being a single-file build says nothing about provenance.
  if (isSea()) return 'binary'

  return 'unknown'
}

/**
 * Infers how this copy was installed.
 *
 * Precedence is `LOOPTROOP_CONTAINER=1` → marker file → path shape → `unknown`,
 * strongest evidence first. Telling the user the wrong upgrade command is worse
 * than telling them none, so anything ambiguous resolves to `unknown` rather
 * than guessing npm.
 */
export function detectInstallChannel(moduleDir = dirname(fileURLToPath(import.meta.url))): InstallChannel {
  return detectFromMarkers(moduleDir) ?? detectFromShape(moduleDir)
}

export function getInstallInfo(moduleDir?: string): InstallInfo {
  const channel = detectInstallChannel(moduleDir)
  return info(channel)
}

/** The `install` object in `config.json`. */
export interface RecordedInstall {
  channel: InstallChannel
  /**
   * Directory detection ran against. Absent means a human wrote this entry to
   * correct a bad guess, and the pin holds wherever the files live.
   */
  path?: string
}

export const INSTALL_SETTINGS_KEY = 'install'

function isInstallChannel(value: unknown): value is InstallChannel {
  // `hasOwn` rather than `in`: `in` walks the prototype chain, so `"constructor"`
  // in a config file or a marker would pass and hand back Object's constructor
  // where an upgrade command belongs.
  return typeof value === 'string' && Object.hasOwn(UPGRADE_COMMANDS, value)
}

/** Reads the recorded channel, treating anything malformed as unrecorded. */
export function readRecordedInstall(configDir?: string): RecordedInstall | null {
  const raw: unknown = readSettingsFile(configDir)[INSTALL_SETTINGS_KEY]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null

  const candidate = raw as { channel?: unknown; path?: unknown }
  if (!isInstallChannel(candidate.channel)) return null

  return typeof candidate.path === 'string'
    ? { channel: candidate.channel, path: candidate.path }
    : { channel: candidate.channel }
}

export interface ResolveInstallOptions {
  configDir?: string
  moduleDir?: string
}

function info(channel: InstallChannel): InstallInfo {
  const first = UPGRADE_PREREQUISITES[channel]
  const post = POST_UPGRADE_COMMANDS[channel]
  const note = UPGRADE_NOTES[channel]
  return {
    channel,
    upgradeCommand: UPGRADE_COMMANDS[channel],
    ...(first === undefined ? {} : { upgradeFirst: first }),
    ...(post === undefined ? {} : { postUpgradeCommand: post }),
    ...(note === undefined ? {} : { upgradeNote: note }),
  }
}

function record(channel: InstallChannel, moduleDir: string, configDir?: string): void {
  try {
    writeSettingsFile({ [INSTALL_SETTINGS_KEY]: { channel, path: moduleDir } }, configDir)
  } catch {
    // A read-only install or an unwritable config dir costs one re-detection
    // per command and nothing else, so it must not fail the command itself.
  }
}

/**
 * The install channel for this copy: strongest available evidence, remembered.
 *
 * Precedence is marker → record → path shape. A marker outranks the record
 * because it was written by the thing that did the installing, and the record
 * can be older than the install it describes; the record outranks a path shape
 * because a shape is a guess and the record may be a human correcting one.
 *
 * The record is nonetheless checked against the path it was written for, and
 * dropped when the two contradict each other. Without that, one wrong answer is
 * permanent: an earlier release wrote `homebrew` for paths under `node_modules`
 * on any Mac whose Node came from Homebrew, and because reinstalling puts the
 * files back at that same path, no later detection would ever run again. The
 * check is the same one the container marker already justified, applied to
 * ordinary channels: evidence that disagrees with itself is stale, not binding.
 */
export function resolveInstallInfo(options: ResolveInstallOptions = {}): InstallInfo {
  const moduleDir = options.moduleDir ?? dirname(fileURLToPath(import.meta.url))
  const recorded = readRecordedInstall(options.configDir)
  const marker = detectFromMarkers(moduleDir)

  if (marker !== null) {
    // A config volume first filled by a global npm install and then mounted into
    // a container carries `channel: npm`, and answering from it would tell the
    // user to `npm install -g` a tree the next `docker run` throws away. The
    // same holds for a marker file: whatever the user meant to correct with a
    // hand-written pin, they were not correcting who installed these files.
    const agrees = recorded?.channel === marker
    // Re-recording only when something would change, so a container does not
    // write to its config volume on every command.
    if (!agrees || (recorded.path !== undefined && recorded.path !== moduleDir)) {
      record(marker, moduleDir, options.configDir)
    }
    return info(marker)
  }

  if (recorded) {
    // No path means a human wrote this to correct a bad guess: it holds wherever
    // the files live, and is never overwritten.
    if (recorded.path === undefined) return info(recorded.channel)

    if (recorded.path === moduleDir) {
      const shape = detectFromShape(moduleDir)
      // `unknown` is not a contradiction, just silence — a custom install root
      // looks like this, and the record is the only thing that knows better.
      if (shape === 'unknown' || shape === recorded.channel) return info(recorded.channel)

      record(shape, moduleDir, options.configDir)
      return info(shape)
    }
    // A recorded path that no longer matches means this copy moved, so the old
    // answer describes an installation that is no longer the one running.
  }

  const channel = detectFromShape(moduleDir)
  // `unknown` is not worth recording: it is precisely the answer a later run —
  // one with LOOPTROOP_CONTAINER set, say — deserves another attempt at.
  if (channel !== 'unknown') record(channel, moduleDir, options.configDir)

  return info(channel)
}

/** Semver comparison limited to the numeric core; prereleases sort below release. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string): number[] => {
    const core = value.trim().replace(/^v/, '').split('-')[0] ?? ''
    return core.split('.').map((part) => Number.parseInt(part, 10) || 0)
  }

  const left = parse(candidate)
  const right = parse(current)

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }

  // Equal cores: a prerelease is older than the matching release.
  const candidatePre = candidate.includes('-')
  const currentPre = current.includes('-')
  return currentPre && !candidatePre
}
