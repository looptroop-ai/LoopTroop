import type { OpenCodeAdapter } from '../../opencode/adapter'
import type { PromptPart, StreamEvent } from '../../opencode/types'
import {
  buildPromptFromTemplate,
  PROM_EXECUTION_SETUP_PLAN,
  PROM_EXECUTION_SETUP_PLAN_REGENERATE,
} from '../../prompts/index'
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
import { getStructuredRetryDecision } from '../../lib/structuredOutputRetry'
import { resolveStructuredRetryDiagnostic } from '../../lib/structuredRetryDiagnostics'
import { normalizeStructuredRetryCount, shouldRetryStructuredOutput } from '../../lib/structuredRetryPolicy'
import { appendAcceptedRawAttempt, appendRejectedRawAttempt } from '../../lib/structuredRawAttempts'
import type { StructuredOutputMetadata } from '../../structuredOutput/types'
import { parseExecutionSetupPlanResult } from './parser'
import type { ExecutionSetupPlan, ExecutionSetupPlanGenerationResult, ExecutionSetupPlanParseResult } from './types'

const EXECUTION_SETUP_PLAN_SCHEMA_REMINDER = [
  'Return exactly one <EXECUTION_SETUP_PLAN>...</EXECUTION_SETUP_PLAN> block and nothing else.',
  'Inside the marker, return a single JSON or YAML proposal with top-level keys: summary, readiness, workspace_inputs, workspace_probes, git_hooks, steps, project_commands, cautions.',
  'LoopTroop supplies ticket identity, schema/artifact/status, temp roots, host facts, Git policy/detection, quality policy, and derived readiness; do not return those fields.',
  'readiness contains only evidence and gaps.',
  'workspace_inputs must list only concrete ignored or untracked non-reproducible files and directories needed by setup, including category.',
  'Every setup step must include id, title, purpose, commands, required, rationale, and cautions. Use cautions: [] when there are no step-specific cautions.',
].join('\n')

type ExecutionSetupPlanPromptStage =
  | 'execution_setup_plan_main'
  | 'execution_setup_plan_structured_retry'

type ExecutionSetupPlanTemplate =
  | typeof PROM_EXECUTION_SETUP_PLAN
  | typeof PROM_EXECUTION_SETUP_PLAN_REGENERATE

async function applyExecutionSetupPlanValidation(
  parsed: ExecutionSetupPlanParseResult,
  validatePlan: ((plan: ExecutionSetupPlan) => Promise<string[]> | string[]) | undefined,
): Promise<ExecutionSetupPlanParseResult> {
  if (!parsed.plan || !validatePlan) return parsed
  const errors = await validatePlan(parsed.plan)
  if (errors.length === 0) return parsed
  return {
    ...parsed,
    plan: null,
    errors,
    validationError: errors.join('; '),
  }
}

