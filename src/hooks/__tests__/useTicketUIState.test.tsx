import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
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

const { useTicketUIState } = await import('../useTickets')

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { wrapper }
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
})
