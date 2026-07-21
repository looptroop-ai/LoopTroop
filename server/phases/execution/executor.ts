import type { OpenCodeAdapter } from '../../opencode/adapter'
import type { Bead } from '../beads/types'
import type { Message, PromptPart, Session, StreamEvent } from '../../opencode/types'
import type { BlockedErrorDiagnostics } from '@shared/errorDiagnostics'
import { parseCompletionMarker } from './completionChecker'
import {
  clearOpenCodePromptDispatchCount,
  runOpenCodePrompt,
  runOpenCodeSessionPrompt,
  type OpenCodePromptCompletedEvent,
  type OpenCodePromptDispatchEvent,
} from '../../workflow/runOpenCodePrompt'
import { PROFILE_DEFAULTS } from '../../db/defaults'
import { throwIfAborted } from '../../council/types'
import { throwIfCancelled } from '../../lib/abort'
import { buildStructuredRetryPrompt } from '../../structuredOutput'
import { SessionManager } from '../../opencode/sessionManager'
import { COUNCIL_RESPONSE_TIMEOUT_MS, EXECUTOR_NOTE_TRUNCATION_LENGTH, EXECUTOR_DETAIL_TRUNCATION_LENGTH } from '../../lib/constants'
import { getStructuredRetryDecision } from '../../lib/structuredOutputRetry'
import { normalizeStructuredRetryCount } from '../../lib/structuredRetryPolicy'
import { buildPromptFromTemplate, buildSameSessionPromptFromTemplate, PROM_CODING, PROM51 } from '../../prompts/index'
import { BEAD_RETRY_BUDGET_EXHAUSTED } from '../../../shared/errorCodes'
import {
  buildOpenCodeBlockedErrorDiagnostics,
  mergeErrorCodes,
  type OpenCodeBlockedErrorDiagnosticsResult,
} from '../../opencode/blockedErrorDiagnostics'
import {
  attachContinuationDiagnostics,
  clearSessionContinuation,
  shouldPreserveSessionForContinuation,
} from '../../opencode/sessionContinuation'
import { isContinuableOpenCodeRetryMessage, type OpenCodeRetryPolicy } from '../../opencode/retryPolicy'
import { isWorkflowDeadlineTimeoutError, WorkflowDeadlineTimeoutError } from '../../lib/deadlineErrors'
import { runShellCommand } from '../../lib/shellCommand'

const BEAD_STATUS_SCHEMA_REMINDER = [
  'Return exactly one <BEAD_STATUS>...</BEAD_STATUS> block and nothing else.',
  'Inside the marker, return a single JSON or YAML object with: bead_id, status, checks.',
  'checks must contain exactly: tests, lint, typecheck, qualitative.',
  'If work is complete, every check must be pass and status must be done.',
  'If work is not complete, return the same shape with status error and include a short reason field.',
].join('\n')

const CONTINUE_CODING_SCHEMA_REMINDER = [
  'Continue working in this same session until the bead is actually complete.',
  'Do not stop because lint, tests, or typecheck failed; inspect the real failures, fix them, and rerun the same checks.',
  'Do not reply with a plain-text progress update or plan. Keep using tools and continue working until you can return the final marker.',
  'Do not return status error while iteration time remains unless the app interrupts you.',
  'Return exactly one <BEAD_STATUS>...</BEAD_STATUS> block and nothing else when all required checks pass.',
  'Inside the final marker, use status done and checks.tests/lint/typecheck/qualitative = pass.',
].join('\n')

const ESCAPE_CHARACTER = String.fromCharCode(27)
const BELL_CHARACTER = String.fromCharCode(7)
const ANSI_OSC_SEQUENCE = new RegExp(`${ESCAPE_CHARACTER}\\][^${BELL_CHARACTER}]*(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\)`, 'g')
const ANSI_CSI_SEQUENCE = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, 'g')
const ANSI_SINGLE_SEQUENCE = new RegExp(`${ESCAPE_CHARACTER}[@-_]`, 'g')

export interface ExecutionResult {
  beadId: string
  success: boolean
  iteration: number
  output: string
  errors: string[]
  rawAttempts?: ExecutionRawAttempt[]
  errorCodes?: string[]
  diagnostics?: BlockedErrorDiagnostics | null
  verificationCommands: BeadVerificationCommandReceipt[]
}

export interface BeadVerificationCommandReceipt {
  command: string
  iteration: number
  commandIndex: number
  effectiveCommand?: string
  setupWrapperApplied: boolean
  checkedAt: string
  durationMs: number
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  passed: boolean
  failureClass?: 'process_start' | 'timeout' | 'exit' | 'signal'
  outputExcerpt: string
}

export type ExecutionRawAttemptOutcome = 'accepted' | 'rejected' | 'failed' | 'timed_out' | 'cancelled'

