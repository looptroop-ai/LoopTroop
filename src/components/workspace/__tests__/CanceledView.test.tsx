import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeTicket } from '@/test/factories'
import { CanceledView } from '../CanceledView'

vi.mock('../CollapsiblePhaseLogSection', () => ({
  CollapsiblePhaseLogSection: ({ phase, ticket }: { phase: string; ticket?: { id: string } }) => (
    <div data-testid="collapsible-log-section" data-phase={phase} data-ticket={ticket?.id ?? 'none'} />
  ),
}))

describe('CanceledView', () => {
  it('hands its ticket to the log panel so the cancelled run keeps its history', () => {
    const ticket = makeTicket({ status: 'CANCELED' })

    render(<CanceledView ticket={ticket} />)

    // The panel loads durable history only when it knows the ticket, and reads the
    // phase as still live without one. Rendered ticketless, a cancelled run showed an
    // empty log next to the reason it was cancelled.
    const section = screen.getByTestId('collapsible-log-section')
    expect(section).toHaveAttribute('data-phase', 'CANCELED')
    expect(section).toHaveAttribute('data-ticket', ticket.id)
  })
})
