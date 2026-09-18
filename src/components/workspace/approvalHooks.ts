import { useEffect, useRef, useState, useCallback, type Dispatch, type SetStateAction, type RefObject } from 'react'
import {
  createTicketUiStateActionId,
  getTicketUiStateRevision,
  rememberTicketUiStateRevision,
} from '@/lib/ticketUiStateRevision'
import type { AutosaveStatusState } from './AutosaveStatus'
import type { QueryClient } from '@tanstack/react-query'
import * as ticketUiStateWrites from '@/hooks/useTickets'
import { apiTicketPath } from '@/lib/apiPaths'
import { throwIfNotOk } from '@/lib/fetchError'
import { clearTicketArtifactsCache } from '@/hooks/useTicketArtifacts'
import { DRAFT_AUTOSAVE_DEBOUNCE_MS } from '@/lib/constants'

interface SaveTicketUiStateInput<T> {
  ticketId: string
  scope: string
  data: T
}

type SaveTicketUiStateFn<T> = (input: SaveTicketUiStateInput<T>) => Promise<unknown> | void

interface UseDebouncedApprovalUiStateOptions<T> {
  enabled: boolean
  snapshot: T
  ticketId: string
  scope: string
  saveUiState: SaveTicketUiStateFn<T>
  /**
   * `RefObject`, not the deprecated `MutableRefObject`: in React 19's typings
   * `RefObject<T>` is `{ current: T }` — mutable — so the refs this module
   * assigns to keep working. On React 18 typings it would be read-only.
   */
  lastSavedSnapshotRef: RefObject<string>
  queryClient?: QueryClient
  initialUpdatedAt?: string | null
  initialFlushState?: UiStateFlushState
  restoredDraftRef?: RefObject<boolean>
  restoredSnapshotRef?: RefObject<string | null>
  delayMs?: number
}

export type UiStateFlushState = 'pending' | 'failed' | null

export interface ApprovalAutosaveStatus {
  state: AutosaveStatusState
  lastSavedAt: Date | null
}

function parseAutosaveResponse(value: unknown): { conflict: boolean; updatedAt: string | null } {
  if (!value || typeof value !== 'object') return { conflict: false, updatedAt: null }
  const candidate = value as { conflict?: unknown; updatedAt?: unknown }
  return {
    conflict: candidate.conflict === true,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : null,
  }
}

export const UI_STATE_FLUSH_ERROR_EVENT = 'looptroop:ui-state-flush-error'
export const UI_STATE_FLUSH_SUCCESS_EVENT = 'looptroop:ui-state-flush-success'
const uiStateFlushSequences = new WeakMap<QueryClient, Map<string, number>>()
const fallbackUiStateWriteGenerations = new Map<string, number>()

function uiStateWriteKey(ticketId: string, scope: string): string {
  return `${ticketId}\u0000${scope}`
}

function beginUiStateWrite(ticketId: string, scope: string): number {
  const sharedBegin = ticketUiStateWrites.beginTicketUiStateWrite
  if (typeof sharedBegin === 'function') return sharedBegin(ticketId, scope)
  const key = uiStateWriteKey(ticketId, scope)
  const generation = (fallbackUiStateWriteGenerations.get(key) ?? 0) + 1
  fallbackUiStateWriteGenerations.set(key, generation)
  return generation
}

function isCurrentUiStateWrite(ticketId: string, scope: string, generation: number): boolean {
  const sharedCheck = ticketUiStateWrites.isCurrentTicketUiStateWrite
  if (typeof sharedCheck === 'function') return sharedCheck(ticketId, scope, generation)
  return fallbackUiStateWriteGenerations.get(uiStateWriteKey(ticketId, scope)) === generation
}

function reportUiStateFlushError(ticketId: string, scope: string, message: string, writeGeneration: number): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(UI_STATE_FLUSH_ERROR_EVENT, {
    detail: { ticketId, scope, message, writeGeneration },
  }))
}

function reportUiStateFlushSuccess(ticketId: string, scope: string, serialized: string, writeGeneration: number): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(UI_STATE_FLUSH_SUCCESS_EVENT, {
    detail: { ticketId, scope, serialized, writeGeneration },
  }))
}