export interface ExecutionRawAttempt {
  attempt: number
  iteration: number
  status: ExecutionRawAttemptOutcome
  outcome: ExecutionRawAttemptOutcome
  initialInput: string
  rawResponse?: string
  modelOutput?: string
  error?: string
  validationError?: string
  failureClass?: string
  modelId?: string
  sessionId?: string
  errorCodes?: string[]
  diagnostics?: BlockedErrorDiagnostics | null
}

type ContextPartsInput = PromptPart[] | (() => Promise<PromptPart[]>)
type CodingPromptStage =
  | 'coding_main'
  | 'coding_continue'
  | 'coding_verification'
  | 'coding_structured_retry'
  | 'context_wipe_note'
type ContextWipeReason = 'failure' | 'iteration_timeout'

async function resolveContextParts(input: ContextPartsInput): Promise<PromptPart[]> {
  if (typeof input === 'function') {
    return await input()
  }
  return input
}

function getRemainingTimeoutMs(deadlineAt: number | undefined): number | undefined {
  return deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - Date.now())
}

function buildContinuationPrompt(
  beadId: string,
  errors: string[],
  previousResponse: string,
): PromptPart[] {
  const failureSummary = errors.join('; ') || 'Completion marker was not accepted.'
  const prompt = [
    '## Continue Bead Execution',
    '',
    `Bead: ${beadId}`,
    '',
    'The current bead attempt is still in progress. Do not stop yet.',
    'Inspect the real failures, keep editing code in this same session, rerun the failing checks, and continue until the bead is actually complete or the app interrupts you.',
    '',
    `Current blocker summary: ${failureSummary}`,
    '',
    CONTINUE_CODING_SCHEMA_REMINDER,
    '',
    'Previous response:',
    '```',
    previousResponse,
    '```',
  ].join('\n')
  return [{ type: 'text', content: prompt }]
}

function stripAnsiSequences(text: string): string {
  return text
    .replace(ANSI_OSC_SEQUENCE, '')
    .replace(ANSI_CSI_SEQUENCE, '')
    .replace(ANSI_SINGLE_SEQUENCE, '')
}

function buildVerificationFailurePrompt(beadId: string, receipt: BeadVerificationCommandReceipt): PromptPart[] {
  const outcome = receipt.timedOut
    ? `timed out after ${receipt.durationMs}ms`
    : `exited with code ${receipt.exitCode ?? 'unknown'}`
  return [{
    type: 'text',
    content: [
      '## Deterministic Test Verification Failed',
      '',
      `Bead: ${beadId}`,
      `Command: ${receipt.command}`,
      `Result: ${outcome}`,
      receipt.failureClass ? `Failure class: ${receipt.failureClass}` : '',
      receipt.effectiveCommand ? `Effective command: ${receipt.effectiveCommand}` : '',
      receipt.signal ? `Signal: ${receipt.signal}` : '',
      '',
      'LoopTroop ran this declared bead test command independently. The bead is not complete yet.',
      'Inspect this real failure, fix it, rerun the relevant checks, and continue working in this same session.',
      '',
      'Output excerpt:',
      '```',
      receipt.outputExcerpt || 'No command output was captured.',
      '```',
      '',
      CONTINUE_CODING_SCHEMA_REMINDER,
    ].join('\n'),
  }]
}

function toVerificationReceipt(
  result: Awaited<ReturnType<typeof runShellCommand>>,
  iteration: number,
  commandIndex: number,
): BeadVerificationCommandReceipt {
  const combinedOutput = stripAnsiSequences([result.stdout, result.stderr].filter(Boolean).join('\n')).trim()
  const failureClass = result.timedOut
    ? 'timeout'
    : result.exitCode !== null
      ? 'exit'
      : result.signal
        ? 'signal'
        : 'process_start'
  return {
    command: result.command,
    iteration,
    commandIndex,
    ...(result.effectiveCommand ? { effectiveCommand: result.effectiveCommand } : {}),
    setupWrapperApplied: result.setupWrapperApplied,
    checkedAt: new Date().toISOString(),
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    passed: result.exitCode === 0 && !result.timedOut,
    ...(!(result.exitCode === 0 && !result.timedOut) ? { failureClass } : {}),
    outputExcerpt: truncateForNote(combinedOutput, EXECUTOR_DETAIL_TRUNCATION_LENGTH),
  }
}

function formatVerificationFailure(receipt: BeadVerificationCommandReceipt): string {
  const outcome = receipt.timedOut
    ? `timed out after ${receipt.durationMs}ms`
    : receipt.signal
      ? `terminated by ${receipt.signal}`
      : receipt.exitCode === null
        ? 'could not start'
        : `exited with code ${receipt.exitCode}`
  const details = [
    `Declared test command ${outcome}: ${receipt.command}`,
    receipt.failureClass ? `Failure class: ${receipt.failureClass}` : '',
    receipt.effectiveCommand ? `Effective command: ${receipt.effectiveCommand}` : '',
    receipt.outputExcerpt ? `Output excerpt: ${receipt.outputExcerpt}` : 'Output excerpt: no command output was captured.',
  ].filter(Boolean)
  return details.join('\n')
}

