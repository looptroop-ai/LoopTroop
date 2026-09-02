import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSavePrompt } from '../usePrompts'

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, invalidate, wrapper }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useSavePrompt', () => {
  it('does not refetch after a rejected save', async () => {
    // A rejected save changed nothing on disk, so a refetch only pushes the
    // server's copy back into the editor — and the reset effect then discards
    // the draft the person is still fixing.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, {
      errors: ['unknown variable {{foo}}'],
      warnings: [],
    })))
    const { invalidate, wrapper } = setup()
    const { result } = renderHook(() => useSavePrompt(), { wrapper })

    result.current.mutate({ id: 'prd', source: 'broken' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.errors).toEqual(['unknown variable {{foo}}'])
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('refetches the catalog and the prompt after a clean save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { errors: [], warnings: [], modified: true })))
    const { invalidate, wrapper } = setup()
    const { result } = renderHook(() => useSavePrompt(), { wrapper })

    result.current.mutate({ id: 'prd', source: 'fixed' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['prompts'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['prompt', 'prd'] })
  })

  it('describes a failure with no structured payload instead of hiding the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502 })))
    const { wrapper } = setup()
    const { result } = renderHook(() => useSavePrompt(), { wrapper })

    result.current.mutate({ id: 'prd', source: 'anything' })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('Failed to save prompt (HTTP 502: Bad Gateway)')
  })
})
