import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeManualQaRound, useManualQaIndex, useManualQaRound } from '../useManualQA'

describe('useManualQaRound', () => {
  afterEach(() => vi.restoreAllMocks())

  it('normalizes checklist items with the documented Manual QA schema', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      version: 1,
      checklist: {
        schemaVersion: 1,
        version: 1,
        items: [{
          id: 'qa-1', lineageId: 'checkout', source: 'implementation_diff',
          behavior: 'Checkout reports a useful error.', severity: 'required', recheckState: 'new',
          prerequisites: [], actions: ['Submit an invalid card.'], expectedResult: 'A useful error appears.', prdRefs: [],
        }],
      },
      coverage: { entries: [], sourceItemCounts: { prd: 0, bead: 0, previousQa: 0, implementationDiff: 1 } },
      evidence: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

    const { result } = renderHook(() => useManualQaRound('ticket-1', 1), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data?.checklist?.items[0]).toMatchObject({
      source: 'implementation_diff', severity: 'required', recheckState: 'new',
    })
    expect(result.current.data?.checklist?.items[0]).not.toHaveProperty('required')
    expect(result.current.data?.coverageSummary.sourceItemCounts).toEqual({
      prd: 0, bead: 0, previousQa: 0, implementationDiff: 1,
    })
  })

  it('normalizes durable operation state for resumable submission UI', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      version: 2,
      status: 'waiting',
      checklistHash: 'a'.repeat(64),
      checklist: { schemaVersion: 1, version: 2, items: [] },
      coverage: { entries: [] },
      evidence: [],
      draftRevision: 3,
      operation: {
        actionId: 'manual-qa-submit:resume-2',
        operationType: 'submit',
        state: 'creating_improvements',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(() => useManualQaRound('ticket-1', 2), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data?.operation).toMatchObject({
      actionId: 'manual-qa-submit:resume-2',
      operationType: 'submit',
      state: 'creating_improvements',
      status: 'creating_improvements',
    })
  })

  it('preserves complete round summaries and coverage provenance', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      version: 1,
      status: 'completed',
      checklistHash: 'b'.repeat(64),
      checklist: { schemaVersion: 1, version: 1, items: [] },
      coverage: {
        entries: [
          { criterionRef: 'EP/ST/AC-1', criterion: 'The behavior works', status: 'covered', itemIds: ['item-1'] },
          { criterionRef: 'EP/ST/AC-2', criterion: 'The build records metadata', status: 'not_applicable', itemIds: [], reason: 'Pipeline-only verification.' },
        ],
        coveredCount: 1, partiallyCoveredCount: 0, uncoveredCount: 0, notApplicableCount: 1,
        sourceItemCounts: { prd: 1, bead: 2, previousQa: 4, implementationDiff: 5 },
      },
      evidence: [],
      summary: {
        outcome: 'created_fixes', createdFixBeadIds: ['QA-1'], improvementTicketIds: ['APP-2'], waivedItemIds: ['item-1'], waivedItems: [{ itemId: 'item-1', reason: 'Device unavailable' }],
        startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z', durationMs: 60_000,
        itemCounts: { pass: 1, fail: 1, waive: 1, improvement: 1, pending: 0 }, requiredItemCount: 2, optionalItemCount: 2, evidenceCount: 3,
        nextAction: 'return_to_coding', coverage: { covered: 1, partiallyCovered: 0, uncovered: 0, notApplicable: 1 },
        modelCapability: { modelId: 'model', modelVariant: 'fast', capabilityLookup: 'available', supportsImages: true, imageEvidenceMode: 'attached' },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

    const { result } = renderHook(() => useManualQaRound('ticket-1', 1), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data?.coverage[0]).toMatchObject({ criterion: 'The behavior works' })
    expect(result.current.data?.coverage[1]).toMatchObject({ status: 'not_applicable', reason: 'Pipeline-only verification.' })
    expect(result.current.data?.coverageSummary.notApplicableCount).toBe(1)
    expect(result.current.data?.coverageSummary.sourceItemCounts).toEqual({ prd: 1, bead: 2, previousQa: 4, implementationDiff: 5 })
    expect(result.current.data?.summary).toMatchObject({
      createdFixBeadIds: ['QA-1'], improvementTicketIds: ['APP-2'], durationMs: 60_000,
      modelCapability: { imageEvidenceMode: 'attached' }, coverage: { notApplicable: 1 },
    })
  })
})

describe('useManualQaIndex', () => {
  afterEach(() => vi.restoreAllMocks())

  it('preserves artifact availability and phase-attempt identity for each round', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      activeVersion: 2,
      completedRounds: 1,
      latestOutcome: 'created_fixes',
      artifactAvailable: false,
      versions: [
        { version: 1, status: 'completed', outcome: 'created_fixes', completedAt: '2026-07-14T10:00:00.000Z', artifactAvailable: true, phaseAttempt: 3 },
        { version: 2, status: 'generating', artifactAvailable: false, phaseAttempt: 4 },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

    const { result } = renderHook(() => useManualQaIndex('ticket-1'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data?.versions).toEqual([
      expect.objectContaining({ version: 1, artifactAvailable: true, phaseAttempt: 3 }),
      expect.objectContaining({ version: 2, artifactAvailable: false, phaseAttempt: 4 }),
    ])
  })
})

describe('normalizeManualQaRound draft', () => {
  const draftPayload = {
    draft: {
      skipReason: 'Covered by the integration suite.',
      results: [{ itemId: 'qa-1', status: 'pass' }],
    },
  }

  it('keeps the skip reason on the restored draft', () => {
    // The normaliser returned `{ results }` alone, so the restore that reads
    // `restored.skipReason` found a field it had just dropped and a typed
    // reason vanished on reload.
    const round = normalizeManualQaRound(draftPayload, 1)
    expect(round.draft?.skipReason).toBe('Covered by the integration suite.')
    expect(round.draft?.results['qa-1']?.status).toBe('pass')
  })

  it('omits the skip reason when there is none to keep', () => {
    const round = normalizeManualQaRound({ draft: { results: [{ itemId: 'qa-1', status: 'pass' }] } }, 1)
    expect(round.draft?.skipReason).toBeUndefined()
  })

  it('keeps the skip reason for a legacy keyed-results draft too', () => {
    const round = normalizeManualQaRound({
      draft: { skipReason: 'Legacy shape.', results: { 'qa-1': { itemId: 'qa-1', status: 'pass' } } },
    }, 1)
    expect(round.draft?.skipReason).toBe('Legacy shape.')
  })
})