function updateUiStateCache<T>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  ticketId: string,
  scope: string,
  data: T,
  expectedRevision: number,
): void {
  queryClient.setQueryData<Record<string, unknown>>(queryKey, (current) => ({
    ...(current ?? {}),
    scope,
    ticketId,
    exists: true,
    data,
    flushPending: true,
    flushFailed: false,
    revision: typeof current?.revision === 'number' ? current.revision : expectedRevision,
    clientRevision: typeof current?.clientRevision === 'number' ? current.clientRevision : expectedRevision,
  }))
}

export function flushTicketUiStateSnapshot<T>(
  ticketId: string,
  scope: string,
  data: T,
  options: { queryClient?: QueryClient } = {},
): boolean {
  const expectedRevision = getTicketUiStateRevision(ticketId, scope)
  const writeGeneration = beginUiStateWrite(ticketId, scope)
  const payload = JSON.stringify({ scope, data, expectedRevision, actionId: createTicketUiStateActionId() })
  const queryKey = ['ticket-ui-state', ticketId, scope] as const
  const sequenceMap = options.queryClient
    ? (uiStateFlushSequences.get(options.queryClient) ?? new Map<string, number>())
    : null
  if (options.queryClient && sequenceMap) {
    uiStateFlushSequences.set(options.queryClient, sequenceMap)
    const key = `${ticketId}\u0000${scope}`
    sequenceMap.set(key, (sequenceMap.get(key) ?? 0) + 1)
    updateUiStateCache(options.queryClient, queryKey, ticketId, scope, data, expectedRevision)
  }
  const sequence = sequenceMap?.get(`${ticketId}\u0000${scope}`) ?? 0
  const isLatest = () => !options.queryClient || sequenceMap?.get(`${ticketId}\u0000${scope}`) === sequence
  const onFailure = () => {
    if (!isCurrentUiStateWrite(ticketId, scope, writeGeneration)) return
    if (options.queryClient && isLatest()) {
      // Keep the draft in the cache so an immediate remount can restore it and
      // offer a retry. Restoring the older cache here loses the only copy of a
      // draft when the component that initiated the keepalive has unmounted.
      options.queryClient.setQueryData<Record<string, unknown>>(queryKey, (current) => ({
        ...(current ?? {}),
        scope,
        ticketId,
        exists: true,
        data,
        flushPending: false,
        flushFailed: true,
      }))
    }
    reportUiStateFlushError(ticketId, scope, 'The latest draft could not be saved while leaving the ticket.', writeGeneration)
  }
  const onResponse = async (response: Response) => {
    if (!response.ok) throw new Error(`UI-state flush failed with ${response.status}`)
    if (!options.queryClient || !isLatest() || !isCurrentUiStateWrite(ticketId, scope, writeGeneration)) return
    let saved: unknown = null
    try { saved = await response.json() } catch { /* Some keepalive test doubles have no body. */ }
    if (!isLatest() || !isCurrentUiStateWrite(ticketId, scope, writeGeneration)) return
    if (!saved || typeof saved !== 'object') {
      options.queryClient.setQueryData<Record<string, unknown>>(queryKey, (current) => ({
        ...(current ?? {}),
        scope,
        ticketId,
        flushPending: false,
        flushFailed: false,
      }))
      reportUiStateFlushSuccess(ticketId, scope, JSON.stringify(data), writeGeneration)
      return
    }
    const result = saved as { conflict?: unknown; data?: unknown; updatedAt?: unknown; revision?: unknown; clientRevision?: unknown }
    if (typeof result.revision === 'number') rememberTicketUiStateRevision(ticketId, scope, result.revision)
    options.queryClient.setQueryData<Record<string, unknown>>(queryKey, (current) => ({
      ...(current ?? {}),
      scope,
      ticketId,
      exists: result.conflict === true ? result.data !== null : true,
      data: result.conflict === true ? result.data ?? null : data,
      flushPending: false,
      flushFailed: false,
      updatedAt: typeof result.updatedAt === 'string' ? result.updatedAt : current?.updatedAt ?? null,
      revision: typeof result.revision === 'number' ? result.revision : current?.revision ?? expectedRevision,
      clientRevision: typeof result.clientRevision === 'number' ? result.clientRevision : current?.clientRevision ?? expectedRevision,
    }))
    if (result.conflict !== true) reportUiStateFlushSuccess(ticketId, scope, JSON.stringify(data), writeGeneration)
  }

  if (typeof fetch === 'function') {
    try {
      void fetch(apiTicketPath(ticketId, 'ui-state'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).then(onResponse).catch(onFailure)
      return true
    } catch {
      // Fall through to sendBeacon below.
    }
  }

  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const sent = navigator.sendBeacon(
        apiTicketPath(ticketId, 'ui-state'),
        new Blob([payload], { type: 'application/json' }),
      )
      if (!sent) onFailure()
      return sent
    } catch {
      onFailure()
      return false
    }
  }

  onFailure()
  return false
}

