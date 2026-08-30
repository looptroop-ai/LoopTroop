import type { TicketContext, TicketEvent } from '../../machines/types'
import { getLatestPhaseArtifact, getTicketPaths, upsertLatestPhaseArtifact } from '../../storage/tickets'
import { isMockOpenCodeMode } from '../../opencode/factory'
import { executeBead, type ExecutionResult } from '../../phases/execution/executor'
import { getNextBead, isAllComplete } from '../../phases/execution/scheduler'
import type { Bead } from '../../phases/beads/types'
import { recordBeadStartCommit, commitBeadChanges, resetToBeadStart, captureBeadDiff, WORKTREE_RESET_PRESERVE_PATHS } from '../../phases/execution/gitOps'
import { throwIfAborted } from '../../council/types'
import { broadcaster } from '../../sse/broadcaster'
import { withCommandLoggingAsync, withCommandLoggingFieldsAsync } from '../../log/commandLogger'
import { adapter } from './state'
import { emitPhaseLog, emitModelSystemLog, emitAiMilestone, emitOpenCodeSessionLogs, emitOpenCodeStreamEvent, emitOpenCodePromptLog, createOpenCodeStreamState, resolveExecutionRuntimeSettings, resolveStructuredRetryRuntimeSettings } from './helpers'
import type { OpenCodeStreamState } from './types'
import { readTicketBeads, recoverCodingBeadWithReset, writeTicketBeads, updateTicketProgressFromBeads } from './beadsPhase'
import { recordBeadMetric } from '../../storage/executionTelemetry'
import {
  clearSessionContinuation,
  hasPendingSessionContinuationForTicketPhase,
} from '../../opencode/sessionContinuation'
import { listOpenCodeSessionsForTicket, SessionManager } from '../../opencode/sessionManager'
import { clearOpenCodePromptDispatchCount } from '../runOpenCodePrompt'
import { ensureLocalGitExclude } from '../../git/repository'
import {
  applyOpencodeStepsConfig,
  OPENCODE_CONFIG_FILENAME,
  reapplyOpencodeStepsConfig,
  restoreOpencodeStepsConfig,
  type OpencodeStepsConfigHandle,
} from '../../phases/execution/opencodeStepsConfig'
import { BEAD_FINALIZATION_FAILED } from '@shared/errorCodes'

const ESCAPE_CHARACTER = String.fromCharCode(27)
const BELL_CHARACTER = String.fromCharCode(7)
const ANSI_OSC_SEQUENCE = new RegExp(`${ESCAPE_CHARACTER}\\][^${BELL_CHARACTER}]*(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\)`, 'g')
const ANSI_CSI_SEQUENCE = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, 'g')
const ANSI_SINGLE_SEQUENCE = new RegExp(`${ESCAPE_CHARACTER}[@-_]`, 'g')

function mergeBeadRetryMetadata(
  beads: Bead[],
  beadId: string,
  options: {
    failedIterationNotes: Bead['failedIterationNotes']
    iteration: number
    status: Bead['status']
    updatedAt?: string
  },
): Bead[] {
  const updatedAt = options.updatedAt ?? new Date().toISOString()
  return beads.map((bead) => {
    if (bead.id !== beadId) return bead
    return {
      ...bead,
      status: options.status,
      failedIterationNotes: options.failedIterationNotes,
      iteration: Math.max(bead.iteration ?? 0, options.iteration),
      updatedAt,
    }
  })
}

function stripAnsiSequences(text: string): string {
  return text
    .replace(ANSI_OSC_SEQUENCE, '')
    .replace(ANSI_CSI_SEQUENCE, '')
    .replace(ANSI_SINGLE_SEQUENCE, '')
}

function conciseFinalizationFailure(message: string): string {
  const clean = stripAnsiSequences(message).trim()
  const excerpt = clean.length <= 1_000 ? clean : `${clean.slice(0, 1_000)}...`
  return `Finalization failed after successful implementation: ${excerpt || 'Unknown error'}`
}

