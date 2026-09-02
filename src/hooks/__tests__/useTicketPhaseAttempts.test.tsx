import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTicketPhaseAttempts } from '../useTicketPhaseAttempts'

const ticketId = '1:ATT-1'
const phase = 'WAITING_INTERVIEW_APPROVAL'

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { wrapper }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useTicketPhaseAttempts', () => {
  it('fails on a non-2xx instead of resolving to no attempts', async () => {
    // Resolving successfully with `[]` made a 500 look like a phase that had run
    // exactly once, so the approval pane hid the version selector and showed the
    // wrong attempt with nothing saying the list had not loaded.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Database is locked' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )))
    const { wrapper } = setup()

    const { result } = renderHook(() => useTicketPhaseAttempts(ticketId, phase), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
    expect((result.current.error as Error).message)
      .toBe('Unable to load phase attempts (HTTP 500: Database is locked)')
  })

  it('fails on a payload that is not a list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ attempts: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    const { wrapper } = setup()

    const { result } = renderHook(() => useTicketPhaseAttempts(ticketId, phase), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect((result.current.error as Error).message).toContain('invalid response')
  })

  it('still accepts a genuinely empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const { wrapper } = setup()

    const { result } = renderHook(() => useTicketPhaseAttempts(ticketId, phase), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual([])
  })

  it('encodes the ticket id and the phase', async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = setup()

    renderHook(() => useTicketPhaseAttempts(ticketId, phase), { wrapper })

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    expect(String(fetchSpy.mock.calls[0]?.[0]))
      .toBe(`/api/tickets/1%3AATT-1/phases/${phase}/attempts`)
  })
})
