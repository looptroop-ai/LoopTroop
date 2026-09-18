import type {
  ManualQaBeadOrigin,
  ManualQaOriginEvidenceRef,
  ManualQaOriginSourceItem,
  Ticket,
} from '@/hooks/useTickets'
import { isRecord } from '@shared/typeGuards'
import { isWorkflowAction } from '@shared/workflowMeta'
import { isGitHookPolicy } from '@shared/gitHookPolicy'

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
function normalizeOccurrenceId(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

function normalizeErrorOccurrenceIds(
  raw: Record<string, unknown>,
  preserveInvalidActive = true,
): Pick<Ticket, 'errorOccurrences' | 'activeErrorOccurrenceId'> {
  const rawOccurrences = Array.isArray(raw.errorOccurrences) ? raw.errorOccurrences : null
  const activeId = normalizeOccurrenceId(raw.activeErrorOccurrenceId)
  const errorOccurrences = (rawOccurrences ?? []).flatMap((occurrence) => {
    if (!isRecord(occurrence)) return []
    const id = normalizeOccurrenceId(occurrence.id)
    return id === null ? [] : [{ ...occurrence, id }]
  }) as NonNullable<Ticket['errorOccurrences']>

  return {
    ...(rawOccurrences && (errorOccurrences.length > 0 || rawOccurrences.length === 0)
      ? {
          errorOccurrences,
        }
      : {}),
    ...('activeErrorOccurrenceId' in raw
      ? raw.activeErrorOccurrenceId === null
        ? { activeErrorOccurrenceId: null }
        : activeId !== null || preserveInvalidActive
          ? { activeErrorOccurrenceId: activeId }
          : {}
      : {}),
  }
}

function normalizeTicketForRender(ticket: Ticket | RawTicketResponse): Ticket {
  const raw = asRawTicket(ticket)
  const cleanup = isRecord(raw.cleanup) ? raw.cleanup : null
  const normalized = { ...(ticket as Ticket) }
  if ('errorOccurrences' in raw) delete normalized.errorOccurrences
  if ('activeErrorOccurrenceId' in raw) delete normalized.activeErrorOccurrenceId

  return {
    ...normalized,
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
  return {
    ...normalizeTicketForRender(payload as unknown as RawTicketResponse),
    ...normalizeRequiredScalars(payload),
  }
}

/**
 * The scalars every surface indexes without guarding.
 *
 * `id` and `status` throw, because a ticket without either cannot be addressed
 * or rendered at all. These do not: a missing `title` should cost the ticket its
 * title, not the whole board. Both halves of that trade-off are deliberate — a
 * boundary that rejects the payload wholesale turns one drifted field into a
 * blank screen, and one that trusts it turns a number into `undefined.trim()`
 * three components away.
 */
function normalizeRequiredScalars(raw: Record<string, unknown>): Partial<Ticket> {
  return {
    externalId: stringOrFallback(raw.externalId, typeof raw.id === 'string' ? raw.id : ''),
    projectId: numberOrFallback(raw.projectId, 0),
    title: stringOrFallback(raw.title, 'Untitled ticket'),
    priority: numberOrFallback(raw.priority, 0),
    createdAt: stringOrFallback(raw.createdAt, ''),
    updatedAt: stringOrFallback(raw.updatedAt, ''),
    implementationTiming: normalizeImplementationTiming(raw.implementationTiming),
  }
}

function normalizeImplementationTiming(value: unknown): Ticket['implementationTiming'] {
  const raw = isRecord(value) ? value : {}
  return {
    activeDurationMs: numberOrFallback(raw.activeDurationMs, 0),
    startedAt: nullableString(raw.startedAt),
    lastPlannedBeadFinishedAt: nullableString(raw.lastPlannedBeadFinishedAt),
    manualQaFixDurationMs: numberOrFallback(raw.manualQaFixDurationMs, 0),
    manualQaFixStartedAt: nullableString(raw.manualQaFixStartedAt),
    workspacePreparationDurationMs: numberOrFallback(raw.workspacePreparationDurationMs, 0),
    workspacePreparationStartedAt: nullableString(raw.workspacePreparationStartedAt),
    finalTestingDurationMs: numberOrFallback(raw.finalTestingDurationMs, 0),
    finalTestingStartedAt: nullableString(raw.finalTestingStartedAt),
    questionWaitingMs: numberOrFallback(raw.questionWaitingMs, 0),
  }
}

export function normalizeTicketListResponse(payload: unknown): Ticket[] {
  if (!Array.isArray(payload)) throw new Error('Ticket list response was not an array')
  const tickets: Ticket[] = []
  payload.forEach((entry, index) => {
    try {
      tickets.push(normalizeTicketResponse(entry))
    } catch (error) {
      console.warn(`Skipping malformed ticket at index ${index}`, error)
    }
  })
  return tickets
}

/** A ticket patch: only what the response carried, with partial nested objects. */
export type TicketPatch =
  Partial<Omit<Ticket, 'runtime' | 'implementationTiming' | 'pendingQuestions' | 'manualQa'>> & {
    id: string
    runtime?: Partial<TicketRuntime> & { beadsDiagnostics?: Record<string, unknown> | null }
    implementationTiming?: Partial<Ticket['implementationTiming']>
    pendingQuestions?: Partial<NonNullable<Ticket['pendingQuestions']>> | null
    manualQa?: Partial<NonNullable<Ticket['manualQa']>>
  }

/**
 * The runtime fields a response actually carried, normalised, and no others.
 *
 * `getTicketRuntime` always answers with a *complete* runtime — that is what
 * makes it right for a read. Using it for a patch pushed the same defaults the
 * patch design exists to avoid one level down: a response carrying
 * `runtime: { totalBeads }` would replace the cached runtime wholesale and blank
 * the bead list, the PR state and the ETA until the follow-up refetch landed.
 */
function normalizeRuntimePatch(rawRuntime: Record<string, unknown>): Partial<TicketRuntime> {
  const patch: Record<string, unknown> = {}
  for (const key of ['baseBranch', 'artifactRoot'] as const) {
    if (typeof rawRuntime[key] === 'string') patch[key] = rawRuntime[key]
  }
  for (const key of ['activeBeadId', 'lastFailedBeadId', 'candidateCommitSha', 'preSquashHead'] as const) {
    if (rawRuntime[key] === null || typeof rawRuntime[key] === 'string') patch[key] = rawRuntime[key]
  }
  for (const key of ['prUrl', 'prHeadSha'] as const) {
    if (rawRuntime[key] === null || typeof rawRuntime[key] === 'string') patch[key] = rawRuntime[key]
  }
  for (const key of ['currentBead', 'completedBeads', 'totalBeads', 'percentComplete', 'iterationCount'] as const) {
    copyPatchNumber(rawRuntime, patch, key)
  }
  for (const key of ['maxIterations', 'maxIterationsPerBead', 'perIterationTimeoutMs', 'executionSetupTimeoutMs', 'activeBeadIteration', 'prNumber'] as const) {
    copyPatchNullableNumber(rawRuntime, patch, key)
  }
  if (Array.isArray(rawRuntime.beads)) patch.beads = normalizeRuntimeBeads(rawRuntime.beads)
  if (rawRuntime.finalTestStatus === 'passed' || rawRuntime.finalTestStatus === 'failed' || rawRuntime.finalTestStatus === 'pending') {
    patch.finalTestStatus = rawRuntime.finalTestStatus
  }
  if (Object.hasOwn(rawRuntime, 'prState')) {
    if (rawRuntime.prState === null || rawRuntime.prState === 'draft' || rawRuntime.prState === 'open'
      || rawRuntime.prState === 'merged' || rawRuntime.prState === 'closed') {
      patch.prState = rawRuntime.prState
    }
  }
  if (Object.hasOwn(rawRuntime, 'eta')) {
    const eta = normalizeRuntimeEtaPatch(rawRuntime.eta)
    if (eta !== undefined) patch.eta = eta
  }
  // PR165 adds this optional diagnostic object to the runtime. Keep its error
  // string when that cross-PR shape is present, even while this branch is
  // merged independently from the runtime type change.
  const rawBeadsDiagnostics = rawRuntime.beadsDiagnostics
  if (rawBeadsDiagnostics === null) {
    (patch as Record<string, unknown>).beadsDiagnostics = null
  } else if (isRecord(rawBeadsDiagnostics)) {
    const numberList = (value: unknown): number[] | null => {
      if (!Array.isArray(value)) return null
      const values = value.filter((entry): entry is number => typeof entry === 'number' && Number.isInteger(entry) && entry >= 0)
      return values.length === value.length ? values : null
    }
    const diagnostics: Record<string, unknown> = {}
    const malformedLines = numberList(rawBeadsDiagnostics.malformedLines)
    const unrepresentableLines = numberList(rawBeadsDiagnostics.unrepresentableLines)
    if (malformedLines) diagnostics.malformedLines = malformedLines
    if (unrepresentableLines) diagnostics.unrepresentableLines = unrepresentableLines
    if (typeof rawBeadsDiagnostics.readError === 'string') diagnostics.readError = rawBeadsDiagnostics.readError
    if (Object.keys(diagnostics).length > 0) patch.beadsDiagnostics = diagnostics
  }
  return patch
}

function normalizeRuntimeEtaPatch(value: unknown): TicketRuntime['eta'] | Partial<NonNullable<TicketRuntime['eta']>> | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const patch: Record<string, unknown> = {}
  for (const key of ['bestMs', 'likelyMs', 'worstMs'] as const) copyPatchNumber(value, patch, key)
  if (value.basis === 'history' || value.basis === 'current' || value.basis === 'default') patch.basis = value.basis
  return Object.keys(patch).length > 0 ? patch as Partial<NonNullable<TicketRuntime['eta']>> : undefined
}

function copyPatchString(raw: Record<string, unknown>, patch: Record<string, unknown>, key: string): void {
  if (typeof raw[key] === 'string') patch[key] = raw[key]
}

function copyPatchNullableString(raw: Record<string, unknown>, patch: Record<string, unknown>, key: string): void {
  if (raw[key] === null || typeof raw[key] === 'string') patch[key] = raw[key]
}

function copyPatchNumber(raw: Record<string, unknown>, patch: Record<string, unknown>, key: string): void {
  if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) patch[key] = raw[key]
}

