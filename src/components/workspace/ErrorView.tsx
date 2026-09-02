import { useState } from 'react'
import { AlertTriangle, CirclePlay, Clock3, FilePenLine, Info, MessageSquarePlus, RotateCcw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTicketAction } from '@/hooks/useTickets'
import { useLogs } from '@/context/useLogContext'
import type { LogEntry } from '@/context/LogContext'
import { CollapsiblePhaseLogSection } from './CollapsiblePhaseLogSection'
import type { Ticket } from '@/hooks/useTickets'
import { formatTimestamp, formatTimestampString } from './logFormat'
import {
  formatErrorOccurrenceLabel,
  formatErrorOccurrenceStatus,
  getActiveErrorOccurrence,
  getTicketErrorOccurrences,
  type TicketErrorOccurrence,
} from '@/lib/errorOccurrences'
import { getStatusUserLabel } from '@/lib/workflowMeta'
import {
  BEAD_AGENT_RESPONSE_INVALID,
  BEAD_FINALIZATION_FAILED,
  BEAD_ITERATION_TIMEOUT,
  BEAD_RETRY_BUDGET_EXHAUSTED,
  FINAL_TEST_FAILED,
  OPENCODE_PROVIDER_AUTH_FAILED,
  OPENCODE_PROVIDER_ERROR,
} from '@shared/errorCodes'
import type { WorkflowAction } from '@shared/workflowMeta'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { CancelTicketDialog } from '@/components/ticket/CancelTicketDialog'
import { sanitizeErrorForDisplay } from '@shared/errorDisplay'

const MAX_RETRY_NOTE_LENGTH = 20_000

interface ErrorViewProps {
  ticket: Ticket
  occurrence?: TicketErrorOccurrence | null
  readOnly?: boolean
}

