import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RawArtifactBlock } from '../RawArtifactBlock'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('RawArtifactBlock', () => {
  it('shows raw statistics and copies the original artifact payload', async () => {
    const payload = JSON.stringify({ answer: 'First line\nSecond line' })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    const { container } = render(
      <TooltipProvider>
        <RawArtifactBlock content={payload} emptyLabel="No artifact available." />
      </TooltipProvider>,
    )

    const copyButton = screen.getByRole('button', { name: 'Copy raw output' })
    expect(screen.getByText(/Lines/)).toBeInTheDocument()
    expect(copyButton.parentElement?.parentElement).toHaveClass('items-start')
    expect(container.querySelector('pre')).toHaveTextContent('answer: |-')

    fireEvent.click(copyButton)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(payload))
  })

  it('keeps the caller empty state when no artifact is available', () => {
    render(<RawArtifactBlock content="" emptyLabel="No artifact available." />)

    expect(screen.getByText('No artifact available.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy raw output' })).not.toBeInTheDocument()
  })
})
