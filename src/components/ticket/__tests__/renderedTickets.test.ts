import { describe, expect, it } from 'vitest'
import {
  __renderedTicketsForTests,
  clearTicketPersistentState,
  getTicketSseCursorGeneration,
} from '../renderedTickets'

describe('rendered ticket test state', () => {
  it('resets SSE cursor generations with rendered-ticket state', () => {
    clearTicketPersistentState('ticket-1')
    expect(getTicketSseCursorGeneration('ticket-1')).toBe(1)

    __renderedTicketsForTests.reset()

    expect(getTicketSseCursorGeneration('ticket-1')).toBe(0)
  })
})
