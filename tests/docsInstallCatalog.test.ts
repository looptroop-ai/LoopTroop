import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { buildInstallCatalog } from '../scripts/docs-install-catalog.mjs'
import { CHANNELS } from '../scripts/smoke-published.mjs'
import type { ChannelRecipe } from '../scripts/smoke-published.mjs'

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

const expectedCatalog = JSON.parse(
  readFileSync(new URL('./fixtures/install-catalog.json', import.meta.url), 'utf8'),
) as InstallCatalog

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

  it('keeps the fields website verification needs for every emitted channel', () => {
    const catalog = runCatalog()

    expect(catalog).toEqual(expectedCatalog)
  })

  it('pins the catalog decisions independently of the smoke recipe implementation', () => {
    const catalog = runCatalog()

    expect(catalog.channels.find((entry) => entry.id === 'scoop')).toMatchObject({
      documentedInstall: 'scoop bucket add looptroop https://github.com/looptroop-ai/scoop-bucket; scoop install looptroop',
    })
    expect(catalog.channels.find((entry) => entry.id === 'container')).toMatchObject({
      kind: 'delegated',
    })
    // The Windows package managers, which the website documents as live. Both
    // are moderated — a version reaches the feed days after the tag — and that
    // is a note the docs carry, not a reason to publish them as uncovered.
    expect(catalog.channels.find((entry) => entry.id === 'chocolatey')).toMatchObject({
      kind: 'installed',
      live: true,
      documentedInstall: 'choco install looptroop',
      doctorChannel: 'chocolatey',
      upgradeCommands: { win32: 'choco upgrade looptroop' },
    })
    expect(catalog.channels.find((entry) => entry.id === 'winget')).toMatchObject({
      kind: 'installed',
      live: true,
      documentedInstall: 'winget install LoopTroopAI.LoopTroop',
      doctorChannel: 'winget',
      upgradeCommands: { win32: 'winget upgrade LoopTroopAI.LoopTroop' },
    })
    // The AUR is the one channel still waiting on something, and a stub carries
    // no legs and no pinnable answer — the website renders it as unavailable.
    expect(catalog.channels.find((entry) => entry.id === 'aur')).toMatchObject({
      kind: 'stub',
      live: false,
      legs: [],
      pinnable: null,
    })
  })

  it('defaults omitted live pinnable flags to true to match the published smoke driver', () => {
    const previewRecipe: ChannelRecipe = {
      documented: 'preview install',
      legs: [{ os: 'ubuntu-latest', tier: 'weekly', opencode: 'none' }],
      delegate: () => ({
        command: 'node',
        args: ['scripts/smoke-container.mjs'],
        pull: 'docker.io/example/preview:latest',
      }),
    }
    const catalog = buildInstallCatalog({
      preview: previewRecipe,
    }) as InstallCatalog

    expect(catalog.channels[0]).toMatchObject({
      id: 'preview',
      kind: 'delegated',
      live: true,
      documentedInstall: 'preview install',
      stubReason: null,
      pinnable: true,
      doctorChannel: null,
      upgradeCommands: null,
      legs: [{ os: 'ubuntu-latest', tier: 'weekly', opencode: 'none' }],
    })
  })
})
