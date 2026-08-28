import { createActor } from 'xstate'
import { ticketMachine } from './ticketMachine'
import { STATUS_TO_PHASE, TERMINAL_STATES, normalizeSettingSource, type ManualQaConfigurationSource, type SettingSource, type TicketContext } from './types'
import { PROFILE_DEFAULTS } from '../db/defaults'
import { attachWorkflowRunner } from '../workflow/runner'
import { broadcaster } from '../sse/broadcaster'
import { appendLogEvent, createLogEvent } from '../log/executionLog'
import {
  ensureActivePhaseAttempt,
  findTicketRefByLocalId,
  getTicketByRef,
  getTicketContext,
  isDisplayOnlyMockTicket,
  listNonTerminalTickets,
  patchTicket,
  parseLockedCouncilMembers,
  parseLockedCouncilMemberVariants,
  recordTicketErrorOccurrence,
  resolveLatestTicketErrorOccurrence,
} from '../storage/tickets'
import { normalizeBlockedErrorDiagnostics, type BlockedErrorDiagnostics } from '@shared/errorDiagnostics'
import { getErrorMessage } from '@shared/typeGuards'

const activeActors = new Map<string, ReturnType<typeof createActor<typeof ticketMachine>>>()

type TicketActorInput = {
  ticketId: string
  projectId: number
  externalId: string
  title: string
  maxIterations?: number
  lockedMainImplementer?: string | null
  lockedMainImplementerVariant?: string | null
  lockedCouncilMembers?: string[] | null
  lockedCouncilMemberVariants?: Record<string, string> | null
  lockedInterviewQuestions?: number | null
  lockedCoverageFollowUpBudgetPercent?: number | null
  lockedMaxCoveragePasses?: number | null
  lockedMaxPrdCoveragePasses?: number | null
  lockedMaxBeadsCoveragePasses?: number | null
  lockedStructuredRetryCount?: number | null
  lockedManualQaEnabled?: boolean | null
  lockedManualQaSource?: ManualQaConfigurationSource | null
  lockedAiQuestionsEnabled?: boolean | null
  lockedAiQuestionsSource?: SettingSource | null
  lockedAiQuestionWindow?: number | null
  lockedAiQuestionWindowSource?: SettingSource | null
}

