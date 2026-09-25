import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getOpenCodeConnection } = vi.hoisted(() => ({ getOpenCodeConnection: vi.fn() }))
vi.mock('../connection', () => ({ getOpenCodeConnection }))

import { fetchProviderCatalog, flattenCatalogModels, refreshProviderCatalog } from '../providerCatalog'

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function locationResponse(data: unknown) {
  return jsonResponse({ location: { directory: '/workspace' }, data })
}

describe('fetchProviderCatalog', () => {
  beforeEach(() => {
    delete process.env.LOOPTROOP_OPENCODE_MODE
    delete process.env.LOOPTROOP_OPENCODE_BASE_URL
    delete process.env.OPENCODE_SERVER_USERNAME
    delete process.env.OPENCODE_SERVER_PASSWORD
    getOpenCodeConnection.mockReset().mockResolvedValue({ protocol: 'v1', version: '1.0.0', headers: {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete process.env.LOOPTROOP_OPENCODE_MODE
    delete process.env.LOOPTROOP_OPENCODE_BASE_URL
    delete process.env.OPENCODE_SERVER_USERNAME
    delete process.env.OPENCODE_SERVER_PASSWORD
    getOpenCodeConnection.mockReset()
  })

  it('includes basic auth when the OpenCode server is protected', async () => {
    getOpenCodeConnection.mockResolvedValue({
      protocol: 'v1',
      version: '1.2.3',
      headers: { Authorization: 'Basic ZGV2LXVzZXI6ZGV2LXNlY3JldA==' },
    })

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        all: [
          {
            id: 'openai',
            name: 'OpenAI',
            models: {
              'gpt-5': {
                id: 'gpt-5',
                name: 'GPT-5',
              },
            },
          },
        ],
        connected: ['openai'],
        default: { openai: 'gpt-5' },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await fetchProviderCatalog()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4096/provider',
      expect.objectContaining({
        headers: { Authorization: 'Basic ZGV2LXVzZXI6ZGV2LXNlY3JldA==' },
        signal: expect.any(AbortSignal),
      }),
    )
    expect(catalog).toEqual({
      all: [
        {
          id: 'openai',
          name: 'OpenAI',
          models: {
            'gpt-5': {
              id: 'gpt-5',
              name: 'GPT-5',
            },
          },
        },
      ],
      connected: ['openai'],
      default: { openai: 'gpt-5' },
      supportsAllModels: true,
    })
  })

  it('trims trailing slashes from the configured base URL', async () => {
    vi.stubEnv('LOOPTROOP_OPENCODE_BASE_URL', 'http://127.0.0.1:4096///')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ all: [], connected: [], default: {} }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchProviderCatalog()

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4096/provider', expect.any(Object))
  })

  it('falls back to /config/providers when the legacy /provider endpoint is unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          providers: [
            {
              id: 'openai',
              name: 'OpenAI',
              models: {
                'gpt-5': {
                  id: 'gpt-5',
                  name: 'GPT-5',
                },
              },
            },
          ],
          default: { openai: 'gpt-5' },
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await fetchProviderCatalog()

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4096/provider',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4096/config/providers',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    )
    expect(catalog).toEqual({
      all: [
        {
          id: 'openai',
          name: 'OpenAI',
          models: {
            'gpt-5': {
              id: 'gpt-5',
              name: 'GPT-5',
            },
          },
        },
      ],
      connected: ['openai'],
      default: { openai: 'gpt-5' },
      supportsAllModels: true,
    })
  })

  it('disposes the catalog instance before fetching newly connected providers', async () => {
    getOpenCodeConnection.mockResolvedValue({
      protocol: 'v1',
      version: '1.2.3',
      headers: { Authorization: 'Basic ZGV2LXVzZXI6ZGV2LXNlY3JldA==' },
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          all: [{ id: 'openai', name: 'OpenAI', models: {} }],
          connected: ['openai'],
          default: {},
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await refreshProviderCatalog()

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4096/instance/dispose',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Basic ZGV2LXVzZXI6ZGV2LXNlY3JldA==' },
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4096/provider',
      expect.any(Object),
    )
    expect(catalog.connected).toEqual(['openai'])
  })

  it('fails without fetching providers when instance disposal fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    vi.stubGlobal('fetch', fetchMock)

    await expect(refreshProviderCatalog()).rejects.toThrow('refresh failed with 500')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('skips instance disposal in mock mode', async () => {
    process.env.LOOPTROOP_OPENCODE_MODE = 'mock'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await refreshProviderCatalog()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(getOpenCodeConnection).not.toHaveBeenCalled()
    expect(catalog.connected).toContain('openai')
  })

  it('normalizes the v2 provider/model/default envelopes and keeps canonical and upstream IDs distinct', async () => {
    getOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.15', headers: { Authorization: 'Bearer test' } })
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/provider') return Promise.resolve(locationResponse([
        { id: 'openai', name: 'OpenAI', activation: 'enabled' },
        { id: 'disabled-provider', name: 'Disabled Provider', activation: 'disabled' },
        { id: 'unspecified-provider', name: 'Unspecified Provider' },
      ]))
      if (path === '/api/model') return Promise.resolve(locationResponse([
        {
          id: 'catalog-model-id',
          modelID: 'upstream-model-id',
          providerID: 'openai',
          name: 'V2 Model',
          family: 'gpt',
          status: 'beta',
          enabled: true,
          compatibility: {},
          capabilities: { tools: true, input: ['text', 'image/png'], output: ['text'] },
          cost: [
            { tier: { type: 'context', size: 200_000 }, input: 1, output: 2, cache: { read: 0.2, write: 0.4 } },
            { tier: { type: 'context', size: 1_000_000 }, input: 3, output: 4 },
          ],
          limit: { context: 1_000_000, output: 64_000 },
          variants: [{ id: 'reasoning-balanced', settings: { reasoningEffort: 'balanced' } }],
        },
        {
          id: 'compatibility-reasoning',
          modelID: 'compatibility-reasoning',
          providerID: 'openai',
          name: 'Compatibility Reasoning',
          enabled: true,
          compatibility: { reasoningField: 'reasoning' },
          capabilities: { tools: false, input: ['text'], output: ['text'] },
          cost: [],
          limit: { context: 8_000, output: 1_000 },
          variants: [],
          status: 'active',
        },
        {
          id: 'disabled-model',
          modelID: 'disabled-model',
          providerID: 'openai',
          name: 'Disabled',
          enabled: false,
          capabilities: { tools: false, input: ['text'], output: ['text'] },
          cost: [],
          limit: { context: 8_000, output: 1_000 },
          variants: [],
          status: 'active',
        },
        {
          id: 'unknown-cost',
          modelID: 'unknown-cost-upstream',
          providerID: 'openai',
          name: 'Unknown Cost',
          enabled: true,
          capabilities: { tools: false, input: ['text'], output: ['text'] },
          limit: { context: 8_000, output: 1_000 },
          variants: [],
          status: 'active',
        },
        {
          id: 'mixed-invalid-cost',
          modelID: 'mixed-invalid-cost-upstream',
          providerID: 'openai',
          name: 'Mixed Invalid Cost',
          enabled: true,
          capabilities: { tools: false, input: ['text'], output: ['text'] },
          cost: [
            { input: 0, output: 0 },
            { input: 0, output: null },
          ],
          limit: { context: 8_000, output: 1_000 },
          variants: [],
          status: 'active',
        },
      ]))
      if (path === '/api/model/default') return Promise.resolve(locationResponse({
        id: 'catalog-model-id', modelID: 'upstream-model-id', providerID: 'openai', name: 'V2 Model',
      }))
      throw new Error(`Unexpected v2 catalog request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await fetchProviderCatalog()
    const models = flattenCatalogModels(catalog)

    expect(fetchMock.mock.calls.map(([input]) => String(input)).sort()).toEqual([
      'http://127.0.0.1:4096/api/model',
      'http://127.0.0.1:4096/api/model/default',
      'http://127.0.0.1:4096/api/provider',
    ])
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ headers: { Authorization: 'Bearer test' }, signal: expect.any(AbortSignal) }))
    expect(catalog.supportsAllModels).toBe(false)
    expect(catalog.all.map((provider) => provider.id)).toEqual(['openai', 'disabled-provider', 'unspecified-provider'])
    expect(catalog.connected).toEqual(['openai', 'unspecified-provider'])
    expect(catalog.default).toEqual({ chat: 'openai/catalog-model-id' })
    expect(models.map((model) => model.fullId)).toEqual([
      'openai/compatibility-reasoning',
      'openai/mixed-invalid-cost',
      'openai/unknown-cost',
      'openai/catalog-model-id',
    ])
    expect(models.find((model) => model.id === 'catalog-model-id')).toMatchObject({
      id: 'catalog-model-id',
      modelID: 'upstream-model-id',
      costInput: null,
      costOutput: null,
      costTiers: [
        { size: 200_000, input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.4 },
        { size: 1_000_000, input: 3, output: 4 },
      ],
      canReason: true,
      canUseTools: true,
      canSeeImages: true,
      inputModalities: ['text', 'image/png'],
      outputModalities: ['text'],
      variants: { 'reasoning-balanced': { id: 'reasoning-balanced', settings: { reasoningEffort: 'balanced' } } },
      status: 'beta',
    })
    expect(models.find((model) => model.id === 'compatibility-reasoning')?.canReason).toBe(true)
    expect(models.find((model) => model.id === 'unknown-cost')).toMatchObject({
      costInput: null,
      costOutput: null,
      canReason: null,
      canUseTools: false,
      canSeeImages: false,
    })
    expect(models.find((model) => model.id === 'mixed-invalid-cost')).toMatchObject({
      costInput: null,
      costOutput: null,
      costTiers: [],
    })
  })

  it.each([
    ['null data', locationResponse(null)],
    ['undefined data omitted by JSON serialization', jsonResponse({ location: { directory: '/workspace' }, data: undefined })],
  ])('accepts an empty v2 model.default response when %s', async (_label, defaultResponse) => {
    getOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.15', headers: {} })
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/provider') return Promise.resolve(locationResponse([]))
      if (path === '/api/model') return Promise.resolve(locationResponse([]))
      if (path === '/api/model/default') return Promise.resolve(defaultResponse)
      throw new Error(`Unexpected v2 catalog request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await fetchProviderCatalog()

    expect(catalog).toEqual({ all: [], connected: [], default: {}, supportsAllModels: false })
  })

  it.each(['/api/provider', '/api/model'])('still rejects a missing v2 %s data envelope', async (malformedPath) => {
    getOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.15', headers: {} })
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === malformedPath) return Promise.resolve(jsonResponse({ location: { directory: '/workspace' } }))
      if (path === '/api/provider') return Promise.resolve(locationResponse([]))
      if (path === '/api/model') return Promise.resolve(locationResponse([]))
      if (path === '/api/model/default') return Promise.resolve(locationResponse(null))
      throw new Error(`Unexpected v2 catalog request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchProviderCatalog()).rejects.toThrow(/unexpected response/)
  })

  it.each(['/api/provider', '/api/model'])('rejects null data in the v2 %s envelope', async (malformedPath) => {
    getOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.15', headers: {} })
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === malformedPath) return Promise.resolve(locationResponse(null))
      if (path === '/api/provider') return Promise.resolve(locationResponse([]))
      if (path === '/api/model') return Promise.resolve(locationResponse([]))
      if (path === '/api/model/default') return Promise.resolve(locationResponse(null))
      throw new Error(`Unexpected v2 catalog request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchProviderCatalog()).rejects.toThrow(/unexpected response/)
  })

  it('reloads the v2 location with an empty POST and refetches the catalog', async () => {
    getOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.15', headers: { Authorization: 'Bearer test' } })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(locationResponse([{ id: 'openai', name: 'OpenAI' }]))
      .mockResolvedValueOnce(locationResponse([]))
      .mockResolvedValueOnce(locationResponse(null))
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await refreshProviderCatalog()

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:4096/api/location/reload', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      signal: expect.any(AbortSignal),
    }))
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('body')
    expect(fetchMock.mock.calls.slice(1).map(([input]) => String(input)).sort()).toEqual([
      'http://127.0.0.1:4096/api/model',
      'http://127.0.0.1:4096/api/model/default',
      'http://127.0.0.1:4096/api/provider',
    ])
    expect(catalog.supportsAllModels).toBe(false)
    expect(getOpenCodeConnection).toHaveBeenCalledOnce()
  })
})
