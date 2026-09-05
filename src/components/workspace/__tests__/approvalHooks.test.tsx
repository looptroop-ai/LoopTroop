import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { useApprovalDraftRestore, useDebouncedApprovalUiState } from '../approvalHooks'

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

interface RestoreHarnessProps {
  document: { id: string } | null
  ready?: boolean
  persisted: { tab: string } | undefined
  restore: (persisted: { tab: string } | undefined, document: { id: string }) => unknown
}

function useRestoreHarness({ document, ready, persisted, restore }: RestoreHarnessProps) {
  const restoredDraftRef = useRef(false)
  const lastSavedSnapshotRef = useRef('')

  useApprovalDraftRestore({
    document,
    ...(ready === undefined ? {} : { ready }),
    persisted,
    restoredDraftRef,
    lastSavedSnapshotRef,
    restore,
  })

  return { restoredDraftRef, lastSavedSnapshotRef }
}

describe('useApprovalDraftRestore', () => {
  const DOCUMENT = { id: 'doc-1' }

  it('restores once, from the persisted state, and records the baseline snapshot', () => {
    const restore = vi.fn(() => ({ tab: 'yaml' }))
    const { result, rerender } = renderHook(
      (props: RestoreHarnessProps) => useRestoreHarness(props),
      { initialProps: { document: DOCUMENT, persisted: { tab: 'yaml' }, restore } },
    )

    expect(restore).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledWith({ tab: 'yaml' }, DOCUMENT)
    expect(result.current.restoredDraftRef.current).toBe(true)
    expect(result.current.lastSavedSnapshotRef.current).toBe(JSON.stringify({ tab: 'yaml' }))

    rerender({ document: DOCUMENT, persisted: { tab: 'structured' }, restore })
    expect(restore).toHaveBeenCalledTimes(1)
  })

  /**
   * Restoring before the document arrives would write a snapshot of empty state
   * and then mark the pane restored, so the real document would never reach the
   * editors — and the autosave would treat the first render as a user edit.
   */
  it('waits for the document', () => {
    const restore = vi.fn(() => ({ tab: 'structured' }))
    const { result, rerender } = renderHook(
      (props: RestoreHarnessProps) => useRestoreHarness(props),
      { initialProps: { document: null as { id: string } | null, persisted: undefined, restore } },
    )

    expect(restore).not.toHaveBeenCalled()
    expect(result.current.restoredDraftRef.current).toBe(false)
    expect(result.current.lastSavedSnapshotRef.current).toBe('')

    rerender({ document: DOCUMENT, persisted: undefined, restore })

    expect(restore).toHaveBeenCalledWith(undefined, DOCUMENT)
    expect(result.current.lastSavedSnapshotRef.current).toBe(JSON.stringify({ tab: 'structured' }))
  })

  it('waits for anything else the pane says it is waiting for', () => {
    const restore = vi.fn(() => ({ tab: 'answers' }))
    const { result, rerender } = renderHook(
      (props: RestoreHarnessProps) => useRestoreHarness(props),
      { initialProps: { document: DOCUMENT, ready: false, persisted: undefined, restore } },
    )

    expect(restore).not.toHaveBeenCalled()

    rerender({ document: DOCUMENT, ready: true, persisted: undefined, restore })

    expect(restore).toHaveBeenCalledTimes(1)
    expect(result.current.restoredDraftRef.current).toBe(true)
  })

  /**
   * The snapshot has to be in place before the pane counts as restored: the
   * autosave is enabled by that flag, and a baseline of `''` reads as a dirty
   * draft the user never typed. Recorded through refs that log their own writes,
   * because a ref assignment causes no re-render for a render body to observe.
   */
  it('writes the baseline before marking the pane restored', () => {
    const writes: string[] = []
    const restoredDraftRef = {
      _value: false,
      get current() { return this._value },
      set current(next: boolean) { writes.push('restored-flag'); this._value = next },
    }
    const lastSavedSnapshotRef = {
      _value: '',
      get current() { return this._value },
      set current(next: string) { writes.push('baseline-snapshot'); this._value = next },
    }

    renderHook(() => useApprovalDraftRestore({
      document: DOCUMENT,
      persisted: undefined,
      restoredDraftRef,
      lastSavedSnapshotRef,
      restore: () => ({ tab: 'answers' }),
    }))

    expect(writes).toEqual(['baseline-snapshot', 'restored-flag'])
    expect(lastSavedSnapshotRef.current).toBe(JSON.stringify({ tab: 'answers' }))
  })

  /**
   * The drag that cost this fix. The persisted draft arrived after the document
   * already had, so the pane restored its defaults, latched `restoredDraftRef`,
   * and then discarded the real draft that landed a moment later. The latch
   * that keeps the restore one-shot is exactly what makes the timing race —
   * which is why `ready` is there: the pane only restores once it has both the
   * document and the UI state, so "persisted" is a genuine value rather than a
   * still-loading gap.
   */
  it('does not restore, then discard a draft that arrives after the document', () => {
    // Echoes what it was handed, the way a real pane's restore does: the
    // baseline snapshot is then the draft that was actually applied, so a
    // restore from the wrong input shows up in the snapshot rather than
    // hiding behind a fixed return value.
    const restore = vi.fn((draft: { tab: string } | undefined) => draft ?? { tab: 'default' })
    const { result, rerender } = renderHook(
      (props: RestoreHarnessProps) => useRestoreHarness(props),
      { initialProps: {
        document: null as { id: string } | null,
        ready: false,
        persisted: undefined as { tab: string } | undefined,
        restore,
      } },
    )

    // Document arrives before the over-debounced UI-state query settles.
    rerender({ document: DOCUMENT, ready: false, persisted: undefined, restore })
    expect(restore).not.toHaveBeenCalled()

    // The UI state resolves: the draft the user actually saved.
    rerender({ document: DOCUMENT, ready: true, persisted: { tab: 'answers' }, restore })

    expect(restore).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledWith({ tab: 'answers' }, DOCUMENT)
    expect(result.current.lastSavedSnapshotRef.current).toBe(JSON.stringify({ tab: 'answers' }))
    expect(result.current.restoredDraftRef.current).toBe(true)
  })

  /**
   * Restore is held through a ref so the one-shot effect does not re-run on
   * every render, and the ref is refreshed in an earlier effect. These two have
   * to be in that order: a render where the document arrives first, restores,
   * and only then the real restore closure (the one that reads the draft the
   * user needs) becomes available must still use the current one. If the ref
   * were updated after the restore effect, the baseline would be the default.
   */
  it('uses the current restore closure even when its identity changes before a retry', () => {
    const first = vi.fn(() => ({ tab: 'default' }))
    const current = vi.fn(() => ({ tab: 'answers' }))
    const { result, rerender } = renderHook(
      (props: RestoreHarnessProps) => useRestoreHarness(props),
      { initialProps: {
        document: null as { id: string } | null,
        ready: true,
        persisted: undefined as { tab: string } | undefined,
        restore: first,
      } },
    )

    // Document and readiness both arrive in the same render as the saved draft.
    rerender({ document: DOCUMENT, ready: true, persisted: { tab: 'answers' }, restore: current })

    expect(current).toHaveBeenCalledWith({ tab: 'answers' }, DOCUMENT)
    expect(first).not.toHaveBeenCalled()
    expect(result.current.lastSavedSnapshotRef.current).toBe(JSON.stringify({ tab: 'answers' }))
  })
})
