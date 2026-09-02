import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { clearPersistedTicketLogs } from '@/context/logUtils'
import { mergeTicketInCache, patchTicketStatusInCache } from './ticketStatusCache'
import { isTerminalWorkflowStatus, type WorkflowAction } from '@shared/workflowMeta'
import { isRecord } from '@shared/typeGuards'
import type { InterviewSessionSnapshot, InterviewSessionView, PersistedInterviewBatch } from '@shared/interviewSession'
import { clearErrorTicketSeen } from '@/lib/errorTicketSeen'
import { clearNeedsInputSeen } from '@/lib/needsInputSeen'
import { throwIfNotOk } from '@/lib/fetchError'
import { apiTicketPath } from '@/lib/apiPaths'
import {
  normalizeTicketListResponse,
  normalizeTicketPatch,
  normalizeTicketResponse,
  type RawTicketResponse,
} from '@/lib/ticketNormalization'
import type { TicketErrorOccurrence } from '@/lib/errorOccurrences'
import {
  clearTicketUiStateRevisions,
  createTicketUiStateActionId,
  getTicketUiStateRevision,
  rememberTicketUiStateRevision,
} from '@/lib/ticketUiStateRevision'
import type { GitHookPolicy } from '@/lib/executionSetupPlan'
import type { SettingSource } from '@shared/aiQuestions'

export interface TicketEta {
  bestMs: number
  likelyMs: number
  worstMs: number
  basis: 'history' | 'current' | 'default'
}

export interface ManualQaOriginEvidenceRef {
  id: string
  originalName: string
  mediaType: string
  size: number
  sha256: string
  relativePath: string
}

export interface ManualQaOriginSourceItem {
  itemId: string
  lineageId: string
  behavior: string
  observation: string
  expectedResult: string
  evidence: ManualQaOriginEvidenceRef[]
  links: Array<{ id: string; url: string; label?: string }>
}

export interface ManualQaBeadOrigin {
  schemaVersion: 1
  actionId: string
  sourceTicketId: string
  sourceTicketExternalId: string
  version: number
  sourceItems: ManualQaOriginSourceItem[]
  imageDelivery?: 'attached' | 'references_only'
}

import type { BeadNoteEntry } from '@shared/beadNotes'
export type { BeadNoteEntry }

export interface ManualQaImprovementOrigin {
  schemaVersion: 1
  source: 'manual_qa_improvement'
  originId: string
  actionId: string
  sourceTicketId: string
  sourceTicketExternalId: string
  sourceProjectId: number
  sourceVersion: number
  sourceItemIds: string[]
  sourceItemTitles: string[]
  resultType: 'improvement'
  relatedPrdRefs: string[]
  relatedBeadRefs: string[]
  evidenceRefs: ManualQaOriginEvidenceRef[]
  omittedEvidence: Array<{ id: string; reason: string }>
  titleSha256: string
  descriptionSha256: string
  omittedFields: string[]
  imageEvidenceMode: 'attached' | 'references_only'
  createdAt: string
}

interface TicketRuntime {
  baseBranch: string
  currentBead: number
  completedBeads: number
  totalBeads: number
  percentComplete: number
  iterationCount: number
  maxIterations: number | null
  maxIterationsPerBead: number | null
  perIterationTimeoutMs?: number | null
  executionSetupTimeoutMs?: number | null
  activeBeadId: string | null
  activeBeadIteration: number | null
  lastFailedBeadId: string | null
  artifactRoot: string
  beads?: Array<{
    id: string
    title: string
    status: string
    iteration: number
    failedIterationNotes: BeadNoteEntry[]
    userRetryNotes: BeadNoteEntry[]
    finalizationFailureNotes: BeadNoteEntry[]
    startedAt?: string | null
    updatedAt?: string | null
    completedAt?: string | null
    qaOrigin?: ManualQaBeadOrigin | null
  }>
  candidateCommitSha: string | null
  preSquashHead: string | null
  finalTestStatus: 'passed' | 'failed' | 'pending'
  prNumber?: number | null
  prUrl?: string | null
  prState?: 'draft' | 'open' | 'merged' | 'closed' | null
  prHeadSha?: string | null
  eta?: TicketEta | null
}

