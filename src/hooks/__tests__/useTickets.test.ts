import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getTicketAutoRefreshInterval,
  getTicketsAutoRefreshInterval,
  ticketAction,
} from '../useTickets'

describe('useTickets auto-refresh helpers', () => {
  it('refreshes active ticket detail queries but not terminal tickets', () => {
    expect(getTicketAutoRefreshInterval({ status: 'CODING' } as { status: string })).toBe(5000)
    expect(getTicketAutoRefreshInterval({ status: 'WAITING_PR_REVIEW' } as { status: string })).toBe(5000)
    expect(getTicketAutoRefreshInterval({ status: 'COMPLETED' } as { status: string })).toBe(false)
    expect(getTicketAutoRefreshInterval({ status: 'CANCELED' } as { status: string })).toBe(false)
    expect(getTicketAutoRefreshInterval(null)).toBe(false)
  })

  it('refreshes ticket lists only while they contain active work', () => {
    expect(getTicketsAutoRefreshInterval([{ status: 'CANCELED' }] as Array<{ status: string }>)).toBe(false)
    expect(getTicketsAutoRefreshInterval([{ status: 'COMPLETED' }] as Array<{ status: string }>)).toBe(false)
    expect(getTicketsAutoRefreshInterval([{ status: 'CODING' }, { status: 'CANCELED' }] as Array<{ status: string }>)).toBe(10000)
    expect(getTicketsAutoRefreshInterval(undefined)).toBe(false)
  })
})

describe('useTicketAction', () => {
  afterEach(() => vi.restoreAllMocks())

  it('surfaces field-specific API validation messages', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'Invalid input',
      message: 'description: Too big: expected string to have <=50000 characters',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }))

    await expect(ticketAction('ticket-1', 'retry')).rejects.toThrow(
      'Invalid input: description: Too big: expected string to have <=50000 characters',
    )
  })

  it('posts the exact note as JSON for an extra-note retry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      message: 'Retry started',
      ticketId: 'ticket-1',
      state: 'CODING',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const note = '  Keep the existing work.\nTry the focused fix next.  '

    await ticketAction('ticket-1', 'retry', note)

    expect(fetchSpy).toHaveBeenCalledWith('/api/tickets/ticket-1/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    })
  })

  it('keeps an ordinary retry request body-free', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      message: 'Retry started',
      ticketId: 'ticket-1',
      state: 'CODING',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await ticketAction('ticket-1', 'retry')

    expect(fetchSpy).toHaveBeenCalledWith('/api/tickets/ticket-1/retry', { method: 'POST' })
  })
})
