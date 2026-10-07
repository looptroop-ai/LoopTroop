import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { createTestQueryClient } from '@/test/renderHelpers'
import { MODEL_FETCH_RETRY_COUNT, MODEL_FETCH_RETRY_DELAY_MS, MODEL_FETCH_TIMEOUT_MS, MODEL_REFRESH_TIMEOUT_MS } from '@/lib/constants'
import {
  ALL_OPENCODE_MODELS_QUERY_KEY,
  clearOpenCodeModelsQuery,
  fetchAllModelsApi,
  fetchModelsApi,
  OPENCODE_MODELS_QUERY_KEY,
  refreshOpenCodeModelsQuery,
  useOpenCodeModelCatalog,
  useAllOpenCodeModels,
  useOpenCodeModels,
} from '../useOpenCodeModels'

function Probe() {
  useOpenCodeModels()
  useAllOpenCodeModels()
  return createElement('div')
}

function queryWrapper(queryClient: ReturnType<typeof createTestQueryClient>) {
  return ({ children }: { children: ReactNode }) => createElement(
    QueryClientProvider,
    { client: queryClient },
    children,
  )
}

describe('useOpenCodeModels', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [{ fullId: 'openai/gpt-5.3-codex' }],
        connectedProviders: ['openai'],
        defaultModels: {},
        catalogScope: 'connected',
      }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches connected models without requesting the full catalog', async () => {
    const queryClient = createTestQueryClient()

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Probe),
      ),
    )

    await waitFor(() => {
      expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toEqual({
        models: [{ fullId: 'openai/gpt-5.3-codex' }],
        connectedProviders: ['openai'],
        defaultModels: {},
        catalogScope: 'connected',
      })
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/api/models', { method: 'GET', signal: expect.any(AbortSignal) })
    expect(queryClient.getQueryData(ALL_OPENCODE_MODELS_QUERY_KEY)).toBeUndefined()
  })

  it('requests the full catalog from its separate endpoint scope', async () => {
    await fetchAllModelsApi()

    expect(fetch).toHaveBeenCalledWith('/api/models?scope=all', {
      method: 'GET',
      signal: expect.any(AbortSignal),
    })
  })

  it('exposes the available-only scope from the catalog response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [{ fullId: 'openai/gpt-5.3-codex' }],
        connectedProviders: ['openai'],
        defaultModels: {},
        catalogScope: 'available',
      }),
    }))
    const queryClient = createTestQueryClient()
    const { result } = renderHook(() => useOpenCodeModelCatalog(), { wrapper: queryWrapper(queryClient) })

    await waitFor(() => expect(result.current.data?.catalogScope).toBe('available'))
  })

  it('treats a response with a message field as an error (opencode not ready)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [],
        connectedProviders: [],
        defaultModels: {},
        code: 'OPENCODE_UNREACHABLE',
        message: 'OpenCode server is not reachable. Restart LoopTroop (`looptroop restart`) so it starts OpenCode again, or check the OpenCode URL setting.',
      }),
    }))

    await expect(fetchModelsApi()).rejects.toThrow(/not reachable/i)
  })

  it.each(['not_started', 'unknown', 'completed'] as const)('preserves the backend reload state %s on a coded error', async (reloadState) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [],
        code: 'OPENCODE_DISCOVERY_FAILED',
        message: 'OpenCode model discovery failed.',
        reloadState,
      }),
    }))

    await expect(fetchModelsApi()).rejects.toMatchObject({
      name: 'OpenCodeModelsError',
      code: 'OPENCODE_DISCOVERY_FAILED',
      reloadState,
    })
  })

  it('retries the explicit OpenCode startup response and succeeds when it comes up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            models: [],
            connectedProviders: [],
            defaultModels: {},
            code: 'OPENCODE_UNREACHABLE',
            message: 'OpenCode server is not reachable. Restart LoopTroop (`looptroop restart`) so it starts OpenCode again, or check the OpenCode URL setting.',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            models: [{ fullId: 'openai/gpt-5.3-codex' }],
            connectedProviders: ['openai'],
            defaultModels: {},
          }),
        })
      vi.stubGlobal('fetch', fetchMock)

      const queryClient = createTestQueryClient()
      renderHook(() => useOpenCodeModels(), { wrapper: queryWrapper(queryClient) })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MODEL_FETCH_RETRY_DELAY_MS)
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/models')
      vi.useRealTimers()
      await waitFor(() => expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toEqual(expect.objectContaining({
        models: [{ fullId: 'openai/gpt-5.3-codex' }],
      })))
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry an HTTP 500 model failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'temporary model failure' }), { status: 500 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = createTestQueryClient()
    const { result } = renderHook(() => useOpenCodeModels(), { wrapper: queryWrapper(queryClient) })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  describe('model request deadline', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      // Native AbortSignal.timeout does not use Vitest's fake timers.
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
        const controller = new AbortController()
        setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), delay)
        return controller.signal
      })
    })

    afterEach(() => {
      vi.restoreAllMocks()
      vi.useRealTimers()
    })

    it('allows model responses that take longer than five seconds', async () => {
      vi.stubGlobal('fetch', vi.fn((_path, { signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => {
        setTimeout(() => resolve({ ok: true, json: () => Promise.resolve({ models: [{ fullId: 'openai/slow-model' }] }) }), 7_000)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })))
      const response = expect(fetchModelsApi()).resolves.toMatchObject({ models: [{ fullId: 'openai/slow-model' }] })

      await vi.advanceTimersByTimeAsync(7_000)

      await response
      expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000)
    })

    it.each([
      ['fetch', 'reason'],
      ['fetch', 'AbortError'],
      ['fetch', 'TimeoutError'],
      ['json', 'AbortError'],
      ['json', 'TimeoutError'],
    ])('normalizes its own timeout during %s with %s', async (stage, errorName) => {
      vi.stubGlobal('fetch', vi.fn((_path, { signal }: { signal: AbortSignal }) => {
        const pending = new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(errorName === 'reason'
            ? signal.reason
            : new DOMException('The operation was aborted.', errorName)), { once: true })
        })
        return stage === 'fetch' ? pending : Promise.resolve({ ok: true, json: () => pending })
      }))
      const request = fetchAllModelsApi().catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(MODEL_FETCH_TIMEOUT_MS)

      expect(await request).toMatchObject({
        name: 'OpenCodeModelsError',
        code: 'OPENCODE_DISCOVERY_TIMEOUT',
        message: 'OpenCode model discovery timed out. Try refreshing models.',
      })
    })

    it('preserves HTTP 500 when reading the error body times out', async () => {
      vi.stubGlobal('fetch', vi.fn((_path, { signal }: { signal: AbortSignal }) => Promise.resolve({
        ok: false,
        status: 500,
        text: () => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true })
        }),
      })))
      const rejection = expect(fetchModelsApi()).rejects.toMatchObject({
        name: 'Error',
        message: 'Failed to fetch models (HTTP 500)',
      })

      await vi.advanceTimersByTimeAsync(MODEL_FETCH_TIMEOUT_MS)

      await rejection
    })

    it('retries a timed-out model request and loads the next response', async () => {
      const fetchMock = vi.fn()
        .mockImplementationOnce((_path, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }))
        .mockResolvedValue({ ok: true, json: () => Promise.resolve({ models: [{ fullId: 'openai/recovered-model' }] }) })
      vi.stubGlobal('fetch', fetchMock)
      const queryClient = createTestQueryClient()
      renderHook(() => useOpenCodeModels(), { wrapper: queryWrapper(queryClient) })

      await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_FETCH_TIMEOUT_MS) })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_FETCH_RETRY_DELAY_MS) })

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toEqual({
        models: [{ fullId: 'openai/recovered-model' }],
      })
    })

    it.each([false, true])('preserves caller cancellation when its own deadline also expires: %s', async (expireDeadline) => {
      const controller = new AbortController()
      const cancellation = new DOMException('Caller cancelled', 'AbortError')
      vi.stubGlobal('fetch', vi.fn((_path, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })))
      const rejection = expect(fetchModelsApi(controller.signal)).rejects.toBe(cancellation)

      controller.abort(cancellation)
      // Expire the deadline before the request's catch runs, so both are aborted.
      if (expireDeadline) vi.advanceTimersByTime(MODEL_FETCH_TIMEOUT_MS)

      await rejection
    })

    it('preserves its own timeout when caller cancellation follows before the catch runs', async () => {
      const controller = new AbortController()
      vi.stubGlobal('fetch', vi.fn((_path, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Request timed out', 'TimeoutError')), { once: true })
      })))
      const rejection = expect(fetchModelsApi(controller.signal)).rejects.toMatchObject({
        code: 'OPENCODE_DISCOVERY_TIMEOUT',
      })

      vi.advanceTimersByTime(MODEL_FETCH_TIMEOUT_MS)
      controller.abort(new DOMException('Caller cancelled', 'AbortError'))

      await rejection
    })

    it.each(['browser', 'server'])('retries a %s timeout only once', async (source) => {
      const fetchMock = source === 'browser'
        ? vi.fn((_path, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }))
        : vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({
            models: [],
            code: 'OPENCODE_DISCOVERY_TIMEOUT',
            message: 'Provider catalog deadline expired.',
          }),
        })
      vi.stubGlobal('fetch', fetchMock)
      const queryClient = createTestQueryClient()
      renderHook(() => useOpenCodeModels(), { wrapper: queryWrapper(queryClient) })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * MODEL_FETCH_TIMEOUT_MS + MODEL_FETCH_RETRY_DELAY_MS)
      })

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(OPENCODE_MODELS_QUERY_KEY)?.error).toMatchObject({
        code: 'OPENCODE_DISCOVERY_TIMEOUT',
      })
    })

    it.each(['OPENCODE_UNREACHABLE', 'OPENCODE_DISCOVERY_FAILED'])('keeps eight retries for quick %s startup failures', async (code) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [], code, message: 'OpenCode is still starting.' }),
      })
      vi.stubGlobal('fetch', fetchMock)
      const queryClient = createTestQueryClient()
      renderHook(() => useOpenCodeModels(), { wrapper: queryWrapper(queryClient) })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MODEL_FETCH_RETRY_COUNT * MODEL_FETCH_RETRY_DELAY_MS)
      })

      expect(fetchMock).toHaveBeenCalledTimes(MODEL_FETCH_RETRY_COUNT + 1)
      expect(queryClient.getQueryState(OPENCODE_MODELS_QUERY_KEY)?.status).toBe('error')
    })

    it.each(['success', 'timeout'])('retries the first timeout after a quick startup failure, ending with %s', async (outcome) => {
      const timeout = {
        ok: true,
        json: () => Promise.resolve({
          models: [],
          code: 'OPENCODE_DISCOVERY_TIMEOUT',
          message: 'Provider catalog deadline expired.',
        }),
      }
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ models: [], code: 'OPENCODE_UNREACHABLE', message: 'OpenCode is still starting.' }),
        })
        .mockResolvedValueOnce(timeout)
        .mockResolvedValue(outcome === 'timeout' ? timeout : {
          ok: true,
          json: () => Promise.resolve({ models: [{ fullId: 'openai/recovered-model' }] }),
        })
      vi.stubGlobal('fetch', fetchMock)
      const queryClient = createTestQueryClient()
      const { rerender } = renderHook(() => useOpenCodeModels(), { wrapper: queryWrapper(queryClient) })

      await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_FETCH_RETRY_DELAY_MS) })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      // Updated observer options must not reset the active fetch's retry budget.
      rerender()
      await act(async () => { await vi.advanceTimersByTimeAsync(2 * MODEL_FETCH_RETRY_DELAY_MS) })

      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(queryClient.getQueryState(OPENCODE_MODELS_QUERY_KEY)?.status).toBe(outcome === 'timeout' ? 'error' : 'success')
    })

    it('keeps timeout retry budgets separate for each scope and resets them for new loads', async () => {
      const attempts = new Map<string, number>()
      const fetchMock = vi.fn((path: string) => {
        const attempt = (attempts.get(path) ?? 0) + 1
        attempts.set(path, attempt)
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(attempt % 2 === 1
            ? { models: [], code: 'OPENCODE_DISCOVERY_TIMEOUT', message: 'Provider catalog deadline expired.' }
            : { models: [{ fullId: 'openai/recovered-model' }] }),
        })
      })
      vi.stubGlobal('fetch', fetchMock)
      const queryClient = createTestQueryClient()
      renderHook(() => {
        useOpenCodeModels()
        useAllOpenCodeModels(true)
      }, { wrapper: queryWrapper(queryClient) })

      await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_FETCH_RETRY_DELAY_MS) })
      expect(attempts.get('/api/models')).toBe(2)
      expect(attempts.get('/api/models?scope=all')).toBe(2)

      const reload = queryClient.refetchQueries({ queryKey: ['opencode-models'] })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MODEL_FETCH_RETRY_DELAY_MS)
        await reload
      })

      expect(attempts.get('/api/models')).toBe(4)
      expect(attempts.get('/api/models?scope=all')).toBe(4)
      expect(queryClient.getQueryState(OPENCODE_MODELS_QUERY_KEY)?.status).toBe('success')
      expect(queryClient.getQueryState(ALL_OPENCODE_MODELS_QUERY_KEY)?.status).toBe('success')
    })

    it('allows a healthy provider reload to take longer than thirty seconds', async () => {
      vi.stubGlobal('fetch', vi.fn((_path, { signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => {
        setTimeout(() => resolve({ ok: true, json: () => Promise.resolve({ models: [{ fullId: 'openai/reloaded-model' }] }) }), 34_000)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })))
      const response = expect(refreshOpenCodeModelsQuery(createTestQueryClient())).resolves.toMatchObject({
        models: [{ fullId: 'openai/reloaded-model' }],
      })

      await vi.advanceTimersByTimeAsync(34_000)

      await response
      expect(AbortSignal.timeout).toHaveBeenCalledWith(MODEL_REFRESH_TIMEOUT_MS)
    })

    it('recovers a timed-out reload with a read without claiming that the reload completed', async () => {
      const fetchMock = vi.fn()
        .mockImplementationOnce((_path, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }))
        .mockResolvedValue({ ok: true, json: () => Promise.resolve({ models: [{ fullId: 'openai/recovered-model' }] }) })
      vi.stubGlobal('fetch', fetchMock)
      const queryClient = createTestQueryClient()
      const response = expect(refreshOpenCodeModelsQuery(queryClient)).rejects.toMatchObject({
        code: 'OPENCODE_DISCOVERY_TIMEOUT',
        message: 'OpenCode model discovery timed out. Try refreshing models.',
      })

      await vi.advanceTimersByTimeAsync(MODEL_REFRESH_TIMEOUT_MS)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(MODEL_FETCH_RETRY_DELAY_MS)

      await response
      expect(fetchMock.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
        ['/api/models/refresh', 'POST'],
        ['/api/models', 'GET'],
      ])
      expect(AbortSignal.timeout).toHaveBeenNthCalledWith(1, MODEL_REFRESH_TIMEOUT_MS)
      expect(AbortSignal.timeout).toHaveBeenNthCalledWith(2, MODEL_FETCH_TIMEOUT_MS)
      expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toMatchObject({
        models: [{ fullId: 'openai/recovered-model' }],
      })
    })

    it.each([
      ['not_started', 'OPENCODE_DISCOVERY_FAILED', 'POST', true],
      ['not_started', 'OPENCODE_DISCOVERY_TIMEOUT', 'POST', true],
      ['completed', 'OPENCODE_DISCOVERY_FAILED', 'GET', true],
      ['completed', 'OPENCODE_DISCOVERY_TIMEOUT', 'GET', true],
      ['unknown', 'OPENCODE_DISCOVERY_FAILED', undefined, false],
      ['unknown', 'OPENCODE_DISCOVERY_TIMEOUT', 'GET', false],
    ] as const)('retries %s %s using %s and reports confirmed success %s', async (reloadState, code, nextMethod, succeeds) => {
      const message = 'OpenCode provider reload failed.'
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ models: [], reloadState, code, message }),
        })
        .mockResolvedValue({ ok: true, json: () => Promise.resolve({ models: [{ fullId: 'openai/recovered-model' }] }) })
      vi.stubGlobal('fetch', fetchMock)
      const queryClient = createTestQueryClient()
      const cachedModels = { models: [{ fullId: 'openai/old-model' }] }
      queryClient.setQueryData(OPENCODE_MODELS_QUERY_KEY, cachedModels)
      const refresh = refreshOpenCodeModelsQuery(queryClient)
      const outcome = succeeds
        ? expect(refresh).resolves.toMatchObject({ models: [{ fullId: 'openai/recovered-model' }] })
        : expect(refresh).rejects.toMatchObject({ code, message, reloadState })

      await vi.advanceTimersByTimeAsync(2 * MODEL_FETCH_RETRY_DELAY_MS)

      await outcome
      expect(fetchMock.mock.calls.map(([path, options]) => [path, options.method])).toEqual(nextMethod
        ? [['/api/models/refresh', 'POST'], [nextMethod === 'POST' ? '/api/models/refresh' : '/api/models', nextMethod]]
        : [['/api/models/refresh', 'POST']])
      expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toEqual(nextMethod
        ? { models: [{ fullId: 'openai/recovered-model' }] }
        : cachedModels)
      expect(queryClient.getQueryState(['opencode-models', 'refresh'])).toBeUndefined()
    })

    it.each([
      ['not_started', 'OPENCODE_UNREACHABLE', 'POST', true],
      ['completed', 'OPENCODE_DISCOVERY_FAILED', 'GET', true],
      ['unknown', 'OPENCODE_DISCOVERY_TIMEOUT', 'GET', false],
    ] as const)('keeps the %s reload retry intact when its connected-model observer rerenders', async (reloadState, code, nextMethod, succeeds) => {
      const cachedModels = { models: [{ fullId: 'openai/old-model' }] }
      const recoveredModels = { models: [{ fullId: 'openai/recovered-model' }] }
      const message = 'The provider reload failed.'
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ models: [], reloadState, code, message }),
        })
        .mockResolvedValue({ ok: true, json: () => Promise.resolve(recoveredModels) })
      vi.stubGlobal('fetch', fetchMock)
      const queryClient = createTestQueryClient()
      queryClient.setQueryData(OPENCODE_MODELS_QUERY_KEY, cachedModels)
      const { result, rerender } = renderHook(() => useOpenCodeModels(), { wrapper: queryWrapper(queryClient) })
      const refresh = refreshOpenCodeModelsQuery(queryClient)
      const outcome = succeeds
        ? expect(refresh).resolves.toEqual(recoveredModels)
        : expect(refresh).rejects.toMatchObject({ code, message, reloadState })

      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      rerender()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MODEL_FETCH_RETRY_DELAY_MS)
        await outcome
        await vi.advanceTimersByTimeAsync(1)
      })

      expect(fetchMock.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
        ['/api/models/refresh', 'POST'],
        [nextMethod === 'POST' ? '/api/models/refresh' : '/api/models', nextMethod],
      ])
      expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toEqual(recoveredModels)
      expect(result.current.data).toEqual(recoveredModels.models)
    })

    it('retries an unconfirmed timeout once after safe startup reload retries', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            models: [],
            reloadState: 'not_started',
            code: 'OPENCODE_UNREACHABLE',
            message: 'OpenCode is still starting.',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            models: [],
            reloadState: 'unknown',
            code: 'OPENCODE_DISCOVERY_TIMEOUT',
            message: 'The reload deadline expired.',
          }),
        })
        .mockResolvedValue({ ok: true, json: () => Promise.resolve({ models: [{ fullId: 'openai/recovered-model' }] }) })
      vi.stubGlobal('fetch', fetchMock)
      const queryClient = createTestQueryClient()
      const outcome = expect(refreshOpenCodeModelsQuery(queryClient)).rejects.toMatchObject({
        code: 'OPENCODE_DISCOVERY_TIMEOUT',
        message: 'The reload deadline expired.',
      })

      await vi.advanceTimersByTimeAsync(2 * MODEL_FETCH_RETRY_DELAY_MS)

      await outcome
      expect(fetchMock.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
        ['/api/models/refresh', 'POST'],
        ['/api/models/refresh', 'POST'],
        ['/api/models', 'GET'],
      ])
    })

    it.each(['OPENCODE_DISCOVERY_FAILED', 'OPENCODE_DISCOVERY_TIMEOUT'])('stops after the single unconfirmed recovery read fails with %s', async (code) => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            models: [],
            reloadState: 'unknown',
            code: 'OPENCODE_DISCOVERY_TIMEOUT',
            message: 'The reload deadline expired.',
          }),
        })
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ models: [], code, message: 'Recovery read failed.' }),
        })
      vi.stubGlobal('fetch', fetchMock)
      const outcome = expect(refreshOpenCodeModelsQuery(createTestQueryClient())).rejects.toMatchObject({
        code,
        message: 'Recovery read failed.',
      })

      await vi.advanceTimersByTimeAsync(2 * MODEL_FETCH_RETRY_DELAY_MS)

      await outcome
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('does not repeat a failed provider reload when the dashboard refetches every query', async () => {
      const cachedModels = { models: [{ fullId: 'openai/old-model' }] }
      let postAttempts = 0
      const fetchMock = vi.fn((_path, { method }: { method: string }) => {
        const fails = method === 'POST' && ++postAttempts <= MODEL_FETCH_RETRY_COUNT + 1
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(fails
            ? { models: [], reloadState: 'not_started', code: 'OPENCODE_DISCOVERY_FAILED', message: 'The safety check failed.' }
            : cachedModels),
        })
      })
      vi.stubGlobal('fetch', fetchMock)
      const queryClient = createTestQueryClient()
      queryClient.setQueryData(OPENCODE_MODELS_QUERY_KEY, cachedModels)
      renderHook(() => useOpenCodeModels(), { wrapper: queryWrapper(queryClient) })
      const outcome = expect(refreshOpenCodeModelsQuery(queryClient)).rejects.toThrow('The safety check failed.')

      await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_FETCH_RETRY_COUNT * MODEL_FETCH_RETRY_DELAY_MS) })
      await outcome
      expect(fetchMock).toHaveBeenCalledTimes(MODEL_FETCH_RETRY_COUNT + 1)

      await act(async () => { await queryClient.refetchQueries() })

      expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(MODEL_FETCH_RETRY_COUNT + 1)
      expect(fetchMock).toHaveBeenLastCalledWith('/api/models', { method: 'GET', signal: expect.any(AbortSignal) })
      expect(queryClient.getQueryState(['opencode-models', 'refresh'])).toBeUndefined()
      expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toEqual(cachedModels)
    })

    it('cleans up a cancelled refresh without cancelling its replacement', async () => {
      let completeReplacement!: (value: unknown) => void
      let replacementSignal!: AbortSignal
      const fetchMock = vi.fn()
        .mockImplementationOnce((_path, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }))
        .mockImplementationOnce((_path, { signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => {
          completeReplacement = resolve
          replacementSignal = signal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }))
      vi.stubGlobal('fetch', fetchMock)
      const queryClient = createTestQueryClient()
      const cancelled = expect(refreshOpenCodeModelsQuery(queryClient)).rejects.toMatchObject({ name: 'Error' })
      await vi.advanceTimersByTimeAsync(0)
      const replacement = refreshOpenCodeModelsQuery(queryClient)
      const outcome = expect(replacement).resolves.toMatchObject({ models: [{ fullId: 'openai/new-model' }] })
      await vi.advanceTimersByTimeAsync(0)

      await cancelled
      expect(replacementSignal.aborted).toBe(false)
      completeReplacement({ ok: true, json: () => Promise.resolve({ models: [{ fullId: 'openai/new-model' }] }) })
      await outcome

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(['opencode-models', 'refresh'])).toBeUndefined()
      expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toMatchObject({ models: [{ fullId: 'openai/new-model' }] })
    })
  })

  it('clears the cached models query before configuration opens', () => {
    const removeQueries = vi.fn()

    clearOpenCodeModelsQuery({ removeQueries })

    expect(removeQueries).toHaveBeenCalledWith({
      queryKey: ['opencode-models'],
    })
  })

  it('refreshes fresh cached models through the strong refresh endpoint', async () => {
    const queryClient = createTestQueryClient()
    const cachedModels = {
      models: [{ fullId: 'openai/old-model' }],
      connectedProviders: ['openai'],
      defaultModels: {},
      catalogScope: 'connected',
    }
    const cachedAllModels = { models: [{ fullId: 'openai/old-all-model' }] }
    queryClient.setQueryData(OPENCODE_MODELS_QUERY_KEY, cachedModels)
    queryClient.setQueryData(ALL_OPENCODE_MODELS_QUERY_KEY, cachedAllModels)

    await refreshOpenCodeModelsQuery(queryClient)

    expect(fetch).toHaveBeenCalledWith('/api/models/refresh', {
      method: 'POST',
      signal: expect.any(AbortSignal),
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toEqual(expect.objectContaining({
      connectedProviders: ['openai'],
    }))
    expect(queryClient.getQueryData(ALL_OPENCODE_MODELS_QUERY_KEY)).toEqual(cachedAllModels)
    expect(queryClient.getQueryState(ALL_OPENCODE_MODELS_QUERY_KEY)?.isInvalidated).toBe(true)
  })

  it('keeps cached models and does not retry a busy refresh', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'OPENCODE_BUSY',
      message: 'OpenCode has active work or unanswered requests. Wait for them to finish, then retry.',
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = createTestQueryClient()
    const cachedModels = { models: [{ fullId: 'openai/gpt-5.3-codex' }] }
    const cachedAllModels = { models: [{ fullId: 'openai/all-model' }] }
    queryClient.setQueryData(OPENCODE_MODELS_QUERY_KEY, cachedModels)
    queryClient.setQueryData(ALL_OPENCODE_MODELS_QUERY_KEY, cachedAllModels)

    await expect(refreshOpenCodeModelsQuery(queryClient)).rejects.toMatchObject({
      name: 'OpenCodeModelsError',
      code: 'OPENCODE_BUSY',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/models/refresh', {
      method: 'POST',
      signal: expect.any(AbortSignal),
    })
    expect(queryClient.getQueryData(OPENCODE_MODELS_QUERY_KEY)).toEqual(cachedModels)
    expect(queryClient.getQueryData(ALL_OPENCODE_MODELS_QUERY_KEY)).toEqual(cachedAllModels)
    expect(queryClient.getQueryState(ALL_OPENCODE_MODELS_QUERY_KEY)?.isInvalidated).toBe(false)
  })

  it('cancels catalog reads and an earlier refresh before reloading providers', async () => {
    const cancelled: string[] = []
    const fetchMock = vi.fn((path: string, { signal }: { signal: AbortSignal }) => path === '/api/models/refresh'
      ? Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [] }) })
      : new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          cancelled.push(path)
          reject(signal.reason)
        }, { once: true })
      }))
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = createTestQueryClient()
    const connected = queryClient.fetchQuery({
      queryKey: OPENCODE_MODELS_QUERY_KEY,
      queryFn: ({ signal }) => fetchModelsApi(signal),
    }).catch(() => undefined)
    const all = queryClient.fetchQuery({
      queryKey: ALL_OPENCODE_MODELS_QUERY_KEY,
      queryFn: ({ signal }) => fetchAllModelsApi(signal),
    }).catch(() => undefined)
    const earlierRefresh = queryClient.fetchQuery({
      queryKey: ['opencode-models', 'refresh'],
      queryFn: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          cancelled.push('earlier refresh')
          reject(signal.reason)
        }, { once: true })
      }),
    }).catch(() => undefined)

    await refreshOpenCodeModelsQuery(queryClient)
    await Promise.all([connected, all, earlierRefresh])

    expect(cancelled).toEqual(['/api/models', '/api/models?scope=all', 'earlier refresh'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/models/refresh', {
      method: 'POST',
      signal: expect.any(AbortSignal),
    })
  })

  it('does not retry a failed manual refresh outside the startup condition', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'temporary model failure' }), { status: 500 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 3 } } })

    await expect(refreshOpenCodeModelsQuery(queryClient)).rejects.toThrow(/HTTP 500/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
