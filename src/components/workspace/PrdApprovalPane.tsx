import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { QUERY_STALE_TIME_5M } from '@/lib/constants'
import { LoadingText } from '@/components/ui/LoadingText'
import { CascadeWarning } from '@/components/editor/CascadeWarning'
import { YamlEditor } from '@/components/editor/YamlEditor'
import { CollapsiblePhaseLogSection } from './CollapsiblePhaseLogSection'
import { CoverageApprovalWarning } from './CoverageApprovalWarning'
import { resolveCoverageApprovalWarning } from './coverageApprovalWarningUtils'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import { PrdApprovalEditor } from './PrdApprovalEditor'
import { PrdDocumentView } from './PrdDocumentView'
import { InterviewDocumentView } from './InterviewDocumentView'
import { clearTicketArtifactsCache, useTicketArtifacts, type DBartifact } from '@/hooks/useTicketArtifacts'
import { useSaveTicketUIState, useTicketUIState, type Ticket } from '@/hooks/useTickets'
import { getCascadeEditWarningMessage } from '@/lib/workflowMeta'
import type { InterviewDocument } from '@shared/interviewArtifact'
import { parseInterviewDocument } from '@/lib/interviewDocument'
import {
  type PrdApprovalDraft,
  type PrdDocument,
  PRD_APPROVAL_FOCUS_EVENT,
  buildPrdApprovalDraft,
  buildPrdDocumentFromDraft,
  normalizePrdApprovalDraft,
  normalizePrdDocumentLike,
  parsePrdDocument,
  parsePrdDocumentContent,
} from '@/lib/prdDocument'
import {
  useApprovalDraftReset,
  useApprovalFocusAnchor,
  useDebouncedApprovalUiState,
  useApprovalPaneState,
} from './approvalHooks'
import { buildReadableRawDisplayContent } from './rawDisplayContent'
import { AutosaveStatus } from './AutosaveStatus'
import {
  findLatestArtifact,
  findLatestCompanionArtifact,
  mergeDraftArtifactContent,
  mergeVoteArtifactContent,
} from './artifactCompanionUtils'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

type EditTab = 'structured' | 'yaml'

interface PrdApprovalUiState {
  isEditMode?: boolean
  editTab?: EditTab
  yamlDraft?: string
  structuredDraft?: PrdApprovalDraft
}

interface PrdArtifactResponse {
  content?: string
  contentSha256?: string | null
}

interface FullAnswersArtifact {
  winnerModelId: string
  winnerLabel: string
  questionCount: number
  document: InterviewDocument
}

