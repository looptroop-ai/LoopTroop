import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJsonResponse, createTestQueryClient } from '@/test/renderHelpers'
import { useTicketAiDetails } from '../useTicketAiDetails'

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useTicketAiDetails', () => {
  it('does not request details until enabled', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    renderHook(
      () => useTicketAiDetails('ticket-1', { scope: 'phase', phase: 'CODING', phaseAttempt: 2 }, false),
      { wrapper },
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('requests the selected phase attempt and model', async () => {
    const payload = {
      scope: 'phase',
      phase: 'CODING',
      phaseAttempt: 2,
      modelId: 'openai/gpt-5.4',
      summary: {
        turns: 2,
        sessions: 1,
        costUsd: 0.1,
        tokens: { total: 100, input: 80, output: 20, reasoning: 0, cacheRead: 5, cacheWrite: 0 },
        timingMs: { total: 3000, average: 1500, longest: 2000 },
        coverage: { costTurns: 2, tokenTurns: 2, timingTurns: 2 },
      },
      updatedAt: '2026-07-23T10:00:00.000Z',
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => createJsonResponse(payload))

    const { result } = renderHook(
      () => useTicketAiDetails('ticket/1', {
        scope: 'phase',
        phase: 'CODING',
        phaseAttempt: 2,
        modelId: 'openai/gpt-5.4',
      }, true),
      { wrapper },
    )

    await waitFor(() => expect(result.current.data).toEqual(payload))
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/tickets/ticket%2F1/ai-details?scope=phase&phase=CODING&phaseAttempt=2&modelId=openai%2Fgpt-5.4',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
