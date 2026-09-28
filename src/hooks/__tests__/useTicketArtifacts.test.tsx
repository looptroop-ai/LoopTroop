import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearTicketArtifactsCache,
  getTicketArtifactsQueryKey,
  useTicketArtifactBundle,
  useTicketArtifacts,
  type TicketArtifact,
} from '../useTicketArtifacts'

const ticketId = '1:ART-1'

function artifact(content = 'durable content'): TicketArtifact {
  return {
    id: 1,
    ticketId,
    phase: 'COUNCIL_VOTING_PRD',
    phaseAttempt: 1,
    artifactType: 'prd_votes',
    filePath: null,
    content,
    createdAt: '2026-08-21T10:00:00.000Z',
    updatedAt: '2026-08-21T10:00:00.000Z',
  }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useTicketArtifacts', () => {
  it('keeps data undefined while loading and accepts a confirmed empty result', async () => {
    let resolveFetch!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve })))
    const { wrapper } = setup()
    const { result } = renderHook(() => useTicketArtifacts(ticketId), { wrapper })

    expect(result.current.artifacts).toBeUndefined()
    expect(result.current.status).toBe('loading')

    await act(async () => resolveFetch(new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.artifacts).toEqual([])
  })

  it('reports detailed HTTP and malformed-response failures instead of empty data', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'database busy' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = setup()
    const { result } = renderHook(() => useTicketArtifacts(ticketId), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.artifacts).toBeUndefined()
    expect(result.current.error).toEqual(expect.objectContaining({
      message: 'Failed to load ticket artifacts (HTTP 503: database busy)',
    }))

    await act(async () => { await result.current.refetch() })
    await waitFor(() => expect(result.current.error).toEqual(expect.objectContaining({
      message: 'Failed to load ticket artifacts: invalid response',
    })))
    expect(result.current.error).toEqual(expect.objectContaining({
      message: 'Failed to load ticket artifacts: invalid response',
    }))
  })

  it('keeps successful cached content visible when a background refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })))
    const { client, wrapper } = setup()
    client.setQueryData(getTicketArtifactsQueryKey(ticketId), [artifact()])

    const { result } = renderHook(() => useTicketArtifacts(ticketId), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('error'))

    expect(result.current.artifacts).toEqual([artifact()])
    expect(result.current.isError).toBe(true)
  })

  it('recovers a failed or stale-empty query when retried', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'busy' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([artifact('recovered')]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = setup()
    const { result } = renderHook(() => useTicketArtifacts(ticketId), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('error'))
    await act(async () => { await result.current.refetch() })

    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.artifacts?.[0]?.content).toBe('recovered')
  })

  it('stays idle without a ticket or when fetching is skipped', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = setup()
    const { result, rerender } = renderHook(
      ({ id, skipFetch }: { id?: string; skipFetch?: boolean }) => useTicketArtifacts(id, { skipFetch }),
      { initialProps: { id: undefined as string | undefined, skipFetch: false }, wrapper },
    )

    expect(result.current.status).toBe('idle')
    expect(result.current.artifacts).toBeUndefined()

    rerender({ id: ticketId, skipFetch: true })
    expect(result.current.status).toBe('idle')
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isFetching).toBe(false)
    expect(result.current.isError).toBe(false)
    expect(result.current.error).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('normalizes optional artifact fields and rejects invalid artifact records', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response([
        {
          id: '12',
          phase: 'PLAN',
          phaseAttempt: '3',
          artifactType: null,
          createdAt: 'created',
          filePath: 7,
          content: 7,
        },
        {
          id: 13,
          ticketId: 42,
          phase: 'PLAN',
          phaseAttempt: '0',
          artifactType: 'note',
          createdAt: 'created',
          updatedAt: 7,
        },
      ]))
      .mockResolvedValueOnce(response([{ id: 'not-an-id', phase: 'PLAN' }])))
    const { wrapper } = setup()
    const { result } = renderHook(() => useTicketArtifacts(ticketId), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.artifacts).toEqual([
      {
        id: 12,
        ticketId,
        phase: 'PLAN',
        phaseAttempt: 3,
        artifactType: '',
        filePath: null,
        content: null,
        createdAt: 'created',
        updatedAt: 'created',
      },
      {
        id: 13,
        ticketId,
        phase: 'PLAN',
        phaseAttempt: 1,
        artifactType: 'note',
        filePath: null,
        content: null,
        createdAt: 'created',
        updatedAt: 'created',
      },
    ])

    await act(async () => { await result.current.refetch() })
    await waitFor(() => expect(result.current.error).toEqual(expect.objectContaining({
      message: 'Failed to load ticket artifacts: invalid artifact record',
    })))
  })
})

