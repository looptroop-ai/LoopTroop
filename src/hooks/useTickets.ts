import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { clearPersistedTicketLogs } from '@/context/logUtils'
import { clearTicketArtifactsCache } from './useTicketArtifacts'
import { mergeTicketInCache, patchTicketStatusInCache } from './ticketStatusCache'
import { isTerminalWorkflowStatus, type WorkflowAction } from '@shared/workflowMeta'
import type { InterviewSessionSnapshot, InterviewSessionView, PersistedInterviewBatch } from '@shared/interviewSession'
import { clearErrorTicketSeen } from '@/lib/errorTicketSeen'
import { failedResponseError } from '@/lib/fetchError'
import type { TicketErrorOccurrence } from '@/lib/errorOccurrences'
import {
  createTicketUiStateActionId,
  getTicketUiStateRevision,
  rememberTicketUiStateRevision,
} from '@/lib/ticketUiStateRevision'
import type { GitHookPolicy } from '@/lib/executionSetupPlan'
import type { SettingSource } from '@shared/aiQuestions'

async function parseErrorBody(res: Response, fallback: string): Promise<string> {
  let message = fallback
  try {
    const err = await res.json() as { error?: string; message?: string }
    const category = err.error?.trim()
    const detail = err.message?.trim()
    message = category && detail && category !== detail
      ? `${category}: ${detail}`
      : detail || category || message
  } catch {
    // ignore parse failure
  }
  return message
}

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
  ticket?: Ticket
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

async function fetchTickets(projectId?: number): Promise<Ticket[]> {
  const url = projectId ? `/api/tickets?projectId=${projectId}` : '/api/tickets'
  const res = await fetch(url)
  if (!res.ok) throw await failedResponseError(res, 'Failed to fetch tickets')
  return res.json()
}

async function fetchTicket(id: string): Promise<Ticket> {
  const res = await fetch(`/api/tickets/${id}`)
  if (!res.ok) throw await failedResponseError(res, 'Failed to fetch ticket')
  return res.json()
}

async function createTicket(input: CreateTicketInput): Promise<Ticket> {
  const res = await fetch('/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to create ticket'))
  }
  return res.json()
}

type UpdateTicketInput = Partial<Pick<
  Ticket,
  'title' | 'description' | 'priority' | 'manualQaOverride' | 'aiQuestionsOverride' | 'aiQuestionWindowOverride'
>>

async function updateTicket(id: string, input: UpdateTicketInput): Promise<Ticket> {
  const res = await fetch(`/api/tickets/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to update ticket'))
  }
  return res.json()
}

function getTicketActionPath(id: string, action: WorkflowAction): string {
  switch (action) {
    case 'close_unmerged':
      return `/api/tickets/${id}/close-unmerged`
    case 'edit_execution_setup_plan':
      return `/api/tickets/${id}/edit-execution-setup-plan`
    default:
      return `/api/tickets/${id}/${action}`
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
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, `Failed to ${action} ticket`))
  }
  return res.json()
}

interface CancelTicketOptions {
  deleteContent?: boolean
  deleteLog?: boolean
  deleteTicket?: boolean
  reason?: string
}

async function cancelTicket(id: string, options: CancelTicketOptions = {}): Promise<TicketActionResponse> {
  const res = await fetch(`/api/tickets/${id}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deleteContent: options.deleteContent ?? false,
      deleteLog: options.deleteLog ?? false,
      deleteTicket: options.deleteTicket ?? false,
      ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
    }),
  })
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to cancel ticket'))
  }
  return res.json()
}

