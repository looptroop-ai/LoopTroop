import type { OpenCodeAdapter } from '../../opencode/adapter'
import type { PromptPart, Session, StreamEvent } from '../../opencode/types'
import { buildPromptFromTemplate, PROM_EXECUTION_SETUP } from '../../prompts/index'
import {
  formatPromptText,
  runOpenCodePrompt,
  runOpenCodeSessionPrompt,
  type OpenCodePromptCompletedEvent,
  type OpenCodePromptDispatchEvent,
} from '../../workflow/runOpenCodePrompt'
import { throwIfAborted, type RawAttempt } from '../../council/types'
import { throwIfCancelled } from '../../lib/abort'
import { buildStructuredRetryPrompt } from '../../structuredOutput'
import { buildStructuredOutputMetadata } from '../../structuredOutput/metadata'
import { SessionManager } from '../../opencode/sessionManager'
import { COUNCIL_RESPONSE_TIMEOUT_MS } from '../../lib/constants'
import { classifyStructuredFailureFromError, getStructuredRetryDecision } from '../../lib/structuredOutputRetry'
import { resolveStructuredRetryDiagnostic } from '../../lib/structuredRetryDiagnostics'
import { normalizeStructuredRetryCount, shouldRetryStructuredOutput } from '../../lib/structuredRetryPolicy'
import { appendAcceptedRawAttempt, appendRejectedRawAttempt } from '../../lib/structuredRawAttempts'
import type { StructuredOutputMetadata } from '../../structuredOutput/types'
import { parseExecutionSetupResult } from './parser'
import type { ExecutionSetupGenerationResult } from './types'
import { getErrorMessage } from '@shared/typeGuards'
import type { WorkBudget } from '../../workflow/workBudget'

const EXECUTION_SETUP_SCHEMA_REMINDER = [
  'Return exactly one <EXECUTION_SETUP_RESULT>...</EXECUTION_SETUP_RESULT> block and nothing else.',
  'Inside the marker, return a single JSON or YAML object with top-level keys: status, summary, profile, checks.',
  'status and profile.status must match: use ready only when every check passes, or blocked when at least one check fails.',
  'profile.artifact must be execution_setup_profile.',
  'profile.temp_roots and profile.reusable_artifacts[].path should prefer approved runtime-owned setup paths under .ticket/runtime/execution-setup/**.',
  'profile.tool_requirements is optional for passing setup, but required as evidence when checks.tooling is fail.',
  'profile must include workspace_probes and git_hooks copied from the approved setup plan; workspace probes are functional repository checks, not tool version probes.',
  'failed tool_requirements evidence uses provisioning_attempts objects with distinct strategies and command lists, not flat provisioning_commands.',
  'Wrapper creation, cache inspection, PATH edits, and version/info probes do not count as provisioning strategies; failed launcher evidence must include real attempts to obtain, install, or activate the required launcher under approved temp roots.',
  'checks must contain exactly: workspace, tooling, temp_scope, policy.',
  'If required command launchers or toolchains are missing and cannot be prepared safely under approved temp roots, set checks.tooling to fail only after recording failed evidence for at least two distinct safe strategies or not_provisionable evidence with a no-safe-path reason.',
].join('\n')

const MAX_PROGRESS_CONTINUATIONS = 2
const PROGRESS_CONTINUATION_FAILURE = 'Setup agent stopped before completing workspace preparation after two continuations.'
const EXECUTION_SETUP_PROGRESS_CONTINUATION_PROMPT = [
  'Continue the workspace preparation in this same session.',
  'Your previous response was only a progress update, so the setup work is not finished yet.',
  'Use the available tools to complete the approved setup work now. Do not return another progress update.',
  'Finish with exactly one <EXECUTION_SETUP_RESULT>...</EXECUTION_SETUP_RESULT> block that honestly reports ready or blocked, including the cause and evidence when blocked.',
].join('\n')

type ExecutionSetupPromptStage =
  | 'execution_setup_main'
  | 'execution_setup_progress_continuation'
  | 'execution_setup_structured_retry'

