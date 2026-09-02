import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { throwIfNotOk } from '@/lib/fetchError'
import { apiTicketPath } from '@/lib/apiPaths'

export type ManualQaResultStatus = 'pass' | 'fail' | 'waive' | 'improvement' | 'pending'
export type ManualQaSeverity = 'required' | 'optional'
export type ManualQaChecklistSource = 'prd' | 'bead' | 'previous_qa' | 'implementation_diff'
export type ManualQaCoverageLevel = 'full' | 'partial'

export interface ManualQaPrdReference {
  ref: string
  coverage: ManualQaCoverageLevel
}

export interface ManualQaChecklistItem {
  id: string
  lineageId: string
  priorItemIds?: string[]
  title?: string
  source: ManualQaChecklistSource
  behavior: string
  severity: ManualQaSeverity
  recheckState?: 'new' | 'pending_recheck' | 'previously_passed'
  prerequisites: string[]
  actions: string[]
  expectedResult: string
  watchNotes?: string[]
  beadRefs?: string[]
  prdRefs: ManualQaPrdReference[]
}

export interface ManualQaChecklist {
  schemaVersion: number
  version: number
  generatedAt?: string
  notApplicablePrdRefs?: Array<{ ref: string; reason: string }>
  items: ManualQaChecklistItem[]
}

export interface ManualQaEvidence {
  id: string
  itemId: string
  name: string
  size: number
  sha256: string
  mediaType: string
  previewable: boolean
  createdAt?: string
  downloadUrl?: string
  originalName?: string
  storedName?: string
  inlinePreview?: boolean
}

export interface ManualQaImprovementDraft {
  title: string
  description: string
  priority: number
  manualQaEnabled: boolean
  contextOverride?: string
  evidenceIds?: string[]
}

export interface ManualQaItemResult {
  itemId: string
  status: ManualQaResultStatus
  note?: string
  observation?: string
  waiverReason?: string
  evidenceIds?: string[]
  improvement?: ManualQaImprovementDraft
  mergeWithItemIds?: string[]
  links?: Array<{ id: string; url: string; label?: string }>
}

export interface ManualQaDraft {
  results: Record<string, ManualQaItemResult>
  skipReason?: string
}

export interface ManualQaCoverageEntry {
  criterionRef: string
  criterion: string
  status: 'covered' | 'partially_covered' | 'uncovered' | 'not_applicable'
  itemIds: string[]
  reason?: string
}

export interface ManualQaCoverageSummary {
  coveredCount: number
  partiallyCoveredCount: number
  uncoveredCount: number
  notApplicableCount: number
  sourceItemCounts: {
    prd: number
    bead: number
    previousQa: number
    implementationDiff: number
  }
}

export interface ManualQaSummary {
  outcome: NonNullable<ManualQaRound['outcome']>
  createdFixBeadIds: string[]
  improvementTicketIds: string[]
  waivedItemIds: string[]
  waivedItems: Array<{ itemId: string; reason: string }>
  skipReason?: string
  startedAt?: string
  completedAt?: string
  durationMs: number
  itemCounts: Record<ManualQaResultStatus, number>
  requiredItemCount: number
  optionalItemCount: number
  evidenceCount: number
  nextAction?: 'integrate' | 'return_to_coding'
  coverage: { covered: number; partiallyCovered: number; uncovered: number; notApplicable: number }
  modelCapability?: {
    modelId: string | null
    modelVariant: string | null
    capabilityLookup: 'available' | 'unavailable'
    supportsImages: boolean | null
    imageEvidenceMode: 'attached' | 'references_only'
    capturedAt?: string
  } | null
  message?: string
}

export interface ManualQaWorkspaceDrift {
  detected: boolean
  files: Array<{ path: string; classification?: string }>
  decisionRequired?: boolean
}

export interface ManualQaRound {
  version: number
  status: 'generating' | 'waiting' | 'completed' | 'failed' | 'skipped' | string
  checklistHash: string | null
  checklist: ManualQaChecklist | null
  coverage: ManualQaCoverageEntry[]
  coverageSummary: ManualQaCoverageSummary
  evidence: ManualQaEvidence[]
  draftRevision: number
  completedAt?: string | null
  outcome?: 'passed' | 'waived_through' | 'skipped' | 'failed' | 'created_fixes' | null
  readOnly?: boolean
  workspaceDrift?: ManualQaWorkspaceDrift | null
  operation?: {
    actionId?: string
    operationType?: 'submit' | 'skip'
    state: string
    status: string
    message?: string | null
  } | null
  draft?: ManualQaDraft | null
  summary?: ManualQaSummary | null
}

