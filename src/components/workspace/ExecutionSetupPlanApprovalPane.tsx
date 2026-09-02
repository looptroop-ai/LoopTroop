import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { QUERY_STALE_TIME_5M, EXECUTION_SETUP_EDIT_GRACE_MS } from '@/lib/constants'
import { YamlEditor } from '@/components/editor/YamlEditor'
import { AlertTriangle, Archive, CheckCircle2 } from 'lucide-react'
import { CollapsiblePhaseLogSection } from './CollapsiblePhaseLogSection'
import { ArtifactContent } from './ArtifactContentViewer'
import { PhaseArtifactsPanel } from './PhaseArtifactsPanel'
import { clearTicketArtifactsCache, useTicketArtifacts } from '@/hooks/useTicketArtifacts'
import { getTicketPhaseAttemptsQueryKey } from '@/hooks/useTicketPhaseAttempts'
import { useSaveTicketUIState, useTicketUIState, type Ticket } from '@/hooks/useTickets'
import { parseExecutionSetupPlanReport } from './phaseArtifactTypes'
import {
  EXECUTION_SETUP_PLAN_APPROVAL_FOCUS_EVENT,
  parseExecutionSetupPlanContent,
  type ExecutionSetupPlan,
} from '@/lib/executionSetupPlan'
import { ExecutionSetupPlanEditor } from './ExecutionSetupPlanEditor'
import {
  useApprovalDraftReset,
  useApprovalFocusAnchor,
  useDebouncedApprovalUiState,
  useApprovalPaneState,
} from './approvalHooks'
import { requestWorkspacePhaseNavigation } from '@/lib/workspaceNavigation'
import { AutosaveStatus } from './AutosaveStatus'
import { apiTicketPath } from '@/lib/apiPaths'
import { throwIfNotOk } from '@/lib/fetchError'
import { QueryErrorNotice } from '@/components/shared/QueryErrorNotice'

type EditTab = 'structured' | 'raw'
type RuntimeRewindTarget = 'edit' | 'regenerate' | null

interface ExecutionSetupPlanApprovalResponse {
  exists: boolean
  raw: string | null
  contentSha256?: string | null
  plan: ExecutionSetupPlan | null
  updatedAt: string | null
}

interface ExecutionSetupPlanApprovalUiState {
  isEditMode?: boolean
  editTab?: EditTab
  rawDraft?: string
  structuredDraft?: ExecutionSetupPlan | null
  commentary?: string
}

interface ExecutionSetupApprovalReceipt {
  approved_by?: string
  approved_at?: string
  step_count?: number
  command_count?: number
}

function parseExecutionSetupApprovalReceipt(content?: string | null): ExecutionSetupApprovalReceipt | null {
  if (!content) return null
  try {
    const parsed = JSON.parse(content) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    return {
      approved_by: typeof record.approved_by === 'string' ? record.approved_by : undefined,
      approved_at: typeof record.approved_at === 'string' ? record.approved_at : undefined,
      step_count: typeof record.step_count === 'number' && Number.isFinite(record.step_count) ? record.step_count : undefined,
      command_count: typeof record.command_count === 'number' && Number.isFinite(record.command_count) ? record.command_count : undefined,
    }
  } catch {
    return null
  }
}

function formatReviewTimestamp(value?: string | null): string | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

function buildSetupPlanSourceChips(updatedAt?: string | null, reportContent?: string | null): string[] {
  const report = reportContent ? parseExecutionSetupPlanReport(reportContent) : null
  const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN
  const generatedAtMs = report?.generatedAt ? Date.parse(report.generatedAt) : Number.NaN
  const editedAfterGeneration = Number.isFinite(updatedAtMs)
    && Number.isFinite(generatedAtMs)
    && updatedAtMs - generatedAtMs > EXECUTION_SETUP_EDIT_GRACE_MS
  const sourceChips = [
    report?.source === 'regenerate'
      ? 'Regenerated before approval'
      : report?.source === 'auto'
        ? 'Initial generated draft'
        : report?.source
          ? 'Saved setup plan'
          : null,
    editedAfterGeneration ? 'Edited before approval' : null,
  ].filter((item): item is string => Boolean(item))
  return sourceChips
}

