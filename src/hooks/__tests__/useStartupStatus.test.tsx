import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STARTUP_STATUS_QUERY_KEY,
  useDismissStartupRestoreNotice,
  useStartupStatus,
  type StartupStatus,
} from '../useStartupStatus'

const dismissedAt = '2026-11-08T12:00:00.000Z'

function makeStartupStatus(): StartupStatus {
  return {
    storage: {
      kind: 'restored',
      dbPath: '/home/user/.config/looptroop/app.sqlite',
      configDir: '/home/user/.config/looptroop',
      source: 'default',
      profileRestored: true,
      restoredProjectCount: 1,
      restoredProjects: [],
    },
    runtime: {
      isWsl: false,
      osLabel: 'Linux',
      appRoot: '/home/user/LoopTroop',
      appPathWarning: null,
    },
    ui: { restoreNotice: { shouldShow: true, dismissedAt: null } },
  }
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useDismissStartupRestoreNotice', () => {
  it('keeps the notice dismissed when the invalidation GET fails, even if an older GET resolves late', async () => {
    let startupGetCount = 0
    let resolveStaleGet!: (response: Response) => void
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/health/startup') {
        startupGetCount += 1
        if (startupGetCount === 2) {
          // Simulate an older in-flight read that ignores its abort signal.
          return new Promise<Response>((resolve) => { resolveStaleGet = resolve })
        }
        if (startupGetCount === 3) return Promise.resolve(new Response('{}', { status: 500 }))
        return Promise.resolve(new Response(JSON.stringify(makeStartupStatus()), { status: 200 }))
      }

      expect(init?.method).toBe('POST')
      return Promise.resolve(new Response(JSON.stringify({ success: true, dismissedAt }), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => ({
      status: useStartupStatus(),
      dismiss: useDismissStartupRestoreNotice(),
    }), { wrapper })

    await waitFor(() => expect(result.current.status.isSuccess).toBe(true))

    const staleRefetch = queryClient.invalidateQueries({ queryKey: STARTUP_STATUS_QUERY_KEY })
    await waitFor(() => expect(startupGetCount).toBe(2))

    await act(async () => {
      await result.current.dismiss.mutateAsync()
    })
    await waitFor(() => expect(result.current.status.isError).toBe(true))
    resolveStaleGet(new Response(JSON.stringify(makeStartupStatus()), { status: 200 }))
    await staleRefetch

    expect(queryClient.getQueryData<StartupStatus>(STARTUP_STATUS_QUERY_KEY)?.ui.restoreNotice)
      .toEqual({ shouldShow: false, dismissedAt })
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })
})
