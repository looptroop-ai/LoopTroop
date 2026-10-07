import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getOpenCodeConnection } = vi.hoisted(() => ({ getOpenCodeConnection: vi.fn() }))
const { listNonTerminalTickets, listOpenCodeSessionsForTicket } = vi.hoisted(() => ({
  listNonTerminalTickets: vi.fn(),
  listOpenCodeSessionsForTicket: vi.fn(),
}))
vi.mock('../connection', () => ({ getOpenCodeConnection }))
vi.mock('../../storage/ticketQueries', () => ({ listNonTerminalTickets }))
vi.mock('../sessionManager', () => ({ listOpenCodeSessionsForTicket }))

import {
  fetchProviderCatalog,
  fetchConnectedModelIds,
  flattenCatalogModels,
  refreshProviderCatalog,
  withProviderCatalogReload,
} from '../providerCatalog'
import { beginOpenCodePromptActivity, ProviderCatalogBusyError } from '../providerCatalogReload'

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function locationResponse(data: unknown) {
  return jsonResponse({ location: { directory: '/workspace' }, data })
}

function mockAbortTimeouts() {
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), delay)
    return controller.signal
  })
}

function delayedResponse(value: unknown, delay: number, signal: AbortSignal, status = 200): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(jsonResponse(value, status)), delay)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

