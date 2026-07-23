import type { OpenCodeAdapter } from '../opencode/adapter'
import {
  analyzeAssistantMessages,
  type OpenCodeResponseMeta,
} from '../opencode/assistantMessageAnalysis'
import type {
  Message,
  SessionErrorStreamEvent,
  OpenCodeSessionCreateOptions,
  PromptPart,
  PromptSessionOptions,
  Session,
  StreamEvent,
} from '../opencode/types'
import { OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS } from '../opencode/permissions'
import type { OpenCodeToolPolicy } from '../opencode/toolPolicy'
import { parseModelRef } from '../opencode/types'
import { SessionManager, type SessionOwnership } from '../opencode/sessionManager'
import { resolveOpenCodeTools } from '../opencode/toolPolicy'
import { PROMPT_MIN_TIMEOUT_MS, PROMPT_MAX_TIMEOUT_MS } from '../lib/constants'
import { PROM54_CONTINUE_TEXT } from '../prompts/index'
import {
  attachContinuationDiagnostics,
  clearSessionContinuation,
  consumeSessionContinuation,
  shouldPreserveSessionForContinuation,
} from '../opencode/sessionContinuation'
import { createOpenCodeSessionWithRetry } from '../opencode/sessionCreation'
import {
  isContinuableOpenCodeRetryMessage,
  resolveOpenCodeRetryPolicy,
  type OpenCodeRetryPolicy,
} from '../opencode/retryPolicy'
import { findOpenCodeLogErrorDetails } from '../opencode/logDiagnostics'
import {
  type DeadlineScope,
  isWorkflowDeadlineTimeoutError,
  WorkflowDeadlineTimeoutError,
} from '../lib/deadlineErrors'

export interface OpenCodeRunCallbacks {
  onSessionCreated?: (session: Session) => void
  onPromptDispatched?: (event: OpenCodePromptDispatchEvent) => void
  onStreamEvent?: (event: StreamEvent) => void
  onStreamError?: (error: unknown) => void
  onPromptCompleted?: (event: OpenCodePromptCompletedEvent) => void
}

export type PromptTimeoutKind = 'ai_response' | 'council_response' | 'per_iteration' | 'execution_setup' | 'opencode_prompt'

export interface OpenCodePromptDispatchEvent {
  session: Session
  parts: PromptPart[]
  promptText: string
  promptNumber: number
  timeoutKind: PromptTimeoutKind
  timeoutMs?: number
  deadlineAt?: string
  model?: string
  agent?: string
  variant?: string
}

export interface OpenCodeSessionOwnership extends SessionOwnership {
  ticketId: string
  phase: string
  keepActive?: boolean
  forceFresh?: boolean
}

export interface OpenCodePromptCompletedEvent {
  session: Session
  parts: PromptPart[]
  response: string
  messages: Message[]
  responseMeta: OpenCodeResponseMeta
  attemptMeta: OpenCodeAttemptMeta
  model?: string
  agent?: string
  variant?: string
}

export interface OpenCodeRunOptions extends OpenCodeRunCallbacks {
  adapter: OpenCodeAdapter
  parts: PromptPart[]
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Absolute wall-clock deadline shared by all prompts that belong to one
   * higher-level attempt. When omitted, timeoutMs starts a fresh deadline.
   */
  timeoutDeadline?: number
  timeoutKind?: PromptTimeoutKind
  deadlineScope?: DeadlineScope
  model?: string
  agent?: string
  variant?: string
  toolPolicy?: OpenCodeToolPolicy
  sessionOwnership?: OpenCodeSessionOwnership
  skipSessionValidation?: boolean
  erroredSessionPolicy?: OpenCodeErroredSessionPolicy
  opencodeRetryPolicy?: Partial<OpenCodeRetryPolicy>
}

export interface OpenCodeRunResult {
  session: Session
  response: string
  messages: Message[]
  responseMeta: OpenCodeResponseMeta
  attemptMeta: OpenCodeAttemptMeta
}

export type OpenCodeErroredSessionPolicy = 'allow' | 'discard_errored_session_output'

export interface OpenCodeAttemptMeta {
  outcome: 'clean' | 'errored_session'
  responseAccepted: boolean
  discardedResponse: boolean
  sessionErrored: boolean
  latestAssistantErrored: boolean
  errorSource?: 'session_error' | 'assistant_error'
  error?: string
  errorDetails?: unknown
}

