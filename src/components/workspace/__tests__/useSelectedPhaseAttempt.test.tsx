import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTicketPhaseAttemptsQueryKey } from '@/hooks/useTicketPhaseAttempts'
import { useSelectedPhaseAttempt } from '../useSelectedPhaseAttempt'

const phase = 'SCANNING_RELEVANT_FILES'

function attempts(ticketId: string, attemptPhase = phase) {
  return [
    { ticketId, phase: attemptPhase, attemptNumber: 1, state: 'active', archivedReason: null, createdAt: '', archivedAt: null },
    { ticketId, phase: attemptPhase, attemptNumber: 2, state: 'archived', archivedReason: 'retried', createdAt: '', archivedAt: '' },
  ]
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useSelectedPhaseAttempt', () => {
  it('resets a manual attempt selection when the ticket changes within the same phase', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const ticketId = decodeURIComponent(String(input).split('/api/tickets/')[1]?.split('/')[0] ?? '')
      return new Response(JSON.stringify(attempts(ticketId)), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result, rerender } = renderHook(
      ({ ticketId }: { ticketId: string }) => useSelectedPhaseAttempt(ticketId, phase),
      { initialProps: { ticketId: 'ticket-one' }, wrapper },
    )

    await waitFor(() => expect(result.current.selectedAttempt?.attemptNumber).toBe(1))
    act(() => result.current.setManualSelectedAttemptNumber(2))
    expect(result.current.selectedAttempt?.attemptNumber).toBe(2)

    client.setQueryData(getTicketPhaseAttemptsQueryKey('ticket-two', phase), attempts('ticket-two'))
    rerender({ ticketId: 'ticket-two' })
    expect(result.current.selectedAttempt?.attemptNumber).toBe(1)
  })

  it('drops an archived selection after visiting another phase', async () => {
    const otherPhase = 'DRAFTING_PRD'
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(getTicketPhaseAttemptsQueryKey('ticket-one', phase), attempts('ticket-one'))
    client.setQueryData(getTicketPhaseAttemptsQueryKey('ticket-one', otherPhase), attempts('ticket-one', otherPhase))
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result, rerender } = renderHook(
      ({ currentPhase }: { currentPhase: string }) => useSelectedPhaseAttempt('ticket-one', currentPhase),
      { initialProps: { currentPhase: phase }, wrapper },
    )

    await waitFor(() => expect(result.current.selectedAttempt?.attemptNumber).toBe(1))
    act(() => result.current.setManualSelectedAttemptNumber(2))
    expect(result.current.selectedAttempt?.attemptNumber).toBe(2)

    rerender({ currentPhase: otherPhase })
    await waitFor(() => expect(result.current.selectedAttempt?.attemptNumber).toBe(1))
    rerender({ currentPhase: phase })
    expect(result.current.selectedAttempt?.attemptNumber).toBe(1)
  })
})
