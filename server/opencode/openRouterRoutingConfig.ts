import { existsSync, readFileSync } from 'node:fs'
import { LOOPTROOP_OPENCODE_ROUTING_CONFIG, isOpenRouterRoutingModel } from '../../shared/openRouterRouting'
import { safeAtomicWrite } from '../io/atomicWrite'
import { isRecord } from '@shared/typeGuards'

type JsonObject = Record<string, unknown>

function readConfig(configPath: string): JsonObject {
  if (!existsSync(configPath)) return {}

  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    return isRecord(parsed) ? parsed : {}
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
  const providers = isRecord(config.provider) ? config.provider : {}
  const openRouter = isRecord(providers.openrouter) ? providers.openrouter : {}
  const models = isRecord(openRouter.models) ? openRouter.models : {}
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
  // Dirname-relative writing is safe here: trusted startup config fixes this path, not model IDs.
  safeAtomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return true
}