function shouldUseStructuredRetry(result: ReturnType<typeof parseCompletionMarker>): boolean {
  return !result.complete && (!result.markerFound || Boolean(result.validationError))
}

function shouldRememberOpenCodeDiagnostics(result: OpenCodeBlockedErrorDiagnosticsResult): boolean {
  const kind = result.diagnostics?.kind
  return Boolean(kind && kind !== 'runtime' && kind !== 'unknown')
}

function classifyFailedRawAttempt(reason: ContextWipeReason, errors: string[]): ExecutionRawAttemptOutcome {
  if (reason === 'iteration_timeout') return 'timed_out'
  const combined = errors.join('\n')
  if (/completion marker|validation|structured retry|schema/i.test(combined)) return 'rejected'
  return 'failed'
}

function truncateForNote(text: string, maxLength = EXECUTOR_NOTE_TRUNCATION_LENGTH): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}...`
}

function extractRecentFailureExcerpts(messages: Message[], maxItems = 5): string[] {
  const excerpts: string[] = []

  for (let messageIndex = messages.length - 1; messageIndex >= 0 && excerpts.length < maxItems; messageIndex -= 1) {
    const message = messages[messageIndex]
    const parts = Array.isArray(message?.parts) ? message.parts : []
    for (let partIndex = parts.length - 1; partIndex >= 0 && excerpts.length < maxItems; partIndex -= 1) {
      const part = parts[partIndex]
      if (part?.type !== 'tool') continue
      const toolName = typeof part.tool === 'string' ? part.tool : 'tool'
      const state = typeof part.state === 'object' && part.state !== null
        ? part.state as {
            status?: string
            error?: string
            output?: string
          }
        : null
      const status = state?.status
      const rawDetails = typeof state?.error === 'string'
        ? state.error
        : typeof state?.output === 'string'
          ? state.output
          : ''
      const details = truncateForNote(rawDetails, EXECUTOR_DETAIL_TRUNCATION_LENGTH)
      const looksFailing = status === 'error' || /fail|error|exception|not ok|timed out/i.test(rawDetails)
      if (!looksFailing) continue
      excerpts.push(`${toolName} (${status ?? 'unknown'}): ${details || 'No details captured.'}`)
    }
  }

  return excerpts
}

function buildFallbackContextWipeNote(options: {
  iteration: number
  errors: string[]
  recentFailureExcerpts: string[]
  lastOutput: string
}): string {
  const lines = [
    `Attempt ${options.iteration} failed or stalled before completion.`,
    `Errors: ${options.errors.join(' | ') || 'No explicit error recorded.'}`,
  ]

  if (options.recentFailureExcerpts.length > 0) {
    lines.push(`Recent failures: ${options.recentFailureExcerpts.join(' | ')}`)
  }

  const lastOutput = truncateForNote(options.lastOutput, 500)
  if (lastOutput) {
    lines.push(`Last model output: ${lastOutput}`)
  }

  lines.push('Next attempt: start from the clean bead snapshot, rerun the failing checks, and do not stop until every required gate passes or the app times out the iteration.')
  return lines.join('\n')
}

async function generateContextWipeNote(
  adapter: OpenCodeAdapter,
  session: Session,
  bead: Bead,
  iterationErrors: string[],
  lastOutput: string,
  recentFailureExcerpts: string[],
  signal?: AbortSignal,
  options?: {
    model?: string
    variant?: string
    iteration?: number
    onOpenCodeStreamEvent?: (entry: { sessionId: string; iteration: number; event: StreamEvent }) => void
    onPromptDispatched?: (entry: { sessionId: string; iteration: number; event: OpenCodePromptDispatchEvent }) => void
    onPromptCompleted?: (entry: { iteration: number; stage: CodingPromptStage; event: OpenCodePromptCompletedEvent }) => void
  },
): Promise<string> {
  const errorContext: PromptPart = {
    type: 'text',
    source: 'error_context',
    content: [
      `## Failed Iteration Errors`,
      iterationErrors.join('\n'),
      '',
      `## Recent Failure Excerpts`,
      recentFailureExcerpts.length > 0 ? recentFailureExcerpts.map((entry) => `- ${entry}`).join('\n') : 'No recent failing tool or test excerpts captured.',
      '',
      `## Last Output (truncated)`,
      lastOutput.slice(0, 2000),
    ].join('\n'),
  }

  const beadData: PromptPart = {
    type: 'text',
    source: 'bead_data',
    content: JSON.stringify(bead, null, 2),
  }

  const promptContent = buildSameSessionPromptFromTemplate(PROM51, [beadData, errorContext])
  const result = await runOpenCodeSessionPrompt({
    adapter,
    session,
    parts: [{ type: 'text', content: promptContent }],
    signal,
    timeoutMs: COUNCIL_RESPONSE_TIMEOUT_MS,
    model: options?.model,
    variant: options?.variant,
    erroredSessionPolicy: 'discard_errored_session_output',
    toolPolicy: PROM51.toolPolicy,
    onStreamEvent: (event) => {
      if (options?.iteration == null) return
      options.onOpenCodeStreamEvent?.({
        sessionId: session.id,
        iteration: options.iteration,
        event,
      })
    },
    onPromptDispatched: (event) => {
      if (options?.iteration == null) return
      options.onPromptDispatched?.({
        sessionId: event.session.id,
        iteration: options.iteration,
        event,
      })
    },
    onPromptCompleted: (event) => {
      if (options?.iteration == null) return
      options.onPromptCompleted?.({
        iteration: options.iteration,
        stage: 'context_wipe_note',
        event,
      })
    },
  })

  return result.response.trim()
}

