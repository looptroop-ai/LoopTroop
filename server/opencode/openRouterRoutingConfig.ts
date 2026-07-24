import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { LOOPTROOP_OPENCODE_ROUTING_CONFIG, isOpenRouterRoutingModel } from '../../shared/openRouterRouting'

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function readConfig(configPath: string): JsonObject {
  if (!existsSync(configPath)) return {}

  try {
    return asObject(JSON.parse(readFileSync(configPath, 'utf8'))) ?? {}
  } catch {
    return {}
  }
}

/**
 * Adds selected OpenRouter routing IDs to the LoopTroop-owned OpenCode config.
 * OpenCode only accepts a routing suffix after that exact model ID is registered.
 */
export function registerOpenRouterRoutingModels(modelIds: readonly string[]): boolean {
  const configPath = process.env[LOOPTROOP_OPENCODE_ROUTING_CONFIG]?.trim()
  if (!configPath) return false

  const routingModels = Array.from(new Set(modelIds.filter(isOpenRouterRoutingModel)))
  if (routingModels.length === 0) return false

  const config = readConfig(configPath)
  const providers = asObject(config.provider) ?? {}
  const openRouter = asObject(providers.openrouter) ?? {}
  const models = asObject(openRouter.models) ?? {}
  let changed = false

  for (const modelId of routingModels) {
    const openRouterModelId = modelId.slice('openrouter/'.length)
    if (!(openRouterModelId in models)) {
      models[openRouterModelId] = {}
      changed = true
    }
  }

  if (!changed) return false

  config.provider = {
    ...providers,
    openrouter: {
      ...openRouter,
      models,
    },
  }
  mkdirSync(dirname(configPath), { recursive: true })
  const temporaryPath = `${configPath}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, configPath)
  return true
}
