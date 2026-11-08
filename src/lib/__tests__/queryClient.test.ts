import { onlineManager } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryClient } from '../queryClient'

afterEach(() => {
  onlineManager.setOnline(true)
  queryClient.clear()
  vi.restoreAllMocks()
})

describe('queryClient', () => {
  it('tries local API queries and mutations while the browser reports offline', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ))
    onlineManager.setOnline(false)

    await expect(queryClient.fetchQuery({
      queryKey: ['offline-local-api-query'],
      queryFn: async () => (await fetch('/api/local-status')).json() as Promise<{ ok: boolean }>,
    })).resolves.toEqual({ ok: true })

    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => (await fetch('/api/local-action', { method: 'POST' })).json() as Promise<{ ok: boolean }>,
    })
    await expect(mutation.execute(undefined)).resolves.toEqual({ ok: true })

    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      '/api/local-status',
      '/api/local-action',
    ])
  })
})