async function deleteTicket(id: string): Promise<{ success: boolean; ticketId: string }> {
  const res = await fetch(`/api/tickets/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to delete ticket'))
  }
  return res.json()
}

async function fetchInterview(ticketId: string): Promise<InterviewSessionView> {
  const res = await fetch(`/api/tickets/${ticketId}/interview`)
  if (!res.ok) throw new Error('Failed to fetch interview data')
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
): Promise<TicketUIStateResponse<T>> {
  const params = new URLSearchParams({ scope })
  const res = await fetch(`/api/tickets/${ticketId}/ui-state?${params.toString()}`)
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to fetch ticket UI state'))
  }
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
  const res = await fetchImpl(`/api/tickets/${ticketId}/ui-state`, {
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
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to save ticket UI state'))
  }
  return res.json()
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
    .then(() => saveTicketUIState(ticketId, scope, data, fetchImpl))
  uiStateSaveQueues.set(key, pending)
  void pending.finally(() => {
    if (uiStateSaveQueues.get(key) === pending) uiStateSaveQueues.delete(key)
  }).catch(() => undefined)
  return pending
}

export function useTickets(projectId?: number) {
  return useQuery({
    queryKey: projectId ? ['tickets', { projectId }] : ['tickets'],
    queryFn: () => fetchTickets(projectId),
    refetchInterval: (query) => getTicketsAutoRefreshInterval(query.state.data as Ticket[] | undefined),
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  })
}

export function useTicket(id: string | null) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: ['ticket', id],
    queryFn: () => fetchTicket(id!),
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
      if (result.ticket) {
        mergeTicketInCache<Ticket>(queryClient, result.ticket)
      }

      const nextStatus = result.state ?? result.status
      if (nextStatus) {
        const ticketId = result.ticketId || variables.id
        patchTicketStatusInCache<Ticket>(queryClient, ticketId, nextStatus)
      }

      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', variables.id] })
      queryClient.invalidateQueries({ queryKey: ['ticket-skips', variables.id] })
    },
  })
}

export function useCancelTicket() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, options }: { id: string; options?: CancelTicketOptions }) =>
      cancelTicket(id, options),
    onSuccess: (result, variables) => {
      if (result.ticket) {
        mergeTicketInCache<Ticket>(queryClient, result.ticket)
      }

      const nextStatus = result.state ?? result.status
      if (nextStatus) {
        const ticketId = result.ticketId || variables.id
        patchTicketStatusInCache<Ticket>(queryClient, ticketId, nextStatus)
      }

      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', variables.id] })
      queryClient.invalidateQueries({ queryKey: ['ticket-skips', variables.id] })
    },
  })
}

export function useDeleteTicket() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteTicket,
    onSuccess: (_, ticketId) => {
      queryClient.setQueriesData<Ticket[]>({ queryKey: ['tickets'] }, (tickets) =>
        tickets?.filter(ticket => ticket.id !== ticketId) ?? tickets,
      )
      queryClient.removeQueries({ queryKey: ['ticket', ticketId], exact: true })
      queryClient.removeQueries({ queryKey: ['interview', ticketId], exact: true })
      queryClient.removeQueries({ queryKey: ['ticket-ui-state', ticketId] })
      queryClient.invalidateQueries({ queryKey: ['tickets'] })

      clearTicketArtifactsCache(ticketId)
      clearPersistedTicketLogs(ticketId)

      clearErrorTicketSeen(ticketId)
    },
  })
}

export function useInterviewQuestions(ticketId: string) {
  return useQuery({
    queryKey: ['interview', ticketId],
    queryFn: () => fetchInterview(ticketId),
  })
}

export function useTicketUIState<T = unknown>(ticketId: string, scope: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ['ticket-ui-state', ticketId, scope],
    queryFn: () => fetchTicketUIState<T>(ticketId, scope),
    enabled,
    select: (data) => {
      rememberTicketUiStateRevision(ticketId, scope, data.revision)
      return data
    },
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
  const res = await fetch(`/api/tickets/${ticketId}/answer-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers, selectedOptions, skipReasons }),
  })
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to submit batch'))
  }
  return res.json()
}

async function editInterviewAnswer(
  ticketId: string,
  questionId: string,
  answer: string,
): Promise<{ success: boolean; questions: unknown[] }> {
  const res = await fetch(`/api/tickets/${ticketId}/edit-answer`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId, answer }),
  })
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to edit answer'))
  }
  return res.json()
}

async function skipInterview(
  ticketId: string,
  answers: Record<string, string>,
  selectedOptions: Record<string, string[]> = {},
  skipReasons: Record<string, string> = {},
  bulkSkipReason?: string,
): Promise<TicketActionResponse> {
  const res = await fetch(`/api/tickets/${ticketId}/skip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      answers,
      selectedOptions,
      skipReasons,
      ...(bulkSkipReason ? { bulkSkipReason } : {}),
    }),
  })
  if (!res.ok) {
    throw new Error(await parseErrorBody(res, 'Failed to skip remaining interview questions'))
  }
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
      if (result.ticket) {
        mergeTicketInCache<Ticket>(queryClient, result.ticket)
      }

      const nextStatus = result.state ?? result.status
      if (nextStatus) {
        patchTicketStatusInCache<Ticket>(queryClient, variables.ticketId, nextStatus)
      }

      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket', variables.ticketId] })
      queryClient.invalidateQueries({ queryKey: ['interview', variables.ticketId] })
      queryClient.invalidateQueries({ queryKey: ['ticket-skips', variables.ticketId] })
    },
  })
}

export type { CreateTicketInput, InterviewSessionSnapshot, InterviewSessionView, TicketUIStateResponse, PersistedInterviewBatch }
