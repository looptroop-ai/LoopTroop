import { afterEach, describe, expect, it, vi } from 'vitest'
import { getActiveErrorOccurrence, getTicketErrorOccurrences } from '../errorOccurrences'

type ErrorTicket = Parameters<typeof getTicketErrorOccurrences>[0]

function ticket(overrides: Partial<ErrorTicket> = {}): ErrorTicket {
  return {
    id: '1:ERR-1',
    status: 'BLOCKED_ERROR',
    previousStatus: 'CODING',
    updatedAt: '2026-09-01T12:00:00.000Z',
    errorMessage: 'boom',
    errorOccurrences: [],
    activeErrorOccurrenceId: null,
    ...overrides,
  } as ErrorTicket
}

function occurrence(overrides: Record<string, unknown>) {
  return {
    occurrenceNumber: 1,
    blockedFromStatus: 'CODING',
    errorMessage: 'boom',
    errorCodes: [],
    resolvedAt: null,
    resolutionStatus: null,
    resumedToStatus: null,
    ...overrides,
  } as unknown as NonNullable<ErrorTicket['errorOccurrences']>[number]
}

afterEach(() => {
  vi.useRealTimers()
})

describe('getTicketErrorOccurrences', () => {
  it('gives an undated occurrence a stable time instead of the current one', () => {
    // This runs during render and the list is sorted by `occurredAt`, so a fresh
    // `new Date()` reordered the list and churned React keys on every pass.
    const source = ticket({
      errorOccurrences: [
        occurrence({ id: '1', occurrenceNumber: 1 }),
        occurrence({ id: '2', occurrenceNumber: 2 }),
      ],
    })

    const first = getTicketErrorOccurrences(source)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'))
    const second = getTicketErrorOccurrences(source)

    expect(first.map((entry) => entry.occurredAt)).toEqual(['2026-09-01T12:00:00.000Z', '2026-09-01T12:00:00.000Z'])
    expect(second.map((entry) => entry.id)).toEqual(first.map((entry) => entry.id))
    expect(second.map((entry) => entry.occurredAt)).toEqual(first.map((entry) => entry.occurredAt))
  })
})

describe('getActiveErrorOccurrence', () => {
  it('prefers the unresolved occurrence over a resolved id while the ticket is blocked', () => {
    // The id points at whichever occurrence the operator was last reviewing.
    // Returning a resolved one offered Retry and Continue against an error that
    // had already been dealt with.
    const active = getActiveErrorOccurrence(ticket({
      activeErrorOccurrenceId: '1',
      errorOccurrences: [
        occurrence({
          id: '1',
          occurrenceNumber: 1,
          occurredAt: '2026-09-01T11:00:00.000Z',
          resolvedAt: '2026-09-01T11:30:00.000Z',
          resolutionStatus: 'RETRIED',
        }),
        occurrence({ id: '2', occurrenceNumber: 2, occurredAt: '2026-09-01T12:00:00.000Z' }),
      ],
    }))

    expect(active?.id).toBe('2')
  })

  it('still honours the id for historical review once the ticket is no longer blocked', () => {
    const active = getActiveErrorOccurrence(ticket({
      status: 'CODING',
      activeErrorOccurrenceId: '1',
      errorOccurrences: [
        occurrence({
          id: '1',
          occurrenceNumber: 1,
          occurredAt: '2026-09-01T11:00:00.000Z',
          resolvedAt: '2026-09-01T11:30:00.000Z',
          resolutionStatus: 'RETRIED',
        }),
      ],
    }))

    expect(active?.id).toBe('1')
  })

  it('honours the id when it names an occurrence that is still open', () => {
    const active = getActiveErrorOccurrence(ticket({
      activeErrorOccurrenceId: '1',
      errorOccurrences: [
        occurrence({ id: '1', occurrenceNumber: 1, occurredAt: '2026-09-01T11:00:00.000Z' }),
        occurrence({ id: '2', occurrenceNumber: 2, occurredAt: '2026-09-01T12:00:00.000Z' }),
      ],
    }))

    expect(active?.id).toBe('1')
  })
})

describe('getActiveErrorOccurrence fallthrough order', () => {
  it('picks the newest unresolved error, not the oldest', () => {
    // The list is newest-first, so reversing before `find` returned the *oldest*
    // open error — and the recovery actions beside it belonged to that one.
    // Reachable now that an active id naming a resolved occurrence falls
    // through to here.
    const active = getActiveErrorOccurrence(ticket({
      activeErrorOccurrenceId: '1',
      errorOccurrences: [
        occurrence({
          id: '1',
          occurrenceNumber: 1,
          occurredAt: '2026-09-01T10:00:00.000Z',
          resolvedAt: '2026-09-01T10:30:00.000Z',
          resolutionStatus: 'RETRIED',
        }),
        occurrence({ id: '2', occurrenceNumber: 2, occurredAt: '2026-09-01T11:00:00.000Z' }),
        occurrence({ id: '3', occurrenceNumber: 3, occurredAt: '2026-09-01T12:00:00.000Z' }),
      ],
    }))

    expect(active?.id).toBe('3')
  })

  it('falls back to the newest occurrence when every one is resolved', () => {
    const active = getActiveErrorOccurrence(ticket({
      activeErrorOccurrenceId: null,
      errorOccurrences: [
        occurrence({ id: '1', occurrenceNumber: 1, occurredAt: '2026-09-01T10:00:00.000Z', resolvedAt: '2026-09-01T10:30:00.000Z' }),
        occurrence({ id: '2', occurrenceNumber: 2, occurredAt: '2026-09-01T12:00:00.000Z', resolvedAt: '2026-09-01T12:30:00.000Z' }),
      ],
    }))

    expect(active?.id).toBe('2')
  })
})