const TIMEOUT_ERROR_MESSAGE = 'Timeout'
const AI_RESPONSE_TIMEOUT_PHASES = new Set([
  'SCANNING_RELEVANT_FILES',
  'COUNCIL_DELIBERATING',
  'COUNCIL_VOTING_INTERVIEW',
  'COMPILING_INTERVIEW',
  'WAITING_INTERVIEW_ANSWERS',
  'VERIFYING_INTERVIEW_COVERAGE',
  'DRAFTING_PRD',
  'COUNCIL_VOTING_PRD',
  'REFINING_PRD',
  'VERIFYING_PRD_COVERAGE',
  'DRAFTING_BEADS',
  'COUNCIL_VOTING_BEADS',
  'REFINING_BEADS',
  'VERIFYING_BEADS_COVERAGE',
  'EXPANDING_BEADS',
  'WAITING_EXECUTION_SETUP_APPROVAL',
  'RUNNING_FINAL_TEST',
  'GENERATING_QA_CHECKLIST',
  'WAITING_MANUAL_QA',
  'CREATING_PULL_REQUEST',
])

interface TimeoutSignalState {
  signal?: AbortSignal
  timedOut: () => boolean
  cleanup: () => void
}

const sessionPromptDispatchCounts = new Map<string, number>()

export function clearOpenCodePromptDispatchCount(sessionId: string): void {
  sessionPromptDispatchCounts.delete(sessionId)
}

export function formatPromptText(parts: PromptPart[]): string {
  if (parts.length === 1 && !parts[0]?.source) {
    return parts[0]?.content ?? ''
  }

  return parts
    .map((part) => {
      const label = part.source ?? part.type
      return `### ${label}\n${part.content}`
    })
    .join('\n\n')
}

function reconcileResponseWithLatestAssistant(
  response: string,
  latestAssistantResponse: string,
  responseMeta: OpenCodeResponseMeta,
): string {
  if (responseMeta.latestAssistantWasStale || responseMeta.latestAssistantHasError) {
    return response
  }

  const current = response.trim()
  const latest = latestAssistantResponse.trim()
  if (!latest) return response
  if (!current) return latest
  if (latest.length > current.length && latest.startsWith(current)) {
    return latest
  }
  return response
}

function mergeSessionErrorIntoResponseMeta(
  responseMeta: OpenCodeResponseMeta,
  sessionErrorEvent?: SessionErrorStreamEvent,
): OpenCodeResponseMeta {
  if (!sessionErrorEvent) {
    return {
      ...responseMeta,
      sessionErrored: false,
    }
  }

  return {
    ...responseMeta,
    sessionErrored: true,
    sessionError: sessionErrorEvent.error,
    sessionErrorDetails: sessionErrorEvent.details,
  }
}

function buildAttemptMeta(
  responseMeta: OpenCodeResponseMeta,
  erroredSessionPolicy: OpenCodeErroredSessionPolicy | undefined,
): OpenCodeAttemptMeta {
  const isSessionErrored = Boolean(responseMeta.sessionErrored)
  const isLatestAssistantErrored = Boolean(responseMeta.latestAssistantHasError)
  const hasErroredSession = isSessionErrored || isLatestAssistantErrored
  const shouldDiscardResponse = hasErroredSession && erroredSessionPolicy === 'discard_errored_session_output'
  const errorSource = isSessionErrored
    ? 'session_error'
    : isLatestAssistantErrored
      ? 'assistant_error'
      : undefined
  const error = isSessionErrored
    ? responseMeta.sessionError
    : isLatestAssistantErrored
      ? responseMeta.latestAssistantError
      : undefined
  const errorDetails = isSessionErrored
    ? responseMeta.sessionErrorDetails
    : isLatestAssistantErrored
      ? responseMeta.latestAssistantErrorInfo
      : undefined

  return {
    outcome: hasErroredSession ? 'errored_session' : 'clean',
    responseAccepted: !shouldDiscardResponse,
    discardedResponse: shouldDiscardResponse,
    sessionErrored: isSessionErrored,
    latestAssistantErrored: isLatestAssistantErrored,
    ...(errorSource ? { errorSource } : {}),
    ...(error ? { error } : {}),
    ...(errorDetails !== undefined ? { errorDetails } : {}),
  }
}