export async function generateExecutionSetupPlan(
  adapter: OpenCodeAdapter,
  ticketContext: PromptPart[],
  projectPath: string,
  signal?: AbortSignal,
  callbacks?: {
    ticketId?: string
    model?: string
    variant?: string
    timeoutMs?: number
    structuredRetryCount?: number
    phaseAttempt?: number
    promptTemplate?: ExecutionSetupPlanTemplate
    validatePlan?: (plan: ExecutionSetupPlan) => Promise<string[]> | string[]
    onSessionCreated?: (sessionId: string) => void
    onOpenCodeStreamEvent?: (entry: { sessionId: string; event: StreamEvent }) => void
    onPromptDispatched?: (entry: { sessionId: string; event: OpenCodePromptDispatchEvent }) => void
    onPromptCompleted?: (entry: { stage: ExecutionSetupPlanPromptStage; event: OpenCodePromptCompletedEvent }) => void
  },
): Promise<ExecutionSetupPlanGenerationResult> {
  const template = callbacks?.promptTemplate ?? PROM_EXECUTION_SETUP_PLAN
  const promptContent = buildPromptFromTemplate(template, ticketContext)
  const promptParts = [{ type: 'text', content: promptContent }] as PromptPart[]
  const initialInput = formatPromptText(promptParts)
  let sessionId = ''
  let activeSessionId: string | null = null
  const sessionManager = callbacks?.ticketId ? new SessionManager(adapter) : null
  throwIfAborted(signal)
  let result: Awaited<ReturnType<typeof runOpenCodePrompt>>

  try {
    result = await runOpenCodePrompt({
      adapter,
      projectPath,
      parts: promptParts,
      signal,
      timeoutMs: callbacks?.timeoutMs ?? COUNCIL_RESPONSE_TIMEOUT_MS,
      timeoutKind: 'ai_response',
      model: callbacks?.model,
      variant: callbacks?.variant,
      erroredSessionPolicy: 'discard_errored_session_output',
      toolPolicy: template.toolPolicy,
      ...(callbacks?.ticketId
        ? {
            sessionOwnership: {
              ticketId: callbacks.ticketId,
              phase: 'WAITING_EXECUTION_SETUP_APPROVAL',
              phaseAttempt: callbacks.phaseAttempt ?? 1,
              keepActive: true,
              step: 'execution_setup_plan',
              ...(callbacks.model ? { memberId: callbacks.model } : {}),
            },
          }
        : {}),
      onSessionCreated: (session) => {
        sessionId = session.id
        activeSessionId = session.id
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
        callbacks?.onPromptCompleted?.({ stage: 'execution_setup_plan_main', event })
      },
    })
  } catch (error) {
    if (activeSessionId && sessionManager) {
      await sessionManager.abandonSession(activeSessionId)
    }
    throwIfCancelled(error, signal)
    throw error
  }

  throwIfAborted(signal)
  activeSessionId = result.session.id

  let response = result.response
  let parsed = await applyExecutionSetupPlanValidation(
    parseExecutionSetupPlanResult(response),
    callbacks?.validatePlan,
  )
  const rawAttempts: RawAttempt[] = []
  const retryDiagnostics: NonNullable<StructuredOutputMetadata['retryDiagnostics']> = []
  const structuredRetryCount = normalizeStructuredRetryCount(callbacks?.structuredRetryCount)
  let retryAttemptsUsed = 0
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
      stage: 'execution_setup_plan',
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
    if (!shouldRetryStructuredOutput(retryAttemptsUsed, structuredRetryCount)) {
      break
    }
    retryAttemptsUsed += 1
    structuredOutput = buildStructuredOutputMetadata(structuredOutput, {
      autoRetryCount: retryAttemptsUsed,
    })

    try {
      if (retryDecision.reuseSession) {
        const retryParts = buildStructuredRetryPrompt([], {
          validationError,
          rawResponse: response,
          schemaReminder: EXECUTION_SETUP_PLAN_SCHEMA_REMINDER,
        })
        const retryResult = await runOpenCodeSessionPrompt({
          adapter,
          session: result.session,
          parts: retryParts,
          signal,
          timeoutMs: callbacks?.timeoutMs ?? COUNCIL_RESPONSE_TIMEOUT_MS,
          timeoutKind: 'ai_response',
          model: callbacks?.model,
          erroredSessionPolicy: 'discard_errored_session_output',
          toolPolicy: template.toolPolicy,
          onStreamEvent: (event) => {
            if (!sessionId) return
            callbacks?.onOpenCodeStreamEvent?.({ sessionId, event })
          },
          onPromptDispatched: (event) => {
            callbacks?.onPromptDispatched?.({ sessionId: event.session.id, event })
          },
          onPromptCompleted: (event) => {
            callbacks?.onPromptCompleted?.({ stage: 'execution_setup_plan_structured_retry', event })
          },
        })
        throwIfAborted(signal)
        result = retryResult
        response = retryResult.response
      } else {
        if (activeSessionId && sessionManager) {
          await sessionManager.abandonSession(activeSessionId)
          activeSessionId = null
        }
        result = await runOpenCodePrompt({
          adapter,
          projectPath,
          parts: promptParts,
          signal,
          timeoutMs: callbacks?.timeoutMs ?? COUNCIL_RESPONSE_TIMEOUT_MS,
          timeoutKind: 'ai_response',
          model: callbacks?.model,
          variant: callbacks?.variant,
          erroredSessionPolicy: 'discard_errored_session_output',
          toolPolicy: template.toolPolicy,
          ...(callbacks?.ticketId
            ? {
                sessionOwnership: {
                  ticketId: callbacks.ticketId,
                  phase: 'WAITING_EXECUTION_SETUP_APPROVAL',
                  phaseAttempt: callbacks.phaseAttempt ?? 1,
                  keepActive: true,
                  step: 'execution_setup_plan',
                  ...(callbacks.model ? { memberId: callbacks.model } : {}),
                },
              }
            : {}),
          onSessionCreated: (session) => {
            sessionId = session.id
            activeSessionId = session.id
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
            callbacks?.onPromptCompleted?.({ stage: 'execution_setup_plan_main', event })
          },
        })
        throwIfAborted(signal)
        activeSessionId = result.session.id
        response = result.response
      }
    } catch (error) {
      if (activeSessionId && sessionManager) {
        await sessionManager.abandonSession(activeSessionId)
        activeSessionId = null
      }
      throwIfCancelled(error, signal)
      throw error
    }

    parsed = await applyExecutionSetupPlanValidation(
      parseExecutionSetupPlanResult(response),
      callbacks?.validatePlan,
    )
    structuredOutput = buildStructuredOutputMetadata(structuredOutput, {
      repairApplied: Boolean(parsed.repairApplied),
      repairWarnings: parsed.repairWarnings ?? [],
      ...(parsed.validationError ? { validationError: parsed.validationError } : {}),
    })
  }

  if (parsed.errors.length === 0) {
    appendAcceptedRawAttempt(rawAttempts, {
      stage: 'execution_setup_plan',
      rawResponse: response,
      initialInput,
    })
  }

  if (activeSessionId && sessionManager) {
    if (parsed.plan) {
      await sessionManager.completeSession(activeSessionId)
    } else {
      await sessionManager.abandonSession(activeSessionId)
    }
  }

  return {
    session: result.session,
    output: response,
    plan: parsed.plan,
    parse: parsed,
    structuredOutput,
    rawAttempts,
  }
}
