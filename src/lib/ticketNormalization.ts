import type {
  ManualQaBeadOrigin,
  ManualQaOriginEvidenceRef,
  ManualQaOriginSourceItem,
  Ticket,
} from '@/hooks/useTickets'
import { isRecord } from '@shared/typeGuards'
import { isWorkflowAction } from '@shared/workflowMeta'

type TicketRuntime = Ticket['runtime']

const DEFAULT_TICKET_RUNTIME: TicketRuntime = {
  baseBranch: 'unknown',
  currentBead: 0,
  completedBeads: 0,
  totalBeads: 0,
  percentComplete: 0,
  iterationCount: 0,
  maxIterations: null,
  maxIterationsPerBead: null,
  perIterationTimeoutMs: null,
  executionSetupTimeoutMs: null,
  activeBeadId: null,
  activeBeadIteration: null,
  lastFailedBeadId: null,
  artifactRoot: '',
  beads: [],
  candidateCommitSha: null,
  preSquashHead: null,
  finalTestStatus: 'pending',
  prNumber: null,
  prUrl: null,
  prState: null,
  prHeadSha: null,
  eta: null,
}

const DEFAULT_CLEANUP_SUMMARY: NonNullable<Ticket['cleanup']> = {
  status: null,
  errorCount: 0,
  latestReportArtifactId: null,
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numberOrFallback(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Reads a ticket-shaped payload as a plain record.
 *
 * `Ticket` is a view model, not the wire shape, so every reader here has to go
 * through `unknown` first. Doing it once behind the guard is the difference
 * between one cast and the five that used to be spread through this file.
 */
function asRawTicket(ticket: Ticket | RawTicketResponse): Record<string, unknown> {
  const raw = ticket as unknown
  return isRecord(raw) ? raw : {}
}

function normalizeBeadNoteEntries(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => ({
      timestamp: stringOrFallback(entry.timestamp, ''),
      iteration: numberOrFallback(entry.iteration, 0),
      content: stringOrFallback(entry.content, ''),
      ...(typeof entry.errorCode === 'string' ? { errorCode: entry.errorCode } : {}),
    }))
    .filter((entry) => entry.content.trim().length > 0)
}

function normalizeEvidenceRefs(value: unknown): ManualQaOriginEvidenceRef[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .filter((entry) => typeof entry.id === 'string' && entry.id.length > 0)
    .map((entry) => ({
      id: entry.id as string,
      originalName: stringOrFallback(entry.originalName, entry.id as string),
      mediaType: stringOrFallback(entry.mediaType, 'application/octet-stream'),
      size: numberOrFallback(entry.size, 0),
      sha256: stringOrFallback(entry.sha256, ''),
      relativePath: stringOrFallback(entry.relativePath, ''),
    }))
}

function normalizeOriginLinks(value: unknown): ManualQaOriginSourceItem['links'] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .filter((entry) => typeof entry.id === 'string' && typeof entry.url === 'string')
    .map((entry) => ({
      id: entry.id as string,
      url: entry.url as string,
      ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
    }))
}

function normalizeOriginSourceItems(value: unknown): ManualQaOriginSourceItem[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .filter((entry) => typeof entry.itemId === 'string' && entry.itemId.length > 0)
    .map((entry) => ({
      itemId: entry.itemId as string,
      lineageId: stringOrFallback(entry.lineageId, entry.itemId as string),
      behavior: stringOrFallback(entry.behavior, ''),
      observation: stringOrFallback(entry.observation, ''),
      expectedResult: stringOrFallback(entry.expectedResult, ''),
      evidence: normalizeEvidenceRefs(entry.evidence),
      links: normalizeOriginLinks(entry.links),
    }))
}

/**
 * A bead's Manual QA provenance, or `null` when the payload cannot supply one.
 *
 * The origin card indexes into `sourceItems`, `evidence` and `links` without
 * guards and builds an evidence URL from `sourceTicketId` and `version`, so a
 * half-formed origin has to become "no origin" here rather than a crash three
 * components later.
 */
