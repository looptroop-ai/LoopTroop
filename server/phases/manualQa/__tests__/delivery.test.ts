import {  } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { ManualQaSummary } from '../types'
import { persistManualQaSummary } from '../storage'
import { readManualQaDeliverySummary } from '../delivery'
import { makeTempDir, removeTempDir } from '../../../test/tempDir'

const roots: string[] = []

function summary(version: number, input: Partial<ManualQaSummary>): ManualQaSummary {
  return {
    schemaVersion: 1,
    artifact: 'manual_qa_summary',
    ticketId: 'QA-1',
    version,
    outcome: 'passed',
    createdFixBeadIds: [],
    improvementTicketIds: [],
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
    ...input,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTempDir(root)
})

describe('Manual QA delivery summary', () => {
  it('uses the latest outcome while retaining created work from every completed round', () => {
    const ticketDir = makeTempDir('manual-qa-delivery-')
    roots.push(ticketDir)
    persistManualQaSummary(ticketDir, summary(1, {
      outcome: 'created_fixes',
      createdFixBeadIds: ['qa-fix-1'],
      improvementTicketIds: ['QA-2'],
      itemCounts: { pass: 0, fail: 1, waive: 0, improvement: 1, pending: 0 },
      nextAction: 'return_to_coding',
    }))
    persistManualQaSummary(ticketDir, summary(2, {
      createdFixBeadIds: ['qa-fix-1', 'qa-fix-2'],
      improvementTicketIds: ['QA-3'],
    }))

    expect(readManualQaDeliverySummary(ticketDir)).toEqual({
      version: 2,
      outcome: 'passed',
      createdFixBeadIds: ['qa-fix-1', 'qa-fix-2'],
      improvementTicketIds: ['QA-2', 'QA-3'],
      waivedItemIds: [],
      skipReason: null,
    })
  })
})
