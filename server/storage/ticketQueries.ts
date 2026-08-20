import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { db as appDb } from '../db/index'
import { PROFILE_DEFAULTS } from '../db/defaults'
import { getProjectContextById, getProjectById, listProjects } from './projects'
import { opencodeSessions, phaseArtifacts, profiles, projects, ticketErrorOccurrences, ticketStatusHistory, tickets } from '../db/schema'
import {
  getTicketAiLogPath,
  getTicketDir,
  getTicketDebugLogPath,
  getTicketExecutionLogPath,
  getTicketExecutionSetupDir,
  getTicketExecutionSetupProfilePath,
  getTicketWorktreePath,
} from './paths'
import { readJsonl } from '../io/jsonl'
import { getAvailableWorkflowActions } from '@shared/workflowMeta'
import { getTicketBeadsPath, resolveTicketBaseBranch } from '../ticket/metadata'
import type { ArtifactSnapshot } from '../sse/eventTypes'
import { EXECUTION_BAND_STATUSES } from '../workflow/executionBand'
import { normalizeBlockedErrorDiagnostics, type BlockedErrorDiagnostics } from '@shared/errorDiagnostics'
import { isContinuableBlockedError } from '../opencode/sessionContinuation'
import { computeEtaRange, type EtaRange } from '../workflow/eta/computeEta'
import type { BeadNoteEntry } from '../phases/beads/types'
import { bucketForBeadCount, getThroughputSamples, getTicketBeadSamples } from './executionTelemetry'
import {
  ManualQaImprovementOriginSchema,
  type ManualQaImprovementOrigin,
} from '../phases/manualQa/types'
import type { QaOrigin } from '../phases/beads/types'
import { isGitHookPolicy } from '../git/hookPolicy'
import type { GitHookPolicy } from '../structuredOutput/types'

type LocalTicketRow = typeof tickets.$inferSelect
type LocalProjectRow = typeof projects.$inferSelect

export const DISPLAY_ONLY_MOCK_BRANCH_NAME = '__looptroop_display_only_mock__'

export function isDisplayOnlyMockTicket(ticket: Pick<LocalTicketRow, 'branchName'>): boolean {
  return ticket.branchName === DISPLAY_ONLY_MOCK_BRANCH_NAME
}

function getDisplayOnlyMockTicketActions(status: string): string[] {
  return status === 'COMPLETED' || status === 'CANCELED' ? [] : ['cancel']
}

const TrimmedNonEmptyStringSchema = z.string().trim().min(1)
const LockedCouncilMembersSchema = z.array(TrimmedNonEmptyStringSchema)
const LockedCouncilMemberVariantsSchema = z.record(z.string(), TrimmedNonEmptyStringSchema).superRefine((value, ctx) => {
  for (const key of Object.keys(value)) {
    if (key.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Council member variant keys must be non-empty strings.',
      })
      return
    }
  }
})
const RuntimeQaOriginSchema: z.ZodType<QaOrigin> = z.object({
  schemaVersion: z.literal(1),
  actionId: TrimmedNonEmptyStringSchema,
  sourceTicketId: TrimmedNonEmptyStringSchema,
  sourceTicketExternalId: TrimmedNonEmptyStringSchema,
  version: z.number().int().positive(),
  modelId: TrimmedNonEmptyStringSchema.nullable(),
  modelSupportsImages: z.boolean().nullable(),
  createdFromManualQaAt: z.string().datetime(),
  sourceItems: z.array(z.object({
    itemId: TrimmedNonEmptyStringSchema,
    lineageId: TrimmedNonEmptyStringSchema,
    behavior: TrimmedNonEmptyStringSchema,
    observation: TrimmedNonEmptyStringSchema,
    expectedResult: TrimmedNonEmptyStringSchema,
    evidence: z.array(z.object({
      id: TrimmedNonEmptyStringSchema,
      originalName: TrimmedNonEmptyStringSchema,
      mediaType: TrimmedNonEmptyStringSchema,
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      relativePath: TrimmedNonEmptyStringSchema,
    }).strict()),
    links: z.array(z.object({
      id: TrimmedNonEmptyStringSchema,
      url: z.string().url().refine((value) => {
        const protocol = new URL(value).protocol
        return protocol === 'http:' || protocol === 'https:'
      }, 'Manual QA evidence links must use HTTP or HTTPS.'),
      label: z.string().optional(),
    }).strict()),
  }).strict()).min(1),
  imageDelivery: z.enum(['attached', 'references_only']).optional(),
}).strict()

function truncateLoggedValue(value: string, maxLength = 200): string {
  const trimmed = value.trim()
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed
}

function warnInvalidDbJson(fieldName: string, raw: string, detail: string): void {
  console.warn(`[tickets] Invalid ${fieldName} JSON in database: ${truncateLoggedValue(raw)} (${detail})`)
}

export type TicketErrorResolutionStatus = 'RETRIED' | 'CONTINUED' | 'CANCELED'

/** An individual error occurrence recorded while a ticket was in BLOCKED_ERROR. */
export interface TicketErrorOccurrence {
  id: number
  ticketId: number
  occurrenceNumber: number
  blockedFromStatus: string
  errorMessage: string | null
  errorCodes: string[]
  diagnostics?: BlockedErrorDiagnostics | null
  occurredAt: string
  resolvedAt: string | null
  resolutionStatus: TicketErrorResolutionStatus | null
  resumedToStatus: string | null
}

export interface TicketImplementationTiming {
  /** Total time the ticket spent on originally planned beads; pauses and Manual QA fix beads are excluded. */
  activeDurationMs: number
  /** First time the ticket entered bead execution. */
  startedAt: string | null
  /** Completion time for the final originally planned bead; Manual QA fix beads do not change it. */
  lastPlannedBeadFinishedAt: string | null
  /** Active coding time attributable to Manual QA fix beads. This is separate from activeDurationMs. */
  manualQaFixDurationMs: number
  /** First time a Manual QA fix bead started. */
  manualQaFixStartedAt: string | null
  /** Total time spent preparing the execution workspace. */
  workspacePreparationDurationMs: number
  /** First time workspace preparation began. */
  workspacePreparationStartedAt: string | null
  /** Total time spent in the automated final-test phase. */
  finalTestingDurationMs: number
  /** First time automated final testing began. */
  finalTestingStartedAt: string | null
}

