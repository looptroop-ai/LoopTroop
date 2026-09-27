import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeManualQaRound,
  manualQaEvidenceUrl,
  newManualQaActionId,
  useManualQaIndex,
  useManualQaRound,
  useRemoveManualQaEvidence,
  useResolveManualQaDrift,
  useSkipManualQa,
  useSubmitManualQa,
  useUploadManualQaEvidence,
} from '../useManualQA'

function createQueryHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

describe('useManualQaRound', () => {
  afterEach(() => vi.restoreAllMocks())

  it('polls again while the server is generating a checklist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'generating' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { client, wrapper } = createQueryHarness()
    const { result } = renderHook(() => useManualQaRound('ticket-1', 3), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const query = client.getQueryCache().find({ queryKey: ['manual-qa', 'ticket-1', 'version', 3] })!
    const refetchInterval = query.options.refetchInterval
    expect(typeof refetchInterval).toBe('function')
    if (typeof refetchInterval === 'function') expect(refetchInterval(query)).toBeGreaterThan(0)
  })

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
      checklist: {
        schemaVersion: 1,
        version: 1,
        items: [],
        notApplicablePrdRefs: [{ ref: 'EP/ST/AC-3', reason: 'Verified by the release pipeline.' }],
      },
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
    expect(result.current.data?.checklist?.notApplicablePrdRefs).toEqual([
      { ref: 'EP/ST/AC-3', reason: 'Verified by the release pipeline.' },
    ])
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

  it('normalizes legacy numeric versions and the completed-round count fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      activeVersion: 3,
      completedRoundCount: 2,
      latestOutcome: 'passed',
      artifactAvailable: true,
      versions: [1, 3, { version: 4 }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const { wrapper } = createQueryHarness()

    const { result } = renderHook(() => useManualQaIndex('ticket-1'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data?.completedRounds).toBe(2)
    expect(result.current.data?.versions).toEqual([
      { version: 1, status: 'completed', artifactAvailable: true, phaseAttempt: null },
      { version: 3, status: 'waiting', artifactAvailable: true, phaseAttempt: null },
      { version: 4, status: 'completed', outcome: undefined, completedAt: null, artifactAvailable: false, phaseAttempt: null },
    ])
  })
})

describe('Manual QA mutations', () => {
  afterEach(() => vi.restoreAllMocks())

  const action = {
    ticketId: 'ticket-1',
    version: 2,
    actionId: 'manual-qa:test-action',
    expectedChecklistHash: 'checklist-hash',
    expectedDraftRevision: 4,
  }

  it('submits and skips a round with guarded request bodies and refreshes dependent queries', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"success":true}', { status: 200 }))
    const { client, wrapper } = createQueryHarness()
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)

    const submit = renderHook(() => useSubmitManualQa(), { wrapper })
    await act(async () => {
      await submit.result.current.mutateAsync({ ...action, draft: { results: {} } })
    })
    expect(fetch.mock.calls[0]?.[0]).toContain('/tickets/ticket-1/manual-qa/submit')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: action.version,
        actionId: action.actionId,
        expectedChecklistHash: action.expectedChecklistHash,
        expectedDraftRevision: action.expectedDraftRevision,
        draft: { results: {} },
      }),
    })
    expect(invalidate.mock.calls.map(([filters]) => filters.queryKey)).toEqual([
      ['manual-qa', 'ticket-1', 'version', 2],
      ['manual-qa', 'ticket-1', 'index'],
      ['ticket', 'ticket-1'],
      ['tickets'],
    ])
    submit.unmount()

    invalidate.mockClear()
    const skip = renderHook(() => useSkipManualQa(), { wrapper })
    await act(async () => {
      await skip.result.current.mutateAsync({ ...action, reason: 'Not testable here.', draft: { results: {} } })
    })
    expect(fetch.mock.calls[1]?.[0]).toContain('/tickets/ticket-1/manual-qa/skip')
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ reason: 'Not testable here.' })
    expect(invalidate).toHaveBeenCalledTimes(4)
  })

  it.each(['include', 'discard'] as const)('resolves workspace drift by %s and refreshes the round', async (decision) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"success":true}', { status: 200 }))
    const { client, wrapper } = createQueryHarness()
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)
    const { result } = renderHook(() => useResolveManualQaDrift(decision), { wrapper })

    await act(async () => { await result.current.mutateAsync(action) })

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/tickets/ticket-1/manual-qa/workspace-drift/${decision}`),
      expect.objectContaining({ method: 'POST' }),
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['manual-qa', 'ticket-1', 'version', 2] })
  })

  it('returns normalized uploaded evidence and invalidates the round cache', async () => {
    const evidence = {
      id: 'evidence-1', itemId: 'qa-1', name: 'Image', size: 4, sha256: 'hash', mediaType: 'image/png', inlinePreview: true,
    }
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ evidence }), { status: 200 }))
    const { client, wrapper } = createQueryHarness()
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)
    const { result } = renderHook(() => useUploadManualQaEvidence(), { wrapper })
    const file = new File(['data'], 'screen shot.png')

    let uploaded
    await act(async () => {
      uploaded = await result.current.mutateAsync({
        ...action, itemId: 'qa-1', evidenceId: 'evidence-1', file,
      })
    })

    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toContain('/tickets/ticket-1/manual-qa/versions/2/evidence?')
    expect(String(url)).toContain('itemId=qa-1')
    expect(String(url)).toContain('expectedDraftRevision=4')
    expect(init).toMatchObject({
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': 'screen%20shot.png',
        'X-Evidence-Id': 'evidence-1',
      },
      body: file,
    })
    expect(uploaded).toMatchObject({ ...evidence, previewable: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['manual-qa', 'ticket-1', 'version', 2] })
  })

  it('normalizes a direct evidence upload response as well as a wrapped response', async () => {
    const evidence = {
      id: 'evidence-direct', itemId: 'qa-1', originalName: 'trace.txt', size: 8, inlinePreview: false,
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(evidence), { status: 200 }))
    const { wrapper } = createQueryHarness()
    const { result } = renderHook(() => useUploadManualQaEvidence(), { wrapper })

    let uploaded: unknown
    await act(async () => {
      uploaded = await result.current.mutateAsync({
        ...action, itemId: 'qa-1', evidenceId: evidence.id, file: new File(['trace'], 'trace.txt', { type: 'text/plain' }),
      })
    })

    expect(uploaded).toMatchObject({
      ...evidence,
      name: 'trace.txt',
      mediaType: 'application/octet-stream',
      previewable: false,
    })
  })

  it('removes evidence using route ids and sends only optimistic concurrency fields in the body', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"success":true}', { status: 200 }))
    const { client, wrapper } = createQueryHarness()
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)
    const { result } = renderHook(() => useRemoveManualQaEvidence(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ ...action, itemId: 'qa-1', evidenceId: 'evidence-1' })
    })

    expect(fetch.mock.calls[0]?.[0]).toContain('/tickets/ticket-1/manual-qa/versions/2/evidence/qa-1/evidence-1')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      actionId: action.actionId,
      expectedChecklistHash: action.expectedChecklistHash,
      expectedDraftRevision: action.expectedDraftRevision,
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['manual-qa', 'ticket-1', 'version', 2] })
  })

  it('surfaces a server rejection without invalidating successful-round caches', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"message":"stale checklist"}', { status: 409 }))
    const { client, wrapper } = createQueryHarness()
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)
    const { result } = renderHook(() => useSubmitManualQa(), { wrapper })

    await act(async () => {
      await expect(result.current.mutateAsync({ ...action, draft: { results: {} } })).rejects.toThrow()
    })
    expect(invalidate).not.toHaveBeenCalled()
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

  it('normalizes evidence, linked observations, and improvement drafts from an array-shaped response', () => {
    const round = normalizeManualQaRound({
      evidence: [
        {
          id: 'evidence-1', itemId: 'qa-1', name: 'Screenshot', size: 12, sha256: 'a'.repeat(64), mediaType: 'image/png',
          previewable: true, createdAt: '2026-01-01T00:00:00.000Z', downloadUrl: '/evidence/1',
          originalName: 'screen.png', storedName: 'stored.png',
        },
        { id: 'evidence-2', itemId: 'qa-1', originalName: 'inline.png', inlinePreview: true },
        null,
      ],
      draft: {
        improvements: [{
          id: 'improvement-1', title: 'Retry checkout', description: 'Explain declines.', priority: 0,
          manualQaEnabled: true, contextOverride: 'Checkout context.', evidenceIds: ['evidence-1'],
        }],
        results: [
          {
            itemId: 'qa-1', outcome: 'improvement', note: 'Needs a clearer message.', observation: 'Card was rejected.',
            reason: 'The copy is vague.', evidenceIds: ['evidence-1'], mergeWithItemIds: ['qa-2'],
            links: [{ id: 'spec', url: 'https://example.test/spec', label: 'Spec' }, { url: '/issue' }],
            improvementDraftId: 'improvement-1',
          },
          { itemId: 'qa-2', status: 'fail', improvementDraftId: 'missing', links: [{}] },
          { status: 'pending' },
        ],
      },
    }, 2)

    expect(round.evidence).toEqual([
      expect.objectContaining({
        id: 'evidence-1', name: 'Screenshot', size: 12, previewable: true, downloadUrl: '/evidence/1',
        originalName: 'screen.png', storedName: 'stored.png', inlinePreview: false,
      }),
      expect.objectContaining({
        id: 'evidence-2', name: 'inline.png', size: 0, mediaType: 'application/octet-stream', previewable: true, inlinePreview: true,
      }),
      expect.objectContaining({ id: '', itemId: '', name: 'Evidence', size: 0, previewable: false }),
    ])
    expect(round.draft?.results).toEqual({
      'qa-1': expect.objectContaining({
        status: 'improvement', note: 'Needs a clearer message.', observation: 'Card was rejected.',
        waiverReason: 'The copy is vague.', evidenceIds: ['evidence-1'], mergeWithItemIds: ['qa-2'],
        links: [{ id: 'spec', url: 'https://example.test/spec', label: 'Spec' }, { id: '', url: '/issue', label: undefined }],
        improvement: {
          title: 'Retry checkout', description: 'Explain declines.', priority: 3, manualQaEnabled: true,
          contextOverride: 'Checkout context.', evidenceIds: ['evidence-1'],
        },
      }),
      'qa-2': expect.objectContaining({ status: 'fail', links: [{ id: '', url: '', label: undefined }], improvement: undefined }),
    })
  })
})

describe('Manual QA evidence helpers', () => {
  it('builds inline and download URLs and gives actions their caller prefix', () => {
    expect(manualQaEvidenceUrl('ticket/1', 2, 'qa 1', 'evidence/1')).toBe(
      '/api/tickets/ticket%2F1/manual-qa/versions/2/evidence/qa%201/evidence%2F1',
    )
    expect(manualQaEvidenceUrl('ticket/1', 2, 'qa 1', 'evidence/1', true)).toBe(
      '/api/tickets/ticket%2F1/manual-qa/versions/2/evidence/qa%201/evidence%2F1?inline=true',
    )
    expect(newManualQaActionId('manual-qa-submit')).toMatch(/^manual-qa-submit:.+/)
  })
})