export async function executeBead(
  adapter: OpenCodeAdapter,
  bead: Bead,
  contextParts: ContextPartsInput,
  projectPath: string,
  maxIterations: number = PROFILE_DEFAULTS.maxIterations,
  timeout: number = PROFILE_DEFAULTS.perIterationTimeout,
  signal?: AbortSignal,
  callbacks?: {
    ticketId?: string
    model?: string
    variant?: string
    onSessionCreated?: (sessionId: string, iteration: number) => void
    onOpenCodeStreamEvent?: (entry: { sessionId: string; iteration: number; event: StreamEvent }) => void
    onPromptDispatched?: (entry: { sessionId: string; iteration: number; event: OpenCodePromptDispatchEvent }) => void
    onPromptCompleted?: (entry: { iteration: number; stage: CodingPromptStage; event: OpenCodePromptCompletedEvent }) => void
    onContextWipe?: (entry: {
      beadId: string
      failedIterationNotes: Bead['failedIterationNotes']
      iteration: number
      reason: ContextWipeReason
      attempt: number
      nextAttempt: number
      maxAttempts: number | null
    }) => Promise<void>
    onContinuableTimeoutPreserved?: (entry: { beadId: string; sessionId: string; iteration: number; message: string }) => void
    commandWrapper?: string
    onVerificationCommand?: (entry: {
      beadId: string
      iteration: number
      receipt: BeadVerificationCommandReceipt
      stdout: string
      stderr: string
    }) => void
    structuredRetryCount?: number
    opencodeRetryPolicy?: Partial<OpenCodeRetryPolicy>
  },
): Promise<ExecutionResult> {
  const startingIteration = Number.isInteger(bead.iteration) && bead.iteration > 0
    ? bead.iteration
    : 1
  const maxAttemptIteration = maxIterations > 0
    ? startingIteration + maxIterations - 1
    : null
  let iteration = startingIteration
  let lastAttemptIteration = startingIteration - 1
  let lastOutput = ''
  const errors: string[] = []
  const rawAttempts: ExecutionRawAttempt[] = []
  const verificationCommands: BeadVerificationCommandReceipt[] = []
  const latestOpenCodeDiagnostics: { current: OpenCodeBlockedErrorDiagnosticsResult | null } = { current: null }
  const currentIterationOpenCodeDiagnostics: { current: OpenCodeBlockedErrorDiagnosticsResult | null } = { current: null }
  const sessionManager = callbacks?.ticketId ? new SessionManager(adapter) : null
  const structuredRetryCount = normalizeStructuredRetryCount(callbacks?.structuredRetryCount)

  const recordRawAttempt = (input: {
    iteration: number
    status: ExecutionRawAttemptOutcome
    initialInput: string
    rawResponse?: string
    errors?: string[]
    validationError?: string
    failureClass?: string
    sessionId?: string | null
    diagnostics?: BlockedErrorDiagnostics | null
    errorCodes?: string[]
  }) => {
    const attempt = input.iteration - startingIteration + 1
    const existingIndex = rawAttempts.findIndex((entry) => entry.iteration === input.iteration)
    const errorText = input.errors?.filter(Boolean).join('\n')
    const entry: ExecutionRawAttempt = {
      attempt,
      iteration: input.iteration,
      status: input.status,
      outcome: input.status,
      initialInput: input.initialInput,
      ...(input.rawResponse ? { rawResponse: input.rawResponse, modelOutput: input.rawResponse } : {}),
      ...(errorText ? { error: errorText } : {}),
      ...(input.validationError ? { validationError: input.validationError } : {}),
      ...(input.failureClass ? { failureClass: input.failureClass } : {}),
      ...(callbacks?.model ? { modelId: callbacks.model } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.errorCodes && input.errorCodes.length > 0 ? { errorCodes: input.errorCodes } : {}),
      ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    }

    if (existingIndex >= 0) {
      const existing = rawAttempts[existingIndex]!
      const rawResponse = entry.rawResponse ?? existing.rawResponse
      const modelOutput = entry.modelOutput ?? existing.modelOutput
      rawAttempts[existingIndex] = {
        ...existing,
        ...entry,
        initialInput: entry.initialInput || existing.initialInput,
        ...(rawResponse ? { rawResponse } : {}),
        ...(modelOutput ? { modelOutput } : {}),
      }
      return
    }

    rawAttempts.push(entry)
  }

  const rememberOpenCodeDiagnostics = (result: OpenCodeBlockedErrorDiagnosticsResult) => {
    if (shouldRememberOpenCodeDiagnostics(result)) {
      latestOpenCodeDiagnostics.current = result
      currentIterationOpenCodeDiagnostics.current = result
    }
  }

  const rememberOpenCodeStreamDiagnostics = (sessionId: string, event: StreamEvent) => {
    if (event.type === 'session_status' && event.status === 'retry' && isContinuableOpenCodeRetryMessage(event.message)) {
      rememberOpenCodeDiagnostics(buildOpenCodeBlockedErrorDiagnostics({
        modelId: callbacks?.model,
        sessionId,
        fallbackMessage: event.message,
      }))
      return
    }

    if (event.type === 'session_error') {
      rememberOpenCodeDiagnostics(buildOpenCodeBlockedErrorDiagnostics({
        modelId: callbacks?.model,
        sessionId,
        responseMeta: {
          hasAssistantMessage: false,
          latestAssistantWasEmpty: true,
          latestAssistantHasError: false,
          latestAssistantWasStale: false,
          sessionErrored: true,
          sessionError: event.error,
          sessionErrorDetails: event.details,
        },
      }))
      return
    }

    if (event.type === 'step' && event.step === 'finish') {
      rememberOpenCodeDiagnostics(buildOpenCodeBlockedErrorDiagnostics({
        modelId: callbacks?.model,
        sessionId,
        responseMeta: {
          hasAssistantMessage: false,
          latestAssistantWasEmpty: true,
          latestAssistantHasError: false,
          latestAssistantWasStale: false,
          sessionErrored: false,
          latestStepFinishReason: event.reason,
          latestStepFinishTokens: event.tokens,
        },
      }))
    }
  }

  const rememberPromptCompletedDiagnostics = (event: OpenCodePromptCompletedEvent) => {
    rememberOpenCodeDiagnostics(buildOpenCodeBlockedErrorDiagnostics({
      modelId: callbacks?.model,
      sessionId: event.session.id,
      responseMeta: event.responseMeta,
      attemptMeta: event.attemptMeta,
    }))
  }

  while (maxAttemptIteration == null || iteration <= maxAttemptIteration) {
    lastAttemptIteration = iteration
    currentIterationOpenCodeDiagnostics.current = null
    throwIfAborted(signal)
    let activeSessionId: string | null = null
    let activeSession: Session | null = null
    const iterationErrors: string[] = []
    let contextWipeReason: ContextWipeReason = 'failure'
    let latestMessages: Message[] = []
    let iterationInitialInput = ''
    let iterationOutput = ''
    const deadlineAt = timeout > 0 ? Date.now() + timeout : undefined

    try {
      let sessionId = ''
      const resolvedContextParts = await resolveContextParts(contextParts)
      const promptContent = buildPromptFromTemplate(
        PROM_CODING,
        resolvedContextParts.filter((part) => part.type !== 'file'),
      )
      iterationInitialInput = promptContent
      const beadPrompt: PromptPart[] = [
        {
          type: 'text',
          content: promptContent,
        },
        // Keep SDK file parts out of the rendered text template and forward
        // them intact. Manual QA image evidence relies on the OpenCode file
        // part contract; provider/context failures must surface normally.
        ...resolvedContextParts.filter((part) => part.type === 'file'),
      ]

      const runBeadPrompt = () => runOpenCodePrompt({
        adapter,
        projectPath,
        parts: beadPrompt,
        signal,
        timeoutMs: getRemainingTimeoutMs(deadlineAt),
        deadlineScope: 'workflow',
        model: callbacks?.model,
        variant: callbacks?.variant,
        opencodeRetryPolicy: callbacks?.opencodeRetryPolicy,
        erroredSessionPolicy: 'discard_errored_session_output',
        toolPolicy: PROM_CODING.toolPolicy,
        ...(callbacks?.ticketId
          ? {
              sessionOwnership: {
                ticketId: callbacks.ticketId,
                phase: 'CODING',
                memberId: callbacks.model,
                beadId: bead.id,
                iteration,
                keepActive: true,
              },
            }
          : {}),
        onSessionCreated: (session) => {
          sessionId = session.id
          activeSessionId = session.id
          activeSession = session
          callbacks?.onSessionCreated?.(session.id, iteration)
        },
        onStreamEvent: (event) => {
          if (!sessionId) return
          rememberOpenCodeStreamDiagnostics(sessionId, event)
          callbacks?.onOpenCodeStreamEvent?.({
            sessionId,
            iteration,
            event,
          })
        },
        onPromptDispatched: (event) => {
          callbacks?.onPromptDispatched?.({
            sessionId: event.session.id,
            iteration,
            event,
          })
        },
        onPromptCompleted: (event) => {
          rememberPromptCompletedDiagnostics(event)
          callbacks?.onPromptCompleted?.({
            iteration,
            stage: 'coding_main',
            event,
          })
        },
      })

      let runResult = await runBeadPrompt()
      let structuredRetryAttempts = 0
      const codingSessionOwnership = callbacks?.ticketId
        ? {
            ticketId: callbacks.ticketId,
            phase: 'CODING',
            memberId: callbacks.model,
            beadId: bead.id,
            iteration,
            keepActive: true,
          }
        : undefined

      while (true) {
        throwIfAborted(signal)
        activeSessionId = runResult.session.id
        activeSession = runResult.session
        lastOutput = runResult.response
        iterationOutput = runResult.response
        latestMessages = runResult.messages

        const result = parseCompletionMarker(lastOutput)
        if (result.complete && result.gatesValid) {
          let failedVerification: BeadVerificationCommandReceipt | null = null
          for (const [commandIndex, command] of bead.testCommands.entries()) {
            const remainingMs = getRemainingTimeoutMs(deadlineAt)
            if (remainingMs !== undefined && remainingMs <= 0) {
              throw new WorkflowDeadlineTimeoutError({ phase: 'CODING', beadId: bead.id, iteration, timeoutMs: timeout })
            }
            const commandResult = await runShellCommand({
              command,
              cwd: projectPath,
              timeoutMs: remainingMs,
              commandWrapper: callbacks?.commandWrapper,
            })
            const receipt = toVerificationReceipt(commandResult, iteration, commandIndex)
            verificationCommands.push(receipt)
            callbacks?.onVerificationCommand?.({
              beadId: bead.id,
              iteration,
              receipt,
              stdout: commandResult.stdout,
              stderr: commandResult.stderr,
            })
            if (!receipt.passed) {
              failedVerification = receipt
              break
            }
          }

          if (failedVerification) {
            const verificationError = formatVerificationFailure(failedVerification)
            if (!iterationErrors.includes(verificationError)) iterationErrors.push(verificationError)

            const remainingMs = getRemainingTimeoutMs(deadlineAt)
            if (failedVerification.timedOut || (remainingMs !== undefined && remainingMs <= 0)) {
              throw new WorkflowDeadlineTimeoutError({ phase: 'CODING', beadId: bead.id, iteration, timeoutMs: timeout })
            }

            runResult = await runOpenCodeSessionPrompt({
              adapter,
              session: runResult.session,
              parts: buildVerificationFailurePrompt(bead.id, failedVerification),
              signal,
              timeoutMs: remainingMs,
              deadlineScope: 'workflow',
              model: callbacks?.model,
              variant: callbacks?.variant,
              sessionOwnership: codingSessionOwnership,
              opencodeRetryPolicy: callbacks?.opencodeRetryPolicy,
              erroredSessionPolicy: 'discard_errored_session_output',
              toolPolicy: PROM_CODING.toolPolicy,
              onStreamEvent: (event) => {
                rememberOpenCodeStreamDiagnostics(runResult.session.id, event)
                callbacks?.onOpenCodeStreamEvent?.({ sessionId: runResult.session.id, iteration, event })
              },
              onPromptDispatched: (event) => {
                callbacks?.onPromptDispatched?.({ sessionId: event.session.id, iteration, event })
              },
              onPromptCompleted: (event) => {
                rememberPromptCompletedDiagnostics(event)
                callbacks?.onPromptCompleted?.({ iteration, stage: 'coding_verification', event })
              },
            })
            continue
          }

          recordRawAttempt({
            iteration,
            status: 'accepted',
            initialInput: iterationInitialInput,
            rawResponse: iterationOutput,
            sessionId: activeSessionId,
          })
          if (activeSessionId && sessionManager) {
            await sessionManager.completeSession(activeSessionId)
            clearOpenCodePromptDispatchCount(activeSessionId)
            activeSessionId = null
          }
          activeSession = null
          return { beadId: bead.id, success: true, iteration, output: lastOutput, errors: [], rawAttempts, verificationCommands }
        }

        const incompleteSummary = result.errors.join(', ') || 'Incomplete'
        if (!iterationErrors.includes(incompleteSummary)) {
          iterationErrors.push(incompleteSummary)
        }

        const remainingMs = getRemainingTimeoutMs(deadlineAt)
        if (remainingMs !== undefined && remainingMs <= 0) {
          throw new WorkflowDeadlineTimeoutError({
            phase: 'CODING',
            beadId: bead.id,
            iteration,
            timeoutMs: timeout,
          })
        }

        if (shouldUseStructuredRetry(result)) {
          if (structuredRetryAttempts >= structuredRetryCount) {
            throw new Error(`Completion marker failed validation after ${structuredRetryCount} structured retry attempt(s): ${result.errors.join('; ') || 'Completion marker missing or invalid.'}`)
          }
          structuredRetryAttempts += 1
          const retryDecision = getStructuredRetryDecision(lastOutput, runResult.responseMeta)
          if (retryDecision.reuseSession) {
            const retryParts = buildStructuredRetryPrompt([], {
              validationError: result.errors.join('; ') || 'Completion marker missing or invalid.',
              rawResponse: lastOutput,
              schemaReminder: BEAD_STATUS_SCHEMA_REMINDER,
            })
            runResult = await runOpenCodeSessionPrompt({
              adapter,
              session: runResult.session,
              parts: retryParts,
              signal,
              timeoutMs: remainingMs,
              deadlineScope: 'workflow',
              model: callbacks?.model,
              sessionOwnership: codingSessionOwnership,
              opencodeRetryPolicy: callbacks?.opencodeRetryPolicy,
              erroredSessionPolicy: 'discard_errored_session_output',
              onStreamEvent: (event) => {
                rememberOpenCodeStreamDiagnostics(runResult.session.id, event)
                callbacks?.onOpenCodeStreamEvent?.({
                  sessionId: runResult.session.id,
                  iteration,
                  event,
                })
              },
              onPromptDispatched: (event) => {
                callbacks?.onPromptDispatched?.({
                  sessionId: event.session.id,
                  iteration,
                  event,
                })
              },
              onPromptCompleted: (event) => {
                rememberPromptCompletedDiagnostics(event)
                callbacks?.onPromptCompleted?.({
                  iteration,
                  stage: 'coding_structured_retry',
                  event,
                })
              },
            })
            continue
          }

          if (activeSessionId && sessionManager) {
            await sessionManager.abandonSession(activeSessionId)
            clearOpenCodePromptDispatchCount(activeSessionId)
            activeSessionId = null
          }
          activeSession = null
          runResult = await runBeadPrompt()
          continue
        }

        runResult = await runOpenCodeSessionPrompt({
          adapter,
          session: runResult.session,
          parts: buildContinuationPrompt(bead.id, result.errors, lastOutput),
          signal,
          timeoutMs: remainingMs,
          deadlineScope: 'workflow',
          model: callbacks?.model,
          variant: callbacks?.variant,
          sessionOwnership: codingSessionOwnership,
          opencodeRetryPolicy: callbacks?.opencodeRetryPolicy,
          erroredSessionPolicy: 'discard_errored_session_output',
          toolPolicy: PROM_CODING.toolPolicy,
          onStreamEvent: (event) => {
            rememberOpenCodeStreamDiagnostics(runResult.session.id, event)
            callbacks?.onOpenCodeStreamEvent?.({
              sessionId: runResult.session.id,
              iteration,
              event,
            })
          },
          onPromptDispatched: (event) => {
            callbacks?.onPromptDispatched?.({
              sessionId: event.session.id,
              iteration,
              event,
            })
          },
          onPromptCompleted: (event) => {
            rememberPromptCompletedDiagnostics(event)
            callbacks?.onPromptCompleted?.({
              iteration,
              stage: 'coding_continue',
              event,
            })
          },
        })
      }
    } catch (err) {
      throwIfCancelled(err, signal)
      const workflowDeadlineTimedOut = isWorkflowDeadlineTimeoutError(err)
      if (workflowDeadlineTimedOut) {
        contextWipeReason = 'iteration_timeout'
        iterationErrors.push('Coding iteration timed out before the completion marker or deterministic verification finished.')
      } else {
        rememberOpenCodeDiagnostics(buildOpenCodeBlockedErrorDiagnostics({
          error: err,
          modelId: callbacks?.model,
          sessionId: activeSessionId ?? undefined,
          fallbackMessage: err instanceof Error ? err.message : undefined,
        }))
      }
      if (
        !workflowDeadlineTimedOut
        && activeSessionId
        && callbacks?.ticketId
        && shouldPreserveSessionForContinuation({
          error: err,
          sessionId: activeSessionId,
          modelId: callbacks.model,
          sessionOwnership: {
            ticketId: callbacks.ticketId,
            phase: 'CODING',
            memberId: callbacks.model,
            beadId: bead.id,
            iteration,
            keepActive: true,
          },
          signal,
        })
      ) {
        const continuableError = err instanceof Error ? err : new Error(String(err))
        const diagnosticResult = buildOpenCodeBlockedErrorDiagnostics({
          error: continuableError,
          modelId: callbacks.model,
          sessionId: activeSessionId,
          fallbackMessage: continuableError.message,
        })
        if (diagnosticResult.diagnostics?.kind === 'timeout') {
          callbacks.onContinuableTimeoutPreserved?.({
            beadId: bead.id,
            sessionId: activeSessionId,
            iteration,
            message: `OpenCode/provider timeout for session ${activeSessionId}; preserving session for Continue.`,
          })
        }
        throw attachContinuationDiagnostics(continuableError, {
          error: continuableError,
          sessionId: activeSessionId,
          modelId: callbacks.model,
        })
      }
      const msg = err instanceof Error ? err.message : 'Unknown error'
      iterationErrors.push(msg)
    }

    if (iterationErrors.length === 0) {
      iterationErrors.push('Incomplete')
    }

    const formattedIterationErrors = iterationErrors.map((msg) => `Iteration ${iteration}: ${msg}`)
    errors.push(...formattedIterationErrors)
    const contextWipeSession = activeSession
    const contextWipeSessionId = activeSessionId
    const openCodeDiagnosticsForAttempt = currentIterationOpenCodeDiagnostics.current as OpenCodeBlockedErrorDiagnosticsResult | null
    const attemptFailureStatus = classifyFailedRawAttempt(contextWipeReason, formattedIterationErrors)
    recordRawAttempt({
      iteration,
      status: attemptFailureStatus,
      initialInput: iterationInitialInput,
      rawResponse: iterationOutput,
      errors: formattedIterationErrors,
      validationError: attemptFailureStatus === 'rejected' ? formattedIterationErrors.join('\n') : undefined,
      failureClass: openCodeDiagnosticsForAttempt?.diagnostics?.kind ?? attemptFailureStatus,
      sessionId: contextWipeSessionId,
      diagnostics: openCodeDiagnosticsForAttempt?.diagnostics ?? null,
      errorCodes: openCodeDiagnosticsForAttempt?.errorCodes,
    })

    activeSession = null
    activeSessionId = null

    const recentFailureExcerpts = extractRecentFailureExcerpts(latestMessages)
    let note = ''
    try {
      if (contextWipeSession) {
        note = await generateContextWipeNote(
          adapter,
          contextWipeSession,
          bead,
          formattedIterationErrors,
          lastOutput,
          recentFailureExcerpts,
          signal,
          {
            model: callbacks?.model,
            variant: callbacks?.variant,
            iteration,
            onOpenCodeStreamEvent: ({ sessionId, event }) => {
              rememberOpenCodeStreamDiagnostics(sessionId, event)
              callbacks?.onOpenCodeStreamEvent?.({ sessionId, iteration, event })
            },
            onPromptDispatched: callbacks?.onPromptDispatched,
            onPromptCompleted: (entry) => {
              rememberPromptCompletedDiagnostics(entry.event)
              callbacks?.onPromptCompleted?.(entry)
            },
          },
        )
      }
    } catch {
      // Best effort only; deterministic fallback note below keeps the retry durable.
    }

    const effectiveNote = note || buildFallbackContextWipeNote({
      iteration,
      errors: formattedIterationErrors,
      recentFailureExcerpts,
      lastOutput,
    })

    bead.failedIterationNotes.push({
      timestamp: new Date().toISOString(),
      iteration,
      content: stripAnsiSequences(effectiveNote),
    })
    const attempt = iteration - startingIteration + 1
    try {
      await callbacks?.onContextWipe?.({
        beadId: bead.id,
        failedIterationNotes: [...bead.failedIterationNotes],
        iteration,
        reason: contextWipeReason,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: maxIterations > 0 ? maxIterations : null,
      })
    } finally {
      if (contextWipeSessionId && sessionManager) {
        await sessionManager.abandonSession(contextWipeSessionId)
        clearSessionContinuation(contextWipeSessionId)
        clearOpenCodePromptDispatchCount(contextWipeSessionId)
      }
    }
    throwIfAborted(signal)

    if (maxAttemptIteration !== null && iteration >= maxAttemptIteration) {
      break
    }
    iteration++
  }

  if (maxAttemptIteration !== null && lastAttemptIteration >= maxAttemptIteration) {
    errors.push(`Reached the configured per-bead retry budget at iteration ${lastAttemptIteration}.`)
  }

  const baseErrorCodes = maxAttemptIteration !== null && lastAttemptIteration >= maxAttemptIteration
    ? [BEAD_RETRY_BUDGET_EXHAUSTED]
    : []
  const openCodeDiagnostics = latestOpenCodeDiagnostics.current
  const errorCodes = mergeErrorCodes(baseErrorCodes, openCodeDiagnostics?.errorCodes ?? [])

  return {
    beadId: bead.id,
    success: false,
    iteration: lastAttemptIteration,
    output: lastOutput,
    errors,
    rawAttempts,
    verificationCommands,
    ...(errorCodes.length > 0 ? { errorCodes } : {}),
    ...(openCodeDiagnostics?.diagnostics ? { diagnostics: openCodeDiagnostics.diagnostics } : {}),
  }
}
