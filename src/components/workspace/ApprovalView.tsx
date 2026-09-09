import { startTransition, useMemo, useState, useCallback, useRef } from 'react'
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
import { BeadsApprovalEditor } from './BeadsApprovalEditor'
import { CoverageApprovalWarning } from './CoverageApprovalWarning'
import { resolveCoverageApprovalWarning } from './coverageApprovalWarningUtils'
import { isRecord } from '@shared/typeGuards'
import {
  BEADS_APPROVAL_FOCUS_EVENT,
  describeBeadEntry,
  filterBeadShaped,
  hasUnstructuredBeadGuidance,
  normalizeBead,
  stripSupersededBeadAliases,
  type NormalizedBead,
} from '@/lib/beadsDocument'
import { ExecutionSetupPlanApprovalPane } from './ExecutionSetupPlanApprovalPane'
import { PhaseAttemptSelector, PhaseAttemptsUnavailable } from './PhaseAttemptSelector'
import { selectedAttemptNumber } from './phaseAttemptSelection'
import { useSelectedPhaseAttempt } from './useSelectedPhaseAttempt'
import { parseInterviewDocument, normalizeInterviewDocumentLike } from '@/lib/interviewDocument'
import { type PrdDocument, normalizePrdDocumentLike, parsePrdDocument, parsePrdDocumentContent } from '@/lib/prdDocument'
import {
  useApprovalDraftReset,
  useApprovalDraftRestore,
  useApprovalEditMode,
  useApprovalFocusAnchor,
  useDebouncedApprovalUiState,
  approveArtifact,
  fixCoverageGaps,
} from './approvalHooks'
import { apiFilePath, apiTicketPath } from '@/lib/apiPaths'
import { throwIfNotOk } from '@/lib/fetchError'
import { QueryErrorNotice } from '@/components/shared/QueryErrorNotice'
import { ApprovalEditToolbar } from './ApprovalEditToolbar'
import { RawArtifactBlock } from './artifactViewers/RawArtifactBlock'

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
  structuredDraft?: NormalizedBead[]
}

interface BeadsArtifactResponse {
  beads: unknown[]
  contentSha256: string | null
  /**
   * The tracker as stored, damaged lines included.
   *
   * Not rebuilt from `beads`: a line that did not parse is not in that array,
   * so a JSONL tab reconstructed from it shows a file the operator does not
   * have — and saving it deletes the damage instead of repairing it.
   */
  rawContent: string
  /** 1-based line numbers in the file that did not parse. */
  malformedLines: number[]
  /** 1-based line numbers that parsed but do not describe a bead. */
  unrepresentableLines: number[]
}

/** `Line 4` or `Lines 4, 9, 12`, capped so a badly damaged file stays readable. */
function describeLines(lines: number[]): string {
  if (lines.length === 1) return `Line ${lines[0]}`
  const listed = lines.slice(0, 10).join(', ')
  return `Lines ${listed}${lines.length > 10 ? `, +${lines.length - 10} more` : ''}`
}

/** A line-number list from a payload, keeping only what is one. */
function numberList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((line): line is number => typeof line === 'number') : []
}

function beadsArrayToJsonl(beads: unknown[]): string {
  return beads.map((b) => JSON.stringify(b)).join('\n') + '\n'
}

