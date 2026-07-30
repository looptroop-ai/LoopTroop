import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSaveTicketUIState, useTicket } from '@/hooks/useTickets'
import { useSSE, type SSEConnectionState } from '@/hooks/useSSE'
import { useUI } from '@/context/useUI'
import { LogProvider } from '@/context/LogContext'
import { useLogs } from '@/context/useLogContext'
import { DashboardHeader } from './DashboardHeader'
import { NavigatorPanel } from './NavigatorPanel'
import { ActiveWorkspace } from './ActiveWorkspace'
import { WorkspacePhaseSummary } from './WorkspacePhaseSummary'
import { ResizeHandle } from './ResizeHandle'
import { Menu, RefreshCw, X } from 'lucide-react'
import { clearErrorTicketSeen, getErrorTicketSignature, markErrorTicketSeen } from '@/lib/errorTicketSeen'
import { clearNeedsInputSeen, getNeedsInputSignature, markNeedsInputSeen } from '@/lib/needsInputSeen'
import { MAX_RAW_OUTPUT_LENGTH } from '@/lib/constants'
import { WORKFLOW_PHASE_IDS } from '@shared/workflowMeta'
import { getActiveErrorOccurrence, getTicketErrorOccurrences } from '@/lib/errorOccurrences'
import { dispatchInterviewBatchEvent, parseInterviewBatchEventDetail } from '@/lib/interviewBatchEvents'
import { INTERVIEW_APPROVAL_FOCUS_EVENT } from '@/lib/interviewDocument'
import { PRD_APPROVAL_FOCUS_EVENT } from '@/lib/prdDocument'
import { BEADS_APPROVAL_FOCUS_EVENT } from '@/lib/beadsDocument'
import { WORKSPACE_PHASE_NAVIGATE_EVENT, type WorkspacePhaseNavigateDetail } from '@/lib/workspaceNavigation'
import { normalizeTicketForRender } from '@/lib/ticketNormalization'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useRecoveryAutoReload } from '@/hooks/useRecoveryAutoReload'

function toDebugJson(data: Record<string, unknown>) {
  if (import.meta.env.PROD) return '[debug]'
  try {
    const raw = JSON.stringify(data)
    return raw.length > MAX_RAW_OUTPUT_LENGTH ? `${raw.slice(0, MAX_RAW_OUTPUT_LENGTH)}…[truncated]` : raw
  } catch {
    return '[unserializable]'
  }
}

