import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
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

function channel(key: string): ChannelRecipe {
  const recipe = CHANNELS[key]
  if (!recipe) throw new Error(`no channel named "${key}"`)
  return recipe
}

function expectedCatalogChannel(id: string, recipe: ChannelRecipe): InstallCatalogChannel {
  return {
    id,
    kind: recipe.stub ? 'stub' : recipe.delegate ? 'delegated' : 'installed',
    live: !recipe.stub,
    documentedInstall: recipe.documented,
    stubReason: recipe.stub ?? null,
    pinnable: recipe.stub ? null : recipe.pinnable ?? true,
    doctorChannel: recipe.stub || recipe.delegate || !recipe.expect ? null : recipe.expect.channel,
    upgradeCommands: recipe.stub || recipe.delegate || !recipe.expect ? null : {
      linux: recipe.expect.upgradeCommand('linux'),
      darwin: recipe.expect.upgradeCommand('darwin'),
      win32: recipe.expect.upgradeCommand('win32'),
    },
    legs: recipe.stub ? [] : (recipe.legs ?? []).map((leg) => ({
      os: leg.os,
      tier: leg.tier,
      opencode: leg.opencode,
    })),
  }
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

  it('keeps the fields website verification needs for every emitted channel', () => {
    const catalog = runCatalog()

    expect(catalog.channels).toEqual(
      Object.entries(CHANNELS).map(([id, recipe]) => expectedCatalogChannel(id, recipe)),
    )
  })

  it('keeps delegated channels delegated in the catalog contract', () => {
    const catalog = runCatalog()

    expect(catalog.channels.find((channel) => channel.id === 'container')).toEqual(
      expectedCatalogChannel('container', channel('container')),
    )
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

    expect(catalog.channels).toEqual([expectedCatalogChannel('preview', previewRecipe)])
    expect(catalog.channels[0]?.pinnable).toBe(true)
  })
})
