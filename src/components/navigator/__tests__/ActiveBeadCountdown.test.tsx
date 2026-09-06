import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/renderHelpers'
import { ActiveBeadCountdown } from '../ActiveBeadCountdown'
import { COUNTDOWN_TICK_MS } from '@/lib/constants'

const NOW = new Date('2026-09-05T12:00:00.000Z')
const FIVE_MINUTES_MS = 5 * 60 * 1000

/**
 * The clock is frozen so the assertions are about which bead's `startedAt` the
 * component read, not about how long the test took to run.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

function startedSecondsAgo(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString()
}

describe('ActiveBeadCountdown', () => {
  it('shows the time left on the bead it was given', () => {
    renderWithProviders(
      <ActiveBeadCountdown startedAt={startedSecondsAgo(60)} perIterationTimeoutMs={FIVE_MINUTES_MS} />,
    )

    expect(screen.getByText('04:00')).toBeInTheDocument()
  })

  /**
   * The remaining time used to be computed only in the initial state and then in
   * the interval callback, so switching beads kept the previous bead's number on
   * screen for up to a whole tick.
   */
  it('recomputes immediately when the bead changes, without waiting for a tick', () => {
    const { rerender } = renderWithProviders(
      <ActiveBeadCountdown startedAt={startedSecondsAgo(60)} perIterationTimeoutMs={FIVE_MINUTES_MS} />,
    )
    expect(screen.getByText('04:00')).toBeInTheDocument()

    rerender(
      <ActiveBeadCountdown startedAt={startedSecondsAgo(240)} perIterationTimeoutMs={FIVE_MINUTES_MS} />,
    )

    // Before any timer has had the chance to fire.
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    expect(screen.getByText('01:00')).toBeInTheDocument()
  })

  it('counts down on each tick', () => {
    renderWithProviders(
      <ActiveBeadCountdown startedAt={startedSecondsAgo(60)} perIterationTimeoutMs={FIVE_MINUTES_MS} />,
    )

    act(() => { vi.advanceTimersByTime(COUNTDOWN_TICK_MS) })
    expect(screen.getByText('03:59')).toBeInTheDocument()
  })

  it('floors at zero rather than counting into negative time', () => {
    renderWithProviders(
      <ActiveBeadCountdown startedAt={startedSecondsAgo(600)} perIterationTimeoutMs={FIVE_MINUTES_MS} />,
    )

    expect(screen.getByText('00:00')).toBeInTheDocument()
  })

  it('renders nothing when there is no timeout to count against', () => {
    const { container } = renderWithProviders(
      <ActiveBeadCountdown startedAt={startedSecondsAgo(60)} perIterationTimeoutMs={0} />,
    )

    expect(container).toBeEmptyDOMElement()
  })
})
