import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KeyboardShortcuts } from '../KeyboardShortcuts'

afterEach(cleanup)

function open() {
  render(<KeyboardShortcuts />)
  fireEvent.keyDown(document.body, { key: '?' })
}

describe('KeyboardShortcuts', () => {
  it('opens on ? as a named dialog', () => {
    open()
    const dialog = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  /**
   * The overlay used to advertise `n` for a new ticket and `k` for the board. Neither
   * is bound anywhere: the user pressed them, nothing happened, and the rest of the
   * list stopped being believable.
   */
  it('lists only shortcuts the app implements', () => {
    open()
    const keys = screen.getAllByText((_, element) => element?.tagName === 'KBD').map((el) => el.textContent)
    expect(keys).toEqual(['?', 'Escape', '/'])
  })

  it('closes on Escape', () => {
    open()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  /**
   * The ticket view and the About window are both `z-[60]`, and Radix dialogs are
   * `z-[70]`. At `z-50` this overlay opened underneath them — invisible, holding
   * focus, and making everything the user could still see inert.
   */
  it('stacks above the ticket view and the app modals', () => {
    open()
    const backdrop = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' }).parentElement!
    expect(backdrop.className).toContain('z-[80]')
  })
})