/** Full public projection of a ticket row, enriched with runtime data, error history, and available actions. */
export interface PublicTicket extends Omit<LocalTicketRow, 'id' | 'lockedCouncilMembers' | 'lockedCouncilMemberVariants' | 'lockedManualQaSource' | 'lockedGitHookPolicy' | 'lockedGitHookPolicySource'> {
  id: string
  projectId: number
  isDisplayOnlyMock: boolean
  lockedCouncilMembers: string[]
  lockedCouncilMemberVariants: Record<string, string> | null
  lockedManualQaSource: 'ticket' | 'project' | 'profile' | null
  effectiveManualQaEnabled: boolean
  effectiveManualQaSource: 'ticket' | 'project' | 'profile'
  lockedGitHookPolicy: GitHookPolicy | null
  lockedGitHookPolicySource: 'project' | 'profile' | null
  effectiveGitHookPolicy: GitHookPolicy
  effectiveGitHookPolicySource: 'project' | 'profile'
  visitedStatuses: string[]
  manualQa: {
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
  manualQaOrigin: ManualQaImprovementOrigin | null
  availableActions: string[]
  previousStatus: string | null
  reviewCutoffStatus: string | null
  errorOccurrences: TicketErrorOccurrence[]
  activeErrorOccurrenceId: number | null
  hasPastErrors: boolean
  errorSeenSignature: string | null
  needsInputSeenSignature: string | null
  implementationTiming: TicketImplementationTiming
  completionDisposition: 'merged' | 'closed_unmerged' | null
  cleanup: {
    status: 'clean' | 'warning' | null
    errorCount: number
    latestReportArtifactId: number | null
    errors: string[]
  }
  runtime: {
    baseBranch: string
    currentBead: number
    completedBeads: number
    totalBeads: number
    percentComplete: number
    iterationCount: number
    maxIterations: number | null
    maxIterationsPerBead: number | null
    perIterationTimeoutMs: number | null
    executionSetupTimeoutMs: number | null
    activeBeadId: string | null
    activeBeadIteration: number | null
    lastFailedBeadId: string | null
    artifactRoot: string
    beads: Array<{
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
      qaOrigin?: QaOrigin | null
    }>
    candidateCommitSha: string | null
    preSquashHead: string | null
    finalTestStatus: 'passed' | 'failed' | 'pending'
    prNumber: number | null
    prUrl: string | null
    prState: 'draft' | 'open' | 'merged' | 'closed' | null
    prHeadSha: string | null
    eta: EtaRange | null
  }
}

export type PublicPhaseArtifactRow = ArtifactSnapshot

/** Resolved storage and database references for processing a ticket in API routes. */
export interface TicketContext {
  ticketRef: string
  externalId: string
  projectId: number
  projectRoot: string
  localProject: LocalProjectRow
  localTicket: LocalTicketRow
  localTicketId: number
  projectDb: NonNullable<ReturnType<typeof getProjectContextById>>['projectDb']
}

export function buildTicketRef(projectId: number, externalId: string): string {
  return `${projectId}:${externalId}`
}

export function parseTicketRef(ticketRef: string): { projectId: number; externalId: string } | null {
  const separator = ticketRef.indexOf(':')
  if (separator <= 0) return null
  const projectId = Number(ticketRef.slice(0, separator))
  const externalId = ticketRef.slice(separator + 1)
  if (Number.isNaN(projectId) || !externalId) return null
  return { projectId, externalId }
}

export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
  } catch {
    return []
  }
}

export function normalizeModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

export function normalizeModelList(values: Array<string | null | undefined>): string[] {
  const unique = new Set<string>()
  const normalized: string[] = []

  for (const value of values) {
    const modelId = normalizeModelId(value)
    if (!modelId || unique.has(modelId)) continue
    unique.add(modelId)
    normalized.push(modelId)
  }

  return normalized
}

export function parseLockedCouncilMembers(raw: string | null | undefined): string[] {
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as unknown
    const result = LockedCouncilMembersSchema.safeParse(parsed)
    if (!result.success) {
      warnInvalidDbJson('lockedCouncilMembers', raw, result.error.message)
      return []
    }
    return normalizeModelList(result.data)
  } catch (error) {
    warnInvalidDbJson('lockedCouncilMembers', raw, error instanceof Error ? error.message : String(error))
    return []
  }
}

export function parseLockedCouncilMemberVariants(raw: string | null | undefined): Record<string, string> | null {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as unknown
    const result = LockedCouncilMemberVariantsSchema.safeParse(parsed)
    if (!result.success) {
      warnInvalidDbJson('lockedCouncilMemberVariants', raw, result.error.message)
      return null
    }

    return Object.fromEntries(
      Object.entries(result.data).map(([key, value]) => [key.trim(), value]),
    )
  } catch (error) {
    warnInvalidDbJson('lockedCouncilMemberVariants', raw, error instanceof Error ? error.message : String(error))
    return null
  }
}

export function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false

  const leftSet = new Set(left)
  const rightSet = new Set(right)
  if (leftSet.size !== left.length || rightSet.size !== right.length) return false
  if (leftSet.size !== rightSet.size) return false
  return [...leftSet].every((value) => rightSet.has(value))
}

export function isValidResolutionStatus(v: unknown): v is TicketErrorResolutionStatus {
  return v === 'RETRIED' || v === 'CONTINUED' || v === 'CANCELED'
}

function parseJsonObject<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function parseManualQaArtifactValue<T>(raw: string | null | undefined): T | null {
  const parsed = parseJsonObject<Record<string, unknown>>(raw)
  if (!parsed) return null
  const nested = parsed.value
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as T
    : parsed as T
}

function parseTicketErrorCodes(raw: string | null | undefined): string[] {
  if (!raw) return []
  const parsed = parseJsonObject<unknown>(raw)
  return Array.isArray(parsed)
    ? parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
}

function parseTicketErrorDiagnostics(raw: string | null | undefined): BlockedErrorDiagnostics | null {
  if (!raw) return null
  const parsed = parseJsonObject<unknown>(raw)
  return normalizeBlockedErrorDiagnostics(parsed)
}