export function useLoadedContentHash(
  ticketId: string,
  currentHash: string | null,
  hasLocalEdits: boolean,
): RefObject<string | null> {
  const baselineRef = useRef<{ ticketId: string; hash: string | null }>({ ticketId, hash: null })
  if (baselineRef.current.ticketId !== ticketId) {
    baselineRef.current = { ticketId, hash: null }
  }
  if (!hasLocalEdits && currentHash) baselineRef.current.hash = currentHash
  return {
    get current() { return baselineRef.current.hash },
    set current(value: string | null) { baselineRef.current.hash = value },
  }
}

export function useApprovalDraftReset(
  ticketId: string,
  restoredDraftRef: RefObject<boolean>,
  lastSavedSnapshotRef: RefObject<string>,
  restoredSnapshotRef?: RefObject<string | null>,
) {
  useEffect(() => {
    restoredDraftRef.current = false
    lastSavedSnapshotRef.current = ''
    if (restoredSnapshotRef) restoredSnapshotRef.current = null
  }, [lastSavedSnapshotRef, restoredDraftRef, restoredSnapshotRef, ticketId])
}

interface UseApprovalDraftRestoreOptions<TPersisted, TDocument> {
  /**
   * The document the draft belongs to. Null or undefined means it has not
   * arrived: restoring then would write a snapshot of empty state and mark the
   * pane restored, so the real document would never reach the editors.
   */
  document: TDocument | null | undefined
  /**
   * Anything else that has to be true first.
   *
   * The UI-state query belongs here, and not only the document query. `persisted`
   * is `undefined` both while that query is in flight and when the server holds
   * no draft, and this hook cannot tell those apart — so a document that arrives
   * first restores defaults, latches, and the saved draft that lands a moment
   * later is discarded with no way back.
   *
   * Required, and with no default: a default of `true` reads as "ready unless
   * told otherwise", which is the failure this option exists to prevent. It
   * also hid the gate from every test whose query mock left the flag out —
   * `!isLoading && undefined` is `undefined`, and the default made that ready.
   */
  ready: boolean
  /** The persisted UI state for this pane, if the server had any. */
  persisted: TPersisted | undefined
  restoredDraftRef: RefObject<boolean>
  lastSavedSnapshotRef: RefObject<string>
  restoredSnapshotRef?: RefObject<string | null>
  flushState?: UiStateFlushState
  /**
   * Applies the restored values to the pane's state and returns the object they
   * represent, which becomes the baseline the autosave compares against.
   */
  restore: (persisted: TPersisted | undefined, document: TDocument) => unknown
  /**
   * When true, the pane already has local edits and must not be overwritten by
   * a draft that arrives later. The one-shot still latches so autosave can
   * keep those edits; it just does not call `restore`.
   */
  skipRestoreRef?: RefObject<boolean>
}

/**
 * Restores one approval pane's draft from persisted UI state, exactly once.
 *
 * The interview, PRD and execution-setup panes each wrote this out: the same
 * guard, the same `JSON.stringify` into `lastSavedSnapshotRef`, the same
 * `restoredDraftRef` flip, around a `restore` body that is genuinely different
 * in each — different tabs, different defaults, different fields. Only the
 * bookkeeping is shared, so only the bookkeeping is here.
 *
 * The order matters and is why this is worth centralising: the snapshot has to
 * be written *before* the pane is marked restored, or the autosave can see a
 * dirty pane whose baseline is still the empty string and save a draft the user
 * never touched.
 */
