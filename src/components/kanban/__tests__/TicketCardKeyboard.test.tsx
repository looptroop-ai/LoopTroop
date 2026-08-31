import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { AIQuestionContext } from '@/context/aiQuestionContextDef'
import { TicketCard } from '../TicketCard'
import { renderWithProviders } from '@/test/renderHelpers'
import { createAiQuestionContextStub } from '@/test/aiQuestionContext'
import { TEST, makeTicket } from '@/test/factories'
import { ticketCardLabel } from '@/test/ticketCardQueries'

const dispatch = vi.fn()

vi.mock('@/context/useUI', () => ({
  useUI: () => ({ state: {}, dispatch }),
}))

function renderCard() {
  const ticket = makeTicket({ id: '1:TEST-1', externalId: TEST.externalId, status: 'CODING' })
  renderWithProviders(
    <AIQuestionContext.Provider value={createAiQuestionContextStub()}>
      <TicketCard ticket={ticket} projectColor="#2563eb" projectIcon="T" projectName="TestProject" />
    </AIQuestionContext.Provider>,
  )
  return ticket
}

beforeEach(() => {
  dispatch.mockReset()
})

afterEach(cleanup)

/**
 * The card is a `<div>` with a click handler, so nothing on it was reachable without
 * a mouse. The title carries the action now — a real button, which Tab reaches and
 * Enter and Space activate. `role="button"` on the card would have been invalid: it
 * holds its own interactive descendants.
 */
describe('TicketCard — keyboard operability', () => {
  it('names the ticket on a real, focusable button', () => {
    const ticket = renderCard()
    const opener = screen.getByRole('button', { name: ticketCardLabel(ticket.externalId) })
    expect(opener.tagName).toBe('BUTTON')

    opener.focus()
    expect(document.activeElement).toBe(opener)
  })

  /**
   * The visible title has to be part of the accessible name, or a screen reader
   * announces only the id and speech input has no name matching the words on screen.
   */
  it('leads the accessible name with the ticket title it displays', () => {
    const ticket = renderCard()
    const opener = screen.getByRole('button', { name: ticketCardLabel(ticket.externalId) })

    expect(opener).toHaveTextContent(ticket.title)
    expect(opener.getAttribute('aria-label')).toBe(`${ticket.title}, open ticket ${ticket.externalId}`)
  })

  it('opens the ticket when the title button is activated', () => {
    const ticket = renderCard()

    fireEvent.click(screen.getByRole('button', { name: ticketCardLabel(ticket.externalId) }))

    expect(dispatch).toHaveBeenCalledWith({
      type: 'SELECT_TICKET',
      ticketId: ticket.id,
      externalId: ticket.externalId,
    })
    // Once, not twice: the button stops the click reaching the card behind it.
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('still opens the ticket from anywhere else on the card', () => {
    const ticket = renderCard()

    fireEvent.click(screen.getByText('TestProject'))

    expect(dispatch).toHaveBeenCalledWith({
      type: 'SELECT_TICKET',
      ticketId: ticket.id,
      externalId: ticket.externalId,
    })
  })

  it('does not put the card itself forward as one control', () => {
    const ticket = renderCard()
    const card = screen
      .getByRole('button', { name: ticketCardLabel(ticket.externalId) })
      .closest('[data-ticket-card]')!
    expect(card).not.toHaveAttribute('role')
  })
})
