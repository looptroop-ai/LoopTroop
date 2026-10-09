import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CenteredModal } from '@/components/shared/CenteredModal'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TicketTitleField } from '../TicketFormSections'

afterEach(cleanup)

const TicketTitleModalHarness = () => {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  return (
    <TooltipProvider>
      <button type="button" onClick={() => setOpen(true)}>New ticket</button>
      <CenteredModal open={open} onClose={() => setOpen(false)} title="New Ticket">
        <TicketTitleField title={title} onChange={setTitle} />
      </CenteredModal>
    </TooltipProvider>
  )
}

describe('Ticket title modal focus', () => {
  it.each(['Escape', 'Close button'] as const)('restores focus after %s with the title control already loaded', closeMethod => {
    render(<TicketTitleModalHarness />)
    const opener = screen.getByRole('button', { name: 'New ticket' })
    opener.focus()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.click(opener)
      const dialog = screen.getByRole('dialog', { name: 'New Ticket' })
      expect(within(dialog).getByRole('textbox')).toBeInTheDocument()
      expect(dialog).toHaveFocus()
      expect(opener).toHaveAttribute('inert')

      if (closeMethod === 'Escape') {
        fireEvent.keyDown(document, { key: 'Escape' })
      } else {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      }

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(opener).not.toHaveAttribute('inert')
      expect(opener).toHaveFocus()
    }
  })
})
