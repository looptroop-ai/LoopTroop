import type { OpenCodeAdapter } from '../../opencode/adapter'
import type { PromptPart, StreamEvent } from '../../opencode/types'
import { throwIfAborted } from '../../council/types'
import type {
  OpenCodePromptCompletedEvent,
  OpenCodePromptDispatchEvent,
} from '../../workflow/runOpenCodePrompt'
import { generateExecutionSetup, type GenerateExecutionSetupResult } from './generator'
import type {
  ExecutionSetupAttemptHistoryEntry,
  ExecutionSetupGenerationResult,
  ExecutionSetupReport,
} from './types'
import { renderCommandSpec } from '@shared/commandSpec'
import { createWorkBudget, type WorkBudget } from '../../workflow/workBudget'

type ContextPartsInput = PromptPart[] | (() => Promise<PromptPart[]>)

const REPEATED_TOOLING_FAILURE_MESSAGE = 'Repeated tooling setup failure detected; stopping early because the same tooling blocker repeated after a provisioning attempt.'
const MAX_EXTRA_TOOLING_PERSISTENCE_ATTEMPTS = 2

export interface ExecutionSetupAttemptTiming {
  timeoutMs: number
  timeoutDeadline?: number
  /**
   * The attempt's work budget.
   *
   * Carried alongside `timeoutDeadline` rather than replacing it because the
   * deadline is also reported to the operator as a fixed time. The budget is
   * what the clocks read: it moves when a question wait is credited back.
   */
  budget?: WorkBudget
}

interface ExecutionSetupAttemptStartMetadata extends ExecutionSetupAttemptTiming {
  baseMaxIterations: number
  isManualContinuationAttempt: boolean
  isExtraToolingPersistenceAttempt: boolean
  extraToolingPersistenceAttempt: number
  maxExtraToolingPersistenceAttempts: number
}

async function resolveContextParts(input: ContextPartsInput): Promise<PromptPart[]> {
  if (typeof input === 'function') return await input()
  return input
}

function normalizeToolingFailureText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function buildToolingFailureSignature(report: ExecutionSetupReport): string | null {
  if (report.checks?.tooling !== 'fail') return null
  const parts = [
    report.summary,
    ...(report.errors ?? []),
    report.profile?.summary,
    ...(report.profile?.cautions ?? []),
  ]
    .map(normalizeToolingFailureText)
    .filter(Boolean)
  return parts.length > 0 ? parts.join('|') : null
}

function countDistinctFailedProvisioningStrategies(report: ExecutionSetupReport): number {
  if (report.checks?.tooling !== 'fail') return 0
  let maxStrategyCount = 0
  for (const requirement of report.profile?.toolRequirements ?? []) {
    if (requirement.status !== 'failed') continue
    const strategyNames = new Set<string>()
    for (const attempt of requirement.provisioningAttempts) {
      if (!attempt.strategy.trim()) continue
      if (!attempt.commands.some((command) => renderCommandSpec(command).trim().length > 0)) continue
      strategyNames.add(attempt.strategy.trim().toLowerCase())
    }
    maxStrategyCount = Math.max(maxStrategyCount, strategyNames.size)
  }
  return maxStrategyCount
}

function hasNoSafePathToolingEvidence(report: ExecutionSetupReport): boolean {
  if (report.checks?.tooling !== 'fail') return false
  return (report.profile?.toolRequirements ?? []).some((requirement) => (
    requirement.status === 'not_provisionable'
    && requirement.failureReason.trim().length > 0
  ))
}

function hasTerminalToolingFailureEvidence(report: ExecutionSetupReport): boolean {
  return hasNoSafePathToolingEvidence(report) || countDistinctFailedProvisioningStrategies(report) >= 2
}

function needsToolingPersistenceRetry(report: ExecutionSetupReport): boolean {
  if (report.checks?.tooling !== 'fail') return false
  if (hasNoSafePathToolingEvidence(report)) return false
  const distinctStrategyCount = countDistinctFailedProvisioningStrategies(report)
  return distinctStrategyCount > 0 && distinctStrategyCount < 2
}

function withRepeatedToolingFailureError(report: ExecutionSetupReport): ExecutionSetupReport {
  if (report.errors.includes(REPEATED_TOOLING_FAILURE_MESSAGE)) return report
  return {
    ...report,
    status: 'failed',
    ready: false,
    errors: [...report.errors, REPEATED_TOOLING_FAILURE_MESSAGE],
  }
}

