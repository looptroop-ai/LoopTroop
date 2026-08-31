import { and, desc, eq, isNull } from 'drizzle-orm'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { resolve } from 'path'
import { spawnSync } from 'child_process'
import { z } from 'zod'
import * as commandLogger from '../log/commandLogger'

// Tolerates partial vi.mock() factories that omit logCommand.
function logCmd(
  bin: string,
  args: string[],
  result:
    | { ok: true; stdin?: string; stdout?: string; stderr?: string }
    | { ok: false; error: string; stdin?: string; stdout?: string; stderr?: string },
) {
  commandLogger.logCommand?.(bin, args, result)
}
import { getProjectContextById } from './projects'
import { manualQaImprovementTickets, opencodeSessions, phaseArtifacts, projects, ticketErrorOccurrences, ticketPhaseAttempts, ticketStatusHistory, tickets } from '../db/schema'
import { getProjectWorktreesRoot, getTicketAiLogPath, getTicketDebugLogPath, getTicketDir, getTicketExecutionLogPath, getTicketWorktreePath } from './paths'
import { safeAtomicWrite } from '../io/atomicWrite'
import { councilMembersEqualOrdered, lockTicketModelSelection, resolveTicketBaseBranch } from '../ticket/metadata'
import type {
  PublicTicket,
  TicketErrorOccurrence,
  TicketErrorResolutionStatus,
} from './ticketQueries'
import {
  BLOCKED_ERROR_DIAGNOSTIC_KINDS,
  BLOCKED_ERROR_DIAGNOSTIC_SOURCES,
  normalizeBlockedErrorDiagnostics,
  type BlockedErrorDiagnostics,
} from '@shared/errorDiagnostics'
import { AI_QUESTION_WINDOW_DEFAULT_MS } from '@shared/aiQuestions'
import { ticketContentFields, ticketOverrideFields } from '../lib/settingSchemas'
import { syncTicketRuntimeProjection } from './ticketRuntimeProjection'
import { removeWorktree } from '../git/worktreeRemoval'
import {
  getTicketContext,
  toPublicTicket,
  parseJsonArray,
  parseLockedCouncilMembers,
  parseLockedCouncilMemberVariants,
  normalizeModelId,
  normalizeModelList,
  isValidResolutionStatus,
} from './ticketQueries'
import { getErrorMessage } from '@shared/typeGuards'

type LocalTicketRow = typeof tickets.$inferSelect

const BlockedErrorDiagnosticsSchema = z.object({
  kind: z.enum(BLOCKED_ERROR_DIAGNOSTIC_KINDS).optional(),
  source: z.enum(BLOCKED_ERROR_DIAGNOSTIC_SOURCES).optional(),
  summary: z.string().optional(),
  modelId: z.string().optional(),
  sessionId: z.string().optional(),
  statusCode: z.number().finite().optional(),
  requestModel: z.string().optional(),
  isRetryable: z.boolean().optional(),
  providerErrorType: z.string().optional(),
  providerErrorTitle: z.string().optional(),
  providerErrorMessage: z.string().optional(),
  responseBodyPreview: z.string().optional(),
  finishReason: z.string().optional(),
  inputTokens: z.number().finite().optional(),
  outputTokens: z.number().finite().optional(),
  reasoningTokens: z.number().finite().optional(),
  cacheReadTokens: z.number().finite().optional(),
  cacheWriteTokens: z.number().finite().optional(),
}).passthrough()

/**
 * The storage boundary's own check on `createTicket` input.
 *
 * Deliberately duplicated validation, not a leftover: `createTicket` is called
 * from the CLI and from tests as well as from the route, so it cannot rely on
 * the route schema having run. The fields it shares with the route are imported
 * so the two cannot disagree about what they accept.
 */
const CreateTicketInputSchema = z.object({
  projectId: z.number().int().positive(),
  title: z.string().min(1).max(500),
  ...ticketContentFields,
  ...ticketOverrideFields,
}).strict()

function truncateLoggedValue(value: string, maxLength = 200): string {
  const trimmed = value.trim()
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed
}