function resolveSessionCreateOptions(): OpenCodeSessionCreateOptions {
  return {
    permission: OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS,
  }
}

function createTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): TimeoutSignalState {
  if (timeoutMs === undefined) {
    return {
      signal,
      timedOut: () => false,
      cleanup: () => undefined,
    }
  }

  const controller = new AbortController()
  let didTimeOut = false

  if (timeoutMs <= 0) {
    didTimeOut = true
    controller.abort()
    return {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      timedOut: () => didTimeOut,
      cleanup: () => undefined,
    }
  }

  const timer = setTimeout(() => {
    didTimeOut = true
    controller.abort()
  }, timeoutMs)

  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => clearTimeout(timer),
  }
}

function getTimeoutDeadline(timeoutMs: number | undefined): number | undefined {
  return timeoutMs === undefined || timeoutMs <= 0 ? undefined : Date.now() + timeoutMs
}

function getRemainingTimeoutMs(timeoutDeadline: number | undefined): number | undefined {
  return timeoutDeadline === undefined || !Number.isFinite(timeoutDeadline)
    ? undefined
    : timeoutDeadline - Date.now()
}

function formatTimeoutDeadline(timeoutDeadline: number | undefined): string | undefined {
  return timeoutDeadline === undefined || !Number.isFinite(timeoutDeadline)
    ? undefined
    : new Date(timeoutDeadline).toISOString()
}

function resolvePromptTimeoutKind(
  timeoutKind: PromptTimeoutKind | undefined,
  deadlineScope: DeadlineScope | undefined,
  sessionOwnership: OpenCodeSessionOwnership | undefined,
): PromptTimeoutKind {
  if (timeoutKind) return timeoutKind
  if (sessionOwnership?.phase === 'CODING' && deadlineScope === 'workflow') return 'per_iteration'
  if (sessionOwnership?.phase === 'PREPARING_EXECUTION_ENV') return 'execution_setup'
  if (sessionOwnership?.phase && AI_RESPONSE_TIMEOUT_PHASES.has(sessionOwnership.phase)) return 'ai_response'
  return 'opencode_prompt'
}

function buildDeadlineTimeoutError(
  deadlineScope: DeadlineScope | undefined,
  timeoutMs: number | undefined,
  sessionOwnership: OpenCodeSessionOwnership | undefined,
): Error {
  if (deadlineScope === 'workflow') {
    return new WorkflowDeadlineTimeoutError({
      phase: sessionOwnership?.phase,
      beadId: sessionOwnership?.beadId ?? undefined,
      iteration: sessionOwnership?.iteration ?? undefined,
      timeoutMs,
    })
  }
  return new Error(TIMEOUT_ERROR_MESSAGE)
}

function isPromptTransportFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (!(error instanceof Error)) return true
  return error.name === 'AbortError' ||
    error.message === TIMEOUT_ERROR_MESSAGE ||
    error.message.startsWith('Failed to prompt OpenCode session')
}

function isOpenCodeRetryProgressEvent(event: StreamEvent): boolean {
  switch (event.type) {
    case 'session_status':
      return event.status !== 'retry'
    case 'text':
    case 'reasoning':
      return Boolean(event.complete || event.delta?.trim() || event.text?.trim())
    case 'part_summary':
      return event.partType !== 'retry'
    case 'tool':
    case 'step':
    case 'session_error':
    case 'permission':
    case 'question':
    case 'todo':
    case 'file_edited':
    case 'debug_event':
    case 'part_removed':
    case 'done':
      return true
    default:
      return false
  }
}