async function abandonInterruptedCodingSessions(
  ticketId: string,
  beadId: string,
  iteration: number,
): Promise<void> {
  const interruptedSessions = listOpenCodeSessionsForTicket(ticketId, ['active'])
    .filter((session) => session.phase === 'CODING'
      && session.beadId === beadId
      && session.iteration === iteration)
  if (interruptedSessions.length === 0) return

  const sessionManager = new SessionManager(adapter)
  await Promise.all(interruptedSessions.map(async (session) => {
    try {
      await adapter.abortSession(session.sessionId)
    } catch (err) {
      console.warn(
        `[executionPhase] Failed to abort interrupted OpenCode session ${session.sessionId}:`,
        err,
      )
    } finally {
      await sessionManager.abandonSession(session.sessionId)
      clearSessionContinuation(session.sessionId)
      clearOpenCodePromptDispatchCount(session.sessionId)
    }
  }))
}

function compareBeadRecoveryOrder(left: Bead, right: Bead) {
  const leftUpdatedAt = Date.parse(left.updatedAt || left.startedAt || left.completedAt || '')
  const rightUpdatedAt = Date.parse(right.updatedAt || right.startedAt || right.completedAt || '')

  if (!Number.isNaN(leftUpdatedAt) || !Number.isNaN(rightUpdatedAt)) {
    if (Number.isNaN(leftUpdatedAt)) return 1
    if (Number.isNaN(rightUpdatedAt)) return -1
    return rightUpdatedAt - leftUpdatedAt
  }

  return right.iteration - left.iteration
}

function getLatestInterruptedInProgressBead(beads: Bead[]): Bead | null {
  return [...beads]
    .filter((bead) => bead.status === 'in_progress')
    .sort(compareBeadRecoveryOrder)[0]
    ?? null
}

function getBeadExecutionArtifactType(beadId: string): string {
  return `bead_execution:${beadId}`
}

function getBeadDiffArtifactType(beadId: string): string {
  return `bead_diff:${beadId}`
}

interface ExecutionCheckpointMetadata {
  beadId: string
  iteration: number
  startedAt: string
  updatedAt: string
  beadStartCommit: string | null
}

type PersistedExecutionCheckpoint = ExecutionResult & {
  checkpoint?: ExecutionCheckpointMetadata
}

function isPersistedExecutionResult(value: unknown, beadId: string): value is ExecutionResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ExecutionResult>
  return candidate.beadId === beadId
    && typeof candidate.success === 'boolean'
    && typeof candidate.iteration === 'number'
    && typeof candidate.output === 'string'
    && Array.isArray(candidate.errors)
    && candidate.errors.every((entry) => typeof entry === 'string')
    && (candidate.errorCodes == null || (Array.isArray(candidate.errorCodes) && candidate.errorCodes.every((entry) => typeof entry === 'string')))
}

function getExecutionCheckpointMetadata(value: unknown): ExecutionCheckpointMetadata | null {
  if (!value || typeof value !== 'object') return null
  const checkpoint = (value as PersistedExecutionCheckpoint).checkpoint
  if (!checkpoint || typeof checkpoint !== 'object') return null
  if (
    typeof checkpoint.beadId !== 'string'
    || typeof checkpoint.iteration !== 'number'
    || typeof checkpoint.startedAt !== 'string'
    || typeof checkpoint.updatedAt !== 'string'
    || !(checkpoint.beadStartCommit === null || typeof checkpoint.beadStartCommit === 'string')
  ) {
    return null
  }
  return checkpoint
}

function isCurrentExecutionCheckpoint(value: unknown, bead: Bead): value is PersistedExecutionCheckpoint {
  if (!isPersistedExecutionResult(value, bead.id)) return false
  const checkpoint = getExecutionCheckpointMetadata(value)
  if (!checkpoint) return false
  return checkpoint.beadId === bead.id
    && checkpoint.iteration === bead.iteration
    && checkpoint.startedAt === bead.startedAt
    && checkpoint.updatedAt === bead.updatedAt
    && checkpoint.beadStartCommit === (bead.beadStartCommit ?? null)
}

