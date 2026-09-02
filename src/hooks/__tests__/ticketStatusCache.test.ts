import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { mergeTicketInCache, patchTicketStatusInCache } from '../ticketStatusCache'

interface TestTicket {
  id: string
  status: string
  title: string
}

describe.concurrent('patchTicketStatusInCache', () => {
  it('updates the ticket detail cache and every ticket list cache immediately', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })

    const ticketId = '1:T-42'
    const originalTicket: TestTicket = {
      id: ticketId,
      status: 'DRAFTING_PRD',
      title: 'Sync live phases',
    }
    const otherTicket: TestTicket = {
      id: '1:T-43',
      status: 'CODING',
      title: 'Leave untouched',
    }

    queryClient.setQueryData(['ticket', ticketId], originalTicket)
    queryClient.setQueryData(['tickets'], [originalTicket, otherTicket])
    queryClient.setQueryData(['tickets', { projectId: 7 }], [originalTicket])

    patchTicketStatusInCache<TestTicket>(queryClient, ticketId, 'REFINING_PRD')

    expect(queryClient.getQueryData<TestTicket>(['ticket', ticketId])).toEqual({
      ...originalTicket,
      status: 'REFINING_PRD',
    })
    expect(queryClient.getQueryData<TestTicket[]>(['tickets'])).toEqual([
      { ...originalTicket, status: 'REFINING_PRD' },
      otherTicket,
    ])
    expect(queryClient.getQueryData<TestTicket[]>(['tickets', { projectId: 7 }])).toEqual([
      { ...originalTicket, status: 'REFINING_PRD' },
    ])
  })
})

describe.concurrent('mergeTicketInCache', () => {
  it('merges newly returned ticket fields into the detail cache and every ticket list cache immediately', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })

    const ticketId = '1:T-42'
    const originalTicket = {
      id: ticketId,
      status: 'DRAFT',
      title: 'Sync live phases',
      lockedMainImplementer: null as string | null,
      lockedCouncilMembers: [] as string[],
    }
    const updatedTicket = {
      ...originalTicket,
      lockedMainImplementer: 'openai/gpt-5-codex',
      lockedCouncilMembers: ['openai/gpt-5-codex', 'openai/gpt-5-mini'],
    }
    const otherTicket = {
      id: '1:T-43',
      status: 'CODING',
      title: 'Leave untouched',
      lockedMainImplementer: null as string | null,
      lockedCouncilMembers: [] as string[],
    }

    queryClient.setQueryData(['ticket', ticketId], originalTicket)
    queryClient.setQueryData(['tickets'], [originalTicket, otherTicket])
    queryClient.setQueryData(['tickets', { projectId: 7 }], [originalTicket])

    mergeTicketInCache(queryClient, updatedTicket)

    expect(queryClient.getQueryData(['ticket', ticketId])).toEqual(updatedTicket)
    expect(queryClient.getQueryData(['tickets'])).toEqual([
      updatedTicket,
      otherTicket,
    ])
    expect(queryClient.getQueryData(['tickets', { projectId: 7 }])).toEqual([
      updatedTicket,
    ])
  })
})

describe.concurrent('mergeTicketInCache with a partial payload', () => {
  it('does not seed an absent entry from a patch', () => {
    // The incoming payload has been through the normaliser, which leaves out
    // fields the response did not carry. Seeding from it would install a
    // half-ticket; the caller invalidates the key instead, so it is fetched
    // whole.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    mergeTicketInCache<TestTicket>(queryClient, { id: '1:T-99', status: 'CODING' })

    expect(queryClient.getQueryData(['ticket', '1:T-99'])).toBeUndefined()
  })

  it('merges only the keys the patch carries', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const cached: TestTicket = { id: '1:T-42', status: 'CODING', title: 'Keep me' }
    queryClient.setQueryData(['ticket', cached.id], cached)

    mergeTicketInCache<TestTicket>(queryClient, { id: cached.id, status: 'WAITING_PR_REVIEW' })

    expect(queryClient.getQueryData<TestTicket>(['ticket', cached.id]))
      .toEqual({ id: cached.id, status: 'WAITING_PR_REVIEW', title: 'Keep me' })
  })
})
