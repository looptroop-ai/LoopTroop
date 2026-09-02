import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDeleteTicket, useSaveTicketUIState } from '../useTickets'

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
        return Promise.resolve(new Response(JSON.stringify({ revision: 2 }), { status: 200 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ success: true, ticketId }), { status: 200 }))
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
        return Promise.resolve(new Response(JSON.stringify({ revision: 1 }), { status: 200 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ success: true, ticketId }), { status: 200 }))
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
})
