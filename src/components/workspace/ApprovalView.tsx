import { startTransition, useMemo, useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useInterviewQuestions, useTicketUIState, useSaveTicketUIState } from '@/hooks/useTickets'
import { useTicketArtifacts, clearTicketArtifactsCache } from '@/hooks/useTicketArtifacts'
import { PhaseArtifactsPanel } from './PhaseArtifactsPanel'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { QUERY_STALE_TIME_5M } from '@/lib/constants'
import { CollapsiblePhaseLogSection } from './CollapsiblePhaseLogSection'
import { YamlEditor } from '@/components/editor/YamlEditor'
import type { Ticket } from '@/hooks/useTickets'
import { InterviewApprovalPane } from './InterviewApprovalPane'
import { InterviewDocumentView } from './InterviewDocumentView'
import { PrdApprovalPane } from './PrdApprovalPane'
import { PrdDocumentView } from './PrdDocumentView'
import { BeadsDraftView } from './ArtifactContentViewer'
import { buildReadableRawDisplayContent } from './rawDisplayContent'
import { BeadsApprovalEditor, type ParsedBead } from './BeadsApprovalEditor'
import { CoverageApprovalWarning } from './CoverageApprovalWarning'
import { resolveCoverageApprovalWarning } from './coverageApprovalWarningUtils'
import { BEADS_APPROVAL_FOCUS_EVENT } from '@/lib/beadsDocument'
import { ExecutionSetupPlanApprovalPane } from './ExecutionSetupPlanApprovalPane'
import { PhaseAttemptSelector } from './PhaseAttemptSelector'
import { useTicketPhaseAttempts } from '@/hooks/useTicketPhaseAttempts'
import { parseInterviewDocument, normalizeInterviewDocumentLike } from '@/lib/interviewDocument'
import { type PrdDocument, normalizePrdDocumentLike, parsePrdDocument, parsePrdDocumentContent } from '@/lib/prdDocument'
import {
  useApprovalDraftReset,
  useApprovalFocusAnchor,
  useDebouncedApprovalUiState,
} from './approvalHooks'
import { AutosaveStatus } from './AutosaveStatus'
import { commandSpecSchema } from '@shared/commandSpec'

interface ApprovalViewProps {
  ticket: Ticket
  phase?: string
  artifactType: 'interview' | 'prd' | 'beads' | 'execution_setup_plan'
  readOnly?: boolean
}

type EditTab = 'structured' | 'jsonl'
type DiscardTarget = { type: 'close' } | { type: 'switch-tab'; tab: EditTab } | null

interface BeadsApprovalUiState {
  isEditMode?: boolean
  editTab?: EditTab
  jsonlDraft?: string
  structuredDraft?: ParsedBead[]
}

interface BeadsArtifactResponse {
  beads: unknown[]
  contentSha256: string | null
}

function beadsArrayToJsonl(beads: unknown[]): string {
  return beads.map((b) => JSON.stringify(b)).join('\n') + '\n'
}

