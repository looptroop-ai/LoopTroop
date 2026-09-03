import { describe, expect, it } from 'vitest'
import { parseManualQaDeliverySummaryArtifact } from '../delivery'

/**
 * The fallback for a ticket whose canonical `manual-qa/` files are gone. Two
 * phases had their own version and they were not equivalent, so the same stored
 * artifact could be refused by one and described to a model by the other.
 */
function summary(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    artifact: 'manual_qa_summary',
    ticketId: 'DEMO-1',
    version: 2,
    outcome: 'passed',
    createdFixBeadIds: ['qa-fix-1'],
    improvementTicketIds: ['DEMO-2'],
    waivedItemIds: [],
    waivedItems: [],
    startedAt: '2026-07-13T10:00:00.000Z',
    completedAt: '2026-07-13T10:01:00.000Z',
    durationMs: 60_000,
    itemCounts: { pass: 1, fail: 0, waive: 0, improvement: 0, pending: 0 },
    requiredItemCount: 1,
    optionalItemCount: 0,
    evidenceCount: 0,
    nextAction: 'integrate',
    coverage: { covered: 1, partiallyCovered: 0, uncovered: 0, notApplicable: 0 },
    modelCapability: null,
    idempotencyKey: '2:passed',
    ...overrides,
  })
}

describe('parseManualQaDeliverySummaryArtifact', () => {
  it('reads a valid envelope into the compact delivery view', () => {
    expect(parseManualQaDeliverySummaryArtifact(summary())).toEqual({
      version: 2,
      outcome: 'passed',
      createdFixBeadIds: ['qa-fix-1'],
      improvementTicketIds: ['DEMO-2'],
      waivedItemIds: [],
      skipReason: null,
    })
  })

  it('unwraps a nested value envelope', () => {
    const nested = JSON.stringify({ value: JSON.parse(summary()) as unknown })
    expect(parseManualQaDeliverySummaryArtifact(nested)?.version).toBe(2)
  })

  it('refuses a failed outcome rather than describing it to a model', () => {
    expect(parseManualQaDeliverySummaryArtifact(summary({ outcome: 'failed' }))).toBeNull()
  })

  it('refuses an envelope the schema does not recognise', () => {
    expect(parseManualQaDeliverySummaryArtifact(summary({ outcome: 'not-an-outcome' }))).toBeNull()
    expect(parseManualQaDeliverySummaryArtifact(JSON.stringify({ nothing: 'useful' }))).toBeNull()
  })

  it('refuses content that is not JSON at all', () => {
    expect(parseManualQaDeliverySummaryArtifact('outcome: passed\n')).toBeNull()
    expect(parseManualQaDeliverySummaryArtifact('')).toBeNull()
  })

  it('refuses a JSON array', () => {
    expect(parseManualQaDeliverySummaryArtifact('[]')).toBeNull()
  })
})