function jsonlToBeadsArray(jsonl: string): unknown[] {
  return jsonl.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

function validateJsonl(jsonl: string): string | null {
  // Numbered over the whole draft, blank lines included: the server, the
  // damaged-line header and this editor all have to name the same line, and
  // filtering first renumbered everything after a blank one.
  const lines = jsonl.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim()) continue
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

/**
 * The editor's beads, from the same filtered list every other surface uses.
 *
 * Without the filter a stored `null` reached `normalizeBead`, which
 * dereferences `bead.dependencies`, and took the structured editor down. The
 * shared filter also keeps the editor's ordering aligned with the outline's
 * focus anchors and the artifact view.
 */
function parseBeadsForEditor(data: unknown[]): NormalizedBead[] {
  // `verbatim`: an editor must give back exactly what is stored. The artifact
  // views read the same fields with `display`, which trims and drops blanks.
  return filterBeadShaped(data, describeBeadEntry).map((bead) => normalizeBead(bead, 'verbatim'))
}

/** Build a canonical bead object for isSaving — merges editor fields back into the original, keeping read-only fields intact. */
function buildBeadForSave(bead: NormalizedBead): Record<string, unknown> {
  const { contextGuidance, dependencies, acceptanceCriteria, testCommands, testCommandReason, targetFiles, prdRefs, ...rest } = bead
  // Stripped over the *whole* record, canonical fields included. Run over
  // `rest` alone it saw no canonical `prdRefs`, kept `prd_refs` as though it
  // were the only copy, and the canonical value was spread back on top — both
  // spellings again, which is the thing this is here to stop.
  return stripSupersededBeadAliases({
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
  } as NormalizedBead) as Record<string, unknown>
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
  const { data: persistedUiState, isSuccess: isUiStateSuccess, isError: isUiStateError } = useTicketUIState<BeadsApprovalUiState>(ticket.id, uiStateScope, true)
  const councilMemberNames = useMemo(
    () => ticket.lockedCouncilMembers.filter((memberId) => memberId.trim().length > 0),
    [ticket.lockedCouncilMembers],
  )
  const councilMemberCount = councilMemberNames.length || 3
  const {
    artifacts: loadedArtifacts,
    isError: isArtifactsError,
    error: artifactsError,
    refetch: refetchArtifacts,
  } = useTicketArtifacts(ticket.id)
  // See `PrdApprovalPane`: an absent coverage warning is indistinguishable from
  // "no gaps", so approving on a failed artifact request approves an unknown.
  const isCoverageUnknown = isArtifactsError && loadedArtifacts === undefined
  const artifacts = useMemo(() => loadedArtifacts ?? [], [loadedArtifacts])

  // Cache stores array form (matching navigator expectations)
  const {
    data: fetchedBeads,
    isLoading,
    isError: isBeadsError,
    error: beadsError,
    refetch: refetchBeads,
  } = useQuery({
    queryKey: ['artifact', ticket.id, 'beads', 'approval'],
    queryFn: async ({ signal }) => {
      const r = await fetch(apiTicketPath(ticket.id, 'beads', 'raw'), { signal })
      await throwIfNotOk(r, 'Failed to load beads')
      const contentSha256 = typeof r.headers?.get === 'function'
        ? r.headers.get('X-Content-Sha256')
        : null
      const data = await r.json() as Partial<{
        content: string
        items: unknown[]
        malformedLines: number[]
        unrepresentableLines: number[]
      }>
      return {
        beads: Array.isArray(data.items) ? data.items : [],
        contentSha256,
        rawContent: typeof data.content === 'string' ? data.content : '',
        malformedLines: numberList(data.malformedLines),
        unrepresentableLines: numberList(data.unrepresentableLines),
      } satisfies BeadsArtifactResponse
    },
    staleTime: QUERY_STALE_TIME_5M,
  })

  const beadsArray = useMemo(() => fetchedBeads?.beads ?? [], [fetchedBeads])
  const currentContentSha256 = fetchedBeads?.contentSha256 ?? null
  const malformedLines = useMemo(() => fetchedBeads?.malformedLines ?? [], [fetchedBeads])
  // Rows that parsed and are not beads. The structured editor is built from the
  // records it can read, so saving it writes these out of the file — the same
  // loss the damaged lines had, one step further along.
  const unrepresentableLines = useMemo(() => fetchedBeads?.unrepresentableLines ?? [], [fetchedBeads])
  // The file as stored. A damaged line is only visible — and only repairable —
  // here; the structured editor is built from the records that parsed.
  const rawJsonl = fetchedBeads?.rawContent ?? ''
  const hasMalformedLines = malformedLines.length > 0
  const hasUnrepresentableLines = unrepresentableLines.length > 0
  // Guidance the structured editor has no field for — free text, or a list of
  // guidance strings — which it would show as empty pattern lists and write
  // over that value on save.
  const unstructuredGuidanceBeadIds = useMemo(
    // The position is taken before filtering: named from the surviving list, a
    // bead with no id was announced under a place it does not occupy.
    () => beadsArray.flatMap((bead, index) => (
      isRecord(bead) && hasUnstructuredBeadGuidance(bead)
        ? [typeof bead.id === 'string' && bead.id ? bead.id : `bead ${index + 1}`]
        : []
    )),
    [beadsArray],
  )
  const hasUnstructuredGuidance = unstructuredGuidanceBeadIds.length > 0
  const structuredEditorBlocked = hasMalformedLines || hasUnrepresentableLines || hasUnstructuredGuidance
  const malformedLineSummary = describeLines(malformedLines)
  const unrepresentableLineSummary = describeLines(unrepresentableLines)

  const [isEditMode, setIsEditMode] = useState(false)
  const [editTab, setEditTab] = useState<EditTab>('structured')
  const [structuredDraft, setStructuredDraft] = useState<NormalizedBead[] | null>(null)
  const [jsonlDraft, setJsonlDraft] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isApproving, setIsApproving] = useState(false)
  // Deliberately not persisted with the approval draft: an acknowledgement is
  // about the gaps in front of you right now, and a stale one from a previous
  // coverage run would be the wrong explanation attached to a new approval.
  const [gapReason, setGapReason] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  /** A save the server refused because the tracker changed underneath it. */
  const [staleSave, setStaleSave] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)
  const [coverageFixError, setCoverageFixError] = useState<string | null>(null)
  const [isFixingCoverageGaps, setIsFixingCoverageGaps] = useState(false)
  const [discardTarget, setDiscardTarget] = useState<DiscardTarget>(null)
  const restoredDraftRef = useRef(false)
  const lastSavedSnapshotRef = useRef('')
  const skipRestoreRef = useRef(false)
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
  const draftRestored = useApprovalDraftRestore({
    document: fetchedBeads,
    // The UI-state query too, not just the beads one: `persisted` is undefined
    // while it is in flight, and restoring from that latches the pane on
    // defaults, discarding the saved structured and JSONL drafts.
    //
    // `isSuccess`, not `isFetched`: a request that *failed* counts as fetched,
    // and `data` is undefined then too. Latching on that would discard the
    // draft and arm the autosave to write the defaults over the server's copy
    // — from a request that never read it. Waiting means the retry restores.
    ready: !isLoading && isUiStateSuccess,
    persisted: persistedUiState?.data,
    restoredDraftRef,
    lastSavedSnapshotRef,
    skipRestoreRef,
    restore: (persisted, document) => {
      const documentBeads = Array.isArray(document.beads) ? document.beads : []
      const documentRaw = typeof document.rawContent === 'string' ? document.rawContent : ''
      const documentStructured = documentBeads.length > 0 ? parseBeadsForEditor(documentBeads) : null
      const nextEditMode = Boolean(persisted?.isEditMode)
      const nextEditTab: EditTab = persisted?.editTab === 'jsonl' ? 'jsonl' : 'structured'
      const nextStructuredDraft = Array.isArray(persisted?.structuredDraft) && persisted.structuredDraft.length > 0
        ? persisted.structuredDraft
        : documentStructured
      const nextJsonlDraft = typeof persisted?.jsonlDraft === 'string' ? persisted.jsonlDraft : documentRaw

      setIsEditMode(nextEditMode)
      setEditTab(nextEditTab)
      setStructuredDraft(nextStructuredDraft)
      setJsonlDraft(nextJsonlDraft)

      return {
        isEditMode: nextEditMode,
        editTab: nextEditTab,
        jsonlDraft: nextJsonlDraft,
        structuredDraft: nextStructuredDraft,
      }
    },
  })
  const canStartEditing = draftRestored || isUiStateError

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
    if (!draftRestored) skipRestoreRef.current = true
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
    } else if (hasMalformedLines || hasUnrepresentableLines) {
      // The structured editor holds only the records that parsed, so saving it
      // over the file is a deletion of everything else in it.
      const lines = hasMalformedLines ? malformedLines : unrepresentableLines
      const summary = hasMalformedLines ? malformedLineSummary : unrepresentableLineSummary
      setSaveError(
        `${summary} ${hasMalformedLines ? 'could not be read' : 'does not describe a bead'}, and the structured editor `
        + `does not contain ${lines.length === 1 ? 'it' : 'them'}. Repair the file in the JSONL tab instead — saving `
        + `from here would drop ${lines.length === 1 ? 'that line' : 'those lines'}.`,
      )
      return
    } else if (hasUnstructuredGuidance) {
      setSaveError(
        `${unstructuredGuidanceBeadIds.join(', ')} store context guidance as free text, which the structured editor `
        + 'cannot show. Edit them in the JSONL tab instead — saving from here would replace that text with empty lists.',
      )
      return
    }

    setIsSaving(true)
    setSaveError(null)

    try {
      const beadsToSave = editTab === 'structured' && structuredDraft
        ? structuredDraft.map(buildBeadForSave)
        : jsonlToBeadsArray(jsonlDraft)

      const response = await fetch(apiTicketPath(ticket.id, 'beads'), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          // The file this draft was built on. The route refuses the write if
          // the tracker changed in between, rather than overwriting whatever
          // landed — a repair of the damaged lines, most likely.
          ...(currentContentSha256 ? { 'X-Content-Sha256': currentContentSha256 } : {}),
          // Which editor produced it, for the edit receipt.
          'X-Edit-Surface': editTab,
        },
        body: JSON.stringify(beadsToSave),
      })

      await throwIfNotOk(response, 'Failed to save beads')

      // Update cache with the saved array (API returns { success: true })
      const nextContentSha256 = typeof response.headers?.get === 'function'
        ? response.headers.get('X-Content-Sha256')
        : null
      queryClient.setQueryData(['artifact', ticket.id, 'beads', 'approval'], {
        beads: beadsToSave,
        contentSha256: nextContentSha256,
        // What was just written is the file now, and it parses by construction:
        // the save is what repairs a tracker that had damaged lines.
        rawContent: beadsArrayToJsonl(beadsToSave),
        malformedLines: [],
        unrepresentableLines: [],
      } satisfies BeadsArtifactResponse)
      queryClient.setQueryData(['artifact', ticket.id, 'beads'], beadsToSave)
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'beads', 'approval'] })
      queryClient.invalidateQueries({ queryKey: ['artifact', ticket.id, 'beads'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', ticket.id] })
      clearTicketArtifactsCache(queryClient, ticket.id)

      setIsEditMode(false)
      setEditTab('structured')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Save failed'
      // A refused save means the file on disk is not the one this draft was
      // built on, and the screen is still showing the old one. Saying so, and
      // offering the way back, is the whole point of refusing rather than
      // overwriting.
      setSaveError(message.includes('changed since it was read')
        ? `${message}. Reload the current file to see what is there now — your draft is kept until you do.`
        : message)
      if (message.includes('changed since it was read')) setStaleSave(true)
    } finally {
      setIsSaving(false)
    }
  }, [currentContentSha256, editTab, hasMalformedLines, hasUnrepresentableLines, hasUnstructuredGuidance, jsonlDraft, malformedLineSummary, malformedLines, structuredDraft, ticket.id, unrepresentableLineSummary, unrepresentableLines, unstructuredGuidanceBeadIds, queryClient])

  const handleApprove = useCallback(async () => {
    setIsApproving(true)
    setApproveError(null)

    try {
      await approveArtifact(queryClient, {
        ticketId: ticket.id,
        domain: 'beads',
        expectedContentSha256: currentContentSha256,
        gapAcknowledgementReason: gapReason,
        failureMessage: 'Failed to approve beads',
      })
      setIsEditMode(false)
      setEditTab('structured')
    } catch (error) {
      setApproveError(error instanceof Error ? error.message : 'Failed to approve beads')
    } finally {
      setIsApproving(false)
    }
  }, [currentContentSha256, gapReason, ticket.id, queryClient])

  const handleFixCoverageGaps = useCallback(async () => {
    setIsFixingCoverageGaps(true)
    setCoverageFixError(null)

    try {
      await fixCoverageGaps(queryClient, { ticketId: ticket.id, domain: 'beads' })
      // The acknowledgement described the gaps that were just repaired. Keeping
      // it would attach an explanation for old gaps to a later approval.
      setGapReason('')
      setIsEditMode(false)
      setEditTab('structured')
    } catch (error) {
      setCoverageFixError(error instanceof Error ? error.message : 'Failed to fix coverage gaps')
    } finally {
      setIsFixingCoverageGaps(false)
    }
  }, [ticket.id, queryClient])

  const { requestTabChange, handleToggleEdit, handleConfirmDiscard } = useApprovalEditMode<EditTab>({
    editTab,
    isEditMode,
    setIsEditMode,
    hasUnsavedChanges,
    discardTarget,
    setDiscardTarget,
    clearDiscardTarget: () => setDiscardTarget(null),
    resetDraftsFromSaved,
    openEditor,
    exitTab: 'structured',
  })



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
            disabled={!isEditMode && !canStartEditing}
            className="text-xs shrink-0"
          >
            {isEditMode ? 'View' : 'Edit'}
          </Button>
          <Button
            size="sm"
            onClick={handleApprove}
            disabled={isApproving || isSaving || isFixingCoverageGaps || isCoverageUnknown || (isEditMode && hasUnsavedChanges) || beadsArray.length === 0 || hasMalformedLines || hasUnrepresentableLines || !currentContentSha256 || ticket.status !== 'WAITING_BEADS_APPROVAL'}
            className="text-xs shrink-0"
          >
            {isApproving ? 'Approving...' : coverageWarning?.gaps.length ? 'Approve with gaps' : 'Approve'}
          </Button>
        </div>

        {hasMalformedLines || hasUnrepresentableLines ? (
          <div
            role="status"
            className="rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200"
          >
            {hasMalformedLines ? (
              <div>
                {malformedLineSummary} could not be read as JSON and {malformedLines.length === 1 ? 'is' : 'are'} not in
                the structured editor.
              </div>
            ) : null}
            {hasUnrepresentableLines ? (
              <div>
                {unrepresentableLineSummary} {unrepresentableLines.length === 1 ? 'holds' : 'hold'} valid JSON that is
                not a bead, so {unrepresentableLines.length === 1 ? 'it is' : 'they are'} not in the structured editor
                either.
              </div>
            ) : null}
            <div>
              Open the JSONL tab to repair the file — the text is there as stored. Approving is blocked until every line
              reads as a bead.
            </div>
          </div>
        ) : null}

        <PhaseArtifactsPanel
          phase={phase}
          isCompleted={false}
          ticketId={ticket.id}
          councilMemberCount={councilMemberCount}
          councilMemberNames={councilMemberNames.length > 0 ? councilMemberNames : undefined}
        />

        {isEditMode ? (
          <ApprovalEditToolbar
            tabs={[{ id: 'structured', label: 'Structured' }, { id: 'jsonl', label: 'JSONL' }]}
            activeTab={editTab}
            onTabChange={requestTabChange}
            autosave={approvalAutosave}
            onSave={handleSave}
            isSaving={isSaving}
            saveDisabled={isSaving || !hasUnsavedChanges}
          />
        ) : null}

        {saveError ? (
          <div className="flex items-center gap-2">
            <p className="text-xs text-red-500">{saveError}</p>
            {staleSave ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs shrink-0"
                onClick={() => {
                  setStaleSave(false)
                  setSaveError(null)
                  void refetchBeads()
                }}
              >
                Reload file
              </Button>
            ) : null}
          </div>
        ) : null}
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
              gapReason={gapReason}
              onGapReasonChange={setGapReason}
              gapReasonDisabled={isApproving || isFixingCoverageGaps}
            />
          ) : null}
          {isCoverageUnknown ? (
            <QueryErrorNotice
              title="Coverage could not be checked, so this plan cannot be approved yet."
              error={artifactsError}
              onRetry={() => void refetchArtifacts()}
            />
          ) : null}
          {isBeadsError && fetchedBeads !== undefined ? (
            <QueryErrorNotice
              title="Showing the last beads that loaded. The refresh failed."
              error={beadsError}
              onRetry={() => void refetchBeads()}
            />
          ) : null}
          {isBeadsError && fetchedBeads === undefined ? (
            <QueryErrorNotice
              className="py-8"
              title="The beads artifact could not be loaded."
              error={beadsError}
              onRetry={() => void refetchBeads()}
            />
          ) : isLoading ? (
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
              ) : structuredEditorBlocked ? (
                <div className="rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
                  {hasMalformedLines || hasUnrepresentableLines ? (
                    <>
                      The structured editor is unavailable while the tracker holds rows it cannot represent: it would
                      contain only the beads it could read, and saving it would delete the rest. Repair the file in the
                      JSONL tab instead — {(hasMalformedLines ? malformedLineSummary : unrepresentableLineSummary).toLowerCase()}{' '}
                      {(hasMalformedLines ? malformedLines : unrepresentableLines).length === 1 ? 'is' : 'are'} there as
                      stored.
                    </>
                  ) : (
                    <>
                      The structured editor has no field for context guidance written as free text, so saving from it
                      would replace that text with empty lists. Edit {unstructuredGuidanceBeadIds.join(', ')} in the
                      JSONL tab instead.
                    </>
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
  const artifactState = useTicketArtifacts(ticket.id, {
    phase,
    ...(archivedAttempt ? { phaseAttempt } : {}),
  })
  const artifacts = useMemo(() => artifactState.artifacts ?? [], [artifactState.artifacts])
  const snapshotArtifactType = `approval_snapshot:${artifactType}`
  const snapshotRaw = useMemo(() => {
    const snapshotArtifact = artifacts.find((artifact) => artifact.artifactType === snapshotArtifactType)
    return parseApprovalSnapshotRaw(snapshotArtifact?.content)
  }, [artifacts, snapshotArtifactType])
  // The interview endpoint answers for the interview artifact only. Left always
  // enabled, opening a read-only PRD or beads attempt still called it, and its
  // failure then surfaced against an artifact type it says nothing about.
  const { data: interviewData, isError: isInterviewError, error: interviewError, refetch: refetchInterview } =
    useInterviewQuestions(ticket.id, {
      enabled: Boolean(ticket.id) && artifactType === 'interview' && !archivedAttempt,
    })
  const {
    data: prdContent,
    isError: isPrdError,
    error: prdError,
    refetch: refetchPrd,
  } = useQuery({
    queryKey: ['artifact', ticket.id, 'prd', archivedAttempt ? phaseAttempt : 'live'],
    queryFn: async ({ signal }) => {
      const response = await fetch(apiFilePath(ticket.id, 'prd'), { signal })
      await throwIfNotOk(response, 'Failed to load PRD')
      const payload = await response.json() as { content?: string }
      return payload.content ?? ''
    },
    enabled: artifactType === 'prd' && !archivedAttempt,
    staleTime: QUERY_STALE_TIME_5M,
  })
  const {
    data: beadsContent,
    isError: isBeadsError,
    error: beadsError,
    refetch: refetchBeads,
  } = useQuery({
    queryKey: ['artifact', ticket.id, 'beads', archivedAttempt ? phaseAttempt : 'live'],
    queryFn: async ({ signal }) => {
      const response = await fetch(apiTicketPath(ticket.id, 'beads'), { signal })
      await throwIfNotOk(response, 'Failed to load beads')
      const payload = await response.json()
      return Array.isArray(payload) ? beadsArrayToJsonl(payload) : ''
    },
    enabled: artifactType === 'beads' && !archivedAttempt,
    staleTime: QUERY_STALE_TIME_5M,
  })

  // An archived attempt reads its content from the artifact snapshot, so only a
  // live attempt can fail here.
  const contentError = archivedAttempt
    ? null
    : artifactType === 'interview'
      ? (isInterviewError ? { error: interviewError, retry: refetchInterview } : null)
      : artifactType === 'prd'
        ? (isPrdError ? { error: prdError, retry: refetchPrd } : null)
        : (isBeadsError ? { error: beadsError, retry: refetchBeads } : null)

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
          artifactState={artifactState}
        />
      </div>

      <div className="flex-1 min-h-0 px-4 pb-2 overflow-auto">
        {contentError ? (
          <QueryErrorNotice
            className="py-8"
            title="This artifact could not be loaded."
            error={contentError.error}
            onRetry={() => void contentError.retry()}
          />
        ) : artifactType === 'interview' ? (
          interviewDocument ? (
            <InterviewDocumentView document={interviewDocument} hideAiAnswerBadge />
          ) : (
            <RawArtifactBlock content={content ? rawDisplayContent : ''} emptyLabel="No interview artifact available." />
          )
        ) : artifactType === 'prd' ? (
          prdDocument ? (
            <PrdDocumentView document={prdDocument as PrdDocument} />
          ) : (
            <RawArtifactBlock content={content ? rawDisplayContent : ''} emptyLabel="No PRD artifact available." />
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
  const {
    attempts,
    selectedAttempt,
    setManualSelectedAttemptNumber,
    archivedAttemptNumber,
    logPhaseAttempt,
    logMode,
    isError: isAttemptsError,
    error: attemptsError,
    refetch: refetchAttempts,
  } = useSelectedPhaseAttempt(ticket.id, resolvedPhase)
  const attemptNumber = selectedAttemptNumber(selectedAttempt, attempts)
  const selector = isAttemptsError ? (
    <div className="px-4 pt-4 shrink-0">
      <PhaseAttemptsUnavailable error={attemptsError} onRetry={() => void refetchAttempts()} />
    </div>
  ) : attemptNumber !== undefined && attempts.length > 1 ? (
    <div className="px-4 pt-4 shrink-0">
      <PhaseAttemptSelector
        attempts={attempts}
        value={attemptNumber}
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
