import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const { fetchProviderCatalog, refreshProviderCatalog } = vi.hoisted(() => ({
  fetchProviderCatalog: vi.fn(),
  refreshProviderCatalog: vi.fn(),
}))

vi.mock('../../opencode/providerCatalog', async () => {
  const actual = await vi.importActual<typeof import('../../opencode/providerCatalog')>('../../opencode/providerCatalog')
  return {
    ...actual,
    fetchProviderCatalog,
    refreshProviderCatalog,
  }
})

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({ checkHealth: vi.fn(async () => ({ available: true })) }),
}))

import { modelsRouter } from '../models'

const catalog = {
  connected: ['openai'],
  default: { chat: 'openai/connected' },
  all: [
    {
      id: 'openai',
      name: 'OpenAI',
      models: {
        connected: { id: 'connected', name: 'Connected', status: 'active' as const },
      },
    },
    {
      id: 'google',
      name: 'Google',
      models: {
        optional: { id: 'optional', name: 'Optional', status: 'active' as const },
      },
    },
  ],
}

function createApp() {
  const app = new Hono()
  app.route('/api', modelsRouter)
  return app
}

describe('models routes', () => {
  beforeEach(() => {
    fetchProviderCatalog.mockReset().mockResolvedValue(catalog)
    refreshProviderCatalog.mockReset().mockResolvedValue(catalog)
  })

  it('returns only configured-provider models by default', async () => {
    const response = await createApp().request('/api/models')
    const body = await response.json()

    expect(body.models.map((model: { fullId: string }) => model.fullId)).toEqual(['openai/connected'])
    expect(body).not.toHaveProperty('allModels')
  })

  it('returns the full catalog only when explicitly requested', async () => {
    const response = await createApp().request('/api/models?scope=all')
    const body = await response.json()

    expect(body.models.map((model: { fullId: string }) => model.fullId)).toEqual([
      'google/optional',
      'openai/connected',
    ])
  })

  it('keeps strong refresh limited to configured-provider models', async () => {
    const response = await createApp().request('/api/models/refresh', { method: 'POST' })
    const body = await response.json()

    expect(refreshProviderCatalog).toHaveBeenCalledOnce()
    expect(body.models.map((model: { fullId: string }) => model.fullId)).toEqual(['openai/connected'])
  })

  it('returns a machine-readable retry code when discovery fails after connection', async () => {
    fetchProviderCatalog.mockRejectedValueOnce(new Error('catalog unavailable'))

    const response = await createApp().request('/api/models')
    const body = await response.json()

    expect(body).toMatchObject({
      code: 'OPENCODE_DISCOVERY_FAILED',
      message: 'OpenCode is connected, but model discovery failed.',
    })
  })
})
