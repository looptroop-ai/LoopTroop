import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

const rememberSpy = vi.fn()

vi.mock('@/lib/ticketUiStateRevision', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ticketUiStateRevision')>('@/lib/ticketUiStateRevision')
  return {
    ...actual,
    rememberTicketUiStateRevision: (...args: unknown[]) => {
      rememberSpy(...args)
      return (actual.rememberTicketUiStateRevision as (...a: unknown[]) => void)(...args)
    },
  }
})

const { useInterviewQuestions, useSaveTicketUIState, useTicketUIState } = await import('../useTickets')
const { flushTicketUiStateSnapshot } = await import('@/components/workspace/approvalHooks')

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

afterEach(() => {
  rememberSpy.mockReset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useTicketUIState', () => {
  it('records the revision once per fetch, not once per observer', async () => {
    // The revision used to be written inside `select`, which runs per observer
    // and again whenever its identity changes — so StrictMode's extra observer
    // alone double-wrote a module-level map that decides what
    // `expectedRevision` a later save sends.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ scope: 'approval_prd', exists: true, data: {}, updatedAt: null, revision: 4, clientRevision: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    const { wrapper } = setup()

    const { result } = renderHook(
      () => [
        useTicketUIState('1:UI-1', 'approval_prd'),
        useTicketUIState('1:UI-1', 'approval_prd'),
      ] as const,
      { wrapper },
    )

    await waitFor(() => expect(result.current[0].isSuccess).toBe(true))
    await waitFor(() => expect(result.current[1].isSuccess).toBe(true))

    expect(rememberSpy).toHaveBeenCalledTimes(1)
    expect(rememberSpy).toHaveBeenCalledWith('1:UI-1', 'approval_prd', 4)
  })

  it('records nothing when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    const { wrapper } = setup()

    const { result } = renderHook(() => useTicketUIState('1:UI-1', 'approval_prd'), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(rememberSpy).not.toHaveBeenCalled()
  })

  it('keeps a newer normal save in cache when an older keepalive body resolves later', async () => {
    const ticketId = '1:UI-order'
    const scope = 'approval_prd'
    let putCount = 0
    let releaseOldBody!: (value: unknown) => void
    const oldBody = new Promise(resolve => { releaseOldBody = resolve })
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        putCount += 1
        if (putCount === 1) return { ok: true, json: () => oldBody } as Response
        return new Response(JSON.stringify({
          success: true,
          conflict: false,
          scope,
          exists: true,
          data: { value: 'new' },
          updatedAt: null,
          revision: 9,
          clientRevision: 9,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        scope,
        exists: true,
        data: { value: 'old' },
        updatedAt: null,
        revision: 8,
        clientRevision: 8,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { client, wrapper } = setup()

    const firstMount = renderHook(() => useTicketUIState(ticketId, scope), { wrapper })
    await waitFor(() => expect(firstMount.result.current.isSuccess).toBe(true))

    flushTicketUiStateSnapshot(ticketId, scope, { value: 'old' }, { queryClient: client })
    await act(async () => { await Promise.resolve() })
    firstMount.unmount()

    const remount = renderHook(() => useTicketUIState(ticketId, scope), { wrapper })
    await waitFor(() => expect(remount.result.current.isSuccess).toBe(true))
    expect(client.getQueryData<{ revision?: number }>(['ticket-ui-state', ticketId, scope])?.revision).toBe(8)

    const save = renderHook(() => useSaveTicketUIState(), { wrapper })
    await act(async () => {
      await save.result.current.mutateAsync({ ticketId, scope, data: { value: 'new' } })
    })
    expect(client.getQueryData<{ data?: unknown; revision?: number }>(['ticket-ui-state', ticketId, scope])).toMatchObject({
      data: { value: 'new' },
      revision: 9,
    })

    await act(async () => {
      releaseOldBody({ conflict: false, revision: 8 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(client.getQueryData<{ data?: unknown; revision?: number }>(['ticket-ui-state', ticketId, scope])).toMatchObject({
      data: { value: 'new' },
      revision: 9,
    })

    save.unmount()
    remount.unmount()
  })

  it('carries failed flush provenance through an absent-state remount', async () => {
    const ticketId = '1:UI-remount'
    const scope = 'approval_prd'
    let reads = 0
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        throw new Error('keepalive body is too large')
      }
      reads += 1
      if (reads === 1) {
        return new Response(JSON.stringify({
          scope,
          exists: false,
          data: null,
          updatedAt: null,
          revision: 0,
          clientRevision: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        scope,
        exists: false,
        data: null,
        updatedAt: null,
        revision: 7,
        clientRevision: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { client, wrapper } = setup()

    const firstMount = renderHook(() => useTicketUIState(ticketId, scope), { wrapper })
    await waitFor(() => expect(firstMount.result.current.isSuccess).toBe(true))
    flushTicketUiStateSnapshot(ticketId, scope, { value: 'retained' }, { queryClient: client })
    firstMount.unmount()

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(client.getQueryData<Record<string, unknown>>(['ticket-ui-state', ticketId, scope])).toMatchObject({
      data: { value: 'retained' },
      flushPending: false,
      flushFailed: true,
    })

    const remount = renderHook(() => useTicketUIState(ticketId, scope), { wrapper })
    await waitFor(() => expect(remount.result.current.isFetching).toBe(false))
    expect(client.getQueryData<Record<string, unknown>>(['ticket-ui-state', ticketId, scope])).toMatchObject({
      data: { value: 'retained' },
      flushPending: false,
      flushFailed: true,
    })
    expect(rememberSpy).toHaveBeenLastCalledWith(ticketId, scope, 7)

    remount.unmount()
  })

  it('passes the predecessor revision to a queued normal save', async () => {
    const ticketId = '1:UI-queue'
    const scope = 'approval_prd'
    let releaseFirst!: (response: Response) => void
    const requestBodies: Array<{ expectedRevision: number }> = []
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as { expectedRevision: number })
      if (requestBodies.length === 1) {
        return new Promise<Response>((resolve) => { releaseFirst = resolve })
      }
      return new Response(JSON.stringify({ success: true, revision: 2, clientRevision: 2 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = setup()
    const hook = renderHook(() => useSaveTicketUIState(), { wrapper })

    let first!: Promise<unknown>
    let second!: Promise<unknown>
    act(() => {
      first = hook.result.current.mutateAsync({ ticketId, scope, data: { value: 'A' } })
    })
    await waitFor(() => expect(releaseFirst).toBeDefined())
    act(() => {
      second = hook.result.current.mutateAsync({ ticketId, scope, data: { value: 'B' } })
    })
    await act(async () => {
      releaseFirst(new Response(JSON.stringify({ success: true, revision: 1, clientRevision: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      await Promise.all([first, second])
    })

    expect(requestBodies.map(({ expectedRevision }) => expectedRevision)).toEqual([0, 1])
    hook.unmount()
  })
})

describe('useInterviewQuestions', () => {
  it('defaults to enabled when there is a ticket', async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = setup()

    renderHook(() => useInterviewQuestions('1:UI-1'), { wrapper })

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/api/tickets/1%3AUI-1/interview')
  })

  it('stays off when the caller says it does not want an interview', async () => {
    // The read-only approval view renders PRD and bead attempts too, and the
    // interview endpoint says nothing about either.
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = setup()

    const { result } = renderHook(() => useInterviewQuestions('1:UI-1', { enabled: false }), { wrapper })

    expect(result.current.fetchStatus).toBe('idle')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('stays off without a ticket', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = setup()

    renderHook(() => useInterviewQuestions(''), { wrapper })

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