describe('ticket artifact query helpers', () => {
  it('uses only valid attempt scopes and removes every cached scope for one ticket', () => {
    expect(getTicketArtifactsQueryKey(ticketId)).toEqual([
      'ticket-artifacts', ticketId, '__all__', 'active',
    ])
    expect(getTicketArtifactsQueryKey(ticketId, { phase: 'PLAN', phaseAttempt: 2 })).toEqual([
      'ticket-artifacts', ticketId, 'PLAN', 2,
    ])
    expect(getTicketArtifactsQueryKey(ticketId, { phase: 'PLAN', phaseAttempt: Number.POSITIVE_INFINITY })).toEqual([
      'ticket-artifacts', ticketId, 'PLAN', 'active',
    ])

    const client = new QueryClient()
    client.setQueryData(getTicketArtifactsQueryKey(ticketId), [artifact()])
    client.setQueryData(getTicketArtifactsQueryKey(ticketId, { phase: 'PLAN' }), [artifact()])
    client.setQueryData(getTicketArtifactsQueryKey('other-ticket'), [artifact()])

    clearTicketArtifactsCache(client, ticketId)

    expect(client.getQueryData(getTicketArtifactsQueryKey(ticketId))).toBeUndefined()
    expect(client.getQueryData(getTicketArtifactsQueryKey(ticketId, { phase: 'PLAN' }))).toBeUndefined()
    expect(client.getQueryData(getTicketArtifactsQueryKey('other-ticket'))).toEqual([artifact()])
  })
})

describe('useTicketArtifactBundle', () => {
  it('deduplicates requested scopes and merges artifact ids across successful scopes', async () => {
    const fetchMock = vi.fn((url: string) => {
      const phase = new URL(url, 'http://localhost').searchParams.get('phase')
      return Promise.resolve(response(phase === 'PLAN'
        ? [artifact('first scope')]
        : [{ ...artifact('second scope'), id: 2 }, { ...artifact('duplicate'), id: 1 }]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = setup()
    const scopes = [
      { phase: 'PLAN', phaseAttempt: 2 },
      { phase: 'BUILD' },
      { phase: 'PLAN', phaseAttempt: 2 },
    ]
    const { result } = renderHook(() => useTicketArtifactBundle(ticketId, scopes), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('success'))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      `/api/tickets/${encodeURIComponent(ticketId)}/artifacts?phase=BUILD`,
      `/api/tickets/${encodeURIComponent(ticketId)}/artifacts?phase=PLAN&phaseAttempt=2`,
    ].sort())
    expect(result.current.artifacts).toEqual([
      { ...artifact('duplicate'), id: 1 },
      { ...artifact('second scope'), id: 2 },
    ])
    expect(result.current.isError).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('keeps artifacts unavailable until each requested scope has data', async () => {
    let resolveBuild!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const phase = new URL(url, 'http://localhost').searchParams.get('phase')
      return phase === 'PLAN'
        ? Promise.resolve(response([artifact()]))
        : new Promise<Response>((resolve) => { resolveBuild = resolve })
    }))
    const { client, wrapper } = setup()
    const scopes = [{ phase: 'PLAN' }, { phase: 'BUILD' }]
    const { result } = renderHook(() => useTicketArtifactBundle(ticketId, scopes), { wrapper })

    await waitFor(() => expect(client.getQueryData(getTicketArtifactsQueryKey(ticketId, { phase: 'PLAN' }))).toEqual([artifact()]))
    expect(result.current.artifacts).toBeUndefined()
    expect(result.current.status).toBe('loading')

    await act(async () => resolveBuild(response([{ ...artifact('built'), id: 2 }])))
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.artifacts).toHaveLength(2)
  })

  it('stays idle and does not fetch when ticket or scopes are missing', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = setup()
    const { result, rerender } = renderHook(
      ({ id, scopes }: { id?: string; scopes: Array<{ phase: string }> }) => useTicketArtifactBundle(id, scopes),
      { initialProps: { id: undefined as string | undefined, scopes: [{ phase: 'PLAN' }] }, wrapper },
    )

    expect(result.current.status).toBe('idle')
    expect(result.current.artifacts).toBeUndefined()
    rerender({ id: ticketId, scopes: [] })
    expect(result.current.status).toBe('idle')
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isFetching).toBe(false)
    expect(result.current.isError).toBe(false)
    expect(result.current.error).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a failed scope and refetches the whole bundle', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([artifact()]))
      .mockResolvedValueOnce(response({ error: 'busy' }, 503))
      .mockResolvedValueOnce(response([artifact('retried')]))
      .mockResolvedValueOnce(response([{ ...artifact('built'), id: 2 }]))
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = setup()
    const scopes = [{ phase: 'PLAN' }, { phase: 'BUILD' }]
    const { result } = renderHook(() => useTicketArtifactBundle(ticketId, scopes), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.isError).toBe(true)
    expect(result.current.error).toEqual(expect.objectContaining({
      message: 'Failed to load ticket artifacts (HTTP 503: busy)',
    }))
    expect(result.current.artifacts).toBeUndefined()

    await act(async () => { await result.current.refetch() })
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.artifacts?.map(({ content }) => content)).toEqual(['retried', 'built'])
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
