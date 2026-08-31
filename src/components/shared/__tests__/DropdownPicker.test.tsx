import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DropdownPicker } from '../DropdownPicker'

afterEach(cleanup)

/** A caller that owns the open state, which is how the app uses this. */
function ControlledPicker({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <DropdownPicker
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next)
        setOpen(next)
      }}
      trigger={<button type="button">Pick a project</button>}
    >
      <button type="button">Project one</button>
    </DropdownPicker>
  )
}

describe('DropdownPicker', () => {
  /**
   * A disclosure, and only that. The popup holds whatever the caller puts in it, so
   * there is no menu, listbox or dialog to advertise — and advertising one anyway
   * promises assistive technology a widget the generic container cannot be.
   */
  it('reports its expanded state and the popup it owns', () => {
    render(<ControlledPicker />)
    const trigger = screen.getByRole('button', { name: 'Pick a project' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).not.toHaveAttribute('aria-haspopup')
    // Nothing to point at while it is closed.
    expect(trigger).not.toHaveAttribute('aria-controls')

    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const popupId = trigger.getAttribute('aria-controls')
    expect(popupId).toBeTruthy()
    expect(document.getElementById(popupId!)).toContainElement(
      screen.getByRole('button', { name: 'Project one' }),
    )
  })

  it('closes on Escape and returns focus to the trigger', () => {
    render(<ControlledPicker />)
    const trigger = screen.getByRole('button', { name: 'Pick a project' })
    fireEvent.click(trigger)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Project one' }), { key: 'Escape' })

    expect(screen.queryByRole('button', { name: 'Project one' })).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps Escape to itself so nothing behind it also closes', () => {
    const onDocumentEscape = vi.fn()
    document.addEventListener('keydown', onDocumentEscape)
    try {
      render(<ControlledPicker />)
      fireEvent.click(screen.getByRole('button', { name: 'Pick a project' }))
      onDocumentEscape.mockClear()

      fireEvent.keyDown(screen.getByRole('button', { name: 'Project one' }), { key: 'Escape' })

      expect(onDocumentEscape).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', onDocumentEscape)
    }
  })

  it('lets Escape through while it is closed', () => {
    const onDocumentEscape = vi.fn()
    document.addEventListener('keydown', onDocumentEscape)
    try {
      render(<ControlledPicker />)

      fireEvent.keyDown(screen.getByRole('button', { name: 'Pick a project' }), { key: 'Escape' })

      expect(onDocumentEscape).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', onDocumentEscape)
    }
  })

  it('asks a caller that holds it open to close, without touching the selection', () => {
    const onOpenChange = vi.fn()
    const onSelect = vi.fn()
    render(
      <DropdownPicker
        open
        onOpenChange={onOpenChange}
        trigger={<button type="button">Pick a project</button>}
      >
        <button type="button" onClick={onSelect}>Project one</button>
      </DropdownPicker>,
    )

    fireEvent.keyDown(screen.getByRole('button', { name: 'Project one' }), { key: 'Escape' })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSelect).not.toHaveBeenCalled()
    // The caller decides; a picker still rendered open still works.
    fireEvent.click(screen.getByRole('button', { name: 'Project one' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