function parseErrorCodes(values: string[] | null | undefined): string {
  return JSON.stringify((values ?? []).filter((value) => typeof value === 'string' && value.trim().length > 0))
}

function serializeDiagnostics(value: BlockedErrorDiagnostics | null | undefined): string | null {
  const diagnostics = normalizeBlockedErrorDiagnostics(value)
  return diagnostics ? JSON.stringify(diagnostics) : null
}

function parseDiagnostics(raw: string | null | undefined): BlockedErrorDiagnostics | null {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as unknown
    const result = BlockedErrorDiagnosticsSchema.safeParse(parsed)
    if (!result.success) {
      console.warn(`[tickets] Invalid stored diagnostics JSON: ${truncateLoggedValue(raw)} (${result.error.message})`)
      return null
    }

    const diagnostics = normalizeBlockedErrorDiagnostics(result.data)
    if (!diagnostics) {
      console.warn(`[tickets] Invalid stored diagnostics payload: ${truncateLoggedValue(raw)}`)
      return null
    }

    return diagnostics
  } catch (error) {
    const detail = getErrorMessage(error)
    console.warn(`[tickets] Failed to parse stored diagnostics JSON: ${truncateLoggedValue(raw)} (${detail})`)
    return null
  }
}

function hydrateErrorOccurrence(row: {
  id: number
  ticketId: number
  occurrenceNumber: number
  blockedFromStatus: string
  errorMessage: string | null
  errorCodes: string | null
  diagnosticDetails: string | null
  occurredAt: string
  resolvedAt: string | null
  resolutionStatus: string | null
  resumedToStatus: string | null
}): TicketErrorOccurrence {
  return {
    id: row.id,
    ticketId: row.ticketId,
    occurrenceNumber: row.occurrenceNumber,
    blockedFromStatus: row.blockedFromStatus,
    errorMessage: row.errorMessage,
    errorCodes: parseJsonArray(row.errorCodes),
    diagnostics: parseDiagnostics(row.diagnosticDetails),
    occurredAt: row.occurredAt,
    resolvedAt: row.resolvedAt,
    resolutionStatus: isValidResolutionStatus(row.resolutionStatus) ? row.resolutionStatus : null,
    resumedToStatus: row.resumedToStatus,
  }
}

export function recordTicketErrorOccurrence(
  ticketRef: string,
  input: {
    blockedFromStatus: string
    errorMessage: string | null
    errorCodes?: string[] | null
    diagnostics?: BlockedErrorDiagnostics | null
    occurredAt?: string
  },
): TicketErrorOccurrence | undefined {
  const context = getTicketContext(ticketRef)
  if (!context) return undefined

  const latestOccurrence = context.projectDb.select({
    occurrenceNumber: ticketErrorOccurrences.occurrenceNumber,
  })
    .from(ticketErrorOccurrences)
    .where(eq(ticketErrorOccurrences.ticketId, context.localTicketId))
    .orderBy(desc(ticketErrorOccurrences.occurrenceNumber))
    .get()

  const inserted = context.projectDb.insert(ticketErrorOccurrences)
    .values({
      ticketId: context.localTicketId,
      occurrenceNumber: (latestOccurrence?.occurrenceNumber ?? 0) + 1,
      blockedFromStatus: input.blockedFromStatus,
      errorMessage: input.errorMessage,
      errorCodes: parseErrorCodes(input.errorCodes),
      diagnosticDetails: serializeDiagnostics(input.diagnostics),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    })
    .returning()
    .get()

  if (!inserted) {
    throw new Error(`Failed to insert ticket error occurrence for ticket: ${ticketRef}`)
  }

  return hydrateErrorOccurrence(inserted)
}

