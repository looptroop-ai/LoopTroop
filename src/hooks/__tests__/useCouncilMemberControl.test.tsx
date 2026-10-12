import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEST } from '@/test/factories'
import { useCouncilMemberControl } from '../useCouncilMemberControl'

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { invalidate, wrapper }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function sentRequest(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return { url, method: init.method, body: JSON.parse(String(init.body)) as unknown }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useCouncilMemberControl', () => {
  it('stops one model and refreshes the ticket artifacts', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      success: true,
      phase: 'COUNCIL_DELIBERATING',
      memberId: 'openai/gpt-5.2',
      outcome: 'stopped',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { invalidate, wrapper } = setup()
    const { result } = renderHook(() => useCouncilMemberControl(), { wrapper })

    result.current.mutate({ ticketId: TEST.ticketId, action: 'stop', phase: 'COUNCIL_DELIBERATING', memberId: 'openai/gpt-5.2' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // The ticket id holds a colon, so the path must be encoded segment by segment.
    expect(sentRequest(fetchMock)).toEqual({
      url: '/api/tickets/1%3ATEST-1/council/members/stop',
      method: 'POST',
      body: { phase: 'COUNCIL_DELIBERATING', memberId: 'openai/gpt-5.2' },
    })
    expect(result.current.data).toMatchObject({ outcome: 'stopped' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['ticket-artifacts', TEST.ticketId] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['ticket', TEST.ticketId] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['ticket-skips', TEST.ticketId] })
  })

  it('sends the PRD part with a retry', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { success: true, phase: 'DRAFTING_PRD', memberId: 'openai/gpt-5.2' }))
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = setup()
    const { result } = renderHook(() => useCouncilMemberControl(), { wrapper })

    result.current.mutate({ ticketId: TEST.ticketId, action: 'retry', phase: 'DRAFTING_PRD', memberId: 'openai/gpt-5.2', part: 'full_answers' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(sentRequest(fetchMock)).toEqual({
      url: '/api/tickets/1%3ATEST-1/council/members/retry',
      method: 'POST',
      body: { phase: 'DRAFTING_PRD', memberId: 'openai/gpt-5.2', part: 'full_answers' },
    })
  })

  it('leaves the part out of a retry that has none', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { success: true, phase: 'COUNCIL_VOTING_PRD', memberId: 'openai/gpt-5.2' }))
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = setup()
    const { result } = renderHook(() => useCouncilMemberControl(), { wrapper })

    result.current.mutate({ ticketId: TEST.ticketId, action: 'retry', phase: 'COUNCIL_VOTING_PRD', memberId: 'openai/gpt-5.2' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(sentRequest(fetchMock).body).toEqual({ phase: 'COUNCIL_VOTING_PRD', memberId: 'openai/gpt-5.2' })
  })

  it('surfaces the server refusal and still refreshes the artifacts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, {
      error: 'This step is no longer running.',
      code: 'STEP_NOT_RUNNING',
    })))
    const { invalidate, wrapper } = setup()
    const { result } = renderHook(() => useCouncilMemberControl(), { wrapper })

    result.current.mutate({ ticketId: TEST.ticketId, action: 'stop', phase: 'COUNCIL_DELIBERATING', memberId: 'openai/gpt-5.2' })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('Could not stop the model (HTTP 409: This step is no longer running.)')
    // A refusal means the screen is behind the server, so it reloads either way.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['ticket-artifacts', TEST.ticketId] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['ticket', TEST.ticketId] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['ticket-skips', TEST.ticketId] })
  })

  it('keeps the details of a failed stop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, {
      error: 'OpenCode did not confirm the session stopped',
      code: 'STOP_UNCONFIRMED',
      details: 'session ses_1 still busy',
    })))
    const { wrapper } = setup()
    const { result } = renderHook(() => useCouncilMemberControl(), { wrapper })

    result.current.mutate({ ticketId: TEST.ticketId, action: 'retry', phase: 'DRAFTING_BEADS', memberId: 'openai/gpt-5.2' })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe(
      'Could not restart the model (HTTP 500: OpenCode did not confirm the session stopped: session ses_1 still busy)',
    )
  })
})
