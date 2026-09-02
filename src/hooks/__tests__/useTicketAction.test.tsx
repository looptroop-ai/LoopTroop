import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCancelTicket, useTicketAction, type Ticket } from '../useTickets'
import { useDeleteProject } from '../useProjects'

const ticketId = '1:ACT-1'

function setup(cached?: Partial<Ticket>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  if (cached) client.setQueryData(['ticket', ticketId], cached)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useTicketAction cache patching', () => {
  it('records where a status-only transition came from', async () => {
    // `useSSE` already sets `previousStatus` on a state change. Without it here,
    // every surface that explains what failed read a `previousStatus` left over
    // from an earlier transition.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      message: 'Retrying',
      ticketId,
      state: 'BLOCKED_ERROR',
    })))
    const { client, wrapper } = setup({ id: ticketId, status: 'PREPARING_EXECUTION_ENV', previousStatus: 'DRAFT' })
    const { result } = renderHook(() => useTicketAction(), { wrapper })

    result.current.mutate({ id: ticketId, action: 'retry' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(client.getQueryData<Ticket>(['ticket', ticketId])).toMatchObject({
      status: 'BLOCKED_ERROR',
      previousStatus: 'PREPARING_EXECUTION_ENV',
    })
  })

  it('leaves previousStatus alone when the status did not move', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      message: 'Nothing changed',
      ticketId,
      state: 'CODING',
    })))
    const { client, wrapper } = setup({ id: ticketId, status: 'CODING', previousStatus: 'DRAFT' })
    const { result } = renderHook(() => useTicketAction(), { wrapper })

    result.current.mutate({ id: ticketId, action: 'retry' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(client.getQueryData<Ticket>(['ticket', ticketId])?.previousStatus).toBe('DRAFT')
  })

  it('takes the ticket the route returned rather than deriving a status patch', async () => {
    // The full ticket carries its own `previousStatus`; patching on top of it
    // would overwrite that with one derived from the cache.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      message: 'Retrying',
      ticketId,
      state: 'CODING',
      ticket: {
        id: ticketId,
        status: 'CODING',
        previousStatus: 'BLOCKED_ERROR',
        availableActions: ['cancel', 'teleport'],
      },
    })))
    const { client, wrapper } = setup({ id: ticketId, status: 'WAITING_PR_REVIEW', previousStatus: 'DRAFT' })
    const { result } = renderHook(() => useTicketAction(), { wrapper })

    result.current.mutate({ id: ticketId, action: 'retry' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(client.getQueryData<Ticket>(['ticket', ticketId])).toMatchObject({
      status: 'CODING',
      previousStatus: 'BLOCKED_ERROR',
      // The merged ticket goes through the normaliser like any other write.
      availableActions: ['cancel'],
    })
  })
})

describe('useCancelTicket with deleteTicket', () => {
  it('clears every cache for a cancel that also deletes the ticket', async () => {
    // The route answers `{ success, ticketId }` and nothing else, so the status
    // patch has nothing to apply. Without the deletion cleanup, phase attempts,
    // Manual QA rounds, artifacts, bead diffs and UI state stayed cached under
    // an id the server can reissue.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, ticketId })))
    const { client, wrapper } = setup({ id: ticketId, status: 'CODING' })
    client.setQueryData(['manual-qa', ticketId, 'index'], {})
    client.setQueryData(['ticket-phase-attempts', ticketId, 'CODING'], [])
    client.setQueryData(['tickets'], [{ id: ticketId }, { id: '1:ACT-2' }])

    const { result } = renderHook(() => useCancelTicket(), { wrapper })
    result.current.mutate({ id: ticketId, options: { deleteTicket: true } })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await waitFor(() => {
      expect(client.getQueryCache().getAll().filter((q) => q.queryKey.includes(ticketId))).toEqual([])
    })
    expect(client.getQueryData<Array<{ id: string }>>(['tickets'])).toEqual([{ id: '1:ACT-2' }])
  })

  it('leaves an ordinary cancel on the status path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      message: 'Canceled', ticketId, state: 'CANCELED',
    })))
    const { client, wrapper } = setup({ id: ticketId, status: 'CODING' })
    client.setQueryData(['manual-qa', ticketId, 'index'], {})

    const { result } = renderHook(() => useCancelTicket(), { wrapper })
    result.current.mutate({ id: ticketId, options: { deleteContent: true } })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(client.getQueryData<Ticket>(['ticket', ticketId])).toMatchObject({
      status: 'CANCELED',
      previousStatus: 'CODING',
    })
    expect(client.getQueryData(['manual-qa', ticketId, 'index'])).toEqual({})
  })
})

describe('applyTicketActionResult without a detail cache entry', () => {
  it('reads the previous status from a ticket list', async () => {
    // A board action fires without the detail query ever having been mounted.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      message: 'Retrying', ticketId, state: 'BLOCKED_ERROR',
    })))
    const { client, wrapper } = setup()
    client.setQueryData(['tickets'], [{ id: ticketId, status: 'PREPARING_EXECUTION_ENV' }])

    const { result } = renderHook(() => useTicketAction(), { wrapper })
    result.current.mutate({ id: ticketId, action: 'retry' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(client.getQueryData<Ticket[]>(['tickets'])?.[0]).toMatchObject({
      status: 'BLOCKED_ERROR',
      previousStatus: 'PREPARING_EXECUTION_ENV',
    })
  })
})

describe('useDeleteProject barrier', () => {
  it('lets panels save again when the project delete fails', async () => {
    // The barrier is added before the DELETE. The ticket paths release it in a
    // catch; this one did not, so one refused project delete left every ticket
    // of that project unable to persist panel state for the life of the tab.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Project is busy' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )))
    const { client, wrapper } = setup()
    client.setQueryData(['tickets'], [{ id: '1:P-1', projectId: 1 }])

    const { result } = renderHook(() => useDeleteProject(), { wrapper })
    result.current.mutate(1)

    await waitFor(() => expect(result.current.isError).toBe(true))
    const { isTicketClosing } = await import('../useTickets')
    expect(isTicketClosing('1:P-1')).toBe(false)
  })
})