export function useApprovalDraftRestore<TPersisted, TDocument>({
  document,
  ready,
  persisted,
  restoredDraftRef,
  lastSavedSnapshotRef,
  restore,
  skipRestoreRef,
  flushState,
  restoredSnapshotRef,
}: UseApprovalDraftRestoreOptions<TPersisted, TDocument>): boolean {
  // Held in a ref rather than in the dependency array: this effect is one-shot,
  // and a `restore` closure that changes identity every render would otherwise
  // re-run it for no reason. Written in an effect rather than during render —
  // a render React discards would otherwise leave the ref pointing at a closure
  // over state that was never committed, and the baseline snapshot below would
  // be computed from it. Declared first so it commits before that effect runs.
  const restoreRef = useRef(restore)
  useEffect(() => {
    restoreRef.current = restore
  })

  const [restored, setRestored] = useState(false)

  useEffect(() => {
    if (restoredDraftRef.current) {
      if (!restored) setRestored(true)
      return
    }
    if (!ready || !document) {
      if (restored) setRestored(false)
      return
    }
    if (skipRestoreRef?.current) {
      restoredDraftRef.current = true
      setRestored(true)
      return
    }
    const restoredSnapshot = JSON.stringify(restoreRef.current(persisted, document))
    if (restoredSnapshotRef) restoredSnapshotRef.current = restoredSnapshot
    lastSavedSnapshotRef.current = flushState ? '' : restoredSnapshot
    restoredDraftRef.current = true
    setRestored(true)
  }, [document, flushState, lastSavedSnapshotRef, persisted, ready, restored, restoredDraftRef, restoredSnapshotRef, skipRestoreRef])

  return restored
}

export function useApprovalFocusAnchor(ticketId: string, eventName: string) {
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ ticketId?: string; anchorId?: string }>).detail
      if (!detail?.anchorId || String(detail.ticketId) !== String(ticketId)) return

      const target = document.getElementById(detail.anchorId)
      if (!target) return
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    window.addEventListener(eventName, handler as EventListener)
    return () => window.removeEventListener(eventName, handler as EventListener)
  }, [eventName, ticketId])
}

