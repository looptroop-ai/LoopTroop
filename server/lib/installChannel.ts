import { dirname, resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readSettingsFile, writeSettingsFile } from './appSettings'

export type InstallChannel = 'npm' | 'homebrew' | 'scoop' | 'chocolatey' | 'container' | 'source' | 'unknown'

export interface InstallInfo {
  channel: InstallChannel
  /** Exact command that upgrades this installation. */
  upgradeCommand: string
}

const UPGRADE_COMMANDS: Record<InstallChannel, string> = {
  npm: 'npm install -g looptroop@latest',
  homebrew: 'brew upgrade looptroop',
  scoop: 'scoop update looptroop',
  chocolatey: 'choco upgrade looptroop',
  container: 'docker pull looptroopai/looptroop:latest',
  source: 'git pull && npm install && npm run build',
  unknown: 'See https://www.looptroop.ovh for upgrade instructions',
}

/**
 * Infers how this copy was installed from where it lives on disk.
 *
 * Telling the user the wrong upgrade command is worse than telling them none,
 * so anything ambiguous resolves to `unknown` rather than guessing npm.
 */
export function detectInstallChannel(moduleDir = dirname(fileURLToPath(import.meta.url))): InstallChannel {
  // Containers set this at build time; nothing else does.
  if (process.env.LOOPTROOP_CONTAINER === '1') return 'container'

  const normalized = moduleDir.split(sep).join('/')

  if (/\/Cellar\/looptroop\/|\/homebrew\//i.test(normalized)) return 'homebrew'
  if (/\/scoop\/apps\/looptroop\//i.test(normalized)) return 'scoop'
  if (/\/ProgramData\/chocolatey\//i.test(normalized)) return 'chocolatey'
  if (/\/node_modules\/looptroop\//.test(normalized)) return 'npm'

  // A checkout has the sources a published package never ships.
  const packageRoot = resolve(moduleDir, '../../..')
  if (existsSync(resolve(packageRoot, 'server')) && existsSync(resolve(packageRoot, '.git'))) {
    return 'source'
  }

  return 'unknown'
}

export function getInstallInfo(moduleDir?: string): InstallInfo {
  const channel = detectInstallChannel(moduleDir)
  return { channel, upgradeCommand: UPGRADE_COMMANDS[channel] }
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
  return typeof value === 'string' && value in UPGRADE_COMMANDS
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

/**
 * The install channel for this copy, detected once and then remembered.
 *
 * Detection reads the filesystem and infers from a path, which is both wasteful
 * to repeat on every command and fragile — a package manager that relocates its
 * files changes the answer. Recording it means the guess is made when the
 * evidence is freshest, stays stable afterwards, and can be corrected by hand.
 */
export function resolveInstallInfo(options: ResolveInstallOptions = {}): InstallInfo {
  const moduleDir = options.moduleDir ?? dirname(fileURLToPath(import.meta.url))
  const recorded = readRecordedInstall(options.configDir)

  // A recorded path that no longer matches means this copy moved, so the old
  // answer describes an installation that is no longer the one running.
  if (recorded && (recorded.path === undefined || recorded.path === moduleDir)) {
    return { channel: recorded.channel, upgradeCommand: UPGRADE_COMMANDS[recorded.channel] }
  }

  const channel = detectInstallChannel(moduleDir)
  // `unknown` is not worth recording: it is precisely the answer a later run —
  // one with LOOPTROOP_CONTAINER set, say — deserves another attempt at.
  if (channel !== 'unknown') {
    try {
      writeSettingsFile({ [INSTALL_SETTINGS_KEY]: { channel, path: moduleDir } }, options.configDir)
    } catch {
      // A read-only install or an unwritable config dir costs one re-detection
      // per command and nothing else, so it must not fail the command itself.
    }
  }

  return { channel, upgradeCommand: UPGRADE_COMMANDS[channel] }
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