function withExecutionCheckpoint(result: ExecutionResult, bead: Bead): PersistedExecutionCheckpoint {
  return {
    ...result,
    checkpoint: {
      beadId: bead.id,
      iteration: bead.iteration,
      startedAt: bead.startedAt,
      updatedAt: bead.updatedAt,
      beadStartCommit: bead.beadStartCommit ?? null,
    },
  }
}

function findRecoverableSuccessfulCheckpoint(ticketId: string, beads: Bead[]): Bead | null {
  const candidates = [...beads]
    .filter((bead) => bead.status === 'error' || bead.status === 'in_progress')
    .sort(compareBeadRecoveryOrder)

  for (const bead of candidates) {
    const executionArtifact = getLatestPhaseArtifact(ticketId, getBeadExecutionArtifactType(bead.id), 'CODING')
    if (!executionArtifact) continue
    try {
      const parsed = JSON.parse(executionArtifact.content) as unknown
      if (
        isPersistedExecutionResult(parsed, bead.id)
        && parsed.success === true
        && isCurrentExecutionCheckpoint(parsed, bead)
      ) {
        return bead
      }
    } catch {
      continue
    }
  }

  return null
}

export function recoverSuccessfulExecutionCheckpointForFinalization(ticketId: string): Bead | null {
  const beads = readTicketBeads(ticketId)
  const checkpointedBead = findRecoverableSuccessfulCheckpoint(ticketId, beads)
  if (!checkpointedBead) return null

  if (checkpointedBead.status === 'in_progress') return checkpointedBead

  const recoveredBeads = beads.map((bead) => bead.id === checkpointedBead.id
    ? {
        ...bead,
        status: 'in_progress' as const,
      }
    : bead)
  writeTicketBeads(ticketId, recoveredBeads)
  updateTicketProgressFromBeads(ticketId, recoveredBeads)
  return recoveredBeads.find((bead) => bead.id === checkpointedBead.id) ?? checkpointedBead
}

function markBeadFinalizationFailed(input: {
  ticketId: string
  context: TicketContext
  finalizingBead: Bead
  freshBeads: Bead[]
  result: ExecutionResult
  codingModelId: string
  sendEvent: (event: TicketEvent) => void
  message: string
}) {
  const failedAt = new Date().toISOString()
  const failureNote = conciseFinalizationFailure(input.message)
  const failedBeads = input.freshBeads.map((bead) => bead.id === input.finalizingBead.id
    ? {
        ...bead,
        status: 'error' as const,
        iteration: input.result.iteration,
        finalizationFailureNotes: [
          ...bead.finalizationFailureNotes,
          {
            timestamp: failedAt,
            iteration: input.result.iteration,
            content: failureNote,
            errorCode: BEAD_FINALIZATION_FAILED,
          },
        ],
      }
    : bead)

  writeTicketBeads(input.ticketId, failedBeads)
  updateTicketProgressFromBeads(input.ticketId, failedBeads)
  emitPhaseLog(
    input.ticketId,
    input.context.externalId,
    'CODING',
    'error',
    `Bead ${input.finalizingBead.id} implementation succeeded but finalization failed: ${input.message}`,
    {
      source: 'system',
      modelId: input.codingModelId,
      beadId: input.finalizingBead.id,
      errorCode: BEAD_FINALIZATION_FAILED,
    },
  )
  input.sendEvent({
    type: 'BEAD_ERROR',
    codes: [BEAD_FINALIZATION_FAILED],
    diagnostics: {
      kind: 'runtime',
      source: 'system',
      summary: `Bead ${input.finalizingBead.id} implementation succeeded, but finalization failed: ${input.message}`,
      modelId: input.codingModelId,
      isRetryable: true,
    },
  })
}

export async function handleMockExecutionUnsupported(
  ticketId: string,
  context: TicketContext,
  phase: string,
  sendEvent: (event: TicketEvent) => void,
) {
  const message = 'Mock OpenCode mode stops before execution. Start a real OpenCode server to continue past planning phases.'
  emitPhaseLog(ticketId, context.externalId, phase, 'error', message)
  sendEvent({ type: 'ERROR', message, codes: ['MOCK_EXECUTION_UNSUPPORTED'] })
}