export function useDebouncedApprovalUiState<T>({
  enabled,
  snapshot,
  ticketId,
  scope,
  saveUiState,
  lastSavedSnapshotRef,
  queryClient,
  initialUpdatedAt = null,
  initialFlushState = null,
  restoredDraftRef,
  restoredSnapshotRef,
  delayMs = DRAFT_AUTOSAVE_DEBOUNCE_MS,
}: UseDebouncedApprovalUiStateOptions<T>): ApprovalAutosaveStatus {
  const [state, setState] = useState<AutosaveStatusState>(
    initialFlushState === 'failed' ? 'error' : initialFlushState === 'pending' ? 'saving' : 'pending',
  )
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(
    initialUpdatedAt ? new Date(initialUpdatedAt) : null,
  )
  const serializedSnapshot = JSON.stringify(snapshot)
  const latestSnapshotRef = useRef<{
    enabled: boolean
    serialized: string
    snapshot: T
    ticketId: string
    scope: string
  } | null>(null)
  const retainedFlushRef = useRef<{
    state: Exclude<UiStateFlushState, null>
    serialized: string
    restorationSettled: boolean
  } | null>(null)
  const lastFlushedSnapshotRef = useRef<string | null>(null)

  useEffect(() => {
    lastFlushedSnapshotRef.current = null
    retainedFlushRef.current = null
    setState(initialFlushState === 'failed' ? 'error' : initialFlushState === 'pending' ? 'saving' : 'pending')
    setLastSavedAt(null)
  }, [initialFlushState, scope, ticketId])

  useEffect(() => {
    if (!initialUpdatedAt) return
    const parsed = new Date(initialUpdatedAt)
    if (!Number.isNaN(parsed.getTime())) setLastSavedAt(parsed)
  }, [initialUpdatedAt])

  useEffect(() => {
    const reportFlushError = (event: Event) => {
      const detail = (event as CustomEvent<{ ticketId?: string; scope?: string; writeGeneration?: number }>).detail
      if (detail?.ticketId === ticketId && detail.scope === scope
        && (typeof detail.writeGeneration !== 'number' || isCurrentUiStateWrite(ticketId, scope, detail.writeGeneration))) {
        // The failed keepalive may be the only persistence attempt made by a
        // component that just unmounted. Clear the acknowledged baseline so a
        // later edit or retry cannot silently treat that draft as saved.
        lastSavedSnapshotRef.current = ''
        lastFlushedSnapshotRef.current = null
        setState('error')
      }
    }
    window.addEventListener(UI_STATE_FLUSH_ERROR_EVENT, reportFlushError)
    const reportFlushSuccess = (event: Event) => {
      const detail = (event as CustomEvent<{ ticketId?: string; scope?: string; serialized?: string; writeGeneration?: number }>).detail
      if (detail?.ticketId !== ticketId || detail.scope !== scope || typeof detail.serialized !== 'string') return
      if (typeof detail.writeGeneration === 'number' && !isCurrentUiStateWrite(ticketId, scope, detail.writeGeneration)) return
      if (latestSnapshotRef.current?.serialized !== detail.serialized) return
      lastSavedSnapshotRef.current = detail.serialized
      retainedFlushRef.current = null
      setState('saved')
    }
    window.addEventListener(UI_STATE_FLUSH_SUCCESS_EVENT, reportFlushSuccess)
    return () => {
      window.removeEventListener(UI_STATE_FLUSH_ERROR_EVENT, reportFlushError)
      window.removeEventListener(UI_STATE_FLUSH_SUCCESS_EVENT, reportFlushSuccess)
    }
  }, [lastSavedSnapshotRef, scope, ticketId])

  useEffect(() => {
    latestSnapshotRef.current = {
      enabled,
      serialized: serializedSnapshot,
      snapshot,
      ticketId,
      scope,
    }
  }, [enabled, scope, serializedSnapshot, snapshot, ticketId])

  useEffect(() => {
    if (!initialFlushState) {
      retainedFlushRef.current = null
      return
    }
  const current = retainedFlushRef.current
    if (!current || current.state !== initialFlushState) {
      retainedFlushRef.current = {
        state: initialFlushState,
        serialized: restoredSnapshotRef?.current ?? serializedSnapshot,
        restorationSettled: enabled && restoredDraftRef?.current === true,
      }
      return
    }
    if (!current.restorationSettled && restoredDraftRef?.current === true) {
      current.serialized = restoredSnapshotRef?.current ?? serializedSnapshot
      current.restorationSettled = true
    }
  }, [enabled, initialFlushState, restoredDraftRef, restoredSnapshotRef, scope, serializedSnapshot, ticketId])

  useEffect(() => {
    if (!enabled) return

    const serialized = serializedSnapshot
    const retainedFlush = retainedFlushRef.current
    if (retainedFlush?.serialized === serialized) {
      setState(retainedFlush.state === 'failed' ? 'error' : 'saving')
      return
    }
    if (retainedFlush) retainedFlushRef.current = null
    if (serialized === lastSavedSnapshotRef.current) {
      setState('saved')
      return
    }
    setState('pending')

    let canceled = false
    const timer = window.setTimeout(() => {
      if (!canceled) setState('saving')
      const latest = latestSnapshotRef.current
      if (!latest || latest.serialized !== serialized) return
      const result = saveUiState({
        ticketId,
        scope,
        data: latest.snapshot,
      })
      void Promise.resolve(result).then((saved) => {
        const response = parseAutosaveResponse(saved)
        if (canceled || latestSnapshotRef.current?.serialized !== serialized) return
        if (response.conflict) {
          setState('conflict')
          return
        }
        if (response.updatedAt) {
          const parsed = new Date(response.updatedAt)
          if (!Number.isNaN(parsed.getTime())) setLastSavedAt(parsed)
        }
        if (!canceled) {
          lastSavedSnapshotRef.current = serialized
          setState('saved')
        }
      }).catch(() => {
        if (!canceled && latestSnapshotRef.current?.serialized === serialized) setState('error')
      })
    }, delayMs)

    return () => {
      canceled = true
      window.clearTimeout(timer)
    }
  }, [delayMs, enabled, lastSavedSnapshotRef, saveUiState, scope, serializedSnapshot, ticketId])

  useEffect(() => {
    const flushLatest = () => {
      const latest = latestSnapshotRef.current
      if (!latest?.enabled || latest.serialized === lastSavedSnapshotRef.current) return
      const flushKey = `${latest.ticketId}\u0000${latest.scope}\u0000${latest.serialized}`
      if (lastFlushedSnapshotRef.current === flushKey) return
      lastFlushedSnapshotRef.current = flushKey
      flushTicketUiStateSnapshot(latest.ticketId, latest.scope, latest.snapshot, { queryClient })
    }

    window.addEventListener('pagehide', flushLatest)
    window.addEventListener('beforeunload', flushLatest)
    return () => {
      flushLatest()
      window.removeEventListener('pagehide', flushLatest)
      window.removeEventListener('beforeunload', flushLatest)
    }
  }, [lastSavedSnapshotRef, queryClient, scope, ticketId])

  return { state, lastSavedAt }
}

