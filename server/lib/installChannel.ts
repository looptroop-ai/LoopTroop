import { dirname, resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
