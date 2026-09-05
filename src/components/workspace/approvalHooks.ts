import { useEffect, useRef, useState, useCallback, type Dispatch, type SetStateAction, type RefObject } from 'react'
import { createTicketUiStateActionId, getTicketUiStateRevision } from '@/lib/ticketUiStateRevision'
import type { AutosaveStatusState } from './AutosaveStatus'
import type { QueryClient } from '@tanstack/react-query'
import { apiTicketPath } from '@/lib/apiPaths'
import { throwIfNotOk } from '@/lib/fetchError'
import { clearTicketArtifactsCache } from '@/hooks/useTicketArtifacts'

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
  initialUpdatedAt?: string | null
  delayMs?: number
}

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

export function flushTicketUiStateSnapshot<T>(ticketId: string, scope: string, data: T): boolean {
  const expectedRevision = getTicketUiStateRevision(ticketId, scope)
  const payload = JSON.stringify({ scope, data, expectedRevision, actionId: createTicketUiStateActionId() })

  if (typeof fetch === 'function') {
    try {
      void fetch(apiTicketPath(ticketId, 'ui-state'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => undefined)
      return true
    } catch {
      // Fall through to sendBeacon below.
    }
  }

  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      return navigator.sendBeacon(
        apiTicketPath(ticketId, 'ui-state'),
        new Blob([payload], { type: 'application/json' }),
      )
    } catch {
      return false
    }
  }

  return false
}

export function useApprovalDraftReset(
  ticketId: string,
  restoredDraftRef: RefObject<boolean>,
  lastSavedSnapshotRef: RefObject<string>,
) {
  useEffect(() => {
    restoredDraftRef.current = false
    lastSavedSnapshotRef.current = ''
  }, [ticketId, lastSavedSnapshotRef, restoredDraftRef])
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
  initialUpdatedAt = null,
  delayMs = 5_000,
}: UseDebouncedApprovalUiStateOptions<T>): ApprovalAutosaveStatus {
  const [state, setState] = useState<AutosaveStatusState>('pending')
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

  useEffect(() => {
    setState('pending')
    setLastSavedAt(null)
  }, [scope, ticketId])

  useEffect(() => {
    if (!initialUpdatedAt) return
    const parsed = new Date(initialUpdatedAt)
    if (!Number.isNaN(parsed.getTime())) setLastSavedAt(parsed)
  }, [initialUpdatedAt])

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
    if (!enabled) return

    const serialized = serializedSnapshot
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
      flushTicketUiStateSnapshot(latest.ticketId, latest.scope, latest.snapshot)
    }

    window.addEventListener('pagehide', flushLatest)
    window.addEventListener('beforeunload', flushLatest)
    return () => {
      window.removeEventListener('pagehide', flushLatest)
      window.removeEventListener('beforeunload', flushLatest)
    }
  }, [lastSavedSnapshotRef])

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
