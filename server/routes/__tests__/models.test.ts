import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const { fetchProviderCatalog, refreshProviderCatalog, checkHealth } = vi.hoisted(() => ({
  fetchProviderCatalog: vi.fn(),
  refreshProviderCatalog: vi.fn(),
  checkHealth: vi.fn(),
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
  getOpenCodeAdapter: () => ({ checkHealth }),
}))

import { modelsRouter } from '../models'
import { ProviderCatalogBusyError } from '../../opencode/providerCatalogReload'

const catalog = {
  supportsAllModels: true,
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
    checkHealth.mockReset().mockResolvedValue({ available: true })
  })

  it('returns only configured-provider models by default', async () => {
    const response = await createApp().request('/api/models')
    const body = await response.json()

    expect(body.models.map((model: { fullId: string }) => model.fullId)).toEqual(['openai/connected'])
    expect(body.catalogScope).toBe('connected')
    expect(body).not.toHaveProperty('allModels')
  })

  it('returns the full catalog only when explicitly requested', async () => {
    const response = await createApp().request('/api/models?scope=all')
    const body = await response.json()

    expect(body.models.map((model: { fullId: string }) => model.fullId)).toEqual([
      'google/optional',
      'openai/connected',
    ])
    expect(body.catalogScope).toBe('all')
  })

  it('reports the v2 available-only scope when all providers are requested', async () => {
    fetchProviderCatalog.mockResolvedValueOnce({ ...catalog, supportsAllModels: false })

    const response = await createApp().request('/api/models?scope=all')
    const body = await response.json()

    expect(body.catalogScope).toBe('available')
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

  it('returns a manual-retry conflict when catalog reload is unsafe', async () => {
    refreshProviderCatalog.mockRejectedValueOnce(new ProviderCatalogBusyError())

    const response = await createApp().request('/api/models/refresh', { method: 'POST' })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'OPENCODE_BUSY',
      message: expect.stringContaining('then retry'),
    })
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

  it('preserves authentication failures in the model discovery message', async () => {
    vi.stubEnv('OPENCODE_PASSWORD', 'configured')
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', '')
    try {
      checkHealth.mockResolvedValueOnce({ available: false, failureKind: 'authentication', error: 'HTTP 401' })
      fetchProviderCatalog.mockRejectedValueOnce(new Error('unauthorized'))

      const response = await createApp().request('/api/models')
      const body = await response.json()

      expect(body).toMatchObject({
        code: 'OPENCODE_UNREACHABLE',
        message: expect.stringContaining('OpenCode rejected the configured credentials.'),
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('words the failure by what was sent, not by an environment the supervisor fills in itself', async () => {
    // The supervisor writes a generated password into this process's
    // environment before it launches its own server, so the environment says
    // "configured" for a password nobody configured.
    vi.stubEnv('OPENCODE_PASSWORD', 'generated-by-the-supervisor')
    try {
      checkHealth.mockResolvedValueOnce({ available: false, failureKind: 'authentication', error: 'HTTP 401', credentialsSent: false })
      fetchProviderCatalog.mockRejectedValueOnce(new Error('unauthorized'))
      const none = await (await createApp().request('/api/models')).json()
      expect(none.message).toMatch(/^OpenCode requires a password, and none is configured\./)

      vi.stubEnv('OPENCODE_PASSWORD', '')
      checkHealth.mockResolvedValueOnce({ available: false, failureKind: 'authentication', error: 'HTTP 401', credentialsSent: true })
      fetchProviderCatalog.mockRejectedValueOnce(new Error('unauthorized'))
      const rejected = await (await createApp().request('/api/models')).json()
      expect(rejected.message).toMatch(/^OpenCode rejected the configured credentials\./)
      expect(rejected.message).toContain('then run `looptroop restart`.')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('says no password is configured when LoopTroop had none to send', async () => {
    // A hand-started OpenCode v2 makes up its own password; "rejected the
    // configured credentials" pointed at a setting nobody had made.
    vi.stubEnv('OPENCODE_PASSWORD', '')
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', '')
    try {
      checkHealth.mockResolvedValueOnce({ available: false, failureKind: 'authentication', error: 'HTTP 401' })
      fetchProviderCatalog.mockRejectedValueOnce(new Error('unauthorized'))

      const body = await (await createApp().request('/api/models')).json()

      expect(body).toMatchObject({
        code: 'OPENCODE_UNREACHABLE',
        message: expect.stringMatching(/^OpenCode requires a password, and none is configured\. Set OPENCODE_PASSWORD/),
      })
      expect(body.message).not.toContain('rejected')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
