import { describe, expect, it } from 'vitest'
import {
  normalizeTicketListResponse,
  normalizeTicketPatch,
  normalizeTicketResponse,
} from '../ticketNormalization'

function wirePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: '1:NORM-1',
    externalId: 'NORM-1',
    projectId: 1,
    title: 'Normalise at the boundary',
    status: 'CODING',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:05:00.000Z',
    ...overrides,
  }
}

describe('normalizeTicketResponse', () => {
  it('refuses a payload that is not a ticket', () => {
    // A cast cannot catch API drift, which is the whole reason the raw shape is
    // written down separately from the view model.
    expect(() => normalizeTicketResponse(null)).toThrow('was not an object')
    expect(() => normalizeTicketResponse([])).toThrow('was not an object')
    expect(() => normalizeTicketResponse({ status: 'CODING' })).toThrow('carried no id')
    expect(() => normalizeTicketResponse({ id: '1:X-1' })).toThrow('carried no status')
  })

  it('fills a missing runtime from the ticket\'s own bead columns', () => {
    const ticket = normalizeTicketResponse(wirePayload({
      currentBead: 2,
      totalBeads: 5,
      percentComplete: 40,
    }))

    expect(ticket.runtime.currentBead).toBe(2)
    expect(ticket.runtime.totalBeads).toBe(5)
    expect(ticket.runtime.percentComplete).toBe(40)
    expect(ticket.runtime.beads).toEqual([])
    expect(ticket.availableActions).toEqual([])
    expect(ticket.lockedCouncilMembers).toEqual([])
    expect(ticket.cleanup).toEqual({ status: null, errorCount: 0, latestReportArtifactId: null, errors: [] })
  })

  it('keeps a bead\'s completedAt and Manual QA origin', () => {
    // Both existed on the payload and on the type, and both were dropped by the
    // mapper — so a QA-fix bead rendered as an ordinary one and log grouping
    // never showed its origin badge.
    const ticket = normalizeTicketResponse(wirePayload({
      runtime: {
        beads: [{
          id: 'bead-1',
          title: 'Fix the importer',
          status: 'completed',
          iteration: 1,
          completedAt: '2026-09-01T10:04:00.000Z',
          qaOrigin: {
            actionId: 'qa:1',
            sourceTicketId: '1:QA-9',
            sourceTicketExternalId: 'QA-9',
            version: 2,
            sourceItems: [{
              itemId: 'item-1',
              behavior: 'Upload a file',
              observation: 'It hung',
              expectedResult: 'It uploads',
            }],
            imageDelivery: 'attached',
          },
        }],
      },
    }))

    const bead = ticket.runtime.beads?.[0]
    expect(bead?.completedAt).toBe('2026-09-01T10:04:00.000Z')
    expect(bead?.qaOrigin?.version).toBe(2)
    expect(bead?.qaOrigin?.sourceTicketExternalId).toBe('QA-9')
    // The origin card indexes into these without guarding, so they must be
    // arrays even when the payload omitted them.
    expect(bead?.qaOrigin?.sourceItems[0]?.evidence).toEqual([])
    expect(bead?.qaOrigin?.sourceItems[0]?.links).toEqual([])
  })

  it('drops a Manual QA origin it cannot build an evidence URL from', () => {
    const ticket = normalizeTicketResponse(wirePayload({
      runtime: {
        beads: [{ id: 'bead-1', title: 'x', status: 'pending', iteration: 0, qaOrigin: { version: 2 } }],
      },
    }))

    expect(ticket.runtime.beads?.[0]?.qaOrigin).toBeNull()
  })

  it('keeps only actions this client can dispatch', () => {
    const ticket = normalizeTicketResponse(wirePayload({
      availableActions: ['cancel', 'teleport', 'retry', 42, ''],
    }))

    expect(ticket.availableActions).toEqual(['cancel', 'retry'])
  })

  it('states error-occurrence ids as strings, the way every key and comparison uses them', () => {
    const ticket = normalizeTicketResponse(wirePayload({
      status: 'BLOCKED_ERROR',
      activeErrorOccurrenceId: 7,
      errorOccurrences: [
        { id: 7, occurrenceNumber: 1, occurredAt: '2026-09-01T10:01:00.000Z' },
        { id: 8, occurrenceNumber: 2, occurredAt: '2026-09-01T10:02:00.000Z' },
      ],
    }))

    expect(ticket.activeErrorOccurrenceId).toBe('7')
    expect(ticket.errorOccurrences?.map((occurrence) => occurrence.id)).toEqual(['7', '8'])
  })
})

describe('normalizeTicketListResponse', () => {
  it('refuses anything that is not a list', () => {
    expect(() => normalizeTicketListResponse({ tickets: [] })).toThrow('was not an array')
  })

  it('normalises each entry', () => {
    const tickets = normalizeTicketListResponse([wirePayload(), wirePayload({ id: '1:NORM-2' })])

    expect(tickets).toHaveLength(2)
    expect(tickets[1]?.runtime.baseBranch).toBe('unknown')
  })
})

describe('normalizeTicketPatch', () => {
  it('leaves out a field the response did not carry', () => {
    // The patch is merged over a cached ticket. Completing it here would
    // overwrite a good runtime with zeroes the moment a route answered without
    // one.
    const patch = normalizeTicketPatch({ id: '1:NORM-1', status: 'WAITING_PR_REVIEW' })

    expect(patch).not.toBeNull()
    expect(patch && 'runtime' in patch).toBe(false)
    expect(patch && 'availableActions' in patch).toBe(false)
    expect(patch && 'cleanup' in patch).toBe(false)
  })

  it('normalises the fields it does carry', () => {
    const patch = normalizeTicketPatch({
      id: '1:NORM-1',
      status: 'BLOCKED_ERROR',
      availableActions: ['retry', 'teleport'],
      activeErrorOccurrenceId: 3,
      runtime: { totalBeads: 4 },
    })

    expect(patch?.availableActions).toEqual(['retry'])
    expect(patch?.activeErrorOccurrenceId).toBe('3')
    expect(patch?.runtime?.totalBeads).toBe(4)
  })

  it('refuses a payload with no id, which cannot address a cache entry', () => {
    expect(normalizeTicketPatch(undefined)).toBeNull()
    expect(normalizeTicketPatch({ status: 'CODING' })).toBeNull()
  })
})