function readTicketErrorOccurrences(
  projectContext: NonNullable<ReturnType<typeof getProjectContextById>> | null | undefined,
  localTicketId: number,
): TicketErrorOccurrence[] {
  if (!projectContext) return []

  const rows = projectContext.projectDb.select({
    id: ticketErrorOccurrences.id,
    ticketId: ticketErrorOccurrences.ticketId,
    occurrenceNumber: ticketErrorOccurrences.occurrenceNumber,
    blockedFromStatus: ticketErrorOccurrences.blockedFromStatus,
    errorMessage: ticketErrorOccurrences.errorMessage,
    errorCodes: ticketErrorOccurrences.errorCodes,
    diagnosticDetails: ticketErrorOccurrences.diagnosticDetails,
    occurredAt: ticketErrorOccurrences.occurredAt,
    resolvedAt: ticketErrorOccurrences.resolvedAt,
    resolutionStatus: ticketErrorOccurrences.resolutionStatus,
    resumedToStatus: ticketErrorOccurrences.resumedToStatus,
  })
    .from(ticketErrorOccurrences)
    .where(eq(ticketErrorOccurrences.ticketId, localTicketId))
    .orderBy(asc(ticketErrorOccurrences.occurrenceNumber))
    .all()

  return rows.map((row) => ({
    id: row.id,
    ticketId: row.ticketId,
    occurrenceNumber: row.occurrenceNumber,
    blockedFromStatus: row.blockedFromStatus,
    errorMessage: row.errorMessage,
    errorCodes: parseTicketErrorCodes(row.errorCodes),
    diagnostics: parseTicketErrorDiagnostics(row.diagnosticDetails),
    occurredAt: row.occurredAt,
    resolvedAt: row.resolvedAt,
    resolutionStatus: isValidResolutionStatus(row.resolutionStatus) ? row.resolutionStatus : null,
    resumedToStatus: row.resumedToStatus,
  }))
}

function readActiveErrorOccurrenceId(errorOccurrences: TicketErrorOccurrence[]): number | null {
  for (let index = errorOccurrences.length - 1; index >= 0; index -= 1) {
    const occurrence = errorOccurrences[index]
    if (!occurrence) continue
    if (!occurrence.resolvedAt) return occurrence.id
  }
  return null
}

export interface TicketContinuationCandidate {
  ticketId: string
  projectId: number
  localTicketId: number
  previousStatus: string
  sessionId: string
}

function resolveTicketContinuationCandidateFromRows(
  projectContext: NonNullable<ReturnType<typeof getProjectContextById>> | null | undefined,
  projectId: number,
  ticket: LocalTicketRow,
  previousStatus: string | null,
  errorOccurrences: TicketErrorOccurrence[],
  activeErrorOccurrenceId: number | null,
): TicketContinuationCandidate | null {
  if (!projectContext || ticket.status !== 'BLOCKED_ERROR' || !previousStatus || activeErrorOccurrenceId === null) {
    return null
  }

  const occurrence = errorOccurrences.find((candidate) => candidate.id === activeErrorOccurrenceId)
  if (!occurrence || occurrence.resolvedAt !== null) return null
  if (!isContinuableBlockedError({
    diagnostics: occurrence.diagnostics,
    errorCodes: occurrence.errorCodes,
  })) {
    return null
  }

  const sessionId = occurrence.diagnostics?.sessionId?.trim()
  if (!sessionId) return null

  const activeSession = projectContext.projectDb.select({ id: opencodeSessions.id })
    .from(opencodeSessions)
    .where(and(
      eq(opencodeSessions.ticketId, ticket.id),
      eq(opencodeSessions.sessionId, sessionId),
      eq(opencodeSessions.phase, previousStatus),
      eq(opencodeSessions.state, 'active'),
    ))
    .get()
  if (!activeSession) return null

  return {
    ticketId: buildTicketRef(projectId, ticket.externalId),
    projectId,
    localTicketId: ticket.id,
    previousStatus,
    sessionId,
  }
}

/**
 * Injects `'continue'` into a ticket’s available actions when a resumable
 * OpenCode session exists for the current BLOCKED_ERROR. Inserted right after
 * `'retry'` so the UI shows them together.
 */
function addContinueActionWhenAvailable(
  actions: string[],
  candidate: TicketContinuationCandidate | null,
): string[] {
  if (!candidate || actions.includes('continue')) return actions
  const retryIndex = actions.indexOf('retry')
  if (retryIndex === -1) return [...actions, 'continue']
  return [
    ...actions.slice(0, retryIndex + 1),
    'continue',
    ...actions.slice(retryIndex + 1),
  ]
}

function readErrorSeenSignature(projectContext: NonNullable<ReturnType<typeof getProjectContextById>>, localTicketId: number): string | null {
  const artifact = projectContext.projectDb.select().from(phaseArtifacts)
    .where(and(
      eq(phaseArtifacts.ticketId, localTicketId),
      eq(phaseArtifacts.phase, 'UI_STATE'),
      eq(phaseArtifacts.artifactType, 'ui_state:error_attention'),
    ))
    .orderBy(desc(phaseArtifacts.id))
    .get()

  if (!artifact) return null

  const parsed = parseJsonObject<{ data?: { seenSignature?: unknown } }>(artifact.content)
  return typeof parsed?.data?.seenSignature === 'string' ? parsed.data.seenSignature : null
}

function readNeedsInputSeenSignature(projectContext: NonNullable<ReturnType<typeof getProjectContextById>>, localTicketId: number): string | null {
  const artifact = projectContext.projectDb.select().from(phaseArtifacts)
    .where(and(
      eq(phaseArtifacts.ticketId, localTicketId),
      eq(phaseArtifacts.phase, 'UI_STATE'),
      eq(phaseArtifacts.artifactType, 'ui_state:needs_input_attention'),
    ))
    .orderBy(desc(phaseArtifacts.id))
    .get()

  if (!artifact) return null

  const parsed = parseJsonObject<{ data?: { seenSignature?: unknown } }>(artifact.content)
  return typeof parsed?.data?.seenSignature === 'string' ? parsed.data.seenSignature : null
}

function readVisitedStatuses(
  projectContext: NonNullable<ReturnType<typeof getProjectContextById>> | null | undefined,
  ticket: LocalTicketRow,
): string[] {
  const visited = new Set<string>(['DRAFT'])
  if (projectContext) {
    const history = projectContext.projectDb.select({ newStatus: ticketStatusHistory.newStatus })
      .from(ticketStatusHistory)
      .where(eq(ticketStatusHistory.ticketId, ticket.id))
      .orderBy(asc(ticketStatusHistory.id))
      .all()
    for (const row of history) visited.add(row.newStatus)
  }
  visited.add(ticket.status)
  return [...visited]
}