function buildAttemptHistoryEntry(
  attempt: number,
  report: ExecutionSetupReport,
): ExecutionSetupAttemptHistoryEntry {
  return {
    attempt,
    status: report.status,
    checkedAt: report.checkedAt,
    summary: report.summary,
    tempRoots: report.profile?.tempRoots ?? [],
    bootstrapCommands: report.profile?.bootstrapCommands ?? [],
    toolingProbeCommands: report.profile?.toolingProbeCommands ?? [],
    errors: [...report.errors],
    failureReason: report.errors[0] ?? undefined,
  }
}

function buildDeterministicExecutionSetupRetryNote(input: {
  attempt: number
  report: ExecutionSetupReport
  generation: ExecutionSetupGenerationResult
}): string {
  const { attempt, report, generation } = input
  const failureReason = report.errors[0]
    ?? generation.parse.errors[0]
    ?? 'Execution setup validation did not pass.'

  const tempRoots = report.profile?.tempRoots.length
    ? ` Temp roots: ${report.profile.tempRoots.join(', ')}.`
    : ''

  return [
    `Attempt ${attempt} failed.`,
    failureReason,
    `${tempRoots}Next attempt: reuse repository-native bootstrap hints, keep setup work minimal, and avoid implementing ticket feature changes during workspace preparation.`,
  ].join(' ').trim()
}

function hasCompleteFailedCommandReceipt(report: ExecutionSetupReport): boolean {
  const receipts = [
    ...(report.profile?.workspaceProbeReceipts ?? []),
    ...(report.profile?.gitHooks.validationReceipts ?? []),
  ]

  return receipts.some((receipt) => (
    (receipt.status === 'failed' || receipt.status === 'timed_out')
    && Boolean(receipt.command && renderCommandSpec(receipt.command).trim().length > 0)
    && Number.isFinite(receipt.durationMs)
    && (receipt.status === 'timed_out' || Number.isInteger(receipt.exitCode))
  ))
}

function hasCommandNotFoundEvidence(report: ExecutionSetupReport): boolean {
  const receiptExitCodes = [
    ...(report.profile?.workspaceProbeReceipts ?? []),
    ...(report.profile?.gitHooks.validationReceipts ?? []),
  ].map((receipt) => receipt.exitCode)
  if (receiptExitCodes.some((exitCode) => exitCode === 126 || exitCode === 127)) return true

  const failureText = [
    ...report.errors,
    report.summary,
    report.profile?.summary,
    ...(report.profile?.cautions ?? []),
  ].filter((value): value is string => typeof value === 'string').join('\n')

  return /\bexit(?:ed with)?(?: code)?\s+(?:126|127)\b|command not found|not recognized as (?:an internal or external )?command/i.test(failureText)
}

function hasDeterministicRetryEvidence(
  report: ExecutionSetupReport,
  generation: ExecutionSetupGenerationResult,
): boolean {
  if (!generation.parse.markerFound || generation.output.trim().length === 0) return true
  if (hasCommandNotFoundEvidence(report)) return true
  return hasCompleteFailedCommandReceipt(report)
}

function withToolingPersistenceGuidance(note: string, report: ExecutionSetupReport): string {
  if (!needsToolingPersistenceRetry(report)) return note
  const guidance = 'Next attempt must not repeat the same provisioning command unchanged; try another distinct safe, repository-appropriate provisioning strategy under approved temp roots before returning checks.tooling=fail.'
  return note.includes(guidance) ? note : `${note} ${guidance}`.trim()
}

function withRetryMetadata(
  report: ExecutionSetupReport,
  input: {
    attempt: number
    maxIterations: number
    attemptHistory: ExecutionSetupAttemptHistoryEntry[]
    retryNotes: string[]
  },
): ExecutionSetupReport {
  return {
    ...report,
    attempt: input.attempt,
    maxIterations: input.maxIterations,
    attemptHistory: input.attemptHistory,
    retryNotes: input.retryNotes,
  }
}