function isProgressOnlyExecutionSetupResponse(response: string, markerFound: boolean): boolean {
  if (markerFound) return false
  const trimmed = response.trim()
  if (!trimmed) return false
  if (trimmed.length > 500) return false
  if (/[{[]/.test(trimmed) || /^\s*(?:status|profile|checks|summary)\s*:/im.test(trimmed)) {
    return false
  }
  if (/\b(?:blocked|complete(?:d)?|done|failed|finished|ready|succeeded|unable|could not)\b/i.test(trimmed)) {
    return false
  }
  return /\b(?:checking|configuring|continuing|downloading|getting|inspecting|installing|preparing|provisioning|setting\s+up|starting|working)\b/i.test(trimmed)
    || /\b(?:going to|will)\s+(?:check|configure|continue|download|get|inspect|install|prepare|provision|set\s+up|start|work)\b/i.test(trimmed)
}

export type GenerateExecutionSetupResult = ExecutionSetupGenerationResult

function errorMessage(error: unknown): string {
  return getErrorMessage(error)
}

function normalizeExecutionSetupPromptError(
  error: unknown,
  expired: boolean,
): unknown {
  return expired
    ? new Error('Execution setup timed out before workspace preparation completed.', { cause: error })
    : error
}

function buildPromptFailureGeneration(
  session: Session | null,
  error: unknown,
  previousDiagnostics: NonNullable<StructuredOutputMetadata['retryDiagnostics']> = [],
  previousRawAttempts: RawAttempt[] = [],
  initialInput?: string,
): GenerateExecutionSetupResult {
  const validationError = `Execution setup prompt failed: ${errorMessage(error)}`
  const failureClass = classifyStructuredFailureFromError(error)
  const rawAttempts: RawAttempt[] = [...previousRawAttempts]
  const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
    stage: 'execution_setup',
    initialInput,
    validationError,
    failureClass,
  })
  const retryDiagnostics = [
    ...previousDiagnostics,
    resolveStructuredRetryDiagnostic({
      attempt: rawAttempt.attempt,
      rawResponse: '',
      validationError,
      failureClass,
    }),
  ]

  return {
    session,
    output: '',
    result: null,
    parse: {
      markerFound: false,
      result: null,
      errors: [validationError],
      validationError,
    },
    structuredOutput: buildStructuredOutputMetadata({
      autoRetryCount: retryDiagnostics.length,
      validationError,
      retryDiagnostics,
    }),
    rawAttempts,
  }
}

