import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { createTestQueryClient } from '@/test/renderHelpers'
import { MODEL_FETCH_RETRY_DELAY_MS } from '@/lib/constants'
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
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: [{ fullId: 'openai/gpt-5.3-codex' }],
        connectedProviders: ['openai'],
        defaultModels: {},
        catalogScope: 'connected',
      }),
    })))
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
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: [{ fullId: 'openai/gpt-5.3-codex' }],
        connectedProviders: ['openai'],
        defaultModels: {},
        catalogScope: 'available',
      }),
    })))
    const queryClient = createTestQueryClient()
    const { result } = renderHook(() => useOpenCodeModelCatalog(), { wrapper: queryWrapper(queryClient) })

    await waitFor(() => expect(result.current.data?.catalogScope).toBe('available'))
  })

  it('treats a response with a message field as an error (opencode not ready)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: [],
        connectedProviders: [],
        defaultModels: {},
        code: 'OPENCODE_UNREACHABLE',
        message: 'OpenCode server is not reachable. Start it with `opencode serve`.',
      }),
    })))

    await expect(fetchModelsApi()).rejects.toThrow(/not reachable/i)
  })

  it('retries the explicit OpenCode startup response and succeeds when it comes up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [],
            connectedProviders: [],
            defaultModels: {},
            code: 'OPENCODE_UNREACHABLE',
            message: 'OpenCode server is not reachable. Start it with `opencode serve`.',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
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