export interface ManualQaIndex {
  activeVersion: number | null
  completedRounds: number
  completedRoundCount?: number
  latestOutcome: ManualQaRound['outcome']
  artifactAvailable: boolean
  versions: Array<{
    version: number
    status: ManualQaRound['status']
    outcome?: ManualQaRound['outcome']
    completedAt?: string | null
    artifactAvailable: boolean
    phaseAttempt: number | null
  }>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function normalizeEvidence(value: unknown): ManualQaEvidence {
  const entry = asRecord(value)
  return {
    id: String(entry.id ?? ''),
    itemId: String(entry.itemId ?? ''),
    name: String(entry.name ?? entry.originalName ?? 'Evidence'),
    size: typeof entry.size === 'number' ? entry.size : 0,
    sha256: String(entry.sha256 ?? ''),
    mediaType: String(entry.mediaType ?? 'application/octet-stream'),
    previewable: entry.previewable === true || entry.inlinePreview === true,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : undefined,
    downloadUrl: typeof entry.downloadUrl === 'string' ? entry.downloadUrl : undefined,
    originalName: typeof entry.originalName === 'string' ? entry.originalName : undefined,
    storedName: typeof entry.storedName === 'string' ? entry.storedName : undefined,
    inlinePreview: entry.inlinePreview === true,
  }
}

function normalizeDraft(value: unknown): ManualQaDraft | null {
  const raw = asRecord(value)
  const rawResults = raw.results
  if (!rawResults) return null
  if (!Array.isArray(rawResults)) return { results: rawResults as Record<string, ManualQaItemResult> }
  const improvements = Array.isArray(raw.improvements) ? raw.improvements.map(asRecord) : []
  const improvementById = new Map(improvements.map((entry) => [String(entry.id ?? ''), entry]))
  const results: Record<string, ManualQaItemResult> = {}
  for (const rawResult of rawResults) {
    const result = asRecord(rawResult)
    const itemId = String(result.itemId ?? '')
    if (!itemId) continue
    const improvement = improvementById.get(String(result.improvementDraftId ?? ''))
    results[itemId] = {
      itemId,
      status: String(result.status ?? result.outcome ?? 'pending') as ManualQaResultStatus,
      note: typeof result.note === 'string' ? result.note : undefined,
      observation: typeof result.observation === 'string' ? result.observation : undefined,
      waiverReason: typeof result.waiverReason === 'string' ? result.waiverReason : typeof result.reason === 'string' ? result.reason : undefined,
      evidenceIds: Array.isArray(result.evidenceIds) ? result.evidenceIds.map(String) : [],
      mergeWithItemIds: Array.isArray(result.mergeWithItemIds) ? result.mergeWithItemIds.map(String) : [],
      links: Array.isArray(result.links) ? result.links.map((linkValue) => {
        const link = asRecord(linkValue)
        return { id: String(link.id ?? ''), url: String(link.url ?? ''), label: typeof link.label === 'string' ? link.label : undefined }
      }) : [],
      improvement: improvement ? {
        title: String(improvement.title ?? ''),
        description: String(improvement.description ?? ''),
        priority: numberValue(improvement.priority) || 3,
        manualQaEnabled: improvement.manualQaEnabled === true,
        contextOverride: typeof improvement.contextOverride === 'string' ? improvement.contextOverride : undefined,
        evidenceIds: Array.isArray(improvement.evidenceIds) ? improvement.evidenceIds.map(String) : [],
      } : undefined,
    }
  }
  return { results }
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

export function normalizeManualQaRound(value: unknown, version: number): ManualQaRound {
  const raw = asRecord(value)
  const checklistRaw = asRecord(raw.checklist)
  const checklist = raw.checklist ? {
    ...checklistRaw,
    schemaVersion: Number(checklistRaw.schemaVersion ?? 1),
    version: Number(checklistRaw.version ?? version),
    notApplicablePrdRefs: Array.isArray(checklistRaw.notApplicablePrdRefs)
      ? checklistRaw.notApplicablePrdRefs.map((value) => {
        const entry = asRecord(value)
        return { ref: String(entry.ref ?? ''), reason: String(entry.reason ?? '') }
      })
      : [],
    items: Array.isArray(checklistRaw.items) ? checklistRaw.items.map((itemValue) => {
      const item = asRecord(itemValue)
      return {
        ...item,
        id: String(item.id ?? ''),
        lineageId: String(item.lineageId ?? ''),
        title: typeof item.title === 'string' ? item.title : undefined,
        source: String(item.source ?? 'implementation_diff') as ManualQaChecklistSource,
        behavior: String(item.behavior ?? ''),
        severity: String(item.severity ?? 'optional') as ManualQaSeverity,
        recheckState: item.recheckState as ManualQaChecklistItem['recheckState'],
        prerequisites: Array.isArray(item.prerequisites) ? item.prerequisites.map(String) : [],
        actions: Array.isArray(item.actions) ? item.actions.map(String) : [],
        expectedResult: String(item.expectedResult ?? ''),
        watchNotes: Array.isArray(item.watchNotes) ? item.watchNotes.map(String) : [],
        beadRefs: Array.isArray(item.beadRefs) ? item.beadRefs.map(String) : [],
        prdRefs: Array.isArray(item.prdRefs) ? item.prdRefs as ManualQaPrdReference[] : [],
      }
    }) : [],
  } as ManualQaChecklist : null
  const coverageRaw = asRecord(raw.coverage)
  const coverageValues = Array.isArray(raw.coverage) ? raw.coverage : Array.isArray(coverageRaw.entries) ? coverageRaw.entries : []
  const summary = asRecord(raw.summary)
  const draft = normalizeDraft(raw.draft ?? raw.results)
  const evidenceValues = Array.isArray(raw.evidence) ? raw.evidence : []
  const operationRaw = asRecord(raw.operation)
  const operationState = String(operationRaw.state ?? operationRaw.status ?? '')
  const sourceItemCounts = asRecord(coverageRaw.sourceItemCounts)
  const itemCounts = asRecord(summary.itemCounts)
  const summaryCoverage = asRecord(summary.coverage)
  const modelCapability = asRecord(summary.modelCapability)
  return {
    version,
    status: String(raw.status ?? (raw.summary ? 'completed' : raw.checklist ? 'waiting' : 'generating')),
    checklistHash: typeof raw.checklistHash === 'string' ? raw.checklistHash : null,
    checklist,
    coverage: coverageValues.map((entryValue) => {
      const entry = asRecord(entryValue)
      return {
        criterionRef: String(entry.criterionRef ?? ''),
        criterion: String(entry.criterion ?? ''),
        status: String(entry.status ?? 'uncovered') as ManualQaCoverageEntry['status'],
        itemIds: Array.isArray(entry.itemIds) ? entry.itemIds.map(String) : [],
        reason: typeof entry.reason === 'string' ? entry.reason : undefined,
      }
    }),
    coverageSummary: {
      coveredCount: numberValue(coverageRaw.coveredCount),
      partiallyCoveredCount: numberValue(coverageRaw.partiallyCoveredCount),
      uncoveredCount: numberValue(coverageRaw.uncoveredCount),
      notApplicableCount: numberValue(coverageRaw.notApplicableCount),
      sourceItemCounts: {
        prd: numberValue(sourceItemCounts.prd),
        bead: numberValue(sourceItemCounts.bead),
        previousQa: numberValue(sourceItemCounts.previousQa),
        implementationDiff: numberValue(sourceItemCounts.implementationDiff),
      },
    },
    evidence: evidenceValues.map(normalizeEvidence),
    draftRevision: typeof raw.draftRevision === 'number' ? raw.draftRevision : Number(asRecord(raw.draft).draftRevision ?? asRecord(raw.results).draftRevision ?? 0),
    completedAt: typeof summary.completedAt === 'string' ? summary.completedAt : null,
    outcome: typeof summary.outcome === 'string' ? summary.outcome as ManualQaRound['outcome'] : null,
    readOnly: raw.readOnly === true || (Boolean(raw.summary) && summary.outcome !== 'failed'),
    workspaceDrift: raw.workspaceDrift as ManualQaWorkspaceDrift | null | undefined,
    operation: raw.operation ? {
      actionId: typeof operationRaw.actionId === 'string' ? operationRaw.actionId : undefined,
      operationType: operationRaw.operationType === 'skip' ? 'skip' : operationRaw.operationType === 'submit' ? 'submit' : undefined,
      state: operationState,
      status: operationState,
      message: typeof operationRaw.message === 'string' ? operationRaw.message : undefined,
    } : null,
    draft,
    summary: raw.summary ? {
      outcome: String(summary.outcome ?? 'failed') as ManualQaSummary['outcome'],
      createdFixBeadIds: stringArray(summary.createdFixBeadIds),
      improvementTicketIds: stringArray(summary.improvementTicketIds),
      waivedItemIds: stringArray(summary.waivedItemIds),
      waivedItems: Array.isArray(summary.waivedItems) ? summary.waivedItems.map((value) => {
        const item = asRecord(value)
        return { itemId: String(item.itemId ?? ''), reason: String(item.reason ?? '') }
      }) : [],
      skipReason: typeof summary.skipReason === 'string' ? summary.skipReason : undefined,
      startedAt: typeof summary.startedAt === 'string' ? summary.startedAt : undefined,
      completedAt: typeof summary.completedAt === 'string' ? summary.completedAt : undefined,
      durationMs: numberValue(summary.durationMs),
      itemCounts: {
        pass: numberValue(itemCounts.pass),
        fail: numberValue(itemCounts.fail),
        waive: numberValue(itemCounts.waive),
        improvement: numberValue(itemCounts.improvement),
        pending: numberValue(itemCounts.pending),
      },
      requiredItemCount: numberValue(summary.requiredItemCount),
      optionalItemCount: numberValue(summary.optionalItemCount),
      evidenceCount: numberValue(summary.evidenceCount),
      nextAction: summary.nextAction === 'return_to_coding' ? 'return_to_coding' : summary.nextAction === 'integrate' ? 'integrate' : undefined,
      coverage: {
        covered: numberValue(summaryCoverage.covered),
        partiallyCovered: numberValue(summaryCoverage.partiallyCovered),
        uncovered: numberValue(summaryCoverage.uncovered),
        notApplicable: numberValue(summaryCoverage.notApplicable),
      },
      modelCapability: summary.modelCapability && typeof summary.modelCapability === 'object' ? {
        modelId: typeof modelCapability.modelId === 'string' ? modelCapability.modelId : null,
        modelVariant: typeof modelCapability.modelVariant === 'string' ? modelCapability.modelVariant : null,
        capabilityLookup: modelCapability.capabilityLookup === 'available' ? 'available' : 'unavailable',
        supportsImages: typeof modelCapability.supportsImages === 'boolean' ? modelCapability.supportsImages : null,
        imageEvidenceMode: modelCapability.imageEvidenceMode === 'attached' ? 'attached' : 'references_only',
        capturedAt: typeof modelCapability.capturedAt === 'string' ? modelCapability.capturedAt : undefined,
      } : null,
      message: typeof summary.message === 'string' ? summary.message : undefined,
    } : null,
  }
}

export interface ManualQaMutationBase {
  ticketId: string
  version: number
  actionId: string
  expectedChecklistHash: string
  expectedDraftRevision: number
}

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
  await throwIfNotOk(response, fallback)
  return response.json() as Promise<T>
}

export function useManualQaIndex(ticketId: string, enabled = true) {
  return useQuery({
    queryKey: ['manual-qa', ticketId, 'index'],
    enabled: Boolean(ticketId) && enabled,
    queryFn: async ({ signal }) => {
      const value = await parseResponse<ManualQaIndex & { completedRoundCount?: number }>(
        await fetch(apiTicketPath(ticketId, 'manual-qa'), { signal }),
        'Failed to load Manual QA rounds',
      )
      const raw = value as unknown as Record<string, unknown>
      const rawVersions = Array.isArray(raw.versions) ? raw.versions : []
      return {
        ...value,
        completedRounds: value.completedRounds ?? value.completedRoundCount ?? 0,
        versions: rawVersions.map((entry) => {
          if (typeof entry === 'number') {
            return {
              version: entry,
              status: entry === value.activeVersion ? 'waiting' : 'completed',
              artifactAvailable: true,
              phaseAttempt: null,
            }
          }
          const versionEntry = asRecord(entry)
          return {
            version: Number(versionEntry.version),
            status: String(versionEntry.status ?? 'completed'),
            outcome: typeof versionEntry.outcome === 'string' ? versionEntry.outcome as ManualQaRound['outcome'] : undefined,
            completedAt: typeof versionEntry.completedAt === 'string' ? versionEntry.completedAt : null,
            artifactAvailable: versionEntry.artifactAvailable === true,
            phaseAttempt: typeof versionEntry.phaseAttempt === 'number' ? versionEntry.phaseAttempt : null,
          }
        }),
      }
    },
    refetchInterval: (query) => query.state.data?.activeVersion ? 5000 : false,
  })
}

export function useManualQaRound(ticketId: string, version: number | null, enabled = true) {
  return useQuery({
    queryKey: ['manual-qa', ticketId, 'version', version],
    enabled: Boolean(ticketId) && version !== null && enabled,
    queryFn: async ({ signal }) => normalizeManualQaRound(await parseResponse<unknown>(
      await fetch(apiTicketPath(ticketId, 'manual-qa', 'versions', version!), { signal }),
      'Failed to load Manual QA checklist',
    ), version!),
    refetchInterval: (query) => query.state.data?.status === 'generating' ? 3000 : false,
  })
}

function manualQaMutation<TVariables extends ManualQaMutationBase>(
  path: (variables: TVariables) => string,
  method: 'POST' | 'DELETE' = 'POST',
) {
  return async (variables: TVariables) => {
    const { ticketId: _ticketId, ...body } = variables
    return parseResponse<unknown>(await fetch(path(variables), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), 'Manual QA action failed')
  }
}

function useRoundMutation<TVariables extends ManualQaMutationBase, TResult = unknown>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['manual-qa', variables.ticketId, 'version', variables.version] })
      queryClient.invalidateQueries({ queryKey: ['manual-qa', variables.ticketId, 'index'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', variables.ticketId] })
      queryClient.invalidateQueries({ queryKey: ['tickets'] })
    },
  })
}

