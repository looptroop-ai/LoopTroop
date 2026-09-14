import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { CHANNELS } from '../scripts/smoke-published.mjs'

interface InstallCatalogChannel {
  id: string
  kind: 'stub' | 'delegated' | 'installed'
  live: boolean
  documentedInstall: string
  stubReason: string | null
  pinnable: boolean | null
  doctorChannel: string | null
  upgradeCommands: {
    linux: string
    darwin: string
    win32: string
  } | null
  legs: Array<{
    os: string
    tier: string
    opencode: string
  }>
}

interface InstallCatalog {
  schemaVersion: number
  sourceFile: string
  channels: InstallCatalogChannel[]
}

describe('docs install catalog', () => {
  function runCatalog(): InstallCatalog {
    const result = spawnSync(process.execPath, ['scripts/docs-install-catalog.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    return JSON.parse(result.stdout) as InstallCatalog
  }

  it('prints valid JSON for every documented install channel', () => {
    const catalog = runCatalog()

    expect(catalog.schemaVersion).toBe(1)
    expect(catalog.sourceFile).toBe('scripts/smoke-published.mjs')
    expect(catalog.channels.map((channel) => channel.id)).toEqual(Object.keys(CHANNELS))
  })

  it('keeps the fields website verification needs for live and planned channels', () => {
    const catalog = runCatalog()

    expect(catalog.channels.find((channel) => channel.id === 'npm')).toEqual({
      id: 'npm',
      kind: 'installed',
      live: true,
      documentedInstall: 'npm install -g looptroop',
      stubReason: null,
      pinnable: true,
      doctorChannel: 'npm',
      upgradeCommands: {
        linux: 'npm install -g looptroop@latest',
        darwin: 'npm install -g looptroop@latest',
        win32: 'npm install -g looptroop@latest',
      },
      legs: [
        { os: 'ubuntu-latest', tier: 'release', opencode: 'npm' },
        { os: 'macos-latest', tier: 'release', opencode: 'npm' },
        { os: 'windows-latest', tier: 'release', opencode: 'npm' },
      ],
    })

    expect(catalog.channels.find((channel) => channel.id === 'scoop')?.documentedInstall).toBe(
      'scoop bucket add looptroop https://github.com/looptroop-ai/scoop-bucket; scoop install looptroop',
    )

    expect(catalog.channels.find((channel) => channel.id === 'winget')).toEqual({
      id: 'winget',
      kind: 'stub',
      live: false,
      documentedInstall: 'winget install LoopTroopAI.LoopTroop',
      stubReason: 'the WinGet manifest has not been merged and indexed',
      pinnable: null,
      doctorChannel: null,
      upgradeCommands: null,
      legs: [],
    })
  })
})
