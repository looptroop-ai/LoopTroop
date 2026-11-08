import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KeyboardShortcuts } from '../KeyboardShortcuts'
import { CenteredModal } from '../CenteredModal'
import { TooltipProvider } from '@/components/ui/tooltip'
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
    expect(dialog).toHaveClass('my-auto', 'max-h-[calc(100dvh-2rem)]', 'overflow-y-auto', 'flex', 'flex-col')
    expect(dialog.parentElement).toHaveClass('overflow-y-auto')
    expect(dialog.children[0]).toHaveClass('shrink-0')
    expect(dialog.children[1]).toHaveClass('min-h-24', 'flex-1', 'overflow-y-auto')
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

  it('does not open over a confirm dialog that is waiting for an answer', () => {
    render(<><KeyboardShortcuts /><div role="alertdialog" aria-label="Discard unsaved changes?" /></>)
    fireEvent.keyDown(document.body, { key: '?' })
    expect(screen.queryByRole('dialog', { name: 'Keyboard Shortcuts' })).not.toBeInTheDocument()
  })

  it('closes on Escape', () => {
    open()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('contains focus and makes the background inert while open', () => {
    render(<><button type="button">outside</button><KeyboardShortcuts /></>)
    fireEvent.keyDown(document.body, { key: '?' })

    const dialog = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })
    const outside = screen.getByText('outside')
    expect(dialog).toHaveFocus()
    expect(outside).toHaveAttribute('inert')
    expect(outside).toHaveAttribute('aria-hidden', 'true')
  })

  it('makes a routed dialog inert when it opens above one', () => {
    render(
      <TooltipProvider>
        <CenteredModal open onClose={() => {}} title="Configuration">
          <button type="button">inside</button>
        </CenteredModal>
        <KeyboardShortcuts />
      </TooltipProvider>,
    )
    fireEvent.keyDown(document.body, { key: '?' })

    const configuration = screen.getByRole('dialog', { name: 'Configuration', hidden: true })
    const shortcuts = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })
    expect(configuration.parentElement).toHaveAttribute('inert')
    expect(shortcuts).toHaveFocus()
  })

  it('keeps panel interactions open and closes on a backdrop click', () => {
    open()
    const dialog = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })
    const backdrop = dialog.parentElement
    if (!backdrop) throw new Error('Keyboard shortcuts dialog has no backdrop')

    fireEvent.click(screen.getByText('Show keyboard shortcuts'))
    fireEvent.scroll(dialog)
    expect(screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeInTheDocument()

    fireEvent.click(backdrop)
    expect(screen.queryByRole('dialog', { name: 'Keyboard Shortcuts' })).not.toBeInTheDocument()
  })

  /**
   * The ticket view is `z-[60]`, routed modals are `z-[70]`, About is `z-[80]`,
   * and the two portaled pickers are higher still. Keeping the shortcuts window
   * above the dashboard but below the active modal preserves keyboard ownership.
   */
  it('stacks above every other surface, pickers included', () => {
    open()
    const backdrop = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' }).parentElement!
    expect(Number(backdrop.style.zIndex)).toBeGreaterThan(DROPDOWN_Z_INDEX)
  })
})