export function resolveLatestTicketErrorOccurrence(
  ticketRef: string,
  input: {
    resolutionStatus: TicketErrorResolutionStatus
    resumedToStatus: string | null
    resolvedAt?: string
  },
): TicketErrorOccurrence | undefined {
  const context = getTicketContext(ticketRef)
  if (!context) return undefined

  const latestOpenOccurrence = context.projectDb.select({
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
    .where(and(
      eq(ticketErrorOccurrences.ticketId, context.localTicketId),
      isNull(ticketErrorOccurrences.resolvedAt),
    ))
    .orderBy(desc(ticketErrorOccurrences.occurrenceNumber))
    .get()

  if (!latestOpenOccurrence) return undefined

  const resolvedAt = input.resolvedAt ?? new Date().toISOString()
  context.projectDb.update(ticketErrorOccurrences)
    .set({
      resolvedAt,
      resolutionStatus: input.resolutionStatus,
      resumedToStatus: input.resumedToStatus,
    })
    .where(eq(ticketErrorOccurrences.id, latestOpenOccurrence.id))
    .run()

  return hydrateErrorOccurrence({
    ...latestOpenOccurrence,
    resolvedAt,
    resolutionStatus: input.resolutionStatus,
    resumedToStatus: input.resumedToStatus,
  })
}

function recordsEqual(left: Record<string, string> | null, right: Record<string, string> | null): boolean {
  if (!left && !right) return true
  if (!left || !right) return false

  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => left[key] === right[key])
}

function assertLockedModelConfigurationMutable(
  ticket: LocalTicketRow,
  patch: Partial<Omit<LocalTicketRow, 'id' | 'projectId' | 'externalId' | 'createdAt'>>,
) {
  const updatesLockedModels = 'lockedMainImplementer' in patch
    || 'lockedCouncilMembers' in patch
    || 'lockedMainImplementerVariant' in patch
    || 'lockedCouncilMemberVariants' in patch
  if (!updatesLockedModels) return

  const currentMainImplementer = normalizeModelId(ticket.lockedMainImplementer)
  const currentMainImplementerVariant = normalizeModelId(ticket.lockedMainImplementerVariant)
  const currentCouncilMembers = parseLockedCouncilMembers(ticket.lockedCouncilMembers)
  const currentCouncilMemberVariants = parseLockedCouncilMemberVariants(ticket.lockedCouncilMemberVariants)
  const hasLockedConfiguration = currentMainImplementer !== null
    || currentMainImplementerVariant !== null
    || currentCouncilMembers.length > 0
    || currentCouncilMemberVariants !== null
  if (!hasLockedConfiguration) return

  const nextMainImplementer = 'lockedMainImplementer' in patch
    ? normalizeModelId(patch.lockedMainImplementer)
    : currentMainImplementer
  const nextMainImplementerVariant = 'lockedMainImplementerVariant' in patch
    ? normalizeModelId(patch.lockedMainImplementerVariant)
    : currentMainImplementerVariant
  const nextCouncilMembers = 'lockedCouncilMembers' in patch
    ? parseLockedCouncilMembers(patch.lockedCouncilMembers)
    : currentCouncilMembers
  const nextCouncilMemberVariants = 'lockedCouncilMemberVariants' in patch
    ? parseLockedCouncilMemberVariants(patch.lockedCouncilMemberVariants)
    : currentCouncilMemberVariants

  if (currentMainImplementer !== nextMainImplementer) {
    throw new Error(`Ticket model configuration is immutable after start: ${ticket.externalId}`)
  }
  if (currentMainImplementerVariant !== nextMainImplementerVariant) {
    throw new Error(`Ticket model configuration is immutable after start: ${ticket.externalId}`)
  }
  if (!councilMembersEqualOrdered(currentCouncilMembers, nextCouncilMembers)) {
    throw new Error(`Ticket model configuration is immutable after start: ${ticket.externalId}`)
  }
  if (!recordsEqual(currentCouncilMemberVariants, nextCouncilMemberVariants)) {
    throw new Error(`Ticket model configuration is immutable after start: ${ticket.externalId}`)
  }
}

type LocalTicketPatch = Partial<Omit<LocalTicketRow, 'id' | 'projectId' | 'externalId' | 'createdAt'>>

const LOCKED_MANUAL_QA_FIELDS = ['lockedManualQaEnabled', 'lockedManualQaSource'] as const
const LOCKED_AI_QUESTION_FIELDS = [
  'lockedAiQuestionsEnabled',
  'lockedAiQuestionsSource',
  'lockedAiQuestionWindow',
  'lockedAiQuestionWindowSource',
] as const

// A locked column is the frozen copy of a cascade: whatever the run started with is
// what it keeps, so rewriting one after start is refused rather than silently applied.
function assertLockedConfigurationMutable(
  ticket: LocalTicketRow,
  patch: LocalTicketPatch,
  fields: readonly (keyof LocalTicketPatch)[],
  label: string,
) {
  if (ticket.startedAt === null || patch.startedAt === null) return

  for (const field of fields) {
    if (!(field in patch)) continue
    if ((patch[field] ?? null) !== (ticket[field] ?? null)) {
      throw new Error(`Ticket ${label} configuration is immutable after start: ${ticket.externalId}`)
    }
  }
}

function assertLockedGitHookConfigurationMutable(
  ticket: LocalTicketRow,
  patch: Partial<Omit<LocalTicketRow, 'id' | 'projectId' | 'externalId' | 'createdAt'>>,
) {
  const updatesLock = 'lockedGitHookPolicy' in patch || 'lockedGitHookPolicySource' in patch
  if (!updatesLock || ticket.startedAt === null || patch.startedAt === null) return

  const nextPolicy = 'lockedGitHookPolicy' in patch
    ? patch.lockedGitHookPolicy ?? null
    : ticket.lockedGitHookPolicy
  const nextSource = 'lockedGitHookPolicySource' in patch
    ? patch.lockedGitHookPolicySource ?? null
    : ticket.lockedGitHookPolicySource
  if (nextPolicy !== ticket.lockedGitHookPolicy || nextSource !== ticket.lockedGitHookPolicySource) {
    throw new Error(`Ticket Git hook configuration is immutable after start: ${ticket.externalId}`)
  }
}

function runGit(projectRoot: string, args: string[]) {
  const fullArgs = ['-C', projectRoot, ...args]
  const result = spawnSync('git', fullArgs, { encoding: 'utf8' })
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  if (result.status !== 0 || result.error) {
    const detail = result.error?.message ?? ([stdout, stderr].filter(Boolean).join(' | ') || `exit code ${result.status ?? '?'}`)
    logCmd('git', fullArgs, {
      ok: false,
      error: result.error?.message ?? `exit code ${result.status ?? '?'}`,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    })
    throw new Error(detail)
  }
  logCmd('git', fullArgs, { ok: true, stdout: stdout || undefined, stderr: stderr || undefined })
}

function removeTicketFilesystem(projectRoot: string, externalId: string, branchName?: string | null) {
  const worktreePath = getTicketWorktreePath(projectRoot, externalId)
  const baseBranch = resolveTicketBaseBranch(projectRoot, externalId)
  const resolvedBranchName = branchName?.trim() || externalId

  if (existsSync(worktreePath)) {
    removeWorktree({
      projectRoot,
      worktreesRoot: getProjectWorktreesRoot(projectRoot),
      worktreePath,
      runGit: (args) => runGit(projectRoot, args),
    })
  }

  if (resolvedBranchName !== baseBranch) {
    try {
      runGit(projectRoot, ['branch', '-D', resolvedBranchName])
    } catch {
      // Ignore missing/already-removed branches.
    }
  }
}

export function createTicket(input: {
  projectId: number
  title: string
  description?: string
  priority?: number
  manualQaOverride?: boolean | null
  aiQuestionsOverride?: boolean | null
  aiQuestionWindowOverride?: number | null
}): PublicTicket {
  const parsedInput = CreateTicketInputSchema.safeParse(input)
  if (!parsedInput.success) {
    const issues = parsedInput.error.issues
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid createTicket input: ${issues}`)
  }

  const validatedInput = parsedInput.data
  const project = getProjectContextById(validatedInput.projectId)
  if (!project) throw new Error('Project not found')

  const newCounter = (project.project.ticketCounter ?? 0) + 1
  const externalId = `${project.project.shortname}-${newCounter}`

  project.projectDb.update(projects)
    .set({ ticketCounter: newCounter, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, project.project.id))
    .run()

  const ticket = project.projectDb.insert(tickets)
    .values({
      externalId,
      projectId: project.project.id,
      title: validatedInput.title,
      description: validatedInput.description ?? null,
      priority: validatedInput.priority ?? 3,
      manualQaOverride: validatedInput.manualQaOverride ?? null,
      aiQuestionsOverride: validatedInput.aiQuestionsOverride ?? null,
      aiQuestionWindowOverride: validatedInput.aiQuestionWindowOverride ?? null,
      status: 'DRAFT',
    })
    .returning()
    .get()

  if (!ticket) {
    throw new Error(`Failed to create ticket: ${externalId}`)
  }

  const metaDir = resolve(getTicketDir(project.projectRoot, externalId), 'meta')
  mkdirSync(metaDir, { recursive: true })
  safeAtomicWrite(
    resolve(metaDir, 'ticket.meta.json'),
    JSON.stringify({
      externalId,
      title: validatedInput.title,
      createdAt: ticket.createdAt,
    }, null, 2),
  )

  const publicTicket = toPublicTicket(validatedInput.projectId, ticket)
  syncTicketRuntimeProjection(publicTicket)
  return publicTicket
}

/**
 * Atomically reserves an improvement origin and creates its Draft ticket.
 * The database mapping is the recovery source of truth if the process exits
 * before ticket-owned origin/evidence files are written.
 */
export function createManualQaImprovementTicket(input: {
  projectId: number
  originId: string
  actionId: string
  title: string
  description: string
  priority?: number
  manualQaEnabled: boolean
}): PublicTicket {
  if (!input.originId.trim() || !input.actionId.trim()) {
    throw new Error('Manual QA improvement creation requires origin and action IDs.')
  }
  const parsedInput = CreateTicketInputSchema.safeParse({
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    priority: input.priority ?? 3,
    manualQaOverride: input.manualQaEnabled,
  })
  if (!parsedInput.success) throw new Error(`Invalid Manual QA improvement ticket: ${parsedInput.error.message}`)
  const project = getProjectContextById(input.projectId)
  if (!project) throw new Error('Project not found')

  const materializeTicketFiles = (row: typeof tickets.$inferSelect): PublicTicket => {
    const metaDir = resolve(getTicketDir(project.projectRoot, row.externalId), 'meta')
    mkdirSync(metaDir, { recursive: true })
    const metaPath = resolve(metaDir, 'ticket.meta.json')
    if (!existsSync(metaPath)) {
      safeAtomicWrite(metaPath, JSON.stringify({
        externalId: row.externalId,
        title: row.title,
        createdAt: row.createdAt,
      }, null, 2))
    }
    const publicTicket = toPublicTicket(input.projectId, row)
    syncTicketRuntimeProjection(publicTicket)
    return publicTicket
  }

  const resolveExisting = (): PublicTicket | null => {
    const mapping = project.projectDb.select().from(manualQaImprovementTickets)
      .where(eq(manualQaImprovementTickets.originId, input.originId)).get()
    if (!mapping) return null
    const row = project.projectDb.select().from(tickets).where(eq(tickets.id, mapping.destinationTicketId)).get()
    if (!row) throw new Error(`Manual QA improvement mapping has no destination ticket: ${input.originId}`)
    return materializeTicketFiles(row)
  }
  const existing = resolveExisting()
  if (existing) return existing

  let created: typeof tickets.$inferSelect
  try {
    created = project.projectDb.transaction((tx) => {
      const currentProject = tx.select().from(projects).where(eq(projects.id, project.project.id)).get()
      if (!currentProject) throw new Error('Project not found while creating Manual QA improvement.')
      const newCounter = (currentProject.ticketCounter ?? 0) + 1
      const externalId = `${currentProject.shortname}-${newCounter}`
      tx.update(projects).set({ ticketCounter: newCounter, updatedAt: new Date().toISOString() })
        .where(eq(projects.id, currentProject.id)).run()
      const inserted = tx.insert(tickets).values({
        externalId,
        projectId: currentProject.id,
        title: parsedInput.data.title,
        description: parsedInput.data.description ?? null,
        priority: parsedInput.data.priority ?? 3,
        manualQaOverride: parsedInput.data.manualQaOverride,
        status: 'DRAFT',
      }).returning().get() ?? null
      if (!inserted) throw new Error(`Failed to create Manual QA improvement ticket: ${externalId}`)
      tx.insert(manualQaImprovementTickets).values({
        originId: input.originId,
        destinationTicketId: inserted.id,
        actionId: input.actionId,
      }).run()
      return inserted
    })
  } catch (error) {
    const raced = resolveExisting()
    if (raced) return raced
    throw error
  }
  return materializeTicketFiles(created)
}

export function updateTicket(ticketRef: string, patch: Partial<Pick<LocalTicketRow, 'title' | 'description' | 'priority' | 'manualQaOverride' | 'aiQuestionsOverride' | 'aiQuestionWindowOverride'>>): PublicTicket | undefined {
  const context = getTicketContext(ticketRef)
  if (!context) return undefined
  if ('manualQaOverride' in patch && context.localTicket.status !== 'DRAFT') {
    throw new Error('Manual QA override can only be changed while the ticket is in DRAFT status.')
  }
  if (('aiQuestionsOverride' in patch || 'aiQuestionWindowOverride' in patch) && context.localTicket.status !== 'DRAFT') {
    throw new Error('AI question overrides can only be changed while the ticket is in DRAFT status.')
  }
  context.projectDb.update(tickets)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(tickets.id, context.localTicketId))
    .run()
  const updated = context.projectDb.select().from(tickets).where(eq(tickets.id, context.localTicketId)).get()
  if (!updated) {
    throw new Error(`Ticket not found after update: ${ticketRef}`)
  }
  const publicTicket = toPublicTicket(context.projectId, updated)
  syncTicketRuntimeProjection(publicTicket)
  return publicTicket
}

export function patchTicket(
  ticketRef: string,
  patch: Partial<Omit<LocalTicketRow, 'id' | 'projectId' | 'externalId' | 'createdAt'>>,
): PublicTicket | undefined {
  const context = getTicketContext(ticketRef)
  if (!context) return undefined

  const previousStatus = context.localTicket.status
  if (
    'manualQaOverride' in patch
    && context.localTicket.status !== 'DRAFT'
    && patch.manualQaOverride !== context.localTicket.manualQaOverride
  ) {
    throw new Error('Manual QA override can only be changed while the ticket is in DRAFT status.')
  }
  if (
    context.localTicket.status !== 'DRAFT'
    && (
      ('aiQuestionsOverride' in patch && patch.aiQuestionsOverride !== context.localTicket.aiQuestionsOverride)
      || ('aiQuestionWindowOverride' in patch && patch.aiQuestionWindowOverride !== context.localTicket.aiQuestionWindowOverride)
    )
  ) {
    throw new Error('AI question overrides can only be changed while the ticket is in DRAFT status.')
  }
  assertLockedModelConfigurationMutable(context.localTicket, patch)
  assertLockedConfigurationMutable(context.localTicket, patch, LOCKED_MANUAL_QA_FIELDS, 'Manual QA')
  assertLockedConfigurationMutable(context.localTicket, patch, LOCKED_AI_QUESTION_FIELDS, 'AI question')
  assertLockedGitHookConfigurationMutable(context.localTicket, patch)
  const statusChanged = typeof patch.status === 'string' && patch.status !== previousStatus

  context.projectDb.update(tickets)
    .set({
      ...patch,
      workflowRevision: statusChanged
        ? context.localTicket.workflowRevision + 1
        : context.localTicket.workflowRevision,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tickets.id, context.localTicketId))
    .run()

  const updated = context.projectDb.select().from(tickets).where(eq(tickets.id, context.localTicketId)).get()
  if (!updated) {
    throw new Error(`Ticket not found after patch: ${ticketRef}`)
  }

  if (statusChanged) {
    context.projectDb.insert(ticketStatusHistory)
      .values({
        ticketId: context.localTicketId,
        previousStatus,
        newStatus: patch.status!,
        reason: typeof patch.errorMessage === 'string' ? patch.errorMessage : null,
      })
      .run()
  }

  const publicTicket = toPublicTicket(context.projectId, updated)
  syncTicketRuntimeProjection(publicTicket)
  return publicTicket
}

export function lockTicketStartConfiguration(
  ticketRef: string,
  input: {
    branchName: string | null
    startedAt: string
    lockedMainImplementer: string
    lockedMainImplementerVariant?: string | null
    lockedCouncilMembers: string[]
    lockedCouncilMemberVariants?: Record<string, string> | null
    lockedInterviewQuestions: number
    lockedCoverageFollowUpBudgetPercent: number
    lockedMaxCoveragePasses: number
    lockedMaxPrdCoveragePasses: number
    lockedMaxBeadsCoveragePasses: number
    lockedStructuredRetryCount: number
    lockedManualQaEnabled?: boolean
    lockedManualQaSource?: 'profile' | 'project' | 'ticket'
    lockedAiQuestionsEnabled?: boolean
    lockedAiQuestionsSource?: 'profile' | 'project' | 'ticket'
    lockedAiQuestionWindow?: number
    lockedAiQuestionWindowSource?: 'profile' | 'project' | 'ticket'
    lockedGitHookPolicy?: 'observe_only' | 'validate_advisory' | 'validate_required' | 'use_native_hooks'
    lockedGitHookPolicySource?: 'profile' | 'project'
  },
): PublicTicket | undefined {
  const context = getTicketContext(ticketRef)
  if (!context) return undefined

  const lockedMainImplementer = normalizeModelId(input.lockedMainImplementer)
  const lockedCouncilMembers = normalizeModelList(input.lockedCouncilMembers)

  if (!lockedMainImplementer) {
    throw new Error('Locked main implementer is required.')
  }
  if (lockedCouncilMembers.length === 0) {
    throw new Error('Locked council members are required.')
  }

  const lockedCouncilMembersRaw = JSON.stringify(lockedCouncilMembers)
  const lockedCouncilMemberVariantsRaw = input.lockedCouncilMemberVariants
    ? JSON.stringify(input.lockedCouncilMemberVariants)
    : null
  assertLockedModelConfigurationMutable(context.localTicket, {
    lockedMainImplementer,
    lockedMainImplementerVariant: input.lockedMainImplementerVariant ?? null,
    lockedCouncilMembers: lockedCouncilMembersRaw,
    lockedCouncilMemberVariants: lockedCouncilMemberVariantsRaw,
  })
  assertLockedConfigurationMutable(context.localTicket, {
    lockedManualQaEnabled: input.lockedManualQaEnabled ?? false,
    lockedManualQaSource: input.lockedManualQaSource ?? 'profile',
  }, LOCKED_MANUAL_QA_FIELDS, 'Manual QA')
  assertLockedConfigurationMutable(context.localTicket, {
    lockedAiQuestionsEnabled: input.lockedAiQuestionsEnabled ?? false,
    lockedAiQuestionsSource: input.lockedAiQuestionsSource ?? 'profile',
    lockedAiQuestionWindow: input.lockedAiQuestionWindow ?? AI_QUESTION_WINDOW_DEFAULT_MS,
    lockedAiQuestionWindowSource: input.lockedAiQuestionWindowSource ?? 'profile',
  }, LOCKED_AI_QUESTION_FIELDS, 'AI question')
  assertLockedGitHookConfigurationMutable(context.localTicket, {
    lockedGitHookPolicy: input.lockedGitHookPolicy ?? 'validate_advisory',
    lockedGitHookPolicySource: input.lockedGitHookPolicySource ?? 'profile',
  })

  const meta = lockTicketModelSelection(context.projectRoot, context.externalId, {
    startedAt: input.startedAt,
    lockedMainImplementer,
    lockedCouncilMembers,
  })

  context.projectDb.update(tickets)
    .set({
      branchName: input.branchName,
      lockedMainImplementer,
      lockedMainImplementerVariant: input.lockedMainImplementerVariant ?? null,
      lockedCouncilMembers: lockedCouncilMembersRaw,
      lockedCouncilMemberVariants: lockedCouncilMemberVariantsRaw,
      lockedInterviewQuestions: input.lockedInterviewQuestions,
      lockedCoverageFollowUpBudgetPercent: input.lockedCoverageFollowUpBudgetPercent,
      lockedMaxCoveragePasses: input.lockedMaxCoveragePasses,
      lockedMaxPrdCoveragePasses: input.lockedMaxPrdCoveragePasses,
      lockedMaxBeadsCoveragePasses: input.lockedMaxBeadsCoveragePasses,
      lockedStructuredRetryCount: input.lockedStructuredRetryCount,
      lockedManualQaEnabled: input.lockedManualQaEnabled ?? false,
      lockedManualQaSource: input.lockedManualQaSource ?? 'profile',
      lockedAiQuestionsEnabled: input.lockedAiQuestionsEnabled ?? false,
      lockedAiQuestionsSource: input.lockedAiQuestionsSource ?? 'profile',
      lockedAiQuestionWindow: input.lockedAiQuestionWindow ?? AI_QUESTION_WINDOW_DEFAULT_MS,
      lockedAiQuestionWindowSource: input.lockedAiQuestionWindowSource ?? 'profile',
      lockedGitHookPolicy: input.lockedGitHookPolicy ?? 'validate_advisory',
      lockedGitHookPolicySource: input.lockedGitHookPolicySource ?? 'profile',
      startedAt: meta.startedAt ?? input.startedAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tickets.id, context.localTicketId))
    .run()

  const updated = context.projectDb.select().from(tickets).where(eq(tickets.id, context.localTicketId)).get()
  if (!updated) {
    throw new Error(`Ticket not found after locking start configuration: ${ticketRef}`)
  }
  return toPublicTicket(context.projectId, updated)
}

export function deleteTicket(ticketRef: string): boolean {
  const context = getTicketContext(ticketRef)
  if (!context) return false

  const { localTicketId, projectDb, projectRoot, externalId } = context
  const branchName = context.localTicket.branchName

  projectDb.transaction((tx) => {
    tx.delete(phaseArtifacts).where(eq(phaseArtifacts.ticketId, localTicketId)).run()
    tx.delete(opencodeSessions).where(eq(opencodeSessions.ticketId, localTicketId)).run()
    tx.delete(ticketPhaseAttempts).where(eq(ticketPhaseAttempts.ticketId, localTicketId)).run()
    tx.delete(ticketErrorOccurrences).where(eq(ticketErrorOccurrences.ticketId, localTicketId)).run()
    tx.delete(ticketStatusHistory).where(eq(ticketStatusHistory.ticketId, localTicketId)).run()
    tx.delete(tickets).where(eq(tickets.id, localTicketId)).run()
  })

  // Filesystem removal happens after DB transaction succeeds.
  // If it fails, the DB is the source of truth and the orphaned
  // filesystem can be cleaned up later.
  try {
    removeTicketFilesystem(projectRoot, externalId, branchName)
  } catch (err) {
    console.warn(`[ticketMutations] Filesystem cleanup failed for ${ticketRef} after DB deletion:`, err)
  }

  return true
}

export function cleanupCanceledTicketData(
  ticketRef: string,
  opts: { deleteContent?: boolean; deleteLog?: boolean },
): boolean {
  const context = getTicketContext(ticketRef)
  if (!context) return false

  const { localTicketId, projectDb, projectRoot, externalId } = context
  const branchName = context.localTicket.branchName

  if (opts.deleteContent) {
    removeTicketFilesystem(projectRoot, externalId, branchName)
    projectDb.transaction((tx) => {
      tx.delete(phaseArtifacts).where(eq(phaseArtifacts.ticketId, localTicketId)).run()
      tx.delete(opencodeSessions).where(eq(opencodeSessions.ticketId, localTicketId)).run()
    })
  } else if (opts.deleteLog) {
    for (const logPath of [
      getTicketExecutionLogPath(projectRoot, externalId),
      getTicketDebugLogPath(projectRoot, externalId),
      getTicketAiLogPath(projectRoot, externalId),
    ]) {
      if (existsSync(logPath)) {
        rmSync(logPath, { force: true })
      }
    }
  }

  return true
}
