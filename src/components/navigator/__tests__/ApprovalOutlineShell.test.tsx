import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/renderHelpers'
import { ApprovalOutlineShell } from '../ApprovalOutlineShell'

/**
 * The four-way decision the four approval navigators used to make separately.
 *
 * The precedence is the point rather than the markup: PR-07's fix was that a
 * failed request must not render as an outline with nothing in it, and that fix
 * had to be repeated in each navigator. Here it is one branch, so it is tested
 * once — including the case that made it necessary, a failure whose stale
 * `children` are still in hand.
 */
function renderShell(overrides: Partial<Parameters<typeof ApprovalOutlineShell>[0]> = {}) {
  const onRetry = vi.fn()
  const result = renderWithProviders(
    <ApprovalOutlineShell
      title="Beads outline"
      isLoading={false}
      isError={false}
      error={null}
      onRetry={onRetry}
      loadingMessage="Loading beads outline…"
      errorTitle="Could not load the beads outline"
      emptyMessage={null}
      {...overrides}
    >
      <div>the outline itself</div>
    </ApprovalOutlineShell>,
  )
  return { ...result, onRetry }
}

describe('ApprovalOutlineShell', () => {
  it('renders the outline once the request has succeeded and there is something to show', () => {
    renderShell()

    expect(screen.getByText('the outline itself')).toBeInTheDocument()
    expect(screen.getByText('Beads outline')).toBeInTheDocument()
  })

  it('shows the loading sentence instead of the outline while the request is in flight', () => {
    renderShell({ isLoading: true })

    expect(screen.getByText('Loading beads outline…')).toBeInTheDocument()
    expect(screen.queryByText('the outline itself')).not.toBeInTheDocument()
  })

  /**
   * The reason the shell exists. A failed request leaves whatever was last
   * rendered in `children`, and every navigator that fell through to it showed
   * an outline that looked merely empty — no error, no retry, nothing to say the
   * data was stale.
   */
  it('shows the failure and a retry rather than an outline, even with children in hand', () => {
    const { onRetry } = renderShell({ isError: true, error: new Error('offline') })

    expect(screen.getByText('Could not load the beads outline')).toBeInTheDocument()
    expect(screen.queryByText('the outline itself')).not.toBeInTheDocument()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('shows the empty sentence when the request succeeded but the outline is not ready', () => {
    renderShell({ emptyMessage: 'No beads yet.' })

    expect(screen.getByText('No beads yet.')).toBeInTheDocument()
    expect(screen.queryByText('the outline itself')).not.toBeInTheDocument()
  })

  it('renders header badges beside the title', () => {
    renderShell({ headerBadges: <span>12 beads</span> })

    expect(screen.getByText('12 beads')).toBeInTheDocument()
  })
})
