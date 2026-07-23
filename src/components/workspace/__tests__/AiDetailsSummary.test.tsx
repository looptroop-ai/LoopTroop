import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TicketAiDetails } from '@/hooks/useTicketAiDetails'
import { AiDetailsSummary } from '../AiDetailsSummary'

const details: TicketAiDetails = {
  scope: 'phase',
  phase: 'CODING',
  phaseAttempt: 1,
  modelId: null,
  summary: {
    turns: 4,
    sessions: 2,
    costUsd: 0.125,
    tokens: {
      total: 1_234,
      input: 1_000,
      output: 200,
      reasoning: 34,
      cacheRead: 100,
      cacheWrite: 0,
    },
    timingMs: { total: 65_000, average: 16_250, longest: 22_000 },
    coverage: { costTurns: 3, tokenTurns: 4, timingTurns: 2 },
  },
  updatedAt: '2026-07-23T10:00:00.000Z',
}

describe('AiDetailsSummary', () => {
  it('renders aggregate values and warns when provider coverage is partial', () => {
    render(
      <AiDetailsSummary
        details={details}
        isLoading={false}
        isError={false}
        isFetching={false}
        scope="phase"
        onRetry={vi.fn()}
      />,
    )

    expect(screen.getByText('All AI models')).toBeInTheDocument()
    expect(screen.getByText('$0.125')).toBeInTheDocument()
    expect(screen.getByText('1,234')).toBeInTheDocument()
    expect(screen.getByText('1m 5s')).toBeInTheDocument()
    expect(screen.getByText(/Partial provider data/)).toHaveTextContent('Cost 3/4')
  })

  it('renders empty and retry states', () => {
    const onRetry = vi.fn()
    const { rerender } = render(
      <AiDetailsSummary
        isLoading={false}
        isError={false}
        isFetching={false}
        scope="lifecycle"
        onRetry={onRetry}
      />,
    )
    expect(screen.getByText(/No completed AI turns/)).toBeInTheDocument()

    rerender(
      <AiDetailsSummary
        isLoading={false}
        isError
        isFetching={false}
        scope="lifecycle"
        onRetry={onRetry}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
