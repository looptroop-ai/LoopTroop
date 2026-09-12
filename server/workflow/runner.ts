import { createActor } from 'xstate'
import { ticketMachine } from '../machines/ticketMachine'
import type { TicketContext, TicketEvent } from '../machines/types'
import { isCancellationError } from '../lib/abort'
import { isMockOpenCodeMode } from '../opencode/factory'
import {
  appendBlockedErrorDiagnosticsSummary,
  buildOpenCodeBlockedErrorDiagnostics,
  mergeErrorCodes,
} from '../opencode/blockedErrorDiagnostics'
import { getErrorMessage } from '@shared/typeGuards'

const ERR_DELIBERATION_DATA_LOST = 'Council data lost after restart. Retry to re-run deliberation.'
const ERR_PRD_DATA_LOST = 'Council data lost after restart. Retry to re-run PRD drafting.'
const ERR_BEADS_DATA_LOST = 'Council data lost after restart. Retry to re-run beads drafting.'

// Import from phase modules
import {
  // State
  runningPhases,
  interviewQASessions,
  phaseIntermediate,
  cancelTicket,
  cleanupTicketState,
  getOrCreateAbortSignal,

  // Helpers
  emitPhaseLog,
  tryRecoverPhaseIntermediate,

  // Interview phase
  handleInterviewDeliberate,
  handleInterviewVote,
  handleInterviewCompile,
  handleInterviewQAStart,
  claimInterviewBatch,
  handleInterviewQABatch,
  processInterviewBatchAsync,
  releaseInterviewBatch,
  skipAllInterviewQuestionsToApproval,
  handleMockCouncilDeliberate,
  handleMockInterviewVote,
  handleMockInterviewCompile,
  handleMockInterviewQAStart,

  // PRD phase
  handlePrdDraft,
  handlePrdVote,
  handlePrdRefine,
  handleMockPrdDraft,
  handleMockPrdVote,
  handleMockPrdRefine,

  // Beads phase
  handleBeadsDraft,
  handleBeadsVote,
  handleBeadsRefine,
  handleBeadsExpansion,
  handleMockBeadsDraft,
  handleMockBeadsVote,
  handleMockBeadsRefine,
  handleMockBeadsExpansion,

  // Execution phase
  handleCoding,
  handleExecutionSetupPlanGeneration,
  handleExecutionSetup,
  handleMockExecutionUnsupported,

  // Verification phase
  handleRelevantFilesScan,
  handleCoverageVerification,
  handlePreFlight,
  handleFinalTest,
  handleMockCoverage,

  // Integration phase
  handleIntegration,
  handleCreatePullRequest,

  // Cleanup phase
  handleCleanup,
} from './phases'
import { handleManualQaChecklistGeneration } from '../phases/manualQa'
import { isWorkflowPhaseId, type WorkflowPhaseId } from '@shared/workflowMeta'
import { OpenCodeUnavailableError, TicketWorkspaceNotInitializedError } from '../lib/workflowErrors'

// Re-export public API for external callers
export {
  cancelTicket,
  claimInterviewBatch,
  handleInterviewQABatch,
  processInterviewBatchAsync,
  releaseInterviewBatch,
  skipAllInterviewQuestionsToApproval,
  handleRelevantFilesScan,
}