export interface Ticket {
  id: string
  externalId: string
  projectId: number
  isDisplayOnlyMock: boolean
  title: string
  description: string | null
  priority: number
  status: string
  xstateSnapshot: string | null
  branchName: string | null
  currentBead: number | null
  totalBeads: number | null
  percentComplete: number | null
  errorMessage: string | null
  /** Why the operator canceled. Survives deleting the ticket's artifacts. */
  cancelReason?: string | null
  errorSeenSignature?: string | null
  needsInputSeenSignature?: string | null
  /**
   * A model waiting on an answer, or null when none is. The two counts disagree
   * on purpose: a council of three asking two things each is 3 requests and
   * 6 questions. Surfaces that speak to a person count questions.
   */
  pendingQuestions?: {
    requestCount: number
    requestIds?: string[]
    questionCount: number
    deadlineAt: string | null
    stoppedAt: string | null
  } | null
  implementationTiming: {
    activeDurationMs: number
    startedAt: string | null
    lastPlannedBeadFinishedAt: string | null
    manualQaFixDurationMs: number
    manualQaFixStartedAt: string | null
    workspacePreparationDurationMs: number
    workspacePreparationStartedAt: string | null
    finalTestingDurationMs: number
    finalTestingStartedAt: string | null
    questionWaitingMs: number
  }
  errorOccurrences?: TicketErrorOccurrence[]
  activeErrorOccurrenceId?: string | null
  hasPastErrors?: boolean
  completionDisposition?: 'merged' | 'closed_unmerged' | null
  cleanup?: {
    status: 'clean' | 'warning' | null
    errorCount: number
    latestReportArtifactId: number | null
    errors?: string[]
  }
  manualQaOverride?: boolean | null
  effectiveGitHookPolicy?: GitHookPolicy
  effectiveGitHookPolicySource?: 'project' | 'profile'
  lockedGitHookPolicy?: GitHookPolicy | null
  lockedGitHookPolicySource?: 'project' | 'profile' | null
  effectiveManualQaEnabled?: boolean
  effectiveManualQaSource?: 'ticket' | 'project' | 'profile'
  lockedManualQaEnabled?: boolean | null
  lockedManualQaSource?: 'ticket' | 'project' | 'profile' | null
  aiQuestionsOverride?: boolean | null
  /** Milliseconds, or null to inherit. */
  aiQuestionWindowOverride?: number | null
  effectiveAiQuestionsEnabled?: boolean
  effectiveAiQuestionsSource?: SettingSource
  effectiveAiQuestionWindow?: number
  effectiveAiQuestionWindowSource?: SettingSource
  workflowRevision?: number
  visitedStatuses?: string[]
  manualQa?: {
    activeVersion: number | null
    completedRoundCount: number
    latestOutcome: 'passed' | 'waived_through' | 'skipped' | 'failed' | 'created_fixes' | null
    artifactAvailability: {
      checklist: boolean
      results: boolean
      coverage: boolean
      summary: boolean
    }
  }
  manualQaOrigin?: ManualQaImprovementOrigin | null
  lockedMainImplementer: string | null
  lockedMainImplementerVariant?: string | null
  lockedInterviewQuestions?: number | null
  lockedCoverageFollowUpBudgetPercent?: number | null
  lockedMaxCoveragePasses?: number | null
  lockedMaxPrdCoveragePasses?: number | null
  lockedMaxBeadsCoveragePasses?: number | null
  lockedStructuredRetryCount?: number | null
  lockedCouncilMembers: string[]
  lockedCouncilMemberVariants?: Record<string, string> | null
  availableActions: WorkflowAction[]
  previousStatus?: string | null
  reviewCutoffStatus: string | null
  runtime: TicketRuntime
  startedAt: string | null
  plannedDate: string | null
  createdAt: string
  updatedAt: string
}

