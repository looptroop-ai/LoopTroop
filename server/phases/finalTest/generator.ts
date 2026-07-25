import type { OpenCodeAdapter } from '../../opencode/adapter'
import type { PromptPart, StreamEvent } from '../../opencode/types'
import { buildPromptFromTemplate, PROM52 } from '../../prompts/index'
import {
  formatPromptText,
  runOpenCodePrompt,
  runOpenCodeSessionPrompt,
  type OpenCodePromptCompletedEvent,
  type OpenCodePromptDispatchEvent,
} from '../../workflow/runOpenCodePrompt'
import { throwIfAborted, type RawAttempt } from '../../council/types'
import { throwIfCancelled } from '../../lib/abort'
import { parseFinalTestCommands, type FinalTestCommandPlan } from './parser'
import { buildStructuredRetryPrompt } from '../../structuredOutput'
import { buildStructuredOutputMetadata } from '../../structuredOutput/metadata'
import { SessionManager } from '../../opencode/sessionManager'
import { COUNCIL_RESPONSE_TIMEOUT_MS } from '../../lib/constants'
import { getStructuredRetryDecision } from '../../lib/structuredOutputRetry'
import type { StructuredOutputMetadata } from '../../structuredOutput/types'
import { resolveStructuredRetryDiagnostic } from '../../lib/structuredRetryDiagnostics'
import { normalizeStructuredRetryCount, shouldRetryStructuredOutput } from '../../lib/structuredRetryPolicy'
import { appendAcceptedRawAttempt, appendRejectedRawAttempt } from '../../lib/structuredRawAttempts'
import { detectHostContext } from '../../lib/hostContext'
import { getCommandSpecPromptExample } from '@shared/commandSpec'

const FINAL_TEST_SCHEMA_REMINDER = [
  'Return exactly one <FINAL_TEST_COMMANDS>...</FINAL_TEST_COMMANDS> block and nothing else.',
  'Inside the marker, return a single JSON or YAML object with a non-empty commands field.',
  `commands must contain CommandSpec objects shaped like ${JSON.stringify(getCommandSpecPromptExample())}.`,
  'Prefer mode "process" with a program and args. Use mode "shell" only when repository evidence requires shell syntax.',
  'test_files must list the paths of all test files you created or modified (relative to the project root).',
  'modified_files must list every permanent repository file created or modified during the final-test phase that should remain in the final candidate. It must include every path from test_files.',
  'summary is optional. tests_count is optional.',
].join('\n')

export interface FinalTestGenerationResult {
  output: string
  commandPlan: FinalTestCommandPlan
  structuredOutput: StructuredOutputMetadata
  rawAttempts?: RawAttempt[]
}

type FinalTestPromptStage = 'final_test_main' | 'final_test_structured_retry'

export async function generateFinalTests(
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
    onSessionCreated?: (sessionId: string) => void
    onOpenCodeStreamEvent?: (entry: { sessionId: string; event: StreamEvent }) => void
    onPromptDispatched?: (entry: { sessionId: string; event: OpenCodePromptDispatchEvent }) => void
    onPromptCompleted?: (entry: { stage: FinalTestPromptStage; event: OpenCodePromptCompletedEvent }) => void
  },
): Promise<FinalTestGenerationResult> {
  const hostContext = detectHostContext()
  const promptContent = buildPromptFromTemplate(PROM52, [
    ...ticketContext,
    {
      type: 'text',
      source: 'host_context',
      content: JSON.stringify(hostContext, null, 2),
    },
  ])
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
      toolPolicy: PROM52.toolPolicy,
      ...(callbacks?.ticketId
        ? {
            sessionOwnership: {
              ticketId: callbacks.ticketId,
              phase: 'RUNNING_FINAL_TEST',
              phaseAttempt: callbacks.phaseAttempt ?? 1,
              keepActive: true,
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
        callbacks?.onOpenCodeStreamEvent?.({
          sessionId,
          event,
        })
      },
      onPromptDispatched: (event) => {
        callbacks?.onPromptDispatched?.({
          sessionId: event.session.id,
          event,
        })
      },
      onPromptCompleted: (event) => {
        callbacks?.onPromptCompleted?.({
          stage: 'final_test_main',
          event,
        })
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
  let commandPlan = parseFinalTestCommands(response)
  const rawAttempts: RawAttempt[] = []
  const retryDiagnostics: NonNullable<StructuredOutputMetadata['retryDiagnostics']> = []
  const structuredRetryCount = normalizeStructuredRetryCount(callbacks?.structuredRetryCount)
  let retryAttemptsUsed = 0
  let structuredOutput = buildStructuredOutputMetadata({
    autoRetryCount: 0,
    repairApplied: Boolean(commandPlan.repairApplied),
    repairWarnings: commandPlan.repairWarnings ?? [],
    ...(commandPlan.validationError ? { validationError: commandPlan.validationError } : {}),
  })
  while (commandPlan.errors.length > 0) {
    const validationError = commandPlan.validationError ?? commandPlan.errors.join('; ')
    const retryDecision = getStructuredRetryDecision(response, result.responseMeta)
    const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
      stage: 'final_test_generation',
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
      retryDiagnostic: commandPlan.retryDiagnostic,
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
          schemaReminder: FINAL_TEST_SCHEMA_REMINDER,
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
          toolPolicy: PROM52.toolPolicy,
          onStreamEvent: (event) => {
            if (!sessionId) return
            callbacks?.onOpenCodeStreamEvent?.({
              sessionId,
              event,
            })
          },
          onPromptDispatched: (event) => {
            callbacks?.onPromptDispatched?.({
              sessionId: event.session.id,
              event,
            })
          },
          onPromptCompleted: (event) => {
            callbacks?.onPromptCompleted?.({
              stage: 'final_test_structured_retry',
              event,
            })
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
          toolPolicy: PROM52.toolPolicy,
          ...(callbacks?.ticketId
            ? {
                sessionOwnership: {
                  ticketId: callbacks.ticketId,
                  phase: 'RUNNING_FINAL_TEST',
                  phaseAttempt: callbacks.phaseAttempt ?? 1,
                  keepActive: true,
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
            callbacks?.onOpenCodeStreamEvent?.({
              sessionId,
              event,
            })
          },
          onPromptDispatched: (event) => {
            callbacks?.onPromptDispatched?.({
              sessionId: event.session.id,
              event,
            })
          },
          onPromptCompleted: (event) => {
            callbacks?.onPromptCompleted?.({
              stage: 'final_test_main',
              event,
            })
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

    commandPlan = parseFinalTestCommands(response)
    structuredOutput = buildStructuredOutputMetadata(structuredOutput, {
      repairApplied: Boolean(commandPlan.repairApplied),
      repairWarnings: commandPlan.repairWarnings ?? [],
      ...(commandPlan.validationError ? { validationError: commandPlan.validationError } : {}),
    })
  }

  if (commandPlan.errors.length === 0) {
    appendAcceptedRawAttempt(rawAttempts, {
      stage: 'final_test_generation',
      rawResponse: response,
      initialInput,
    })
  }

  if (activeSessionId && sessionManager) {
    await sessionManager.completeSession(activeSessionId)
  }

  return {
    output: response,
    commandPlan,
    structuredOutput,
    rawAttempts,
  }
}
