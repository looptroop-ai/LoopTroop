import { getOpenCodeBaseUrl } from './runtimeConfig'
import type { OpenCodeCatalogModel, OpenCodeCatalogResponse } from '../../shared/opencodeCatalog'
import { isMockOpenCodeMode } from './factory'
import { SDK_OPERATION_TIMEOUT_MS, DEFAULT_CONTEXT_WINDOW_LIMIT } from '../lib/constants'
import { getOpenCodeBasicAuthHeader } from '../../shared/opencodeAuth'

type OpenCodeCatalogProvider = OpenCodeCatalogResponse['all'][number]

function buildMockCatalog(): OpenCodeCatalogResponse {
  return {
    connected: ['openai', 'anthropic', 'google'],
    default: {
      chat: 'openai/codex-mini-latest',
    },
    all: [
      {
        id: 'openai',
        name: 'OpenAI',
        env: [],
        npm: [],
        models: {
          'codex-mini-latest': {
            id: 'codex-mini-latest',
            name: 'Codex Mini Latest',
            status: 'active',
            capabilities: { reasoning: true, toolcall: true, input: { image: false } },
            limit: { context: DEFAULT_CONTEXT_WINDOW_LIMIT },
            cost: { input: 0, output: 0 },
            variants: { low: { reasoningEffort: 'low' }, medium: { reasoningEffort: 'medium' }, high: { reasoningEffort: 'high' } },
          },
          'gpt-5.3-codex': {
            id: 'gpt-5.3-codex',
            name: 'GPT-5.3 Codex',
            status: 'active',
            capabilities: { reasoning: true, toolcall: true, input: { image: false } },
            limit: { context: DEFAULT_CONTEXT_WINDOW_LIMIT },
            cost: { input: 0, output: 0 },
            variants: { low: { reasoningEffort: 'low' }, medium: { reasoningEffort: 'medium' }, high: { reasoningEffort: 'high' }, xhigh: { reasoningEffort: 'xhigh' } },
          },
        },
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        env: [],
        npm: [],
        models: {
          'claude-sonnet-4': {
            id: 'claude-sonnet-4',
            name: 'Claude Sonnet 4',
            status: 'active',
            capabilities: { reasoning: true, toolcall: true, input: { image: false } },
            limit: { context: DEFAULT_CONTEXT_WINDOW_LIMIT },
            cost: { input: 0, output: 0 },
            variants: { high: { thinking: { type: 'enabled', budgetTokens: 16000 } }, max: { thinking: { type: 'enabled', budgetTokens: 31999 } } },
          },
        },
      },
      {
        id: 'google',
        name: 'Google',
        env: [],
        npm: [],
        models: {
          'gemini-2.5-pro': {
            id: 'gemini-2.5-pro',
            name: 'Gemini 2.5 Pro',
            status: 'active',
            capabilities: { reasoning: true, toolcall: true, input: { image: false } },
            limit: { context: DEFAULT_CONTEXT_WINDOW_LIMIT },
            cost: { input: 0, output: 0 },
            variants: { high: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } }, max: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'max' } } },
          },
        },
      },
    ],
  }
}

export async function fetchProviderCatalog(signal?: AbortSignal): Promise<OpenCodeCatalogResponse> {
  if (isMockOpenCodeMode()) {
    return buildMockCatalog()
  }

  let response = await fetchCatalogEndpoint('/provider', {}, signal)
  if (response.status === 404) {
    response = await fetchCatalogEndpoint('/config/providers', {}, signal)
  }
  if (!response.ok) {
    throw new Error(`OpenCode provider catalog request failed with ${response.status}`)
  }

  return normalizeProviderCatalog(await response.json())
}

