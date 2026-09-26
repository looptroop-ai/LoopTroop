import { getOpenCodeBaseUrl } from './runtimeConfig'
import type { OpenCodeCatalogModel, OpenCodeCatalogResponse } from '../../shared/opencodeCatalog'
import { isMockOpenCodeMode } from './factory'
import { SDK_OPERATION_TIMEOUT_MS, DEFAULT_CONTEXT_WINDOW_LIMIT } from '../lib/constants'
import { getOpenCodeConnection, type OpenCodeConnection } from './connection'
import { ProviderCatalogBusyError, withProviderCatalogReload as withReloadLease } from './providerCatalogReload'
import { isRecord } from '@shared/typeGuards'

type OpenCodeCatalogProvider = OpenCodeCatalogResponse['all'][number]

function buildMockCatalog(): OpenCodeCatalogResponse {
  return {
    supportsAllModels: true,
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

  const baseUrl = getOpenCodeBaseUrl()
  const connection = await getOpenCodeConnection(baseUrl, signal)
  if (connection.protocol === 'v2') return fetchV2ProviderCatalog(baseUrl, connection.headers, signal)

  let response = await fetchCatalogEndpoint(baseUrl, connection, '/provider', {}, signal)
  if (response.status === 404) {
    response = await fetchCatalogEndpoint(baseUrl, connection, '/config/providers', {}, signal)
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
      if (model.enabled !== true && (model.status ?? 'active') !== 'active') continue
      const inputModalities = model.modalities?.input
      const outputModalities = model.modalities?.output
      models.push({
        fullId: `${providerId}/${model.id}`,
        id: model.id,
        ...(model.modelID ? { modelID: model.modelID } : {}),
        name: model.name,
        providerID: providerId,
        providerName,
        family: model.family ?? '',
        costInput: finiteNumber(model.cost?.input) ? model.cost.input : null,
        costOutput: finiteNumber(model.cost?.output) ? model.cost.output : null,
        ...(model.cost?.tiers ? { costTiers: model.cost.tiers } : {}),
        contextWindow: model.limit?.context ?? 0,
        canReason: booleanOrNull(model.capabilities?.reasoning),
        canUseTools: booleanOrNull(model.capabilities?.toolcall ?? model.capabilities?.tools),
        canSeeImages: imageCapability(model.capabilities?.input?.image, inputModalities),
        ...(inputModalities ? { inputModalities } : {}),
        ...(outputModalities ? { outputModalities } : {}),
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

export async function refreshProviderCatalog(signal?: AbortSignal): Promise<OpenCodeCatalogResponse> {
  if (isMockOpenCodeMode()) return buildMockCatalog()

  return withProviderCatalogReload((_connection, refresh) => refresh(), signal)
}

export async function withProviderCatalogReload<T>(
  operation: (
    connection: OpenCodeConnection,
    refresh: () => Promise<OpenCodeCatalogResponse>,
  ) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const baseUrl = getOpenCodeBaseUrl()
  const connection = await getOpenCodeConnection(baseUrl, signal)
  return withReloadLease(
    () => assertProviderCatalogCanReload(baseUrl, connection, signal),
    () => operation(connection, () => reloadProviderCatalog(baseUrl, connection, signal)),
  )
}

function fetchCatalogEndpoint(
  baseUrl: string,
  connection: OpenCodeConnection,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
) {
  const headers = { ...connection.headers, ...Object.fromEntries(new Headers(init.headers).entries()) }
  while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1)
  return fetch(`${baseUrl}${path}`, {
    ...init,
    // Combined rather than replaced: the operation timeout still applies, and
    // the caller's cancellation now actually reaches the request instead of
    // only abandoning the wait for it.
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(SDK_OPERATION_TIMEOUT_MS)])
      : AbortSignal.timeout(SDK_OPERATION_TIMEOUT_MS),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  })
}

export async function fetchProviderCatalogForV2Server(
  baseUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<OpenCodeCatalogResponse> {
  return fetchV2ProviderCatalog(baseUrl, headers, signal)
}

async function fetchV2ProviderCatalog(
  baseUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<OpenCodeCatalogResponse> {
  const connection: OpenCodeConnection = { protocol: 'v2', version: '', headers }
  const [providersResponse, modelsResponse, defaultResponse] = await Promise.all([
    fetchCatalogEndpoint(baseUrl, connection, '/api/provider', {}, signal),
    fetchCatalogEndpoint(baseUrl, connection, '/api/model', {}, signal),
    fetchCatalogEndpoint(baseUrl, connection, '/api/model/default', {}, signal),
  ])
  const providers = await readLocationData(providersResponse, 'provider catalog')
  const models = await readLocationData(modelsResponse, 'model catalog')
  const defaultModel = await readLocationData(defaultResponse, 'default model', true)
  return normalizeV2ProviderCatalog(providers, models, defaultModel)
}

async function reloadProviderCatalog(
  baseUrl: string,
  connection: OpenCodeConnection,
  signal?: AbortSignal,
): Promise<OpenCodeCatalogResponse> {
  if (connection.protocol === 'v2') {
    const response = await fetchCatalogEndpoint(baseUrl, connection, '/api/location/reload', { method: 'POST' }, signal)
    if (response.status !== 204) {
      throw new Error(`OpenCode provider catalog refresh failed with ${response.status}`)
    }
  } else {
    const response = await fetchCatalogEndpoint(baseUrl, connection, '/instance/dispose', { method: 'POST' }, signal)
    if (!response.ok) {
      throw new Error(`OpenCode provider catalog refresh failed with ${response.status}`)
    }
  }

  return fetchProviderCatalogWithConnection(baseUrl, connection, signal)
}

async function fetchProviderCatalogWithConnection(
  baseUrl: string,
  connection: OpenCodeConnection,
  signal?: AbortSignal,
) {
  if (connection.protocol === 'v2') return fetchV2ProviderCatalog(baseUrl, connection.headers, signal)
  let response = await fetchCatalogEndpoint(baseUrl, connection, '/provider', {}, signal)
  if (response.status === 404) response = await fetchCatalogEndpoint(baseUrl, connection, '/config/providers', {}, signal)
  if (!response.ok) throw new Error(`OpenCode provider catalog request failed with ${response.status}`)
  return normalizeProviderCatalog(await response.json())
}

async function assertProviderCatalogCanReload(
  baseUrl: string,
  connection: OpenCodeConnection,
  signal?: AbortSignal,
): Promise<void> {
  if (connection.protocol !== 'v2') return

  const activeResponse = await fetchCatalogEndpoint(baseUrl, connection, '/api/session/active', {}, signal)
  const activeValue: unknown = await readJsonResponse(activeResponse, 'OpenCode active session list')
  if (!isRecord(activeValue) || !isRecord(activeValue.data)) {
    throw new Error('OpenCode active session list returned an unexpected response')
  }
  if (Object.keys(activeValue.data).length > 0) throw new ProviderCatalogBusyError()

  const sessionIds = await listPersistedActiveSessionIds()
  const pending = await Promise.all(sessionIds.map(async (sessionId) => {
    const [forms, permissions] = await Promise.all([
      listSessionRequests(baseUrl, connection, `/api/session/${encodeURIComponent(sessionId)}/form`, signal),
      listSessionRequests(baseUrl, connection, `/api/session/${encodeURIComponent(sessionId)}/permission`, signal),
    ])
    return forms.length > 0 || permissions.length > 0
  }))
  if (pending.some(Boolean)) throw new ProviderCatalogBusyError()
}

async function listPersistedActiveSessionIds(): Promise<string[]> {
  const [{ listNonTerminalTickets }, { listOpenCodeSessionsForTicket }] = await Promise.all([
    import('../storage/ticketQueries'),
    import('./sessionManager'),
  ])
  return [...new Set(listNonTerminalTickets().flatMap((ticket) =>
    listOpenCodeSessionsForTicket(ticket.id, ['active']).map((session) => session.sessionId),
  ))]
}

async function listSessionRequests(
  baseUrl: string,
  connection: OpenCodeConnection,
  path: string,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const response = await fetchCatalogEndpoint(baseUrl, connection, path, {}, signal)
  if (response.status === 404) return []
  const value: unknown = await readJsonResponse(response, 'OpenCode pending request list')
  const data = isRecord(value) && 'data' in value ? value.data : value
  if (!Array.isArray(data)) throw new Error('OpenCode pending request list returned an unexpected response')
  return data
}

async function readJsonResponse(response: Response, description: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${description} request failed with ${response.status}`)
  try {
    return await response.json()
  } catch (cause) {
    throw new Error(`${description} returned invalid JSON`, { cause })
  }
}

function normalizeProviderCatalog(data: unknown): OpenCodeCatalogResponse {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const all = coerceProviders(record.all)
  if (all.length > 0 || Array.isArray(record.all)) {
    return {
      all,
      connected: Array.isArray(record.connected) ? record.connected.filter((item): item is string => typeof item === 'string') : [],
      default: coerceDefaultModels(record.default),
      supportsAllModels: true,
    }
  }

  const providers = coerceProviders(record.providers)
  return {
    all: providers,
    connected: providers.map((provider) => provider.id),
    default: coerceDefaultModels(record.default),
    supportsAllModels: true,
  }
}

async function readLocationData(response: Response, description: string, allowMissingData = false): Promise<unknown> {
  if (!response.ok) throw new Error(`OpenCode ${description} request failed with ${response.status}`)
  const value: unknown = await response.json()
  if (!isRecord(value) || !('location' in value) || (!allowMissingData && (!('data' in value) || value.data === null))) {
    throw new Error(`OpenCode ${description} request returned an unexpected response`)
  }
  return value.data
}

function normalizeV2ProviderCatalog(providersValue: unknown, modelsValue: unknown, defaultValue: unknown): OpenCodeCatalogResponse {
  const providers = Array.isArray(providersValue)
    ? providersValue.filter(isRecord).filter((provider) => typeof provider.id === 'string' && typeof provider.name === 'string')
    : []
  const availableIds = new Set(providers.map((provider) => provider.id as string))
  const modelsByProvider = new Map<string, OpenCodeCatalogProvider['models']>()

  if (Array.isArray(modelsValue)) {
    for (const value of modelsValue) {
      if (!isRecord(value)
        || value.enabled !== true
        || typeof value.providerID !== 'string'
        || typeof value.id !== 'string'
        || typeof value.modelID !== 'string'
        || typeof value.name !== 'string'
        || !availableIds.has(value.providerID)) continue
      const model = normalizeV2Model(value)
      const models = modelsByProvider.get(value.providerID) ?? {}
      models[model.id] = model
      modelsByProvider.set(value.providerID, models)
    }
  }

  const all = providers.map((provider): OpenCodeCatalogProvider => ({
    id: provider.id as string,
    name: provider.name as string,
    models: modelsByProvider.get(provider.id as string) ?? {},
  }))
  const defaultModel: Record<string, string> = isRecord(defaultValue) && typeof defaultValue.providerID === 'string' && typeof defaultValue.id === 'string'
    ? { chat: `${defaultValue.providerID}/${defaultValue.id}` }
    : {}

  return {
    all,
    connected: providers
      .filter((provider) => provider.activation !== 'disabled')
      .map((provider) => provider.id as string),
    default: defaultModel,
    supportsAllModels: false,
  }
}

type OpenCodeCostTier = NonNullable<NonNullable<OpenCodeCatalogProvider['models'][string]['cost']>['tiers']>[number]

function normalizeV2Model(value: Record<string, unknown>): OpenCodeCatalogProvider['models'][string] {
  const rawCostTiers = Array.isArray(value.cost) ? value.cost : []
  const hasUnusableCostTier = rawCostTiers.some((tier) =>
    !isRecord(tier) || !finiteNumber(tier.input) || !finiteNumber(tier.output),
  )
  const costTiers = hasUnusableCostTier ? [] : rawCostTiers.flatMap((tier): OpenCodeCostTier[] => {
    if (!isRecord(tier) || !finiteNumber(tier.input) || !finiteNumber(tier.output)) return []
    const contextTier = isRecord(tier.tier) && tier.tier.type === 'context' && finiteNumber(tier.tier.size)
      ? { size: tier.tier.size }
      : {}
    const cache = isRecord(tier.cache) ? tier.cache : {}
    return [{
      ...contextTier,
      input: tier.input,
      output: tier.output,
      ...(finiteNumber(cache.read) ? { cacheRead: cache.read } : {}),
      ...(finiteNumber(cache.write) ? { cacheWrite: cache.write } : {}),
    }]
  })
  const inputPrices = new Set(costTiers.map((tier) => tier.input))
  const outputPrices = new Set(costTiers.map((tier) => tier.output))
  const capabilities = isRecord(value.capabilities) ? value.capabilities : null
  const compatibility = isRecord(value.compatibility) ? value.compatibility : null
  const inputModalities = Array.isArray(capabilities?.input) ? stringArray(capabilities.input) : undefined
  const outputModalities = Array.isArray(capabilities?.output) ? stringArray(capabilities.output) : undefined
  const variants = Array.isArray(value.variants)
    ? Object.fromEntries(value.variants.flatMap((variant) =>
        isRecord(variant) && typeof variant.id === 'string' ? [[variant.id, variant]] : [],
      ))
    : {}
  const canReason = typeof compatibility?.reasoningField === 'string'
    || Object.values(variants).some((variant) => isRecord(variant)
      && isRecord(variant.settings)
      && typeof variant.settings.reasoningEffort === 'string'
      && variant.settings.reasoningEffort.length > 0)

  return {
    id: value.id as string,
    modelID: value.modelID as string,
    name: value.name as string,
    ...(typeof value.family === 'string' ? { family: value.family } : {}),
    status: typeof value.status === 'string' ? value.status : 'active',
    enabled: value.enabled === true,
    cost: {
      input: inputPrices.size === 1 ? costTiers[0]?.input ?? null : null,
      output: outputPrices.size === 1 ? costTiers[0]?.output ?? null : null,
      tiers: costTiers,
    },
    limit: { context: isRecord(value.limit) && finiteNumber(value.limit.context) ? value.limit.context : 0 },
    capabilities: {
      reasoning: canReason ? true : null,
      tools: typeof capabilities?.tools === 'boolean' ? capabilities.tools : null,
      input: { image: inputModalities ? inputModalities.some(isImageModality) : null },
    },
    ...(inputModalities || outputModalities
      ? { modalities: { ...(inputModalities ? { input: inputModalities } : {}), ...(outputModalities ? { output: outputModalities } : {}) } }
      : {}),
    variants,
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

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function isImageModality(value: string): boolean {
  return value === 'image' || value === '*/*' || /^image\//i.test(value)
}

function imageCapability(image: unknown, modalities?: readonly string[]): boolean | null {
  if (typeof image === 'boolean') return image
  return modalities ? modalities.some(isImageModality) : null
}