export async function runOpenCodePrompt({
  adapter,
  projectPath,
  parts,
  signal,
  timeoutMs,
  timeoutDeadline,
  timeoutKind,
  deadlineScope,
  model,
  agent,
  variant,
  toolPolicy,
  sessionOwnership,
  erroredSessionPolicy,
  opencodeRetryPolicy,
  onSessionCreated,
  onPromptDispatched,
  onStreamEvent,
  onPromptCompleted,
}: OpenCodeRunOptions & { projectPath: string }): Promise<OpenCodeRunResult> {
  const sessionManager = sessionOwnership ? new SessionManager(adapter) : null
  const sessionCreateOptions = resolveSessionCreateOptions()
  const resolvedTimeoutDeadline = timeoutDeadline ?? getTimeoutDeadline(timeoutMs)
  const acquisitionDeadline = createTimeoutSignal(signal, getRemainingTimeoutMs(resolvedTimeoutDeadline))
  let session: Session | undefined
  let preservedForContinuation = false
  try {
    if (sessionOwnership?.forceFresh) {
      const existing = sessionManager!.getOwnedActiveSession(
        sessionOwnership.ticketId,
        sessionOwnership.phase,
        sessionOwnership,
      )
      if (existing) {
        await adapter.abortSession(existing.sessionId).catch(() => false)
        await sessionManager!.abandonSession(existing.sessionId)
        clearSessionContinuation(existing.sessionId)
        clearOpenCodePromptDispatchCount(existing.sessionId)
      }
    }
    session = sessionOwnership
      ? (!sessionOwnership.forceFresh
          ? await sessionManager!.validateAndReconnect(
            sessionOwnership.ticketId,
            sessionOwnership.phase,
            sessionOwnership,
            acquisitionDeadline.signal,
          )
          : null
        ) ?? await sessionManager!.createSessionForPhase(
          sessionOwnership.ticketId,
          sessionOwnership.phase,
          sessionOwnership.phaseAttempt ?? 1,
          sessionOwnership.memberId ?? undefined,
          sessionOwnership.beadId ?? undefined,
          sessionOwnership.iteration ?? undefined,
          sessionOwnership.step ?? undefined,
          projectPath,
          sessionCreateOptions,
          acquisitionDeadline.signal,
        )
      : await createOpenCodeSessionWithRetry(
        adapter,
        projectPath,
        acquisitionDeadline.signal,
        sessionCreateOptions,
      )
  } catch (error) {
    if (acquisitionDeadline.timedOut()) {
      throw buildDeadlineTimeoutError(deadlineScope, timeoutMs, sessionOwnership)
    }
    throw error
  } finally {
    acquisitionDeadline.cleanup()
  }
  onSessionCreated?.(session)
  try {
    const continuation = sessionOwnership
      ? consumeSessionContinuation({
          ticketId: sessionOwnership.ticketId,
          phase: sessionOwnership.phase,
          sessionId: session.id,
        })
      : null
    const promptParts = continuation
      ? [{ type: 'text' as const, content: continuation.prompt ?? PROM54_CONTINUE_TEXT }]
      : parts
    const result = await runOpenCodeSessionPrompt({
      adapter,
      session,
      parts: promptParts,
      signal,
      timeoutMs,
      timeoutKind,
      deadlineScope,
      model,
      agent,
      variant,
      toolPolicy,
      sessionOwnership,
      skipSessionValidation: true,
      erroredSessionPolicy,
      opencodeRetryPolicy,
      onPromptDispatched,
      onStreamEvent,
      onPromptCompleted,
      timeoutDeadline: resolvedTimeoutDeadline,
    })
    if (sessionManager && !sessionOwnership?.keepActive) {
      await sessionManager.completeSession(session.id)
      clearSessionContinuation(session.id)
      clearOpenCodePromptDispatchCount(session.id)
    }
    return result
  } catch (error) {
    preservedForContinuation = !isWorkflowDeadlineTimeoutError(error) && shouldPreserveSessionForContinuation({
      error,
      sessionId: session.id,
      modelId: model,
      sessionOwnership,
      signal,
    })
    if (sessionManager && !sessionOwnership?.keepActive && !preservedForContinuation) {
      await sessionManager.abandonSession(session.id)
      clearSessionContinuation(session.id)
      clearOpenCodePromptDispatchCount(session.id)
    }
    throw error
  } finally {
    if (session && !sessionOwnership?.keepActive && !preservedForContinuation) {
      clearOpenCodePromptDispatchCount(session.id)
    }
  }
}