function jsonlToBeadsArray(jsonl: string): unknown[] {
  return jsonl.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

function validateJsonl(jsonl: string): string | null {
  const lines = jsonl.split('\n').filter((l) => l.trim())
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return `Line ${i + 1}: expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
      }
    } catch {
      return `Line ${i + 1}: invalid JSON — ${line.substring(0, 60)}…`
    }
  }
  return null
}

function normalizeBeadForEditor(bead: Record<string, unknown>): ParsedBead {
  const getStringArray = (record: Record<string, unknown>, keys: string[]): string[] => {
    for (const key of keys) {
      if (Array.isArray(record[key])) return (record[key] as unknown[]).filter((v): v is string => typeof v === 'string')
    }
    return []
  }
  const getString = (record: Record<string, unknown>, keys: string[]): string => {
    for (const key of keys) {
      if (typeof record[key] === 'string') return record[key] as string
    }
    return ''
  }
  const getCommands = (record: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      if (!Array.isArray(record[key])) continue
      return (record[key] as unknown[]).flatMap((value) => {
        const parsed = commandSpecSchema.safeParse(value)
        return parsed.success ? [parsed.data] : []
      })
    }
    return []
  }
  const deps = (bead.dependencies ?? {}) as Record<string, unknown>
  const guidance = (bead.contextGuidance ?? bead.context_guidance ?? {}) as Record<string, unknown>
  return {
    ...bead,
    id: getString(bead, ['id']),
    title: getString(bead, ['title']),
    description: getString(bead, ['description']),
    prdRefs: getStringArray(bead, ['prdRefs', 'prd_refs', 'prd_references']),
    acceptanceCriteria: getStringArray(bead, ['acceptanceCriteria', 'acceptance_criteria']),
    tests: getStringArray(bead, ['tests']),
    testCommands: getCommands(bead, ['testCommands', 'test_commands']),
    testCommandReason: getString(bead, ['testCommandReason', 'test_command_reason']) || undefined,
    targetFiles: getStringArray(bead, ['targetFiles', 'target_files']),
    contextGuidance: {
      patterns: getStringArray(guidance, ['patterns']),
      anti_patterns: getStringArray(guidance, ['anti_patterns', 'antiPatterns']),
    },
    dependencies: {
      blocked_by: getStringArray(deps, ['blocked_by', 'blockedBy']),
      blocks: getStringArray(deps, ['blocks']),
    },
  }
}

function parseBeadsForEditor(data: unknown[]): ParsedBead[] {
  return data.map((item) => normalizeBeadForEditor(item as Record<string, unknown>))
}

/** Build a canonical bead object for isSaving — merges editor fields back into the original, keeping read-only fields intact. */
function buildBeadForSave(bead: ParsedBead): Record<string, unknown> {
  const { contextGuidance, dependencies, acceptanceCriteria, testCommands, testCommandReason, targetFiles, prdRefs, ...rest } = bead
  return {
    ...rest,
    acceptanceCriteria,
    testCommands,
    ...(testCommands.length === 0 && testCommandReason ? { testCommandReason } : {}),
    targetFiles,
    prdRefs,
    contextGuidance: {
      patterns: contextGuidance.patterns,
      anti_patterns: contextGuidance.anti_patterns,
    },
    dependencies: {
      blocked_by: dependencies.blocked_by,
      blocks: dependencies.blocks,
    },
  }
}

function BeadsApprovalPane({
  ticket,
  phase,
  logPhaseAttempt,
  logMode = 'live',
}: {
  ticket: Ticket
  phase: string
  logPhaseAttempt?: number
  logMode?: 'live' | 'snapshot'
}) {
  const queryClient = useQueryClient()
  const { mutateAsync: saveUiState } = useSaveTicketUIState()
  const uiStateScope = 'approval_beads'
  const { data: persistedUiState } = useTicketUIState<BeadsApprovalUiState>(ticket.id, uiStateScope, true)
  const councilMemberNames = useMemo(
    () => ticket.lockedCouncilMembers.filter((memberId) => memberId.trim().length > 0),
    [ticket.lockedCouncilMembers],
  )
  const councilMemberCount = councilMemberNames.length || 3
  const { artifacts } = useTicketArtifacts(ticket.id)

  // Cache stores array form (matching navigator expectations)
  const { data: fetchedBeads, isLoading } = useQuery({
    queryKey: ['artifact', ticket.id, 'beads', 'approval'],
    queryFn: async () => {
      const r = await fetch(`/api/tickets/${ticket.id}/beads`)
      if (!r.ok) throw new Error('Failed to load')
      const contentSha256 = typeof r.headers?.get === 'function'
        ? r.headers.get('X-Content-Sha256')
        : null
      const data = await r.json()
      return {
        beads: Array.isArray(data) ? data as unknown[] : [],
        contentSha256,
      } satisfies BeadsArtifactResponse
    },
    staleTime: QUERY_STALE_TIME_5M,
  })

  const beadsArray = useMemo(() => fetchedBeads?.beads ?? [], [fetchedBeads])
  const currentContentSha256 = fetchedBeads?.contentSha256 ?? null
  const rawJsonl = useMemo(() => beadsArray.length > 0 ? beadsArrayToJsonl(beadsArray) : '', [beadsArray])

  const [isEditMode, setIsEditMode] = useState(false)
  const [editTab, setEditTab] = useState<EditTab>('structured')
  const [structuredDraft, setStructuredDraft] = useState<ParsedBead[] | null>(null)
  const [jsonlDraft, setJsonlDraft] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isApproving, setIsApproving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [approveError, setApproveError] = useState<string | null>(null)
  const [coverageFixError, setCoverageFixError] = useState<string | null>(null)
  const [isFixingCoverageGaps, setIsFixingCoverageGaps] = useState(false)
  const [discardTarget, setDiscardTarget] = useState<DiscardTarget>(null)
  const restoredDraftRef = useRef(false)
  const lastSavedSnapshotRef = useRef('')
  const containerRef = useRef<HTMLDivElement>(null)

  const baseStructuredDraft = useMemo(
    () => beadsArray.length > 0 ? parseBeadsForEditor(beadsArray) : null,
    [beadsArray],
  )

  const hasStructuredChanges = useMemo(
    () => structuredDraft !== null && baseStructuredDraft !== null && JSON.stringify(structuredDraft) !== JSON.stringify(baseStructuredDraft),
    [baseStructuredDraft, structuredDraft],
  )
  const hasJsonlChanges = jsonlDraft !== rawJsonl
  const hasUnsavedChanges = editTab === 'structured' ? hasStructuredChanges : hasJsonlChanges
  const jsonlValidation = editTab === 'jsonl' ? validateJsonl(jsonlDraft) : null
  const coverageWarning = useMemo(
    () => resolveCoverageApprovalWarning(artifacts, 'beads'),
    [artifacts],
  )

  useApprovalDraftReset(ticket.id, restoredDraftRef, lastSavedSnapshotRef)

  // Restore persisted UI state
  useEffect(() => {
    if (isLoading || restoredDraftRef.current || fetchedBeads === undefined) return

    const persisted = persistedUiState?.data
    const nextEditMode = Boolean(persisted?.isEditMode)
    const nextEditTab: EditTab = persisted?.editTab === 'jsonl' ? 'jsonl' : 'structured'
    const nextStructuredDraft = Array.isArray(persisted?.structuredDraft) && persisted.structuredDraft.length > 0
      ? persisted.structuredDraft
      : baseStructuredDraft
    const nextJsonlDraft = typeof persisted?.jsonlDraft === 'string' ? persisted.jsonlDraft : rawJsonl

    setIsEditMode(nextEditMode)
    setEditTab(nextEditTab)
    setStructuredDraft(nextStructuredDraft)
    setJsonlDraft(nextJsonlDraft)

    const snapshot = JSON.stringify({
      isEditMode: nextEditMode,
      editTab: nextEditTab,
      jsonlDraft: nextJsonlDraft,
      structuredDraft: nextStructuredDraft,
    })
    lastSavedSnapshotRef.current = snapshot
    restoredDraftRef.current = true
  }, [isLoading, fetchedBeads, persistedUiState, baseStructuredDraft, rawJsonl])

  useApprovalFocusAnchor(ticket.id, BEADS_APPROVAL_FOCUS_EVENT)

  const approvalAutosave = useDebouncedApprovalUiState({
    enabled: !isLoading && restoredDraftRef.current,
    snapshot: {
      isEditMode,
      editTab,
      jsonlDraft,
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
      setJsonlDraft(rawJsonl)
      setEditTab(nextTab)
      setSaveError(null)
      setApproveError(null)
    })
  }

  function openEditor() {
    resetDraftsFromSaved('structured')
    setIsEditMode(true)
  }

  const handleSave = useCallback(async () => {
    if (editTab === 'jsonl') {
      const error = validateJsonl(jsonlDraft)
      if (error) {
        setSaveError(error)
        return
      }
    }

    setIsSaving(true)
    setSaveError(null)

    try {
      const beadsToSave = editTab === 'structured' && structuredDraft
        ? structuredDraft.map(buildBeadForSave)
        : jsonlToBeadsArray(jsonlDraft)

      const response = await fetch(`/api/tickets/${ticket.id}/beads`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(beadsToSave),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string; details?: string }
        throw new Error(payload.details || payload.error || 'Save failed')
      }

      // Update cache with the saved array (API returns { success: true })
      const nextContentSha256 = typeof response.headers?.get === 'function'
        ? response.headers.get('X-Content-Sha256')
        : null
      queryClient.setQueryData(['artifact', ticket.id, 'beads', 'approval'], {
        beads: beadsToSave,
        contentSha256: nextContentSha256,
      } satisfies BeadsArtifactResponse)
      queryClient.setQueryData(['artifact', ticket.id, 'beads'], beadsToSave)
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'beads', 'approval'] })
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'beads'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', ticket.id] })
      clearTicketArtifactsCache(ticket.id)

      setIsEditMode(false)
      setEditTab('structured')
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }, [editTab, jsonlDraft, structuredDraft, ticket.id, queryClient])

  const handleApprove = useCallback(async () => {
    setIsApproving(true)
    setApproveError(null)

    try {
      const response = await fetch(`/api/tickets/${ticket.id}/approve-beads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedContentSha256: currentContentSha256 }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; details?: string }
      if (!response.ok) {
        throw new Error(payload.details || payload.error || 'Failed to approve beads')
      }

      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', ticket.id] })
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'beads', 'approval'] })
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'beads'] })
      clearTicketArtifactsCache(ticket.id)
      setIsEditMode(false)
      setEditTab('structured')
    } catch (error) {
      setApproveError(error instanceof Error ? error.message : 'Failed to approve beads')
    } finally {
      setIsApproving(false)
    }
  }, [currentContentSha256, ticket.id, queryClient])

  const handleFixCoverageGaps = useCallback(async () => {
    setIsFixingCoverageGaps(true)
    setCoverageFixError(null)

    try {
      const response = await fetch(`/api/tickets/${ticket.id}/coverage/fix-gaps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'beads' }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; details?: string }
      if (!response.ok) {
        throw new Error(payload.details || payload.error || 'Failed to fix coverage gaps')
      }

      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', ticket.id] })
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'beads', 'approval'] })
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'beads'] })
      clearTicketArtifactsCache(ticket.id)
      setIsEditMode(false)
      setEditTab('structured')
    } catch (error) {
      setCoverageFixError(error instanceof Error ? error.message : 'Failed to fix coverage gaps')
    } finally {
      setIsFixingCoverageGaps(false)
    }
  }, [ticket.id, queryClient])

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
    openEditor()
  }

  function handleConfirmDiscard() {
    const target = discardTarget
    setDiscardTarget(null)
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
      <Dialog open={discardTarget !== null} onOpenChange={(open) => !open && setDiscardTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Discard unsaved beads edits?</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Switching editors or leaving edit mode resets the current draft back to the last saved beads artifact.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setDiscardTarget(null)}>
              Keep Editing
            </Button>
            <Button type="button" size="sm" onClick={handleConfirmDiscard}>
              Discard Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="p-4 space-y-3 shrink-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold">Beads Breakdown</span>
          <span className="flex-1 text-xs text-muted-foreground">Review the implementation beads with tests and dependencies, edit if needed, then approve.</span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleEdit}
            className="text-xs shrink-0"
          >
            {isEditMode ? 'View' : 'Edit'}
          </Button>
          <Button
            size="sm"
            onClick={handleApprove}
            disabled={isApproving || isSaving || isFixingCoverageGaps || (isEditMode && hasUnsavedChanges) || beadsArray.length === 0 || !currentContentSha256 || ticket.status !== 'WAITING_BEADS_APPROVAL'}
            className="text-xs shrink-0"
          >
            {isApproving ? 'Approving...' : coverageWarning?.gaps.length ? 'Approve with gaps' : 'Approve'}
          </Button>
        </div>

        <PhaseArtifactsPanel
          phase={phase}
          isCompleted={false}
          ticketId={ticket.id}
          councilMemberCount={councilMemberCount}
          councilMemberNames={councilMemberNames.length > 0 ? councilMemberNames : undefined}
        />

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
                onClick={() => requestTabChange('jsonl')}
                className={editTab === 'jsonl'
                  ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
                  : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
              >
                JSONL
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
                disabled={isSaving || !hasUnsavedChanges}
              >
                {isSaving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        ) : null}

        {saveError ? <p className="text-xs text-red-500">{saveError}</p> : null}
        {approveError ? <p className="text-xs text-red-500">{approveError}</p> : null}
      </div>

      {/* Artifact content */}
      <div className="flex-1 min-h-0 px-4 pb-2 overflow-auto">
        <div className="space-y-3">
          {coverageWarning ? (
            <CoverageApprovalWarning
              warning={coverageWarning}
              onFixGaps={handleFixCoverageGaps}
              isFixing={isFixingCoverageGaps}
              fixError={coverageFixError}
            />
          ) : null}
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">Loading beads…</div>
          ) : isEditMode ? (
            <div className="space-y-3 rounded-2xl border border-border bg-muted/20 p-3">
              {editTab === 'jsonl' ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-border bg-background/80 p-3 text-xs text-muted-foreground">
                    JSONL mode gives full control over the beads artifact. Each line is one bead as a JSON object.
                  </div>
                  <YamlEditor value={jsonlDraft} onChange={setJsonlDraft} className="min-h-[520px] rounded-xl border border-border bg-background" />
                  {jsonlValidation ? (
                    <div className="rounded-md border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200">
                      {jsonlValidation}
                    </div>
                  ) : (
                    <div className="rounded-md border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-200">
                      JSONL looks structurally valid.
                    </div>
                  )}
                </div>
              ) : structuredDraft && structuredDraft.length > 0 ? (
                <BeadsApprovalEditor
                  beads={structuredDraft}
                  disabled={isSaving}
                  onChange={setStructuredDraft}
                />
              ) : (
                <div className="rounded-md border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200">
                  No beads data available to edit. Switch to JSONL mode to create beads from scratch.
                </div>
              )}
            </div>
          ) : beadsArray.length > 0 ? (
            <BeadsDraftView content={beadsArrayToJsonl(beadsArray)} />
          ) : (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">No beads artifact available yet.</div>
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

function parseApprovalSnapshotRaw(content: string | null | undefined): string {
  if (!content) return ''
  try {
    const parsed = JSON.parse(content) as { raw?: unknown }
    return typeof parsed.raw === 'string' ? parsed.raw : ''
  } catch {
    return ''
  }
}

function ReadOnlyApprovalAttemptView({
  ticket,
  phase,
  artifactType,
  phaseAttempt,
  logPhaseAttempt,
}: {
  ticket: Ticket
  phase: string
  artifactType: 'interview' | 'prd' | 'beads'
  phaseAttempt?: number
  logPhaseAttempt?: number
}) {
  const councilMemberNames = useMemo(
    () => ticket.lockedCouncilMembers.filter((memberId) => memberId.trim().length > 0),
    [ticket.lockedCouncilMembers],
  )
  const councilMemberCount = councilMemberNames.length || 3
  const archivedAttempt = typeof phaseAttempt === 'number'
  const { artifacts } = useTicketArtifacts(ticket.id, {
    phase,
    ...(archivedAttempt ? { phaseAttempt } : {}),
  })
  const snapshotArtifactType = `approval_snapshot:${artifactType}`
  const snapshotRaw = useMemo(() => {
    const snapshotArtifact = artifacts.find((artifact) => artifact.artifactType === snapshotArtifactType)
    return parseApprovalSnapshotRaw(snapshotArtifact?.content)
  }, [artifacts, snapshotArtifactType])
  const { data: interviewData } = useInterviewQuestions(ticket.id)
  const { data: prdContent } = useQuery({
    queryKey: ['artifact', ticket.id, 'prd', archivedAttempt ? phaseAttempt : 'live'],
    queryFn: async () => {
      const response = await fetch(`/api/files/${ticket.id}/prd`)
      if (!response.ok) return ''
      const payload = await response.json() as { content?: string }
      return payload.content ?? ''
    },
    enabled: artifactType === 'prd' && !archivedAttempt,
    staleTime: QUERY_STALE_TIME_5M,
  })
  const { data: beadsContent } = useQuery({
    queryKey: ['artifact', ticket.id, 'beads', archivedAttempt ? phaseAttempt : 'live'],
    queryFn: async () => {
      const response = await fetch(`/api/tickets/${ticket.id}/beads`)
      if (!response.ok) return ''
      const payload = await response.json()
      return Array.isArray(payload) ? beadsArrayToJsonl(payload) : ''
    },
    enabled: artifactType === 'beads' && !archivedAttempt,
    staleTime: QUERY_STALE_TIME_5M,
  })

  const content = artifactType === 'interview'
    ? (archivedAttempt ? snapshotRaw : (interviewData?.raw ?? ''))
    : artifactType === 'prd'
      ? (archivedAttempt ? snapshotRaw : (prdContent ?? ''))
      : (archivedAttempt ? snapshotRaw : (beadsContent ?? ''))

  const interviewDocument = useMemo(
    () => artifactType === 'interview'
      ? normalizeInterviewDocumentLike(archivedAttempt ? null : interviewData?.document) ?? parseInterviewDocument(content)
      : null,
    [archivedAttempt, artifactType, content, interviewData?.document],
  )
  const prdDocument = useMemo(
    () => artifactType === 'prd'
      ? normalizePrdDocumentLike(parsePrdDocument(content) ?? parsePrdDocumentContent(content).document)
      : null,
    [artifactType, content],
  )
  const rawDisplayContent = useMemo(() => buildReadableRawDisplayContent(content), [content])

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-4 space-y-3 shrink-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold">
            {artifactType === 'interview'
              ? 'Interview Results'
              : artifactType === 'prd'
                ? 'Product Requirements Document'
                : 'Beads Breakdown'}
          </span>
          <span className="flex-1 text-xs text-muted-foreground">
            {archivedAttempt
              ? 'This archived attempt is read-only. You can inspect and copy its content, but it can no longer be used by the workflow.'
              : 'This approval view is read-only.'}
          </span>
        </div>

        <PhaseArtifactsPanel
          phase={phase}
          isCompleted={ticket.status !== phase}
          ticketId={ticket.id}
          councilMemberCount={councilMemberCount}
          councilMemberNames={councilMemberNames.length > 0 ? councilMemberNames : undefined}
          preloadedArtifacts={artifacts}
        />
      </div>

      <div className="flex-1 min-h-0 px-4 pb-2 overflow-auto">
        {artifactType === 'interview' ? (
          interviewDocument ? (
            <InterviewDocumentView document={interviewDocument} hideAiAnswerBadge />
          ) : content ? (
            <div className="raw-content-box">
              <pre className="raw-content-pre">{rawDisplayContent}</pre>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">No interview artifact available.</div>
          )
        ) : artifactType === 'prd' ? (
          prdDocument ? (
            <PrdDocumentView document={prdDocument as PrdDocument} />
          ) : content ? (
            <div className="raw-content-box">
              <pre className="raw-content-pre">{rawDisplayContent}</pre>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">No PRD artifact available.</div>
          )
        ) : content ? (
          <BeadsDraftView content={content} />
        ) : (
          <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">No beads artifact available.</div>
        )}
      </div>

      <CollapsiblePhaseLogSection
        phase={phase}
        phaseAttempt={logPhaseAttempt ?? (archivedAttempt ? phaseAttempt : undefined)}
        logMode={archivedAttempt ? 'snapshot' : 'live'}
        ticket={ticket}
        defaultExpanded={false}
        variant="bottom"
        className="px-4 pb-4"
      />
    </div>
  )
}

function resolveApprovalPhase(artifactType: ApprovalViewProps['artifactType'], phase?: string): string {
  if (phase) return phase
  if (artifactType === 'interview') return 'WAITING_INTERVIEW_APPROVAL'
  if (artifactType === 'prd') return 'WAITING_PRD_APPROVAL'
  if (artifactType === 'beads') return 'WAITING_BEADS_APPROVAL'
  return 'WAITING_EXECUTION_SETUP_APPROVAL'
}

export function ApprovalView({ ticket, phase, artifactType, readOnly }: ApprovalViewProps) {
  const resolvedPhase = resolveApprovalPhase(artifactType, phase)
  const { data: attempts = [] } = useTicketPhaseAttempts(ticket.id, resolvedPhase)
  const [manualSelectedAttemptNumber, setManualSelectedAttemptNumber] = useState<number | null>(null)
  const selectedAttemptNumber = useMemo(() => {
    if (manualSelectedAttemptNumber != null && attempts.some((attempt) => attempt.attemptNumber === manualSelectedAttemptNumber)) {
      return manualSelectedAttemptNumber
    }
    return (attempts.find((attempt) => attempt.state === 'active') ?? attempts[0])?.attemptNumber ?? null
  }, [attempts, manualSelectedAttemptNumber])
  const selectedAttempt = useMemo(
    () => attempts.find((attempt) => attempt.attemptNumber === selectedAttemptNumber)
      ?? attempts.find((attempt) => attempt.state === 'active')
      ?? attempts[0]
      ?? null,
    [attempts, selectedAttemptNumber],
  )

  const archivedAttemptNumber = selectedAttempt?.state === 'archived' ? selectedAttempt.attemptNumber : undefined
  const logPhaseAttempt = attempts.length > 1 ? selectedAttemptNumber ?? undefined : undefined
  const logMode = archivedAttemptNumber != null ? 'snapshot' : 'live'
  const selector = attempts.length > 1 ? (
    <div className="px-4 pt-4 shrink-0">
      <PhaseAttemptSelector
        attempts={attempts}
        value={selectedAttempt?.attemptNumber ?? attempts[0]!.attemptNumber}
        onChange={setManualSelectedAttemptNumber}
      />
    </div>
  ) : null

  if (artifactType === 'execution_setup_plan') {
    const isArchivedAttempt = archivedAttemptNumber != null
    return (
      <div className="h-full flex flex-col min-h-0">
        {selector}
        <div className="flex-1 min-h-0">
          <ExecutionSetupPlanApprovalPane
            ticket={ticket}
            readOnly={readOnly || isArchivedAttempt}
            phaseAttempt={isArchivedAttempt ? archivedAttemptNumber : undefined}
            logPhaseAttempt={logPhaseAttempt}
            logMode={logMode}
          />
        </div>
      </div>
    )
  }

  if (readOnly || archivedAttemptNumber != null) {
    return (
      <div className="h-full flex flex-col min-h-0">
        {selector}
        <div className="flex-1 min-h-0">
          <ReadOnlyApprovalAttemptView
            ticket={ticket}
            phase={resolvedPhase}
            artifactType={artifactType}
            phaseAttempt={archivedAttemptNumber}
            logPhaseAttempt={logPhaseAttempt}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {selector}
      <div className="flex-1 min-h-0">
        {artifactType === 'interview'
          ? <InterviewApprovalPane ticket={ticket} phase={resolvedPhase} logPhaseAttempt={logPhaseAttempt} logMode={logMode} />
          : artifactType === 'prd'
            ? <PrdApprovalPane ticket={ticket} phase={resolvedPhase} logPhaseAttempt={logPhaseAttempt} logMode={logMode} />
            : <BeadsApprovalPane ticket={ticket} phase={resolvedPhase} logPhaseAttempt={logPhaseAttempt} logMode={logMode} />}
      </div>
    </div>
  )
}