function normalizeManualQaBeadOrigin(value: unknown): ManualQaBeadOrigin | null {
  if (!isRecord(value)) return null
  const sourceTicketId = nullableString(value.sourceTicketId)
  const version = nullableNumber(value.version)
  if (!sourceTicketId || version === null || !Number.isInteger(version) || version < 1) return null

  return {
    schemaVersion: 1,
    actionId: stringOrFallback(value.actionId, ''),
    sourceTicketId,
    sourceTicketExternalId: stringOrFallback(value.sourceTicketExternalId, sourceTicketId),
    version,
    sourceItems: normalizeOriginSourceItems(value.sourceItems),
    ...(value.imageDelivery === 'attached' || value.imageDelivery === 'references_only'
      ? { imageDelivery: value.imageDelivery }
      : {}),
  }
}

function normalizeRuntimeBeads(value: unknown): TicketRuntime['beads'] {
  if (!Array.isArray(value)) return []
  return value
    .filter((bead): bead is Record<string, unknown> => isRecord(bead))
    .map((bead) => ({
      id: stringOrFallback(bead.id, ''),
      title: stringOrFallback(bead.title, 'Untitled'),
      status: stringOrFallback(bead.status, 'pending'),
      iteration: numberOrFallback(bead.iteration, 0),
      failedIterationNotes: normalizeBeadNoteEntries(bead.failedIterationNotes),
      userRetryNotes: normalizeBeadNoteEntries(bead.userRetryNotes),
      finalizationFailureNotes: normalizeBeadNoteEntries(bead.finalizationFailureNotes),
      startedAt: nullableString(bead.startedAt),
      updatedAt: nullableString(bead.updatedAt),
      completedAt: nullableString(bead.completedAt),
      qaOrigin: normalizeManualQaBeadOrigin(bead.qaOrigin),
    }))
    .filter((bead) => bead.id.length > 0)
}

function normalizeRuntimeEta(value: unknown): TicketRuntime['eta'] {
  if (!isRecord(value)) return null
  const bestMs = nullableNumber(value.bestMs)
  const likelyMs = nullableNumber(value.likelyMs)
  const worstMs = nullableNumber(value.worstMs)
  const basis = value.basis
  if (bestMs === null || likelyMs === null || worstMs === null) return null
  if (basis !== 'history' && basis !== 'current' && basis !== 'default') return null
  return { bestMs, likelyMs, worstMs, basis }
}

function getTicketRuntime(ticket: Ticket | RawTicketResponse): TicketRuntime {
  const rawTicket = asRawTicket(ticket)
  const rawRuntime: Record<string, unknown> = isRecord(rawTicket.runtime)
    ? rawTicket.runtime
    : {}
  const fallbackCurrentBead = numberOrFallback(rawTicket.currentBead, DEFAULT_TICKET_RUNTIME.currentBead)
  const fallbackTotalBeads = numberOrFallback(rawTicket.totalBeads, DEFAULT_TICKET_RUNTIME.totalBeads)
  const fallbackPercentComplete = numberOrFallback(
    rawTicket.percentComplete,
    DEFAULT_TICKET_RUNTIME.percentComplete,
  )

  return {
    baseBranch: stringOrFallback(rawRuntime.baseBranch, DEFAULT_TICKET_RUNTIME.baseBranch),
    currentBead: numberOrFallback(rawRuntime.currentBead, fallbackCurrentBead),
    completedBeads: numberOrFallback(rawRuntime.completedBeads, DEFAULT_TICKET_RUNTIME.completedBeads),
    totalBeads: numberOrFallback(rawRuntime.totalBeads, fallbackTotalBeads),
    percentComplete: numberOrFallback(rawRuntime.percentComplete, fallbackPercentComplete),
    iterationCount: numberOrFallback(rawRuntime.iterationCount, DEFAULT_TICKET_RUNTIME.iterationCount),
    maxIterations: nullableNumber(rawRuntime.maxIterations),
    maxIterationsPerBead: nullableNumber(rawRuntime.maxIterationsPerBead),
    perIterationTimeoutMs: nullableNumber(rawRuntime.perIterationTimeoutMs),
    executionSetupTimeoutMs: nullableNumber(rawRuntime.executionSetupTimeoutMs),
    activeBeadId: nullableString(rawRuntime.activeBeadId),
    activeBeadIteration: nullableNumber(rawRuntime.activeBeadIteration),
    lastFailedBeadId: nullableString(rawRuntime.lastFailedBeadId),
    artifactRoot: stringOrFallback(rawRuntime.artifactRoot, DEFAULT_TICKET_RUNTIME.artifactRoot),
    beads: normalizeRuntimeBeads(rawRuntime.beads),
    candidateCommitSha: nullableString(rawRuntime.candidateCommitSha),
    preSquashHead: nullableString(rawRuntime.preSquashHead),
    finalTestStatus: rawRuntime.finalTestStatus === 'passed' || rawRuntime.finalTestStatus === 'failed'
      ? rawRuntime.finalTestStatus
      : DEFAULT_TICKET_RUNTIME.finalTestStatus,
    prNumber: nullableNumber(rawRuntime.prNumber),
    prUrl: nullableString(rawRuntime.prUrl),
    prState: rawRuntime.prState === 'draft'
      || rawRuntime.prState === 'open'
      || rawRuntime.prState === 'merged'
      || rawRuntime.prState === 'closed'
      ? rawRuntime.prState
      : null,
    prHeadSha: nullableString(rawRuntime.prHeadSha),
    eta: normalizeRuntimeEta(rawRuntime.eta),
  }
}

