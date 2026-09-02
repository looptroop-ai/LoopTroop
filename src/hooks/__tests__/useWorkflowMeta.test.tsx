import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKFLOW_GROUPS, WORKFLOW_PHASES } from '@shared/workflowMeta'
import { useWorkflowMeta } from '../useWorkflowMeta'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useWorkflowMeta', () => {
  it('serves the shared table without a request', () => {
    // It was a query that could never reach the network: seeded with these same
    // constants, never stale, never invalidated. Keeping the query only meant a
    // fetcher nobody could reach and an `isLoading` that was always false.
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const { result } = renderHook(() => useWorkflowMeta())

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.current.groups).toBe(WORKFLOW_GROUPS)
    expect(result.current.phases).toBe(WORKFLOW_PHASES)
    expect(result.current.isLoading).toBe(false)
  })

  it('keeps the phase map consumers index into, one entry per declared phase', () => {
    const { result, rerender } = renderHook(() => useWorkflowMeta())
    const first = result.current.phaseMap

    expect(Object.keys(first)).toHaveLength(WORKFLOW_PHASES.length)
    expect(first[WORKFLOW_PHASES[0]!.id]).toBe(WORKFLOW_PHASES[0])

    rerender()
    // A new object per render would invalidate every memo that lists it.
    expect(result.current.phaseMap).toBe(first)
  })
})