const mockLifecycleHandlers: Partial<Record<WorkflowPhaseId, (
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
) => Promise<void>>> = {
  SCANNING_RELEVANT_FILES: async (_ticketId, _context, sendEvent) => {
    sendEvent({ type: 'RELEVANT_FILES_READY' })
  },
  COUNCIL_DELIBERATING: handleMockCouncilDeliberate,
  COUNCIL_VOTING_INTERVIEW: handleMockInterviewVote,
  COMPILING_INTERVIEW: handleMockInterviewCompile,
  WAITING_INTERVIEW_ANSWERS: async (ticketId, context) => {
    if (!interviewQASessions.has(ticketId)) {
      await handleMockInterviewQAStart(ticketId, context)
    }
  },
  VERIFYING_INTERVIEW_COVERAGE: async (ticketId, context, sendEvent) => {
    await handleMockCoverage(ticketId, context, 'interview', sendEvent)
  },
  DRAFTING_PRD: handleMockPrdDraft,
  COUNCIL_VOTING_PRD: handleMockPrdVote,
  REFINING_PRD: handleMockPrdRefine,
  VERIFYING_PRD_COVERAGE: async (ticketId, context, sendEvent) => {
    await handleMockCoverage(ticketId, context, 'prd', sendEvent)
  },
  DRAFTING_BEADS: handleMockBeadsDraft,
  COUNCIL_VOTING_BEADS: handleMockBeadsVote,
  REFINING_BEADS: handleMockBeadsRefine,
  VERIFYING_BEADS_COVERAGE: async (ticketId, context, sendEvent) => {
    await handleMockCoverage(ticketId, context, 'beads', sendEvent)
  },
  EXPANDING_BEADS: handleMockBeadsExpansion,
  PRE_FLIGHT_CHECK: async (ticketId, context, sendEvent) => {
    await handleMockExecutionUnsupported(ticketId, context, 'PRE_FLIGHT_CHECK', sendEvent)
  },
  GENERATING_EXECUTION_SETUP_PLAN: async (ticketId, context, sendEvent) => {
    await handleMockExecutionUnsupported(ticketId, context, 'GENERATING_EXECUTION_SETUP_PLAN', sendEvent)
  },
  PREPARING_EXECUTION_ENV: async (ticketId, context, sendEvent) => {
    await handleMockExecutionUnsupported(ticketId, context, 'PREPARING_EXECUTION_ENV', sendEvent)
  },
  CODING: async (ticketId, context, sendEvent) => {
    await handleMockExecutionUnsupported(ticketId, context, 'CODING', sendEvent)
  },
  RUNNING_FINAL_TEST: async (ticketId, context, sendEvent) => {
    await handleMockExecutionUnsupported(ticketId, context, 'RUNNING_FINAL_TEST', sendEvent)
  },
  GENERATING_QA_CHECKLIST: async (ticketId, context, sendEvent) => {
    await handleMockExecutionUnsupported(ticketId, context, 'GENERATING_QA_CHECKLIST', sendEvent)
  },
  INTEGRATING_CHANGES: async (ticketId, context, sendEvent) => {
    await handleMockExecutionUnsupported(ticketId, context, 'INTEGRATING_CHANGES', sendEvent)
  },
  CREATING_PULL_REQUEST: async (ticketId, context, sendEvent) => {
    await handleMockExecutionUnsupported(ticketId, context, 'CREATING_PULL_REQUEST', sendEvent)
  },
  CLEANING_ENV: async (ticketId, context, sendEvent) => {
    await handleMockExecutionUnsupported(ticketId, context, 'CLEANING_ENV', sendEvent)
  },
}

function resolveSnapshotState(
  snapshot: ReturnType<ReturnType<typeof createActor<typeof ticketMachine>>['getSnapshot']>,
) {
  return typeof snapshot.value === 'string' ? snapshot.value : JSON.stringify(snapshot.value)
}

function buildWorkflowErrorEvent(
  message: string,
  codes: string[] = [],
  error?: unknown,
): Extract<TicketEvent, { type: 'ERROR' }> {
  const diagnosticResult = buildOpenCodeBlockedErrorDiagnostics({
    error,
    fallbackMessage: message,
  })
  const mergedCodes = mergeErrorCodes(codes, diagnosticResult.errorCodes)
  return {
    type: 'ERROR',
    message: appendBlockedErrorDiagnosticsSummary(message, diagnosticResult.diagnostics),
    ...(mergedCodes.length > 0 ? { codes: mergedCodes } : {}),
    ...(diagnosticResult.diagnostics ? { diagnostics: diagnosticResult.diagnostics } : {}),
  }
}

function startCodingPhase(
  ticketId: string,
  actor: ReturnType<typeof createActor<typeof ticketMachine>>,
  sendEvent: (event: TicketEvent) => void,
) {
  const snapshot = actor.getSnapshot()
  const state = resolveSnapshotState(snapshot)
  const key = `${ticketId}:CODING`

  if (state !== 'CODING' || runningPhases.has(key)) return

  const signal = getOrCreateAbortSignal(ticketId)
  const context = snapshot.context

  runningPhases.add(key)
  handleCoding(ticketId, context, sendEvent, signal)
    .catch(err => {
      if (isCancellationError(err, signal)) return
      const errMsg = getErrorMessage(err)
      emitPhaseLog(ticketId, context.externalId, 'CODING', 'error', errMsg)
      sendEvent(buildWorkflowErrorEvent(errMsg, ['CODING_FAILED'], err))
    })
    .finally(() => {
      runningPhases.delete(key)

      // CODING self-transitions after each successful bead. Re-check the actor
      // once the current pass unwinds so the next bead can start.
      queueMicrotask(() => {
        startCodingPhase(ticketId, actor, sendEvent)
      })
    })
}

