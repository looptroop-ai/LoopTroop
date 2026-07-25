import type { OpenCodeAdapter } from '../../opencode/adapter'
import type { PromptPart, StreamEvent } from '../../opencode/types'
import { throwIfAborted } from '../../council/types'
import type { OpenCodePromptCompletedEvent, OpenCodePromptDispatchEvent } from '../../workflow/runOpenCodePrompt'
import {
  generateFinalTests,
  type FinalTestGenerationResult,
} from './generator'
import type {
  FinalTestAttemptHistoryEntry,
  FinalTestExecutionReport,
} from './runner'
import { renderCommandSpec } from '@shared/commandSpec'

type ContextPartsInput = PromptPart[] | (() => Promise<PromptPart[]>)

async function resolveContextParts(input: ContextPartsInput): Promise<PromptPart[]> {
  if (typeof input === 'function') {
    return await input()
  }
  return input
}

function buildDeterministicFinalTestRetryNote(input: {
  attempt: number
  report: FinalTestExecutionReport
  generation: FinalTestGenerationResult
}): string {
  const { attempt, report, generation } = input
  const commandSummary = report.commands.length > 0
    ? report.commands
      .map((command) => (
        command.timedOut
          ? `${command.displayCommand} (timed out after ${command.durationMs}ms)`
          : `${command.displayCommand} (exit ${command.exitCode ?? 'unknown'})`
      ))
      .join('; ')
    : generation.commandPlan.commands.map((command) => renderCommandSpec(command)).join('; ')
      || 'No executable final-test commands were returned.'
  const failureReason = report.errors[0]
    ?? generation.commandPlan.errors[0]
    ?? 'Final-test verification did not pass.'
  const testFiles = report.testFiles.length > 0
    ? ` Test files: ${report.testFiles.join(', ')}.`
    : ''

  return [
    `Attempt ${attempt} failed.`,
    failureReason,
    `Commands: ${commandSummary}.`,
    `${testFiles}Next attempt: inspect the real failure output, preserve ticket scope, and change implementation and/or final tests instead of weakening coverage.`,
  ].filter(Boolean).join(' ').trim()
}

function buildAttemptHistoryEntry(
  attempt: number,
  report: FinalTestExecutionReport,
): FinalTestAttemptHistoryEntry {
  return {
    attempt,
    status: report.status,
    checkedAt: report.checkedAt,
    summary: report.summary,
    commands: report.commands.map((command) => command.command),
    testFiles: report.testFiles,
    modifiedFiles: report.modifiedFiles,
    fileEffects: report.fileEffects,
    errors: [...report.errors],
    failureReason: report.errors[0] ?? undefined,
  }
}

function withRetryMetadata(
  report: FinalTestExecutionReport,
  input: {
    attempt: number
    maxIterations: number
    attemptHistory: FinalTestAttemptHistoryEntry[]
    retryNotes: string[]
  },
): FinalTestExecutionReport {
  return {
    ...report,
    attempt: input.attempt,
    maxIterations: input.maxIterations,
    attemptHistory: input.attemptHistory,
    retryNotes: input.retryNotes,
  }
}