describe('fetchProviderCatalog', () => {
  beforeEach(() => {
    delete process.env.LOOPTROOP_OPENCODE_MODE
    delete process.env.LOOPTROOP_OPENCODE_BASE_URL
    delete process.env.OPENCODE_SERVER_USERNAME
    delete process.env.OPENCODE_SERVER_PASSWORD
    getOpenCodeConnection.mockReset().mockResolvedValue({ protocol: 'v1', version: '1.0.0', headers: {} })
    listNonTerminalTickets.mockReset().mockReturnValue([])
    listOpenCodeSessionsForTicket.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete process.env.LOOPTROOP_OPENCODE_MODE
    delete process.env.LOOPTROOP_OPENCODE_BASE_URL
    delete process.env.OPENCODE_SERVER_USERNAME
    delete process.env.OPENCODE_SERVER_PASSWORD
    getOpenCodeConnection.mockReset()
    listNonTerminalTickets.mockReset()
    listOpenCodeSessionsForTicket.mockReset()
  })

  it('loads connected provider metadata and includes basic auth when the OpenCode server is protected', async () => {
    getOpenCodeConnection.mockResolvedValue({
      protocol: 'v1',
      version: '1.2.3',
      headers: { Authorization: 'Basic ZGV2LXVzZXI6ZGV2LXNlY3JldA==' },
    })

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          models: {
            'gpt-5': {
              id: 'gpt-5',
              name: 'GPT-5',
              family: 'gpt',
              capabilities: { reasoning: true, toolcall: true, input: { image: true } },
              cost: { input: 1, output: 2 },
              limit: { context: 200_000 },
              variants: { high: { reasoningEffort: 'high' } },
            },
          },
        },
      ],
      default: { openai: 'gpt-5' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await fetchProviderCatalog()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4096/config/providers',
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
              family: 'gpt',
              capabilities: { reasoning: true, toolcall: true, input: { image: true } },
              cost: { input: 1, output: 2 },
              limit: { context: 200_000 },
              variants: { high: { reasoningEffort: 'high' } },
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

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4096/config/providers', expect.any(Object))
  })

  it('fetches connected providers for model validation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      providers: [{ id: 'openai', name: 'OpenAI', models: { 'gpt-5': { id: 'gpt-5', name: 'GPT-5' } } }],
      default: {},
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchConnectedModelIds()).resolves.toEqual(['openai/gpt-5'])

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4096/config/providers', expect.any(Object))
  })

  it('fetches the full provider catalog only for all scope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      all: [
        { id: 'openai', name: 'OpenAI', models: {} },
        { id: 'anthropic', name: 'Anthropic', models: {} },
      ],
      connected: ['openai'],
      default: { openai: 'gpt-5' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await fetchProviderCatalog(undefined, 'all')

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4096/provider', expect.any(Object))
    expect(catalog.all.map((provider) => provider.id)).toEqual(['openai', 'anthropic'])
    expect(catalog.connected).toEqual(['openai'])
    expect(catalog.supportsAllModels).toBe(true)
  })

  it.each([404, 500, 503])('does not request the full catalog after a connected catalog %s failure', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, status))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchProviderCatalog()).rejects.toThrow(`request failed with ${status}`)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4096/config/providers', expect.any(Object))
  })

  it.each(['connected', 'all'] as const)('loads a healthy %s provider catalog that takes twenty seconds', async (scope) => {
    vi.useFakeTimers()
    try {
      // Native AbortSignal.timeout does not follow Vitest's clock.
      mockAbortTimeouts()
      vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        setTimeout(() => resolve(jsonResponse({
          all: [{ id: 'openai', name: 'OpenAI', models: { 'gpt-5': { id: 'gpt-5', name: 'GPT-5' } } }],
          connected: ['openai'],
          default: {},
        })), 20_000)
      })))

      const catalog = fetchProviderCatalog(undefined, scope)
      const loaded = expect(catalog).resolves.toMatchObject({ connected: ['openai'] })
      await vi.advanceTimersByTimeAsync(20_000)
      await loaded
      expect(flattenCatalogModels(await catalog).map((model) => model.fullId)).toEqual(['openai/gpt-5'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('still cancels catalog discovery when the caller aborts', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })))
    const controller = new AbortController()
    const reason = new DOMException('Cancelled', 'AbortError')
    const cancelled = expect(fetchProviderCatalog(controller.signal)).rejects.toBe(reason)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())

    controller.abort(reason)

    await cancelled
  })

  it('shares one read deadline across protocol discovery and the all-catalog fallback', async () => {
    vi.useFakeTimers()
    try {
      const timeout = mockAbortTimeouts()
      getOpenCodeConnection.mockImplementation(async (_baseUrl: string, signal: AbortSignal) => {
        await delayedResponse({}, 2_000, signal)
        return { protocol: 'v1', version: '1.0.0', headers: {} }
      })
      const fetchMock = vi.fn((input: RequestInfo | URL, { signal }: { signal: AbortSignal }) => {
        const fullCatalog = new URL(String(input)).pathname === '/provider'
        return delayedResponse({}, fullCatalog ? 18_000 : 8_000, signal, fullCatalog ? 404 : 200)
      })
      vi.stubGlobal('fetch', fetchMock)
      const rejected = expect(fetchProviderCatalog(undefined, 'all')).rejects.toMatchObject({ name: 'TimeoutError' })

      await vi.advanceTimersByTimeAsync(25_000)

      await rejected
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const sharedSignal = getOpenCodeConnection.mock.calls[0]?.[1]
      expect(fetchMock.mock.calls.every(([, init]) => init?.signal === sharedSignal)).toBe(true)
      expect(timeout.mock.calls).toEqual([[25_000]])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['read', fetchProviderCatalog, 25_000],
    ['reload', refreshProviderCatalog, 55_000],
  ] as const)('preserves the %s operation timeout when a connection probe wraps its abort error', async (_operation, fetchCatalog, deadline) => {
    vi.useFakeTimers()
    try {
      mockAbortTimeouts()
      getOpenCodeConnection.mockImplementation((_baseUrl: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Invalid connection JSON', { cause: signal.reason })), { once: true })
      }))
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const rejected = expect(fetchCatalog()).rejects.toMatchObject({ name: 'TimeoutError' })

      await vi.advanceTimersByTimeAsync(deadline)

      await rejected
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to /config/providers for all scope when /provider is unavailable', async () => {
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

    const catalog = await fetchProviderCatalog(undefined, 'all')

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

    const onReloadState = vi.fn()
    const catalog = await refreshProviderCatalog(undefined, onReloadState)

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
      'http://127.0.0.1:4096/config/providers',
      expect.any(Object),
    )
    expect(catalog.connected).toEqual(['openai'])
    expect(onReloadState.mock.calls).toEqual([['unknown'], ['completed']])
  })

  it('fails without fetching providers when instance disposal fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    vi.stubGlobal('fetch', fetchMock)
    const onReloadState = vi.fn()

    await expect(refreshProviderCatalog(undefined, onReloadState)).rejects.toThrow('refresh failed with 500')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onReloadState.mock.calls).toEqual([['unknown']])
  })

  it('does not report a dispatched reload when protocol discovery fails', async () => {
    const reason = new Error('Connection unavailable')
    getOpenCodeConnection.mockRejectedValue(reason)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const onReloadState = vi.fn()

    await expect(refreshProviderCatalog(undefined, onReloadState)).rejects.toBe(reason)

    expect(onReloadState).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not report a dispatched reload when a safety check times out', async () => {
    vi.useFakeTimers()
    try {
      mockAbortTimeouts()
      getOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.16', headers: {} })
      const fetchMock = vi.fn((_input: RequestInfo | URL, { signal }: { signal: AbortSignal }) =>
        delayedResponse({ data: {} }, 6_000, signal),
      )
      vi.stubGlobal('fetch', fetchMock)
      const onReloadState = vi.fn()
      const rejected = expect(refreshProviderCatalog(undefined, onReloadState)).rejects.toMatchObject({ name: 'TimeoutError' })

      await vi.advanceTimersByTimeAsync(5_000)

      await rejected
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(onReloadState).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['v1', 'v2'] as const)('reports unknown when the %s reload POST times out', async (protocol) => {
    vi.useFakeTimers()
    try {
      mockAbortTimeouts()
      getOpenCodeConnection.mockResolvedValue({ protocol, version: '', headers: {} })
      const fetchMock = vi.fn((input: RequestInfo | URL, { signal }: { signal: AbortSignal }) => {
        if (new URL(String(input)).pathname === '/api/session/active') return Promise.resolve(jsonResponse({ data: {} }))
        return delayedResponse({}, 60_000, signal)
      })
      vi.stubGlobal('fetch', fetchMock)
      const onReloadState = vi.fn()
      const rejected = expect(refreshProviderCatalog(undefined, onReloadState)).rejects.toMatchObject({ name: 'TimeoutError' })

      await vi.advanceTimersByTimeAsync(55_000)

      await rejected
      expect(onReloadState.mock.calls).toEqual([['unknown']])
      expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).pathname === '/config/providers')).toBe(false)
      const endPrompt = beginOpenCodePromptActivity()
      endPrompt()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['v1', 'v2'] as const)('reports completed when the catalog fetch fails after the confirmed %s reload', async (protocol) => {
    getOpenCodeConnection.mockResolvedValue({ protocol, version: '', headers: {} })
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/session/active') return Promise.resolve(jsonResponse({ data: {} }))
      if (path === '/api/location/reload') return Promise.resolve(new Response(null, { status: 204 }))
      if (path === '/instance/dispose') return Promise.resolve(jsonResponse({}))
      return Promise.resolve(jsonResponse({}, 503))
    })
    vi.stubGlobal('fetch', fetchMock)
    const onReloadState = vi.fn()

    await expect(refreshProviderCatalog(undefined, onReloadState)).rejects.toThrow('provider catalog request failed with 503')

    expect(onReloadState.mock.calls).toEqual([['unknown'], ['completed']])
  })

  it('allows a cold catalog read lasting thirty-four seconds within the reload budget', async () => {
    vi.useFakeTimers()
    try {
      const timeout = mockAbortTimeouts()
      const fetchMock = vi.fn((input: RequestInfo | URL, { signal }: { signal: AbortSignal }) => {
        const disposing = new URL(String(input)).pathname === '/instance/dispose'
        return delayedResponse({ providers: [], default: {} }, disposing ? 1_000 : 34_000, signal)
      })
      vi.stubGlobal('fetch', fetchMock)
      const loaded = expect(refreshProviderCatalog()).resolves.toMatchObject({ connected: [] })

      await vi.advanceTimersByTimeAsync(35_000)

      await loaded
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(fetchMock.mock.calls[1]?.[1]?.signal)
      expect(timeout.mock.calls).toEqual([[55_000]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('expires the cumulative reload deadline and releases the prompt lease', async () => {
    vi.useFakeTimers()
    try {
      const timeout = mockAbortTimeouts()
      const fetchMock = vi.fn((_input: RequestInfo | URL, { signal }: { signal: AbortSignal }) =>
        delayedResponse({ providers: [], default: {} }, 30_000, signal),
      )
      vi.stubGlobal('fetch', fetchMock)
      const onReloadState = vi.fn()
      const rejected = expect(refreshProviderCatalog(undefined, onReloadState)).rejects.toMatchObject({ name: 'TimeoutError' })

      await vi.advanceTimersByTimeAsync(55_000)

      await rejected
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(timeout.mock.calls).toEqual([[55_000]])
      expect(onReloadState.mock.calls).toEqual([['unknown'], ['completed']])
      const endPrompt = beginOpenCodePromptActivity()
      endPrompt()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a reload response body when the caller disconnects and releases the prompt lease', async () => {
    const bodyRead = vi.fn()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const response = jsonResponse({ providers: [], default: {} })
      if (new URL(String(input)).pathname === '/config/providers') {
        response.json = bodyRead.mockImplementation(() => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }))
      }
      return Promise.resolve(response)
    }))
    const controller = new AbortController()
    const reason = new DOMException('Client disconnected', 'AbortError')
    const cancelled = expect(refreshProviderCatalog(controller.signal)).rejects.toBe(reason)
    await vi.waitFor(() => expect(bodyRead).toHaveBeenCalledOnce())

    controller.abort(reason)

    await cancelled
    const endPrompt = beginOpenCodePromptActivity()
    endPrompt()
  })

  it('rejects reload when a running OpenCode session exists at any location', async () => {
    getOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.16', headers: {} })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { 'external-session': { type: 'running' } } }))
    vi.stubGlobal('fetch', fetchMock)
    const writeConfig = vi.fn().mockResolvedValue('changed')

    await expect(withProviderCatalogReload(() => writeConfig())).rejects.toBeInstanceOf(ProviderCatalogBusyError)

    expect(writeConfig).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4096/api/session/active', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }))
  })

  it('rejects reload for pending forms and permissions in persisted sessions after reconnect', async () => {
    getOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.16', headers: {} })
    listNonTerminalTickets.mockReturnValue([{ id: 'project:ticket' }])
    listOpenCodeSessionsForTicket.mockReturnValue([
      { sessionId: 'session-with-form' },
      { sessionId: 'session-with-permission' },
    ])
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/session/active') return Promise.resolve(jsonResponse({ data: {} }))
      if (path === '/api/session/session-with-form/form') return Promise.resolve(jsonResponse({ data: [{ id: 'form-1' }] }))
      if (path === '/api/session/session-with-form/permission') return Promise.resolve(jsonResponse({ data: [] }))
      if (path === '/api/session/session-with-permission/form') return Promise.resolve(jsonResponse({ data: [] }))
      if (path === '/api/session/session-with-permission/permission') return Promise.resolve(jsonResponse({ data: [{ id: 'permission-1' }] }))
      throw new Error(`Unexpected reload request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const writeConfig = vi.fn().mockResolvedValue('changed')

    await expect(withProviderCatalogReload(() => writeConfig())).rejects.toBeInstanceOf(ProviderCatalogBusyError)

    expect(writeConfig).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).pathname === '/api/location/reload')).toBe(false)
  })

  it('fails closed when it cannot verify whether OpenCode sessions are active', async () => {
    getOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.16', headers: {} })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'unavailable' }, 503))
    vi.stubGlobal('fetch', fetchMock)
    const writeConfig = vi.fn().mockResolvedValue('changed')

    await expect(withProviderCatalogReload(() => writeConfig())).rejects.toThrow(/active session list request failed with 503/)

    expect(writeConfig).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    '/api/session/active',
    '/api/session/session-1/form',
    '/api/session/session-1/permission',
  ])('keeps the five-second safety timeout and preserves body timeout errors for %s', async (pendingPath) => {
    vi.useFakeTimers()
    try {
      mockAbortTimeouts()
      getOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.16', headers: {} })
      listNonTerminalTickets.mockReturnValue([{ id: 'project:ticket' }])
      listOpenCodeSessionsForTicket.mockReturnValue([{ sessionId: 'session-1' }])
      const bodyRead = vi.fn()
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname
        const response = jsonResponse({ data: path === '/api/session/active' ? {} : [] })
        if (path === pendingPath) {
          response.json = bodyRead.mockImplementation(() => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          }))
        }
        return Promise.resolve(response)
      }))
      const writeConfig = vi.fn().mockResolvedValue('changed')
      const rejected = expect(withProviderCatalogReload(() => writeConfig())).rejects.toMatchObject({ name: 'TimeoutError' })

      await vi.advanceTimersByTimeAsync(5_000)

      await rejected
      expect(bodyRead).toHaveBeenCalledOnce()
      expect(writeConfig).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves caller cancellation while reading the safety-check response body', async () => {
    getOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.16', headers: {} })
    const bodyRead = vi.fn()
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const response = jsonResponse({})
      response.json = bodyRead.mockImplementation(() => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }))
      return Promise.resolve(response)
    }))
    const controller = new AbortController()
    const reason = new DOMException('Cancelled', 'AbortError')
    const writeConfig = vi.fn().mockResolvedValue('changed')
    const cancelled = expect(withProviderCatalogReload(() => writeConfig(), controller.signal)).rejects.toBe(reason)
    await vi.waitFor(() => expect(bodyRead).toHaveBeenCalledOnce())

    controller.abort(reason)

    await cancelled
    expect(writeConfig).not.toHaveBeenCalled()
  })

  it('adds the invalid JSON context only for a safety-check syntax error', async () => {
    getOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.16', headers: {} })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{')))
    const writeConfig = vi.fn().mockResolvedValue('changed')

    await expect(withProviderCatalogReload(() => writeConfig())).rejects.toThrow('OpenCode active session list returned invalid JSON')

    expect(writeConfig).not.toHaveBeenCalled()
  })

  it('skips instance disposal in mock mode', async () => {
    process.env.LOOPTROOP_OPENCODE_MODE = 'mock'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const onReloadState = vi.fn()
    const catalog = await refreshProviderCatalog(undefined, onReloadState)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(getOpenCodeConnection).not.toHaveBeenCalled()
    expect(catalog.connected).toContain('openai')
    expect(onReloadState.mock.calls).toEqual([['completed']])
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

  it('cancels sibling v2 HTTP requests and JSON reads after a catalog endpoint fails', async () => {
    getOpenCodeConnection.mockResolvedValue({ protocol: 'v2', version: '2.0.16', headers: {} })
    const bodyRead = vi.fn()
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/provider') return Promise.resolve(jsonResponse({}, 503))
      if (path === '/api/model') {
        const response = locationResponse([])
        response.json = bodyRead.mockImplementation(() => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }))
        return Promise.resolve(response)
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchProviderCatalog()).rejects.toThrow('provider catalog request failed with 503')

    expect(bodyRead).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const sharedSignal = fetchMock.mock.calls[0]?.[1]?.signal
    expect(sharedSignal?.aborted).toBe(true)
    expect(fetchMock.mock.calls.every(([, init]) => init?.signal === sharedSignal)).toBe(true)
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
      .mockResolvedValueOnce(jsonResponse({ data: {} }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(locationResponse([{ id: 'openai', name: 'OpenAI' }]))
      .mockResolvedValueOnce(locationResponse([]))
      .mockResolvedValueOnce(locationResponse(null))
    vi.stubGlobal('fetch', fetchMock)

    const onReloadState = vi.fn()
    const catalog = await refreshProviderCatalog(undefined, onReloadState)

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:4096/api/session/active', expect.objectContaining({
      headers: { Authorization: 'Bearer test' },
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:4096/api/location/reload', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      signal: expect.any(AbortSignal),
    }))
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty('body')
    expect(fetchMock.mock.calls.slice(2).map(([input]) => String(input)).sort()).toEqual([
      'http://127.0.0.1:4096/api/model',
      'http://127.0.0.1:4096/api/model/default',
      'http://127.0.0.1:4096/api/provider',
    ])
    expect(catalog.supportsAllModels).toBe(false)
    expect(getOpenCodeConnection).toHaveBeenCalledOnce()
    expect(onReloadState.mock.calls).toEqual([['unknown'], ['completed']])
  })
})
