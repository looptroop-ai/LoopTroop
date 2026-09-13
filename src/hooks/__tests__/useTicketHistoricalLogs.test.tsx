import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJsonResponse, createTestQueryClient } from '@/test/renderHelpers'
import { useTicketHistoricalLogs, type HistoricalLogScope } from '../useTicketHistoricalLogs'
import { SERVER_LOG_REFRESH_EVENT } from '@/context/logUtils'

/** Mounts the hook against a fresh query client — every test needs the same scaffolding. */
function renderHistoricalLogs(scope: HistoricalLogScope) {
  const client = createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(() => useTicketHistoricalLogs('ticket-1', scope), { wrapper })
}

describe('useTicketHistoricalLogs', () => {
  afterEach(() => vi.restoreAllMocks())

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