function copyPatchNullableNumber(raw: Record<string, unknown>, patch: Record<string, unknown>, key: string): void {
  if (raw[key] === null || (typeof raw[key] === 'number' && Number.isFinite(raw[key]))) patch[key] = raw[key]
}

function copyPatchBoolean(raw: Record<string, unknown>, patch: Record<string, unknown>, key: string): void {
  if (typeof raw[key] === 'boolean') patch[key] = raw[key]
}

function normalizeImplementationTimingPatch(value: Record<string, unknown>): Partial<Ticket['implementationTiming']> | undefined {
  const patch: Record<string, unknown> = {}
  for (const key of ['activeDurationMs', 'manualQaFixDurationMs', 'workspacePreparationDurationMs', 'finalTestingDurationMs', 'questionWaitingMs']) {
    copyPatchNumber(value, patch, key)
  }
  for (const key of ['startedAt', 'lastPlannedBeadFinishedAt', 'manualQaFixStartedAt', 'workspacePreparationStartedAt', 'finalTestingStartedAt']) {
    copyPatchNullableString(value, patch, key)
  }
  return Object.keys(patch).length > 0 ? patch as Partial<Ticket['implementationTiming']> : undefined
}

function normalizePendingQuestions(value: unknown): TicketPatch['pendingQuestions'] | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const patch: Record<string, unknown> = {}
  for (const key of ['requestCount', 'questionCount']) copyPatchNumber(value, patch, key)
  for (const key of ['deadlineAt', 'stoppedAt']) copyPatchNullableString(value, patch, key)
  if (Array.isArray(value.requestIds) && value.requestIds.every((requestId) => typeof requestId === 'string')) {
    patch.requestIds = value.requestIds
  }
  return Object.keys(patch).length > 0 ? patch as TicketPatch['pendingQuestions'] : undefined
}