export async function handleCoding(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  return withCommandLoggingAsync(
    ticketId, context.externalId, 'CODING',
    async () => {
  const paths = getTicketPaths(ticketId)
  if (!paths) throw new Error(`Ticket workspace not initialized: missing ticket paths for ${context.externalId}`)

  let beads = readTicketBeads(ticketId)
  if (beads.length === 0) {
    throw new Error('No beads available for execution')
  }

  if (isAllComplete(beads)) {
    updateTicketProgressFromBeads(ticketId, beads)
    sendEvent({ type: 'ALL_BEADS_DONE' })
    return
  }

  if (isMockOpenCodeMode()) {
    await handleMockExecutionUnsupported(ticketId, context, 'CODING', sendEvent)
    return
  }

  const codingModelId = context.lockedMainImplementer
  if (!codingModelId) {
    throw new Error('No locked main implementer is configured for coding')
  }

  const executionSettings = resolveExecutionRuntimeSettings(context)
  let stepsConfig: OpencodeStepsConfigHandle | null = null
  const reportStepsConfig = (message: string) => {
    emitModelSystemLog(ticketId, context.externalId, 'CODING', 'info', message, codingModelId)
  }

  /**
   * `git clean` would delete a project's own untracked `opencode.json`, which
   * the run is holding a modified copy of. Preserving it is what makes the
   * restore afterwards possible at all.
   */
  const resetPreservePaths = () => (stepsConfig
    ? [...WORKTREE_RESET_PRESERVE_PATHS, OPENCODE_CONFIG_FILENAME]
    : [...WORKTREE_RESET_PRESERVE_PATHS])

  /** A reset returns a tracked config to its committed state, cap and all. */
  const reapplyStepsConfigAfterReset = () => {
    if (stepsConfig) reapplyOpencodeStepsConfig(stepsConfig, reportStepsConfig)
  }

  // Inside the `try`, so a failure anywhere after the file is written — the git
  // exclude included — still reaches the restore in the `finally`.
  try {
    if (executionSettings.opencodeSteps > 0) {
      const outcome = applyOpencodeStepsConfig({
        ticketDir: paths.ticketDir,
        worktreePath: paths.worktreePath,
        steps: executionSettings.opencodeSteps,
        report: reportStepsConfig,
      })
      if (outcome.applied) {
        stepsConfig = outcome.handle
        // Only a file this run created is ours to hide from git. A project that
        // ships its own `opencode.json` has already decided how it is tracked —
        // it is kept out of the bead commit instead, at the commit itself.
        if (outcome.handle.created) {
          ensureLocalGitExclude(paths.worktreePath, ['/' + OPENCODE_CONFIG_FILENAME])
        }
      }
    }

  let activeBead = getLatestInterruptedInProgressBead(beads)
  let beadStartCommit: string | null = activeBead?.beadStartCommit ?? null
  let result: ExecutionResult | null = null
  const continueActiveBead = Boolean(activeBead && hasPendingSessionContinuationForTicketPhase(ticketId, 'CODING'))

  if (activeBead && !continueActiveBead) {
    const executionArtifact = getLatestPhaseArtifact(ticketId, getBeadExecutionArtifactType(activeBead.id), 'CODING')
    if (executionArtifact) {
      try {
        const parsed = JSON.parse(executionArtifact.content) as unknown
        if (!isPersistedExecutionResult(parsed, activeBead.id)) {
          throw new Error('artifact payload did not match the execution result schema')
        }
        if (!parsed.success) {
          throw new Error('artifact does not contain a successful result awaiting finalization')
        }
        if (!isCurrentExecutionCheckpoint(parsed, activeBead)) {
          throw new Error('artifact checkpoint does not match the current in-progress bead state')
        }
        result = parsed
        emitPhaseLog(
          ticketId,
          context.externalId,
          'CODING',
          'info',
          `Recovered interrupted bead ${activeBead.id} from its current execution checkpoint and will resume finalization without re-executing.`,
          { source: 'system', modelId: codingModelId, beadId: activeBead.id },
        )
      } catch (err) {
        emitPhaseLog(
          ticketId,
          context.externalId,
          'CODING',
          'info',
          `Execution checkpoint for bead ${activeBead.id} was invalid; resetting it to its start snapshot before retrying: ${err instanceof Error ? err.message : 'Unknown error'}`,
          { source: 'system', modelId: codingModelId, beadId: activeBead.id },
        )
        activeBead = null
        beadStartCommit = null
      }
    }
  }

  if (!result) {
    let executingBead: Bead

    if (continueActiveBead && activeBead) {
      emitPhaseLog(
        ticketId,
        context.externalId,
        'CODING',
        'info',
        `Continuing preserved OpenCode session for bead ${activeBead.id}.`,
        { source: 'system', modelId: codingModelId, beadId: activeBead.id },
      )
      executingBead = activeBead
      updateTicketProgressFromBeads(ticketId, beads)
    } else {
      const interruptedBead = recoverCodingBeadWithReset(ticketId, {
        worktreePath: paths.worktreePath,
        onlyInProgress: true,
        requireReset: true,
        preservePaths: resetPreservePaths(),
        consumeInterruptedIteration: {
          failureNote: 'Iteration was interrupted before its OpenCode session could be resumed; restarted from the bead start snapshot.',
        },
      })
      if (interruptedBead) {
        const interruptedIteration = interruptedBead.iteration - 1
        await abandonInterruptedCodingSessions(ticketId, interruptedBead.id, interruptedIteration)
        emitPhaseLog(
          ticketId,
          context.externalId,
          'CODING',
          'info',
          `Recovered interrupted bead ${interruptedBead.id} from its start snapshot, recorded failed iteration ${interruptedIteration}, and returned it to pending for iteration ${interruptedBead.iteration}.`,
          {
            source: 'system',
            modelId: codingModelId,
            beadId: interruptedBead.id,
            beadIteration: interruptedIteration,
          },
        )
        beads = readTicketBeads(ticketId)
      }

      const nextBead = getNextBead(beads)
      if (!nextBead) {
        throw new Error('No runnable bead found; unresolved dependencies remain')
      }

      const now = new Date().toISOString()
      const inProgressBeads = beads.map(bead => bead.id === nextBead.id
        ? { ...bead, status: 'in_progress' as const, updatedAt: now, startedAt: bead.startedAt || now }
        : bead)
      writeTicketBeads(ticketId, inProgressBeads)
      updateTicketProgressFromBeads(ticketId, inProgressBeads)
      const selectedBead = inProgressBeads.find(bead => bead.id === nextBead.id)
      if (!selectedBead) {
        throw new Error(`Failed to mark bead ${nextBead.id} as in progress`)
      }
      executingBead = selectedBead
      activeBead = executingBead

      emitPhaseLog(ticketId, context.externalId, 'CODING', 'info', `Executing bead ${executingBead.id}: ${executingBead.title}`, { source: 'system', modelId: codingModelId, beadId: executingBead.id })

      // Record bead start commit for potential reset on context wipe
      beadStartCommit = null
      try {
        beadStartCommit = await withCommandLoggingFieldsAsync({ beadId: executingBead.id }, async () => recordBeadStartCommit(paths.worktreePath))
        const beadsWithCommit = readTicketBeads(ticketId).map(b =>
          b.id === executingBead.id ? { ...b, beadStartCommit } : b)
        writeTicketBeads(ticketId, beadsWithCommit)
        activeBead = beadsWithCommit.find(bead => bead.id === executingBead.id) ?? activeBead
        executingBead = activeBead ?? executingBead
      } catch (err) {
        emitPhaseLog(ticketId, context.externalId, 'CODING', 'info', `Could not record bead start commit: ${err instanceof Error ? err.message : 'Unknown error'}`, { source: 'system', modelId: codingModelId, beadId: executingBead.id })
      }
    }

    throwIfAborted(signal, ticketId)
    const streamStates = new Map<string, OpenCodeStreamState>()
    result = await withCommandLoggingFieldsAsync({ beadId: executingBead.id }, async () => await executeBead(
      adapter,
      executingBead,
      () => adapter.assembleBeadContext(ticketId, executingBead.id),
      paths.worktreePath,
      executionSettings.maxIterations,
      executionSettings.perIterationTimeoutMs,
      signal,
      {
        ticketId,
        model: codingModelId,
        variant: context.lockedMainImplementerVariant ?? undefined,
        structuredRetryCount: resolveStructuredRetryRuntimeSettings(context).structuredRetryCount,
        opencodeRetryPolicy: {
          limit: executionSettings.opencodeRetryLimit,
          delayMs: executionSettings.opencodeRetryDelayMs,
        },
        onSessionCreated: (sessionId, iteration) => {
          const currentBeads = readTicketBeads(ticketId)
          const attemptStartedAt = new Date().toISOString()
          const updated = currentBeads.map((bead) => bead.id === executingBead.id
            ? {
                ...bead,
                status: 'in_progress' as const,
                iteration,
                startedAt: bead.startedAt || attemptStartedAt,
                updatedAt: attemptStartedAt,
              }
            : bead)
          writeTicketBeads(ticketId, updated)
          emitAiMilestone(
            ticketId,
            context.externalId,
            'CODING',
            `Coding session created for bead ${executingBead.id} attempt ${iteration} (session=${sessionId}).`,
            `${executingBead.id}:${iteration}:created`,
            {
              modelId: codingModelId,
              sessionId,
              source: `model:${codingModelId}`,
              beadId: executingBead.id,
              beadIteration: iteration,
            },
          )
        },
        onOpenCodeStreamEvent: ({ sessionId, iteration, event }) => {
          const streamState = streamStates.get(sessionId) ?? createOpenCodeStreamState()
          streamStates.set(sessionId, streamState)
          emitOpenCodeStreamEvent(
            ticketId,
            context.externalId,
            'CODING',
            codingModelId,
            sessionId,
            event,
            streamState,
            executingBead.id,
            iteration,
          )
        },
        onPromptDispatched: ({ iteration, event }) => {
          emitOpenCodePromptLog(
            ticketId,
            context.externalId,
            'CODING',
            codingModelId,
            event,
            executingBead.id,
            iteration,
          )
        },
        onPromptCompleted: ({ iteration, stage, event }) => {
          emitOpenCodeSessionLogs(
            ticketId,
            context.externalId,
            'CODING',
            codingModelId,
            event.session.id,
            stage,
            event.response,
            event.messages,
            streamStates.get(event.session.id),
            executingBead.id,
            iteration,
          )
        },
        onContinuableTimeoutPreserved: ({ beadId, iteration, message }) => {
          emitPhaseLog(
            ticketId,
            context.externalId,
            'CODING',
            'info',
            message,
            { source: 'system', modelId: codingModelId, beadId, beadIteration: iteration },
          )
        },
        onContextWipe: async ({ beadId, failedIterationNotes, iteration, reason, attempt, nextAttempt, maxAttempts }) => {
          const nextIteration = iteration + 1
          if (!beadStartCommit) {
            throw new Error(`Cannot reset bead ${beadId} for attempt ${nextIteration}: missing bead start commit`)
          }

          const beadsBeforeReset = readTicketBeads(ticketId)
          const retryUpdatedAt = new Date().toISOString()
          try {
            await withCommandLoggingFieldsAsync(
              { beadId },
              async () => resetToBeadStart(paths.worktreePath, beadStartCommit!, {
                preservePaths: resetPreservePaths(),
              }),
            )
            reapplyStepsConfigAfterReset()
          } catch (err) {
            const preservedFailureBeads = mergeBeadRetryMetadata(beadsBeforeReset, beadId, {
              failedIterationNotes,
              iteration: nextIteration,
              status: 'error',
              updatedAt: retryUpdatedAt,
            })
            writeTicketBeads(ticketId, preservedFailureBeads)
            emitPhaseLog(
              ticketId,
              context.externalId,
              'CODING',
              'error',
              `Could not reset bead ${beadId} to bead start commit: ${err instanceof Error ? err.message : 'Unknown error'}`,
              { source: 'system', modelId: codingModelId, beadId, beadIteration: iteration },
            )
            throw err
          }

          const updated = mergeBeadRetryMetadata(beadsBeforeReset, beadId, {
            failedIterationNotes,
            iteration: nextIteration,
            status: 'pending',
            updatedAt: retryUpdatedAt,
          })
          writeTicketBeads(ticketId, updated)
          const resetMessage = reason === 'iteration_timeout'
            ? `Iteration timeout for bead ${beadId} attempt ${attempt}; resetting for attempt ${nextAttempt}${maxAttempts ? ` of ${maxAttempts}` : ''}.`
            : `Reset bead ${beadId} to its start snapshot and appended retry notes for attempt ${nextIteration}.`
          emitPhaseLog(
            ticketId,
            context.externalId,
            'CODING',
            'info',
            resetMessage,
            { source: 'system', modelId: codingModelId, beadId, beadIteration: iteration },
          )
        },
      },
    ))

    const checkpointBead = readTicketBeads(ticketId).find(bead => bead.id === executingBead.id) ?? activeBead ?? executingBead
    activeBead = checkpointBead
    beadStartCommit = checkpointBead.beadStartCommit ?? beadStartCommit
    upsertLatestPhaseArtifact(
      ticketId,
      getBeadExecutionArtifactType(checkpointBead.id),
      'CODING',
      JSON.stringify(withExecutionCheckpoint(result, checkpointBead)),
    )
  }

  if (!activeBead || !result) {
    throw new Error('Execution flow did not resolve a bead result')
  }
  const finalizingBead = activeBead

  throwIfAborted(signal, ticketId)

  // Reload beads from disk to avoid overwriting fields (notes, beadStartCommit)
  // that were persisted during execution via callbacks
  const freshBeads = readTicketBeads(ticketId)

  if (!result.success) {
    const nowStr = new Date().toISOString()
    const failedBeads = freshBeads.map(bead => bead.id === finalizingBead.id
      ? {
          ...bead,
          status: 'error' as const,
          iteration: result.iteration,
          updatedAt: nowStr,
        }
      : bead)
    writeTicketBeads(ticketId, failedBeads)
    updateTicketProgressFromBeads(ticketId, failedBeads)
    emitPhaseLog(ticketId, context.externalId, 'CODING', 'error', `Bead ${finalizingBead.id} failed.`, {
      source: 'system',
      modelId: codingModelId,
      beadId: finalizingBead.id,
      errors: result.errors,
      ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    })
    sendEvent({
      type: 'BEAD_ERROR',
      ...(result.errorCodes && result.errorCodes.length > 0 ? { codes: result.errorCodes } : {}),
      ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    })
    return
  }

  // Finalize durable local changes before marking the bead complete. A local
  // commit failure blocks progress; a push failure after a commit is recoverable.
  let gitResult: Awaited<ReturnType<typeof commitBeadChanges>>
  try {
    gitResult = await withCommandLoggingFieldsAsync(
      { beadId: finalizingBead.id },
      // The step cap is LoopTroop's, not the project's, and a commit cannot be
      // taken back by restoring the file afterwards.
      async () => commitBeadChanges(paths.worktreePath, finalizingBead.id, finalizingBead.title, {
        excludePaths: stepsConfig ? [OPENCODE_CONFIG_FILENAME] : [],
      }),
    )
  } catch (err) {
    markBeadFinalizationFailed({
      ticketId,
      context,
      finalizingBead,
      freshBeads,
      result,
      codingModelId,
      sendEvent,
      message: err instanceof Error ? err.message : 'Unknown error',
    })
    return
  }

  if (gitResult.error && !gitResult.committed) {
    markBeadFinalizationFailed({
      ticketId,
      context,
      finalizingBead,
      freshBeads,
      result,
      codingModelId,
      sendEvent,
      message: gitResult.error,
    })
    return
  }

  if (gitResult.error) {
    emitPhaseLog(ticketId, context.externalId, 'CODING', 'info', `Git push warning for bead ${finalizingBead.id}: ${gitResult.error}`, { source: 'system', modelId: codingModelId, beadId: finalizingBead.id })
  }
  if (gitResult.generatedNoiseWarning) {
    emitPhaseLog(ticketId, context.externalId, 'CODING', 'info', gitResult.generatedNoiseWarning, { source: 'system', modelId: codingModelId, beadId: finalizingBead.id })
  }
  if (gitResult.committed) {
    emitPhaseLog(ticketId, context.externalId, 'CODING', 'info', `Committed bead ${finalizingBead.id} changes${gitResult.pushed ? ' and pushed' : ' (push pending)'}`, { source: 'system', modelId: codingModelId, beadId: finalizingBead.id })
  } else if (gitResult.skippedFiles?.length) {
    emitPhaseLog(ticketId, context.externalId, 'CODING', 'info', `No local commit was created for bead ${finalizingBead.id}; only LoopTroop/setup/generated paths changed.`, { source: 'system', modelId: codingModelId, beadId: finalizingBead.id, skippedFiles: gitResult.skippedFiles })
  } else {
    emitPhaseLog(ticketId, context.externalId, 'CODING', 'info', `No local commit was needed for bead ${finalizingBead.id}; finalization continued as a no-op.`, { source: 'system', modelId: codingModelId, beadId: finalizingBead.id })
  }

  const doneNow = new Date().toISOString()
  const completedBeads = freshBeads.map(bead => bead.id === finalizingBead.id
    ? {
        ...bead,
        status: 'done' as const,
        iteration: result.iteration,
        updatedAt: doneNow,
        completedAt: doneNow,
      }
    : bead)
  writeTicketBeads(ticketId, completedBeads)
  updateTicketProgressFromBeads(ticketId, completedBeads)
  recordBeadMetric(ticketId, completedBeads.find(bead => bead.id === finalizingBead.id) ?? finalizingBead, completedBeads)

  // Capture code-only diff for this bead (excludes .ticket/** metadata)
  if (beadStartCommit) {
    try {
      const diffContent = await withCommandLoggingFieldsAsync({ beadId: finalizingBead.id }, async () => captureBeadDiff(paths.worktreePath, beadStartCommit))
      upsertLatestPhaseArtifact(ticketId, getBeadDiffArtifactType(finalizingBead.id), 'CODING', diffContent)
    } catch (err) {
      emitPhaseLog(ticketId, context.externalId, 'CODING', 'info', `Could not capture bead diff: ${err instanceof Error ? err.message : 'Unknown error'}`, { source: 'system', modelId: codingModelId, beadId: finalizingBead.id })
    }
  }

  broadcaster.broadcast(ticketId, 'bead_complete', {
    ticketId,
    beadId: finalizingBead.id,
    title: finalizingBead.title,
    completed: completedBeads.filter(bead => bead.status === 'done').length,
    total: completedBeads.length,
  })

  emitPhaseLog(ticketId, context.externalId, 'CODING', 'bead_complete', `Completed bead ${finalizingBead.id}: ${finalizingBead.title}`, { source: 'system', modelId: codingModelId, beadId: finalizingBead.id })
  if (isAllComplete(completedBeads)) {
    sendEvent({ type: 'ALL_BEADS_DONE' })
  } else {
    sendEvent({ type: 'BEAD_COMPLETE' })
  }
  } finally {
    if (stepsConfig) {
      restoreOpencodeStepsConfig(stepsConfig, reportStepsConfig)
    }
  }
    },
    (phase, type, content, data) => emitPhaseLog(ticketId, context.externalId, phase, type, content, { source: 'system', audience: 'all', ...(data ?? {}) }),
  )
}