export function flattenCatalogModels(
  catalog: OpenCodeCatalogResponse,
  scope: 'connected' | 'all' = 'connected',
): OpenCodeCatalogModel[] {
  const connected = new Set(catalog.connected)
  const providers = scope === 'connected'
    ? catalog.all.filter((provider) => connected.has(provider.id))
    : catalog.all

  const models: OpenCodeCatalogModel[] = []
  for (const provider of providers) {
    const providerName = provider.name
    const providerId = provider.id
    const entries = provider.models ? Object.values(provider.models) : []
    for (const model of entries) {
      if ((model.status ?? 'active') !== 'active') continue
      models.push({
        fullId: `${providerId}/${model.id}`,
        id: model.id,
        name: model.name,
        providerID: providerId,
        providerName,
        family: model.family ?? '',
        costInput: model.cost?.input ?? 0,
        costOutput: model.cost?.output ?? 0,
        contextWindow: model.limit?.context ?? 0,
        canReason: model.capabilities?.reasoning ?? false,
        canUseTools: model.capabilities?.toolcall ?? false,
        canSeeImages: model.capabilities?.input?.image ?? false,
        status: model.status ?? 'active',
        ...(model.variants && Object.keys(model.variants).length > 0 ? { variants: model.variants } : {}),
      })
    }
  }

  return models.sort((left, right) =>
    left.providerName.localeCompare(right.providerName) || left.name.localeCompare(right.name),
  )
}

export async function fetchConnectedModelIds(signal?: AbortSignal): Promise<string[]> {
  const catalog = await fetchProviderCatalog(signal)
  return flattenCatalogModels(catalog, 'connected').map((model) => model.fullId)
}

export async function refreshProviderCatalog(): Promise<OpenCodeCatalogResponse> {
  if (!isMockOpenCodeMode()) {
    const response = await fetchCatalogEndpoint('/instance/dispose', { method: 'POST' })
    if (!response.ok) {
      throw new Error(`OpenCode provider catalog refresh failed with ${response.status}`)
    }
  }

  return fetchProviderCatalog()
}

function fetchCatalogEndpoint(path: string, init: RequestInit = {}, signal?: AbortSignal) {
  const authHeader = getOpenCodeBasicAuthHeader()
  return fetch(`${getOpenCodeBaseUrl()}${path}`, {
    ...init,
    // Combined rather than replaced: the operation timeout still applies, and
    // the caller's cancellation now actually reaches the request instead of
    // only abandoning the wait for it.
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(SDK_OPERATION_TIMEOUT_MS)])
      : AbortSignal.timeout(SDK_OPERATION_TIMEOUT_MS),
    ...(authHeader
      ? { headers: { ...Object.fromEntries(new Headers(init.headers).entries()), Authorization: authHeader } }
      : {}),
  })
}

function normalizeProviderCatalog(data: unknown): OpenCodeCatalogResponse {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const all = coerceProviders(record.all)
  if (all.length > 0 || Array.isArray(record.all)) {
    return {
      all,
      connected: Array.isArray(record.connected) ? record.connected.filter((item): item is string => typeof item === 'string') : [],
      default: coerceDefaultModels(record.default),
    }
  }

  const providers = coerceProviders(record.providers)
  return {
    all: providers,
    connected: providers.map((provider) => provider.id),
    default: coerceDefaultModels(record.default),
  }
}

function coerceProviders(value: unknown): OpenCodeCatalogProvider[] {
  if (!Array.isArray(value)) return []

  return value
    .map((provider): OpenCodeCatalogProvider | null => {
      if (!provider || typeof provider !== 'object') return null
      const record = provider as Record<string, unknown>
      if (typeof record.id !== 'string' || typeof record.name !== 'string') return null
      const models = record.models && typeof record.models === 'object' && !Array.isArray(record.models)
        ? record.models as OpenCodeCatalogProvider['models']
        : {}
      return {
        id: record.id,
        name: record.name,
        ...(Array.isArray(record.env)
          ? { env: record.env.filter((item): item is string => typeof item === 'string') }
          : {}),
        ...(Array.isArray(record.npm)
          ? { npm: record.npm.filter((item): item is string => typeof item === 'string') }
          : {}),
        models,
      }
    })
    .filter((provider): provider is OpenCodeCatalogProvider => provider !== null)
}

function coerceDefaultModels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}
