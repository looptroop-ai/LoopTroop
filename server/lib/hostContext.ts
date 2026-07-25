import { existsSync, readFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import type { CommandShellKind, HostContext, HostPlatform } from '../../shared/hostContext'

export interface HostContextDetection {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  pathExists?: (path: string) => boolean
  readTextFile?: (path: string) => string
}

function mapPlatform(value: NodeJS.Platform): HostPlatform {
  if (value === 'win32') return 'windows'
  if (value === 'darwin') return 'macos'
  return 'linux'
}

function executableExists(
  name: string,
  input: Required<Pick<HostContextDetection, 'env' | 'pathExists'>>,
  hostPlatform: HostPlatform,
): boolean {
  const pathValue = input.env.PATH ?? input.env.Path ?? ''
  const extensions = hostPlatform === 'windows'
    ? (input.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  const pathSeparator = hostPlatform === 'windows' ? ';' : ':'
  return pathValue.split(pathSeparator).some((directory) =>
    extensions.some((extension) => input.pathExists(join(directory, `${name}${extension}`))),
  )
}

export function detectHostContext(input: HostContextDetection = {}): HostContext {
  const nodePlatform = input.platform ?? platform()
  const hostPlatform = mapPlatform(nodePlatform)
  const environment = input.env ?? process.env
  const pathExists = input.pathExists ?? existsSync
  const readTextFile = input.readTextFile ?? ((path) => readFileSync(path, 'utf8'))
  let isWsl = false

  if (hostPlatform === 'linux') {
    isWsl = Boolean(environment.WSL_DISTRO_NAME || environment.WSL_INTEROP)
    if (!isWsl && pathExists('/proc/version')) {
      try {
        isWsl = /microsoft|wsl/i.test(readTextFile('/proc/version'))
      } catch {
        // Host context is advisory; an unreadable proc file still describes native Linux.
      }
    }
  }

  const availableShells: CommandShellKind[] = []
  if (hostPlatform === 'windows') {
    if (environment.ComSpec || executableExists('cmd', { env: environment, pathExists }, hostPlatform)) {
      availableShells.push('cmd')
    }
    if (
      executableExists('pwsh', { env: environment, pathExists }, hostPlatform)
      || executableExists('powershell', { env: environment, pathExists }, hostPlatform)
    ) {
      availableShells.push('powershell')
    }
    if (availableShells.length === 0) availableShells.push('cmd')
  } else {
    availableShells.push('posix')
    if (executableExists('pwsh', { env: environment, pathExists }, hostPlatform)) {
      availableShells.push('powershell')
    }
  }

  return {
    platform: hostPlatform,
    environment: isWsl ? 'wsl' : 'native',
    arch: input.arch ?? arch(),
    availableShells,
    preferredShell: hostPlatform === 'windows' && availableShells.includes('powershell')
      ? 'powershell'
      : availableShells[0]!,
  }
}
