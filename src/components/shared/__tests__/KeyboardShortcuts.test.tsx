import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KeyboardShortcuts } from '../KeyboardShortcuts'
import { DROPDOWN_Z_INDEX } from '@/lib/constants'

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
   * The ticket view and the About window are both `z-[60]`, Radix dialogs are
   * `z-[70]`, and the two portaled pickers are higher still. At `z-50` this overlay
   * opened underneath all of them — invisible, holding focus, and making everything
   * the user could still see inert.
   */
  it('stacks above every other surface, pickers included', () => {
    open()
    const backdrop = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' }).parentElement!
    expect(Number(backdrop.style.zIndex)).toBeGreaterThan(DROPDOWN_Z_INDEX)
  })
})