export async function runOpenCodeSessionPrompt({
  adapter,
  session,
  parts,
  signal,
  timeoutMs,
  timeoutKind,
  deadlineScope,
  model,
  agent,
  variant,
  toolPolicy,
  sessionOwnership,
  skipSessionValidation,
  erroredSessionPolicy,
  opencodeRetryPolicy,
  onPromptDispatched,
  onStreamEvent,
  onStreamError,
  onPromptCompleted,
  timeoutDeadline,
}: OpenCodeRunOptions & { session: Session }): Promise<OpenCodeRunResult> {
  const resolvedTimeoutDeadline = timeoutDeadline ?? getTimeoutDeadline(timeoutMs)
  let resolvedSession = session
  const sessionManager = sessionOwnership ? new SessionManager(adapter) : null
  if (sessionOwnership && !skipSessionValidation) {
    const validationDeadline = createTimeoutSignal(signal, getRemainingTimeoutMs(resolvedTimeoutDeadline))
    let reconnected: Session | null
    try {
      reconnected = await sessionManager!.validateAndReconnect(sessionOwnership.ticketId, sessionOwnership.phase, {
        phaseAttempt: sessionOwnership.phaseAttempt,
        ...(sessionOwnership.memberId !== undefined ? { memberId: sessionOwnership.memberId } : {}),
        ...(sessionOwnership.beadId !== undefined ? { beadId: sessionOwnership.beadId } : {}),
        ...(sessionOwnership.iteration !== undefined ? { iteration: sessionOwnership.iteration } : {}),
        ...(sessionOwnership.step !== undefined ? { step: sessionOwnership.step } : {}),
      }, validationDeadline.signal)
    } catch (error) {
      if (validationDeadline.timedOut()) {
        throw buildDeadlineTimeoutError(deadlineScope, timeoutMs, sessionOwnership)
      }
      throw error
    } finally {
      validationDeadline.cleanup()
    }
    if (!reconnected || reconnected.id !== session.id) {
      throw new Error(`OpenCode session ${session.id} is no longer active for ${sessionOwnership.ticketId}:${sessionOwnership.phase}`)
    }
    resolvedSession = reconnected
  }

  let response = ''
  const promptTimeoutMs = getRemainingTimeoutMs(resolvedTimeoutDeadline)
  const deadlineController = promptTimeoutMs === undefined ? undefined : new AbortController()
  const retryController = new AbortController()
  const combinedSignal = signal
    ? deadlineController
      ? AbortSignal.any([signal, deadlineController.signal, retryController.signal])
      : AbortSignal.any([signal, retryController.signal])
    : deadlineController
      ? AbortSignal.any([deadlineController.signal, retryController.signal])
      : retryController.signal
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let openCodeRetryTimer: ReturnType<typeof setTimeout> | undefined
  let openCodeRetryError: Error | null = null
  let continuableRetryCount = 0
  let latestContinuableRetryMessage = ''
  let latestContinuableRetryAttempt: number | undefined
  const resolvedRetryPolicy = resolveOpenCodeRetryPolicy(opencodeRetryPolicy)
  const parsedModel = model ? parseModelRef(model) : undefined
  const tools = resolveOpenCodeTools(toolPolicy)
  const stepFinishSafetyMs = promptTimeoutMs === undefined || promptTimeoutMs <= 0
    ? undefined
    : Math.min(Math.max(promptTimeoutMs / 10, PROMPT_MIN_TIMEOUT_MS), PROMPT_MAX_TIMEOUT_MS)
  const promptOptions: PromptSessionOptions = {
    ...(combinedSignal ? { signal: combinedSignal } : {}),
    ...(parsedModel ? { model: parsedModel } : {}),
    ...(agent ? { agent } : {}),
    ...(variant ? { variant } : {}),
    ...(tools ? { tools } : {}),
    ...(stepFinishSafetyMs !== undefined ? { stepFinishSafetyMs } : {}),
  }
  let sessionErrorEvent: SessionErrorStreamEvent | undefined
  let latestStepFinishReason: string | undefined
  let latestStepFinishTokens: OpenCodeResponseMeta['latestStepFinishTokens'] | undefined
  const clearOpenCodeRetryTimer = () => {
    if (openCodeRetryTimer) {
      clearTimeout(openCodeRetryTimer)
      openCodeRetryTimer = undefined
    }
  }
  const buildOpenCodeRetryError = (reason: 'limit' | 'delay'): Error => {
    const retryMessage = latestContinuableRetryMessage || 'OpenCode reported a retryable provider interruption.'
    const retryLabel = typeof latestContinuableRetryAttempt === 'number'
      ? `retry attempt ${latestContinuableRetryAttempt}`
      : `${continuableRetryCount} retry event(s)`
    const summary = reason === 'limit'
      ? `OpenCode retry budget exhausted after ${continuableRetryCount} retry event(s)`
      : `OpenCode retry grace window expired after ${resolvedRetryPolicy.delayMs}ms`
    const error = new Error(`${summary} (${retryLabel}): ${retryMessage}`)
    error.name = 'OpenCodeRetryLimitError'
    const logDetails = findOpenCodeLogErrorDetails(resolvedSession.id)
    if (logDetails) {
      Object.assign(error, {
        details: logDetails,
        modelErrorDetails: logDetails,
      })
    }
    return error
  }
  const blockForOpenCodeRetry = (reason: 'limit' | 'delay') => {
    if (openCodeRetryError) return
    openCodeRetryError = buildOpenCodeRetryError(reason)
    retryController.abort()
  }
  promptOptions.onEvent = (event) => {
    if (event.type === 'session_error') {
      sessionErrorEvent = event
    }
    if (event.type === 'step' && event.step === 'finish') {
      latestStepFinishReason = typeof event.reason === 'string' && event.reason.trim().length > 0
        ? event.reason.trim()
        : latestStepFinishReason
      latestStepFinishTokens = event.tokens ?? latestStepFinishTokens
    }
    if (event.type === 'session_status' && event.status === 'retry') {
      if (isContinuableOpenCodeRetryMessage(event.message)) {
        continuableRetryCount += 1
        latestContinuableRetryMessage = event.message?.trim() || latestContinuableRetryMessage
        latestContinuableRetryAttempt = event.attempt

        if (!openCodeRetryTimer && resolvedRetryPolicy.delayMs > 0) {
          openCodeRetryTimer = setTimeout(() => blockForOpenCodeRetry('delay'), resolvedRetryPolicy.delayMs)
        }
        if (resolvedRetryPolicy.limit === 0 || continuableRetryCount >= resolvedRetryPolicy.limit) {
          blockForOpenCodeRetry('limit')
        }
      } else {
        clearOpenCodeRetryTimer()
      }
    } else if (isOpenCodeRetryProgressEvent(event)) {
      clearOpenCodeRetryTimer()
    }
    onStreamEvent?.(event)
  }

  try {
    const promptNumber = (sessionPromptDispatchCounts.get(resolvedSession.id) ?? 0) + 1
    sessionPromptDispatchCounts.set(resolvedSession.id, promptNumber)
    const dispatchTimeoutKind = resolvePromptTimeoutKind(timeoutKind, deadlineScope, sessionOwnership)
    const dispatchDeadlineAt = formatTimeoutDeadline(resolvedTimeoutDeadline)
    onPromptDispatched?.({
      session: resolvedSession,
      parts,
      promptText: formatPromptText(parts),
      promptNumber,
      timeoutKind: dispatchTimeoutKind,
      ...(timeoutMs !== undefined && timeoutMs > 0 ? { timeoutMs } : {}),
      ...(dispatchDeadlineAt ? { deadlineAt: dispatchDeadlineAt } : {}),
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
      ...(variant ? { variant } : {}),
    })

    if (deadlineController) {
      if (promptTimeoutMs !== undefined && promptTimeoutMs <= 0) {
        deadlineController.abort()
      } else {
        deadlineTimer = setTimeout(() => deadlineController.abort(), promptTimeoutMs)
      }
    }
    if (deadlineController?.signal.aborted) {
      throw buildDeadlineTimeoutError(deadlineScope, timeoutMs, sessionOwnership)
    }
    response = await adapter.promptSession(resolvedSession.id, parts, combinedSignal, promptOptions)
    if (openCodeRetryError) {
      throw openCodeRetryError
    }
    // Adapter completed but deadline may have fired during execution;
    // enforce the timeout even if the adapter didn't respect the signal.
    if (deadlineController?.signal.aborted) {
      throw buildDeadlineTimeoutError(deadlineScope, timeoutMs, sessionOwnership)
    }
  } catch (error) {
    if (openCodeRetryError) {
      const preserveForContinuation = shouldPreserveSessionForContinuation({
        error: openCodeRetryError,
        sessionId: resolvedSession.id,
        modelId: model,
        sessionOwnership,
        signal,
      })
      const enrichedError = preserveForContinuation
        ? attachContinuationDiagnostics(openCodeRetryError, {
            error: openCodeRetryError,
            sessionId: resolvedSession.id,
            modelId: model,
          })
        : openCodeRetryError
      onStreamError?.(enrichedError)
      throw enrichedError
    }
    if (deadlineController?.signal.aborted) {
      const timeoutError = deadlineScope === 'workflow' || !(error instanceof Error && error.message === TIMEOUT_ERROR_MESSAGE)
        ? buildDeadlineTimeoutError(deadlineScope, timeoutMs, sessionOwnership)
        : error
      const preserveForContinuation = !isWorkflowDeadlineTimeoutError(timeoutError) && shouldPreserveSessionForContinuation({
        error: timeoutError,
        sessionId: resolvedSession.id,
        modelId: model,
        sessionOwnership,
        signal,
        fallbackMessage: TIMEOUT_ERROR_MESSAGE,
      })
      if (!preserveForContinuation) {
        await adapter.abortSession(resolvedSession.id)
      }
      if (sessionManager && !sessionOwnership?.keepActive && !preserveForContinuation) {
        await sessionManager.abandonSession(resolvedSession.id)
        clearSessionContinuation(resolvedSession.id)
        clearOpenCodePromptDispatchCount(resolvedSession.id)
      }
      const enrichedError = preserveForContinuation
        ? attachContinuationDiagnostics(timeoutError, {
            error: timeoutError,
            sessionId: resolvedSession.id,
            modelId: model,
            fallbackMessage: TIMEOUT_ERROR_MESSAGE,
          })
        : timeoutError
      onStreamError?.(enrichedError)
      throw enrichedError
    }
    const preserveForContinuation = shouldPreserveSessionForContinuation({
      error,
      sessionId: resolvedSession.id,
      modelId: model,
      sessionOwnership,
      signal,
    })
    if (sessionManager && !sessionOwnership?.keepActive && isPromptTransportFailure(error) && !preserveForContinuation) {
      await sessionManager.abandonSession(resolvedSession.id)
      clearSessionContinuation(resolvedSession.id)
      clearOpenCodePromptDispatchCount(resolvedSession.id)
    }
    const thrownError = preserveForContinuation && error instanceof Error
      ? attachContinuationDiagnostics(error, {
          error,
          sessionId: resolvedSession.id,
          modelId: model,
        })
      : error
    onStreamError?.(thrownError)
    throw thrownError
  } finally {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer)
    }
    clearOpenCodeRetryTimer()
  }

  let messages: Message[] = []
  let latestAssistantResponse = ''
  let responseMeta: OpenCodeResponseMeta = {
    hasAssistantMessage: false,
    latestAssistantWasEmpty: true,
    latestAssistantHasError: false,
    latestAssistantWasStale: false,
    sessionErrored: false,
  }
  try {
    messages = await adapter.getSessionMessages(resolvedSession.id, signal)
    const latestAssistant = analyzeAssistantMessages(messages)
    latestAssistantResponse = latestAssistant.responseText
    responseMeta = latestAssistant.responseMeta
  } catch {
    messages = []
  }
  responseMeta = mergeSessionErrorIntoResponseMeta(responseMeta, sessionErrorEvent)
  const resolvedStepFinishReason = responseMeta.latestStepFinishReason ?? latestStepFinishReason
  const resolvedStepFinishTokens = responseMeta.latestStepFinishTokens ?? latestStepFinishTokens
  responseMeta = {
    ...responseMeta,
    ...(resolvedStepFinishReason ? { latestStepFinishReason: resolvedStepFinishReason } : {}),
    ...(resolvedStepFinishTokens ? { latestStepFinishTokens: resolvedStepFinishTokens } : {}),
  }
  const attemptMeta = buildAttemptMeta(responseMeta, erroredSessionPolicy)
  response = attemptMeta.discardedResponse
    ? ''
    : reconcileResponseWithLatestAssistant(response, latestAssistantResponse, responseMeta)

  const result = {
    session: resolvedSession,
    response,
    messages,
    responseMeta,
    attemptMeta,
  }
  onPromptCompleted?.({
    session: resolvedSession,
    parts,
    response,
    messages,
    responseMeta,
    attemptMeta,
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    ...(variant ? { variant } : {}),
  })

  return result
}