function parseRecord(content: string | null | undefined): Record<string, unknown> | null {
  if (!content?.trim()) return null
  try {
    const parsed = JSON.parse(content) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function parseWinnerId(content: string | null | undefined): string | null {
  const parsed = parseRecord(content)
  const winnerId = typeof parsed?.winnerId === 'string' ? parsed.winnerId.trim() : ''
  return winnerId || null
}

function resolvePrdWinnerId(artifacts: DBartifact[]): string | null {
  const winnerArtifact = findLatestArtifact(artifacts, artifact => artifact.artifactType === 'prd_winner')
  const winnerId = parseWinnerId(winnerArtifact?.content)
  if (winnerId) return winnerId

  const voteArtifact = findLatestArtifact(artifacts, artifact => artifact.artifactType === 'prd_votes')
  const voteCompanion = findLatestCompanionArtifact(artifacts, 'prd_votes')
  const draftArtifact = findLatestArtifact(artifacts, artifact => artifact.artifactType === 'prd_drafts')
  const draftCompanion = findLatestCompanionArtifact(artifacts, 'prd_drafts')
  const mergedDraftContent = mergeDraftArtifactContent(draftArtifact?.content, draftCompanion?.content)
  const mergedVoteContent = mergeVoteArtifactContent(voteArtifact?.content, voteCompanion?.content, mergedDraftContent)
  return parseWinnerId(mergedVoteContent ?? voteArtifact?.content)
}

function resolveWinnerFullAnswers(artifacts: DBartifact[]): FullAnswersArtifact | null {
  const winnerId = resolvePrdWinnerId(artifacts)
  if (!winnerId) return null

  const fullAnswersArtifact = findLatestArtifact(artifacts, artifact => artifact.phase === 'DRAFTING_PRD' && artifact.artifactType === 'prd_full_answers')
    ?? findLatestArtifact(artifacts, artifact => artifact.artifactType === 'prd_full_answers')
  const fullAnswersCompanion = findLatestCompanionArtifact(artifacts, 'prd_full_answers', ['DRAFTING_PRD'])
    ?? findLatestCompanionArtifact(artifacts, 'prd_full_answers')
  const mergedFullAnswersContent = mergeDraftArtifactContent(fullAnswersArtifact?.content, fullAnswersCompanion?.content)
  const parsedFullAnswers = parseRecord(mergedFullAnswersContent ?? fullAnswersArtifact?.content)
  const drafts = Array.isArray(parsedFullAnswers?.drafts)
    ? parsedFullAnswers.drafts.filter((draft): draft is Record<string, unknown> => Boolean(draft) && typeof draft === 'object' && !Array.isArray(draft))
    : []
  const winnerDraft = drafts.find(draft => draft.memberId === winnerId)
  const content = typeof winnerDraft?.content === 'string' ? winnerDraft.content : ''
  const document = parseInterviewDocument(content)
  if (!document) return null
  if (document.questions.length === 0) return null

  return {
    winnerModelId: winnerId,
    winnerLabel: getModelDisplayName(winnerId),
    questionCount: document.questions.length,
    document,
  }
}

export function PrdApprovalPane({
  ticket,
  phase = 'WAITING_PRD_APPROVAL',
  logPhaseAttempt,
  logMode = 'live',
}: {
  ticket: Ticket
  phase?: string
  logPhaseAttempt?: number
  logMode?: 'live' | 'snapshot'
}) {
  const queryClient = useQueryClient()
  const { mutateAsync: saveUiState } = useSaveTicketUIState()
  const uiStateScope = 'approval_prd'
  const cascadeWarningMessage = useMemo(
    () => getCascadeEditWarningMessage(ticket.status, 'prd', ticket.previousStatus),
    [ticket.status, ticket.previousStatus],
  )
  const { data: persistedUiState } = useTicketUIState<PrdApprovalUiState>(ticket.id, uiStateScope, true)
  const { data: fetchedPrd, isLoading, isFetching } = useQuery({
    queryKey: ['artifact', ticket.id, 'prd', 'approval'],
    queryFn: async () => {
      const response = await fetch(`/api/files/${ticket.id}/prd`)
      if (!response.ok) {
        throw new Error('Failed to load PRD')
      }
      const payload = await response.json() as PrdArtifactResponse
      return {
        content: payload.content ?? '',
        contentSha256: payload.contentSha256 ?? null,
      }
    },
    staleTime: QUERY_STALE_TIME_5M,
  })
  const { artifacts: loadedArtifacts } = useTicketArtifacts(ticket.id)
  const artifacts = useMemo(() => loadedArtifacts ?? [], [loadedArtifacts])

  const rawContent = fetchedPrd?.content ?? ''
  const currentContentSha256 = fetchedPrd?.contentSha256 ?? null
  const prdDocument = useMemo(
    () => normalizePrdDocumentLike(parsePrdDocument(rawContent) ?? parsePrdDocumentContent(rawContent).document),
    [rawContent],
  )
  const rawDisplayContent = useMemo(() => buildReadableRawDisplayContent(rawContent), [rawContent])
  const isPreparingStructuredPrd = !prdDocument && Boolean(rawContent) && isFetching

  const {
    isEditMode, setIsEditMode,
    isSaving, setIsSaving,
    isApproving, setIsApproving,
    discardTarget, setDiscardTarget,
    clearDiscardTarget,
  } = useApprovalPaneState<EditTab>()
  const [editTab, setEditTab] = useState<EditTab>('structured')
  const [structuredDraft, setStructuredDraft] = useState<PrdApprovalDraft | null>(null)
  const [yamlDraft, setYamlDraft] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [approveError, setApproveError] = useState<string | null>(null)
  const [coverageFixError, setCoverageFixError] = useState<string | null>(null)
  const [isFixingCoverageGaps, setIsFixingCoverageGaps] = useState(false)
  const [isCascadeWarningOpen, setIsCascadeWarningOpen] = useState(false)
  const [isFullAnswersOpen, setIsFullAnswersOpen] = useState(false)
  // Deliberately not persisted with the approval draft: an acknowledgement is
  // about the gaps in front of you right now, and a stale one from a previous
  // coverage run would be the wrong explanation attached to a new approval.
  const [gapReason, setGapReason] = useState('')
  const restoredDraftRef = useRef(false)
  const lastSavedSnapshotRef = useRef('')
  const containerRef = useRef<HTMLDivElement>(null)

  const baseStructuredDraft = useMemo(
    () => (prdDocument ? buildPrdApprovalDraft(prdDocument) : null),
    [prdDocument],
  )

  const hasStructuredChanges = useMemo(
    () => structuredDraft !== null && baseStructuredDraft !== null && JSON.stringify(structuredDraft) !== JSON.stringify(baseStructuredDraft),
    [baseStructuredDraft, structuredDraft],
  )
  const hasYamlChanges = yamlDraft !== rawContent
  const structuredEditorUnavailable = editTab === 'structured' && structuredDraft === null
  const hasUnsavedChanges = editTab === 'structured' ? hasStructuredChanges : hasYamlChanges
  const yamlValidation = editTab === 'yaml' ? parsePrdDocumentContent(yamlDraft) : null
  const coverageWarning = useMemo(
    () => resolveCoverageApprovalWarning(artifacts, 'prd'),
    [artifacts],
  )
  const fullAnswersArtifact = useMemo(
    () => resolveWinnerFullAnswers(artifacts),
    [artifacts],
  )

  useApprovalDraftReset(ticket.id, restoredDraftRef, lastSavedSnapshotRef)

  useEffect(() => {
    if (isLoading || restoredDraftRef.current || !prdDocument) return

    const persisted = persistedUiState?.data
    const nextEditMode = Boolean(persisted?.isEditMode)
    const nextEditTab: EditTab = persisted?.editTab === 'yaml' ? 'yaml' : 'structured'
    const nextStructuredDraft = normalizePrdApprovalDraft(persisted?.structuredDraft, prdDocument)
    const nextYamlDraft = typeof persisted?.yamlDraft === 'string' ? persisted.yamlDraft : rawContent

    setIsEditMode(nextEditMode)
    setEditTab(nextEditTab)
    setStructuredDraft(nextStructuredDraft)
    setYamlDraft(nextYamlDraft)

    const snapshot = JSON.stringify({
      isEditMode: nextEditMode,
      editTab: nextEditTab,
      yamlDraft: nextYamlDraft,
      structuredDraft: nextStructuredDraft,
    })
    lastSavedSnapshotRef.current = snapshot
    restoredDraftRef.current = true
  }, [isLoading, persistedUiState, prdDocument, rawContent, setIsEditMode])

  useApprovalFocusAnchor(ticket.id, PRD_APPROVAL_FOCUS_EVENT)

  const approvalAutosave = useDebouncedApprovalUiState({
    enabled: !isLoading && restoredDraftRef.current && structuredDraft !== null,
    snapshot: {
      isEditMode,
      editTab,
      yamlDraft,
      structuredDraft,
    },
    ticketId: ticket.id,
    scope: uiStateScope,
    saveUiState,
    lastSavedSnapshotRef,
    initialUpdatedAt: persistedUiState?.updatedAt,
  })

  function resetDraftsFromSaved(nextTab: EditTab = 'structured') {
    startTransition(() => {
      setStructuredDraft(baseStructuredDraft)
      setYamlDraft(rawContent)
      setEditTab(nextTab === 'structured' && baseStructuredDraft === null ? 'yaml' : nextTab)
      setSaveError(null)
      setApproveError(null)
    })
  }

  function openFriendlyEditor() {
    resetDraftsFromSaved(baseStructuredDraft ? 'structured' : 'yaml')
    setIsEditMode(true)
  }

  async function handleSave() {
    if (!prdDocument || structuredDraft === null) return

    if (editTab === 'yaml' && yamlValidation?.error) {
      setSaveError(yamlValidation.error)
      return
    }

    setIsSaving(true)
    setSaveError(null)

    try {
      const response = await fetch(`/api/files/${ticket.id}/prd`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          editTab === 'structured'
            ? { document: buildPrdDocumentFromDraft(prdDocument, structuredDraft) }
            : { content: yamlDraft },
        ),
      })

      const payload = await response.json() as PrdArtifactResponse & { error?: string; details?: string }
      if (!response.ok) {
        throw new Error(payload.details || payload.error || 'Save failed')
      }

      const nextRaw = payload.content ?? ''
      queryClient.setQueryData(['artifact', ticket.id, 'prd', 'approval'], {
        content: nextRaw,
        contentSha256: payload.contentSha256 ?? null,
      })
      queryClient.setQueryData(['artifact', ticket.id, 'prd'], nextRaw)
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'prd', 'approval'] })
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'prd'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', ticket.id] })
      clearTicketArtifactsCache(ticket.id)

      const savedDocument = parsePrdDocument(nextRaw)
      setStructuredDraft(savedDocument ? buildPrdApprovalDraft(savedDocument) : null)
      setYamlDraft(nextRaw)
      setIsEditMode(false)
      setEditTab('structured')
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleApprove() {
    setIsApproving(true)
    setApproveError(null)

    try {
      const response = await fetch(`/api/tickets/${ticket.id}/approve-prd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedContentSha256: currentContentSha256,
          ...(gapReason.trim() ? { gapAcknowledgementReason: gapReason.trim() } : {}),
        }),
      })
      const payload = await response.json() as { error?: string; details?: string }
      if (!response.ok) {
        throw new Error(payload.details || payload.error || 'Failed to approve PRD')
      }

      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', ticket.id] })
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'prd', 'approval'] })
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'prd'] })
      queryClient.invalidateQueries({ queryKey: ['ticket-skips', ticket.id] })
      clearTicketArtifactsCache(ticket.id)
      setIsEditMode(false)
      setEditTab('structured')
    } catch (error) {
      setApproveError(error instanceof Error ? error.message : 'Failed to approve PRD')
    } finally {
      setIsApproving(false)
    }
  }

  async function handleFixCoverageGaps() {
    setIsFixingCoverageGaps(true)
    setCoverageFixError(null)

    try {
      const response = await fetch(`/api/tickets/${ticket.id}/coverage/fix-gaps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'prd' }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; details?: string }
      if (!response.ok) {
        throw new Error(payload.details || payload.error || 'Failed to fix coverage gaps')
      }

      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', ticket.id] })
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'prd', 'approval'] })
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'prd'] })
      clearTicketArtifactsCache(ticket.id)
      setIsEditMode(false)
      setEditTab('structured')
    } catch (error) {
      setCoverageFixError(error instanceof Error ? error.message : 'Failed to fix coverage gaps')
    } finally {
      setIsFixingCoverageGaps(false)
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

    if (cascadeWarningMessage) {
      setIsCascadeWarningOpen(true)
      return
    }

    openFriendlyEditor()
  }

  function handleConfirmCascade() {
    setIsCascadeWarningOpen(false)
    openFriendlyEditor()
  }

  function handleConfirmDiscard() {
    const target = discardTarget
    clearDiscardTarget()
    if (!target) return

    if (target.type === 'close') {
      resetDraftsFromSaved(baseStructuredDraft ? 'structured' : 'yaml')
      setIsEditMode(false)
      return
    }

    resetDraftsFromSaved(target.tab)
  }

  return (
    <div ref={containerRef} className="h-full flex flex-col overflow-hidden">
      <CascadeWarning
        message={cascadeWarningMessage ?? ''}
        open={isCascadeWarningOpen}
        onConfirm={handleConfirmCascade}
        onCancel={() => setIsCascadeWarningOpen(false)}
      />

      <Dialog open={discardTarget !== null} onOpenChange={(open) => !open && clearDiscardTarget()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Discard unsaved PRD edits?</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Switching editors or leaving edit mode resets the current draft back to the last saved PRD artifact.
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

      <Dialog open={isFullAnswersOpen} onOpenChange={setIsFullAnswersOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Full Answers
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Read-only Part 1 artifact from {fullAnswersArtifact?.winnerLabel ?? 'the winning PRD model'}, including all interview questions and answers used for PRD drafting.
            </DialogDescription>
            {fullAnswersArtifact ? (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <span>Produced by</span>
                <span className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                  {fullAnswersArtifact.winnerModelId}
                </span>
              </div>
            ) : null}
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto rounded-md bg-muted p-4">
            {fullAnswersArtifact ? (
              <InterviewDocumentView
                document={fullAnswersArtifact.document}
                defaultGroupsOpen
              />
            ) : (
              <div className="text-xs text-muted-foreground">No Full Answers artifact is available.</div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <div className="p-4 space-y-3 shrink-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold">Product Requirements Document</span>
          <span className="flex-1 text-xs text-muted-foreground">Review the final PRD, edit it if needed, then approve it before Beads drafting begins.</span>
          {fullAnswersArtifact ? (
            <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setIsFullAnswersOpen(true)}
                                    className="h-7 shrink-0 gap-1.5 px-2 text-[11px]"
                                  >
                                    <FileText className="h-3.5 w-3.5" />
                                    <span>Full Answers</span>
                                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                      {fullAnswersArtifact.questionCount}
                                    </span>
                                  </Button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-center text-balance">{`View ${fullAnswersArtifact.questionCount} Full Answers question${fullAnswersArtifact.questionCount === 1 ? '' : 's'} from ${fullAnswersArtifact.winnerLabel}`}</TooltipContent>
                      </Tooltip>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleEdit}
            disabled={isPreparingStructuredPrd}
            className="text-xs shrink-0"
          >
            {isEditMode ? 'View' : 'Edit'}
          </Button>
          <Button
            size="sm"
            onClick={handleApprove}
            disabled={isApproving || isSaving || isFixingCoverageGaps || (isEditMode && (hasUnsavedChanges || structuredEditorUnavailable)) || !prdDocument || !currentContentSha256 || ticket.status !== phase}
            className="text-xs shrink-0"
          >
            {isApproving ? 'Approving...' : coverageWarning?.gaps.length ? 'Approve with gaps' : 'Approve'}
          </Button>
        </div>

        {isEditMode ? (
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
                onClick={() => requestTabChange('yaml')}
                className={editTab === 'yaml'
                  ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
                  : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
              >
                YAML
              </button>
            </div>

            <div className="flex items-center gap-2">
              <AutosaveStatus
                state={approvalAutosave.state}
                lastSavedAt={approvalAutosave.lastSavedAt}
                label="Draft autosave on"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={handleSave}
                disabled={isSaving || !hasUnsavedChanges || structuredEditorUnavailable}
              >
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
          {coverageWarning ? (
            <CoverageApprovalWarning
              warning={coverageWarning}
              onFixGaps={handleFixCoverageGaps}
              isFixing={isFixingCoverageGaps}
              fixError={coverageFixError}
              gapReason={gapReason}
              onGapReasonChange={setGapReason}
              gapReasonDisabled={isApproving || isFixingCoverageGaps}
            />
          ) : null}
          {isLoading || isPreparingStructuredPrd ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              <div className="text-center space-y-2">
                <LoadingText text={isPreparingStructuredPrd ? 'Preparing PRD approval view' : 'Loading PRD'} className="text-sm font-medium animate-pulse" />
                <p className="text-[10px]">
                  {isPreparingStructuredPrd
                    ? 'Building the structured approval view.'
                    : 'Fetching the latest PRD artifact.'}
                </p>
              </div>
            </div>
          ) : isEditMode ? (
            <div className="space-y-3 rounded-2xl border border-border bg-muted/20 p-3">
              {editTab === 'yaml' ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-border bg-background/80 p-3 text-xs text-muted-foreground">
                    YAML mode gives full control over the canonical PRD artifact. Saving rewrites it into the server&apos;s canonical form and clears PRD approval metadata.
                  </div>
                  <YamlEditor value={yamlDraft} onChange={setYamlDraft} className="min-h-[520px] rounded-xl border border-border bg-background" />
                  {yamlValidation?.error ? (
                    <div className="rounded-md border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200">
                      {yamlValidation.error}
                    </div>
                  ) : (
                    <div className="rounded-md border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-200">
                      YAML looks structurally valid. Saving will canonicalize the document.
                    </div>
                  )}
                </div>
              ) : structuredDraft ? (
                <PrdApprovalEditor
                  draft={structuredDraft}
                  disabled={isSaving}
                  onChange={setStructuredDraft}
                />
              ) : (
                <div className="rounded-md border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200">
                  The final PRD artifact could not be parsed. Switch to YAML mode to inspect the raw document.
                </div>
              )}
            </div>
          ) : prdDocument ? (
            <PrdDocumentView document={prdDocument as PrdDocument} />
          ) : rawContent ? (
            <div className="raw-content-box">
              <pre className="raw-content-pre">{rawDisplayContent}</pre>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">No PRD artifact available yet.</div>
          )}
        </div>
      </div>

      <CollapsiblePhaseLogSection
        phase={phase}
        phaseAttempt={logPhaseAttempt}
        logMode={logMode}
        ticket={ticket}
        defaultExpanded={false}
        variant="bottom"
        className="px-4 pb-4"
        resizeContainerRef={containerRef}
      />
    </div>
  )
}