function getTicketCouncilMembers(ticket: Ticket | RawTicketResponse): string[] {
  const rawMembers = asRawTicket(ticket).lockedCouncilMembers
  if (!Array.isArray(rawMembers)) return []
  return rawMembers.filter((memberId): memberId is string => typeof memberId === 'string' && memberId.trim().length > 0)
}

/**
 * The actions the server says this ticket offers, checked against the ones this
 * client knows how to dispatch.
 *
 * An unrecognised value used to be cast straight into `WorkflowAction`, so a
 * server ahead of the client rendered a button whose request no route here can
 * build. Dropping it shows nothing rather than something broken.
 */
function getTicketAvailableActions(ticket: Ticket | RawTicketResponse): Ticket['availableActions'] {
  const rawActions = asRawTicket(ticket).availableActions
  if (!Array.isArray(rawActions)) return []
  return rawActions.filter(isWorkflowAction)
}

/**
 * Error occurrence ids as the view model states them.
 *
 * The server emits them as numbers and every key, comparison and storage
 * signature on this side is a string, so the conversion happens once, here,
 * rather than as a `String(...)` at each reader.
 */
function normalizeErrorOccurrenceIds(raw: Record<string, unknown>): Pick<Ticket, 'errorOccurrences' | 'activeErrorOccurrenceId'> {
  const rawOccurrences = Array.isArray(raw.errorOccurrences) ? raw.errorOccurrences : null
  const activeId = raw.activeErrorOccurrenceId

  return {
    ...(rawOccurrences
      ? {
          errorOccurrences: rawOccurrences
            .filter((occurrence): occurrence is Record<string, unknown> => isRecord(occurrence))
            .map((occurrence) => ({
              ...occurrence,
              ...(occurrence.id != null ? { id: String(occurrence.id) } : {}),
            })) as Ticket['errorOccurrences'],
        }
      : {}),
    ...(activeId != null ? { activeErrorOccurrenceId: String(activeId) } : {}),
  }
}

function normalizeTicketForRender(ticket: Ticket | RawTicketResponse): Ticket {
  const raw = asRawTicket(ticket)
  const cleanup = isRecord(raw.cleanup) ? raw.cleanup : null

  return {
    ...(ticket as Ticket),
    runtime: getTicketRuntime(ticket),
    lockedCouncilMembers: getTicketCouncilMembers(ticket),
    availableActions: getTicketAvailableActions(ticket),
    ...normalizeErrorOccurrenceIds(raw),
    cleanup: {
      status: cleanup?.status === 'clean' || cleanup?.status === 'warning' ? cleanup.status : null,
      errorCount: numberOrFallback(cleanup?.errorCount, DEFAULT_CLEANUP_SUMMARY.errorCount),
      latestReportArtifactId: nullableNumber(cleanup?.latestReportArtifactId),
      errors: stringList(cleanup?.errors),
    },
  }
}