export function useSubmitManualQa() {
  return useRoundMutation(manualQaMutation<ManualQaMutationBase & { draft: unknown }>(
    ({ ticketId }) => apiTicketPath(ticketId, 'manual-qa', 'submit'),
  ))
}

export function useSkipManualQa() {
  return useRoundMutation(manualQaMutation<ManualQaMutationBase & { reason?: string; draft: unknown }>(
    ({ ticketId }) => apiTicketPath(ticketId, 'manual-qa', 'skip'),
  ))
}

export function useResolveManualQaDrift(decision: 'include' | 'discard') {
  return useRoundMutation(manualQaMutation<ManualQaMutationBase>(
    ({ ticketId }) => apiTicketPath(ticketId, 'manual-qa', 'workspace-drift', decision),
  ))
}

export function useUploadManualQaEvidence() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ ticketId, version, itemId, file, evidenceId, actionId, expectedChecklistHash, expectedDraftRevision }: ManualQaMutationBase & { itemId: string; file: File; evidenceId: string }) => {
      const params = new URLSearchParams({
        itemId,
        actionId,
        expectedChecklistHash,
        expectedDraftRevision: String(expectedDraftRevision),
      })
      const evidenceUrl = `${apiTicketPath(ticketId, 'manual-qa', 'versions', version, 'evidence')}?${params.toString()}`
      const payload = await parseResponse<unknown>(await fetch(evidenceUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
          'X-Evidence-Id': evidenceId,
        },
        body: file,
      }), 'Evidence upload failed')
      return normalizeEvidence(asRecord(payload).evidence ?? payload)
    },
    onSettled: (_, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: ['manual-qa', variables.ticketId, 'version', variables.version] })
    },
  })
}

export function useRemoveManualQaEvidence() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ ticketId, version, itemId, evidenceId, ...body }: ManualQaMutationBase & { itemId: string; evidenceId: string }) =>
      parseResponse<{ success: boolean }>(await fetch(
        apiTicketPath(ticketId, 'manual-qa', 'versions', version, 'evidence', itemId, evidenceId),
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ), 'Failed to remove evidence'),
    onSettled: (_, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: ['manual-qa', variables.ticketId, 'version', variables.version] })
    },
  })
}

export function manualQaEvidenceUrl(ticketId: string, version: number, itemId: string, evidenceId: string, inline = false) {
  const path = apiTicketPath(ticketId, 'manual-qa', 'versions', version, 'evidence', itemId, evidenceId)
  return inline ? `${path}?inline=true` : path
}

export function newManualQaActionId(prefix: string) {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}
