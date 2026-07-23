import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJsonResponse, createTestQueryClient } from '@/test/renderHelpers'
import { useTicketHistoricalLogs } from '../useTicketHistoricalLogs'
import { SERVER_LOG_REFRESH_EVENT } from '@/context/logUtils'

describe('useTicketHistoricalLogs', () => {
  afterEach(() => vi.restoreAllMocks())

  it('requests 20 newest rows, then pages upward in batches of 250 with the returned cursor', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'new', content: 'new', timestamp: '2026-03-10T00:00:02.000Z' }],
        olderCursor: 'cursor-older',
        hasOlder: true,
        totalEntries: 2000,
        totalTextLines: 4821,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'old', content: 'old', timestamp: '2026-03-10T00:00:01.000Z' }],
        olderCursor: null,
        hasOlder: false,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'recovered', content: 'recovered', timestamp: '2026-03-10T00:00:03.000Z' }],
        olderCursor: 'cursor-older',
        hasOlder: true,
        totalEntries: 2001,
        totalTextLines: 4822,
      }))
    const client = createTestQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useTicketHistoricalLogs('ticket-1', {
      scope: 'phase', phase: 'CODING', phaseAttempt: 2, view: 'overview',
    }), { wrapper })

    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['new']))
    expect(result.current.totalEntries).toBe(2000)
    expect(result.current.totalTextLines).toBe(4821)
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      '/api/tickets/ticket-1/logs?scope=phase&view=overview&limit=20&phase=CODING&phaseAttempt=2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    await act(async () => { await result.current.fetchOlder() })
    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['old', 'new']))
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      '/api/tickets/ticket-1/logs?scope=phase&view=overview&limit=250&phase=CODING&phaseAttempt=2&before=cursor-older',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    act(() => window.dispatchEvent(new CustomEvent(SERVER_LOG_REFRESH_EVENT, { detail: { ticketId: 'ticket-1' } })))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['recovered']))
    expect(result.current.totalEntries).toBe(2001)
    expect(result.current.totalTextLines).toBe(4822)
  })

  it('loads every older cursor page for explicit navigation to the true beginning', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'new', content: 'new' }],
        olderCursor: 'cursor-2',
        hasOlder: true,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'middle', content: 'middle' }],
        olderCursor: 'cursor-1',
        hasOlder: true,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{ phase: 'CODING', entryId: 'old', content: 'old' }],
        olderCursor: null,
        hasOlder: false,
      }))
    const client = createTestQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useTicketHistoricalLogs('ticket-1', {
      scope: 'lifecycle', view: 'overview',
    }), { wrapper })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(async () => { await result.current.fetchAllOlder() })

    await waitFor(() => expect(result.current.entries.map(entry => entry.entryId)).toEqual(['new', 'middle', 'old']))
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      '/api/tickets/ticket-1/logs?scope=lifecycle&view=overview&limit=250&before=cursor-2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      '/api/tickets/ticket-1/logs?scope=lifecycle&view=overview&limit=250&before=cursor-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