interface CreateTicketInput {
  projectId: number
  title: string
  description?: string
  priority?: number
  manualQaOverride?: boolean | null
  aiQuestionsOverride?: boolean | null
  aiQuestionWindowOverride?: number | null
}

interface TicketActionResponse {
  message: string
  ticketId: string
  status?: string
  state?: string
  /** The server's own shape, not the view model — it goes through the normaliser. */
  ticket?: RawTicketResponse
}

const ACTIVE_TICKET_REFETCH_INTERVAL_MS = 5000
const ACTIVE_TICKET_LIST_REFETCH_INTERVAL_MS = 10000

export function getTicketAutoRefreshInterval(
  ticket: Pick<Ticket, 'status'> | null | undefined,
): number | false {
  return ticket && !isTerminalWorkflowStatus(ticket.status)
    ? ACTIVE_TICKET_REFETCH_INTERVAL_MS
    : false
}

export function getTicketsAutoRefreshInterval(
  tickets: Array<Pick<Ticket, 'status'>> | null | undefined,
): number | false {
  return tickets?.some((ticket) => !isTerminalWorkflowStatus(ticket.status))
    ? ACTIVE_TICKET_LIST_REFETCH_INTERVAL_MS
    : false
}

async function fetchTickets(projectId?: number, signal?: AbortSignal): Promise<Ticket[]> {
  const url = projectId
    ? `/api/tickets?${new URLSearchParams({ projectId: String(projectId) }).toString()}`
    : '/api/tickets'
  const res = await fetch(url, { signal })
  await throwIfNotOk(res, 'Failed to fetch tickets')
  return normalizeTicketListResponse(await res.json())
}

async function fetchTicket(id: string, signal?: AbortSignal): Promise<Ticket> {
  const res = await fetch(apiTicketPath(id), { signal })
  await throwIfNotOk(res, 'Failed to fetch ticket')
  return normalizeTicketResponse(await res.json())
}

