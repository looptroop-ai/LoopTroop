import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CenteredModal } from '../CenteredModal'
import { TooltipProvider } from '@/components/ui/tooltip'

afterEach(cleanup)

function renderModal(onClose = vi.fn()) {
  const result = render(
    <TooltipProvider>
      <button type="button">outside</button>
      <CenteredModal open onClose={onClose} title="Configuration">
        <button type="button">first</button>
        <button type="button">second</button>
      </CenteredModal>
    </TooltipProvider>,
  )
  return { ...result, onClose }
}

describe('CenteredModal — dialog semantics and focus containment', () => {
  it('exposes a named modal dialog', () => {
    renderModal()
    const dialog = screen.getByRole('dialog', { name: 'Configuration' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('moves focus into the dialog on open', () => {
    renderModal()
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Configuration' }))
  })

  it('makes the rest of the page inert while it is open', () => {
    renderModal()
    // Queried by text rather than by role: the button is hidden from assistive
    // technology now, which is the point, and `getByRole` honours that.
    const outside = screen.getByText('outside')
    expect(outside).toHaveAttribute('inert')
    expect(outside).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('button', { name: 'outside' })).not.toBeInTheDocument()
  })

  it('releases the page and restores focus when it closes', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <TooltipProvider>
          <button type="button" onClick={() => setOpen(true)}>open it</button>
          <CenteredModal open={open} onClose={() => setOpen(false)} title="Configuration">
            <button type="button">inside</button>
          </CenteredModal>
        </TooltipProvider>
      )
    }
    render(<Harness />)
    const opener = screen.getByText('open it')
    opener.focus()
    fireEvent.click(opener)

    expect(screen.getByRole('dialog', { name: 'Configuration' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).not.toHaveAttribute('inert')
    expect(document.activeElement).toBe(opener)
  })

  it('wraps Tab from the last focusable back to the first', () => {
    renderModal()
    const dialog = screen.getByRole('dialog', { name: 'Configuration' })
    const focusable = Array.from(dialog.querySelectorAll('button'))
    const last = focusable[focusable.length - 1]!
    last.focus()

    fireEvent.keyDown(last, { key: 'Tab' })

    expect(document.activeElement).toBe(focusable[0])
  })

  it('wraps Shift+Tab from the dialog itself to the last focusable', () => {
    renderModal()
    const dialog = screen.getByRole('dialog', { name: 'Configuration' })
    const focusable = Array.from(dialog.querySelectorAll('button'))

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })

    expect(document.activeElement).toBe(focusable[focusable.length - 1])
  })
})