/**
 * What `/api/tickets` actually returns.
 *
 * Deliberately not `Ticket`: the wire carries numeric error-occurrence ids,
 * `availableActions` as plain strings, and a runtime object that may be missing
 * entirely. Declaring it as the view model is what let those differences survive
 * as compensating casts spread across the components that read them.
 */
export interface RawTicketResponse extends Omit<Ticket, 'availableActions' | 'errorOccurrences' | 'activeErrorOccurrenceId' | 'runtime'> {
  availableActions: string[]
  errorOccurrences?: Array<Omit<NonNullable<Ticket['errorOccurrences']>[number], 'id'> & { id: string | number }>
  activeErrorOccurrenceId?: string | number | null
  runtime?: Partial<Ticket['runtime']>
}

/**
 * The one door into the ticket cache.
 *
 * Every read and every write passes through here, so a consumer can rely on
 * `runtime`, `availableActions`, `lockedCouncilMembers` and `cleanup` being
 * present and well-formed instead of compensating for their absence at each use
 * site. A response that is not a ticket at all fails rather than being cast:
 * a TypeScript assertion cannot catch API drift, which is the reason the raw
 * shape above is written down separately.
 */
export function normalizeTicketResponse(payload: unknown): Ticket {
  if (!isRecord(payload)) throw new Error('Ticket response was not an object')
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new Error('Ticket response carried no id')
  }
  if (typeof payload.status !== 'string' || payload.status.length === 0) {
    throw new Error('Ticket response carried no status')
  }
  return normalizeTicketForRender(payload as unknown as RawTicketResponse)
}

export function normalizeTicketListResponse(payload: unknown): Ticket[] {
  if (!Array.isArray(payload)) throw new Error('Ticket list response was not an array')
  return payload.map(normalizeTicketResponse)
}

/**
 * A server ticket on its way *into* the cache, normalised without being completed.
 *
 * Mutation responses carry a ticket that is merged over the cached one, so a key
 * this payload does not have must stay absent: filling `runtime` with defaults
 * here would overwrite a good cached runtime with zeroes the moment a route
 * answered without one. Only the fields actually present are normalised — which
 * is what keeps the rule "nothing reaches the ticket cache without passing the
 * normaliser" true for writes as well as reads.
 */
export function normalizeTicketPatch(payload: unknown): (Partial<Ticket> & { id: string }) | null {
  if (!isRecord(payload)) return null
  if (typeof payload.id !== 'string' || payload.id.length === 0) return null

  const raw = payload
  const cleanup = isRecord(raw.cleanup) ? raw.cleanup : null

  return {
    ...(raw as unknown as Partial<Ticket>),
    id: payload.id,
    ...('runtime' in raw ? { runtime: getTicketRuntime(raw as unknown as RawTicketResponse) } : {}),
    ...('availableActions' in raw
      ? { availableActions: getTicketAvailableActions(raw as unknown as RawTicketResponse) }
      : {}),
    ...('lockedCouncilMembers' in raw
      ? { lockedCouncilMembers: getTicketCouncilMembers(raw as unknown as RawTicketResponse) }
      : {}),
    ...normalizeErrorOccurrenceIds(raw),
    ...(cleanup
      ? {
          cleanup: {
            status: cleanup.status === 'clean' || cleanup.status === 'warning' ? cleanup.status : null,
            errorCount: numberOrFallback(cleanup.errorCount, DEFAULT_CLEANUP_SUMMARY.errorCount),
            latestReportArtifactId: nullableNumber(cleanup.latestReportArtifactId),
            errors: stringList(cleanup.errors),
          },
        }
      : {}),
  }
}