export type ApprovalDiscardTarget<TEditTab extends string = string> =
  | { type: 'close' }
  | { type: 'switch-tab'; tab: TEditTab }
  | null

export interface ApprovalPaneState<TEditTab extends string = string> {
  isEditMode: boolean
  setIsEditMode: Dispatch<SetStateAction<boolean>>
  isSaving: boolean
  setIsSaving: Dispatch<SetStateAction<boolean>>
  isApproving: boolean
  setIsApproving: Dispatch<SetStateAction<boolean>>
  discardTarget: ApprovalDiscardTarget<TEditTab>
  setDiscardTarget: Dispatch<SetStateAction<ApprovalDiscardTarget<TEditTab>>>
  clearDiscardTarget: () => void
}

export function useApprovalPaneState<TEditTab extends string = string>(): ApprovalPaneState<TEditTab> {
  const [isEditMode, setIsEditMode] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isApproving, setIsApproving] = useState(false)
  const [discardTarget, setDiscardTarget] = useState<ApprovalDiscardTarget<TEditTab>>(null)
  const clearDiscardTarget = useCallback(() => setDiscardTarget(null), [])

  return {
    isEditMode, setIsEditMode,
    isSaving, setIsSaving,
    isApproving, setIsApproving,
    discardTarget, setDiscardTarget,
    clearDiscardTarget,
  }
}

/**
 * The edit-mode state machine all four approval panes run.
 *
 * Switching tabs, leaving edit mode and confirming a discard were written out
 * in `ApprovalView`, `PrdApprovalPane`, `InterviewApprovalPane` and
 * `ExecutionSetupPlanApprovalPane` — 84 identical lines, and the largest single
 * block behind SonarCloud's duplication gate after PR-07 routed the panes
 * through one error helper.
 *
 * The three ways the panes actually differ are parameters, not branches:
 *
 * - `openEditor` is where a pane puts its own gate. `PrdApprovalPane` and
 *   `InterviewApprovalPane` raise a cascade warning first,
 *   `ExecutionSetupPlanApprovalPane` a runtime-rewind warning, `ApprovalView`
 *   nothing at all.
 * - `exitTab` is the tab a pane resets to when edit mode closes.
 * - `discardExitTab` is the same thing for a confirmed discard, and defaults to
 *   `exitTab`. Only `PrdApprovalPane` sets it, because it picks between
 *   `structured` and `yaml` depending on whether a structured draft exists —
 *   its two close paths genuinely disagreed, and that is preserved rather than
 *   tidied away.
 */
