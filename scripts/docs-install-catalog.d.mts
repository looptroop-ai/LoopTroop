/**
 * Types for `docs-install-catalog.mjs`, which exposes the published-smoke
 * install table as deterministic JSON for cross-repository documentation checks.
 */
import type { ChannelLeg, ChannelRecipe } from './smoke-published.mjs'

export interface InstallCatalogChannel {
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
  legs: ChannelLeg[]
}

export interface InstallCatalog {
  schemaVersion: 1
  sourceFile: 'scripts/smoke-published.mjs'
  channels: InstallCatalogChannel[]
}

export function buildInstallCatalogChannel(id: string, recipe: ChannelRecipe): InstallCatalogChannel

export function buildInstallCatalog(channels?: Record<string, ChannelRecipe>): InstallCatalog
