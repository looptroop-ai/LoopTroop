import { useState } from 'react'
import { createPortal } from 'react-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  it('skips focusable controls inside hidden ancestors', () => {
    render(
      <TooltipProvider>
        <CenteredModal open onClose={vi.fn()} title="Configuration">
          <button type="button">first</button>
          <button type="button">last</button>
          <div hidden><button type="button">hidden</button></div>
        </CenteredModal>
      </TooltipProvider>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Configuration' })
    const first = screen.getByRole('button', { name: 'Close' })
    const last = screen.getByRole('button', { name: 'last' })
    first.focus()

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })

    expect(document.activeElement).toBe(last)
    expect(dialog).toContainElement(screen.getByText('hidden'))
  })

  it('stacks the routed modal above the dashboard surface', () => {
    renderModal()
    const backdrop = screen.getByRole('dialog', { name: 'Configuration' }).parentElement!
    expect(backdrop).toHaveClass('z-[70]')
  })

  it('confirms only when the caller reports an unsaved value', () => {
    const onClose = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(
      <TooltipProvider>
        <CenteredModal open onClose={onClose} title="Configuration" isDirty>
          <button type="button">inside</button>
        </CenteredModal>
      </TooltipProvider>,
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(confirm).toHaveBeenCalledWith('You have unsaved changes. Close this window anyway?')
    expect(onClose).not.toHaveBeenCalled()
    confirm.mockRestore()
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
    act(() => { first.focus() })
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

  it('does not let an unrelated Radix tooltip claim Escape', () => {
    const onClose = renderWithNestedOverlay('group')
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-radix-popper-content-wrapper', '')
    const tooltip = document.createElement('span')
    tooltip.setAttribute('role', 'tooltip')
    tooltip.textContent = 'Unrelated hint'
    wrapper.appendChild(tooltip)
    document.body.appendChild(wrapper)
    try {
      fireEvent.keyDown(screen.getByRole('button', { name: 'Confirm' }), { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      wrapper.remove()
    }
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
    const first = dialog.querySelector('button')!
    act(() => { first.focus() })

    // Shift+Tab off the first control wraps to the end of the dialog's own scope. If
    // the picker behind were counted as part of it, that end would be its option.
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inside' }))
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
    function Harness() {
      const [menuOpen, setMenuOpen] = useState(false)
      return (
        <TooltipProvider>
          <CenteredModal open onClose={vi.fn()} title="Projects">
            <button type="button" onClick={() => setMenuOpen(true)}>Sort</button>
            {/* What Radix does: content portaled to the body only while it is open,
                with its own focus scope, and key events that still travel this React
                tree to the dialog's handler. */}
            {menuOpen && createPortal(
              <div role="menu">
                <button type="button">Sort by name</button>
              </div>,
              document.body,
            )}
          </CenteredModal>
        </TooltipProvider>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }))

    const item = screen.getByRole('button', { name: 'Sort by name' })
    item.focus()

    fireEvent.keyDown(item, { key: 'Tab' })

    expect(document.activeElement).toBe(item)
  })
})

describe('CenteredModal — picker ownership when another overlay is on top', () => {
  it('lets About claim Escape from an underlying picker', () => {
    const routeClose = vi.fn()

    function Harness() {
      const [aboutOpen, setAboutOpen] = useState(false)
      return (
        <TooltipProvider>
          <CenteredModal open onClose={routeClose} title="Configuration">
            <button type="button" onClick={() => setAboutOpen(true)}>Open About</button>
            <DropdownPicker open onOpenChange={vi.fn()} trigger={<button type="button">Pick a project</button>}>
              <button type="button">Project one</button>
            </DropdownPicker>
          </CenteredModal>
          <CenteredModal open={aboutOpen} onClose={() => setAboutOpen(false)} title="About" zIndexClass="z-[60]">
            <p>About Dialog</p>
          </CenteredModal>
        </TooltipProvider>
      )
    }

    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open About' }))
    expect(screen.getByRole('dialog', { name: 'About' })).toBeInTheDocument()

    document.body.focus()
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'About' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Project one' })).toBeInTheDocument()
    expect(routeClose).not.toHaveBeenCalled()
  })
})
