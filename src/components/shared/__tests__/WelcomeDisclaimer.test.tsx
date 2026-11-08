import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WelcomeDisclaimer } from '../WelcomeDisclaimer'

afterEach(cleanup)

describe('WelcomeDisclaimer', () => {
  it('keeps a long startup warning and the continue button reachable', () => {
    render(
      <WelcomeDisclaimer
        open
        onDismiss={vi.fn()}
        appPathWarning={'Long startup warning. '.repeat(100)}
      />,
    )

    const panel = screen.getByRole('dialog', { name: 'Welcome to LoopTroop' })

    expect(panel).toHaveAttribute('aria-modal', 'true')
    expect(panel).toHaveClass('my-auto', 'max-h-[calc(100dvh-2rem)]', 'overflow-y-auto', 'flex', 'flex-col')
    expect(screen.getByRole('region', { name: 'Welcome to LoopTroop' })).toHaveClass('min-h-24', 'overflow-y-auto')
    expect(screen.getByRole('region', { name: 'Welcome to LoopTroop' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByText(/Long startup warning/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "Got it, let's go!" })).toBeInTheDocument()
  })

  it('moves focus into the dialog and makes the page behind it inert', () => {
    render(
      <>
        <button type="button">outside</button>
        <WelcomeDisclaimer open onDismiss={vi.fn()} />
      </>,
    )

    const dialog = screen.getByRole('dialog', { name: 'Welcome to LoopTroop' })
    const outside = screen.getByText('outside')
    expect(dialog).toHaveFocus()
    expect(outside).toHaveAttribute('inert')
    expect(outside).toHaveAttribute('aria-hidden', 'true')
  })
})
