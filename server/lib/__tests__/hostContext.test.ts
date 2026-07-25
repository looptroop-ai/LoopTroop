import { describe, expect, it } from 'vitest'
import { detectHostContext } from '../hostContext'

describe('detectHostContext', () => {
  it('treats WSL as a Linux host with a POSIX shell', () => {
    expect(detectHostContext({
      platform: 'linux',
      arch: 'x64',
      env: { WSL_DISTRO_NAME: 'Ubuntu', PATH: '' },
      pathExists: () => false,
    })).toEqual({
      platform: 'linux',
      environment: 'wsl',
      arch: 'x64',
      availableShells: ['posix'],
      preferredShell: 'posix',
    })
  })

  it('uses PowerShell as the preferred shell when it is available on Windows', () => {
    const context = detectHostContext({
      platform: 'win32',
      arch: 'arm64',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: 'C:\\tools' },
      pathExists: (path) => path.toLowerCase().endsWith('pwsh.exe'),
    })

    expect(context).toEqual({
      platform: 'windows',
      environment: 'native',
      arch: 'arm64',
      availableShells: ['cmd', 'powershell'],
      preferredShell: 'powershell',
    })
  })

  it('detects Microsoft from proc when WSL variables are absent', () => {
    expect(detectHostContext({
      platform: 'linux',
      env: { PATH: '' },
      pathExists: (path) => path === '/proc/version',
      readTextFile: () => 'Linux version 6.6.87.2-microsoft-standard-WSL2',
    }).environment).toBe('wsl')
  })
})