export async function executeFinalTestWithRetries(
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
    aiResponseTimeoutMs?: number
    structuredRetryCount?: number
    initialAttempt?: number
  },
  callbacks: {
    executePlan: (input: { attempt: number; generation: FinalTestGenerationResult }) => Promise<FinalTestExecutionReport>
    generateRetryNote?: (input: {
      attempt: number
      report: FinalTestExecutionReport
      generation: FinalTestGenerationResult
      notes: string[]
    }) => Promise<string | null | undefined>
    onAttemptStart?: (attempt: number) => void | Promise<void>
    onAttemptComplete?: (input: {
      attempt: number
      report: FinalTestExecutionReport
      generation: FinalTestGenerationResult
    }) => void | Promise<void>
    onSessionCreated?: (sessionId: string, attempt: number) => void
    onOpenCodeStreamEvent?: (entry: { sessionId: string; attempt: number; event: StreamEvent }) => void
    onPromptDispatched?: (entry: { sessionId: string; attempt: number; event: OpenCodePromptDispatchEvent }) => void
    onPromptCompleted?: (entry: { attempt: number; stage: string; event: OpenCodePromptCompletedEvent }) => void
    onFailedAttempt?: (input: {
      attempt: number
      report: FinalTestExecutionReport
      generation: FinalTestGenerationResult
      note: string
      notes: string[]
      canRetry: boolean
    }) => void | Promise<void>
    beforeRetry?: (input: {
      attempt: number
      nextAttempt: number
      report: FinalTestExecutionReport
      generation: FinalTestGenerationResult
      note: string
      notes: string[]
    }) => void | Promise<void>
    onRetriesExhausted?: (input: {
      attempt: number
      maxIterations: number
      report: FinalTestExecutionReport
      notes: string[]
    }) => void | Promise<void>
  },
  deps?: {
    generatePlan?: typeof generateFinalTests
  },
): Promise<FinalTestExecutionReport> {
  const generatePlan = deps?.generatePlan ?? generateFinalTests
  const notes: string[] = []
  const attemptHistory: FinalTestAttemptHistoryEntry[] = []
  let attempt = (options.initialAttempt ?? 1) - 1

  while (options.maxIterations <= 0 || attempt < options.maxIterations) {
    attempt += 1
    throwIfAborted(signal)
    await callbacks.onAttemptStart?.(attempt)

    const generation = await generatePlan(
      adapter,
      await resolveContextParts(contextParts),
      projectPath,
      signal,
      {
        ticketId: options.ticketId,
        model: options.model,
        variant: options.variant,
        timeoutMs: options.aiResponseTimeoutMs ?? options.timeoutMs,
        structuredRetryCount: options.structuredRetryCount,
        phaseAttempt: attempt,
        onSessionCreated: (sessionId) => {
          callbacks.onSessionCreated?.(sessionId, attempt)
        },
        onOpenCodeStreamEvent: ({ sessionId, event }) => {
          callbacks.onOpenCodeStreamEvent?.({
            sessionId,
            attempt,
            event,
          })
        },
        onPromptDispatched: ({ sessionId, event }) => {
          callbacks.onPromptDispatched?.({
            sessionId,
            attempt,
            event,
          })
        },
        onPromptCompleted: ({ stage, event }) => {
          callbacks.onPromptCompleted?.({
            attempt,
            stage,
            event,
          })
        },
      },
    )
    throwIfAborted(signal)

    const report = await callbacks.executePlan({ attempt, generation })
    const attemptEntry = buildAttemptHistoryEntry(attempt, report)
    attemptHistory.push(attemptEntry)
    await callbacks.onAttemptComplete?.({ attempt, report, generation })

    if (report.passed) {
      return withRetryMetadata(report, {
        attempt,
        maxIterations: options.maxIterations,
        attemptHistory,
        retryNotes: [...notes],
      })
    }

    let note: string | null | undefined
    try {
      note = await callbacks.generateRetryNote?.({
        attempt,
        report,
        generation,
        notes: [...notes],
      })
    } catch {
      note = null
    }

    const resolvedNote = note?.trim() || buildDeterministicFinalTestRetryNote({
      attempt,
      report,
      generation,
    })
    notes.push(resolvedNote)
    attemptEntry.noteAppended = resolvedNote

    const canRetry = options.maxIterations <= 0 || attempt < options.maxIterations
    await callbacks.onFailedAttempt?.({
      attempt,
      report,
      generation,
      note: resolvedNote,
      notes: [...notes],
      canRetry,
    })

    if (!canRetry) {
      await callbacks.onRetriesExhausted?.({
        attempt,
        maxIterations: options.maxIterations,
        report,
        notes: [...notes],
      })
      return withRetryMetadata(report, {
        attempt,
        maxIterations: options.maxIterations,
        attemptHistory,
        retryNotes: [...notes],
      })
    }

    await callbacks.beforeRetry?.({
      attempt,
      nextAttempt: attempt + 1,
      report,
      generation,
      note: resolvedNote,
      notes: [...notes],
    })
  }

  const failedReport: FinalTestExecutionReport = {
    status: 'failed',
    passed: false,
    checkedAt: new Date().toISOString(),
    plannedBy: options.model,
    modelOutput: '',
    testFiles: [],
    modifiedFiles: [],
    fileEffects: [],
    testsCount: null,
    commands: [],
    errors: ['Final-test retry loop exited without producing a result.'],
  }

  return withRetryMetadata(failedReport, {
    attempt,
    maxIterations: options.maxIterations,
    attemptHistory,
    retryNotes: [...notes],
  })
}