async function createTicket(input: CreateTicketInput): Promise<Ticket> {
  const res = await fetch('/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  await throwIfNotOk(res, 'Failed to create ticket')
  return normalizeTicketResponse(await res.json())
}

type UpdateTicketInput = Partial<Pick<
  Ticket,
  'title' | 'description' | 'priority' | 'manualQaOverride' | 'aiQuestionsOverride' | 'aiQuestionWindowOverride'
>>

async function updateTicket(id: string, input: UpdateTicketInput): Promise<Ticket> {
  const res = await fetch(apiTicketPath(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  await throwIfNotOk(res, 'Failed to update ticket')
  return normalizeTicketResponse(await res.json())
}

function getTicketActionPath(id: string, action: WorkflowAction): string {
  switch (action) {
    case 'close_unmerged':
      return apiTicketPath(id, 'close-unmerged')
    case 'edit_execution_setup_plan':
      return apiTicketPath(id, 'edit-execution-setup-plan')
    default:
      return apiTicketPath(id, action)
  }
}

/**
 * What an action carries beyond the action itself.
 *
 * Discriminated rather than a bare `note`, because the two payloads mean
 * opposite things: a retry note is forwarded to the agent as an instruction, and
 * a close reason is recorded for people and never reaches a model. A single
 * positional string would let one be sent where the other was meant, with no
 * type error and no runtime failure — just a reason quietly handed to an agent.
 */
export type TicketActionPayload =
  | { kind: 'retry_note'; note: string }
  | { kind: 'close_reason'; reason?: string }

export type TicketActionVariables =
  | { id: string; action: WorkflowAction; payload?: undefined }
  | { id: string; action: 'retry'; payload: { kind: 'retry_note'; note: string } }
  | { id: string; action: 'close_unmerged'; payload: { kind: 'close_reason'; reason?: string } }

function buildTicketActionBody(payload: TicketActionPayload | undefined): string | undefined {
  if (!payload) return undefined
  if (payload.kind === 'retry_note') return JSON.stringify({ note: payload.note })
  return JSON.stringify(payload.reason ? { reason: payload.reason } : {})
}

export async function ticketAction(
  id: string,
  action: WorkflowAction,
  payload?: TicketActionPayload,
): Promise<TicketActionResponse> {
  const body = buildTicketActionBody(payload)
  const res = await fetch(getTicketActionPath(id, action), {
    method: 'POST',
    ...(body !== undefined
      ? {
          headers: { 'Content-Type': 'application/json' },
          body,
        }
      : {}),
  })
  await throwIfNotOk(res, `Failed to ${action} ticket`)
  return res.json()
}

interface CancelTicketOptions {
  deleteContent?: boolean
  deleteLog?: boolean
  deleteTicket?: boolean
  reason?: string
}

async function cancelTicket(id: string, options: CancelTicketOptions = {}): Promise<TicketActionResponse> {
  const res = await fetch(apiTicketPath(id, 'cancel'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deleteContent: options.deleteContent ?? false,
      deleteLog: options.deleteLog ?? false,
      deleteTicket: options.deleteTicket ?? false,
      ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
    }),
  })
  await throwIfNotOk(res, 'Failed to cancel ticket')
  return res.json()
}

async function deleteTicket(id: string): Promise<{ success: boolean; ticketId: string }> {
  const res = await fetch(apiTicketPath(id), { method: 'DELETE' })
  await throwIfNotOk(res, 'Failed to delete ticket')
  return res.json()
}

async function fetchInterview(ticketId: string, signal?: AbortSignal): Promise<InterviewSessionView> {
  const res = await fetch(apiTicketPath(ticketId, 'interview'), { signal })
  await throwIfNotOk(res, 'Failed to fetch interview data')
  return res.json()
}

interface TicketUIStateResponse<T = unknown> {
  scope: string
  exists: boolean
  data: T | null
  updatedAt: string | null
  revision: number
  clientRevision: number | null
  /**
   * The ticket this payload was loaded for. Stamped client-side — the server answers with the
   * scope only, so without it a consumer holding a payload cannot tell whose state it is. A
   * restore effect that applies a payload to whatever ticket is on screen writes one ticket's
   * answers onto another; the gate needs an identity to compare.
   */
  ticketId: string
}

interface SaveTicketUIStateResponse<T = unknown> {
  success?: boolean
  conflict: boolean
  scope: string
  exists?: boolean
  data?: T | null
  updatedAt: string | null
  revision: number
  clientRevision: number | null
}

const uiStateSaveQueues = new Map<string, Promise<SaveTicketUIStateResponse>>()

async function fetchTicketUIState<T = unknown>(
  ticketId: string,
  scope: string,
  signal?: AbortSignal,
): Promise<TicketUIStateResponse<T>> {
  const params = new URLSearchParams({ scope })
  const res = await fetch(`${apiTicketPath(ticketId, 'ui-state')}?${params.toString()}`, { signal })
  await throwIfNotOk(res, 'Failed to fetch ticket UI state')
  const payload = await res.json() as Omit<TicketUIStateResponse<T>, 'ticketId'>
  return { ...payload, ticketId }
}

async function saveTicketUIState(
  ticketId: string,
  scope: string,
  data: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<SaveTicketUIStateResponse> {
  const expectedRevision = getTicketUiStateRevision(ticketId, scope)
  const res = await fetchImpl(apiTicketPath(ticketId, 'ui-state'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope,
      data,
      expectedRevision,
      actionId: createTicketUiStateActionId(),
    }),
  })
  if (res.status === 409) return res.json()
  await throwIfNotOk(res, 'Failed to save ticket UI state')
  return res.json()
}

/**
 * Tickets whose deletion has started.
 *
 * Draining the queue is not enough on its own: the debounced approval autosave
 * can enqueue a *new* save while the drain is awaiting the old one, and that PUT
 * then lands after the DELETE. A ticket named here refuses further saves, so the
 * barrier closes instead of merely emptying.
 */
