import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { clearTicketCaches } from '../useTickets'

const ticketId = '1:DEL-1'
const otherTicketId = '1:DEL-2'

/** One entry per query family that keys on a ticket id, as of this change. */
function seedCache(client: QueryClient) {
  client.setQueryData(['ticket', ticketId], { id: ticketId })
  client.setQueryData(['interview', ticketId], { raw: '' })
  client.setQueryData(['ticket-ui-state', ticketId, 'approval_prd'], { revision: 1 })
  client.setQueryData(['ticket-artifacts', ticketId, '__all__', 'active'], [])
  client.setQueryData(['ticket-phase-attempts', ticketId, 'CODING'], [])
  client.setQueryData(['manual-qa', ticketId, 'index'], {})
  client.setQueryData(['ticket-ai-details', ticketId, 'phase', '', '', ''], {})
  client.setQueryData(['ticket-beads', ticketId], [])
  client.setQueryData(['bead-diff', ticketId, 'bead-1'], {})
  client.setQueryData(['bead-commit-metadata', ticketId], [])
  client.setQueryData(['artifact', ticketId, 'prd', 'live'], '')
  client.setQueryData(['ticket-skips', ticketId], { events: [] })
}

describe('clearTicketCaches', () => {
  it('removes every family that names the ticket, not an enumerated few', async () => {
    // The enumerated version cleared six of these twelve. The six it missed
    // survived under an id the server can hand out again.
    const client = new QueryClient()
    seedCache(client)

    await clearTicketCaches(client, ticketId)

    const remaining = client.getQueryCache().getAll()
      .filter((query) => query.queryKey.includes(ticketId))
    expect(remaining).toEqual([])
  })

  it('leaves another ticket alone', async () => {
    const client = new QueryClient()
    seedCache(client)
    client.setQueryData(['ticket', otherTicketId], { id: otherTicketId })
    client.setQueryData(['manual-qa', otherTicketId, 'index'], {})

    await clearTicketCaches(client, ticketId)

    expect(client.getQueryData(['ticket', otherTicketId])).toEqual({ id: otherTicketId })
    expect(client.getQueryData(['manual-qa', otherTicketId, 'index'])).toEqual({})
  })

  it('leaves the ticket lists in place, which the caller filters itself', async () => {
    const client = new QueryClient()
    client.setQueryData(['tickets'], [{ id: ticketId }, { id: otherTicketId }])
    client.setQueryData(['tickets', { projectId: 1 }], [{ id: ticketId }])

    await clearTicketCaches(client, ticketId)

    expect(client.getQueryData(['tickets'])).toHaveLength(2)
    expect(client.getQueryData(['tickets', { projectId: 1 }])).toHaveLength(1)
  })
})