function normalizeManualQa(value: unknown): TicketPatch['manualQa'] | undefined {
  if (!isRecord(value)) return undefined
  const patch: Record<string, unknown> = {}
  if (Object.hasOwn(value, 'activeVersion')) copyPatchNullableNumber(value, patch, 'activeVersion')
  copyPatchNumber(value, patch, 'completedRoundCount')
  if (value.latestOutcome === null || value.latestOutcome === 'passed'
    || value.latestOutcome === 'waived_through' || value.latestOutcome === 'skipped'
    || value.latestOutcome === 'failed' || value.latestOutcome === 'created_fixes') {
    patch.latestOutcome = value.latestOutcome
  }
  if (isRecord(value.artifactAvailability)) {
    const availability: Record<string, boolean> = {}
    for (const key of ['checklist', 'results', 'coverage', 'summary']) {
      if (typeof value.artifactAvailability[key] === 'boolean') availability[key] = value.artifactAvailability[key]
    }
    if (Object.keys(availability).length > 0) patch.artifactAvailability = availability
  }
  return Object.keys(patch).length > 0 ? patch as TicketPatch['manualQa'] : undefined
}

function normalizeManualQaOrigin(value: unknown): Ticket['manualQaOrigin'] | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const sourceTicketId = nullableString(value.sourceTicketId)
  const sourceTicketExternalId = nullableString(value.sourceTicketExternalId)
  const originId = nullableString(value.originId)
  const actionId = nullableString(value.actionId)
  const sourceProjectId = nullableNumber(value.sourceProjectId)
  const sourceVersion = nullableNumber(value.sourceVersion)
  if (value.schemaVersion !== 1 || value.source !== 'manual_qa_improvement'
    || !sourceTicketId || !sourceTicketExternalId || !originId || !actionId
    || sourceProjectId === null || !Number.isInteger(sourceProjectId) || sourceProjectId < 1
    || sourceVersion === null || !Number.isInteger(sourceVersion) || sourceVersion < 1) {
    return undefined
  }
  const sourceItemIds = stringList(value.sourceItemIds)
  const sourceItemTitles = stringList(value.sourceItemTitles)
  if (sourceItemIds.length === 0 || sourceItemTitles.length === 0) return undefined
  const evidenceRefs = normalizeEvidenceRefs(value.evidenceRefs)
  const omittedEvidence = Array.isArray(value.omittedEvidence)
    ? value.omittedEvidence
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .filter((entry) => typeof entry.id === 'string' && typeof entry.reason === 'string')
      .map((entry) => ({ id: entry.id as string, reason: entry.reason as string }))
    : []
  if (value.resultType !== 'improvement') return undefined
  const imageEvidenceMode = value.imageEvidenceMode
  if (imageEvidenceMode !== 'attached' && imageEvidenceMode !== 'references_only') return undefined
  if (typeof value.createdAt !== 'string') return undefined
  return {
    schemaVersion: 1,
    source: 'manual_qa_improvement',
    originId,
    actionId,
    sourceTicketId,
    sourceTicketExternalId,
    sourceProjectId,
    sourceVersion,
    sourceItemIds,
    sourceItemTitles,
    resultType: 'improvement',
    relatedPrdRefs: stringList(value.relatedPrdRefs),
    relatedBeadRefs: stringList(value.relatedBeadRefs),
    evidenceRefs,
    omittedEvidence,
    titleSha256: stringOrFallback(value.titleSha256, ''),
    descriptionSha256: stringOrFallback(value.descriptionSha256, ''),
    omittedFields: stringList(value.omittedFields),
    imageEvidenceMode,
    createdAt: value.createdAt,
  }
}