const closingTickets = new Set<string>()

/** How long the delete waits for a queued save before going ahead without it. */
const UI_STATE_DRAIN_TIMEOUT_MS = 5_000

export function isTicketClosing(ticketId: string): boolean {
  return closingTickets.has(ticketId)
}

function enqueueTicketUIStateSave(
  ticketId: string,
  scope: string,
  data: unknown,
  fetchImpl: typeof fetch,
): Promise<SaveTicketUIStateResponse> {
  const key = `${ticketId}\u0000${scope}`
  const previous = uiStateSaveQueues.get(key)
  const pending = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(() => {
      // Checked here, not at call time: a save queued behind another one can
      // reach the front after the delete has started.
      if (closingTickets.has(ticketId)) throw new Error('Ticket is being deleted')
      return saveTicketUIState(ticketId, scope, data, fetchImpl)
    })
  uiStateSaveQueues.set(key, pending)
  void pending.finally(() => {
    if (uiStateSaveQueues.get(key) === pending) uiStateSaveQueues.delete(key)
  }).catch(() => undefined)
  return pending
}

/**
 * Closes the door on this ticket's queued UI-state saves, then waits them out.
 *
 * A save is enqueued per `ticketId\0scope` and settles well after the keystroke
 * that started it, so deleting first left a PUT in the air for a row that no
 * longer exists. Two things have to be true for that to stop: nothing new may be
 * enqueued (the tombstone), and what is already in flight must finish (the
 * drain).
 *
 * Bounded, because the drain is not worth blocking the delete on: a stalled PUT
 * would otherwise hold the mutation open indefinitely and the DELETE would never
 * be sent. Failures are swallowed — this is a barrier, not a checkpoint.
 */
async function settleTicketUiStateSaves(ticketId: string): Promise<void> {
  closingTickets.add(ticketId)
  const prefix = `${ticketId}\u0000`
  const pending = [...uiStateSaveQueues.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, save]) => save.catch(() => undefined))
  if (pending.length === 0) return

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, UI_STATE_DRAIN_TIMEOUT_MS) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Reopens the door after a delete that did not happen. */
function releaseClosingTicket(ticketId: string): void {
  closingTickets.delete(ticketId)
}

/**
 * True when any part of a query key names this ticket.
 *
 * Object parts are searched one level down as well. Every family today puts the
 * id in directly, but a future `['artifact', { ticketId }]` would slip past a
 * flat comparison — which is the same silent escape the enumerated list this
 * predicate replaced was built to end.
 */
function queryKeyNamesTicket(queryKey: readonly unknown[], ticketId: string): boolean {
  return queryKey.some((part) => {
    if (part === ticketId) return true
    return isRecord(part) && Object.values(part).some((value) => value === ticketId)
  })
}

/**
 * Drops everything cached against one ticket.
 *
 * Matched by predicate rather than by an enumerated list of query families: the
 * enumerated version had grown to six of the twelve families that key on a
 * ticket id, and the six it missed — phase attempts, Manual QA, AI details,
 * ticket beads, bead diffs, and every `['artifact', id, …]` — stayed in memory
 * under an id the server can hand out again. A new family added next release
 * escapes a list silently; it cannot escape this.
 *
 * The ticket *list* queries are untouched: `['tickets']` does not carry a ticket
 * id, and the list is filtered by its own caller.
 *
 * In-flight requests are cancelled before the keys go, so a response that was
 * already on the wire cannot repopulate a deleted ticket.
 */
export async function settleTicketUiStateSavesForDelete(ticketId: string): Promise<void> {
  await settleTicketUiStateSaves(ticketId)
}