const IMPLEMENTATION_TIMING_STATUSES = {
  coding: 'CODING',
  workspacePreparation: 'PREPARING_EXECUTION_ENV',
  finalTesting: 'RUNNING_FINAL_TEST',
} as const

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function readImplementationTiming(
  projectContext: NonNullable<ReturnType<typeof getProjectContextById>> | null | undefined,
  ticket: LocalTicketRow,
  beads: Array<{
    startedAt?: string | null
    updatedAt?: string | null
    completedAt?: string | null
    qaOrigin?: QaOrigin | null
  }>,
): TicketImplementationTiming {
  const empty: TicketImplementationTiming = {
    activeDurationMs: 0,
    startedAt: null,
    lastPlannedBeadFinishedAt: null,
    manualQaFixDurationMs: 0,
    manualQaFixStartedAt: null,
    workspacePreparationDurationMs: 0,
    workspacePreparationStartedAt: null,
    finalTestingDurationMs: 0,
    finalTestingStartedAt: null,
  }
  if (!projectContext) return empty

  const rows = projectContext.projectDb.select({
    newStatus: ticketStatusHistory.newStatus,
    changedAt: ticketStatusHistory.changedAt,
  })
    .from(ticketStatusHistory)
    .where(eq(ticketStatusHistory.ticketId, ticket.id))
    .orderBy(asc(ticketStatusHistory.id))
    .all()

  let activeDurationMs = 0
  let workspacePreparationDurationMs = 0
  let finalTestingDurationMs = 0
  let startedAt: string | null = null
  let workspacePreparationStartedAt: string | null = null
  let finalTestingStartedAt: string | null = null
  const codingIntervals: Array<{ startedAt: number; endedAt: number }> = []
  const now = Date.now()

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) continue
    const startedMs = parseTimestamp(row.changedAt)
    if (startedMs === null) continue
    const endedMs = parseTimestamp(rows[index + 1]?.changedAt)
      ?? (ticket.status === row.newStatus ? now : startedMs)
    const durationMs = Math.max(0, endedMs - startedMs)

    if (row.newStatus === IMPLEMENTATION_TIMING_STATUSES.coding) {
      activeDurationMs += durationMs
      startedAt ??= row.changedAt
      codingIntervals.push({ startedAt: startedMs, endedAt: endedMs })
    } else if (row.newStatus === IMPLEMENTATION_TIMING_STATUSES.workspacePreparation) {
      workspacePreparationDurationMs += durationMs
      workspacePreparationStartedAt ??= row.changedAt
    } else if (row.newStatus === IMPLEMENTATION_TIMING_STATUSES.finalTesting) {
      finalTestingDurationMs += durationMs
      finalTestingStartedAt ??= row.changedAt
    }
  }

  const finalPlannedBead = beads.filter((bead) => !bead.qaOrigin).at(-1)
  const lastPlannedBeadFinishedAt = parseTimestamp(finalPlannedBead?.completedAt) !== null
    ? finalPlannedBead!.completedAt!
    : null
  const manualQaFixBeads = beads.filter((bead) => bead.qaOrigin)
  const manualQaFixStartedAt = manualQaFixBeads
    .map((bead) => bead.startedAt ?? null)
    .filter((value): value is string => parseTimestamp(value) !== null)
    .sort((left, right) => parseTimestamp(left)! - parseTimestamp(right)!)[0] ?? null
  const manualQaFixDurationMs = manualQaFixBeads.reduce((total, bead) => {
    const beadStartedAt = parseTimestamp(bead.startedAt)
    if (beadStartedAt === null) return total
    const beadEndedAt = parseTimestamp(bead.completedAt)
      ?? parseTimestamp(bead.updatedAt)
      ?? (ticket.status === IMPLEMENTATION_TIMING_STATUSES.coding ? now : beadStartedAt)
    return total + codingIntervals.reduce((duration, interval) => (
      duration + Math.max(0, Math.min(interval.endedAt, beadEndedAt) - Math.max(interval.startedAt, beadStartedAt))
    ), 0)
  }, 0)

  return {
    activeDurationMs: Math.max(0, activeDurationMs - manualQaFixDurationMs),
    startedAt,
    lastPlannedBeadFinishedAt,
    manualQaFixDurationMs,
    manualQaFixStartedAt,
    workspacePreparationDurationMs,
    workspacePreparationStartedAt,
    finalTestingDurationMs,
    finalTestingStartedAt,
  }
}

const MANUAL_QA_OUTCOMES = new Set(['passed', 'waived_through', 'skipped', 'failed', 'created_fixes'])

function readManualQaProjection(
  projectContext: NonNullable<ReturnType<typeof getProjectContextById>> | null | undefined,
  localTicketId: number,
): PublicTicket['manualQa'] {
  const empty: PublicTicket['manualQa'] = {
    activeVersion: null,
    completedRoundCount: 0,
    latestOutcome: null,
    artifactAvailability: { checklist: false, results: false, coverage: false, summary: false },
  }
  if (!projectContext) return empty

  const artifacts = projectContext.projectDb.select().from(phaseArtifacts)
    .where(eq(phaseArtifacts.ticketId, localTicketId))
    .orderBy(asc(phaseArtifacts.id))
    .all()
    .filter((artifact) => typeof artifact.artifactType === 'string' && artifact.artifactType.startsWith('manual_qa_'))
  if (artifacts.length === 0) return empty

  let latestOutcome: PublicTicket['manualQa']['latestOutcome'] = null
  const artifactVersions = new Set<number>()
  const completedVersions = new Set<number>()
  const typesByVersion = new Map<number, Set<string>>()

  for (const artifact of artifacts) {
    const parsed = parseManualQaArtifactValue<Record<string, unknown>>(artifact.content)
    const rawVersion = parsed?.version ?? parsed?.checklistVersion ?? parsed?.activeVersion
    const version = typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion > 0
      ? rawVersion
      : null
    if (version !== null) {
      artifactVersions.add(version)
      const versionTypes = typesByVersion.get(version) ?? new Set<string>()
      versionTypes.add(artifact.artifactType!)
      typesByVersion.set(version, versionTypes)
    }

    if (artifact.artifactType === 'manual_qa_summary') {
      const rawOutcome = parsed?.outcome ?? parsed?.status
      if (typeof rawOutcome === 'string' && MANUAL_QA_OUTCOMES.has(rawOutcome)) {
        latestOutcome = rawOutcome as PublicTicket['manualQa']['latestOutcome']
        if (version !== null && rawOutcome !== 'failed') completedVersions.add(version)
      }
    }
  }

  const activeVersion = [...artifactVersions]
    .filter((version) => !completedVersions.has(version))
    .sort((left, right) => right - left)[0] ?? null
  const projectedVersion = activeVersion ?? [...artifactVersions].sort((left, right) => right - left)[0] ?? null
  const types = projectedVersion === null ? new Set<string>() : (typesByVersion.get(projectedVersion) ?? new Set<string>())

  return {
    activeVersion,
    completedRoundCount: completedVersions.size,
    latestOutcome,
    artifactAvailability: {
      checklist: types.has('manual_qa_checklist'),
      results: types.has('manual_qa_results'),
      coverage: types.has('manual_qa_coverage'),
      summary: types.has('manual_qa_summary'),
    },
  }
}