export function attachWorkflowRunner(
  ticketId: string,
  actor: ReturnType<typeof createActor<typeof ticketMachine>>,
  sendEvent: (event: TicketEvent) => void,
  options?: { processInitialSnapshot?: boolean },
) {
  const processSnapshot = (snapshot: ReturnType<typeof actor.getSnapshot>) => {
    const state = resolveSnapshotState(snapshot)
    const context = snapshot.context
    const key = `${ticketId}:${state}`

    // When the ticket reaches CANCELED, abort all running work
    if (state === 'CANCELED') {
      cancelTicket(ticketId)
      return
    }

    if (state === 'COMPLETED') {
      cleanupTicketState(ticketId)
      return
    }

    if (runningPhases.has(key)) return

    const signal = getOrCreateAbortSignal(ticketId)

    if (isMockOpenCodeMode() && isWorkflowPhaseId(state)) {
      const mockHandler = mockLifecycleHandlers[state]
      if (mockHandler) {
        runningPhases.add(key)
        mockHandler(ticketId, context, sendEvent)
          .catch((err: unknown) => {
            if (isCancellationError(err, signal)) return
            const errMsg = getErrorMessage(err)
            emitPhaseLog(ticketId, context.externalId, state, 'error', errMsg)
            sendEvent(buildWorkflowErrorEvent(errMsg, ['MOCK_LIFECYCLE_FAILED'], err))
          })
          .finally(() => {
            runningPhases.delete(key)
          })
        return
      }
    }

    if (state === 'SCANNING_RELEVANT_FILES') {
      runningPhases.add(key)
        handleRelevantFilesScan(ticketId, context, sendEvent, signal)
        .catch((err: unknown) => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'SCANNING_RELEVANT_FILES', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['RELEVANT_FILES_SCAN_FAILED'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'COUNCIL_DELIBERATING') {
      runningPhases.add(key)
      handleInterviewDeliberate(ticketId, context, sendEvent, signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          const codes = err instanceof OpenCodeUnavailableError
            ? ['OPENCODE_UNREACHABLE']
            : err instanceof TicketWorkspaceNotInitializedError
              ? ['WORKSPACE_NOT_INITIALIZED']
              : ['QUORUM_NOT_MET']
          emitPhaseLog(ticketId, context.externalId, 'COUNCIL_DELIBERATING', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, codes, err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'COUNCIL_VOTING_INTERVIEW') {
      if (phaseIntermediate.has(`${ticketId}:interview`) || tryRecoverPhaseIntermediate(ticketId, context, 'interview', false)) {
        runningPhases.add(key)
        handleInterviewVote(ticketId, context, sendEvent, signal)
          .catch(err => {
            if (isCancellationError(err, signal)) return
            const errMsg = getErrorMessage(err)
            emitPhaseLog(ticketId, context.externalId, 'COUNCIL_VOTING_INTERVIEW', 'error', errMsg)
            sendEvent(buildWorkflowErrorEvent(errMsg, ['QUORUM_NOT_MET'], err))
          })
          .finally(() => {
            runningPhases.delete(key)
          })
      } else {
        sendEvent({ type: 'ERROR', message: ERR_DELIBERATION_DATA_LOST, codes: ['INTERMEDIATE_DATA_LOST'] })
      }
    } else if (state === 'COMPILING_INTERVIEW') {
      if (phaseIntermediate.has(`${ticketId}:interview`) || tryRecoverPhaseIntermediate(ticketId, context, 'interview', true)) {
        runningPhases.add(key)
        handleInterviewCompile(ticketId, context, sendEvent, signal)
          .catch(err => {
            if (isCancellationError(err, signal)) return
            const errMsg = getErrorMessage(err)
            emitPhaseLog(ticketId, context.externalId, 'COMPILING_INTERVIEW', 'error', errMsg)
            sendEvent(buildWorkflowErrorEvent(errMsg, [], err))
          })
          .finally(() => {
            runningPhases.delete(key)
          })
      } else {
        sendEvent({ type: 'ERROR', message: ERR_DELIBERATION_DATA_LOST, codes: ['INTERMEDIATE_DATA_LOST'] })
      }
    } else if (state === 'WAITING_INTERVIEW_ANSWERS') {
      // Start PROM4 session if not already running
      const qaInitKey = `${ticketId}:interview_qa_init`
      if (!interviewQASessions.has(ticketId) && !runningPhases.has(qaInitKey)) {
        runningPhases.add(qaInitKey)
        handleInterviewQAStart(ticketId, context, sendEvent, signal)
          .catch(err => {
            if (isCancellationError(err, signal)) return
            const errMsg = getErrorMessage(err)
            emitPhaseLog(ticketId, context.externalId, 'WAITING_INTERVIEW_ANSWERS', 'error', errMsg)
            sendEvent(buildWorkflowErrorEvent(errMsg, ['PROM4_INIT_FAILED'], err))
          })
          .finally(() => {
            runningPhases.delete(qaInitKey)
          })
      }
    } else if (state === 'VERIFYING_INTERVIEW_COVERAGE') {
      runningPhases.add(key)
      handleCoverageVerification(ticketId, context, sendEvent, 'interview', signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'VERIFYING_INTERVIEW_COVERAGE', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['COVERAGE_FAILED'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'DRAFTING_PRD') {
      runningPhases.add(key)
      handlePrdDraft(ticketId, context, sendEvent, signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'DRAFTING_PRD', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['QUORUM_NOT_MET'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'COUNCIL_VOTING_PRD') {
      if (phaseIntermediate.has(`${ticketId}:prd`) || tryRecoverPhaseIntermediate(ticketId, context, 'prd', false)) {
        runningPhases.add(key)
        handlePrdVote(ticketId, context, sendEvent, signal)
          .catch(err => {
            if (isCancellationError(err, signal)) return
            const errMsg = getErrorMessage(err)
            emitPhaseLog(ticketId, context.externalId, 'COUNCIL_VOTING_PRD', 'error', errMsg)
            sendEvent(buildWorkflowErrorEvent(errMsg, ['QUORUM_NOT_MET'], err))
          })
          .finally(() => {
            runningPhases.delete(key)
          })
      } else {
        sendEvent({ type: 'ERROR', message: ERR_PRD_DATA_LOST, codes: ['INTERMEDIATE_DATA_LOST'] })
      }
    } else if (state === 'REFINING_PRD') {
      if (phaseIntermediate.has(`${ticketId}:prd`) || tryRecoverPhaseIntermediate(ticketId, context, 'prd', true)) {
        runningPhases.add(key)
        handlePrdRefine(ticketId, context, sendEvent, signal)
          .catch(err => {
            if (isCancellationError(err, signal)) return
            const errMsg = getErrorMessage(err)
            emitPhaseLog(ticketId, context.externalId, 'REFINING_PRD', 'error', errMsg)
            sendEvent(buildWorkflowErrorEvent(errMsg, [], err))
          })
          .finally(() => {
            runningPhases.delete(key)
          })
      } else {
        sendEvent({ type: 'ERROR', message: ERR_PRD_DATA_LOST, codes: ['INTERMEDIATE_DATA_LOST'] })
      }
    } else if (state === 'VERIFYING_PRD_COVERAGE') {
      runningPhases.add(key)
      handleCoverageVerification(ticketId, context, sendEvent, 'prd', signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'VERIFYING_PRD_COVERAGE', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['COVERAGE_FAILED'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'DRAFTING_BEADS') {
      runningPhases.add(key)
      handleBeadsDraft(ticketId, context, sendEvent, signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'DRAFTING_BEADS', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['QUORUM_NOT_MET'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'COUNCIL_VOTING_BEADS') {
      if (phaseIntermediate.has(`${ticketId}:beads`) || tryRecoverPhaseIntermediate(ticketId, context, 'beads', false)) {
        runningPhases.add(key)
        handleBeadsVote(ticketId, context, sendEvent, signal)
          .catch(err => {
            if (isCancellationError(err, signal)) return
            const errMsg = getErrorMessage(err)
            emitPhaseLog(ticketId, context.externalId, 'COUNCIL_VOTING_BEADS', 'error', errMsg)
            sendEvent(buildWorkflowErrorEvent(errMsg, ['QUORUM_NOT_MET'], err))
          })
          .finally(() => {
            runningPhases.delete(key)
          })
      } else {
        sendEvent({ type: 'ERROR', message: ERR_BEADS_DATA_LOST, codes: ['INTERMEDIATE_DATA_LOST'] })
      }
    } else if (state === 'REFINING_BEADS') {
      if (phaseIntermediate.has(`${ticketId}:beads`) || tryRecoverPhaseIntermediate(ticketId, context, 'beads', true)) {
        runningPhases.add(key)
        handleBeadsRefine(ticketId, context, sendEvent, signal)
          .catch(err => {
            if (isCancellationError(err, signal)) return
            const errMsg = getErrorMessage(err)
            emitPhaseLog(ticketId, context.externalId, 'REFINING_BEADS', 'error', errMsg)
            sendEvent(buildWorkflowErrorEvent(errMsg, [], err))
          })
          .finally(() => {
            runningPhases.delete(key)
          })
      } else {
        sendEvent({ type: 'ERROR', message: ERR_BEADS_DATA_LOST, codes: ['INTERMEDIATE_DATA_LOST'] })
      }
    } else if (state === 'VERIFYING_BEADS_COVERAGE') {
      runningPhases.add(key)
      handleCoverageVerification(ticketId, context, sendEvent, 'beads', signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'VERIFYING_BEADS_COVERAGE', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['COVERAGE_FAILED'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'EXPANDING_BEADS') {
      runningPhases.add(key)
      handleBeadsExpansion(ticketId, context, sendEvent, signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'EXPANDING_BEADS', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['EXPANSION_FAILED'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'PRE_FLIGHT_CHECK') {
      runningPhases.add(key)
      handlePreFlight(ticketId, context, sendEvent, signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'PRE_FLIGHT_CHECK', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['PREFLIGHT_FAILED'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'GENERATING_EXECUTION_SETUP_PLAN') {
      runningPhases.add(key)
      handleExecutionSetupPlanGeneration(ticketId, context, sendEvent, signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'GENERATING_EXECUTION_SETUP_PLAN', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['EXECUTION_SETUP_PLAN_FAILED'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'PREPARING_EXECUTION_ENV') {
      runningPhases.add(key)
      handleExecutionSetup(ticketId, context, sendEvent, signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'PREPARING_EXECUTION_ENV', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['EXECUTION_SETUP_FAILED'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'CODING') {
      startCodingPhase(ticketId, actor, sendEvent)
    } else if (state === 'RUNNING_FINAL_TEST') {
      runningPhases.add(key)
      handleFinalTest(ticketId, context, sendEvent, signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'RUNNING_FINAL_TEST', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['TESTS_FAILED'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'GENERATING_QA_CHECKLIST') {
      runningPhases.add(key)
      handleManualQaChecklistGeneration(ticketId, context, sendEvent, signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'GENERATING_QA_CHECKLIST', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['MANUAL_QA_CHECKLIST_FAILED'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'INTEGRATING_CHANGES') {
      runningPhases.add(key)
      handleIntegration(ticketId, context, sendEvent, signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'INTEGRATING_CHANGES', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['INTEGRATION_FAILED'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'CREATING_PULL_REQUEST') {
      runningPhases.add(key)
      handleCreatePullRequest(ticketId, context, sendEvent, signal)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'CREATING_PULL_REQUEST', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['PULL_REQUEST_FAILED'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    } else if (state === 'CLEANING_ENV') {
      runningPhases.add(key)
      handleCleanup(ticketId, context, sendEvent)
        .catch(err => {
          if (isCancellationError(err, signal)) return
          const errMsg = getErrorMessage(err)
          emitPhaseLog(ticketId, context.externalId, 'CLEANING_ENV', 'error', errMsg)
          sendEvent(buildWorkflowErrorEvent(errMsg, ['CLEANUP_FAILED'], err))
        })
        .finally(() => {
          runningPhases.delete(key)
        })
    }
  }

  actor.subscribe(processSnapshot)

  // XState subscriptions added after actor.start() do not replay the current
  // restored snapshot. Hydrated tickets need the active state to be processed
  // immediately after the runner is attached, otherwise work can sit idle until
  // some unrelated event arrives.
  if (options?.processInitialSnapshot !== false) {
    processSnapshot(actor.getSnapshot())
  }
}