export async function clearTicketCaches(queryClient: QueryClient, ticketId: string): Promise<void> {
  const predicate = (query: { queryKey: readonly unknown[] }) => queryKeyNamesTicket(query.queryKey, ticketId)

  await queryClient.cancelQueries({ predicate })
  queryClient.removeQueries({ predicate })

  // Module-scope stores, which no query client owns. `clearPersistedTicketLogs`
  // already calls `clearServerLogCache` for this ticket — calling it here too
  // would be the second clear, and broadening it takes every other open
  // ticket's cache with it.
  clearPersistedTicketLogs(ticketId)
  clearErrorTicketSeen(ticketId)
  clearNeedsInputSeen(ticketId)
  // The revision map only ever climbs, so carrying it past a deletion makes the
  // next ticket issued under the same id send an `expectedRevision` from a
  // ticket that no longer exists — and every one of its autosaves is refused as
  // a conflict.
  clearTicketUiStateRevisions(ticketId)
  closingTickets.delete(ticketId)
}

/**
 * Writes a mutation's answer into the ticket cache.
 *
 * Two shapes, and only one of them applies. When the route returned the whole
 * ticket, that is the truth — including its own `previousStatus` — and a
 * status-only patch on top would overwrite it with one derived here. When it
 * returned a status alone, `previousStatus` is set from what the cache currently
 * holds, which is what `useSSE` already does for a `state_change`: without it,
 * every surface that explains *what* failed (the error view's setup detection,
 * `isBeforeExecution`) reads a `previousStatus` left over from an earlier
 * transition.
 */
function applyTicketActionResult(
  queryClient: QueryClient,
  ticketId: string,
  result: TicketActionResponse,
): void {
  const incomingTicket = normalizeTicketPatch(result.ticket)
  if (incomingTicket) {
    mergeTicketInCache<Ticket>(queryClient, incomingTicket)
    return
  }

  const nextStatus = result.state ?? result.status
  if (!nextStatus) return

  // The detail entry first, then any list that holds the ticket: a board action
  // fires without the detail query ever having been mounted, and reading only
  // the detail cache there left `previousStatus` stale.
  const cachedStatus = queryClient.getQueryData<Ticket>(['ticket', ticketId])?.status
    ?? queryClient.getQueriesData<Ticket[]>({ queryKey: ['tickets'] })
      .flatMap(([, tickets]) => tickets ?? [])
      .find((ticket) => ticket.id === ticketId)?.status
  patchTicketStatusInCache<Ticket>(
    queryClient,
    ticketId,
    nextStatus,
    cachedStatus && cachedStatus !== nextStatus ? cachedStatus : undefined,
  )
}

export function useTickets(projectId?: number) {
  return useQuery({
    queryKey: projectId ? ['tickets', { projectId }] : ['tickets'],
    queryFn: ({ signal }) => fetchTickets(projectId, signal),
    refetchInterval: (query) => getTicketsAutoRefreshInterval(query.state.data as Ticket[] | undefined),
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  })
}

export function useTicket(id: string | null) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: ['ticket', id],
    queryFn: ({ signal }) => fetchTicket(id!, signal),
    enabled: id !== null,
    initialData: () => {
      const allTicketLists = queryClient.getQueriesData<Ticket[]>({ queryKey: ['tickets'] })
      for (const [, tickets] of allTicketLists) {
        const ticket = tickets?.find(t => t.id === id)
        if (ticket) return ticket
      }
      return undefined
    },
    refetchInterval: (query) => getTicketAutoRefreshInterval(query.state.data as Ticket | undefined),
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  })
}

export function useCreateTicket() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createTicket,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tickets'] })
    },
  })
}

export function useUpdateTicket() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & UpdateTicketInput) =>
      updateTicket(id, input),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', variables.id] })
      queryClient.invalidateQueries({ queryKey: ['ticket-skips', variables.id] })
    },
  })
}

export function useTicketAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action, payload }: TicketActionVariables) =>
      ticketAction(id, action, payload),
    onSuccess: (result, variables) => {
      applyTicketActionResult(queryClient, result.ticketId || variables.id, result)

      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', variables.id] })
      queryClient.invalidateQueries({ queryKey: ['ticket-skips', variables.id] })
    },
  })
}