export function useApprovalEditMode<TEditTab extends string>({
  editTab,
  isEditMode,
  setIsEditMode,
  hasUnsavedChanges,
  discardTarget,
  setDiscardTarget,
  clearDiscardTarget,
  resetDraftsFromSaved,
  openEditor,
  exitTab,
  discardExitTab = exitTab,
}: {
  editTab: TEditTab
  isEditMode: boolean
  setIsEditMode: Dispatch<SetStateAction<boolean>>
  hasUnsavedChanges: boolean
  discardTarget: ApprovalDiscardTarget<TEditTab>
  setDiscardTarget: Dispatch<SetStateAction<ApprovalDiscardTarget<TEditTab>>>
  clearDiscardTarget: () => void
  resetDraftsFromSaved: (tab: TEditTab) => void
  openEditor: () => void
  exitTab: TEditTab
  discardExitTab?: TEditTab
}): {
  requestTabChange: (nextTab: TEditTab) => void
  handleToggleEdit: () => void
  handleConfirmDiscard: () => void
} {
  function requestTabChange(nextTab: TEditTab) {
    if (nextTab === editTab) return
    if (hasUnsavedChanges) {
      setDiscardTarget({ type: 'switch-tab', tab: nextTab })
      return
    }
    resetDraftsFromSaved(nextTab)
  }

  function handleToggleEdit() {
    if (isEditMode) {
      if (hasUnsavedChanges) {
        setDiscardTarget({ type: 'close' })
        return
      }
      resetDraftsFromSaved(exitTab)
      setIsEditMode(false)
      return
    }
    openEditor()
  }

  function handleConfirmDiscard() {
    const target = discardTarget
    clearDiscardTarget()
    if (!target) return

    if (target.type === 'close') {
      resetDraftsFromSaved(discardExitTab)
      setIsEditMode(false)
      return
    }

    resetDraftsFromSaved(target.tab)
  }

  return { requestTabChange, handleToggleEdit, handleConfirmDiscard }
}

/**
 * The two approval mutations the PRD and beads panes both run.
 *
 * Only four things differ between the panes — the route, the coverage domain,
 * the artifact cache key and the sentence shown on failure — and everything
 * around them was copied. The copies had already drifted once: routing the
 * panes through the shared error helper is what made them identical again, and
 * what SonarCloud then measured as new duplication.
 *
 * The state juggling stays in the component. Only the request and the cache
 * invalidation live here, which is the half that was actually the same.
 */
export type ApprovalDomain = 'prd' | 'beads'

function invalidateApprovedArtifact(
  queryClient: QueryClient,
  ticketId: string,
  domain: ApprovalDomain,
): void {
  queryClient.invalidateQueries({ queryKey: ['tickets'] })
  queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] })
  queryClient.invalidateQueries({ queryKey: ['artifact', ticketId, domain, 'approval'] })
  queryClient.invalidateQueries({ queryKey: ['artifact', ticketId, domain] })
  clearTicketArtifactsCache(queryClient, ticketId)
}

export async function approveArtifact(
  queryClient: QueryClient,
  options: {
    ticketId: string
    domain: ApprovalDomain
    expectedContentSha256: string | null
    gapAcknowledgementReason?: string
    failureMessage: string
  },
): Promise<void> {
  const response = await fetch(apiTicketPath(options.ticketId, `approve-${options.domain}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedContentSha256: options.expectedContentSha256,
      ...(options.gapAcknowledgementReason?.trim()
        ? { gapAcknowledgementReason: options.gapAcknowledgementReason.trim() }
        : {}),
    }),
  })
  await throwIfNotOk(response, options.failureMessage)

  queryClient.invalidateQueries({ queryKey: ['ticket-skips', options.ticketId] })
  invalidateApprovedArtifact(queryClient, options.ticketId, options.domain)
}

export async function fixCoverageGaps(
  queryClient: QueryClient,
  options: { ticketId: string; domain: ApprovalDomain },
): Promise<void> {
  const response = await fetch(apiTicketPath(options.ticketId, 'coverage', 'fix-gaps'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: options.domain }),
  })
  await throwIfNotOk(response, 'Failed to fix coverage gaps')

  invalidateApprovedArtifact(queryClient, options.ticketId, options.domain)
}