export async function executeExecutionSetupWithRetries(
  adapter: OpenCodeAdapter,
  contextParts: ContextPartsInput,
  projectPath: string,
  signal: AbortSignal | undefined,
  options: {
    ticketId?: string
    model: string
    variant?: string
    maxIterations: number
    timeoutMs: number
    structuredRetryCount?: number
    initialRetryNotes?: string[]
    initialAttempt?: number
    additionalManualIterations?: number
  },
  callbacks: {
    evaluateGeneration: (input: {
      attempt: number
      generation: GenerateExecutionSetupResult
      timing: ExecutionSetupAttemptTiming
    }) => Promise<ExecutionSetupReport>
    generateRetryNote?: (input: {
      attempt: number
      report: ExecutionSetupReport
      generation: GenerateExecutionSetupResult
      notes: string[]
      timing: ExecutionSetupAttemptTiming
    }) => Promise<string | null | undefined>
    onAttemptStart?: (attempt: number, metadata: ExecutionSetupAttemptStartMetadata) => void | Promise<void>
    onAttemptComplete?: (input: {
      attempt: number
      report: ExecutionSetupReport
      generation: GenerateExecutionSetupResult
    }) => void | Promise<void>
    onRetryAnalysisStart?: (input: {
      attempt: number
      report: ExecutionSetupReport
      generation: GenerateExecutionSetupResult
    }) => void | Promise<void>
    onSessionCreated?: (sessionId: string, attempt: number) => void
    onOpenCodeStreamEvent?: (entry: { sessionId: string; attempt: number; event: StreamEvent }) => void
    onPromptDispatched?: (entry: { sessionId: string; attempt: number; event: OpenCodePromptDispatchEvent }) => void
    onPromptCompleted?: (entry: { attempt: number; stage: string; event: OpenCodePromptCompletedEvent }) => void
    onStructuredRetryStart?: (entry: { attempt: number; sessionId: string; retryAttempt: number }) => void
    onFailedAttempt?: (input: {
      attempt: number
      report: ExecutionSetupReport
      generation: GenerateExecutionSetupResult
      note: string
      notes: string[]
      canRetry: boolean
    }) => void | Promise<void>
    beforeRetry?: (input: {
      attempt: number
      nextAttempt: number
      report: ExecutionSetupReport
      generation: GenerateExecutionSetupResult
      note: string
      notes: string[]
    }) => void | Promise<void>
    onRetriesExhausted?: (input: {
      attempt: number
      maxIterations: number
      report: ExecutionSetupReport
      notes: string[]
      reason?: 'exhausted' | 'repeated_tooling_failure' | 'not_provisionable'
    }) => void | Promise<void>
  },
): Promise<ExecutionSetupReport> {
  const notes: string[] = [...(options.initialRetryNotes ?? [])]
  const attemptHistory: ExecutionSetupAttemptHistoryEntry[] = []
  const toolingFailureSignatures: string[] = []
  let extraToolingPersistenceAttemptsUsed = 0
  let attempt = (options.initialAttempt ?? 1) - 1
  const attemptsUsedAtStart = attempt
  const hasManualContinuationBudget = (options.additionalManualIterations ?? 0) > 0
  const iterationLimit = hasManualContinuationBudget
    ? attemptsUsedAtStart + (options.additionalManualIterations ?? 0)
    : options.maxIterations

  // Each attempt registers its budget in the ticket's ledger, which holds it
  // until it is released — and two of the exits from this loop are `return`s
  // from part-way through an attempt. Collected here so every way out releases
  // them, rather than leaving a dead budget per setup attempt behind.
  const attemptBudgets: WorkBudget[] = []
  try {
    while (
      (!hasManualContinuationBudget && iterationLimit <= 0)
      || attempt < iterationLimit + extraToolingPersistenceAttemptsUsed
    ) {
      attempt += 1
      throwIfAborted(signal)
      const attemptBudget = createWorkBudget({
        ...(options.ticketId ? { ticketId: options.ticketId } : {}),
        ...(options.timeoutMs > 0 ? { totalMs: options.timeoutMs } : {}),
        scope: 'execution_setup',
      })
      attemptBudgets.push(attemptBudget)
      const timing: ExecutionSetupAttemptTiming = {
        timeoutMs: options.timeoutMs,
        ...(options.timeoutMs > 0 ? { timeoutDeadline: Date.now() + options.timeoutMs } : {}),
        budget: attemptBudget,
      }
      await callbacks.onAttemptStart?.(attempt, {
        ...timing,
        baseMaxIterations: options.maxIterations,
        isManualContinuationAttempt: hasManualContinuationBudget
          && attempt > attemptsUsedAtStart
          && attempt <= iterationLimit,
        isExtraToolingPersistenceAttempt: iterationLimit > 0 && attempt > iterationLimit,
        extraToolingPersistenceAttempt: iterationLimit > 0
          ? Math.max(0, attempt - iterationLimit)
          : 0,
        maxExtraToolingPersistenceAttempts: MAX_EXTRA_TOOLING_PERSISTENCE_ATTEMPTS,
      })

      const generation = await generateExecutionSetup(
        adapter,
        await resolveContextParts(contextParts),
        projectPath,
        signal,
        {
          ticketId: options.ticketId,
          model: options.model,
          variant: options.variant,
          timeoutMs: options.timeoutMs,
          timeoutDeadline: timing.timeoutDeadline,
          budget: attemptBudget,
          structuredRetryCount: options.structuredRetryCount,
          phaseAttempt: attempt,
          manualContinuation: hasManualContinuationBudget
            && attempt > attemptsUsedAtStart
            && attempt <= iterationLimit,
          onSessionCreated: (sessionId) => {
            callbacks.onSessionCreated?.(sessionId, attempt)
          },
          onOpenCodeStreamEvent: ({ sessionId, event }) => {
            callbacks.onOpenCodeStreamEvent?.({ sessionId, attempt, event })
          },
          onPromptDispatched: ({ sessionId, event }) => {
            callbacks.onPromptDispatched?.({ sessionId, attempt, event })
          },
          onPromptCompleted: ({ stage, event }) => {
            callbacks.onPromptCompleted?.({ attempt, stage, event })
          },
          onStructuredRetryStart: ({ sessionId, retryAttempt }) => {
            callbacks.onStructuredRetryStart?.({ attempt, sessionId, retryAttempt })
          },
        },
      )
      throwIfAborted(signal)

      const report = await callbacks.evaluateGeneration({ attempt, generation, timing })
      const toolingFailureSignature = buildToolingFailureSignature(report)
      const repeatedToolingFailure = toolingFailureSignature !== null
        && toolingFailureSignatures[toolingFailureSignatures.length - 1] === toolingFailureSignature
        && hasTerminalToolingFailureEvidence(report)
      if (toolingFailureSignature) {
        toolingFailureSignatures.push(toolingFailureSignature)
      }
      const finalReport = repeatedToolingFailure
        ? withRepeatedToolingFailureError(report)
        : report
      const attemptEntry = buildAttemptHistoryEntry(attempt, finalReport)
      attemptHistory.push(attemptEntry)
      await callbacks.onAttemptComplete?.({ attempt, report: finalReport, generation })

      if (finalReport.ready) {
        return withRetryMetadata(finalReport, {
          attempt,
          maxIterations: options.maxIterations,
          attemptHistory,
          retryNotes: [...notes],
        })
      }

      await callbacks.onRetryAnalysisStart?.({
        attempt,
        report: finalReport,
        generation,
      })

      let note: string | null | undefined
      const useDeterministicRetryNote = hasDeterministicRetryEvidence(finalReport, generation)
        && !needsToolingPersistenceRetry(finalReport)
      if (!useDeterministicRetryNote) {
        try {
          note = await callbacks.generateRetryNote?.({
            attempt,
            report: finalReport,
            generation,
            notes: [...notes],
            timing,
          })
        } catch {
          note = null
        }
      }

      const resolvedNote = withToolingPersistenceGuidance(note?.trim() || buildDeterministicExecutionSetupRetryNote({
        attempt,
        report: finalReport,
        generation,
      }), finalReport)
      notes.push(resolvedNote)
      attemptEntry.noteAppended = resolvedNote

      const withinBaseBudget = (!hasManualContinuationBudget && iterationLimit <= 0)
        || attempt < iterationLimit
      const canUseExtraToolingPersistenceAttempt = options.maxIterations > 0
        && (options.additionalManualIterations ?? 0) <= 0
        && !withinBaseBudget
        && needsToolingPersistenceRetry(finalReport)
        && extraToolingPersistenceAttemptsUsed < MAX_EXTRA_TOOLING_PERSISTENCE_ATTEMPTS
      const hasImmediateNoSafePathBlocker = hasNoSafePathToolingEvidence(finalReport)
      const canRetry = !repeatedToolingFailure
        && !hasImmediateNoSafePathBlocker
        && (withinBaseBudget || canUseExtraToolingPersistenceAttempt)
      await callbacks.onFailedAttempt?.({
        attempt,
        report: finalReport,
        generation,
        note: resolvedNote,
        notes: [...notes],
        canRetry,
      })

      if (!canRetry) {
        await callbacks.onRetriesExhausted?.({
          attempt,
          maxIterations: options.maxIterations,
          report: finalReport,
          notes: [...notes],
          reason: repeatedToolingFailure
            ? 'repeated_tooling_failure'
            : hasImmediateNoSafePathBlocker
              ? 'not_provisionable'
              : 'exhausted',
        })
        return withRetryMetadata(finalReport, {
          attempt,
          maxIterations: options.maxIterations,
          attemptHistory,
          retryNotes: [...notes],
        })
      }

      if (canUseExtraToolingPersistenceAttempt) {
        extraToolingPersistenceAttemptsUsed += 1
      }

      await callbacks.beforeRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        report: finalReport,
        generation,
        note: resolvedNote,
        notes: [...notes],
      })
    }

    return {
      status: 'failed',
      ready: false,
      checkedAt: new Date().toISOString(),
      preparedBy: options.model,
      profile: null,
      checks: null,
      modelOutput: '',
      errors: ['Execution setup retry loop terminated unexpectedly'],
      attempt,
      maxIterations: options.maxIterations,
      attemptHistory,
      retryNotes: notes,
    }
  } finally {
    for (const attemptBudget of attemptBudgets) attemptBudget.release()
  }
}