function SSELogConnector({
  ticketId,
  currentStatus,
  onStateChange,
  onConnectionStateChange,
}: {
  ticketId: string | null
  currentStatus: string
  onStateChange?: (payload: { status: string; previousStatus?: string; workflowRevision?: number }) => void
  onConnectionStateChange?: (state: SSEConnectionState) => void
}) {
  const logCtx = useLogs()

  const handleEvent = useCallback((event: { type: string; data: Record<string, unknown> }) => {
    if (event.type === 'state_change') {
      const from = String(event.data.from ?? '')
      const to = String(event.data.to ?? '')
      const phaseAttempt = typeof event.data.phaseAttempt === 'number' && Number.isFinite(event.data.phaseAttempt)
        ? event.data.phaseAttempt
        : undefined
      const rawWorkflowRevision = [event.data.workflowRevision, event.data.transitionId, event.data.revision]
        .find((value) => (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim().length > 0))
      const parsedWorkflowRevision = Number(rawWorkflowRevision)
      const workflowRevision = Number.isFinite(parsedWorkflowRevision) ? parsedWorkflowRevision : undefined
      if (to) {
        onStateChange?.({
          status: to,
          ...(from ? { previousStatus: from } : {}),
          ...(workflowRevision !== undefined ? { workflowRevision } : {}),
        })
        logCtx?.setActivePhase(to)
        logCtx?.addLog(
          to,
          `[DEBUG] sse.state_change ${toDebugJson(event.data)}`,
          {
            source: 'debug',
            status: to,
            timestamp: typeof event.data.timestamp === 'string' ? event.data.timestamp : undefined,
            audience: 'debug',
            kind: 'session',
            ...(phaseAttempt !== undefined ? { phaseAttempt } : {}),
          },
        )
        logCtx?.addLog(
          to,
          `[SYS] Transition: ${from || 'unknown'} -> ${to}`,
          {
            source: 'system',
            status: to,
            timestamp: typeof event.data.timestamp === 'string' ? event.data.timestamp : undefined,
            audience: 'all',
            kind: 'milestone',
            ...(phaseAttempt !== undefined ? { phaseAttempt } : {}),
          },
        )
      }
      return
    }

    if (event.type === 'log') {
      const phase = String(event.data.phase ?? logCtx?.activePhase ?? currentStatus ?? '')
      if (phase) {
        logCtx?.addLogRecord(phase, event.data)
      }
      return
    }

    if (event.type === 'app_error') {
      const phase = String(event.data.phase ?? logCtx?.activePhase ?? currentStatus ?? '')
      const phaseAttempt = typeof event.data.phaseAttempt === 'number' && Number.isFinite(event.data.phaseAttempt)
        ? event.data.phaseAttempt
        : undefined
      if (phase) {
        logCtx?.addLog(
          phase,
          `[DEBUG] sse.app_error ${toDebugJson(event.data)}`,
          {
            source: 'debug',
            status: phase,
            timestamp: typeof event.data.timestamp === 'string' ? event.data.timestamp : undefined,
            audience: 'debug',
            kind: 'error',
            ...(phaseAttempt !== undefined ? { phaseAttempt } : {}),
          },
        )
        logCtx?.addLogRecord(phase, {
          type: 'error',
          phase,
          status: phase,
          source: 'error',
          audience: 'all',
          kind: 'error',
          content: String(event.data.message ?? 'Unknown error'),
          timestamp: typeof event.data.timestamp === 'string' ? event.data.timestamp : undefined,
          ...(phaseAttempt !== undefined ? { phaseAttempt } : {}),
        })
      }
      return
    }

    if (
      event.type === 'needs_input'
      && (event.data.type === 'interview_batch' || event.data.type === 'interview_error')
    ) {
      const interviewDetail = parseInterviewBatchEventDetail(event.data)
      if (interviewDetail) {
        dispatchInterviewBatchEvent(interviewDetail)
      }
    }

    if (
      event.type === 'needs_input' &&
      (event.data.type === 'opencode_question' || event.data.type === 'opencode_question_resolved')
    ) {
      return
    }

    const phase = String(event.data.phase ?? logCtx?.activePhase ?? currentStatus ?? '')
    if (phase) {
      logCtx?.addLog(
        phase,
        `[DEBUG] sse.${event.type} ${toDebugJson(event.data)}`,
        {
          source: 'debug',
          status: phase,
          timestamp: typeof event.data.timestamp === 'string' ? event.data.timestamp : undefined,
          audience: 'debug',
          kind: 'session',
        },
      )
    }
  }, [currentStatus, logCtx, onStateChange])

  const { connectionState } = useSSE({ ticketId, onEvent: handleEvent })

  useEffect(() => {
    onConnectionStateChange?.(connectionState)
  }, [connectionState, onConnectionStateChange])

  return null
}

