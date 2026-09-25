import { existsSync, readFileSync } from 'node:fs'
import { LOOPTROOP_OPENCODE_ROUTING_CONFIG, isOpenRouterRoutingModel } from '../../shared/openRouterRouting'
import { safeAtomicWrite } from '../io/atomicWrite'
import { isRecord } from '@shared/typeGuards'
import type { OpenCodeProtocol } from './connection'

type JsonObject = Record<string, unknown>

export function needsOpenRouterRoutingConfig(modelIds: readonly string[]): boolean {
  return Boolean(process.env[LOOPTROOP_OPENCODE_ROUTING_CONFIG]?.trim())
    && modelIds.some(isOpenRouterRoutingModel)
}

function buildRoutingConfigUpdate(modelIds: readonly string[], protocol: OpenCodeProtocol): { path: string; config: JsonObject } | null {
  const path = process.env[LOOPTROOP_OPENCODE_ROUTING_CONFIG]?.trim()
  if (!path || !needsOpenRouterRoutingConfig(modelIds)) return null

  const routingModels = Array.from(new Set(modelIds.filter(isOpenRouterRoutingModel)))
  if (routingModels.length === 0) return null

  const config = readConfig(path)
  const configKey = protocol === 'v2' && isRecord(config.provider) && !('providers' in config)
    ? 'provider'
    : protocol === 'v2' ? 'providers' : 'provider'
  const providers = isRecord(config[configKey]) ? config[configKey] as JsonObject : {}
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

  if (!changed) return null
  return {
    path,
    config: {
      ...config,
      [configKey]: {
        ...providers,
        openrouter: {
          ...openRouter,
          models,
        },
      },
    },
  }
}

export function openRouterRoutingModelsWouldChangeConfig(modelIds: readonly string[], protocol: OpenCodeProtocol): boolean {
  return buildRoutingConfigUpdate(modelIds, protocol) !== null
}

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
export function registerOpenRouterRoutingModels(modelIds: readonly string[], protocol: OpenCodeProtocol): boolean {
  const update = buildRoutingConfigUpdate(modelIds, protocol)
  if (!update) return false
  // Dirname-relative writing is safe here: trusted startup config fixes this path, not model IDs.
  safeAtomicWrite(update.path, `${JSON.stringify(update.config, null, 2)}\n`)
  return true
}
