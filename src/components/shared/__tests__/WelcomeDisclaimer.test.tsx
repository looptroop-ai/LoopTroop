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

    const panel = screen.getByText('Welcome to LoopTroop').parentElement

    expect(panel).toHaveClass('max-h-[calc(100dvh-2rem)]', 'overflow-y-auto')
    expect(screen.getByText(/Long startup warning/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "Got it, let's go!" })).toBeInTheDocument()
  })
})
