import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getTicketArtifactsQueryKey,
  useTicketArtifacts,
  type DBartifact,
} from '../useTicketArtifacts'

const ticketId = '1:ART-1'

function artifact(content = 'durable content'): DBartifact {
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
})