function mergeErrorLogs(previousPhaseLogs: LogEntry[], blockedLogs: LogEntry[]): LogEntry[] {
  const seen = new Set<string>()
  const merged = [...previousPhaseLogs, ...blockedLogs].filter((entry, index) => {
    const key = entry.timestamp
      ? `${entry.timestamp}|${entry.status}|${entry.source}|${entry.line}`
      : `no-ts:${index}|${entry.status}|${entry.source}|${entry.line}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return merged.sort((a, b) => {
    const aTime = a.timestamp ? Date.parse(a.timestamp) : Number.NaN
    const bTime = b.timestamp ? Date.parse(b.timestamp) : Number.NaN
    if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0
    if (Number.isNaN(aTime)) return 1
    if (Number.isNaN(bTime)) return -1
    return aTime - bTime
  })
}

function readTimestamp(value?: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function filterLogsWithinWindow(
  logs: LogEntry[],
  options: {
    startTime?: number | null
    endTime?: number | null
    includeStart?: boolean
    includeEnd?: boolean
  },
) {
  const {
    startTime = null,
    endTime = null,
    includeStart = true,
    includeEnd = true,
  } = options

  // An undated line has no place in a window defined by time. Keeping them
  // pulled every undated row in the phase — every attempt of it — into the
  // failure window, which is the opposite of what a window is for.
  if (startTime === null && endTime === null) return logs

  return logs.filter((entry) => {
    const timestamp = readTimestamp(entry.timestamp)
    if (timestamp === null) return false
    if (startTime !== null) {
      if (includeStart ? timestamp < startTime : timestamp <= startTime) return false
    }
    if (endTime !== null) {
      if (includeEnd ? timestamp > endTime : timestamp >= endTime) return false
    }
    return true
  })
}

function formatDiagnosticKind(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function buildDiagnosticRows(diagnostics: NonNullable<TicketErrorOccurrence['diagnostics']>) {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Kind', value: formatDiagnosticKind(diagnostics.kind) },
    { label: 'Source', value: formatDiagnosticKind(diagnostics.source) },
  ]

  if (diagnostics.modelId) rows.push({ label: 'Model', value: diagnostics.modelId })
  if (diagnostics.providerId) rows.push({ label: 'Provider', value: diagnostics.providerId })
  if (diagnostics.providerModelId) rows.push({ label: 'Provider model', value: diagnostics.providerModelId })
  if (diagnostics.requestModel && diagnostics.requestModel !== diagnostics.modelId) rows.push({ label: 'Request model', value: diagnostics.requestModel })
  if (diagnostics.sessionId) rows.push({ label: 'Session', value: diagnostics.sessionId })
  if (typeof diagnostics.statusCode === 'number') rows.push({ label: 'HTTP', value: String(diagnostics.statusCode) })
  if (diagnostics.providerErrorType) rows.push({ label: 'Provider type', value: diagnostics.providerErrorType })
  if (typeof diagnostics.isRetryable === 'boolean') rows.push({ label: 'Retryable', value: diagnostics.isRetryable ? 'yes' : 'no' })
  if (diagnostics.providerErrorTitle) rows.push({ label: 'Provider title', value: diagnostics.providerErrorTitle })
  if (diagnostics.providerErrorMessage && diagnostics.providerErrorMessage !== diagnostics.summary) {
    rows.push({ label: 'Provider message', value: sanitizeErrorForDisplay(diagnostics.providerErrorMessage) })
  }
  if (diagnostics.finishReason) rows.push({ label: 'Finish reason', value: diagnostics.finishReason })
  if (typeof diagnostics.outputTokens === 'number') rows.push({ label: 'Output tokens', value: diagnostics.outputTokens.toLocaleString() })
  if (typeof diagnostics.reasoningTokens === 'number') rows.push({ label: 'Reasoning tokens', value: diagnostics.reasoningTokens.toLocaleString() })
  if (typeof diagnostics.inputTokens === 'number') rows.push({ label: 'Input tokens', value: diagnostics.inputTokens.toLocaleString() })

  return rows
}

function normalizeErrorText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

interface BlockedErrorExplanation {
  title: string
  description: string
  recommendation: string
}

function explainBlockedError(
  blockedFromStatus: string | undefined,
  errorCodes: string[],
): BlockedErrorExplanation {
  const codes = new Set(errorCodes)

  if (codes.has(BEAD_FINALIZATION_FAILED)) {
    return {
      title: 'Git finalization failed',
      description: 'The implementation finished, but LoopTroop could not save the bead as a Git commit.',
      recommendation: 'Retry finalization. The completed implementation can be reused.',
    }
  }
  if (codes.has(BEAD_AGENT_RESPONSE_INVALID)) {
    return {
      title: 'Agent response incomplete',
      description: 'The coding agent did not provide the required completion result, so LoopTroop could not confirm the bead finished.',
      recommendation: 'Retry with an extra note that asks the agent to finish with the required result.',
    }
  }
  if (codes.has(BEAD_ITERATION_TIMEOUT)) {
    return {
      title: 'Implementation attempt timed out',
      description: 'The coding attempt exceeded its configured time limit before it could finish.',
      recommendation: 'Retry the bead. Add a note if the work should be split or approached differently.',
    }
  }
  if (codes.has(OPENCODE_PROVIDER_AUTH_FAILED) || codes.has(OPENCODE_PROVIDER_ERROR)) {
    return {
      title: 'Provider or environment unavailable',
      description: 'The model provider or its runtime interrupted this workflow step. This does not necessarily mean the work itself failed.',
      recommendation: 'Continue the preserved session when available, or retry after the service or credentials recover.',
    }
  }
  if (codes.has(FINAL_TEST_FAILED) || blockedFromStatus === 'RUNNING_FINAL_TEST') {
    return {
      title: 'Final Testing failed',
      description: 'The ticket-wide automated checks did not pass, so LoopTroop stopped before delivery.',
      recommendation: 'Review the failed checks, then retry Final Testing after addressing them.',
    }
  }
  if (codes.has(BEAD_RETRY_BUDGET_EXHAUSTED)) {
    return {
      title: 'Implementation retries exhausted',
      description: 'The coding agent used every configured attempt without completing this bead.',
      recommendation: 'Retry with an extra note that clarifies the approach or the remaining problem.',
    }
  }
  if (blockedFromStatus === 'GENERATING_EXECUTION_SETUP_PLAN') {
    return {
      title: 'Workspace setup drafting failed',
      description: 'LoopTroop could not finish generating the workspace setup plan because an operational step failed.',
      recommendation: 'Retry the drafting phase after resolving the reported provider or environment problem.',
    }
  }
  if (blockedFromStatus === 'PREPARING_EXECUTION_ENV' || blockedFromStatus === 'WAITING_EXECUTION_SETUP_APPROVAL') {
    return {
      title: 'Workspace setup failed',
      description: 'LoopTroop could not prepare the repository environment needed for implementation.',
      recommendation: 'Edit the setup plan when it is incorrect, or retry after fixing the environment.',
    }
  }

  return {
    title: 'Workflow step failed',
    description: 'LoopTroop stopped because the current workflow step could not finish safely.',
    recommendation: 'Review the technical details, then use an available recovery action.',
  }
}

export function ErrorView({ ticket, occurrence, readOnly = false }: ErrorViewProps) {
  const { mutate: performAction, isPending } = useTicketAction()
  const [actionError, setActionError] = useState<string | null>(null)
  const [retryNoteDialogOpen, setRetryNoteDialogOpen] = useState(false)
  const [retryNote, setRetryNote] = useState('')
  const [retryNoteError, setRetryNoteError] = useState<string | null>(null)
  const [retryNoteSubmitting, setRetryNoteSubmitting] = useState(false)
  const [editSetupPlanDialogOpen, setEditSetupPlanDialogOpen] = useState(false)
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false)
  const logCtx = useLogs()
  const failedBead = ticket.runtime.lastFailedBeadId
    ? ticket.runtime.beads?.find((bead) => bead.id === ticket.runtime.lastFailedBeadId) ?? null
    : null
  const activeRuntimeBead = ticket.runtime.activeBeadId
    ? ticket.runtime.beads?.find((bead) => bead.id === ticket.runtime.activeBeadId) ?? null
    : null
  const failedBeadNoteGroups = [
    { title: 'Failed Iteration Notes', notes: failedBead?.failedIterationNotes ?? [] },
    { title: 'User Retry Notes', notes: failedBead?.userRetryNotes ?? [] },
    { title: 'Finalization Failure Notes', notes: failedBead?.finalizationFailureNotes ?? [] },
  ].filter((group) => group.notes.length > 0)
  const visibleOccurrence = occurrence ?? getActiveErrorOccurrence(ticket)
  const retryActionLabel = (
    visibleOccurrence?.blockedFromStatus === 'CODING'
    && visibleOccurrence.errorCodes.includes(BEAD_RETRY_BUDGET_EXHAUSTED)
    && typeof ticket.runtime.maxIterationsPerBead === 'number'
    && ticket.runtime.maxIterationsPerBead > 0
  )
    ? `Try again ${ticket.runtime.maxIterationsPerBead} ${ticket.runtime.maxIterationsPerBead === 1 ? 'retry' : 'retries'}`
    : 'Retry'
  const errorLogs = (() => {
    if (!visibleOccurrence) {
      return logCtx?.getLogsForPhase('BLOCKED_ERROR') ?? []
    }

    const allOccurrences = getTicketErrorOccurrences(ticket)
    const occurrenceIndex = allOccurrences.findIndex((candidate) => candidate.id === visibleOccurrence.id)
    // `getTicketErrorOccurrences` answers newest-first, so the chronologically
    // *previous* error is the next index, not the one before. Reading backwards
    // took the newer occurrence, which made `startTime` later than `endTime` and
    // produced a window nothing could fall inside. Undated rows used to slip
    // through that window and hide it; now that they are excluded, a historical
    // error would render with no phase logs at all.
    const previousOccurrence = occurrenceIndex >= 0 && occurrenceIndex < allOccurrences.length - 1
      ? allOccurrences[occurrenceIndex + 1]
      : null
    const previousResolutionTime = readTimestamp(previousOccurrence?.resolvedAt ?? previousOccurrence?.occurredAt ?? null)
    const blockedAt = readTimestamp(visibleOccurrence.occurredAt)
    const resolvedAt = readTimestamp(visibleOccurrence.resolvedAt)
    const blockedLogs = logCtx?.getLogsForPhase('BLOCKED_ERROR') ?? []
    const phaseLogs = logCtx?.getLogsForPhase(visibleOccurrence.blockedFromStatus) ?? []
    const merged = mergeErrorLogs(
      filterLogsWithinWindow(phaseLogs, {
        startTime: previousResolutionTime,
        endTime: blockedAt,
        includeStart: false,
      }),
      filterLogsWithinWindow(blockedLogs, {
        startTime: blockedAt,
        endTime: resolvedAt,
      }),
    )
    return merged
  })()

  const isLiveError = !readOnly
    && ticket.status === 'BLOCKED_ERROR'
    && Boolean(visibleOccurrence)
    && visibleOccurrence?.resolvedAt === null
  // Gated on the occurrence, not on `ticket.previousStatus`: the surrounding copy
  // already reads `visibleOccurrence.blockedFromStatus`, and `explainBlockedError`
  // already treats both setup statuses as setup — so "Edit setup plan" was
  // missing after a failure that blocked from `WAITING_EXECUTION_SETUP_APPROVAL`,
  // and after any error whose occurrence disagreed with `previousStatus`.
  const isSetupRuntimeError = isLiveError
    && (visibleOccurrence?.blockedFromStatus === 'PREPARING_EXECUTION_ENV'
      || visibleOccurrence?.blockedFromStatus === 'WAITING_EXECUTION_SETUP_APPROVAL')
  const canContinue = isLiveError && ticket.availableActions.includes('continue')
  const canRetryWithNote = isLiveError
    && (visibleOccurrence?.blockedFromStatus === 'CODING' || isSetupRuntimeError)
    && ticket.availableActions.includes('retry')
  const canEditExecutionSetupPlan = isSetupRuntimeError
  const pausedCodingBead = isLiveError
    && visibleOccurrence?.blockedFromStatus === 'CODING'
    && activeRuntimeBead?.status === 'in_progress'
    ? activeRuntimeBead
    : null
  const diagnostics = visibleOccurrence?.diagnostics ?? null
  const diagnosticRows = diagnostics ? buildDiagnosticRows(diagnostics) : []
  const rawPrimaryErrorMessage = visibleOccurrence?.errorMessage || ticket.errorMessage || 'An error occurred but no details were captured. Try retrying or check the server logs.'
  const primaryErrorMessage = sanitizeErrorForDisplay(rawPrimaryErrorMessage) || 'An error occurred but no details were captured. Try retrying or check the server logs.'
  const displayErrorCodes = visibleOccurrence?.errorCodes
    .map(code => sanitizeErrorForDisplay(code))
    .filter(code => code.length > 0) ?? []
  const errorExplanation = explainBlockedError(
    visibleOccurrence?.blockedFromStatus ?? ticket.previousStatus ?? undefined,
    visibleOccurrence?.errorCodes ?? [],
  )
  const statusLabelOptions = {
    currentBead: ticket.runtime.currentBead ?? ticket.currentBead,
    totalBeads: ticket.runtime.totalBeads ?? ticket.totalBeads,
  }
  const diagnosticSummary = sanitizeErrorForDisplay(diagnostics?.summary ?? '')
  const normalizedPrimaryError = normalizeErrorText(primaryErrorMessage)
  const normalizedDiagnosticSummary = normalizeErrorText(diagnosticSummary)
  const hasDiagnosticSummary = diagnosticSummary.length > 0
    && normalizedPrimaryError.length > 0
    && !normalizedPrimaryError.includes(normalizedDiagnosticSummary)
  const handleAction = (action: WorkflowAction) => {
    setActionError(null)
    performAction(
      { id: ticket.id, action },
      {
        onError: (error: unknown) => {
          setActionError(error instanceof Error ? error.message : `Failed to ${action} ticket`)
        },
      },
    )
  }
  const retryNoteIsBlank = retryNote.trim().length === 0
  const isRetryNotePending = isPending || retryNoteSubmitting
  const handleRetryWithNote = () => {
    if (retryNoteIsBlank) {
      setRetryNoteError('Enter an extra note before retrying.')
      return
    }

    setRetryNoteError(null)
    setRetryNoteSubmitting(true)
    performAction(
      { id: ticket.id, action: 'retry', payload: { kind: 'retry_note', note: retryNote } },
      {
        onSuccess: () => {
          setRetryNoteSubmitting(false)
          setRetryNoteDialogOpen(false)
          setRetryNote('')
          setRetryNoteError(null)
        },
        onError: (error: unknown) => {
          setRetryNoteSubmitting(false)
          setRetryNoteError(error instanceof Error ? error.message : 'Failed to add note and retry ticket')
        },
      },
    )
  }
  const handleEditExecutionSetupPlan = () => {
    setActionError(null)
    performAction(
      { id: ticket.id, action: 'edit_execution_setup_plan' },
      {
        onSuccess: () => {
          setEditSetupPlanDialogOpen(false)
        },
        onError: (error: unknown) => {
          setActionError(error instanceof Error ? error.message : 'Failed to return to setup plan editing')
        },
      },
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      <div className="min-h-0 shrink overflow-y-auto p-4">
        <Card className={cn(
          'rounded-xl border bg-card shadow-2xs transition-all overflow-hidden',
          isLiveError ? 'border-rose-500/30 dark:border-rose-500/40' : 'border-amber-500/30 dark:border-amber-500/40'
        )}>
          <CardHeader className="py-3">
            <CardTitle className={cn('text-sm font-mono font-semibold flex items-center gap-2', isLiveError ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400')}>
              <AlertTriangle className={`h-4 w-4 ${isLiveError ? 'animate-wobble-throb' : ''}`} />
              {isLiveError ? 'Blocked — Error' : 'Error Review'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pb-3">
            <div className="rounded-md border border-border bg-muted/40 p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                {visibleOccurrence ? (
                  <>
                    <Badge variant={isLiveError ? 'destructive' : 'secondary'} className="text-[10px]">
                      {formatErrorOccurrenceStatus(visibleOccurrence, statusLabelOptions)}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {formatErrorOccurrenceLabel(visibleOccurrence, visibleOccurrence.occurrenceNumber, statusLabelOptions)}
                    </Badge>
                  </>
                ) : (
                  <Badge variant="destructive" className="text-[10px]">Active</Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                                className="flex items-center gap-1"
                                                title={visibleOccurrence?.occurredAt ? formatTimestampString(visibleOccurrence.occurredAt, { includeMilliseconds: false }) : undefined}
                                              >
                                                <Clock3 className="h-3.5 w-3.5" />
                                                {visibleOccurrence ? `Blocked from ${getStatusUserLabel(visibleOccurrence.blockedFromStatus, statusLabelOptions)}` : 'Blocked error'}
                                              </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs text-center text-balance">{visibleOccurrence?.occurredAt
                                                  ? formatTimestampString(visibleOccurrence.occurredAt, { includeMilliseconds: false })
                                                  : undefined}</TooltipContent>
                              </Tooltip>
                {visibleOccurrence?.resolvedAt && (
                  <span className="flex items-center gap-1">
                    <RotateCcw className="h-3.5 w-3.5" />
                    Resolved {formatTimestamp(visibleOccurrence.resolvedAt, { includeMilliseconds: false })}
                  </span>
                )}
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-foreground">{errorExplanation.title}</h3>
                <p className="text-xs text-muted-foreground">{errorExplanation.description}</p>
                <p className="text-xs text-foreground">
                  <span className="font-medium">Recommended:</span> {errorExplanation.recommendation}
                </p>
              </div>
              <details className="rounded border border-border bg-background/70 px-2 py-1.5 text-[11px]">
                <summary className="cursor-pointer font-medium text-foreground">Technical details</summary>
                <div className="mt-2 space-y-2">
                  <p className="font-mono text-muted-foreground">{primaryErrorMessage}</p>
                  {displayErrorCodes.length > 0 && (
                    <div className="flex flex-col items-start gap-1">
                      {displayErrorCodes.map((code, index) => code.includes('\n') || code.length > 120 ? (
                        <div
                          key={`${index}:${code}`}
                          className="w-full rounded-md border border-border px-2.5 py-1 text-[10px] font-mono leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
                        >
                          {code}
                        </div>
                      ) : (
                        <Badge key={`${index}:${code}`} variant="outline" className="text-[10px]">
                          {code}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {diagnostics && (
                    <div className="rounded border border-border bg-background/70 px-2 py-1.5 text-[11px] text-muted-foreground space-y-1.5">
                      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-foreground">
                        <Info className="h-3.5 w-3.5" />
                        Underlying error
                      </div>
                      {hasDiagnosticSummary && (
                        <p className="font-mono whitespace-pre-wrap text-muted-foreground/90">{diagnosticSummary}</p>
                      )}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
                        {diagnosticRows.map((row) => (
                          <div key={`${row.label}:${row.value}`} className="min-w-0">
                            <span className="text-muted-foreground/80">{row.label}: </span>
                            <span className="font-mono text-foreground break-words">{row.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </details>
              {(failedBead || pausedCodingBead || ticket.runtime.activeBeadIteration) && (
                <div className="rounded border border-border bg-background/70 px-2 py-1.5 text-[11px] text-muted-foreground space-y-1">
                  {failedBead && (
                    <div>
                      Failed bead <span className="font-mono text-foreground">{failedBead.id}</span>
                      {ticket.runtime.activeBeadIteration ? ` on iteration ${ticket.runtime.activeBeadIteration}` : ''}
                    </div>
                  )}
                  {!failedBead && pausedCodingBead && (
                    <>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px]">Paused</Badge>
                        <span>
                          Bead <span className="font-mono text-foreground">{pausedCodingBead.id}</span>
                          {ticket.runtime.activeBeadIteration ? ` on iteration ${ticket.runtime.activeBeadIteration}` : ''}
                        </span>
                      </div>
                      <div>
                        Timer paused while the ticket is blocked. {canContinue
                          ? 'Continue resumes the preserved OpenCode session with a fresh bead timer.'
                          : 'Retry starts a fresh coding recovery attempt.'}
                      </div>
                    </>
                  )}
                  <div>
                    Retryable: {ticket.availableActions.includes('retry') ? 'yes' : 'no'}
                  </div>
                  {failedBeadNoteGroups.length > 0 && (
                    <div className="space-y-1">
                      {failedBeadNoteGroups.map((group) => (
                        <div key={group.title} className="space-y-1">
                          <div className="text-[10px] uppercase tracking-wider">{group.title}</div>
                          {group.notes.map((note, index) => (
                            <div key={`${note.timestamp}-${note.iteration}-${index}`} className="rounded border border-border/60 p-1.5">
                              <div className="mb-0.5 flex flex-wrap gap-1.5 text-[9px] uppercase tracking-wide">
                                {note.iteration > 0 ? <span>Iteration {note.iteration}</span> : null}
                                {note.timestamp ? <span>{note.timestamp}</span> : null}
                                {note.errorCode ? <span className="font-mono">{note.errorCode}</span> : null}
                              </div>
                              <p className="font-mono text-[10px] whitespace-pre-wrap text-muted-foreground/90">{note.content}</p>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            {isLiveError && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2 justify-end">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setCancelDialogOpen(true)}
                    disabled={isPending}
                    className="h-7 text-xs font-mono font-semibold rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/30 hover:bg-rose-500/20 active:scale-[0.98] transition-all"
                  >
                    Cancel…
                  </Button>
                  {canContinue && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleAction('continue')}
                          disabled={isPending}
                          className="h-7 text-xs font-mono font-semibold rounded-lg border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 active:scale-[0.98] transition-all"
                        >
                          <CirclePlay className="mr-1 h-3.5 w-3.5" />
                          Continue
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-center text-balance">
                        Sends only "continue please" to the preserved session. It does not restart the original prompt.
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {canEditExecutionSetupPlan && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditSetupPlanDialogOpen(true)}
                      disabled={isPending}
                      className="h-7 text-xs font-mono font-medium rounded-lg border-border/70 bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground active:scale-[0.98] transition-all"
                    >
                      <FilePenLine className="mr-1 h-3.5 w-3.5" />
                      Edit setup plan...
                    </Button>
                  )}
                  {canRetryWithNote && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setRetryNoteError(null)
                        setRetryNoteDialogOpen(true)
                      }}
                      disabled={isPending}
                      className="h-7 text-xs font-mono font-medium rounded-lg border-border/70 bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground active:scale-[0.98] transition-all"
                    >
                      <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />
                      Retry with extra note...
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={() => handleAction('retry')}
                    disabled={isPending}
                    className="h-7 text-xs font-mono font-semibold rounded-lg bg-brand-500 text-brand-50 hover:bg-brand-600 active:scale-[0.98] shadow-xs transition-all"
                  >
                    {retryActionLabel}
                  </Button>
                </div>
                {actionError && (
                  <p role="alert" className="text-right text-[11px] leading-snug text-destructive">
                    {actionError}
                  </p>
                )}
                {canContinue && (
                  <p className="text-right text-[11px] leading-snug text-muted-foreground">
                    Continue keeps the current OpenCode session and sends only "continue please" after the temporary interruption clears.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <CollapsiblePhaseLogSection
        phase={visibleOccurrence?.blockedFromStatus ?? 'BLOCKED_ERROR'}
        logs={errorLogs}
        ticket={ticket}
        defaultExpanded={false}
        className="px-4 pb-4"
      />

      <Dialog
        open={retryNoteDialogOpen}
        onOpenChange={(open) => {
          if (!isRetryNotePending) setRetryNoteDialogOpen(open)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {canEditExecutionSetupPlan ? 'Retry workspace setup with an extra note' : 'Retry implementation with an extra note'}
            </DialogTitle>
            <DialogDescription id="retry-note-description">
              {canEditExecutionSetupPlan
                ? 'Send guidance to the current workspace setup session. LoopTroop sends only this note and runs one extra attempt beyond the configured retry limit.'
                : 'Add guidance for the next fresh implementation attempt. The note will be appended to User Retry Notes; nothing already there will be replaced.'}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              handleRetryWithNote()
            }}
          >
            <div className="space-y-1.5">
              <label htmlFor="retry-note" className="text-sm font-medium">
                Extra note <span className="text-destructive">*</span>
              </label>
              <textarea
                id="retry-note"
                value={retryNote}
                onChange={(event) => {
                  setRetryNote(event.target.value.slice(0, MAX_RETRY_NOTE_LENGTH))
                }}
                maxLength={MAX_RETRY_NOTE_LENGTH}
                required
                disabled={isRetryNotePending}
                aria-describedby={`retry-note-description retry-note-count${retryNoteError ? ' retry-note-error' : ''}`}
                aria-invalid={Boolean(retryNoteError || (retryNote.length > 0 && retryNoteIsBlank))}
                className="min-h-36 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="Add context, constraints, or a different approach for the next attempt..."
              />
              <div className="flex items-start justify-between gap-3">
                <div>
                  {retryNote.length > 0 && retryNoteIsBlank && !retryNoteError && (
                    <p role="alert" className="text-xs text-destructive">Enter an extra note before retrying.</p>
                  )}
                  {retryNoteError && (
                    <p id="retry-note-error" role="alert" className="text-xs text-destructive">
                      {retryNoteError}
                    </p>
                  )}
                </div>
                <p id="retry-note-count" className="shrink-0 text-xs text-muted-foreground">
                  {retryNote.length.toLocaleString()} / {MAX_RETRY_NOTE_LENGTH.toLocaleString()} characters
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRetryNoteDialogOpen(false)}
                disabled={isRetryNotePending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isRetryNotePending || retryNoteIsBlank}>
                Add note and retry
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={editSetupPlanDialogOpen}
        onOpenChange={(open) => {
          if (!isPending) setEditSetupPlanDialogOpen(open)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit workspace setup plan?</DialogTitle>
            <DialogDescription>
              The failed setup attempt will remain in the ticket history. After you confirm, the ticket will return to setup plan review, where you can edit or regenerate the plan before approving it again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditSetupPlanDialogOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleEditExecutionSetupPlan} disabled={isPending}>
              Edit setup plan
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <CancelTicketDialog ticketId={ticket.id} open={cancelDialogOpen} onOpenChange={setCancelDialogOpen} />
    </div>
  )
}
