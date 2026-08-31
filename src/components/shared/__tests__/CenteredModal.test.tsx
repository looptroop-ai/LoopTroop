import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CenteredModal } from '../CenteredModal'
import { DropdownPicker } from '../DropdownPicker'
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

/**
 * `DropdownPicker` and `ModelPicker` portal their popup to `document.body`, so a
 * picker opened inside a modal is a DOM sibling of the whole app. A trap that only
 * looked inside the modal element left those popups unreachable by Tab — openable
 * from the keyboard and then unusable.
 */
describe('CenteredModal — popups the dialog owns', () => {
  function renderWithPicker(open: boolean) {
    return render(
      <TooltipProvider>
        <button type="button">outside</button>
        <CenteredModal open onClose={vi.fn()} title="New Ticket">
          <DropdownPicker open={open} onOpenChange={vi.fn()} trigger={<button type="button">Pick a project</button>}>
            <button type="button">Project one</button>
          </DropdownPicker>
          <button type="button">Create</button>
        </CenteredModal>
      </TooltipProvider>,
    )
  }

  it('counts the portaled picker as the end of the dialog', () => {
    renderWithPicker(true)
    const dialog = screen.getByRole('dialog', { name: 'New Ticket' })
    const option = screen.getByRole('button', { name: 'Project one' })
    // The popup really is outside the dialog element — that is the whole problem.
    expect(dialog).not.toContainElement(option)

    // Shift+Tab off the first control wraps to the last thing in the dialog's scope.
    const first = dialog.querySelector('button')!
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })

    expect(document.activeElement).toBe(option)
  })

  it('brings focus back into the dialog when Tab leaves the portaled picker', () => {
    renderWithPicker(true)
    const dialog = screen.getByRole('dialog', { name: 'New Ticket' })
    const option = screen.getByRole('button', { name: 'Project one' })
    option.focus()

    fireEvent.keyDown(option, { key: 'Tab' })

    expect(document.activeElement).toBe(dialog.querySelector('button'))
  })

  it('leaves a portaled picker interactive rather than inert', () => {
    renderWithPicker(true)
    expect(screen.getByRole('button', { name: 'Project one' })).toBeInTheDocument()
  })
})

/**
 * Escape belongs to the innermost overlay. Both primitives close on a document
 * keydown, so without this the keypress that dismissed a confirmation dialog, a
 * folder picker or a model list also closed the window behind it.
 */
describe('CenteredModal — Escape ownership', () => {
  function renderWithNestedOverlay(role: string) {
    const onClose = vi.fn()
    render(
      <TooltipProvider>
        <CenteredModal open onClose={onClose} title="Projects">
          <div role={role} aria-label="Nested">
            <button type="button">Confirm</button>
          </div>
        </CenteredModal>
      </TooltipProvider>,
    )
    return onClose
  }

  it('stays open when Escape dismisses a nested dialog', () => {
    const onClose = renderWithNestedOverlay('dialog')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Confirm' }), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stays open when Escape dismisses a nested listbox', () => {
    const onClose = renderWithNestedOverlay('listbox')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Confirm' }), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stays open when something else already handled Escape', () => {
    const onClose = renderWithNestedOverlay('group')
    const handled = screen.getByRole('button', { name: 'Confirm' })
    handled.addEventListener('keydown', (event) => event.preventDefault())

    fireEvent.keyDown(handled, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('still closes on an Escape nothing else claimed', () => {
    const onClose = renderWithNestedOverlay('group')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Confirm' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

/**
 * A popup belongs to the window that opened it. One left open underneath a newer
 * overlay is part of the page behind it, not part of the overlay — otherwise
 * summoning the shortcuts overlay over an open picker put that picker in the
 * overlay's tab order and left it interactive.
 */
describe('CenteredModal — popups belonging to something else', () => {
  function renderPickerOutsideDialog() {
    return render(
      <TooltipProvider>
        <DropdownPicker open onOpenChange={vi.fn()} trigger={<button type="button">Pick a project</button>}>
          <button type="button">Project one</button>
        </DropdownPicker>
        <CenteredModal open onClose={vi.fn()} title="Keyboard Shortcuts">
          <button type="button">Inside</button>
        </CenteredModal>
      </TooltipProvider>,
    )
  }

  it('inerts a picker that belongs to the page behind it', () => {
    renderPickerOutsideDialog()
    expect(screen.getByText('Project one').closest('[data-lt-portal]')).toHaveAttribute('inert')
  })

  it('keeps Tab out of it', () => {
    renderPickerOutsideDialog()
    const dialog = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })
    const inside = screen.getByRole('button', { name: 'Inside' })
    inside.focus()

    fireEvent.keyDown(inside, { key: 'Tab' })

    expect(dialog).toContainElement(document.activeElement as HTMLElement)
  })
})

/**
 * Radix brings its own focus scope and portals its content to the body. Its key
 * events still travel the React tree to this handler, and treating "not in my list"
 * as "wrap back to my own first control" yanked focus out of the menu the user had
 * just opened inside the dialog.
 */
describe('CenteredModal — overlays with their own focus management', () => {
  it('leaves Tab alone inside a nested menu', () => {
    render(
      <TooltipProvider>
        <CenteredModal open onClose={vi.fn()} title="Projects">
          <button type="button">Inside</button>
        </CenteredModal>
      </TooltipProvider>,
    )

    // Stand in for a Radix popper: body-portaled, its own scope, unknown to ours.
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    menu.appendChild(item)
    document.body.appendChild(menu)
    item.focus()

    fireEvent.keyDown(item, { key: 'Tab' })

    expect(document.activeElement).toBe(item)
    document.body.removeChild(menu)
  })
})