export function useCancelTicket() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, options }: { id: string; options?: CancelTicketOptions }) => {
      // The cancel dialog's "also delete the ticket" really deletes the row, so
      // this request needs the same barrier the delete mutation has.
      if (!options?.deleteTicket) return cancelTicket(id, options)

      await settleTicketUiStateSaves(id)
      try {
        return await cancelTicket(id, options)
      } catch (error) {
        releaseClosingTicket(id)
        throw error
      }
    },
    onSuccess: async (result, variables) => {
      const ticketId = result.ticketId || variables.id

      if (variables.options?.deleteTicket) {
        // A deleting cancel answers `{ success, ticketId }` and nothing else, so
        // `applyTicketActionResult` has nothing to apply. Without this the
        // ticket's phase attempts, Manual QA rounds, artifacts, bead diffs, logs
        // and UI state all stayed cached under an id the server can reissue.
        queryClient.setQueriesData<Ticket[]>({ queryKey: ['tickets'] }, (tickets) =>
          tickets?.filter(ticket => ticket.id !== ticketId) ?? tickets,
        )
        await clearTicketCaches(queryClient, ticketId)
        queryClient.invalidateQueries({ queryKey: ['tickets'] })
        return
      }

      applyTicketActionResult(queryClient, ticketId, result)

      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', variables.id] })
      queryClient.invalidateQueries({ queryKey: ['ticket-skips', variables.id] })
    },
  })
}

export function useDeleteTicket() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (ticketId: string) => {
      // Before the DELETE, not after: a queued panel save otherwise reaches the
      // server for a ticket row that is already gone.
      await settleTicketUiStateSaves(ticketId)
      try {
        return await deleteTicket(ticketId)
      } catch (error) {
        // The ticket is still there, so its panels may save again.
        releaseClosingTicket(ticketId)
        throw error
      }
    },
    onSuccess: async (_, ticketId) => {
      queryClient.setQueriesData<Ticket[]>({ queryKey: ['tickets'] }, (tickets) =>
        tickets?.filter(ticket => ticket.id !== ticketId) ?? tickets,
      )
      await clearTicketCaches(queryClient, ticketId)
      queryClient.invalidateQueries({ queryKey: ['tickets'] })
    },
  })
}

/**
 * The interview session for a ticket.
 *
 * `enabled` defaults to "there is a ticket", which is what the three interview
 * surfaces want. The read-only approval view is the exception: it renders PRD
 * and beads attempts too, and asking `/interview` for those both costs a request
 * and puts an interview failure in front of somebody looking at a bead plan.
 */
export function useInterviewQuestions(ticketId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['interview', ticketId],
    queryFn: ({ signal }) => fetchInterview(ticketId, signal),
    enabled: options?.enabled ?? Boolean(ticketId),
  })
}

export function useTicketUIState<T = unknown>(ticketId: string, scope: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ['ticket-ui-state', ticketId, scope],
    // The revision is remembered where the payload is produced, not in `select`.
    // `select` must be pure: it runs per observer and again on every re-render
    // that changes its identity, so StrictMode's extra observer alone was enough
    // to write the module-level revision map twice. A `useEffect` is not the
    // alternative — it runs after the render that already queued a save, which
    // would send the previous revision as `expectedRevision` and lose the write
    // to a false conflict.
    queryFn: async ({ signal }) => {
      const payload = await fetchTicketUIState<T>(ticketId, scope, signal)
      rememberTicketUiStateRevision(ticketId, scope, payload.revision)
      return payload
    },
    enabled,
  })
}