function readManualQaOrigin(projectRoot: string | undefined, externalId: string): PublicTicket['manualQaOrigin'] {
  if (!projectRoot) return null
  try {
    const content = readFileSync(resolve(getTicketDir(projectRoot, externalId), 'meta', 'manual-qa-origin.json'), 'utf8')
    const parsed = ManualQaImprovementOriginSchema.safeParse(JSON.parse(content) as unknown)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Determines the status a reviewer should scroll to when viewing a ticket’s
 * artifact history. For BLOCKED_ERROR it returns the phase that was active when
 * the error occurred; for CANCELED it unwinds through a possible double-error.
 */
export function resolveReviewCutoffStatus(
  ticketStatus: string,
  previousStatus: string | null,
  latestBlockedErrorPreviousStatus: string | null = null,
): string | null {
  if (ticketStatus === 'BLOCKED_ERROR') {
    return previousStatus
  }

  if (ticketStatus !== 'CANCELED') {
    return null
  }

  if (previousStatus !== 'BLOCKED_ERROR') {
    return previousStatus
  }

  return latestBlockedErrorPreviousStatus ?? null
}

function readReviewCutoffStatus(
  ticket: LocalTicketRow,
  previousStatus: string | null,
  errorOccurrences: TicketErrorOccurrence[],
): string | null {
  const latestBlockedErrorPreviousStatus = previousStatus === 'BLOCKED_ERROR'
    ? errorOccurrences.at(-1)?.blockedFromStatus ?? null
    : null

  return resolveReviewCutoffStatus(ticket.status, previousStatus, latestBlockedErrorPreviousStatus)
}

/** Converts a raw database ticket row into a fully enriched public ticket with runtime data, actions, and error history. */
export function toPublicTicket(projectId: number, ticket: LocalTicketRow): PublicTicket {
  const project = getProjectById(projectId)
  const profile = appDb.select().from(profiles).get()
  const projectContext = getProjectContextById(projectId)
  const isMockTicket = isDisplayOnlyMockTicket(ticket)
  const baseBranch = project ? resolveTicketBaseBranch(project.folderPath, ticket.externalId) : 'unknown'
  const lockedCouncilMembers = parseLockedCouncilMembers(ticket.lockedCouncilMembers)
  const lockedCouncilMemberVariants = parseLockedCouncilMemberVariants(ticket.lockedCouncilMemberVariants)
  const snapshot = parseJsonObject<{ context?: { previousStatus?: unknown } }>(ticket.xstateSnapshot)
  const errorOccurrences = readTicketErrorOccurrences(projectContext, ticket.id)
  const activeErrorOccurrenceId = readActiveErrorOccurrenceId(errorOccurrences)
  const previousStatusFromSnapshot = typeof snapshot?.context?.previousStatus === 'string' ? snapshot.context.previousStatus : null
  const previousStatus = previousStatusFromSnapshot
    ?? (ticket.status === 'BLOCKED_ERROR' ? errorOccurrences.at(-1)?.blockedFromStatus ?? null : null)
  const reviewCutoffStatus = readReviewCutoffStatus(ticket, previousStatus, errorOccurrences)
  const errorSeenSignature = projectContext ? readErrorSeenSignature(projectContext, ticket.id) : null
  const needsInputSeenSignature = projectContext ? readNeedsInputSeenSignature(projectContext, ticket.id) : null
  const continuationCandidate = resolveTicketContinuationCandidateFromRows(
    projectContext,
    projectId,
    ticket,
    previousStatus,
    errorOccurrences,
    activeErrorOccurrenceId,
  )
  const runtime = project ? buildRuntime(projectId, project.folderPath, ticket, baseBranch, previousStatus) : {
    baseBranch,
    currentBead: ticket.currentBead ?? 0,
    completedBeads: 0,
    totalBeads: ticket.totalBeads ?? 0,
    percentComplete: Math.round(ticket.percentComplete ?? 0),
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
    finalTestStatus: 'pending' as const,
    prNumber: null,
    prUrl: null,
    prState: null,
    prHeadSha: null,
    eta: null,
  }
  const completionDisposition = readCompletionDisposition(projectContext, ticket.id)
  const cleanup = readCleanupSummary(projectContext, ticket.id)
  const visitedStatuses = readVisitedStatuses(projectContext, ticket)
  const manualQa = readManualQaProjection(projectContext, ticket.id)
  const manualQaOrigin = readManualQaOrigin(project?.folderPath, ticket.externalId)
  const implementationTiming = readImplementationTiming(projectContext, ticket, runtime.beads ?? [])
  const manualQaResolution: { enabled: boolean; source: 'ticket' | 'project' | 'profile' } = ticket.startedAt !== null
    ? {
        enabled: ticket.lockedManualQaEnabled === true,
        source: ticket.lockedManualQaSource === 'ticket' || ticket.lockedManualQaSource === 'project'
          ? ticket.lockedManualQaSource
          : 'profile',
      }
    : ticket.manualQaOverride !== null
      ? { enabled: ticket.manualQaOverride, source: 'ticket' as const }
      : project?.manualQaOverride !== null && project?.manualQaOverride !== undefined
        ? { enabled: project.manualQaOverride, source: 'project' as const }
        : { enabled: profile?.manualQaEnabled ?? PROFILE_DEFAULTS.manualQaEnabled, source: 'profile' as const }
  const gitHookPolicyResolution: { policy: GitHookPolicy; source: 'project' | 'profile' } = ticket.startedAt !== null
    ? {
        policy: isGitHookPolicy(ticket.lockedGitHookPolicy)
          ? ticket.lockedGitHookPolicy
          : PROFILE_DEFAULTS.gitHookPolicy,
        source: ticket.lockedGitHookPolicySource === 'project'
          ? 'project'
          : 'profile',
      }
    : isGitHookPolicy(project?.gitHookPolicy)
      ? { policy: project.gitHookPolicy, source: 'project' as const }
      : {
          policy: isGitHookPolicy(profile?.gitHookPolicy) ? profile.gitHookPolicy : PROFILE_DEFAULTS.gitHookPolicy,
          source: 'profile' as const,
        }

  return {
    ...ticket,
    id: buildTicketRef(projectId, ticket.externalId),
    projectId,
    isDisplayOnlyMock: isMockTicket,
    lockedCouncilMembers,
    lockedCouncilMemberVariants,
    lockedManualQaSource: ticket.lockedManualQaSource === 'ticket'
      || ticket.lockedManualQaSource === 'project'
      || ticket.lockedManualQaSource === 'profile'
      ? ticket.lockedManualQaSource
      : null,
    effectiveManualQaEnabled: manualQaResolution.enabled,
    effectiveManualQaSource: manualQaResolution.source,
    lockedGitHookPolicy: isGitHookPolicy(ticket.lockedGitHookPolicy) ? ticket.lockedGitHookPolicy : null,
    lockedGitHookPolicySource: ticket.lockedGitHookPolicySource === 'project'
      || ticket.lockedGitHookPolicySource === 'profile'
      ? ticket.lockedGitHookPolicySource
      : null,
    effectiveGitHookPolicy: gitHookPolicyResolution.policy,
    effectiveGitHookPolicySource: gitHookPolicyResolution.source,
    visitedStatuses,
    manualQa,
    manualQaOrigin,
    availableActions: isMockTicket
      ? getDisplayOnlyMockTicketActions(ticket.status)
      : addContinueActionWhenAvailable(
        getAvailableWorkflowActions(ticket.status),
        continuationCandidate,
      ),
    previousStatus,
    reviewCutoffStatus,
    errorOccurrences,
    activeErrorOccurrenceId,
    hasPastErrors: errorOccurrences.some((occurrence) => occurrence.resolvedAt !== null),
    errorSeenSignature,
    needsInputSeenSignature,
    implementationTiming,
    completionDisposition,
    cleanup,
    runtime,
  }
}

function readCleanupSummary(
  projectContext: NonNullable<ReturnType<typeof getProjectContextById>> | null | undefined,
  localTicketId: number,
): PublicTicket['cleanup'] {
  if (!projectContext) {
    return { status: null, errorCount: 0, latestReportArtifactId: null, errors: [] }
  }

  const artifact = projectContext.projectDb.select().from(phaseArtifacts)
    .where(and(
      eq(phaseArtifacts.ticketId, localTicketId),
      eq(phaseArtifacts.artifactType, 'cleanup_report'),
    ))
    .orderBy(desc(phaseArtifacts.id))
    .get()

  if (!artifact?.content) {
    return { status: null, errorCount: 0, latestReportArtifactId: null, errors: [] }
  }

  const parsed = parseJsonObject<{ status?: unknown; errors?: unknown }>(artifact.content)
  const errors = Array.isArray(parsed?.errors)
    ? parsed.errors.filter((entry) => typeof entry === 'string')
    : []
  const status = parsed?.status === 'warning'
    ? 'warning'
    : parsed?.status === 'clean'
      ? 'clean'
      : errors.length > 0 ? 'warning' : 'clean'

  return {
    status,
    errorCount: errors.length,
    latestReportArtifactId: artifact.id,
    errors,
  }
}

function readCompletionDisposition(
  projectContext: NonNullable<ReturnType<typeof getProjectContextById>> | null | undefined,
  localTicketId: number,
): PublicTicket['completionDisposition'] {
  if (!projectContext) return null

  const artifact = projectContext.projectDb.select().from(phaseArtifacts)
    .where(and(
      eq(phaseArtifacts.ticketId, localTicketId),
      eq(phaseArtifacts.artifactType, 'merge_report'),
    ))
    .orderBy(desc(phaseArtifacts.id))
    .get()

  if (!artifact?.content) return null

  const parsed = parseJsonObject<{ disposition?: unknown }>(artifact.content)
  return parsed?.disposition === 'merged' || parsed?.disposition === 'closed_unmerged'
    ? parsed.disposition
    : null
}

function buildRuntime(
  projectId: number,
  projectRoot: string,
  ticket: LocalTicketRow,
  baseBranch: string,
  previousStatus: string | null,
): PublicTicket['runtime'] {
  const projectContext = getProjectContextById(projectId)
  const profile = appDb.select().from(profiles).get()
  const snapshot = parseJsonObject<{ context?: { maxIterations?: unknown } }>(ticket.xstateSnapshot)
  const maxIterations = typeof snapshot?.context?.maxIterations === 'number'
    ? snapshot.context.maxIterations
    : projectContext?.project.maxIterations
      ?? profile?.maxIterations
      ?? PROFILE_DEFAULTS.maxIterations
  const perIterationTimeoutMs = projectContext?.project.perIterationTimeout
    ?? profile?.perIterationTimeout
    ?? PROFILE_DEFAULTS.perIterationTimeout
  const executionSetupTimeoutMs = projectContext?.project.executionSetupTimeout
    ?? profile?.executionSetupTimeout
    ?? PROFILE_DEFAULTS.executionSetupTimeout
  const finalTestArtifact = projectContext?.projectDb.select().from(phaseArtifacts)
    .where(and(
      eq(phaseArtifacts.ticketId, ticket.id),
      eq(phaseArtifacts.artifactType, 'final_test_report'),
    ))
    .orderBy(desc(phaseArtifacts.id))
    .get()
  const latestManualQaSummaryArtifact = projectContext?.projectDb.select().from(phaseArtifacts)
    .where(and(
      eq(phaseArtifacts.ticketId, ticket.id),
      eq(phaseArtifacts.artifactType, 'manual_qa_summary'),
    ))
    .orderBy(desc(phaseArtifacts.id))
    .get()
  const integrationArtifact = projectContext?.projectDb.select().from(phaseArtifacts)
    .where(and(
      eq(phaseArtifacts.ticketId, ticket.id),
      eq(phaseArtifacts.artifactType, 'integration_report'),
    ))
    .orderBy(desc(phaseArtifacts.id))
    .get()
  const pullRequestArtifact = projectContext?.projectDb.select().from(phaseArtifacts)
    .where(and(
      eq(phaseArtifacts.ticketId, ticket.id),
      eq(phaseArtifacts.artifactType, 'pull_request_report'),
    ))
    .orderBy(desc(phaseArtifacts.id))
    .get()
  const finalTestReport = parseJsonObject<{ status?: 'passed' | 'failed'; passed?: boolean }>(finalTestArtifact?.content)
  const latestManualQaSummary = parseManualQaArtifactValue<{ outcome?: unknown; status?: unknown }>(latestManualQaSummaryArtifact?.content)
  const latestManualQaOutcome = latestManualQaSummary?.outcome ?? latestManualQaSummary?.status
  const qaFixesAreNewerThanFinalTest = (
    (latestManualQaOutcome === 'created_fixes' || latestManualQaOutcome === 'failed')
    && Boolean(latestManualQaSummaryArtifact)
    && (!finalTestArtifact || latestManualQaSummaryArtifact!.id > finalTestArtifact.id)
  )
  const integrationReport = parseJsonObject<{ candidateCommitSha?: string | null; preSquashHead?: string | null }>(integrationArtifact?.content)
  const pullRequestReport = parseJsonObject<{
    prNumber?: number | null
    prUrl?: string | null
    prState?: 'draft' | 'open' | 'merged' | 'closed' | null
    prHeadSha?: string | null
  }>(pullRequestArtifact?.content)
  const beads = readRuntimeBeads(projectRoot, ticket.externalId, baseBranch)
  const inProgressBead = beads.find((bead) => bead.status === 'in_progress') ?? null
  const lastFailedBead = [...beads]
    .filter((bead) => bead.status === 'error')
    .sort((left, right) => {
      const leftUpdatedAt = Date.parse(left.updatedAt ?? '')
      const rightUpdatedAt = Date.parse(right.updatedAt ?? '')

      if (!Number.isNaN(leftUpdatedAt) || !Number.isNaN(rightUpdatedAt)) {
        if (Number.isNaN(leftUpdatedAt)) return 1
        if (Number.isNaN(rightUpdatedAt)) return -1
        return rightUpdatedAt - leftUpdatedAt
      }

      return right.iteration - left.iteration
    })[0] ?? null
  const blockedFromCoding = ticket.status === 'BLOCKED_ERROR' && previousStatus === 'CODING'
  const totalBeads = ticket.totalBeads ?? 0
  const currentBead = ticket.currentBead ?? 0
  const completedBeads = totalBeads === 0
    ? 0
    : currentBead >= totalBeads
      ? totalBeads
      : Math.max(0, currentBead - 1)

  // ETA is only meaningful while beads are actively executing; skip it elsewhere to keep
  // list/kanban fetches cheap. Computed read-time from persisted throughput metrics.
  let eta: EtaRange | null = null
  if (ticket.status === 'CODING' && projectContext && totalBeads > 0) {
    const effortTier = ticket.lockedMainImplementerVariant || 'medium'
    const sizeBucket = bucketForBeadCount(totalBeads)
    eta = computeEtaRange({
      remaining: Math.max(0, totalBeads - completedBeads),
      historySamples: getThroughputSamples(projectContext.projectDb, { effortTier, sizeBucket, excludeTicketId: ticket.id }),
      currentRunSamples: getTicketBeadSamples(projectContext.projectDb, ticket.id),
    })
  }

  return {
    baseBranch,
    currentBead,
    completedBeads,
    totalBeads,
    percentComplete: Math.round(ticket.percentComplete ?? 0),
    iterationCount: 0,
    maxIterations,
    maxIterationsPerBead: maxIterations,
    perIterationTimeoutMs,
    executionSetupTimeoutMs,
    activeBeadId: inProgressBead?.id ?? (blockedFromCoding ? lastFailedBead?.id ?? null : null),
    activeBeadIteration: inProgressBead?.iteration ?? (blockedFromCoding ? lastFailedBead?.iteration ?? null : null),
    lastFailedBeadId: blockedFromCoding ? lastFailedBead?.id ?? null : null,
    artifactRoot: getTicketDir(projectRoot, ticket.externalId),
    beads: beads.map((bead) => ({
      id: bead.id,
      title: bead.title,
      status: bead.status,
      iteration: bead.iteration,
      failedIterationNotes: bead.failedIterationNotes,
      userRetryNotes: bead.userRetryNotes,
      finalizationFailureNotes: bead.finalizationFailureNotes,
      startedAt: bead.startedAt,
      updatedAt: bead.updatedAt,
      completedAt: bead.completedAt,
      qaOrigin: bead.qaOrigin,
    })),
    candidateCommitSha: integrationReport?.candidateCommitSha ?? null,
    preSquashHead: integrationReport?.preSquashHead ?? null,
    finalTestStatus: qaFixesAreNewerThanFinalTest
      ? 'pending'
      : finalTestReport?.status ?? (finalTestReport?.passed ? 'passed' : 'pending'),
    prNumber: typeof pullRequestReport?.prNumber === 'number' ? pullRequestReport.prNumber : null,
    prUrl: typeof pullRequestReport?.prUrl === 'string' ? pullRequestReport.prUrl : null,
    prState: pullRequestReport?.prState ?? null,
    prHeadSha: typeof pullRequestReport?.prHeadSha === 'string' ? pullRequestReport.prHeadSha : null,
    eta,
  }
}

function readRuntimeBeads(projectRoot: string, externalId: string, baseBranch: string) {
  try {
    return readJsonl<Record<string, unknown>>(getTicketBeadsPath(projectRoot, externalId, baseBranch))
      .map((bead) => {
        const qaOrigin = RuntimeQaOriginSchema.safeParse(bead.qaOrigin)
        return {
          id: typeof bead.id === 'string' ? bead.id : '',
          title: typeof bead.title === 'string' ? bead.title : 'Untitled',
          status: typeof bead.status === 'string' ? bead.status : 'pending',
          iteration: typeof bead.iteration === 'number' ? bead.iteration : 0,
          failedIterationNotes: Array.isArray(bead.failedIterationNotes) ? bead.failedIterationNotes : [],
          userRetryNotes: Array.isArray(bead.userRetryNotes) ? bead.userRetryNotes : [],
          finalizationFailureNotes: Array.isArray(bead.finalizationFailureNotes) ? bead.finalizationFailureNotes : [],
          updatedAt: typeof bead.updatedAt === 'string' ? bead.updatedAt : null,
          startedAt: typeof bead.startedAt === 'string' ? bead.startedAt : null,
          completedAt: typeof bead.completedAt === 'string' ? bead.completedAt : null,
          qaOrigin: qaOrigin.success ? qaOrigin.data : null,
        }
      })
      .filter((bead) => bead.id.length > 0)
  } catch {
    return []
  }
}

export interface ExecutionBandConflict {
  ticketId: string
  externalId: string
  title: string
  status: string
}

/** Returns any ticket in the project that is currently in the execution band (coding/testing/integrating), excluding `excludeTicketRef`. */
export function findProjectExecutionBandConflict(
  projectId: number,
  excludeTicketRef?: string,
): ExecutionBandConflict | null {
  const project = getProjectContextById(projectId)
  if (!project) return null

  const excludedExternalId = excludeTicketRef ? parseTicketRef(excludeTicketRef)?.externalId ?? null : null
  const executionBandStatusSet = new Set<string>(EXECUTION_BAND_STATUSES)

  const conflict = project.projectDb.select({
    externalId: tickets.externalId,
    title: tickets.title,
    status: tickets.status,
    branchName: tickets.branchName,
  })
    .from(tickets)
    .orderBy(desc(tickets.updatedAt))
    .all()
    .find((candidate) => (
      candidate.externalId !== excludedExternalId
      && !isDisplayOnlyMockTicket(candidate)
      && executionBandStatusSet.has(candidate.status)
    ))

  return conflict
    ? {
        ticketId: buildTicketRef(projectId, conflict.externalId),
        externalId: conflict.externalId,
        title: conflict.title,
        status: conflict.status,
      }
    : null
}

/** Lists all tickets across one or all projects, sorted by most recently updated. */
export function listTickets(projectId?: number): PublicTicket[] {
  const projectsToRead = projectId != null
    ? [getProjectContextById(projectId)].filter(Boolean)
    : listProjects().map(project => getProjectContextById(project.id)).filter(Boolean)
  const aggregated: PublicTicket[] = []
  for (const project of projectsToRead) {
    if (!project) continue
    const projectTickets = project.projectDb.select().from(tickets).orderBy(desc(tickets.updatedAt)).all()
    aggregated.push(...projectTickets.map(ticket => toPublicTicket(project.attached.id, ticket)))
  }
  return aggregated.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

/** Fetches a single ticket by its composite ref (`projectId:externalId`). */
export function getTicketByRef(ticketRef: string): PublicTicket | undefined {
  const context = getTicketContext(ticketRef)
  if (!context) return undefined
  return toPublicTicket(context.projectId, context.localTicket)
}

export function findTicketRefByLocalId(localTicketId: number): string | undefined {
  for (const project of listProjects()) {
    const context = getProjectContextById(project.id)
    if (!context) continue
    const localTicket = context.projectDb.select().from(tickets).where(eq(tickets.id, localTicketId)).get()
    if (localTicket) {
      return buildTicketRef(project.id, localTicket.externalId)
    }
  }
  return undefined
}

/** Resolves full ticket context (database handles, paths, project metadata) from a composite ticket ref. */
export function getTicketContext(ticketRef: string): TicketContext | undefined {
  const parsed = parseTicketRef(ticketRef)
  if (!parsed) return undefined
  const project = getProjectContextById(parsed.projectId)
  if (!project) return undefined
  const localTicket = project.projectDb.select().from(tickets).where(eq(tickets.externalId, parsed.externalId)).get()
  if (!localTicket) return undefined
  return {
    ticketRef,
    externalId: parsed.externalId,
    projectId: parsed.projectId,
    projectRoot: project.projectRoot,
    localProject: project.project,
    localTicket,
    localTicketId: localTicket.id,
    projectDb: project.projectDb,
  }
}

export function resolveTicketContinuationCandidate(ticketRef: string): TicketContinuationCandidate | null {
  const context = getTicketContext(ticketRef)
  if (!context) return null
  const projectContext = getProjectContextById(context.projectId)
  if (!projectContext) return null
  const snapshot = parseJsonObject<{ context?: { previousStatus?: unknown } }>(context.localTicket.xstateSnapshot)
  const errorOccurrences = readTicketErrorOccurrences(projectContext, context.localTicketId)
  const activeErrorOccurrenceId = readActiveErrorOccurrenceId(errorOccurrences)
  const previousStatusFromSnapshot = typeof snapshot?.context?.previousStatus === 'string' ? snapshot.context.previousStatus : null
  const previousStatus = previousStatusFromSnapshot
    ?? (context.localTicket.status === 'BLOCKED_ERROR' ? errorOccurrences.at(-1)?.blockedFromStatus ?? null : null)

  return resolveTicketContinuationCandidateFromRows(
    projectContext,
    context.projectId,
    context.localTicket,
    previousStatus,
    errorOccurrences,
    activeErrorOccurrenceId,
  )
}

export function getTicketStorageContext(ticketRef: string): { projectId: number; projectRoot: string; externalId: string } | undefined {
  const parsed = parseTicketRef(ticketRef)
  if (!parsed) return undefined
  const project = getProjectById(parsed.projectId)
  if (!project) return undefined
  return {
    projectId: parsed.projectId,
    projectRoot: project.folderPath,
    externalId: parsed.externalId,
  }
}

export function listNonTerminalTickets(): PublicTicket[] {
  return listTickets().filter(ticket => (
    !['COMPLETED', 'CANCELED'].includes(ticket.status)
    && !isDisplayOnlyMockTicket(ticket)
  ))
}

export function getTicketPaths(ticketRef: string): {
  projectRoot: string
  worktreePath: string
  ticketDir: string
  executionLogPath: string
  debugLogPath: string
  aiLogPath: string
  executionSetupDir: string
  executionSetupProfilePath: string
  baseBranch: string
  beadsPath: string
} | undefined {
  const storage = getTicketStorageContext(ticketRef)
  if (!storage) return undefined
  const baseBranch = resolveTicketBaseBranch(storage.projectRoot, storage.externalId)
  return {
    projectRoot: storage.projectRoot,
    worktreePath: getTicketWorktreePath(storage.projectRoot, storage.externalId),
    ticketDir: getTicketDir(storage.projectRoot, storage.externalId),
    executionLogPath: getTicketExecutionLogPath(storage.projectRoot, storage.externalId),
    debugLogPath: getTicketDebugLogPath(storage.projectRoot, storage.externalId),
    aiLogPath: getTicketAiLogPath(storage.projectRoot, storage.externalId),
    executionSetupDir: getTicketExecutionSetupDir(storage.projectRoot, storage.externalId),
    executionSetupProfilePath: getTicketExecutionSetupProfilePath(storage.projectRoot, storage.externalId),
    baseBranch,
    beadsPath: getTicketBeadsPath(storage.projectRoot, storage.externalId, baseBranch),
  }
}