function isKnownWorkflowState(status: string): boolean {
  return Object.prototype.hasOwnProperty.call(STATUS_TO_PHASE, status)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getSnapshotStateValue(snapshot: unknown): string | null {
  if (!isRecord(snapshot)) return null
  return typeof snapshot.value === 'string' ? snapshot.value : null
}

function getSnapshotContext(snapshot: unknown): Record<string, unknown> | null {
  return isRecord(snapshot) && isRecord(snapshot.context) ? snapshot.context : null
}

function buildMachineContext(
  input: TicketActorInput,
  options: {
    status: string
    previousStatus?: string | null
    error?: string | null
    errorCodes?: string[]
    errorDiagnostics?: BlockedErrorDiagnostics | null
    createdAt?: string | null
    updatedAt?: string | null
  },
): TicketContext {
  return {
    ticketId: input.ticketId,
    projectId: input.projectId,
    externalId: input.externalId,
    title: input.title,
    status: options.status,
    lockedMainImplementer: input.lockedMainImplementer ?? null,
    lockedMainImplementerVariant: input.lockedMainImplementerVariant ?? null,
    lockedCouncilMembers: input.lockedCouncilMembers ?? null,
    lockedCouncilMemberVariants: input.lockedCouncilMemberVariants ?? null,
    lockedInterviewQuestions: input.lockedInterviewQuestions ?? null,
    lockedCoverageFollowUpBudgetPercent: input.lockedCoverageFollowUpBudgetPercent ?? null,
    lockedMaxCoveragePasses: input.lockedMaxCoveragePasses ?? null,
    lockedMaxPrdCoveragePasses: input.lockedMaxPrdCoveragePasses ?? null,
    lockedMaxBeadsCoveragePasses: input.lockedMaxBeadsCoveragePasses ?? null,
    lockedStructuredRetryCount: input.lockedStructuredRetryCount ?? null,
    lockedManualQaEnabled: input.lockedManualQaEnabled ?? null,
    lockedManualQaSource: input.lockedManualQaSource ?? null,
    lockedAiQuestionsEnabled: input.lockedAiQuestionsEnabled ?? null,
    lockedAiQuestionsSource: input.lockedAiQuestionsSource ?? null,
    lockedAiQuestionWindow: input.lockedAiQuestionWindow ?? null,
    lockedAiQuestionWindowSource: input.lockedAiQuestionWindowSource ?? null,
    pendingExecutionSetupPlanRequestArtifactId: null,
    previousStatus: options.previousStatus ?? null,
    error: options.error ?? null,
    errorCodes: options.errorCodes ?? [],
    errorDiagnostics: options.errorDiagnostics ?? null,
    blockedErrorResolution: null,
    beadProgress: { total: 0, completed: 0, current: null },
    iterationCount: 0,
    maxIterations: input.maxIterations ?? PROFILE_DEFAULTS.maxIterations,
    councilResults: null,
    createdAt: options.createdAt ?? new Date().toISOString(),
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  }
}

function buildPersistedSnapshot(
  input: TicketActorInput,
  options: {
    status: string
    previousStatus?: string | null
    error?: string | null
    errorCodes?: string[]
    errorDiagnostics?: BlockedErrorDiagnostics | null
    createdAt?: string | null
    updatedAt?: string | null
  },
) {
  return {
    status: TERMINAL_STATES.includes(options.status as (typeof TERMINAL_STATES)[number]) ? 'done' : 'active',
    value: options.status,
    historyValue: {},
    context: buildMachineContext(input, options),
    children: {},
  }
}

function reconcileSnapshotForTicket(
  ticketRef: string,
  rawSnapshot: unknown,
  input: TicketActorInput,
  dbStatus: string,
): unknown | null {
  if (!isKnownWorkflowState(dbStatus)) return null

  const snapshotStatus = getSnapshotStateValue(rawSnapshot)
  if (!snapshotStatus || !isKnownWorkflowState(snapshotStatus)) return null

  const context = getSnapshotContext(rawSnapshot)
  if (!context) return null

  if (snapshotStatus !== dbStatus) {
    context.previousStatus = snapshotStatus
    context.status = dbStatus
    const mutableSnapshot = rawSnapshot as Record<string, unknown>
    mutableSnapshot.value = dbStatus
  }

  context.ticketId = input.ticketId
  context.projectId = input.projectId
  context.externalId = input.externalId
  context.title = input.title
  context.lockedMainImplementer = input.lockedMainImplementer ?? null
  context.lockedMainImplementerVariant = input.lockedMainImplementerVariant ?? null
  context.lockedCouncilMembers = input.lockedCouncilMembers ?? null
  context.lockedCouncilMemberVariants = input.lockedCouncilMemberVariants ?? null
  context.lockedInterviewQuestions = input.lockedInterviewQuestions ?? null
  context.lockedCoverageFollowUpBudgetPercent = input.lockedCoverageFollowUpBudgetPercent ?? null
  context.lockedMaxCoveragePasses = input.lockedMaxCoveragePasses ?? null
  context.lockedMaxPrdCoveragePasses = input.lockedMaxPrdCoveragePasses ?? null
  context.lockedMaxBeadsCoveragePasses = input.lockedMaxBeadsCoveragePasses ?? null
  context.lockedStructuredRetryCount = input.lockedStructuredRetryCount ?? null
  context.lockedManualQaEnabled = input.lockedManualQaEnabled ?? null
  context.lockedManualQaSource = input.lockedManualQaSource ?? null
  context.lockedAiQuestionsEnabled = input.lockedAiQuestionsEnabled ?? null
  context.lockedAiQuestionsSource = input.lockedAiQuestionsSource ?? null
  context.lockedAiQuestionWindow = input.lockedAiQuestionWindow ?? null
  context.lockedAiQuestionWindowSource = input.lockedAiQuestionWindowSource ?? null
  if (
    typeof context.pendingExecutionSetupPlanRequestArtifactId !== 'number'
    || !Number.isFinite(context.pendingExecutionSetupPlanRequestArtifactId)
  ) {
    context.pendingExecutionSetupPlanRequestArtifactId = null
  }

  if (
    dbStatus === 'BLOCKED_ERROR'
    && (typeof context.previousStatus !== 'string' || !isKnownWorkflowState(context.previousStatus))
  ) {
    const durablePreviousStatus = getTicketByRef(ticketRef)?.previousStatus
    if (durablePreviousStatus) {
      context.previousStatus = durablePreviousStatus
    }
  }

  context.status = dbStatus
  if (typeof context.maxIterations !== 'number') {
    context.maxIterations = input.maxIterations ?? PROFILE_DEFAULTS.maxIterations
  }
  if (!isRecord(context.beadProgress)) {
    context.beadProgress = { total: 0, completed: 0, current: null }
  }
  if (!Array.isArray(context.errorCodes)) {
    context.errorCodes = []
  }
  context.errorDiagnostics = normalizeBlockedErrorDiagnostics(context.errorDiagnostics)
  if (context.blockedErrorResolution !== 'RETRIED' && context.blockedErrorResolution !== 'CONTINUED') {
    context.blockedErrorResolution = null
  }

  return rawSnapshot
}

function recoverSnapshotForTicket(
  ticketRef: string,
  input: TicketActorInput,
  dbStatus: string,
  errorMessage?: string | null,
): unknown | null {
  if (!isKnownWorkflowState(dbStatus)) return null
  const ticket = getTicketByRef(ticketRef)
  const previousStatus = dbStatus === 'BLOCKED_ERROR'
    ? ticket?.previousStatus ?? null
    : null

  const snapshot = buildPersistedSnapshot(input, {
    status: dbStatus,
    previousStatus,
    error: dbStatus === 'BLOCKED_ERROR' ? errorMessage ?? ticket?.errorMessage ?? null : null,
    createdAt: ticket?.createdAt,
    updatedAt: ticket?.updatedAt,
  })

  patchTicket(ticketRef, {
    status: dbStatus,
    xstateSnapshot: JSON.stringify(snapshot),
    errorMessage: dbStatus === 'BLOCKED_ERROR' ? errorMessage ?? ticket?.errorMessage ?? null : null,
  })

  return snapshot
}

function blockTicketForSnapshotRecovery(
  ticketRef: string,
  input: TicketActorInput,
  failedStatus: string,
  cause: unknown,
): unknown {
  const blockedFromStatus = isKnownWorkflowState(failedStatus) && failedStatus !== 'BLOCKED_ERROR'
    ? failedStatus
    : getTicketByRef(ticketRef)?.previousStatus ?? 'DRAFT'
  const message = `Ticket workflow snapshot could not be restored safely. Retry will resume from ${blockedFromStatus}. Details: ${getErrorMessage(cause)}`
  const snapshot = buildPersistedSnapshot(input, {
    status: 'BLOCKED_ERROR',
    previousStatus: blockedFromStatus,
    error: message,
    errorCodes: ['SNAPSHOT_RECOVERY_FAILED'],
    errorDiagnostics: null,
  })

  const existing = getTicketByRef(ticketRef)
  patchTicket(ticketRef, {
    status: 'BLOCKED_ERROR',
    xstateSnapshot: JSON.stringify(snapshot),
    errorMessage: message,
  })
  if (existing?.status !== 'BLOCKED_ERROR') {
    recordTicketErrorOccurrence(ticketRef, {
      blockedFromStatus,
      errorMessage: message,
      errorCodes: ['SNAPSHOT_RECOVERY_FAILED'],
    })
  }
  emitAppErrorLog(ticketRef, 'BLOCKED_ERROR', `[SYS] ${message}`, {
    message,
    blockedFrom: blockedFromStatus,
    blockedTo: 'BLOCKED_ERROR',
    errorCodes: ['SNAPSHOT_RECOVERY_FAILED'],
  })

  return snapshot
}

function resolveTicketRef(ticketRef: string | number): string {
  if (typeof ticketRef === 'string' && ticketRef.includes(':')) return ticketRef
  const numericId = typeof ticketRef === 'number' ? ticketRef : Number(ticketRef)
  if (!Number.isNaN(numericId)) {
    const resolved = findTicketRefByLocalId(numericId)
    if (resolved) return resolved
  }
  return String(ticketRef)
}

function getStateValue(actor: ReturnType<typeof createActor<typeof ticketMachine>>): string {
  const snapshot = actor.getSnapshot()
  return typeof snapshot.value === 'string' ? snapshot.value : JSON.stringify(snapshot.value)
}

function emitAppErrorLog(
  ticketRef: string,
  phase: string,
  content: string,
  data?: Record<string, unknown>,
) {
  const timestamp = new Date().toISOString()
  const emissionData = data ? { ...data, timestamp } : { timestamp }
  const structuredExtra = {
    audience: 'all' as const,
    kind: 'error' as const,
    op: 'append' as const,
    streaming: false,
    ...(typeof data?.phaseAttempt === 'number' && Number.isFinite(data.phaseAttempt) ? { phaseAttempt: data.phaseAttempt } : {}),
  }
  const event = createLogEvent(
    ticketRef,
    'error',
    phase,
    content,
    emissionData,
    'error',
    phase,
    structuredExtra,
  )
  broadcaster.broadcast(ticketRef, 'log', { ...event })
  appendLogEvent(ticketRef, 'error', phase, content, emissionData, 'error', phase, structuredExtra)
}

function attachPersistenceSubscription(
  ticketRef: string,
  actor: ReturnType<typeof createActor<typeof ticketMachine>>,
  options?: { skipFirstPersist?: boolean },
) {
  let isFirstEmission = true

  actor.subscribe(() => {
    const skipPersist = isFirstEmission && options?.skipFirstPersist
    if (isFirstEmission) {
      isFirstEmission = false
    }

    if (!skipPersist) {
      persistSnapshot(ticketRef, actor)
    }

    if (actor.getSnapshot().status === 'done') {
      activeActors.delete(ticketRef)
    }
  })
}

export function ensureActorForTicket(ticketRef: string | number) {
  const resolvedTicketRef = resolveTicketRef(ticketRef)
  const existing = activeActors.get(resolvedTicketRef)
  if (existing) return existing

  const ticket = getTicketContext(resolvedTicketRef)
  if (!ticket) throw new Error(`Ticket ${resolvedTicketRef} not found`)
  if (TERMINAL_STATES.includes(ticket.localTicket.status as (typeof TERMINAL_STATES)[number])) {
    throw new Error(`Ticket ${resolvedTicketRef} is terminal (${ticket.localTicket.status})`)
  }
  if (isDisplayOnlyMockTicket(ticket.localTicket)) {
    throw new Error(`Ticket ${resolvedTicketRef} is a display-only mock ticket and cannot run workflow actors`)
  }

  const input = {
    ticketId: resolvedTicketRef,
    projectId: ticket.projectId,
    externalId: ticket.externalId,
    title: ticket.localTicket.title,
    maxIterations: ticket.localProject.maxIterations ?? PROFILE_DEFAULTS.maxIterations,
    lockedMainImplementer: ticket.localTicket.lockedMainImplementer ?? null,
    lockedMainImplementerVariant: ticket.localTicket.lockedMainImplementerVariant ?? null,
    lockedCouncilMembers: parseLockedCouncilMembers(ticket.localTicket.lockedCouncilMembers),
    lockedCouncilMemberVariants: parseLockedCouncilMemberVariants(ticket.localTicket.lockedCouncilMemberVariants),
    lockedInterviewQuestions: ticket.localTicket.lockedInterviewQuestions ?? null,
    lockedCoverageFollowUpBudgetPercent: ticket.localTicket.lockedCoverageFollowUpBudgetPercent ?? null,
    lockedMaxCoveragePasses: ticket.localTicket.lockedMaxCoveragePasses ?? null,
    lockedMaxPrdCoveragePasses: ticket.localTicket.lockedMaxPrdCoveragePasses ?? null,
    lockedMaxBeadsCoveragePasses: ticket.localTicket.lockedMaxBeadsCoveragePasses ?? null,
    lockedStructuredRetryCount: ticket.localTicket.lockedStructuredRetryCount ?? null,
    lockedManualQaEnabled: ticket.localTicket.lockedManualQaEnabled ?? null,
    lockedManualQaSource: normalizeSettingSource(ticket.localTicket.lockedManualQaSource),
    lockedAiQuestionsEnabled: ticket.localTicket.lockedAiQuestionsEnabled ?? null,
    lockedAiQuestionsSource: normalizeSettingSource(ticket.localTicket.lockedAiQuestionsSource),
    lockedAiQuestionWindow: ticket.localTicket.lockedAiQuestionWindow ?? null,
    lockedAiQuestionWindowSource: normalizeSettingSource(ticket.localTicket.lockedAiQuestionWindowSource),
  }

  if (ticket.localTicket.xstateSnapshot) {
    try {
      const rawSnapshot = JSON.parse(ticket.localTicket.xstateSnapshot)
      const snapshot = reconcileSnapshotForTicket(resolvedTicketRef, rawSnapshot, input, ticket.localTicket.status)
      if (snapshot) {
        return hydrateTicketActor(resolvedTicketRef, snapshot, input)
      }
      if (ticket.localTicket.status !== 'DRAFT') {
        return hydrateTicketActor(
          resolvedTicketRef,
          blockTicketForSnapshotRecovery(resolvedTicketRef, input, ticket.localTicket.status, new Error('Invalid workflow snapshot shape')),
          input,
        )
      }
    } catch (err) {
      if (ticket.localTicket.status !== 'DRAFT') {
        return hydrateTicketActor(
          resolvedTicketRef,
          blockTicketForSnapshotRecovery(resolvedTicketRef, input, ticket.localTicket.status, err),
          input,
        )
      }
    }
  }

  if (ticket.localTicket.status !== 'DRAFT') {
    const snapshot = recoverSnapshotForTicket(
      resolvedTicketRef,
      input,
      ticket.localTicket.status,
      ticket.localTicket.errorMessage,
    )
    if (snapshot) return hydrateTicketActor(resolvedTicketRef, snapshot, input)
  }

  return createTicketActor(resolvedTicketRef, input)
}

function persistSnapshot(
  ticketRef: string | number,
  actor: ReturnType<typeof createActor<typeof ticketMachine>>,
) {
  const resolvedTicketRef = resolveTicketRef(ticketRef)
  const existing = getTicketContext(resolvedTicketRef)
  if (!existing) return

  const snapshot = actor.getPersistedSnapshot()
  const currentSnapshot = actor.getSnapshot()
  const stateValue = typeof currentSnapshot.value === 'string' ? currentSnapshot.value : JSON.stringify(currentSnapshot.value)
  const previousStatus = existing.localTicket.status
  const errorMessage = typeof currentSnapshot.context.error === 'string' && currentSnapshot.context.error.trim().length > 0
    ? currentSnapshot.context.error
    : null
  const errorCodes = Array.isArray(currentSnapshot.context.errorCodes)
    ? currentSnapshot.context.errorCodes.filter((code): code is string => typeof code === 'string' && code.trim().length > 0)
    : []
  const errorDiagnostics = normalizeBlockedErrorDiagnostics(currentSnapshot.context.errorDiagnostics)
  const transitionAt = new Date().toISOString()

  const updated = patchTicket(resolvedTicketRef, {
    xstateSnapshot: JSON.stringify(snapshot),
    status: stateValue,
    errorMessage,
  })

  if (!updated) return

  if (previousStatus !== stateValue) {
    const phaseAttempt = ensureActivePhaseAttempt(resolvedTicketRef, stateValue)
    const payload = {
      ticketId: ticketRef,
      from: previousStatus ?? 'unknown',
      to: stateValue,
      previousStatus: previousStatus ?? null,
      phaseAttempt,
      workflowRevision: updated.workflowRevision,
    }
    broadcaster.broadcast(resolvedTicketRef, 'state_change', payload)
    appendLogEvent(
      resolvedTicketRef,
      'state_change',
      stateValue,
      `[SYS] Transition: ${payload.from} -> ${payload.to}`,
      { ...payload, timestamp: new Date().toISOString() },
      'system',
      stateValue,
      { audience: 'all', kind: 'milestone', op: 'append', streaming: false, phaseAttempt },
    )

    if (stateValue === 'BLOCKED_ERROR') {
      const blockedMessage = errorMessage ?? 'Unknown error'
      recordTicketErrorOccurrence(resolvedTicketRef, {
        blockedFromStatus: payload.from,
        errorMessage,
        errorCodes,
        diagnostics: errorDiagnostics,
        occurredAt: transitionAt,
      })
      emitAppErrorLog(
        resolvedTicketRef,
        stateValue,
        `[SYS] Blocked in ${payload.from}: ${blockedMessage}`,
        {
          message: blockedMessage,
          blockedFrom: payload.from,
          blockedTo: payload.to,
          phaseAttempt,
          errorCodes,
          ...(errorDiagnostics ? { diagnostics: errorDiagnostics } : {}),
        },
      )
    } else if (previousStatus === 'BLOCKED_ERROR') {
      const resolutionStatus = stateValue === 'CANCELED'
        ? 'CANCELED'
        : currentSnapshot.context.blockedErrorResolution === 'CONTINUED'
          ? 'CONTINUED'
          : 'RETRIED'
      resolveLatestTicketErrorOccurrence(resolvedTicketRef, {
        resolutionStatus,
        resumedToStatus: stateValue === 'CANCELED' ? null : stateValue,
        resolvedAt: transitionAt,
      })
    }
  }
}

export function createTicketActor(
  ticketRef: string | number,
  input: TicketActorInput,
) {
  const resolvedTicketRef = resolveTicketRef(ticketRef)
  const actor = createActor(ticketMachine, {
    input: {
      ticketId: input.ticketId,
      projectId: input.projectId,
      externalId: input.externalId,
      title: input.title,
      maxIterations: input.maxIterations ?? PROFILE_DEFAULTS.maxIterations,
      lockedMainImplementer: input.lockedMainImplementer ?? null,
      lockedMainImplementerVariant: input.lockedMainImplementerVariant ?? null,
      lockedCouncilMembers: input.lockedCouncilMembers ?? null,
      lockedCouncilMemberVariants: input.lockedCouncilMemberVariants ?? null,
      lockedInterviewQuestions: input.lockedInterviewQuestions ?? null,
      lockedCoverageFollowUpBudgetPercent: input.lockedCoverageFollowUpBudgetPercent ?? null,
      lockedMaxCoveragePasses: input.lockedMaxCoveragePasses ?? null,
      lockedMaxPrdCoveragePasses: input.lockedMaxPrdCoveragePasses ?? null,
      lockedMaxBeadsCoveragePasses: input.lockedMaxBeadsCoveragePasses ?? null,
      lockedStructuredRetryCount: input.lockedStructuredRetryCount ?? null,
      lockedManualQaEnabled: input.lockedManualQaEnabled ?? null,
      lockedManualQaSource: input.lockedManualQaSource ?? null,
      lockedAiQuestionsEnabled: input.lockedAiQuestionsEnabled ?? null,
      lockedAiQuestionsSource: input.lockedAiQuestionsSource ?? null,
      lockedAiQuestionWindow: input.lockedAiQuestionWindow ?? null,
      lockedAiQuestionWindowSource: input.lockedAiQuestionWindowSource ?? null,
    },
  })

  attachPersistenceSubscription(resolvedTicketRef, actor)

  actor.start()
  activeActors.set(resolvedTicketRef, actor)
  attachWorkflowRunner(resolvedTicketRef, actor, (event) => actor.send(event))
  return actor
}

function hydrateTicketActor(
  ticketRef: string | number,
  snapshot: unknown,
  input: TicketActorInput,
  options?: { skipFirstPersist?: boolean; skipInitialWorkflowRun?: boolean },
) {
  const resolvedTicketRef = resolveTicketRef(ticketRef)
  const actor = createActor(ticketMachine, {
    snapshot: snapshot as Parameters<typeof createActor<typeof ticketMachine>>[1] extends { snapshot?: infer S } ? S : never,
    input: {
      ticketId: input.ticketId,
      projectId: input.projectId,
      externalId: input.externalId,
      title: input.title,
      maxIterations: input.maxIterations ?? PROFILE_DEFAULTS.maxIterations,
      lockedMainImplementer: input.lockedMainImplementer ?? null,
      lockedMainImplementerVariant: input.lockedMainImplementerVariant ?? null,
      lockedCouncilMembers: input.lockedCouncilMembers ?? null,
      lockedCouncilMemberVariants: input.lockedCouncilMemberVariants ?? null,
      lockedInterviewQuestions: input.lockedInterviewQuestions ?? null,
      lockedCoverageFollowUpBudgetPercent: input.lockedCoverageFollowUpBudgetPercent ?? null,
      lockedMaxCoveragePasses: input.lockedMaxCoveragePasses ?? null,
      lockedMaxPrdCoveragePasses: input.lockedMaxPrdCoveragePasses ?? null,
      lockedMaxBeadsCoveragePasses: input.lockedMaxBeadsCoveragePasses ?? null,
      lockedStructuredRetryCount: input.lockedStructuredRetryCount ?? null,
      lockedManualQaEnabled: input.lockedManualQaEnabled ?? null,
      lockedManualQaSource: input.lockedManualQaSource ?? null,
      lockedAiQuestionsEnabled: input.lockedAiQuestionsEnabled ?? null,
      lockedAiQuestionsSource: input.lockedAiQuestionsSource ?? null,
      lockedAiQuestionWindow: input.lockedAiQuestionWindow ?? null,
      lockedAiQuestionWindowSource: input.lockedAiQuestionWindowSource ?? null,
    },
  })

  attachPersistenceSubscription(resolvedTicketRef, actor, {
    skipFirstPersist: options?.skipFirstPersist ?? true,
  })

  actor.start()
  activeActors.set(resolvedTicketRef, actor)
  attachWorkflowRunner(resolvedTicketRef, actor, (event) => actor.send(event), {
    processInitialSnapshot: options?.skipInitialWorkflowRun !== true,
  })
  return actor
}

export function hydrateAllTickets() {
  const nonTerminalTickets = listNonTerminalTickets()

  let hydrated = 0
  for (const ticket of nonTerminalTickets) {
    const input: TicketActorInput = {
      ticketId: ticket.id,
      projectId: ticket.projectId,
      externalId: ticket.externalId,
      title: ticket.title,
      maxIterations: ticket.runtime.maxIterations ?? PROFILE_DEFAULTS.maxIterations,
      lockedMainImplementer: ticket.lockedMainImplementer ?? null,
      lockedMainImplementerVariant: ticket.lockedMainImplementerVariant ?? null,
      lockedCouncilMembers: ticket.lockedCouncilMembers.length > 0 ? ticket.lockedCouncilMembers : null,
      lockedCouncilMemberVariants: ticket.lockedCouncilMemberVariants ?? null,
      lockedInterviewQuestions: ticket.lockedInterviewQuestions ?? null,
      lockedCoverageFollowUpBudgetPercent: ticket.lockedCoverageFollowUpBudgetPercent ?? null,
      lockedMaxCoveragePasses: ticket.lockedMaxCoveragePasses ?? null,
      lockedMaxPrdCoveragePasses: ticket.lockedMaxPrdCoveragePasses ?? null,
      lockedMaxBeadsCoveragePasses: ticket.lockedMaxBeadsCoveragePasses ?? null,
      lockedStructuredRetryCount: ticket.lockedStructuredRetryCount ?? null,
      lockedManualQaEnabled: ticket.lockedManualQaEnabled ?? null,
      lockedManualQaSource: normalizeSettingSource(ticket.lockedManualQaSource),
      lockedAiQuestionsEnabled: ticket.lockedAiQuestionsEnabled ?? null,
      lockedAiQuestionsSource: normalizeSettingSource(ticket.lockedAiQuestionsSource),
      lockedAiQuestionWindow: ticket.lockedAiQuestionWindow ?? null,
      lockedAiQuestionWindowSource: normalizeSettingSource(ticket.lockedAiQuestionWindowSource),
    }

    try {
      let snapshot: unknown | null = null
      if (ticket.xstateSnapshot) {
        const rawSnapshot = JSON.parse(ticket.xstateSnapshot)
        snapshot = reconcileSnapshotForTicket(ticket.id, rawSnapshot, input, ticket.status)
      } else if (ticket.status !== 'DRAFT') {
        snapshot = recoverSnapshotForTicket(ticket.id, input, ticket.status, ticket.errorMessage)
      }

      if (!snapshot && ticket.status !== 'DRAFT') {
        snapshot = blockTicketForSnapshotRecovery(ticket.id, input, ticket.status, new Error('Missing or invalid workflow snapshot'))
      }

      if (!snapshot) continue
      hydrateTicketActor(ticket.id, snapshot, input)
      hydrated++
    } catch (err) {
      try {
        if (ticket.status !== 'DRAFT') {
          hydrateTicketActor(ticket.id, blockTicketForSnapshotRecovery(ticket.id, input, ticket.status, err), input)
          hydrated++
          continue
        }
      } catch (blockErr) {
        console.error(`[persistence] Failed to block ticket ${ticket.externalId} after snapshot recovery failure:`, blockErr)
      }
      console.error(`[persistence] Failed to hydrate ticket ${ticket.externalId}:`, err)
    }
  }

  console.log(`[persistence] Hydrated ${hydrated}/${nonTerminalTickets.length} non-terminal tickets`)
  return hydrated
}

export function sendTicketEvent(
  ticketRef: string | number,
  event: Parameters<ReturnType<typeof createActor<typeof ticketMachine>>['send']>[0],
) {
  const resolvedTicketRef = resolveTicketRef(ticketRef)
  const actor = activeActors.get(resolvedTicketRef)
  if (!actor) {
    throw new Error(`No active actor for ticket ${resolvedTicketRef}`)
  }
  actor.send(event)
  return actor.getSnapshot()
}

export function getTicketState(ticketRef: string | number) {
  const actor = activeActors.get(resolveTicketRef(ticketRef))
  if (!actor) return null
  const snapshot = actor.getSnapshot()
  return {
    state: typeof snapshot.value === 'string' ? snapshot.value : String(snapshot.value),
    context: snapshot.context,
    status: snapshot.status,
  }
}

export function revertTicketToApprovalStatus(
  ticketRef: string | number,
  targetApprovalStatus: string,
  options?: { skipInitialWorkflowRun?: boolean },
) {
  const resolvedTicketRef = resolveTicketRef(ticketRef)

  const actor = activeActors.get(resolvedTicketRef)
  if (!actor) {
    throw new Error(`No active actor for ticket ${resolvedTicketRef}`)
  }

  const currentState = getStateValue(actor)
  if (currentState === targetApprovalStatus) return actor

  const snapshot = actor.getPersistedSnapshot() as Record<string, unknown>
  snapshot.value = targetApprovalStatus

  const context = snapshot.context as Record<string, unknown>
  context.previousStatus = currentState
  context.status = targetApprovalStatus
  context.updatedAt = new Date().toISOString()

  const ticket = getTicketContext(resolvedTicketRef)
  if (!ticket) throw new Error(`Ticket ${resolvedTicketRef} not found`)

  // Stop the current actor (cleans up workflow runner subscription)
  stopActor(resolvedTicketRef)

  return hydrateTicketActor(resolvedTicketRef, snapshot, {
    ticketId: resolvedTicketRef,
    projectId: ticket.projectId,
    externalId: ticket.externalId,
    title: ticket.localTicket.title,
    lockedMainImplementer: ticket.localTicket.lockedMainImplementer ?? null,
    lockedMainImplementerVariant: ticket.localTicket.lockedMainImplementerVariant ?? null,
    lockedCouncilMembers: parseLockedCouncilMembers(ticket.localTicket.lockedCouncilMembers),
    lockedCouncilMemberVariants: parseLockedCouncilMemberVariants(ticket.localTicket.lockedCouncilMemberVariants),
    lockedInterviewQuestions: ticket.localTicket.lockedInterviewQuestions ?? null,
    lockedCoverageFollowUpBudgetPercent: ticket.localTicket.lockedCoverageFollowUpBudgetPercent ?? null,
    lockedMaxCoveragePasses: ticket.localTicket.lockedMaxCoveragePasses ?? null,
    lockedMaxPrdCoveragePasses: ticket.localTicket.lockedMaxPrdCoveragePasses ?? null,
    lockedMaxBeadsCoveragePasses: ticket.localTicket.lockedMaxBeadsCoveragePasses ?? null,
    lockedStructuredRetryCount: ticket.localTicket.lockedStructuredRetryCount ?? null,
    lockedManualQaEnabled: ticket.localTicket.lockedManualQaEnabled ?? null,
    lockedManualQaSource: normalizeSettingSource(ticket.localTicket.lockedManualQaSource),
    lockedAiQuestionsEnabled: ticket.localTicket.lockedAiQuestionsEnabled ?? null,
    lockedAiQuestionsSource: normalizeSettingSource(ticket.localTicket.lockedAiQuestionsSource),
    lockedAiQuestionWindow: ticket.localTicket.lockedAiQuestionWindow ?? null,
    lockedAiQuestionWindowSource: normalizeSettingSource(ticket.localTicket.lockedAiQuestionWindowSource),
  }, {
    skipFirstPersist: false,
    skipInitialWorkflowRun: options?.skipInitialWorkflowRun,
  })
}

export function stopActor(ticketRef: string | number) {
  const resolvedTicketRef = resolveTicketRef(ticketRef)
  const actor = activeActors.get(resolvedTicketRef)
  if (!actor) return false

  try {
    actor.stop()
  } catch {
    // ignore stop errors
  }
  activeActors.delete(resolvedTicketRef)
  return true
}