export function useSaveTicketUIState() {
  const queryClient = useQueryClient()
  const fetchImpl = globalThis.fetch
  return useMutation({
    mutationFn: ({ ticketId, scope, data }: { ticketId: string; scope: string; data: unknown }) =>
      enqueueTicketUIStateSave(ticketId, scope, data, fetchImpl),
    onSuccess: (result, variables) => {
      rememberTicketUiStateRevision(variables.ticketId, variables.scope, result.revision)
      if (result.conflict) {
        queryClient.setQueryData<TicketUIStateResponse<unknown>>(
          ['ticket-ui-state', variables.ticketId, variables.scope],
          {
            scope: variables.scope,
            exists: result.exists ?? result.updatedAt !== null,
            data: result.data ?? null,
            updatedAt: result.updatedAt,
            revision: result.revision,
            clientRevision: result.revision,
            ticketId: variables.ticketId,
          },
        )
        return
      }
      queryClient.setQueryData<TicketUIStateResponse<unknown>>(
        ['ticket-ui-state', variables.ticketId, variables.scope],
        () => ({
          scope: variables.scope,
          exists: true,
          data: variables.data,
          updatedAt: result.updatedAt,
          revision: result.revision,
          clientRevision: result.clientRevision,
          ticketId: variables.ticketId,
        }),
      )
    },
  })
}

async function submitBatch(
  ticketId: string,
  answers: Record<string, string>,
  selectedOptions: Record<string, string[]> = {},
  skipReasons: Record<string, string> = {},
): Promise<PersistedInterviewBatch | { accepted: boolean }> {
  const res = await fetch(apiTicketPath(ticketId, 'answer-batch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers, selectedOptions, skipReasons }),
  })
  await throwIfNotOk(res, 'Failed to submit batch')
  return res.json()
}

async function editInterviewAnswer(
  ticketId: string,
  questionId: string,
  answer: string,
): Promise<{ success: boolean; questions: unknown[] }> {
  const res = await fetch(apiTicketPath(ticketId, 'edit-answer'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId, answer }),
  })
  await throwIfNotOk(res, 'Failed to edit answer')
  return res.json()
}

async function skipInterview(
  ticketId: string,
  answers: Record<string, string>,
  selectedOptions: Record<string, string[]> = {},
  skipReasons: Record<string, string> = {},
  bulkSkipReason?: string,
): Promise<TicketActionResponse> {
  const res = await fetch(apiTicketPath(ticketId, 'skip'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      answers,
      selectedOptions,
      skipReasons,
      ...(bulkSkipReason ? { bulkSkipReason } : {}),
    }),
  })
  await throwIfNotOk(res, 'Failed to skip remaining interview questions')
  return res.json()
}

export function useSubmitBatch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ ticketId, answers, selectedOptions, skipReasons }: {
      ticketId: string
      answers: Record<string, string>
      selectedOptions?: Record<string, string[]>
      skipReasons?: Record<string, string>
    }) => submitBatch(ticketId, answers, selectedOptions ?? {}, skipReasons ?? {}),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', variables.ticketId] })
      queryClient.invalidateQueries({ queryKey: ['interview', variables.ticketId] })
      queryClient.invalidateQueries({ queryKey: ['ticket-skips', variables.ticketId] })
    },
  })
}

export function useEditInterviewAnswer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ ticketId, questionId, answer }: { ticketId: string; questionId: string; answer: string }) =>
      editInterviewAnswer(ticketId, questionId, answer),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['interview', variables.ticketId] })
      queryClient.invalidateQueries({ queryKey: ['ticket-skips', variables.ticketId] })
    },
  })
}

export function useSkipInterview() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ ticketId, answers, selectedOptions, skipReasons, bulkSkipReason }: {
      ticketId: string
      answers: Record<string, string>
      selectedOptions?: Record<string, string[]>
      skipReasons?: Record<string, string>
      bulkSkipReason?: string
    }) => skipInterview(ticketId, answers, selectedOptions ?? {}, skipReasons ?? {}, bulkSkipReason),
    onSuccess: (result, variables) => {
      applyTicketActionResult(queryClient, result.ticketId || variables.ticketId, result)

      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', variables.ticketId] })
      queryClient.invalidateQueries({ queryKey: ['interview', variables.ticketId] })
      queryClient.invalidateQueries({ queryKey: ['ticket-skips', variables.ticketId] })
    },
  })
}

export type { CreateTicketInput, InterviewSessionSnapshot, InterviewSessionView, TicketUIStateResponse, PersistedInterviewBatch }
