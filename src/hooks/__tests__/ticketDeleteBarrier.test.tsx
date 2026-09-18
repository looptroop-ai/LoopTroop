import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDeleteTicket, useSaveTicketUIState, useTicketUIState } from '../useTickets'
import { getTicketUiStateRevision } from '@/lib/ticketUiStateRevision'

const ticketId = '1:BAR-1'

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  client.setQueryData(['ticket', ticketId], { id: ticketId, status: 'CODING' })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

function uiStateSaves(spy: ReturnType<typeof vi.fn>): number {
  return spy.mock.calls.filter(([url, init]) => (
    String(url).includes('/ui-state') && (init as RequestInit | undefined)?.method === 'PUT'
  )).length
}

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status }))
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the deletion write barrier', () => {
  it('does not let a queued save escape once the drain has timed out', async () => {
    // The drain is bounded so a stalled PUT cannot hold the delete open. That
    // bound is also the hole: the delete then clears the tombstone, and a save
    // still waiting behind the stalled one used to find the door open again and
    // PUT to a ticket that no longer exists. The save's own sequence number is
    // what keeps it refused.
    let releaseFirstSave!: () => void
    const fetchSpy = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/ui-state') && init?.method === 'PUT') {
        // The first save never settles until the test says so.
        if (uiStateSaves(fetchSpy) === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirstSave = () => resolve(new Response(JSON.stringify({ revision: 1 }), { status: 200 }))
          })
        }
        return jsonResponse({ revision: 2 })
      }
      return jsonResponse({ success: true, ticketId })
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { wrapper } = setup()
    const save = renderHook(() => useSaveTicketUIState(), { wrapper })
    const remove = renderHook(() => useDeleteTicket(), { wrapper })

    act(() => {
      save.result.current.mutate({ ticketId, scope: 'approval_prd', data: { a: 1 } })
    })
    await waitFor(() => expect(uiStateSaves(fetchSpy)).toBe(1))

    // A second save queues behind the stalled one.
    act(() => {
      save.result.current.mutate({ ticketId, scope: 'approval_prd', data: { a: 2 } })
    })

    act(() => {
      remove.result.current.mutate(ticketId)
    })
    // The drain gives up rather than waiting on the stall.
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
    await waitFor(() => expect(remove.result.current.isSuccess).toBe(true))

    // Only now does the stalled save settle, letting the queued one through.
    await act(async () => {
      releaseFirstSave()
      await Promise.resolve()
    })

    expect(uiStateSaves(fetchSpy)).toBe(1)
  })

  it('lets a save enqueued after the deletion through, which a recycled id needs', async () => {
    const fetchSpy = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/ui-state') && init?.method === 'PUT') {
        return jsonResponse({ revision: 1 })
      }
      return jsonResponse({ success: true, ticketId })
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { wrapper } = setup()
    const save = renderHook(() => useSaveTicketUIState(), { wrapper })
    const remove = renderHook(() => useDeleteTicket(), { wrapper })

    act(() => {
      remove.result.current.mutate(ticketId)
    })
    await waitFor(() => expect(remove.result.current.isSuccess).toBe(true))

    act(() => {
      save.result.current.mutate({ ticketId, scope: 'approval_prd', data: { a: 1 } })
    })

    await waitFor(() => expect(uiStateSaves(fetchSpy)).toBe(1))
  })

  it('releases queued saves when the delete fails', async () => {
    let releaseFirstSave!: () => void
    const fetchSpy = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/ui-state') && init?.method === 'PUT') {
        if (uiStateSaves(fetchSpy) === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirstSave = () => resolve(new Response(JSON.stringify({ revision: 1 }), { status: 200 }))
          })
        }
        return jsonResponse({ revision: 2 })
      }
      return jsonResponse({ error: 'still in use' }, 409)
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { wrapper } = setup()
    const save = renderHook(() => useSaveTicketUIState(), { wrapper })
    const remove = renderHook(() => useDeleteTicket(), { wrapper })

    act(() => {
      save.result.current.mutate({ ticketId, scope: 'approval_prd', data: { a: 1 } })
      save.result.current.mutate({ ticketId, scope: 'approval_prd', data: { a: 2 } })
    })
    await waitFor(() => expect(uiStateSaves(fetchSpy)).toBe(1))

    act(() => { remove.result.current.mutate(ticketId) })
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
    await waitFor(() => expect(remove.result.current.isError).toBe(true))

    await act(async () => {
      releaseFirstSave()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(uiStateSaves(fetchSpy)).toBe(2))
  })

  it('fences a late save response after a successful delete', async () => {
    let releaseFirstSave!: () => void
    const fetchSpy = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/ui-state') && init?.method === 'PUT') {
        return new Promise<Response>((resolve) => {
          releaseFirstSave = () => resolve(new Response(JSON.stringify({ revision: 7 }), { status: 200 }))
        })
      }
      return jsonResponse({ success: true, ticketId })
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { client, wrapper } = setup()
    const save = renderHook(() => useSaveTicketUIState(), { wrapper })
    const remove = renderHook(() => useDeleteTicket(), { wrapper })

    act(() => {
      save.result.current.mutate({ ticketId, scope: 'approval_prd', data: { draft: 'old' } })
    })
    await waitFor(() => expect(uiStateSaves(fetchSpy)).toBe(1))

    act(() => { remove.result.current.mutate(ticketId) })
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
    await waitFor(() => expect(remove.result.current.isSuccess).toBe(true))
    expect(client.getQueryData(['ticket-ui-state', ticketId, 'approval_prd'])).toBeUndefined()

    await act(async () => {
      releaseFirstSave()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(client.getQueryData(['ticket-ui-state', ticketId, 'approval_prd'])).toBeUndefined()
    expect(getTicketUiStateRevision(ticketId, 'approval_prd')).toBe(0)
  })

  it('fences a paused UI-state GET across delete and same-id reissue', async () => {
    const reissuedTicketId = '1:BAR-GET-REISSUE'
    const scope = 'approval_prd'
    let releaseOldJson!: (value: unknown) => void
    let readCount = 0
    const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return jsonResponse({ success: true, ticketId: reissuedTicketId })
      }
      if (init?.method === 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({
          success: true,
          conflict: false,
          revision: 6,
          clientRevision: 6,
        }), { status: 200 }))
      }
      readCount += 1
      if (readCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => new Promise((resolve) => { releaseOldJson = resolve }),
        } as Response)
      }
      return Promise.resolve(new Response(JSON.stringify({
        scope,
        exists: true,
        data: { value: 'new-ticket' },
        updatedAt: null,
        revision: 5,
        clientRevision: 5,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { client, wrapper } = setup()
    const oldRead = renderHook(() => useTicketUIState(reissuedTicketId, scope), { wrapper })
    await waitFor(() => expect(releaseOldJson).toBeDefined())
    // Leave the old observer before deleting. The query itself remains paused
    // in the QueryClient, so the delete cleanup can cancel/remove it without
    // an observer immediately starting a new read for the same id.
    oldRead.unmount()

    const remove = renderHook(() => useDeleteTicket(), { wrapper })
    act(() => { remove.result.current.mutate(reissuedTicketId) })
    await waitFor(() => expect(remove.result.current.isSuccess).toBe(true))

    expect(getTicketUiStateRevision(reissuedTicketId, scope)).toBe(0)
    await act(async () => {
      releaseOldJson({
        scope,
        exists: true,
        data: { value: 'old-ticket' },
        updatedAt: null,
        revision: 77,
        clientRevision: 77,
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getTicketUiStateRevision(reissuedTicketId, scope)).toBe(0)
    expect(client.getQueryData(['ticket-ui-state', reissuedTicketId, scope])).toBeUndefined()

    const newRead = renderHook(() => useTicketUIState(reissuedTicketId, scope), { wrapper })
    await waitFor(() => expect(newRead.result.current.isSuccess).toBe(true))
    expect(getTicketUiStateRevision(reissuedTicketId, scope)).toBe(5)

    const save = renderHook(() => useSaveTicketUIState(), { wrapper })
    await act(async () => {
      await save.result.current.mutateAsync({ ticketId: reissuedTicketId, scope, data: { value: 'saved' } })
    })
    const putCall = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({ expectedRevision: 5 })

    save.unmount()
    newRead.unmount()
  })
})
