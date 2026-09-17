import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOG_STORAGE_PREFIX } from '@/context/logUtils'
import { createTestQueryClient } from '@/test/renderHelpers'
import { getTicketArtifactsQueryKey } from '../useTicketArtifacts'
import { useCreateProject, useDeleteProject } from '../useProjects'

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    )
  }
}

const TEST_PROJECT_ROOT = '/projects/test-restored-project'
const DELETED_TICKET_ID = 'test-ticket-1'
const KEPT_TICKET_ID = 'test-ticket-2'

describe('useProjects', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('invalidates tickets as well as projects after creating or restoring a project', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: 7,
        name: 'Restored Project',
      }),
    })))

    const queryClient = createTestQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useCreateProject(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      await result.current.mutateAsync({
        name: 'Restored Project',
        shortname: 'RST',
        folderPath: TEST_PROJECT_ROOT,
      })
    })

    expect(fetch).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
      method: 'POST',
    }))
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tickets'] })
  })

  it('removes deleted-project tickets from cache and clears their related state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        projectRoot: TEST_PROJECT_ROOT,
      }),
    })))

    const queryClient = createTestQueryClient()
    const deletedProjectId = 7
    const deletedTicketId = DELETED_TICKET_ID
    const keptTicketId = KEPT_TICKET_ID
    const deletedTicket = { id: deletedTicketId, projectId: deletedProjectId, title: 'Deleted ticket' }
    const keptTicket = { id: keptTicketId, projectId: 8, title: 'Kept ticket' }

    queryClient.setQueryData(['tickets'], [deletedTicket, keptTicket])
    queryClient.setQueryData(['tickets', { projectId: deletedProjectId }], [deletedTicket])
    queryClient.setQueryData(['tickets', { projectId: 8 }], [keptTicket])
    queryClient.setQueryData(['ticket', deletedTicketId], deletedTicket)
    queryClient.setQueryData(['ticket', keptTicketId], keptTicket)
    queryClient.setQueryData(['interview', deletedTicketId], { questions: [] })
    queryClient.setQueryData(['ticket-ui-state', deletedTicketId, 'workspace'], { scope: 'workspace' })
    queryClient.setQueryData(getTicketArtifactsQueryKey(deletedTicketId), [
      { id: 1, ticketId: deletedTicketId, phase: 'DRAFT', artifactType: 'note', filePath: null, content: null, createdAt: '2026-04-07T10:00:00.000Z' },
    ])

    localStorage.setItem(`${LOG_STORAGE_PREFIX}${deletedTicketId}-DRAFT`, JSON.stringify([{ line: 'hello' }]))
    localStorage.setItem(`error-seen-${deletedTicketId}`, 'seen')

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useDeleteProject(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      await result.current.mutateAsync(deletedProjectId)
    })

    await waitFor(() => {
      expect(queryClient.getQueryData(['tickets'])).toEqual([keptTicket])
    })

    expect(queryClient.getQueryData(['tickets', { projectId: deletedProjectId }])).toEqual([])
    expect(queryClient.getQueryData(['tickets', { projectId: 8 }])).toEqual([keptTicket])
    expect(queryClient.getQueryData(['ticket', deletedTicketId])).toBeUndefined()
    expect(queryClient.getQueryData(['ticket', keptTicketId])).toEqual(keptTicket)
    expect(queryClient.getQueryData(['interview', deletedTicketId])).toBeUndefined()
    expect(queryClient.getQueryData(['ticket-ui-state', deletedTicketId, 'workspace'])).toBeUndefined()
    expect(queryClient.getQueryData(getTicketArtifactsQueryKey(deletedTicketId))).toBeUndefined()
    expect(localStorage.getItem(`${LOG_STORAGE_PREFIX}${deletedTicketId}-DRAFT`)).toBeNull()
    expect(localStorage.getItem(`error-seen-${deletedTicketId}`)).toBeNull()
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tickets'] })
  })

  it('matches project ticket ids without numeric coercion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })))

    const queryClient = createTestQueryClient()
    queryClient.setQueryData(['ticket', '1:EXACT-1'], { id: '1:EXACT-1' })
    queryClient.setQueryData(['ticket', '1e0:OTHER-1'], { id: '1e0:OTHER-1' })
    queryClient.setQueryData(['ticket', ' 1 :OTHER-2'], { id: ' 1 :OTHER-2' })

    const { result } = renderHook(() => useDeleteProject(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => { await result.current.mutateAsync(1) })

    expect(queryClient.getQueryData(['ticket', '1:EXACT-1'])).toBeUndefined()
    expect(queryClient.getQueryData(['ticket', '1e0:OTHER-1'])).toEqual({ id: '1e0:OTHER-1' })
    expect(queryClient.getQueryData(['ticket', ' 1 :OTHER-2'])).toEqual({ id: ' 1 :OTHER-2' })
  })
})
