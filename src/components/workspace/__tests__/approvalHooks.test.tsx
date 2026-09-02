import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { useDebouncedApprovalUiState } from '../approvalHooks'

interface HarnessProps {
  snapshot: { value: string }
  saveUiState: (input: { ticketId: string; scope: string; data: { value: string } }) => Promise<unknown>
}

function useHarness({ snapshot, saveUiState }: HarnessProps) {
  const lastSavedSnapshotRef = useRef('')

  const autosave = useDebouncedApprovalUiState({
    enabled: true,
    snapshot,
    ticketId: '1:T-42',
    scope: 'approval_prd',
    saveUiState,
    lastSavedSnapshotRef,
    delayMs: 10,
  })

  return { lastSavedSnapshotRef, autosave }
}

describe('useDebouncedApprovalUiState', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('marks a draft snapshot as saved only after the save succeeds', async () => {
    vi.useFakeTimers()
    const saveUiState = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ success: true })

    try {
      const { result, rerender } = renderHook(
        (props: HarnessProps) => useHarness(props),
        { initialProps: { snapshot: { value: 'first' }, saveUiState } },
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
        await Promise.resolve()
      })

      expect(saveUiState).toHaveBeenCalledTimes(1)
      expect(result.current.lastSavedSnapshotRef.current).toBe('')
      expect(result.current.autosave.state).toBe('error')

      rerender({ snapshot: { value: 'second' }, saveUiState })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
        await Promise.resolve()
      })

      expect(result.current.lastSavedSnapshotRef.current).toBe(JSON.stringify({ value: 'second' }))
      expect(result.current.autosave.state).toBe('saved')
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('reports acknowledged timestamps and conflicts without marking the local snapshot saved', async () => {
    vi.useFakeTimers()
    const updatedAt = '2026-07-20T12:00:00.000Z'
    const saveUiState = vi.fn()
      .mockResolvedValueOnce({ conflict: false, updatedAt })
      .mockResolvedValueOnce({ conflict: true, updatedAt: '2026-07-20T12:01:00.000Z' })

    try {
      const { result, rerender } = renderHook(
        (props: HarnessProps) => useHarness(props),
        { initialProps: { snapshot: { value: 'first' }, saveUiState } },
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })

      expect(result.current.autosave.state).toBe('saved')
      expect(result.current.autosave.lastSavedAt?.toISOString()).toBe(updatedAt)

      rerender({ snapshot: { value: 'second' }, saveUiState })
      expect(result.current.autosave.state).toBe('pending')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })

      expect(result.current.autosave.state).toBe('conflict')
      expect(result.current.lastSavedSnapshotRef.current).toBe(JSON.stringify({ value: 'first' }))
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('remains saving until the in-flight request is acknowledged', async () => {
    vi.useFakeTimers()
    let resolveSave: ((value: unknown) => void) | undefined
    const saveUiState = vi.fn(() => new Promise((resolve) => {
      resolveSave = resolve
    }))

    try {
      const { result } = renderHook(
        (props: HarnessProps) => useHarness(props),
        { initialProps: { snapshot: { value: 'delayed' }, saveUiState } },
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
      expect(result.current.autosave.state).toBe('saving')
      expect(result.current.lastSavedSnapshotRef.current).toBe('')

      await act(async () => {
        resolveSave?.({ conflict: false, updatedAt: '2026-07-20T12:00:00.000Z' })
        await Promise.resolve()
      })
      expect(result.current.autosave.state).toBe('saved')
      expect(result.current.lastSavedSnapshotRef.current).toBe(JSON.stringify({ value: 'delayed' }))
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('flushes the latest unsaved snapshot on pagehide with a keepalive request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const saveUiState = vi.fn().mockResolvedValue({ success: true })

    renderHook(
      (props: HarnessProps) => useHarness(props),
      { initialProps: { snapshot: { value: 'leaving' }, saveUiState } },
    )

    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] ?? []
    expect(url).toBe(`/api/tickets/${encodeURIComponent('1:T-42')}/ui-state`)
    expect(init).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    })
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      scope: 'approval_prd',
      data: { value: 'leaving' },
      expectedRevision: expect.any(Number),
      actionId: expect.any(String),
    })
  })
})