export async function generateExecutionSetup(
  adapter: OpenCodeAdapter,
  ticketContext: PromptPart[],
  projectPath: string,
  signal?: AbortSignal,
  callbacks?: {
    ticketId?: string
    model?: string
    variant?: string
    timeoutMs?: number
    timeoutDeadline?: number
    budget?: WorkBudget
    structuredRetryCount?: number
    phaseAttempt?: number
    manualContinuation?: boolean
    onSessionCreated?: (sessionId: string) => void
    onOpenCodeStreamEvent?: (entry: { sessionId: string; event: StreamEvent }) => void
    onPromptDispatched?: (entry: { sessionId: string; event: OpenCodePromptDispatchEvent }) => void
    onPromptCompleted?: (entry: { stage: ExecutionSetupPromptStage; event: OpenCodePromptCompletedEvent }) => void
    onStructuredRetryStart?: (entry: { sessionId: string; retryAttempt: number }) => void
  },
): Promise<GenerateExecutionSetupResult> {
  const promptContent = buildPromptFromTemplate(PROM_EXECUTION_SETUP, ticketContext)
  const promptParts = [{ type: 'text', content: promptContent }] as PromptPart[]
  const initialInput = formatPromptText(promptParts)
  const timeoutMs = callbacks?.timeoutMs ?? COUNCIL_RESPONSE_TIMEOUT_MS
  const timeoutDeadline = callbacks?.timeoutDeadline
    ?? (timeoutMs > 0 ? Date.now() + timeoutMs : undefined)
  // The budget knows about question waits; the bare deadline does not. Prefer it
  // wherever "has this attempt run out" is being asked.
  const setupExpired = (): boolean => callbacks?.budget
    ? callbacks.budget.expired()
    : timeoutDeadline !== undefined && Date.now() >= timeoutDeadline
  let sessionId = ''
  let activeSessionId: string | null = null
  let activeSession: Session | null = null
  const sessionManager = callbacks?.ticketId ? new SessionManager(adapter) : null
  throwIfAborted(signal)

  const runMainSetupPrompt = async () => await runOpenCodePrompt({
    adapter,
    projectPath,
    parts: promptParts,
    signal,
    ...(callbacks?.budget ? { workBudget: callbacks.budget } : { timeoutMs, timeoutDeadline }),
    timeoutKind: 'execution_setup',
    model: callbacks?.model,
    variant: callbacks?.variant,
    erroredSessionPolicy: 'discard_errored_session_output',
    toolPolicy: PROM_EXECUTION_SETUP.toolPolicy,
    ...(callbacks?.ticketId
      ? {
          sessionOwnership: {
            ticketId: callbacks.ticketId,
            phase: 'PREPARING_EXECUTION_ENV',
            phaseAttempt: callbacks.phaseAttempt ?? 1,
            keepActive: true,
            ...(callbacks.model ? { memberId: callbacks.model } : {}),
          },
        }
      : {}),
    onSessionCreated: (session) => {
      sessionId = session.id
      activeSessionId = session.id
      activeSession = session
      callbacks?.onSessionCreated?.(session.id)
    },
    onStreamEvent: (event) => {
      if (!sessionId) return
      callbacks?.onOpenCodeStreamEvent?.({ sessionId, event })
    },
    onPromptDispatched: (event) => {
      callbacks?.onPromptDispatched?.({ sessionId: event.session.id, event })
    },
    onPromptCompleted: (event) => {
      callbacks?.onPromptCompleted?.({ stage: 'execution_setup_main', event })
    },
  })

  let result: Awaited<ReturnType<typeof runMainSetupPrompt>>
  try {
    result = await runMainSetupPrompt()
  } catch (error) {
    throwIfCancelled(error, signal)
    if (setupExpired()) {
      return buildPromptFailureGeneration(
        activeSession,
        normalizeExecutionSetupPromptError(error, setupExpired()),
        [],
        [],
        initialInput,
      )
    }
    if (callbacks?.manualContinuation) throw error
    if (activeSessionId && sessionManager) {
      await sessionManager.abandonSession(activeSessionId)
      activeSessionId = null
      activeSession = null
    }

    try {
      result = await runMainSetupPrompt()
    } catch (retryError) {
      throwIfCancelled(retryError, signal)
      if (setupExpired()) {
        return buildPromptFailureGeneration(
          activeSession,
          normalizeExecutionSetupPromptError(retryError, setupExpired()),
          [],
          [],
          initialInput,
        )
      }
      if (!activeSession) {
        throw retryError
      }
      const promptFailureAttempts: RawAttempt[] = []
      appendRejectedRawAttempt(promptFailureAttempts, {
        stage: 'execution_setup',
        initialInput,
        validationError: `Execution setup prompt failed: ${errorMessage(error)}`,
        failureClass: classifyStructuredFailureFromError(error),
      })
      return buildPromptFailureGeneration(
        activeSession,
        retryError,
        [
          resolveStructuredRetryDiagnostic({
            attempt: 1,
            rawResponse: '',
            validationError: `Execution setup prompt failed: ${errorMessage(error)}`,
            failureClass: classifyStructuredFailureFromError(error),
          }),
        ],
        promptFailureAttempts,
        initialInput,
      )
    }
  }

  throwIfAborted(signal)
  activeSessionId = result.session.id
  activeSession = result.session

  let response = result.response
  let parsed = parseExecutionSetupResult(response)
  const rawAttempts: RawAttempt[] = []
  const retryDiagnostics: NonNullable<StructuredOutputMetadata['retryDiagnostics']> = []
  const structuredRetryCount = normalizeStructuredRetryCount(callbacks?.structuredRetryCount)
  let retryAttemptsUsed = 0
  let progressContinuationsUsed = 0
  let progressContinuationExhausted = false
  let structuredOutput = buildStructuredOutputMetadata({
    autoRetryCount: 0,
    repairApplied: Boolean(parsed.repairApplied),
    repairWarnings: parsed.repairWarnings ?? [],
    ...(parsed.validationError ? { validationError: parsed.validationError } : {}),
  })

  while (parsed.errors.length > 0) {
    const validationError = parsed.validationError ?? parsed.errors.join('; ')
    const retryDecision = getStructuredRetryDecision(response, result.responseMeta)
    const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
      stage: 'execution_setup',
      rawResponse: response,
      initialInput,
      validationError,
      failureClass: retryDecision.failureClass,
    })
    retryDiagnostics.push(resolveStructuredRetryDiagnostic({
      attempt: rawAttempt.attempt,
      rawResponse: response,
      validationError,
      failureClass: retryDecision.failureClass,
      retryDiagnostic: parsed.retryDiagnostic,
    }))
    structuredOutput = buildStructuredOutputMetadata(structuredOutput, {
      autoRetryCount: retryAttemptsUsed,
      validationError,
      retryDiagnostics,
    })
    if (isProgressOnlyExecutionSetupResponse(response, parsed.markerFound)) {
      if (progressContinuationsUsed >= MAX_PROGRESS_CONTINUATIONS) {
        progressContinuationExhausted = true
        break
      }
      progressContinuationsUsed += 1
      try {
        const continuationResult = await runOpenCodeSessionPrompt({
          adapter,
          session: result.session,
          parts: [{ type: 'text', content: EXECUTION_SETUP_PROGRESS_CONTINUATION_PROMPT }],
          signal,
          ...(callbacks?.budget ? { workBudget: callbacks.budget } : { timeoutMs, timeoutDeadline }),
          timeoutKind: 'execution_setup',
          model: callbacks?.model,
          erroredSessionPolicy: 'discard_errored_session_output',
          toolPolicy: PROM_EXECUTION_SETUP.toolPolicy,
          onStreamEvent: (event) => {
            if (!sessionId) return
            callbacks?.onOpenCodeStreamEvent?.({ sessionId, event })
          },
          onPromptDispatched: (event) => {
            callbacks?.onPromptDispatched?.({ sessionId: event.session.id, event })
          },
          onPromptCompleted: (event) => {
            callbacks?.onPromptCompleted?.({ stage: 'execution_setup_progress_continuation', event })
          },
        })
        throwIfAborted(signal)
        result = continuationResult
        response = continuationResult.response
        parsed = parseExecutionSetupResult(response)
        structuredOutput = buildStructuredOutputMetadata(structuredOutput, {
          repairApplied: Boolean(parsed.repairApplied),
          repairWarnings: parsed.repairWarnings ?? [],
          ...(parsed.validationError ? { validationError: parsed.validationError } : {}),
        })
        continue
      } catch (error) {
        throwIfCancelled(error, signal)
        if (!activeSession) {
          throw error
        }
        return buildPromptFailureGeneration(
          activeSession,
          normalizeExecutionSetupPromptError(error, setupExpired()),
          retryDiagnostics,
          rawAttempts,
          initialInput,
        )
      }
    }
    if (!shouldRetryStructuredOutput(retryAttemptsUsed, structuredRetryCount)) {
      break
    }
    retryAttemptsUsed += 1
    structuredOutput = buildStructuredOutputMetadata(structuredOutput, {
      autoRetryCount: retryAttemptsUsed,
    })

    try {
      callbacks?.onStructuredRetryStart?.({
        sessionId: result.session.id,
        retryAttempt: retryAttemptsUsed,
      })
      if (retryDecision.reuseSession) {
        const retryParts = buildStructuredRetryPrompt([], {
          validationError,
          rawResponse: response,
          schemaReminder: EXECUTION_SETUP_SCHEMA_REMINDER,
        })
        const retryResult = await runOpenCodeSessionPrompt({
          adapter,
          session: result.session,
          parts: retryParts,
          signal,
          ...(callbacks?.budget ? { workBudget: callbacks.budget } : { timeoutMs, timeoutDeadline }),
          timeoutKind: 'execution_setup',
          model: callbacks?.model,
          erroredSessionPolicy: 'discard_errored_session_output',
          toolPolicy: PROM_EXECUTION_SETUP.toolPolicy,
          onStreamEvent: (event) => {
            if (!sessionId) return
            callbacks?.onOpenCodeStreamEvent?.({ sessionId, event })
          },
          onPromptDispatched: (event) => {
            callbacks?.onPromptDispatched?.({ sessionId: event.session.id, event })
          },
          onPromptCompleted: (event) => {
            callbacks?.onPromptCompleted?.({ stage: 'execution_setup_structured_retry', event })
          },
        })
        throwIfAborted(signal)
        result = retryResult
        response = retryResult.response
      } else {
        if (activeSessionId && sessionManager) {
          await sessionManager.abandonSession(activeSessionId)
          activeSessionId = null
          activeSession = null
        }
        result = await runOpenCodePrompt({
          adapter,
          projectPath,
          parts: promptParts,
          signal,
          ...(callbacks?.budget ? { workBudget: callbacks.budget } : { timeoutMs, timeoutDeadline }),
          timeoutKind: 'execution_setup',
          model: callbacks?.model,
          variant: callbacks?.variant,
          erroredSessionPolicy: 'discard_errored_session_output',
          toolPolicy: PROM_EXECUTION_SETUP.toolPolicy,
          ...(callbacks?.ticketId
            ? {
                sessionOwnership: {
                  ticketId: callbacks.ticketId,
                  phase: 'PREPARING_EXECUTION_ENV',
                  phaseAttempt: callbacks.phaseAttempt ?? 1,
                  keepActive: true,
                  ...(callbacks.model ? { memberId: callbacks.model } : {}),
                },
              }
            : {}),
          onSessionCreated: (session) => {
            sessionId = session.id
            activeSessionId = session.id
            activeSession = session
            callbacks?.onSessionCreated?.(session.id)
          },
          onStreamEvent: (event) => {
            if (!sessionId) return
            callbacks?.onOpenCodeStreamEvent?.({ sessionId, event })
          },
          onPromptDispatched: (event) => {
            callbacks?.onPromptDispatched?.({ sessionId: event.session.id, event })
          },
          onPromptCompleted: (event) => {
            callbacks?.onPromptCompleted?.({ stage: 'execution_setup_main', event })
          },
        })
        throwIfAborted(signal)
        activeSessionId = result.session.id
        activeSession = result.session
        response = result.response
      }
    } catch (error) {
      throwIfCancelled(error, signal)
      if (!activeSession) {
        throw error
      }
      return buildPromptFailureGeneration(
        activeSession,
        normalizeExecutionSetupPromptError(error, setupExpired()),
        retryDiagnostics,
        rawAttempts,
        initialInput,
      )
    }

    parsed = parseExecutionSetupResult(response)
    structuredOutput = buildStructuredOutputMetadata(structuredOutput, {
      repairApplied: Boolean(parsed.repairApplied),
      repairWarnings: parsed.repairWarnings ?? [],
      ...(parsed.validationError ? { validationError: parsed.validationError } : {}),
    })
  }

  if (progressContinuationExhausted) {
    parsed = {
      ...parsed,
      result: null,
      errors: [PROGRESS_CONTINUATION_FAILURE],
      validationError: PROGRESS_CONTINUATION_FAILURE,
    }
    structuredOutput = buildStructuredOutputMetadata(structuredOutput, {
      validationError: PROGRESS_CONTINUATION_FAILURE,
      retryDiagnostics,
    })
  }

  if (parsed.errors.length === 0) {
    appendAcceptedRawAttempt(rawAttempts, {
      stage: 'execution_setup',
      rawResponse: response,
      initialInput,
    })
  }

  if (!activeSession) {
    throw new Error('Execution setup session was not available after prompt completion')
  }

  return {
    session: activeSession,
    output: response,
    result: parsed.result,
    parse: parsed,
    structuredOutput,
    rawAttempts,
  }
}