function getSetupPlanRegenerateNotes(reportContent?: string | null): string[] {
  const report = reportContent ? parseExecutionSetupPlanReport(reportContent) : null
  if (report?.source !== 'regenerate') return []
  return (report.notes ?? []).filter((note) => note.trim().length > 0)
}

function RegenerateCommentaryPanel({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null

  return (
    <div className="rounded-md border border-blue-200 bg-blue-50/80 px-3 py-3 text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-100">
      <div className="text-xs font-semibold uppercase tracking-wider text-blue-900/70 dark:text-blue-200/80">
        Regeneration Request
      </div>
      <div className="mt-2 space-y-2">
        {notes.map((note, index) => (
          <div
            key={`${index}:${note}`}
            className="rounded-md border border-blue-200/70 bg-background/75 px-3 py-2 text-xs leading-5 text-foreground dark:border-blue-900/50"
          >
            {note}
          </div>
        ))}
      </div>
    </div>
  )
}

function ApprovedSetupPlanBanner({
  receipt,
  updatedAt,
  reportContent,
}: {
  receipt: ExecutionSetupApprovalReceipt | null
  updatedAt?: string | null
  reportContent?: string | null
}) {
  const approvedAtLabel = formatReviewTimestamp(receipt?.approved_at)
  const updatedAtLabel = formatReviewTimestamp(updatedAt)
  const detailChips = [
    receipt?.approved_by ? `Approved by ${receipt.approved_by}` : 'Approved',
    approvedAtLabel ? `Approved at ${approvedAtLabel}` : null,
    typeof receipt?.step_count === 'number' ? `${receipt.step_count} step${receipt.step_count === 1 ? '' : 's'}` : null,
    typeof receipt?.command_count === 'number' ? `${receipt.command_count} command${receipt.command_count === 1 ? '' : 's'}` : null,
    ...buildSetupPlanSourceChips(updatedAt, reportContent),
    updatedAtLabel ? `Saved at ${updatedAtLabel}` : null,
  ].filter((item): item is string => Boolean(item))

  return (
    <div className="rounded-md border border-green-300/70 bg-green-50/80 px-3 py-3 text-green-950 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-100">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Approved setup contract</div>
          <div className="mt-1 text-xs leading-5">
            This is the reviewed plan that was handed to Preparing Workspace Runtime. It is locked here for review only.
          </div>
          {detailChips.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {detailChips.map((chip) => (
                <span key={chip} className="rounded-full border border-green-300/70 bg-background/70 px-2 py-0.5 text-[10px] font-medium text-foreground dark:border-green-900/60">
                  {chip}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function RejectedSetupPlanDraftBanner({
  updatedAt,
  reportContent,
}: {
  updatedAt?: string | null
  reportContent?: string | null
}) {
  const updatedAtLabel = formatReviewTimestamp(updatedAt)
  const detailChips = [
    'Rejected draft',
    ...buildSetupPlanSourceChips(updatedAt, reportContent),
    updatedAtLabel ? `Saved at ${updatedAtLabel}` : null,
  ].filter((item): item is string => Boolean(item))

  return (
    <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-3 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
      <div className="flex items-start gap-2">
        <Archive className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Rejected setup draft</div>
          <div className="mt-1 text-xs leading-5">
            This draft was replaced by a later regeneration. It was not handed to Preparing Workspace Runtime and is locked here for review only.
          </div>
          {detailChips.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {detailChips.map((chip) => (
                <span key={chip} className="rounded-full border border-amber-300/70 bg-background/70 px-2 py-0.5 text-[10px] font-medium text-foreground dark:border-amber-900/60">
                  {chip}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function FailedSetupPlanGenerationBanner({
  reportContent,
}: {
  reportContent?: string | null
}) {
  const report = reportContent ? parseExecutionSetupPlanReport(reportContent) : null
  const errors = report?.errors ?? []

  return (
    <div className="rounded-md border border-red-300/70 bg-red-50/80 px-3 py-3 text-red-950 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-100">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Setup plan generation needs another attempt</div>
          <p className="mt-1 text-xs leading-5">
            The drafting run finished without a valid setup plan. Review the diagnostics below, then regenerate with commentary describing what should change.
          </p>
          {errors.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
              {errors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function SupersededApprovedSetupPlanBanner({
  receipt,
  updatedAt,
  reportContent,
}: {
  receipt: ExecutionSetupApprovalReceipt | null
  updatedAt?: string | null
  reportContent?: string | null
}) {
  const approvedAtLabel = formatReviewTimestamp(receipt?.approved_at)
  const updatedAtLabel = formatReviewTimestamp(updatedAt)
  const detailChips = [
    'Superseded approved contract',
    receipt?.approved_by ? `Approved by ${receipt.approved_by}` : 'Approved',
    approvedAtLabel ? `Approved at ${approvedAtLabel}` : null,
    typeof receipt?.step_count === 'number' ? `${receipt.step_count} step${receipt.step_count === 1 ? '' : 's'}` : null,
    typeof receipt?.command_count === 'number' ? `${receipt.command_count} command${receipt.command_count === 1 ? '' : 's'}` : null,
    ...buildSetupPlanSourceChips(updatedAt, reportContent),
    updatedAtLabel ? `Saved at ${updatedAtLabel}` : null,
  ].filter((item): item is string => Boolean(item))

  return (
    <div className="rounded-md border border-sky-300/70 bg-sky-50/80 px-3 py-3 text-sky-950 dark:border-sky-900/60 dark:bg-sky-950/20 dark:text-sky-100">
      <div className="flex items-start gap-2">
        <Archive className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Superseded approved setup contract</div>
          <div className="mt-1 text-xs leading-5">
            This approved plan was handed to Preparing Workspace Runtime, then archived when runtime setup was returned to setup-plan approval.
          </div>
          {detailChips.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {detailChips.map((chip) => (
                <span key={chip} className="rounded-full border border-sky-300/70 bg-background/70 px-2 py-0.5 text-[10px] font-medium text-foreground dark:border-sky-900/60">
                  {chip}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function RuntimeRewindWarningDialog({
  target,
  onConfirm,
  onCancel,
}: {
  target: RuntimeRewindTarget
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md border-amber-500">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" />
            Return to setup approval?
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            This will stop Preparing Workspace Runtime, archive the current runtime attempt and approved setup contract, clear stale runtime profile outputs, and require approval before runtime setup runs again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={onConfirm}>
            {target === 'regenerate' ? 'Regenerate Plan' : 'Proceed with Edit'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ExecutionSetupPlanApprovalPane({
  ticket,
  readOnly = false,
  phaseAttempt,
  logPhaseAttempt,
  logMode,
}: {
  ticket: Ticket
  readOnly?: boolean
  phaseAttempt?: number
  logPhaseAttempt?: number
  logMode?: 'live' | 'snapshot'
}) {
  const queryClient = useQueryClient()
  const { mutateAsync: saveUiState } = useSaveTicketUIState()
  const uiStateScope = 'approval_execution_setup'
  const { data: persistedUiState } = useTicketUIState<ExecutionSetupPlanApprovalUiState>(ticket.id, uiStateScope, true)
  const isArchivedAttempt = phaseAttempt != null
  const effectiveLogMode = logMode ?? (isArchivedAttempt ? 'snapshot' : 'live')
  const isRuntimeSetupRewindMode = !readOnly && !isArchivedAttempt && ticket.status === 'PREPARING_EXECUTION_ENV'
  const artifactState = useTicketArtifacts(ticket.id, isArchivedAttempt
    ? { phase: 'WAITING_EXECUTION_SETUP_APPROVAL', phaseAttempt }
    : undefined)
  const artifacts = useMemo(() => artifactState.artifacts ?? [], [artifactState.artifacts])
  const planQueryKey = phaseAttempt != null
    ? ['artifact', ticket.id, 'execution-setup-plan', phaseAttempt]
    : ['artifact', ticket.id, 'execution-setup-plan']
  const planUrl = phaseAttempt != null
    ? `${apiTicketPath(ticket.id, 'execution-setup-plan')}?${new URLSearchParams({ phaseAttempt: String(phaseAttempt) }).toString()}`
    : apiTicketPath(ticket.id, 'execution-setup-plan')
  const {
    data: fetchedPlan,
    isLoading,
    isFetching,
    isError: isPlanError,
    error: planError,
    refetch: refetchPlan,
  } = useQuery({
    queryKey: planQueryKey,
    queryFn: async ({ signal }) => {
      const response = await fetch(planUrl, { signal })
      await throwIfNotOk(response, 'Failed to load execution setup plan')
      return response.json() as Promise<ExecutionSetupPlanApprovalResponse>
    },
    staleTime: QUERY_STALE_TIME_5M,
  })

  const rawContent = fetchedPlan?.raw ?? ''
  const currentContentSha256 = fetchedPlan?.contentSha256 ?? null
  const plan = fetchedPlan?.plan ?? null
  const isPlanLoading = !fetchedPlan && (isLoading || isFetching)
  // A request that failed says nothing about whether generation succeeded. Left
  // out of this condition, a 500 rendered the "generation failed" banner and
  // offered Regenerate — a destructive action — for a plan that may well exist.
  const planRequestFailed = isPlanError && !fetchedPlan
  const generationFailed = ticket.status === 'WAITING_EXECUTION_SETUP_APPROVAL'
    && !isArchivedAttempt
    && !isPlanLoading
    && !planRequestFailed
    && !plan
  const executionSetupPlanReportContent = useMemo(() => {
    const matchingArtifact = [...artifacts].reverse().find((artifact) => (
      artifact.artifactType === 'execution_setup_plan_report'
      && artifact.phase === 'WAITING_EXECUTION_SETUP_APPROVAL'
    ))
      ?? [...artifacts].reverse().find((artifact) => artifact.artifactType === 'execution_setup_plan_report')
    return matchingArtifact?.content ?? null
  }, [artifacts])
  const approvalReceipt = useMemo(() => {
    const matchingArtifact = [...artifacts].reverse().find((artifact) => (
      artifact.artifactType === 'approval_receipt'
      && artifact.phase === 'WAITING_EXECUTION_SETUP_APPROVAL'
    ))
    return parseExecutionSetupApprovalReceipt(matchingArtifact?.content)
  }, [artifacts])
  const isArchivedApprovedAttempt = isArchivedAttempt && approvalReceipt !== null
  const regenerateNotes = useMemo(
    () => getSetupPlanRegenerateNotes(executionSetupPlanReportContent),
    [executionSetupPlanReportContent],
  )
  const artifactPanelPhase = readOnly || isRuntimeSetupRewindMode ? 'WAITING_EXECUTION_SETUP_APPROVAL' : ticket.status
  const isSetupPlanVisible = !isPlanLoading && rawContent.trim().length > 0
  const shouldExpandSetupPlanLog = !isSetupPlanVisible

  const {
    isEditMode, setIsEditMode,
    isSaving, setIsSaving,
    isApproving, setIsApproving,
    discardTarget, setDiscardTarget,
    clearDiscardTarget,
  } = useApprovalPaneState<EditTab>()
  const [editTab, setEditTab] = useState<EditTab>('structured')
  const [structuredDraft, setStructuredDraft] = useState<ExecutionSetupPlan | null>(null)
  const [rawDraft, setRawDraft] = useState('')
  const [commentary, setCommentary] = useState('')
  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false)
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [regenerateError, setRegenerateError] = useState<string | null>(null)
  const [approveError, setApproveError] = useState<string | null>(null)
  const [runtimeRewindTarget, setRuntimeRewindTarget] = useState<RuntimeRewindTarget>(null)
  const restoredDraftRef = useRef(false)
  const lastSavedSnapshotRef = useRef('')
  const containerRef = useRef<HTMLDivElement>(null)

  const hasStructuredChanges = useMemo(
    () => structuredDraft !== null && plan !== null && JSON.stringify(structuredDraft) !== JSON.stringify(plan),
    [plan, structuredDraft],
  )
  const hasRawChanges = rawDraft !== rawContent
  const hasUnsavedChanges = editTab === 'structured' ? hasStructuredChanges : hasRawChanges
  const rawValidation = editTab === 'raw' && rawDraft.trim().length > 0 ? parseExecutionSetupPlanContent(rawDraft).error : null

  useApprovalDraftReset(ticket.id, restoredDraftRef, lastSavedSnapshotRef)

  useEffect(() => {
    if (restoredDraftRef.current || !plan) return

    const persisted = persistedUiState?.data
    const nextEditMode = Boolean(persisted?.isEditMode)
    const nextEditTab: EditTab = persisted?.editTab === 'raw' ? 'raw' : 'structured'
    const nextStructuredDraft = persisted?.structuredDraft ?? plan
    const nextRawDraft = typeof persisted?.rawDraft === 'string' ? persisted.rawDraft : rawContent
    const nextCommentary = typeof persisted?.commentary === 'string' ? persisted.commentary : ''

    setIsEditMode(!readOnly && nextEditMode && Boolean(plan))
    setEditTab(nextEditTab)
    setStructuredDraft(nextStructuredDraft ?? null)
    setRawDraft(nextRawDraft)
    setCommentary(nextCommentary)

    lastSavedSnapshotRef.current = JSON.stringify({
      isEditMode: nextEditMode,
      editTab: nextEditTab,
      rawDraft: nextRawDraft,
      structuredDraft: nextStructuredDraft,
      commentary: nextCommentary,
    })
    restoredDraftRef.current = true
  }, [persistedUiState, plan, rawContent, readOnly, setIsEditMode])

  useEffect(() => {
    if (!readOnly) return
    setIsEditMode(false)
    clearDiscardTarget()
    setIsRegenerateDialogOpen(false)
    setRuntimeRewindTarget(null)
  }, [clearDiscardTarget, readOnly, setIsEditMode])

  useApprovalFocusAnchor(ticket.id, EXECUTION_SETUP_PLAN_APPROVAL_FOCUS_EVENT)

  const approvalAutosave = useDebouncedApprovalUiState({
    enabled: !readOnly && restoredDraftRef.current,
    snapshot: {
      isEditMode,
      editTab,
      rawDraft,
      structuredDraft,
      commentary,
    },
    ticketId: ticket.id,
    scope: uiStateScope,
    saveUiState,
    lastSavedSnapshotRef,
    initialUpdatedAt: persistedUiState?.updatedAt,
  })

  function resetDraftsFromSaved(nextTab: EditTab = 'structured') {
    startTransition(() => {
      setStructuredDraft(plan)
      setRawDraft(rawContent)
      setEditTab(nextTab)
      setSaveError(null)
      setApproveError(null)
      setRegenerateError(null)
    })
  }

  async function handleSave() {
    if (!plan && !structuredDraft) return
    if (editTab === 'raw' && rawValidation) {
      setSaveError(rawValidation)
      return
    }

    setIsSaving(true)
    setSaveError(null)
    try {
      const response = await fetch(apiTicketPath(ticket.id, 'execution-setup-plan'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          editTab === 'structured' && structuredDraft
            ? { plan: structuredDraft }
            : { content: rawDraft },
        ),
      })
      await throwIfNotOk(response, 'Failed to save execution setup plan')
      const payload = await response.json() as { raw?: string; contentSha256?: string | null; plan?: ExecutionSetupPlan }

      const nextData: ExecutionSetupPlanApprovalResponse = {
        exists: Boolean(payload.plan),
        raw: payload.raw ?? rawDraft,
        contentSha256: payload.contentSha256 ?? null,
        plan: payload.plan ?? structuredDraft ?? null,
        updatedAt: new Date().toISOString(),
      }
      queryClient.setQueryData(['artifact', ticket.id, 'execution-setup-plan'], nextData)
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'execution-setup-plan'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', ticket.id] })
      clearTicketArtifactsCache(queryClient, ticket.id)
      setIsEditMode(false)
      setEditTab('structured')
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to save execution setup plan')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleRegenerate() {
    if (!commentary.trim()) {
      setRegenerateError('Add commentary before regenerating the setup plan.')
      return
    }

    setIsRegenerating(true)
    setRegenerateError(null)
    try {
      const response = await fetch(apiTicketPath(ticket.id, 'regenerate-execution-setup-plan'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commentary,
          ...(editTab === 'structured' && structuredDraft ? { plan: structuredDraft } : {}),
          ...(editTab === 'raw' && rawDraft.trim() ? { rawContent: rawDraft } : {}),
        }),
      })
      await throwIfNotOk(response, 'Failed to regenerate execution setup plan')

      // Invalidate queries so old cached plan is gone, new poll will start fresh
      queryClient.removeQueries({ queryKey: ['artifact', ticket.id, 'execution-setup-plan'] })
      clearTicketArtifactsCache(queryClient, ticket.id)
      queryClient.invalidateQueries({
        queryKey: getTicketPhaseAttemptsQueryKey(ticket.id, 'WAITING_EXECUTION_SETUP_APPROVAL'),
      })
      queryClient.invalidateQueries({
        queryKey: getTicketPhaseAttemptsQueryKey(ticket.id, 'GENERATING_EXECUTION_SETUP_PLAN'),
      })
      queryClient.invalidateQueries({ queryKey: ['ticket', ticket.id] })

      // Drafting is its own visible workflow phase. Navigate there immediately
      // so the new version's artifacts and live logs are never presented as an
      // approval task that is still generating.
      setIsRegenerateDialogOpen(false)
      requestWorkspacePhaseNavigation({ ticketId: ticket.id, phase: 'GENERATING_EXECUTION_SETUP_PLAN' })
      setIsRegenerating(false)
    } catch (error) {
      setRegenerateError(error instanceof Error ? error.message : 'Failed to regenerate execution setup plan')
      setIsRegenerating(false)
    }
  }

  async function handleApprove() {
    setIsApproving(true)
    setApproveError(null)
    try {
      const response = await fetch(apiTicketPath(ticket.id, 'approve-execution-setup-plan'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedContentSha256: currentContentSha256 }),
      })
      await throwIfNotOk(response, 'Failed to approve execution setup plan')

      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', ticket.id] })
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'execution-setup-plan'] })
      clearTicketArtifactsCache(queryClient, ticket.id)
      setIsEditMode(false)
      setEditTab('structured')
    } catch (error) {
      setApproveError(error instanceof Error ? error.message : 'Failed to approve execution setup plan')
    } finally {
      setIsApproving(false)
    }
  }

  function requestTabChange(nextTab: EditTab) {
    if (nextTab === editTab) return
    if (hasUnsavedChanges) {
      setDiscardTarget({ type: 'switch-tab', tab: nextTab })
      return
    }
    resetDraftsFromSaved(nextTab)
  }

  function openEditor() {
    resetDraftsFromSaved('structured')
    setIsEditMode(true)
  }

  function handleToggleEdit() {
    if (isEditMode) {
      if (hasUnsavedChanges) {
        setDiscardTarget({ type: 'close' })
        return
      }
      resetDraftsFromSaved('structured')
      setIsEditMode(false)
      return
    }
    if (isRuntimeSetupRewindMode) {
      setRuntimeRewindTarget('edit')
      return
    }
    openEditor()
  }

  function handleOpenRegenerate() {
    setRegenerateError(null)
    if (isRuntimeSetupRewindMode) {
      setRuntimeRewindTarget('regenerate')
      return
    }
    setIsRegenerateDialogOpen(true)
  }

  function handleConfirmRuntimeRewind() {
    const target = runtimeRewindTarget
    setRuntimeRewindTarget(null)
    if (target === 'edit') {
      openEditor()
      return
    }
    if (target === 'regenerate') {
      setRegenerateError(null)
      setIsRegenerateDialogOpen(true)
    }
  }

  function handleConfirmDiscard() {
    const target = discardTarget
    clearDiscardTarget()
    if (!target) return

    if (target.type === 'close') {
      resetDraftsFromSaved('structured')
      setIsEditMode(false)
      return
    }

    resetDraftsFromSaved(target.tab)
  }

  return (
    <div ref={containerRef} className="h-full flex flex-col overflow-hidden">
      <RuntimeRewindWarningDialog
        target={runtimeRewindTarget}
        onConfirm={handleConfirmRuntimeRewind}
        onCancel={() => setRuntimeRewindTarget(null)}
      />

      <Dialog open={!readOnly && discardTarget !== null} onOpenChange={(open) => !open && clearDiscardTarget()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Discard unsaved setup-plan edits?</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Switching editors or leaving edit mode resets the current draft back to the last saved setup plan.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={clearDiscardTarget}>
              Keep Editing
            </Button>
            <Button type="button" size="sm" onClick={handleConfirmDiscard}>
              Discard Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!readOnly && isRegenerateDialogOpen} onOpenChange={(open) => {
        setIsRegenerateDialogOpen(open)
        if (open) setRegenerateError(null)
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm">Regenerate setup plan</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Describe what should change in the readiness assessment or workspace-preparation plan. If you currently have unsaved edits open, LoopTroop uses that draft as the regenerate baseline.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 mb-1">Commentary</div>
              <textarea
                value={commentary}
                onChange={(event) => {
                  setCommentary(event.target.value)
                  if (regenerateError) setRegenerateError(null)
                }}
                rows={6}
                placeholder="Describe what should change in the readiness assessment or setup plan..."
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs resize-y"
              />
            </div>

            {regenerateError ? <p className="text-xs text-red-500">{regenerateError}</p> : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setIsRegenerateDialogOpen(false)} disabled={isRegenerating}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={handleRegenerate} disabled={isRegenerating || isSaving || isApproving || !commentary.trim()}>
                {isRegenerating ? 'Regenerating…' : 'Regenerate'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="p-4 space-y-3 shrink-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold">
            {readOnly
              ? isArchivedAttempt
                ? isArchivedApprovedAttempt ? 'Superseded Execution Setup Contract' : 'Rejected Execution Setup Draft'
                : 'Approved Execution Setup Plan'
              : 'Execution Setup Plan'}
          </span>
          {readOnly ? (
            <span className={isArchivedAttempt
              ? isArchivedApprovedAttempt
                ? 'rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/20 dark:text-sky-200'
                : 'rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200'
              : 'rounded-full border border-green-300 bg-green-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-green-800 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-200'}
            >
              {isArchivedAttempt ? isArchivedApprovedAttempt ? 'Superseded' : 'Rejected Draft' : 'Approved'}
            </span>
          ) : null}
          <span className="flex-1 text-xs text-muted-foreground">
            {readOnly
              ? isArchivedAttempt
                ? isArchivedApprovedAttempt
                  ? 'Review the approved setup contract archived by a runtime setup rewind.'
                  : 'Review the superseded workspace readiness audit and setup draft.'
                : 'Review the approved workspace readiness audit and setup contract.'
              : 'Review the workspace readiness audit and any setup steps, edit if needed, regenerate with commentary, then approve.'}
          </span>
          {!readOnly ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenRegenerate}
                className="text-xs shrink-0"
                disabled={isPlanLoading || isSaving || isApproving || isRegenerating}
              >
                Regenerate ...
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleToggleEdit}
                className="text-xs shrink-0"
                disabled={!plan}
              >
                {isEditMode ? 'View' : 'Edit'}
              </Button>
              <Button
                size="sm"
                onClick={handleApprove}
                disabled={isApproving || isSaving || isRegenerating || (isEditMode && hasUnsavedChanges) || !plan || !currentContentSha256 || ticket.status !== 'WAITING_EXECUTION_SETUP_APPROVAL'}
                className="text-xs shrink-0"
              >
                {isApproving ? 'Approving…' : 'Approve'}
              </Button>
            </>
          ) : null}
        </div>

        <PhaseArtifactsPanel
          phase={artifactPanelPhase}
          isCompleted={false}
          ticketId={ticket.id}
          councilMemberCount={ticket.lockedCouncilMembers.length || 1}
          councilMemberNames={ticket.lockedCouncilMembers}
          artifactState={artifactState}
        />

        {!readOnly && isEditMode ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex items-center gap-1 rounded-md border border-border bg-background p-1">
              <button
                type="button"
                onClick={() => requestTabChange('structured')}
                className={editTab === 'structured'
                  ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
                  : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
              >
                Structured
              </button>
              <button
                type="button"
                onClick={() => requestTabChange('raw')}
                className={editTab === 'raw'
                  ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
                  : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
              >
                Raw
              </button>
            </div>
            <div className="flex items-center gap-2">
              <AutosaveStatus
                state={approvalAutosave.state}
                lastSavedAt={approvalAutosave.lastSavedAt}
                label="Draft autosave on"
              />
              <Button size="sm" variant="secondary" onClick={handleSave} disabled={isSaving || !hasUnsavedChanges}>
                {isSaving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        ) : null}

        {saveError ? <p className="text-xs text-red-500">{saveError}</p> : null}
        {approveError ? <p className="text-xs text-red-500">{approveError}</p> : null}
      </div>

      <div className="flex-1 min-h-0 px-4 pb-2 overflow-auto">
        <div className="space-y-3">
          {readOnly ? (
            isArchivedAttempt ? (
              isArchivedApprovedAttempt ? (
                <SupersededApprovedSetupPlanBanner
                  receipt={approvalReceipt}
                  updatedAt={fetchedPlan?.updatedAt}
                  reportContent={executionSetupPlanReportContent}
                />
              ) : (
                <RejectedSetupPlanDraftBanner
                  updatedAt={fetchedPlan?.updatedAt}
                  reportContent={executionSetupPlanReportContent}
                />
              )
            ) : (
              <ApprovedSetupPlanBanner
                receipt={approvalReceipt}
                updatedAt={fetchedPlan?.updatedAt}
                reportContent={executionSetupPlanReportContent}
              />
            )
          ) : null}

          <RegenerateCommentaryPanel notes={regenerateNotes} />

          {/* Beside the plan, not instead of it: a failed refresh must not hide
              content the operator is about to approve, only mark it as stale. */}
          {isPlanError && fetchedPlan ? (
            <QueryErrorNotice
              title="Showing the last setup plan that loaded. The refresh failed."
              error={planError}
              onRetry={() => void refetchPlan()}
            />
          ) : null}

          {isPlanLoading ? (
            <div className="rounded-2xl border border-border bg-muted/20 p-6 text-sm">
              <div className="font-semibold">Loading the setup plan.</div>
              <p className="mt-2 text-xs text-muted-foreground">
                LoopTroop is loading the completed drafting result for review.
              </p>
            </div>
          ) : planRequestFailed ? (
            <QueryErrorNotice
              className="py-8"
              title="The setup plan could not be loaded."
              error={planError}
              onRetry={() => void refetchPlan()}
            />
          ) : generationFailed ? (
            <div className="space-y-3">
              <FailedSetupPlanGenerationBanner reportContent={executionSetupPlanReportContent} />
              {executionSetupPlanReportContent ? (
                <div className="rounded-2xl border border-border bg-background p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Generation diagnostics
                  </div>
                  <ArtifactContent
                    artifactId="execution-setup-plan-report"
                    content={executionSetupPlanReportContent}
                    phase="WAITING_EXECUTION_SETUP_APPROVAL"
                  />
                </div>
              ) : (
                <div className="rounded-md border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
                  No generation report was published. Regenerate the setup plan to start a new version.
                </div>
              )}
            </div>
          ) : !readOnly && isEditMode ? (
            <div className="space-y-3 rounded-2xl border border-border bg-muted/20 p-3">
              {editTab === 'raw' ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-border bg-background/80 p-3 text-xs text-muted-foreground">
                    Raw mode lets you edit the full readiness-and-setup artifact as JSON or YAML.
                  </div>
                  <YamlEditor value={rawDraft} onChange={setRawDraft} className="min-h-[520px] rounded-xl border border-border bg-background" />
                  {rawValidation ? (
                    <div className="rounded-md border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200">
                      {rawValidation}
                    </div>
                  ) : (
                    <div className="rounded-md border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-200">
                      Raw plan content looks structurally valid.
                    </div>
                  )}
                </div>
              ) : structuredDraft ? (
                <ExecutionSetupPlanEditor
                  plan={structuredDraft}
                  disabled={isSaving || isRegenerating}
                  onChange={setStructuredDraft}
                />
              ) : (
                <div className="rounded-md border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200">
                  No setup plan is available to edit yet.
                </div>
              )}
            </div>
          ) : rawContent ? (
            <div className="rounded-2xl border border-border bg-background p-4">
              <ArtifactContent
                artifactId="execution-setup-plan"
                content={rawContent}
                phase={artifactPanelPhase}
                reportContent={executionSetupPlanReportContent}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">No setup plan artifact is available yet.</div>
          )}
        </div>
      </div>

      <CollapsiblePhaseLogSection
        key={shouldExpandSetupPlanLog ? 'setup-plan-pending' : 'setup-plan-visible'}
        phase={artifactPanelPhase}
        phaseAttempt={logPhaseAttempt ?? phaseAttempt}
        logMode={effectiveLogMode}
        ticket={ticket}
        defaultExpanded={shouldExpandSetupPlanLog}
        variant="bottom"
        className="px-4 pb-4"
        resizeContainerRef={containerRef}
      />
    </div>
  )
}
