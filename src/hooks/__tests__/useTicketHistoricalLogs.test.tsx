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

  it('keeps two archived attempts apart when they reuse one milestone id', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{
          phase: 'CODING',
          entryId: 'milestone:CODING:started',
          phaseAttempt: 2,
          content: 'second attempt',
          timestamp: '2026-03-10T00:00:02.000Z',
        }],
        olderCursor: 'cursor-older',
        hasOlder: true,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{
          phase: 'CODING',
          entryId: 'milestone:CODING:started',
          phaseAttempt: 1,
          content: 'first attempt',
          timestamp: '2026-03-10T00:00:01.000Z',
        }],
        olderCursor: null,
        hasOlder: false,
      }))
    const client = createTestQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useTicketHistoricalLogs('ticket-1', {
      scope: 'phase', phase: 'CODING', view: 'overview',
    }), { wrapper })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(async () => { await result.current.fetchAllOlder() })

    // Folding on the bare entry id kept whichever page was applied last and dropped the
    // other attempt entirely.
    await waitFor(() => expect(result.current.entries).toHaveLength(2))
    expect(result.current.entries.map(entry => entry.phaseAttempt)).toEqual([1, 2])
    expect(result.current.entries.map(entry => entry.line)).toEqual(['[SYS] first attempt', '[SYS] second attempt'])
  })

  it('stops walking older pages once the caller cancels', async () => {
    // Bounded at five pages so an uncancelled walk still terminates: this has to fail on
    // its own assertion if the token is dropped, not by hanging the run.
    let page = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(() => {
        page += 1
        return createJsonResponse({
          entries: [{ phase: 'CODING', entryId: `page-${page}`, content: `row ${page}` }],
          olderCursor: page < 5 ? `cursor-${page}` : null,
          hasOlder: page < 5,
        })
      })
    const client = createTestQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useTicketHistoricalLogs('ticket-1', {
      scope: 'lifecycle', view: 'overview',
    }), { wrapper })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    const callsBeforeDrain = fetchSpy.mock.calls.length

    // Cancelled the moment the first page lands, standing in for a bead switch or an
    // unmount mid-walk.
    let cancelled = false
    await act(async () => {
      await result.current.fetchAllOlder(() => {
        const wasCancelled = cancelled
        cancelled = true
        return wasCancelled
      })
    })

    expect(fetchSpy.mock.calls.length).toBe(callsBeforeDrain + 1)
  })

  it('includes a bead filter in durable history requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(() => createJsonResponse({
        entries: [],
        olderCursor: null,
        hasOlder: false,
      }))
    const client = createTestQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    renderHook(() => useTicketHistoricalLogs('ticket-1', {
      scope: 'phase', phase: 'CODING', view: 'ai', beadId: 'bead-1',
    }), { wrapper })

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/tickets/ticket-1/logs?scope=phase&view=ai&limit=20&phase=CODING&beadId=bead-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
