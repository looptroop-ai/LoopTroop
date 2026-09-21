#!/usr/bin/env node
/**
 * Prints the documented install-channel catalog as JSON.
 *
 * The website documentation lives in another repository, while the published
 * smoke here already keeps the canonical list of install methods it exercises.
 * Exposing that table in a machine-readable form lets the website verify its
 * consolidated installation docs against the same source this repository uses
 * to decide which channels exist and what command each one tells users to run.
 */
import { CHANNELS } from './smoke-published.mjs'

function recipeKind(recipe) {
  if (recipe.stub) return 'stub'
  if (recipe.delegate) return 'delegated'
  return 'installed'
}

function upgradeCommands(recipe) {
  if (recipe.stub || recipe.delegate || !recipe.expect) return null
  return {
    linux: recipe.expect.upgradeCommand('linux'),
    darwin: recipe.expect.upgradeCommand('darwin'),
    win32: recipe.expect.upgradeCommand('win32'),
  }
}

function pinnable(recipe) {
  if (recipe.stub) return null
  return recipe.pinnable ?? true
}

/**
 * The queue a channel's publish joins, for the channels that have one.
 *
 * The website tells readers that Chocolatey and WinGet arrive days after the
 * other channels. That sentence is a promise about how this repository
 * publishes, so it belongs in the catalog the website verifies against rather
 * than only in prose either side can edit without the other noticing.
 */
function moderated(recipe) {
  if (!recipe.moderated) return null
  return { queue: recipe.moderated.queue, graceDays: recipe.moderated.graceDays }
}

export function buildInstallCatalogChannel(id, recipe) {
  return {
    id,
    kind: recipeKind(recipe),
    live: !recipe.stub,
    documentedInstall: recipe.documented,
    stubReason: recipe.stub ?? null,
    moderated: moderated(recipe),
    pinnable: pinnable(recipe),
    doctorChannel: recipe.stub || recipe.delegate || !recipe.expect ? null : recipe.expect.channel,
    upgradeCommands: upgradeCommands(recipe),
    legs: recipe.stub ? [] : recipe.legs.map((leg) => ({
      os: leg.os,
      tier: leg.tier,
      opencode: leg.opencode,
    })),
  }
}

export function buildInstallCatalog(channels = CHANNELS) {
  return {
    schemaVersion: 1,
    sourceFile: 'scripts/smoke-published.mjs',
    channels: Object.entries(channels).map(([id, recipe]) => buildInstallCatalogChannel(id, recipe)),
  }
}

if (process.argv[1] && process.argv[1].endsWith('docs-install-catalog.mjs')) {
  process.stdout.write(`${JSON.stringify(buildInstallCatalog(), null, 2)}\n`)
}