function normalizePatchScalars(raw: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const key of ['externalId', 'title', 'createdAt', 'updatedAt']) copyPatchString(raw, patch, key)
  if (typeof raw.status === 'string' && raw.status.length > 0) patch.status = raw.status
  for (const key of ['description', 'xstateSnapshot', 'branchName', 'errorMessage', 'cancelReason', 'errorSeenSignature', 'needsInputSeenSignature', 'previousStatus', 'reviewCutoffStatus', 'startedAt', 'plannedDate', 'lockedMainImplementer', 'lockedMainImplementerVariant']) {
    copyPatchNullableString(raw, patch, key)
  }
  for (const key of ['projectId', 'priority', 'workflowRevision']) copyPatchNumber(raw, patch, key)
  for (const key of ['currentBead', 'totalBeads', 'percentComplete', 'aiQuestionWindowOverride', 'lockedInterviewQuestions', 'lockedCoverageFollowUpBudgetPercent', 'lockedMaxCoveragePasses', 'lockedMaxPrdCoveragePasses', 'lockedMaxBeadsCoveragePasses', 'lockedStructuredRetryCount']) {
    copyPatchNullableNumber(raw, patch, key)
  }
  for (const key of ['isDisplayOnlyMock', 'hasPastErrors', 'manualQaOverride', 'aiQuestionsOverride']) copyPatchBoolean(raw, patch, key)
  if (raw.completionDisposition === null || raw.completionDisposition === 'merged' || raw.completionDisposition === 'closed_unmerged') {
    patch.completionDisposition = raw.completionDisposition
  }
  if (isRecord(raw.implementationTiming)) {
    const implementationTiming = normalizeImplementationTimingPatch(raw.implementationTiming)
    if (implementationTiming) patch.implementationTiming = implementationTiming
  }
  if (Array.isArray(raw.visitedStatuses) && raw.visitedStatuses.every((value) => typeof value === 'string')) {
    patch.visitedStatuses = raw.visitedStatuses
  }
  if (Object.hasOwn(raw, 'pendingQuestions')) {
    const pendingQuestions = normalizePendingQuestions(raw.pendingQuestions)
    if (pendingQuestions !== undefined) patch.pendingQuestions = pendingQuestions
  }
  if (Object.hasOwn(raw, 'manualQa')) {
    const manualQa = normalizeManualQa(raw.manualQa)
    if (manualQa !== undefined) patch.manualQa = manualQa
  }
  if (Object.hasOwn(raw, 'manualQaOrigin')) {
    const manualQaOrigin = normalizeManualQaOrigin(raw.manualQaOrigin)
    if (manualQaOrigin !== undefined) patch.manualQaOrigin = manualQaOrigin
  }
  for (const key of ['effectiveGitHookPolicy', 'lockedGitHookPolicy']) {
    if (raw[key] === null && key === 'lockedGitHookPolicy') patch[key] = null
    else if (isGitHookPolicy(raw[key])) patch[key] = raw[key]
  }
  for (const key of ['effectiveGitHookPolicySource', 'lockedGitHookPolicySource', 'effectiveManualQaSource', 'lockedManualQaSource', 'effectiveAiQuestionsSource', 'effectiveAiQuestionWindowSource']) {
    if (raw[key] === null && key.startsWith('locked')) patch[key] = null
    else if (raw[key] === 'profile' || raw[key] === 'project' || raw[key] === 'ticket') patch[key] = raw[key]
  }
  if (raw.effectiveManualQaEnabled === true || raw.effectiveManualQaEnabled === false) patch.effectiveManualQaEnabled = raw.effectiveManualQaEnabled
  if (raw.lockedManualQaEnabled === null || raw.lockedManualQaEnabled === true || raw.lockedManualQaEnabled === false) patch.lockedManualQaEnabled = raw.lockedManualQaEnabled
  if (raw.effectiveAiQuestionsEnabled === true || raw.effectiveAiQuestionsEnabled === false) patch.effectiveAiQuestionsEnabled = raw.effectiveAiQuestionsEnabled
  if (raw.effectiveAiQuestionWindow !== undefined) copyPatchNumber(raw, patch, 'effectiveAiQuestionWindow')
  if (Object.hasOwn(raw, 'lockedCouncilMemberVariants')) {
    if (raw.lockedCouncilMemberVariants === null) patch.lockedCouncilMemberVariants = null
    else if (isRecord(raw.lockedCouncilMemberVariants)) {
      const variants = Object.fromEntries(Object.entries(raw.lockedCouncilMemberVariants).filter(([, variant]) => typeof variant === 'string'))
      if (Object.keys(variants).length > 0 || Object.keys(raw.lockedCouncilMemberVariants).length === 0) {
        patch.lockedCouncilMemberVariants = variants
      }
    }
  }
  return patch
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
export function normalizeTicketPatch(payload: unknown): TicketPatch | null {
  if (!isRecord(payload)) return null
  if (typeof payload.id !== 'string' || payload.id.length === 0) return null

  const raw = payload
  const cleanup = isRecord(raw.cleanup) ? raw.cleanup : null
  const rawAvailableActions = Array.isArray(raw.availableActions) ? raw.availableActions : null
  const rawLockedCouncilMembers = Array.isArray(raw.lockedCouncilMembers) ? raw.lockedCouncilMembers : null
  const availableActions = rawAvailableActions
    ? getTicketAvailableActions(raw as unknown as RawTicketResponse)
    : null
  const lockedCouncilMembers = rawLockedCouncilMembers
    ? getTicketCouncilMembers(raw as unknown as RawTicketResponse)
    : null

  const patch: Record<string, unknown> = {
    id: payload.id,
    ...normalizePatchScalars(raw),
    ...(isRecord(raw.runtime) ? { runtime: normalizeRuntimePatch(raw.runtime) } : {}),
    ...(availableActions && (availableActions.length > 0 || rawAvailableActions?.length === 0)
      ? { availableActions }
      : {}),
    ...(lockedCouncilMembers && (lockedCouncilMembers.length > 0 || rawLockedCouncilMembers?.length === 0)
      ? { lockedCouncilMembers }
      : {}),
    ...normalizeErrorOccurrenceIds(raw, false),
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

  return patch as TicketPatch
}