export function TicketDashboard() {
  const { state, dispatch } = useUI()
  const ticketId = state.selectedTicketId
  const { data: ticket } = useTicket(ticketId)
  const { mutate: saveTicketUiState } = useSaveTicketUIState()
  const renderedTicketIdsRef = useRef(new Set<string>())
  const [navWidth, setNavWidth] = useState(280)
  const [isFullLogOpen, setIsFullLogOpen] = useState(false)
  const [phaseSelection, setPhaseSelection] = useState<{ ticketId: string | null; phase: string | null }>({
    ticketId: null,
    phase: null,
  })
  const [errorSelection, setErrorSelection] = useState<{ ticketId: string | null; occurrenceId: string | null }>({
    ticketId: null,
    occurrenceId: null,
  })
  const [pendingWorkspaceNavigation, setPendingWorkspaceNavigation] = useState<{
    ticketId: string
    phase: string
    anchorId?: string
  } | null>(null)
  const [livePhase, setLivePhase] = useState<{
    ticketId: string | null
    phase: string | null
    previousStatus: string | null
    reviewCutoffStatus: string | null
    workflowRevision: number | null
  }>({
    ticketId: null,
    phase: null,
    previousStatus: null,
    reviewCutoffStatus: null,
    workflowRevision: null,
  })
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false)
  const [liveUpdatesState, setLiveUpdatesState] = useState<SSEConnectionState>('connecting')
  const isRecoverableTicketLoading = Boolean(ticketId && !ticket && renderedTicketIdsRef.current.has(ticketId))
  useRecoveryAutoReload(`ticket-loading:${ticketId ?? 'none'}`, isRecoverableTicketLoading)

  useEffect(() => {
    if (ticketId && ticket) {
      renderedTicketIdsRef.current.add(ticketId)
    }
  }, [ticket, ticketId])

  const snapshotPreviousStatus = useMemo(
    () => ticket?.previousStatus ?? undefined,
    [ticket?.previousStatus],
  )
  const snapshotReviewCutoffStatus = useMemo(
    () => ticket?.reviewCutoffStatus ?? undefined,
    [ticket?.reviewCutoffStatus],
  )

  const closeMobileNav = useCallback(() => setIsMobileNavOpen(false), [])

  const dbStatus = ticket?.status ?? null
  const effectiveLivePhase = useMemo(() => {
    if (livePhase.ticketId !== ticketId || !livePhase.phase) return null
    if (!dbStatus || livePhase.phase === dbStatus) return livePhase

    const liveRevision = livePhase.workflowRevision
    const dbRevision = ticket?.workflowRevision
    if (typeof liveRevision === 'number' && typeof dbRevision === 'number') {
      if (dbRevision >= liveRevision) {
        return {
          ...livePhase,
          phase: dbStatus,
          workflowRevision: dbRevision,
          previousStatus: snapshotPreviousStatus ?? livePhase.previousStatus,
          reviewCutoffStatus: snapshotReviewCutoffStatus ?? livePhase.reviewCutoffStatus,
        }
      }
      return livePhase
    }

    const liveIdx = WORKFLOW_PHASE_IDS.indexOf(livePhase.phase)
    const dbIdx = WORKFLOW_PHASE_IDS.indexOf(dbStatus)
    if (liveIdx >= 0 && dbIdx >= 0 && dbIdx > liveIdx) {
      return {
        ...livePhase,
        phase: dbStatus,
        previousStatus: livePhase.previousStatus ?? snapshotPreviousStatus ?? null,
        reviewCutoffStatus: livePhase.reviewCutoffStatus ?? snapshotReviewCutoffStatus ?? null,
      }
    }

    return livePhase
  }, [dbStatus, livePhase, snapshotPreviousStatus, snapshotReviewCutoffStatus, ticket?.workflowRevision, ticketId])

  const liveStatus = effectiveLivePhase && effectiveLivePhase.phase !== ticket?.status
    ? effectiveLivePhase.phase
    : null
  const currentStatus = liveStatus ?? dbStatus ?? ''
  const livePhaseMeta = effectiveLivePhase && effectiveLivePhase.phase === currentStatus
    ? effectiveLivePhase
    : null
  const previousStatus = livePhaseMeta?.previousStatus ?? snapshotPreviousStatus
  const reviewCutoffStatus = livePhaseMeta?.reviewCutoffStatus ?? snapshotReviewCutoffStatus
  const effectiveTicket = useMemo(() => {
    if (!ticket) return null
    if (currentStatus === ticket.status) return ticket
    return {
      ...ticket,
      status: currentStatus,
      previousStatus: previousStatus ?? ticket.previousStatus,
      reviewCutoffStatus: reviewCutoffStatus ?? ticket.reviewCutoffStatus,
    }
  }, [currentStatus, previousStatus, reviewCutoffStatus, ticket])
  const renderTicket = useMemo(
    () => effectiveTicket ? normalizeTicketForRender(effectiveTicket) : null,
    [effectiveTicket],
  )
  const errorSignature = renderTicket ? getErrorTicketSignature(renderTicket) : null
  const needsInputSignature = renderTicket ? getNeedsInputSignature(renderTicket) : null
  const ticketErrorOccurrences = useMemo(() => (renderTicket ? getTicketErrorOccurrences(renderTicket) : []), [renderTicket])
  const selectedErrorOccurrenceId = errorSelection.ticketId === ticketId ? errorSelection.occurrenceId : null
  const selectedErrorOccurrence = useMemo(
    () => selectedErrorOccurrenceId != null
      ? ticketErrorOccurrences.find((occurrence) => occurrence.id === selectedErrorOccurrenceId) ?? null
      : null,
    [selectedErrorOccurrenceId, ticketErrorOccurrences],
  )
  const selectedPhase = phaseSelection.ticketId === ticketId && phaseSelection.phase !== currentStatus
    ? phaseSelection.phase
    : null
  const selectedPhaseForWorkspace = selectedPhase ?? currentStatus
  const liveErrorOccurrence = useMemo(() => {
    if (!renderTicket) return null
    if (selectedPhase && selectedPhase !== currentStatus) return null
    if (selectedErrorOccurrence) return selectedErrorOccurrence
    return currentStatus === 'BLOCKED_ERROR' ? getActiveErrorOccurrence(renderTicket) : null
  }, [currentStatus, renderTicket, selectedErrorOccurrence, selectedPhase])
  const contextPhase = selectedErrorOccurrence?.blockedFromStatus
    ?? liveErrorOccurrence?.blockedFromStatus
    ?? selectedPhaseForWorkspace
  const handleSelectPhase = useCallback((phase: string | null) => {
    setPhaseSelection({ ticketId, phase })
    setErrorSelection({ ticketId: null, occurrenceId: null })
    setIsFullLogOpen(false)
  }, [ticketId])
  const handleOpenFullLog = useCallback(() => {
    setIsFullLogOpen(true)
    setErrorSelection({ ticketId: null, occurrenceId: null })
  }, [])
  const handleSelectErrorOccurrence = useCallback((occurrenceId: string | null) => {
    setErrorSelection({ ticketId, occurrenceId })
    if (occurrenceId != null) {
      setPhaseSelection({ ticketId: null, phase: null })
      setIsFullLogOpen(false)
    }
  }, [ticketId])
  const handleLiveStatusChange = useCallback(({ status, previousStatus, workflowRevision }: { status: string; previousStatus?: string; workflowRevision?: number }) => {
    setLivePhase((current) => {
      if (
        typeof workflowRevision === 'number'
        && typeof current.workflowRevision === 'number'
        && workflowRevision <= current.workflowRevision
        && current.ticketId === ticketId
      ) {
        return current
      }
      const nextPreviousStatus = previousStatus ?? null
      let nextReviewCutoffStatus: string | null = null

      if (status === 'BLOCKED_ERROR') {
        nextReviewCutoffStatus = nextPreviousStatus
          ?? current.reviewCutoffStatus
          ?? snapshotReviewCutoffStatus
          ?? snapshotPreviousStatus
          ?? null
      } else if (status === 'CANCELED') {
        if (nextPreviousStatus === 'BLOCKED_ERROR') {
          nextReviewCutoffStatus = current.phase === 'BLOCKED_ERROR'
            ? current.reviewCutoffStatus
            : snapshotReviewCutoffStatus
              ?? (ticket?.status === 'BLOCKED_ERROR' ? snapshotPreviousStatus ?? null : null)
        } else {
          nextReviewCutoffStatus = nextPreviousStatus ?? snapshotReviewCutoffStatus ?? null
        }
      }

      if (
        current.ticketId === ticketId
        && current.phase === status
        && current.previousStatus === nextPreviousStatus
        && current.reviewCutoffStatus === nextReviewCutoffStatus
        && current.workflowRevision === (workflowRevision ?? current.workflowRevision)
      ) {
        return current
      }

      return {
        ticketId,
        phase: status,
        previousStatus: nextPreviousStatus,
        reviewCutoffStatus: nextReviewCutoffStatus,
        workflowRevision: workflowRevision ?? null,
      }
    })
    setPhaseSelection((current) => {
      if (current.ticketId === ticketId && current.phase === status) {
        return { ticketId, phase: null }
      }
      if (status !== 'BLOCKED_ERROR' && current.ticketId === ticketId && current.phase === 'BLOCKED_ERROR') {
        return { ticketId, phase: null }
      }
      return current
    })
  }, [ticket?.status, ticketId, snapshotPreviousStatus, snapshotReviewCutoffStatus])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<WorkspacePhaseNavigateDetail>).detail
      if (!detail?.ticketId || detail.ticketId !== ticketId || !detail.phase) return

      setPhaseSelection({
        ticketId,
        phase: detail.phase === currentStatus ? null : detail.phase,
      })
      setErrorSelection({ ticketId: null, occurrenceId: null })
      if (detail.phase === 'WAITING_INTERVIEW_APPROVAL' || detail.phase === 'WAITING_PRD_APPROVAL') {
        setPendingWorkspaceNavigation(detail)
      } else {
        setPendingWorkspaceNavigation(null)
      }
      closeMobileNav()
    }

    window.addEventListener(WORKSPACE_PHASE_NAVIGATE_EVENT, handler as EventListener)
    return () => window.removeEventListener(WORKSPACE_PHASE_NAVIGATE_EVENT, handler as EventListener)
  }, [closeMobileNav, currentStatus, ticketId])

  useEffect(() => {
    if (!pendingWorkspaceNavigation?.anchorId || pendingWorkspaceNavigation.ticketId !== ticketId) return
    if (selectedPhaseForWorkspace !== pendingWorkspaceNavigation.phase) return

    const focusEventType = pendingWorkspaceNavigation.phase === 'WAITING_INTERVIEW_APPROVAL'
      ? INTERVIEW_APPROVAL_FOCUS_EVENT
      : pendingWorkspaceNavigation.phase === 'WAITING_PRD_APPROVAL'
        ? PRD_APPROVAL_FOCUS_EVENT
        : pendingWorkspaceNavigation.phase === 'WAITING_BEADS_APPROVAL'
          ? BEADS_APPROVAL_FOCUS_EVENT
          : null

    if (!focusEventType) return

    const frame = window.requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent(focusEventType, {
        detail: {
          ticketId,
          anchorId: pendingWorkspaceNavigation.anchorId,
        },
      }))
      setPendingWorkspaceNavigation(null)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [pendingWorkspaceNavigation, selectedPhaseForWorkspace, ticketId])

  useEffect(() => {
    if (!ticket) return
    if (errorSignature) {
      markErrorTicketSeen(ticket.id, errorSignature)
      if (ticket.errorSeenSignature !== errorSignature) {
        saveTicketUiState({
          ticketId: ticket.id,
          scope: 'error_attention',
          data: { seenSignature: errorSignature },
        })
      }
      return
    }
    clearErrorTicketSeen(ticket.id)
    if (ticket.errorSeenSignature !== null) {
      saveTicketUiState({
        ticketId: ticket.id,
        scope: 'error_attention',
        data: { seenSignature: null },
      })
    }
  }, [ticket, errorSignature, saveTicketUiState])

  // Persist the needs-input "seen" acknowledgment so the yellow flashing stops
  // once the user opens the ticket and stays stopped across reloads/tabs. Mirrors
  // the error_attention effect above but uses the needs_input_attention scope.
  useEffect(() => {
    if (!ticket) return
    if (needsInputSignature) {
      markNeedsInputSeen(ticket.id, needsInputSignature)
      if (ticket.needsInputSeenSignature !== needsInputSignature) {
        saveTicketUiState({
          ticketId: ticket.id,
          scope: 'needs_input_attention',
          data: { seenSignature: needsInputSignature },
        })
      }
      return
    }
    clearNeedsInputSeen(ticket.id)
    if (ticket.needsInputSeenSignature !== null) {
      saveTicketUiState({
        ticketId: ticket.id,
        scope: 'needs_input_attention',
        data: { seenSignature: null },
      })
    }
  }, [ticket, needsInputSignature, saveTicketUiState])

  // Escape key closes dashboard
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isMobileNavOpen) {
          setIsMobileNavOpen(false)
        } else {
          dispatch({ type: 'CLOSE_TICKET' })
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [dispatch, isMobileNavOpen])

  if (!ticketId) return null

  if (!ticket) return (
    <div className="fixed inset-0 z-[60] bg-background flex flex-col">
      {/* Skeleton header */}
      <div className="h-12 border-b border-border flex items-center px-4 gap-3">
        <div className="h-4 w-16 bg-muted animate-pulse rounded" />
        <div className="h-4 w-48 bg-muted animate-pulse rounded" />
        <div className="h-5 w-20 bg-muted animate-pulse rounded-full ml-auto" />
        <div className="h-8 w-8 bg-muted animate-pulse rounded" />
      </div>

      <div
        className="border-b border-amber-200 bg-amber-50/90 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/40"
        role="status"
        aria-live="polite"
      >
        <div className="flex flex-col gap-1">
          <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                              variant="outline"
                              className="w-fit gap-1.5 border-amber-300 bg-amber-100/80 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                            >
                              <RefreshCw className="h-3 w-3 animate-spin" />
                              Loading ticket...
                            </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-center text-balance">Waiting for ticket data from the server.</TooltipContent>
                  </Tooltip>
          <p className="text-xs leading-5 text-amber-900/75 dark:text-amber-200/80">
            LoopTroop is fetching the ticket state. This might take a few seconds on initial load.
          </p>
        </div>
      </div>

      <div className="relative flex flex-1 flex-col overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 bg-slate-400/12 backdrop-blur-[0.5px] transition-all duration-200 dark:bg-slate-950/16"
        />
        <div className="flex flex-1 overflow-hidden">
          {/* Skeleton sidebar */}
          <div className="w-[280px] border-r border-border p-4 space-y-4 hidden md:block">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="h-6 w-6 bg-muted animate-pulse rounded-full" />
                <div className="h-3 bg-muted animate-pulse rounded flex-1" />
              </div>
            ))}
          </div>
          {/* Skeleton workspace */}
          <div className="flex-1 p-6 space-y-4">
            <div className="h-5 w-40 bg-muted animate-pulse rounded" />
            <div className="h-3 w-72 bg-muted animate-pulse rounded" />
            <div className="h-32 bg-muted animate-pulse rounded-md mt-4" />
          </div>
        </div>
      </div>
    </div>
  )

  if (!renderTicket) return null

  const activePhase = selectedPhase ?? currentStatus
  const activeErrorOccurrenceId = liveErrorOccurrence?.id ?? selectedErrorOccurrenceId
  const summaryPhase = activeErrorOccurrenceId ? 'BLOCKED_ERROR' : activePhase
  const summaryErrorMessage = selectedErrorOccurrence?.errorMessage
    ?? liveErrorOccurrence?.errorMessage
    ?? renderTicket.errorMessage
  const isReconnecting = liveUpdatesState === 'reconnecting'

  return (
    <LogProvider
      ticketId={ticketId}
      currentStatus={currentStatus}
      visiblePhase={contextPhase}
      fullLogOpen={isFullLogOpen}
    >
      <SSELogConnector
        ticketId={ticketId}
        currentStatus={currentStatus}
        onStateChange={handleLiveStatusChange}
        onConnectionStateChange={setLiveUpdatesState}
      />
      <div className="fixed inset-0 z-[60] bg-background flex flex-col">
        <DashboardHeader ticket={renderTicket} />
        {isReconnecting && (
          <div
            className="border-b border-amber-200 bg-amber-50/90 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/40"
            role="status"
            aria-live="polite"
          >
            <div className="flex flex-col gap-1">
              <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge
                                          variant="outline"
                                          className="w-fit gap-1.5 border-amber-300 bg-amber-100/80 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                                        >
                                          <RefreshCw className="h-3 w-3 animate-spin" />
                                          Live updates reconnecting...
                                        </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs text-center text-balance">Realtime updates disconnected. LoopTroop is refetching the ticket and will reconnect automatically.</TooltipContent>
                          </Tooltip>
              <p className="text-xs leading-5 text-amber-900/75 dark:text-amber-200/80">
                LoopTroop is refetching the latest ticket state and will reconnect automatically.
              </p>
            </div>
          </div>
        )}

        <div className="relative flex flex-1 flex-col overflow-hidden">
          {isReconnecting && (
            <div
              aria-hidden="true"
              data-testid="live-updates-reconnecting-overlay"
              className="pointer-events-none absolute inset-0 z-10 bg-slate-400/12 backdrop-blur-[0.5px] transition-all duration-200 dark:bg-slate-950/16"
            />
          )}

          {/* Mobile nav toggle */}
          <div className="md:hidden flex items-center px-3 py-2 border-b border-border">
            <button
              className="flex items-center justify-center h-8 w-8 rounded-md border border-border text-foreground hover:bg-accent"
              onClick={() => setIsMobileNavOpen(true)}
              aria-label="Open navigation"
            >
              <Menu className="h-4 w-4" />
            </button>
          </div>

          {/* Mobile nav overlay */}
          {isMobileNavOpen && (
            <div className="md:hidden fixed inset-0 z-[70]">
              <div className="fixed inset-0 bg-black/50" onClick={closeMobileNav} />
              <div className="fixed left-0 top-0 bottom-0 z-[71] w-72 bg-background border-r border-border shadow-xl flex flex-col">
                <div className="flex items-center justify-end p-2">
                  <button
                    className="flex items-center justify-center h-8 w-8 rounded-md border border-border text-foreground hover:bg-accent"
                    onClick={closeMobileNav}
                    aria-label="Close navigation"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex-1 overflow-hidden">
                  <NavigatorPanel
                    ticketId={renderTicket.id}
                    ticket={renderTicket}
                    currentStatus={currentStatus}
                    selectedPhase={activePhase}
                    selectedErrorOccurrenceId={selectedErrorOccurrenceId}
                    reviewCutoffStatus={reviewCutoffStatus}
                    previousStatus={previousStatus}
                    fullLogOpen={isFullLogOpen}
                    onSelectPhase={(phase) => {
                      handleSelectPhase(phase)
                      setIsMobileNavOpen(false)
                    }}
                    onSelectErrorOccurrence={(occurrenceId) => {
                      handleSelectErrorOccurrence(occurrenceId)
                      setIsMobileNavOpen(false)
                    }}
                    onOpenFullLog={() => {
                      handleOpenFullLog()
                      setIsMobileNavOpen(false)
                    }}
                    contextPhase={contextPhase}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-1 overflow-hidden">
            {/* Navigator Panel — hidden on mobile */}
            <div
              className="hidden md:block flex-shrink-0 border-r border-border overflow-hidden"
              style={{ width: navWidth }}
            >
              <NavigatorPanel
                ticketId={renderTicket.id}
                ticket={renderTicket}
                currentStatus={currentStatus}
                selectedPhase={activePhase}
                selectedErrorOccurrenceId={selectedErrorOccurrenceId}
                reviewCutoffStatus={reviewCutoffStatus}
                previousStatus={previousStatus}
                fullLogOpen={isFullLogOpen}
                onSelectPhase={handleSelectPhase}
                onSelectErrorOccurrence={handleSelectErrorOccurrence}
                onOpenFullLog={handleOpenFullLog}
                contextPhase={contextPhase}
              />
            </div>
            <div className="hidden md:block">
              <ResizeHandle onResize={setNavWidth} />
            </div>
            {/* Active Workspace */}
            <div className="flex flex-col flex-1 overflow-hidden">
              {!isFullLogOpen && (
                <WorkspacePhaseSummary
                  key={renderTicket.id}
                  phase={summaryPhase}
                  ticket={renderTicket}
                  errorMessage={summaryErrorMessage}
                  errorOccurrence={selectedErrorOccurrence ?? liveErrorOccurrence}
                />
              )}
              <ActiveWorkspace
                ticket={renderTicket}
                selectedPhase={activePhase}
                selectedErrorOccurrenceId={activeErrorOccurrenceId}
                previousStatus={previousStatus}
                reviewCutoffStatus={reviewCutoffStatus}
                fullLogOpen={isFullLogOpen}
              />
            </div>
          </div>
        </div>
      </div>
    </LogProvider>
  )
}
