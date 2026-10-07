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
    const request = new Request('http://localhost/api/models')
    const response = await createApp().request(request)
    const body = await response.json()

    expect(fetchProviderCatalog).toHaveBeenCalledWith(request.signal, 'connected')
    expect(body.models.map((model: { fullId: string }) => model.fullId)).toEqual(['openai/connected'])
    expect(body.catalogScope).toBe('connected')
    expect(body).not.toHaveProperty('allModels')
  })

  it('returns the full catalog only when explicitly requested', async () => {
    const request = new Request('http://localhost/api/models?scope=all')
    const response = await createApp().request(request)
    const body = await response.json()

    expect(fetchProviderCatalog).toHaveBeenCalledWith(request.signal, 'all')
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
    const request = new Request('http://localhost/api/models/refresh', { method: 'POST' })
    const response = await createApp().request(request)
    const body = await response.json()

    expect(refreshProviderCatalog).toHaveBeenCalledOnce()
    expect(refreshProviderCatalog).toHaveBeenCalledWith(request.signal)
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

    const request = new Request('http://localhost/api/models')
    const response = await createApp().request(request)
    const body = await response.json()

    expect(checkHealth).toHaveBeenCalledWith(request.signal)
    expect(body).toMatchObject({
      code: 'OPENCODE_DISCOVERY_FAILED',
      message: 'OpenCode is connected, but model discovery failed.',
    })
  })

  it.each([
    ['GET', '/api/models', fetchProviderCatalog],
    ['POST', '/api/models/refresh', refreshProviderCatalog],
  ] as const)('reports %s catalog timeouts without another health probe', async (method, path, discover) => {
    discover.mockRejectedValueOnce(new DOMException('catalog deadline elapsed', 'TimeoutError'))

    const response = await createApp().request(path, { method })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      models: [],
      connectedProviders: [],
      defaultModels: {},
      code: 'OPENCODE_DISCOVERY_TIMEOUT',
      message: 'OpenCode model discovery timed out. Try refreshing models.',
    })
    expect(checkHealth).not.toHaveBeenCalled()
  })

  it.each([
    ['GET', '/api/models', fetchProviderCatalog, new Error('catalog unavailable')],
    ['POST', '/api/models/refresh', refreshProviderCatalog, new ProviderCatalogBusyError()],
    ['POST', '/api/models/refresh', refreshProviderCatalog, new DOMException('catalog deadline elapsed', 'TimeoutError')],
  ] as const)('preserves caller cancellation for %s instead of reporting a discovery failure', async (method, path, discover, failure) => {
    const controller = new AbortController()
    const reason = new DOMException('request cancelled', 'AbortError')
    discover.mockImplementationOnce(() => {
      controller.abort(reason)
      return Promise.reject(failure)
    })
    const request = new Request(`http://localhost${path}`, { method, signal: controller.signal })
    const app = createApp()
    const onError = vi.fn()
    app.onError((error, c) => {
      onError(error)
      return c.body(null, 503)
    })

    const response = await app.request(request)

    expect(response.status).toBe(503)
    expect(onError).toHaveBeenCalledWith(reason)
    expect(checkHealth).not.toHaveBeenCalled()
  })

  it('preserves cancellation while diagnostic health is running', async () => {
    const controller = new AbortController()
    const reason = new DOMException('request cancelled', 'AbortError')
    fetchProviderCatalog.mockRejectedValueOnce(new Error('catalog unavailable'))
    checkHealth.mockImplementationOnce(() => {
      controller.abort(reason)
      return Promise.resolve({ available: true })
    })
    const request = new Request('http://localhost/api/models', { signal: controller.signal })
    const app = createApp()
    const onError = vi.fn()
    app.onError((error, c) => {
      onError(error)
      return c.body(null, 503)
    })

    const response = await app.request(request)

    expect(response.status).toBe(503)
    expect(checkHealth).toHaveBeenCalledWith(request.signal)
    expect(onError).toHaveBeenCalledWith(reason)
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
