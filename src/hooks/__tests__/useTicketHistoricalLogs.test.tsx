import { StrictMode, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJsonResponse, createTestQueryClient } from '@/test/renderHelpers'
import { foldHistoricalLogPages, useTicketHistoricalLogs, type HistoricalLogPage, type HistoricalLogScope } from '../useTicketHistoricalLogs'
import { SERVER_LOG_REFRESH_EVENT } from '@/context/logUtils'

/** Mounts the hook against a fresh query client — every test needs the same scaffolding. */
function renderHistoricalLogs(scope: HistoricalLogScope, strictMode = false) {
  const client = createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => {
    const content = <QueryClientProvider client={client}>{children}</QueryClientProvider>
    return strictMode ? <StrictMode>{content}</StrictMode> : content
  }
  return { ...renderHook(() => useTicketHistoricalLogs('ticket-1', scope), { wrapper }), client }
}

describe('useTicketHistoricalLogs', () => {
  afterEach(() => vi.restoreAllMocks())

  it('publishes a completed automatic drain after StrictMode replays the mount effect', async () => {
    let page = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const currentPage = page++
      return createJsonResponse({
        entries: [{ phase: 'CODING', entryId: currentPage === 0 ? 'new' : 'old', content: currentPage === 0 ? 'new' : 'old' }],
        olderCursor: currentPage === 0 ? 'older' : null,
        hasOlder: currentPage === 0,
      })
    })
    const { result } = renderHistoricalLogs({ scope: 'lifecycle', view: 'overview' }, true)

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(async () => { await result.current.fetchAllOlder() })

    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['old', 'new']))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('does not share an in-flight older-page drain with a new query scope', async () => {
    let resolveAttemptOne!: (response: Response | PromiseLike<Response>) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
      const url = new URL(String(input), 'http://localhost')
      const attempt = url.searchParams.get('phaseAttempt')
      if (url.searchParams.has('before')) {
        if (attempt === '1') return new Promise<Response>(resolve => { resolveAttemptOne = resolve })
        return createJsonResponse({
          entries: [{ phase: 'CODING', entryId: 'old-attempt-two', content: 'old attempt two' }],
          olderCursor: null,
          hasOlder: false,
        })
      }
      return createJsonResponse({
        entries: [{ phase: 'CODING', entryId: `new-attempt-${attempt}`, content: `new attempt ${attempt}` }],
        olderCursor: `cursor-${attempt}`,
        hasOlder: true,
      })
    })
    const client = createTestQueryClient()
    const { result, rerender } = renderHook(
      ({ scope }: { scope: HistoricalLogScope }) => useTicketHistoricalLogs('ticket-1', scope),
      {
        initialProps: { scope: { scope: 'phase', phase: 'CODING', phaseAttempt: 1, view: 'overview' } },
        wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
      },
    )

    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['new-attempt-1']))
    let firstDrain!: Promise<void>
    await act(async () => {
      firstDrain = result.current.fetchAllOlder()
      await Promise.resolve()
    })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))

    rerender({ scope: { scope: 'phase', phase: 'CODING', phaseAttempt: 2, view: 'overview' } })
    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['new-attempt-2']))
    await act(async () => { await result.current.fetchAllOlder() })

    expect(result.current.entries.map(entry => entry.entryId)).toEqual(['old-attempt-two', 'new-attempt-2'])
    expect(fetchSpy).toHaveBeenCalledTimes(4)

    await act(async () => {
      resolveAttemptOne(createJsonResponse({ entries: [], olderCursor: null, hasOlder: false }))
      await firstDrain
    })
  })

  it('preserves the model array reference when fresh responses contain the same catalog', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => createJsonResponse({
      entries: [], modelIds: ['provider/a', 'provider/b'], olderCursor: null, hasOlder: false,
    }))
    const { result } = renderHistoricalLogs({ scope: 'lifecycle', view: 'overview' })
    await waitFor(() => expect(result.current.modelIds).toEqual(['provider/a', 'provider/b']))
    const models = result.current.modelIds
    await act(async () => { await result.current.refetch() })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result.current.modelIds).toBe(models)
  })

  it.each([200, 503])('orders concurrent filter catalogs when the newer request returns status %i', async status => {
    let resolveOlder!: (response: Response) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve }))
      .mockImplementationOnce(() => createJsonResponse({ entries: [], modelIds: ['provider/a', 'provider/b'] }, status))
    const client = createTestQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const older = renderHook(() => useTicketHistoricalLogs('ticket-1', { scope: 'lifecycle', view: 'overview' }), { wrapper })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    const newer = renderHook(() => useTicketHistoricalLogs('ticket-1', { scope: 'lifecycle', view: 'ai' }), { wrapper })
    await waitFor(() => expect(newer.result.current.isFetching).toBe(false))
    await act(async () => { resolveOlder(await createJsonResponse({ entries: [], modelIds: ['provider/a'] })) })
    await waitFor(() => expect(older.result.current.isFetching).toBe(false))
    const expected = status === 200 ? ['provider/a', 'provider/b'] : ['provider/a']
    await waitFor(() => expect(older.result.current.modelIds).toEqual(expected))
    expect(newer.result.current.modelIds).toEqual(expected)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it.each([1000, 900])('keeps the catalog through cached paging and remounts when the clock becomes %i', async clock => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
      const url = new URL(String(input), 'http://localhost')
      if (url.searchParams.has('before')) return createJsonResponse({ entries: [], hasOlder: false, olderCursor: null })
      const modelIds = url.searchParams.get('view') === 'ai' ? ['provider/a', 'provider/b'] : ['provider/a']
      return createJsonResponse({ entries: [], hasOlder: true, olderCursor: 'older', modelIds })
    })
    const client = createTestQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result, rerender, unmount } = renderHook(
      ({ view }: { view: HistoricalLogScope['view'] }) => useTicketHistoricalLogs('ticket-1', { scope: 'lifecycle', view }),
      { initialProps: { view: 'overview' }, wrapper },
    )
    await waitFor(() => expect(result.current.modelIds).toEqual(['provider/a']))
    now.mockReturnValue(clock)
    rerender({ view: 'ai' })
    await waitFor(() => expect(result.current.modelIds).toEqual(['provider/a', 'provider/b']))
    rerender({ view: 'overview' })
    expect(result.current.modelIds).toEqual(['provider/a', 'provider/b'])
    await act(async () => { await result.current.fetchOlder() })
    expect(result.current.modelIds).toEqual(['provider/a', 'provider/b'])
    unmount()
    const remounted = renderHook(() => useTicketHistoricalLogs('ticket-1', { scope: 'lifecycle', view: 'overview' }), { wrapper })
    expect(remounted.result.current.modelIds).toEqual(['provider/a', 'provider/b'])
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('retains complete model metadata across filter loading and resets it for another scope', async () => {
    const models = ['provider/older-model', 'provider/newer-model']
    let finishModelPage: (response: Response) => void = () => {}
    vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
      const url = new URL(String(input), 'http://localhost')
      if (url.searchParams.get('phaseAttempt') === '2') return new Promise(() => {})
      if (url.searchParams.has('modelId')) return new Promise(resolve => { finishModelPage = resolve })
      return createJsonResponse({ entries: [], hasOlder: false, olderCursor: null, modelIds: models })
    })
    const client = createTestQueryClient()
    const { result, rerender } = renderHook(
      ({ scope }: { scope: HistoricalLogScope }) => useTicketHistoricalLogs('ticket-1', scope),
      {
        initialProps: { scope: { scope: 'phase', phase: 'CODING', phaseAttempt: 1, view: 'overview' } },
        wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
      },
    )
    await waitFor(() => expect(result.current.modelIds).toEqual(models))
    rerender({ scope: { scope: 'phase', phase: 'CODING', phaseAttempt: 1, view: 'ai', modelId: models[0] } })
    expect(result.current.isLoading).toBe(true)
    expect(result.current.modelIds).toEqual(models)
    await act(async () => { finishModelPage(await createJsonResponse({ entries: [], hasOlder: false, olderCursor: null, modelIds: models })) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.modelIds).toEqual(models)
    rerender({ scope: { scope: 'phase', phase: 'CODING', phaseAttempt: 2, view: 'ai', modelId: models[0] } })
    expect(result.current.modelIds).toBeNull()
    expect(result.current.entries).toEqual([])
  })

  it('refreshes loaded history from the newest page with fresh cursors, totals, and models', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'new', content: 'new', timestamp: '2026-03-10T00:00:02.000Z' }],
        olderCursor: 'cursor-older',
        hasOlder: true,
        totalEntries: 2000,
        totalTextLines: 4821,
        modelIds: ['provider/archived-model'],
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'old', content: 'old', timestamp: '2026-03-10T00:00:01.000Z' }],
        olderCursor: null,
        hasOlder: false,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'recovered', content: 'recovered', timestamp: '2026-03-10T00:00:03.000Z' }],
        olderCursor: 'fresh-older',
        hasOlder: true,
        totalEntries: 2001,
        totalTextLines: 4822,
        modelIds: ['provider/archived-model', 'provider/new-model'],
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [
          { phase: 'CODING', entryId: 'old', content: 'old', timestamp: '2026-03-10T00:00:01.000Z' },
          { phase: 'CODING', entryId: 'new', content: 'new', timestamp: '2026-03-10T00:00:02.000Z' },
        ],
        olderCursor: null,
        hasOlder: false,
      }))
    const { result } = renderHistoricalLogs({ scope: 'phase', phase: 'CODING', phaseAttempt: 2, view: 'overview', })

    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['new']))
    expect(result.current.totalEntries).toBe(2000)
    expect(result.current.totalTextLines).toBe(4821)
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      '/api/tickets/ticket-1/logs?scope=phase&view=overview&limit=20&phase=CODING&phaseAttempt=2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    await act(async () => { await result.current.fetchOlder() })
    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['old', 'new']))
    expect(result.current.modelIds).toEqual(['provider/archived-model'])
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      '/api/tickets/ticket-1/logs?scope=phase&view=overview&limit=250&phase=CODING&phaseAttempt=2&before=cursor-older',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    act(() => window.dispatchEvent(new CustomEvent(SERVER_LOG_REFRESH_EVENT, { detail: { ticketId: 'ticket-1' } })))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4))
    expect(fetchSpy).toHaveBeenNthCalledWith(3,
      '/api/tickets/ticket-1/logs?scope=phase&view=overview&limit=20&phase=CODING&phaseAttempt=2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(fetchSpy).toHaveBeenNthCalledWith(4,
      '/api/tickets/ticket-1/logs?scope=phase&view=overview&limit=250&phase=CODING&phaseAttempt=2&before=fresh-older',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['old', 'new', 'recovered']))
    expect(result.current.modelIds).toEqual(['provider/archived-model', 'provider/new-model'])
    expect(result.current.data?.pages).toHaveLength(2)
    expect(result.current.hasOlder).toBe(false)
    expect(result.current.totalEntries).toBe(2001)
    expect(result.current.totalTextLines).toBe(4822)
  })

  it('lets a native refresh supersede an older request and lets the full drain retry it', async () => {
    let resolveOlder!: (response: Response) => void
    let olderSignal: AbortSignal | null | undefined
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.includes('before=')) {
        olderSignal = init?.signal
        return new Promise<Response>((resolve) => { resolveOlder = resolve })
      }
      return createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'new', content: 'new' }],
        olderCursor: 'cursor-older',
        hasOlder: true,
      })
    })
    const { result } = renderHistoricalLogs({ scope: 'lifecycle', view: 'overview' })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(async () => {
      void result.current.fetchOlder()
      await Promise.resolve()
    })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SERVER_LOG_REFRESH_EVENT, { detail: { ticketId: 'ticket-1' } }))
      await Promise.resolve()
    })

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3))
    expect(olderSignal?.aborted).toBe(true)
    let drain!: Promise<void>
    await act(async () => {
      drain = result.current.fetchAllOlder()
      await Promise.resolve()
    })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4))
    await act(async () => {
      resolveOlder(await createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'old', content: 'old' }],
        olderCursor: null,
        hasOlder: false,
      }))
      await drain
    })
    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['old', 'new']))
  })

  it('uses native refetch cancellation and retries the older cursor during a full drain', async () => {
    let olderSignal: AbortSignal | null | undefined
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.includes('before=')) {
        if (fetchSpy.mock.calls.length > 2) {
          return createJsonResponse({
            entries: [{ phase: 'CODING', entryId: 'old', content: 'old' }],
            olderCursor: null, hasOlder: false,
          })
        }
        olderSignal = init?.signal
        return new Promise<Response>(() => {})
      }
      if (fetchSpy.mock.calls.length === 1) {
        return createJsonResponse({
          entries: [{ phase: 'CODING', entryId: 'new', content: 'new' }],
          olderCursor: 'cursor-older', hasOlder: true,
        })
      }
      return createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'recovered', content: 'recovered' }],
        olderCursor: 'fresh-older', hasOlder: true,
      })
    })
    const { result } = renderHistoricalLogs({ scope: 'lifecycle', view: 'overview' })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(async () => {
      void result.current.fetchOlder()
      await Promise.resolve()
    })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    let refresh!: ReturnType<typeof result.current.refetch>
    await act(async () => {
      refresh = result.current.refetch()
      await Promise.resolve()
    })
    expect(olderSignal?.aborted).toBe(true)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3))

    await act(async () => {
      await refresh
    })

    let drain!: Promise<void>
    await act(async () => {
      drain = result.current.fetchAllOlder()
      await Promise.resolve()
    })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4))
    await act(async () => {
      await drain
    })
    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['old', 'recovered']))
    expect(result.current.data?.pages).toHaveLength(2)
  })

  it('shares an active native refetch with an older request, then drains its settled cursor', async () => {
    let resolveRefresh!: (response: Response) => void
    let refreshSignal: AbortSignal | null | undefined
    let resolveOlder!: (response: Response) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.includes('before=')) {
        return new Promise<Response>(resolve => { resolveOlder = resolve })
      }
      if (fetchSpy.mock.calls.length === 1) {
        return createJsonResponse({
          entries: [{ phase: 'CODING', entryId: 'new', content: 'new' }],
          olderCursor: 'cursor-older', hasOlder: true,
        })
      }
      refreshSignal = init?.signal
      return new Promise<Response>(resolve => { resolveRefresh = resolve })
    })
    const { result } = renderHistoricalLogs({ scope: 'lifecycle', view: 'overview' })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    let refresh!: ReturnType<typeof result.current.refetch>
    let drain!: Promise<void>
    await act(async () => {
      refresh = result.current.refetch()
      drain = result.current.fetchAllOlder()
      await Promise.resolve()
    })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('before='))).toBe(false)

    await act(async () => {
      resolveRefresh(await createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'recovered', content: 'recovered' }],
        olderCursor: 'fresh-older', hasOlder: true,
      }))
      await refresh
    })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3))
    expect(refreshSignal?.aborted).toBe(false)

    await act(async () => {
      resolveOlder(await createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'old', content: 'old' }],
        olderCursor: null, hasOlder: false,
      }))
      await drain
    })
    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['old', 'recovered']))
  })

  it('preserves refetchType none during an older-page request', async () => {
    let resolveOlder!: (response: Response) => void
    let olderSignal: AbortSignal | null | undefined
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.includes('before=')) {
        olderSignal = init?.signal
        return new Promise<Response>(resolve => { resolveOlder = resolve })
      }
      if (fetchSpy.mock.calls.length === 1) {
        return createJsonResponse({
          entries: [{ phase: 'CODING', entryId: 'new', content: 'new' }],
          olderCursor: 'cursor-older', hasOlder: true,
        })
      }
      return createJsonResponse({ entries: [{ phase: 'CODING', entryId: 'new', content: 'new' }], olderCursor: 'cursor-older', hasOlder: true })
    })
    const { result, client } = renderHistoricalLogs({ scope: 'lifecycle', view: 'overview' })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(async () => {
      void result.current.fetchOlder()
      await Promise.resolve()
    })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    const invalidation = client.invalidateQueries({
      predicate: query => query.queryKey.includes('ticket-1'),
      refetchType: 'none',
    })
    expect(olderSignal?.aborted).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveOlder(await createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'old', content: 'old' }],
        olderCursor: null, hasOlder: false,
      }))
      await invalidation
    })
    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['old', 'new']))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('restarts a full drain after the server expires its cursor and clears the visible error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (!url.includes('before=')) {
        if (fetchSpy.mock.calls.length === 1) {
          return createJsonResponse({
            entries: [{ phase: 'CODING', entryId: 'new', content: 'new' }],
            olderCursor: 'expired-cursor', hasOlder: true,
          })
        }
        return createJsonResponse({
          entries: [{ phase: 'CODING', entryId: 'fresh', content: 'fresh' }],
          olderCursor: 'fresh-cursor', hasOlder: true,
        })
      }
      if (fetchSpy.mock.calls.length === 2) {
        return createJsonResponse({ code: 'LOG_CURSOR_EXPIRED', error: 'LOG_CURSOR_EXPIRED' }, 409)
      }
      return createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'old', content: 'old' }],
        olderCursor: null, hasOlder: false,
      })
    })
    const { result } = renderHistoricalLogs({ scope: 'lifecycle', view: 'overview' })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(async () => { await result.current.fetchAllOlder() })
    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['old', 'fresh']))
    expect(result.current.isError).toBe(false)
    expect(result.current.data?.pages).toHaveLength(2)
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect(fetchSpy.mock.calls[3]?.[0]).toContain('before=fresh-cursor')
  })

  it('fails loudly when an older cursor repeats instead of truncating the drain', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
      const url = String(input)
      if (!url.includes('before=')) {
        return createJsonResponse({
          entries: [{ phase: 'CODING', entryId: 'new', content: 'new' }],
          olderCursor: 'cursor-older', hasOlder: true,
        })
      }
      return createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'same-page', content: 'same page' }],
        olderCursor: 'cursor-older', hasOlder: true,
      })
    })
    const { result } = renderHistoricalLogs({ scope: 'lifecycle', view: 'overview' })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    let drain!: Promise<void>
    await act(async () => {
      drain = result.current.fetchAllOlder()
      await Promise.resolve()
    })
    await act(async () => {
      await expect(drain).rejects.toThrow('cursor did not advance')
    })
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['same-page', 'new']))
  })

  it('loads every older cursor page for explicit navigation to the true beginning', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'new', content: 'new' }],
        olderCursor: 'cursor-2',
        hasOlder: true,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'middle', content: 'middle' }],
        olderCursor: 'cursor-1',
        hasOlder: true,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'old', content: 'old' }],
        olderCursor: null,
        hasOlder: false,
      }))
    const { result } = renderHistoricalLogs({ scope: 'lifecycle', view: 'overview', })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(async () => { await result.current.fetchAllOlder() })

    // Undated rows must retain the oldest-first fold order, regardless of cache order.
    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['old', 'middle', 'new']))
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      '/api/tickets/ticket-1/logs?scope=lifecycle&view=overview&limit=250&before=cursor-2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      '/api/tickets/ticket-1/logs?scope=lifecycle&view=overview&limit=250&before=cursor-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('keeps non-AI history in the server page order', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse({
        entries: [
          { phase: 'CODING', entryId: 'newer', content: 'newer', timestamp: '2026-03-10T00:00:01.000Z' },
          { phase: 'CODING', entryId: 'newer-undated', content: 'newer undated', timestamp: 'not-a-date' },
        ],
        olderCursor: 'cursor-older', hasOlder: true,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [
          { phase: 'CODING', entryId: 'older-undated', content: 'older undated', timestamp: 'still-not-a-date' },
          { phase: 'CODING', entryId: 'older-dated', content: 'older dated', timestamp: '2026-03-10T00:00:03.000Z' },
        ],
        olderCursor: null, hasOlder: false,
      }))
    const { result } = renderHistoricalLogs({ scope: 'lifecycle', view: 'overview' })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(async () => { await result.current.fetchAllOlder() })

    // The server's non-AI cursor is file/order based. Timestamps are display data,
    // not permission to reorder rows that arrived out of timestamp order.
    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual([
      'older-undated', 'older-dated', 'newer', 'newer-undated',
    ]))
  })

  it('uses a total AI comparator with undated rows last', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => createJsonResponse({
      entries: [
        { phase: 'CODING', entryId: 'undated', content: 'undated', timestamp: 'not-a-date', type: 'model_output', source: 'opencode', audience: 'ai', kind: 'text' },
        { phase: 'CODING', entryId: 'same-b', content: 'same b', timestamp: '2026-03-10T00:00:02.000Z', type: 'model_output', source: 'opencode', audience: 'ai', kind: 'text' },
        { phase: 'CODING', entryId: 'same-a', content: 'same a', timestamp: '2026-03-10T00:00:02.000Z', type: 'model_output', source: 'opencode', audience: 'ai', kind: 'text' },
        { phase: 'CODING', entryId: 'early', content: 'early', timestamp: '2026-03-10T00:00:01.000Z', type: 'model_output', source: 'opencode', audience: 'ai', kind: 'text' },
      ],
      olderCursor: null, hasOlder: false,
    }))
    const { result } = renderHistoricalLogs({ scope: 'phase', phase: 'CODING', view: 'ai' })

    await waitFor(() => expect(result.current.entries).toHaveLength(4))
    expect(result.current.entries.map(entry => entry.entryId)).toEqual(['early', 'same-a', 'same-b', 'undated'])
  })

  it('repositions an aliased older append when an incremental fold learns its start time', () => {
    const newerPage: HistoricalLogPage = {
      entries: [
        {
          id: 'b', entryId: 'b', line: 'b', source: 'opencode', status: 'CODING',
          audience: 'ai', kind: 'text', streaming: false, op: 'append',
          timestamp: '2026-03-10T00:00:02.000Z',
        },
        {
          id: 'a-final', entryId: 'a-final', fingerprint: 'alias-a', line: 'a final', source: 'opencode', status: 'CODING',
          audience: 'ai', kind: 'text', streaming: false, op: 'finalize',
          timestamp: '2026-03-10T00:00:03.000Z',
        },
      ],
      olderCursor: 'cursor-older', hasOlder: true, totalEntries: null, totalTextLines: null, modelIds: null,
    }
    const olderPage: HistoricalLogPage = {
      entries: [{
        id: 'a-append', entryId: 'a-append', fingerprint: 'alias-a', line: 'a original', source: 'opencode', status: 'CODING',
        audience: 'ai', kind: 'text', streaming: true, op: 'append',
        timestamp: '2026-03-10T00:00:01.000Z',
      }],
      olderCursor: null, hasOlder: false, totalEntries: null, totalTextLines: null, modelIds: null,
    }

    const initial = foldHistoricalLogPages([newerPage], 'ai')
    const folded = foldHistoricalLogPages([newerPage, olderPage], 'ai', initial)
    expect(folded.entries.map(entry => entry.entryId)).toEqual(['a-final', 'b'])
    expect(folded.entries[0]).toMatchObject({ timestamp: '2026-03-10T00:00:01.000Z', streaming: false })
  })

  it('retains aliases introduced by a middle page when the newest payload already won', () => {
    const newest: HistoricalLogPage = {
      entries: [{
        id: 'new', entryId: 'new', fingerprint: 'fp', line: 'final', source: 'opencode', status: 'CODING',
        audience: 'ai', kind: 'text', streaming: false, op: 'finalize', timestamp: '2026-03-10T00:00:03.000Z',
      }],
      olderCursor: 'middle', hasOlder: true, totalEntries: null, totalTextLines: null, modelIds: null,
    }
    const middle: HistoricalLogPage = {
      entries: [{
        id: 'old', entryId: 'old', fingerprint: 'fp', line: 'append', source: 'opencode', status: 'CODING',
        audience: 'ai', kind: 'text', streaming: true, op: 'append', timestamp: '2026-03-10T00:00:02.000Z',
      }],
      olderCursor: 'oldest', hasOlder: true, totalEntries: null, totalTextLines: null, modelIds: null,
    }
    const oldest: HistoricalLogPage = {
      entries: [{
        id: 'old', entryId: 'old', line: 'original', source: 'opencode', status: 'CODING',
        audience: 'ai', kind: 'text', streaming: true, op: 'append', timestamp: '2026-03-10T00:00:01.000Z',
      }],
      olderCursor: null, hasOlder: false, totalEntries: null, totalTextLines: null, modelIds: null,
    }

    const fresh = foldHistoricalLogPages([newest, middle, oldest], 'ai')
    const incremental = foldHistoricalLogPages([newest], 'ai')
    foldHistoricalLogPages([newest, middle], 'ai', incremental)
    const folded = foldHistoricalLogPages([newest, middle, oldest], 'ai', incremental)
    expect(fresh.entries).toHaveLength(1)
    expect(folded.entries).toHaveLength(1)
    expect(folded.entries[0]).toMatchObject({ entryId: 'new', timestamp: '2026-03-10T00:00:01.000Z', streaming: false })
  })

  it('folds many older pages with linear row visits after the first page', () => {
    const stats = {
      pagesVisited: 0, entriesVisited: 0, comparatorCalls: 0,
      nodeCopies: 0, materializedEntries: 0, aliasRegistrations: 0,
    }
    const pages: HistoricalLogPage[] = []
    for (let page = 0; page < 40; page += 1) {
      const next: HistoricalLogPage = {
        entries: Array.from({ length: 10 }, (_, index) => ({
          id: `row-${page}-${index}`,
          entryId: `row-${page}-${index}`,
          line: `row ${page}-${index}`,
          source: 'system',
          status: 'CODING',
          audience: 'all',
          kind: 'milestone',
          streaming: false,
          op: 'append',
        })),
        olderCursor: page < 39 ? `cursor-${page}` : null,
        hasOlder: page < 39,
        totalEntries: null,
        totalTextLines: null,
        modelIds: null,
      }
      pages.push(next)
    }

    // The automatic drain batches query updates and performs this one canonical
    // fold, so its actual publication work is one 400-row materialization.
    const cache = foldHistoricalLogPages(pages, 'overview', null, stats)
    expect(cache.entries).toHaveLength(400)
    expect(stats.entriesVisited).toBe(400)
    expect(stats.pagesVisited).toBe(40)
    expect(stats.comparatorCalls).toBe(0)
    expect(stats.materializedEntries).toBe(400)

    // The same production fold API also exposes the cost that would result from
    // publishing every page. This is the regression guard against accidentally
    // moving the fold back into each automatic observer update: 8,200 growing
    // materialized entries and 8,190 accumulated-array copies, not a fake row
    // counter based only on the final length.
    const incrementalStats = {
      pagesVisited: 0, entriesVisited: 0, comparatorCalls: 0,
      nodeCopies: 0, materializedEntries: 0, aliasRegistrations: 0,
    }
    let incrementalCache: ReturnType<typeof foldHistoricalLogPages> | null = null
    for (let count = 1; count <= pages.length; count += 1) {
      incrementalCache = foldHistoricalLogPages(pages.slice(0, count), 'overview', incrementalCache, incrementalStats)
    }
    expect(incrementalStats.entriesVisited).toBe(400)
    expect(incrementalStats.materializedEntries).toBe(8200)
    expect(incrementalStats.nodeCopies).toBe(8190)
  })

  it('publishes one final fold while the automatic 40-page drain is active', async () => {
    let page = 0
    const publishedLengths: number[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const currentPage = page++
      return createJsonResponse({
        entries: Array.from({ length: 10 }, (_, index) => ({
          phase: 'CODING', entryId: `drain-${currentPage}-${index}`, content: `row ${currentPage}-${index}`,
        })),
        olderCursor: currentPage < 39 ? `cursor-${currentPage + 1}` : null,
        hasOlder: currentPage < 39,
      })
    })
    const client = createTestQueryClient()
    const { result } = renderHook(() => {
      const current = useTicketHistoricalLogs('ticket-1', { scope: 'lifecycle', view: 'overview' })
      publishedLengths.push(current.entries.length)
      return current
    }, {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(async () => { await result.current.fetchAllOlder() })
    await waitFor(() => expect(result.current.entries).toHaveLength(400))
    expect(fetchSpy).toHaveBeenCalledTimes(40)
    expect(publishedLengths.filter(length => length > 10)).toEqual([400])
  })

  it('keeps two archived attempts apart when they reuse one milestone id', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{
          phase: 'CODING',
          entryId: 'milestone:CODING:started',
          phaseAttempt: 2,
          content: 'second attempt',
          timestamp: '2026-03-10T00:00:02.000Z',
        }],
        olderCursor: 'cursor-older',
        hasOlder: true,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{
          phase: 'CODING',
          entryId: 'milestone:CODING:started',
          phaseAttempt: 1,
          content: 'first attempt',
          timestamp: '2026-03-10T00:00:01.000Z',
        }],
        olderCursor: null,
        hasOlder: false,
      }))
    const { result } = renderHistoricalLogs({ scope: 'phase', phase: 'CODING', view: 'overview', })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(async () => { await result.current.fetchAllOlder() })

    // Folding on the bare entry id kept whichever page was applied last and dropped the
    // other attempt entirely.
    await waitFor(() => expect(result.current.entries).toHaveLength(2))
    expect(result.current.entries.map(entry => entry.phaseAttempt)).toEqual([1, 2])
    expect(result.current.entries.map(entry => entry.line)).toEqual(['[SYS] first attempt', '[SYS] second attempt'])
  })

  it('keeps the newer copy when one row spans a page boundary', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{
          phase: 'CODING',
          entryId: 'ses-1:answer',
          content: 'the finished answer',
          op: 'finalize',
          timestamp: '2026-03-10T00:00:02.000Z',
        }],
        olderCursor: 'cursor-older',
        hasOlder: true,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{
          phase: 'CODING',
          entryId: 'ses-1:answer',
          content: 'the answer so f',
          op: 'append',
          timestamp: '2026-03-10T00:00:01.000Z',
        }],
        olderCursor: null,
        hasOlder: false,
      }))
    const { result } = renderHistoricalLogs({ scope: 'phase', phase: 'CODING', view: 'ai', })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(async () => { await result.current.fetchAllOlder() })
    await waitFor(() => expect(result.current.data?.pages.length).toBe(2))

    // Folding oldest first prevents the unfinished append from replacing the finalize.
    expect(result.current.entries).toHaveLength(1)
    expect(result.current.entries[0]?.line).toContain('the finished answer')
    // ...and the row still reads from when it started, the way the live overlay merges
    // the same pair. Taking the finalize's timestamp would sort a row that streamed for
    // a while past everything that happened while it was streaming.
    expect(result.current.entries[0]?.timestamp).toBe('2026-03-10T00:00:01.000Z')
    expect(result.current.entries[0]?.streaming).toBe(false)
  })

  it('folds a row re-emitted under a new id when the fingerprint matches', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => createJsonResponse({
      entries: [
        {
          phase: 'CODING',
          entryId: 'first-delivery',
          fingerprint: 'opencode-question:session-1:req-1:replied',
          content: 'AI question answered.',
          timestamp: '2026-03-10T00:00:01.000Z',
        },
        {
          phase: 'CODING',
          entryId: 'second-delivery',
          fingerprint: 'opencode-question:session-1:req-1:replied',
          content: 'AI question answered.',
          timestamp: '2026-03-10T00:00:02.000Z',
        },
      ],
      olderCursor: null,
      hasOlder: false,
    }))
    const { result } = renderHistoricalLogs({ scope: 'phase', phase: 'CODING', view: 'overview', })

    // The live overlay folds on the fingerprint as well as the id, so the archive has to
    // as well or the same pair renders once live and twice restored.
    await waitFor(() => expect(result.current.entries).toHaveLength(1))
  })

  it('stops walking older pages once the caller cancels', async () => {
    // Bounded at five pages so an uncancelled walk still terminates: this has to fail on
    // its own assertion if the token is dropped, not by hanging the run.
    let page = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(() => {
        page += 1
        return createJsonResponse({
          entries: [{ phase: 'CODING', entryId: `page-${page}`, content: `row ${page}` }],
          olderCursor: page < 5 ? `cursor-${page}` : null,
          hasOlder: page < 5,
        })
      })
    const { result } = renderHistoricalLogs({ scope: 'lifecycle', view: 'overview', })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    const callsBeforeDrain = fetchSpy.mock.calls.length

    // Cancelled the moment the first page lands, standing in for a bead switch or an
    // unmount mid-walk.
    let cancelled = false
    await act(async () => {
      await result.current.fetchAllOlder(() => {
        const wasCancelled = cancelled
        cancelled = true
        return wasCancelled
      })
    })

    expect(fetchSpy.mock.calls.length).toBe(callsBeforeDrain + 1)
  })

  it('keeps one identity while it pages, so a caller can own a walk across it', async () => {
    // The second page is the last one, so `hasOlder` flips true -> false. That
    // flip is what used to rebuild the callback.
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'newest', content: 'row' }],
        olderCursor: 'cursor-next',
        hasOlder: true,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'oldest', content: 'row' }],
        olderCursor: null,
        hasOlder: false,
      }))
    const { result } = renderHistoricalLogs({ scope: 'lifecycle', view: 'overview', })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    const beforePaging = result.current.fetchAllOlder
    await act(async () => { await result.current.fetchOlder() })
    await waitFor(() => expect(result.current.hasOlder).toBe(false))

    // A caller holds this in an effect dependency to own its walk. Rebuilding it as
    // pages land re-runs that effect, and the cleanup cancels the walk still in flight —
    // which is how a refused page comes back looking like a cancellation and the retry
    // latch never closes.
    expect(result.current.fetchAllOlder).toBe(beforePaging)
  })

  it('includes a bead filter in durable history requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(() => createJsonResponse({
        entries: [],
        olderCursor: null,
        hasOlder: false,
      }))
    renderHistoricalLogs({ scope: 'phase', phase: 'CODING', view: 'ai', beadId: 'bead-1', })

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/tickets/ticket-1/logs?scope=phase&view=ai&limit=20&phase=CODING&beadId=bead-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
