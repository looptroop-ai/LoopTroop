import { createActor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TicketContext } from '../../machines/types'
import { ticketMachine } from '../../machines/ticketMachine'
import { attachWorkflowRunner } from '../runner'
import { handleCleanup as handleCleanupPhase } from '../phases/cleanupPhase'
import * as phaseHelpers from '../phases/helpers'
import * as questionWindows from '../questionWindows'
import { interviewQASessions, phaseIntermediate, runningPhases, ticketAbortControllers } from '../phases'
import * as cleaner from '../../phases/cleanup/cleaner'
import * as ticketStorage from '../../storage/tickets'
import { OpenCodeUnavailableError, TicketWorkspaceNotInitializedError } from '../../lib/workflowErrors'
import { TEST, makeTicketContext } from '../../test/factories'
import {
  clearAllPendingSessionContinuationsForTests,
  hasPendingSessionContinuationForTicketPhase,
  requestSessionContinuation,
} from '../../opencode/sessionContinuation'

function createSnapshotActor(value: string, overrides: Partial<TicketContext> = {}) {
  const context = makeTicketContext(overrides)
  return createActor(ticketMachine, {
    snapshot: {
      status: 'active', value, historyValue: {}, context, children: {},
    } as unknown as never,
    input: {
      ticketId: context.ticketId,
      projectId: context.projectId,
      externalId: context.externalId,
      title: context.title,
      maxIterations: context.maxIterations,
      lockedMainImplementer: context.lockedMainImplementer ?? TEST.implementer,
      lockedCouncilMembers: context.lockedCouncilMembers ?? [...TEST.councilMembers],
    },
  })
}

const {
  mockLifecyclePhaseMocks,
  livePhaseMocks,
  handleInterviewDeliberateMock,
  handleCodingMock,
  handleFinalTestMock,
  handleManualQaChecklistGenerationMock,
  handlePrdRefineMock,
  handleExecutionSetupPlanGenerationMock,
  handleMockExecutionUnsupportedMock,
  emitPhaseLogMock,
  isMockOpenCodeModeMock,
  abortTicketSessionsMock,
  isTicketCancellationPendingMock,
} = vi.hoisted(() => ({
  mockLifecyclePhaseMocks: {
    handleMockCouncilDeliberate: vi.fn(),
    handleMockInterviewVote: vi.fn(),
    handleMockInterviewCompile: vi.fn(),
    handleMockInterviewQAStart: vi.fn(),
    handleMockPrdDraft: vi.fn(),
    handleMockPrdVote: vi.fn(),
    handleMockPrdRefine: vi.fn(),
    handleMockBeadsDraft: vi.fn(),
    handleMockBeadsVote: vi.fn(),
    handleMockBeadsRefine: vi.fn(),
    handleMockBeadsExpansion: vi.fn(),
    handleMockCoverage: vi.fn(),
  },
  livePhaseMocks: {
    handleInterviewVote: vi.fn(),
    handleInterviewCompile: vi.fn(),
    handleInterviewQAStart: vi.fn(),
    handleCoverageVerification: vi.fn(),
    handlePrdDraft: vi.fn(),
    handlePrdVote: vi.fn(),
    handleBeadsDraft: vi.fn(),
    handleBeadsVote: vi.fn(),
    handleBeadsRefine: vi.fn(),
    handleBeadsExpansion: vi.fn(),
    handlePreFlight: vi.fn(),
    handleExecutionSetup: vi.fn(),
    handleRelevantFilesScan: vi.fn(),
    handleManualQaChecklistGeneration: vi.fn(),
    handleIntegration: vi.fn(),
    handleCreatePullRequest: vi.fn(),
    handleCleanup: vi.fn(),
  },
  handleInterviewDeliberateMock: vi.fn(),
  handleCodingMock: vi.fn(),
  handleFinalTestMock: vi.fn(),
  handleManualQaChecklistGenerationMock: vi.fn(),
  handlePrdRefineMock: vi.fn(),
  handleExecutionSetupPlanGenerationMock: vi.fn(),
  handleMockExecutionUnsupportedMock: vi.fn(),
  emitPhaseLogMock: vi.fn(),
  isMockOpenCodeModeMock: vi.fn(),
  abortTicketSessionsMock: vi.fn(),
  isTicketCancellationPendingMock: vi.fn(() => false),
}))

vi.mock('../../opencode/factory', async () => {
  const actual = await vi.importActual<typeof import('../../opencode/factory')>('../../opencode/factory')
  return {
    ...actual,
    isMockOpenCodeMode: isMockOpenCodeModeMock,
  }
})

vi.mock('../../opencode/sessionManager', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../opencode/sessionManager')>(),
  abortTicketSessions: abortTicketSessionsMock,
}))

vi.mock('../../phases/manualQa', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../phases/manualQa')>(),
  handleManualQaChecklistGeneration: handleManualQaChecklistGenerationMock,
}))

vi.mock('../phases', async () => {
  const actual = await vi.importActual<typeof import('../phases')>('../phases')
  return {
    ...actual,
    ...mockLifecyclePhaseMocks,
    ...livePhaseMocks,
    handleInterviewDeliberate: handleInterviewDeliberateMock,
    handleCoding: handleCodingMock,
    handleFinalTest: handleFinalTestMock,
    handlePrdRefine: handlePrdRefineMock,
    handleExecutionSetupPlanGeneration: handleExecutionSetupPlanGenerationMock,
    handleMockExecutionUnsupported: handleMockExecutionUnsupportedMock,
    emitPhaseLog: emitPhaseLogMock,
    isTicketCancellationPending: isTicketCancellationPendingMock,
  }
})

describe('attachWorkflowRunner', () => {
  function createRefiningPrdActor() {
    return createSnapshotActor('REFINING_PRD', {
      title: 'Runner PRD refinement test',
      status: 'REFINING_PRD',
      previousStatus: 'COUNCIL_VOTING_PRD',
    })
  }

  afterEach(() => {
    runningPhases.clear()
    for (const controller of ticketAbortControllers.values()) {
      controller.abort()
    }
    ticketAbortControllers.clear()
    for (const mock of Object.values(mockLifecyclePhaseMocks)) mock.mockReset()
    for (const mock of Object.values(livePhaseMocks)) mock.mockReset()
    handleInterviewDeliberateMock.mockReset()
    handleCodingMock.mockReset()
    handleFinalTestMock.mockReset()
    handleManualQaChecklistGenerationMock.mockReset()
    handlePrdRefineMock.mockReset()
    handleExecutionSetupPlanGenerationMock.mockReset()
    handleMockExecutionUnsupportedMock.mockReset()
    emitPhaseLogMock.mockReset()
    isMockOpenCodeModeMock.mockReset()
    abortTicketSessionsMock.mockReset()
    isTicketCancellationPendingMock.mockReset().mockReturnValue(false)
    clearAllPendingSessionContinuationsForTests()
    phaseIntermediate.clear()
    interviewQASessions.clear()
  })

  it.each([
    [new OpenCodeUnavailableError('OpenCode server is not running. Restart LoopTroop (`looptroop restart`) so it starts OpenCode again. (connection refused)'), 'OPENCODE_UNREACHABLE'],
    [new TicketWorkspaceNotInitializedError('Ticket workspace not initialized: missing ticket context'), 'WORKSPACE_NOT_INITIALIZED'],
    [new Error('Not enough council responses'), 'QUORUM_NOT_MET'],
    [new OpenCodeUnavailableError('Health check did not pass'), 'OPENCODE_UNREACHABLE'],
    [new TicketWorkspaceNotInitializedError('Workspace unavailable'), 'WORKSPACE_NOT_INITIALIZED'],
    [new Error('Response quoted: OpenCode server is not running'), 'QUORUM_NOT_MET'],
    [new Error('Response quoted: Ticket workspace not initialized'), 'QUORUM_NOT_MET'],
  ])('classifies deliberation failure by type: %s → %s', async (error, code) => {
    handleInterviewDeliberateMock.mockRejectedValue(error)
    const actor = createSnapshotActor('COUNCIL_DELIBERATING')
    const sendEvent = vi.fn((event) => actor.send(event))
    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, sendEvent)

    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('BLOCKED_ERROR'))
    expect(sendEvent).toHaveBeenCalledExactlyOnceWith({
      type: 'ERROR', message: error.message, codes: [code],
      diagnostics: { kind: 'runtime', source: 'opencode', summary: error.message },
    })
    expect(actor.getSnapshot().context.error).toBe(error.message)
    expect(actor.getSnapshot().context.errorCodes).toEqual([code])
    expect(error.name).toBe('Error')
    expect(JSON.stringify(error)).toBe(JSON.stringify(new Error(error.message)))
    actor.stop()
  })

  it.each([
    ['SCANNING_RELEVANT_FILES', 'handleRelevantFilesScan', 'RELEVANT_FILES_SCAN_FAILED'],
    ['COUNCIL_DELIBERATING', 'handleInterviewDeliberate', 'QUORUM_NOT_MET'],
    ['COUNCIL_VOTING_INTERVIEW', 'handleInterviewVote', 'QUORUM_NOT_MET', 'interview'],
    ['COMPILING_INTERVIEW', 'handleInterviewCompile', undefined, 'interview'],
    ['WAITING_INTERVIEW_ANSWERS', 'handleInterviewQAStart', 'PROM4_INIT_FAILED'],
    ['VERIFYING_INTERVIEW_COVERAGE', 'handleCoverageVerification', 'COVERAGE_FAILED', 'interview'],
    ['DRAFTING_PRD', 'handlePrdDraft', 'QUORUM_NOT_MET'],
    ['COUNCIL_VOTING_PRD', 'handlePrdVote', 'QUORUM_NOT_MET', 'prd'],
    ['REFINING_PRD', 'handlePrdRefine', undefined, 'prd'],
    ['VERIFYING_PRD_COVERAGE', 'handleCoverageVerification', 'COVERAGE_FAILED', 'prd'],
    ['DRAFTING_BEADS', 'handleBeadsDraft', 'QUORUM_NOT_MET'],
    ['COUNCIL_VOTING_BEADS', 'handleBeadsVote', 'QUORUM_NOT_MET', 'beads'],
    ['REFINING_BEADS', 'handleBeadsRefine', undefined, 'beads'],
    ['VERIFYING_BEADS_COVERAGE', 'handleCoverageVerification', 'COVERAGE_FAILED', 'beads'],
    ['EXPANDING_BEADS', 'handleBeadsExpansion', 'EXPANSION_FAILED'],
    ['PRE_FLIGHT_CHECK', 'handlePreFlight', 'PREFLIGHT_FAILED'],
    ['GENERATING_EXECUTION_SETUP_PLAN', 'handleExecutionSetupPlanGeneration', 'EXECUTION_SETUP_PLAN_FAILED'],
    ['PREPARING_EXECUTION_ENV', 'handleExecutionSetup', 'EXECUTION_SETUP_FAILED'],
    ['CODING', 'handleCoding', 'CODING_FAILED'],
    ['RUNNING_FINAL_TEST', 'handleFinalTest', 'TESTS_FAILED'],
    ['GENERATING_QA_CHECKLIST', 'handleManualQaChecklistGeneration', 'MANUAL_QA_CHECKLIST_FAILED'],
    ['INTEGRATING_CHANGES', 'handleIntegration', 'INTEGRATION_FAILED'],
    ['CREATING_PULL_REQUEST', 'handleCreatePullRequest', 'PULL_REQUEST_FAILED'],
    ['CLEANING_ENV', 'handleCleanup', 'CLEANUP_FAILED'],
  ] as const)('sends a phase-specific blocked error when %s fails', async (state, handlerName, code, intermediatePhase?) => {
    const handlers = {
      ...livePhaseMocks,
      handleInterviewDeliberate: handleInterviewDeliberateMock,
      handlePrdRefine: handlePrdRefineMock,
      handleExecutionSetupPlanGeneration: handleExecutionSetupPlanGenerationMock,
      handleCoding: handleCodingMock,
      handleFinalTest: handleFinalTestMock,
      handleManualQaChecklistGeneration: handleManualQaChecklistGenerationMock,
    }
    const handler = handlers[handlerName as keyof typeof handlers]
    const error = new Error('phase failed')
    handler.mockRejectedValue(error)
    if (intermediatePhase) phaseIntermediate.set(`${TEST.ticketId}:${intermediatePhase}`, {} as never)

    const actor = createSnapshotActor(state)
    const sendEvent = vi.fn((event) => actor.send(event))
    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, sendEvent)

    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('BLOCKED_ERROR'))
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ERROR',
      message: error.message,
      ...(code ? { codes: [code] } : {}),
    }))
    await vi.waitFor(() => expect(runningPhases.has(`${TEST.ticketId}:${state}`)).toBe(false))
    actor.stop()
  })

  it.each([
    ['COUNCIL_VOTING_INTERVIEW', 'Council data lost after restart. Retry to re-run deliberation.'],
    ['COMPILING_INTERVIEW', 'Council data lost after restart. Retry to re-run deliberation.'],
    ['COUNCIL_VOTING_PRD', 'Council data lost after restart. Retry to re-run PRD drafting.'],
    ['REFINING_PRD', 'Council data lost after restart. Retry to re-run PRD drafting.'],
    ['COUNCIL_VOTING_BEADS', 'Council data lost after restart. Retry to re-run beads drafting.'],
    ['REFINING_BEADS', 'Council data lost after restart. Retry to re-run beads drafting.'],
  ] as const)('blocks restored %s when its persisted intermediate data is missing', async (state, message) => {
    const actor = createSnapshotActor(state)
    const sendEvent = vi.fn((event) => actor.send(event))
    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, sendEvent)

    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('BLOCKED_ERROR'))
    expect(sendEvent).toHaveBeenCalledWith({ type: 'ERROR', message, codes: ['INTERMEDIATE_DATA_LOST'] })
    actor.stop()
  })

  it('turns a failed mock lifecycle handler into a blocked workflow error', async () => {
    isMockOpenCodeModeMock.mockReturnValue(true)
    mockLifecyclePhaseMocks.handleMockPrdDraft.mockRejectedValue(new Error('mock phase failed'))
    const actor = createSnapshotActor('DRAFTING_PRD')
    const sendEvent = vi.fn((event) => actor.send(event))
    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, sendEvent)

    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('BLOCKED_ERROR'))
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ERROR',
      message: 'mock phase failed',
      codes: ['MOCK_LIFECYCLE_FAILED'],
    }))
    actor.stop()
  })

  it('stores the cleanup report, emits its details, and completes the phase', async () => {
    const report = {
      status: 'warning' as const,
      removedDirs: ['/ticket/runtime/sessions'],
      removedFiles: ['/ticket/runtime/state.yaml'],
      preservedPaths: ['/ticket/.ticket/prd.yaml'],
      errors: ['Could not remove runtime/tmp'],
    }
    const cleanup = vi.spyOn(cleaner, 'cleanupTicketResources').mockReturnValue(report)
    const insertArtifact = vi.spyOn(ticketStorage, 'insertPhaseArtifact').mockImplementation(() => undefined)
    const emitLog = vi.spyOn(phaseHelpers, 'emitPhaseLog').mockImplementation(() => undefined)
    isMockOpenCodeModeMock.mockReturnValue(false)
    const context = makeTicketContext()
    const sendEvent = vi.fn()

    try {
      await handleCleanupPhase(TEST.ticketId, context, sendEvent)

      expect(cleanup).toHaveBeenCalledWith(TEST.ticketId)
      expect(insertArtifact).toHaveBeenCalledWith(TEST.ticketId, {
        phase: 'CLEANING_ENV',
        artifactType: 'cleanup_report',
        content: JSON.stringify(report),
      })
      expect(emitLog.mock.calls.map((call) => call[4])).toEqual([
        'Removed: /ticket/runtime/sessions',
        'Removed file: /ticket/runtime/state.yaml',
        'Preserved: /ticket/.ticket/prd.yaml',
        'Cleanup error: Could not remove runtime/tmp',
        'Cleanup completed with 1 warning(s).',
      ])
      expect(sendEvent).toHaveBeenCalledExactlyOnceWith({ type: 'CLEANUP_DONE' })
    } finally {
      cleanup.mockRestore()
      insertArtifact.mockRestore()
      emitLog.mockRestore()
    }
  })

  it('preserves other phases error codes for typed workspace failures', async () => {
    phaseIntermediate.set(`${TEST.ticketId}:prd`, {} as never)
    const error = new TicketWorkspaceNotInitializedError('Ticket workspace not initialized')
    handlePrdRefineMock.mockRejectedValue(error)
    const actor = createRefiningPrdActor()
    const sendEvent = vi.fn((event) => actor.send(event))
    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, sendEvent)

    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('BLOCKED_ERROR'))
    expect(sendEvent).toHaveBeenCalledExactlyOnceWith({
      type: 'ERROR', message: error.message,
      diagnostics: { kind: 'runtime', source: 'opencode', summary: error.message },
    })
    actor.stop()
  })

  it.each([
    ['COUNCIL_DELIBERATING', 'handleMockCouncilDeliberate'],
    ['COUNCIL_VOTING_INTERVIEW', 'handleMockInterviewVote'],
    ['COMPILING_INTERVIEW', 'handleMockInterviewCompile'],
    ['WAITING_INTERVIEW_ANSWERS', 'handleMockInterviewQAStart'],
    ['DRAFTING_PRD', 'handleMockPrdDraft'],
    ['COUNCIL_VOTING_PRD', 'handleMockPrdVote'],
    ['REFINING_PRD', 'handleMockPrdRefine'],
    ['DRAFTING_BEADS', 'handleMockBeadsDraft'],
    ['COUNCIL_VOTING_BEADS', 'handleMockBeadsVote'],
    ['REFINING_BEADS', 'handleMockBeadsRefine'],
    ['EXPANDING_BEADS', 'handleMockBeadsExpansion'],
    ['VERIFYING_INTERVIEW_COVERAGE', 'handleMockCoverage', 'interview'],
    ['VERIFYING_PRD_COVERAGE', 'handleMockCoverage', 'prd'],
    ['VERIFYING_BEADS_COVERAGE', 'handleMockCoverage', 'beads'],
  ] as const)('dispatches the mock handler for %s', async (state, handlerName, phase?) => {
    isMockOpenCodeModeMock.mockReturnValue(true)
    const handler = mockLifecyclePhaseMocks[handlerName].mockResolvedValue(undefined)
    const actor = createSnapshotActor(state)
    const sendEvent = vi.fn()
    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, sendEvent)

    await vi.waitFor(() => expect(runningPhases.has(`${TEST.ticketId}:${state}`)).toBe(false))
    const tail = state === 'WAITING_INTERVIEW_ANSWERS' ? [] : phase ? [phase, sendEvent] : [sendEvent]
    expect(handler).toHaveBeenCalledExactlyOnceWith(TEST.ticketId, expect.anything(), ...tail)
    actor.stop()
  })

  it('advances mock relevant-file scanning without launching a real scan', async () => {
    isMockOpenCodeModeMock.mockReturnValue(true)
    const actor = createSnapshotActor('SCANNING_RELEVANT_FILES')
    const sendEvent = vi.fn()
    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, sendEvent)

    await vi.waitFor(() => expect(runningPhases.has(`${TEST.ticketId}:SCANNING_RELEVANT_FILES`)).toBe(false))
    expect(sendEvent).toHaveBeenCalledExactlyOnceWith({ type: 'RELEVANT_FILES_READY' })
    actor.stop()
  })

  it.each(['toString', 'constructor', '__proto__', 'UNKNOWN_PHASE'])('ignores an invalid mock snapshot state %s', (state) => {
    isMockOpenCodeModeMock.mockReturnValue(true)
    const actor = {
      getSnapshot: () => ({ value: state, context: makeTicketContext() }),
      subscribe: vi.fn(),
    } as unknown as ReturnType<typeof createSnapshotActor>
    const sendEvent = vi.fn()

    expect(() => attachWorkflowRunner(TEST.ticketId, actor, sendEvent)).not.toThrow()
    expect(runningPhases.size).toBe(0)
    expect(sendEvent).not.toHaveBeenCalled()
    for (const handler of Object.values(mockLifecyclePhaseMocks)) expect(handler).not.toHaveBeenCalled()
    expect(handleMockExecutionUnsupportedMock).not.toHaveBeenCalled()
  })

  it.each([
    ['SCANNING_RELEVANT_FILES', 'handleRelevantFilesScan'],
    ['COUNCIL_VOTING_INTERVIEW', 'handleInterviewVote', 'interview'],
    ['COMPILING_INTERVIEW', 'handleInterviewCompile', 'interview'],
    ['WAITING_INTERVIEW_ANSWERS', 'handleInterviewQAStart'],
    ['VERIFYING_INTERVIEW_COVERAGE', 'handleCoverageVerification', 'interview'],
    ['DRAFTING_PRD', 'handlePrdDraft'],
    ['COUNCIL_VOTING_PRD', 'handlePrdVote', 'prd'],
    ['VERIFYING_PRD_COVERAGE', 'handleCoverageVerification', 'prd'],
    ['DRAFTING_BEADS', 'handleBeadsDraft'],
    ['COUNCIL_VOTING_BEADS', 'handleBeadsVote', 'beads'],
    ['REFINING_BEADS', 'handleBeadsRefine', 'beads'],
    ['VERIFYING_BEADS_COVERAGE', 'handleCoverageVerification', 'beads'],
    ['EXPANDING_BEADS', 'handleBeadsExpansion'],
    ['PRE_FLIGHT_CHECK', 'handlePreFlight'],
    ['PREPARING_EXECUTION_ENV', 'handleExecutionSetup'],
    ['RUNNING_FINAL_TEST', 'handleFinalTest'],
    ['GENERATING_QA_CHECKLIST', 'handleManualQaChecklistGeneration'],
    ['INTEGRATING_CHANGES', 'handleIntegration'],
    ['CREATING_PULL_REQUEST', 'handleCreatePullRequest'],
    ['CLEANING_ENV', 'handleCleanup'],
  ] as const)('dispatches the live handler for %s', async (state, handlerName, phase?) => {
    const handler = handlerName === 'handleFinalTest'
      ? handleFinalTestMock.mockResolvedValue(undefined)
      : handlerName === 'handleManualQaChecklistGeneration'
        ? handleManualQaChecklistGenerationMock.mockResolvedValue(undefined)
        : livePhaseMocks[handlerName as keyof typeof livePhaseMocks].mockResolvedValue(undefined)
    if (phase) phaseIntermediate.set(`${TEST.ticketId}:${phase}`, {} as never)

    const actor = createSnapshotActor(state)
    const sendEvent = vi.fn()
    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, sendEvent)

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    const expectedArgs = handlerName === 'handleCoverageVerification'
      ? [TEST.ticketId, expect.anything(), sendEvent, phase, expect.anything()]
      : state === 'CLEANING_ENV'
        ? [TEST.ticketId, expect.anything(), sendEvent]
        : [TEST.ticketId, expect.anything(), sendEvent, expect.anything()]
    expect(handler).toHaveBeenCalledWith(...expectedArgs)
    await vi.waitFor(() => expect(runningPhases.has(`${TEST.ticketId}:${state}`)).toBe(false))
    actor.stop()
  })

  it.each([
    'DRAFT', 'WAITING_INTERVIEW_APPROVAL', 'WAITING_PRD_APPROVAL', 'WAITING_BEADS_APPROVAL',
    'WAITING_EXECUTION_SETUP_APPROVAL', 'WAITING_MANUAL_QA', 'WAITING_PR_REVIEW', 'BLOCKED_ERROR',
  ])('leaves mock %s idle without starting real phase work', (state) => {
    isMockOpenCodeModeMock.mockReturnValue(true)
    const actor = createSnapshotActor(state)
    const sendEvent = vi.fn()
    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, sendEvent)

    expect(runningPhases.size).toBe(0)
    expect(sendEvent).not.toHaveBeenCalled()
    for (const handler of Object.values(mockLifecyclePhaseMocks)) expect(handler).not.toHaveBeenCalled()
    expect(handleMockExecutionUnsupportedMock).not.toHaveBeenCalled()
    expect(handleInterviewDeliberateMock).not.toHaveBeenCalled()
    expect(handleCodingMock).not.toHaveBeenCalled()
    expect(handleFinalTestMock).not.toHaveBeenCalled()
    expect(handlePrdRefineMock).not.toHaveBeenCalled()
    expect(handleExecutionSetupPlanGenerationMock).not.toHaveBeenCalled()
    actor.stop()
  })

  it.each([
    'PRE_FLIGHT_CHECK', 'GENERATING_EXECUTION_SETUP_PLAN', 'PREPARING_EXECUTION_ENV',
    'CODING', 'RUNNING_FINAL_TEST', 'GENERATING_QA_CHECKLIST', 'INTEGRATING_CHANGES',
    'CREATING_PULL_REQUEST', 'CLEANING_ENV',
  ])('dispatches the mock execution handler for %s', async (state) => {
    isMockOpenCodeModeMock.mockReturnValue(true)
    handleMockExecutionUnsupportedMock.mockResolvedValue(undefined)
    const actor = createSnapshotActor(state)
    const sendEvent = vi.fn()
    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, sendEvent)

    await vi.waitFor(() => expect(runningPhases.has(`${TEST.ticketId}:${state}`)).toBe(false))
    expect(handleMockExecutionUnsupportedMock).toHaveBeenCalledExactlyOnceWith(
      TEST.ticketId, expect.anything(), state, sendEvent,
    )
    actor.stop()
  })

  it('does not block an active PRD refinement when the phase rejects after abort', async () => {
    isMockOpenCodeModeMock.mockReturnValue(false)
    phaseIntermediate.set(`${TEST.ticketId}:prd`, {} as never)
    handlePrdRefineMock.mockImplementation(async (
      _ticketId,
      _context,
      _sendEvent,
      signal: AbortSignal,
    ) => {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        }, { once: true })
      })
    })

    const actor = createRefiningPrdActor()
    const sentEvents: unknown[] = []
    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, (event) => {
      sentEvents.push(event)
      actor.send(event)
    })

    await vi.waitFor(() => {
      expect(handlePrdRefineMock).toHaveBeenCalledTimes(1)
    })

    ticketAbortControllers.get(TEST.ticketId)?.abort()

    await vi.waitFor(() => {
      expect(runningPhases.has(`${TEST.ticketId}:REFINING_PRD`)).toBe(false)
    })

    expect(actor.getSnapshot().value).toBe('REFINING_PRD')
    expect(sentEvents).not.toContainEqual(expect.objectContaining({ type: 'ERROR' }))
    expect(emitPhaseLogMock).not.toHaveBeenCalled()
  })

  it('blocks an active PRD refinement when it fails without cancellation', async () => {
    isMockOpenCodeModeMock.mockReturnValue(false)
    phaseIntermediate.set(`${TEST.ticketId}:prd`, {} as never)
    handlePrdRefineMock.mockRejectedValue(new Error('Refinement failed'))

    const actor = createRefiningPrdActor()
    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, (event) => actor.send(event))

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('BLOCKED_ERROR')
    })

    expect(actor.getSnapshot().context.error).toBe('Refinement failed')
    expect(emitPhaseLogMock).toHaveBeenCalledWith(
      TEST.ticketId,
      TEST.externalId,
      'REFINING_PRD',
      'error',
      'Refinement failed',
    )
  })

  it('starts work for a restored active snapshot immediately after attachment', async () => {
    isMockOpenCodeModeMock.mockReturnValue(false)
    handleCodingMock.mockImplementation(async (_ticketId, _context, sendEvent) => {
      sendEvent({ type: 'ALL_BEADS_DONE' })
    })
    handleFinalTestMock.mockResolvedValue(undefined)

    const actor = createSnapshotActor('CODING', {
      title: 'Runner restored coding test',
      status: 'CODING',
      previousStatus: 'PREPARING_EXECUTION_ENV',
      beadProgress: { total: 2, completed: 0, current: 'bead-1' },
    })

    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, (event) => actor.send(event))

    await vi.waitFor(() => {
      expect(handleCodingMock).toHaveBeenCalledTimes(1)
    })
  })

  it('does not restart restored coding while cancellation is pending', () => {
    isTicketCancellationPendingMock.mockReturnValue(true)
    const actor = createSnapshotActor('CODING', { status: 'CODING' })
    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, vi.fn())

    expect(isTicketCancellationPendingMock).toHaveBeenCalledWith(TEST.ticketId)
    expect(handleCodingMock).not.toHaveBeenCalled()
    actor.stop()
  })

  it('does not start any restored workflow phase while cancellation is pending', () => {
    isMockOpenCodeModeMock.mockReturnValue(false)
    isTicketCancellationPendingMock.mockReturnValue(true)
    const actor = createSnapshotActor('COUNCIL_DELIBERATING', { status: 'COUNCIL_DELIBERATING' })

    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, vi.fn())

    expect(isTicketCancellationPendingMock).toHaveBeenCalledWith(TEST.ticketId)
    expect(handleInterviewDeliberateMock).not.toHaveBeenCalled()
    actor.stop()
  })

  it('can attach to a restored snapshot without processing it immediately', async () => {
    isMockOpenCodeModeMock.mockReturnValue(true)

    const actor = createSnapshotActor('WAITING_EXECUTION_SETUP_APPROVAL', {
      title: 'Runner deferred setup approval test',
      status: 'WAITING_EXECUTION_SETUP_APPROVAL',
      previousStatus: 'PRE_FLIGHT_CHECK',
      beadProgress: { total: 5, completed: 0, current: null },
    })

    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, (event) => actor.send(event), {
      processInitialSnapshot: false,
    })

    expect(handleMockExecutionUnsupportedMock).not.toHaveBeenCalled()

    actor.send({ type: 'APPROVE_EXECUTION_SETUP_PLAN' })

    await vi.waitFor(() => {
      expect(handleMockExecutionUnsupportedMock).toHaveBeenCalledWith(
        TEST.ticketId,
        expect.objectContaining({ status: 'PREPARING_EXECUTION_ENV' }),
        'PREPARING_EXECUTION_ENV',
        expect.any(Function),
      )
    })
  })

  it('cleans in-memory workflow state when a ticket reaches COMPLETED naturally', async () => {
    const controller = new AbortController()
    ticketAbortControllers.set(TEST.ticketId, controller)
    runningPhases.add(`${TEST.ticketId}:CODING`)
    phaseIntermediate.set(`${TEST.ticketId}:prd`, {} as never)

    const actor = createSnapshotActor('COMPLETED', {
      title: 'Runner completed cleanup test',
      status: 'COMPLETED',
      previousStatus: 'CLEANING_ENV',
    })

    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, (event) => actor.send(event))

    await vi.waitFor(() => {
      expect(ticketAbortControllers.has(TEST.ticketId)).toBe(false)
      expect(runningPhases.has(`${TEST.ticketId}:CODING`)).toBe(false)
      expect(phaseIntermediate.has(`${TEST.ticketId}:prd`)).toBe(false)
    })
    expect(controller.signal.aborted).toBe(false)
  })

  it('retains cancellation state after an unconfirmed stop and cleans it after a later confirmation', async () => {
    requestSessionContinuation({
      ticketId: TEST.ticketId,
      phase: 'CODING',
      sessionId: 'ses-canceled',
    })
    abortTicketSessionsMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const actor = createSnapshotActor('CANCELED', {
      title: 'Runner cancellation stop test',
      status: 'CANCELED',
      previousStatus: 'CODING',
    })

    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, vi.fn())
    await vi.waitFor(() => expect(abortTicketSessionsMock).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(hasPendingSessionContinuationForTicketPhase(TEST.ticketId, 'CODING')).toBe(true))

    // The retry timer owns the next attempt; a repeated terminal snapshot must
    // not bypass its bounded backoff while that timer is still armed.
    await vi.waitFor(() => expect(abortTicketSessionsMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(hasPendingSessionContinuationForTicketPhase(TEST.ticketId, 'CODING')).toBe(false))
    actor.stop()
  })

  it('redrives a failed cancel marker before sending CANCEL from a live phase', async () => {
    vi.useFakeTimers()
    try {
      isTicketCancellationPendingMock.mockReturnValue(true)
      abortTicketSessionsMock
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValue(true)
      const actor = createSnapshotActor('CODING', { status: 'CODING' })
      const sendEvent = vi.fn((event) => actor.send(event))

      actor.start()
      attachWorkflowRunner(TEST.ticketId, actor, sendEvent)
      expect(handleCodingMock).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(250)
      expect(abortTicketSessionsMock).toHaveBeenCalledTimes(1)
      expect(actor.getSnapshot().value).toBe('CODING')

      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(abortTicketSessionsMock).toHaveBeenCalledTimes(3))
      expect(sendEvent).toHaveBeenCalledWith({ type: 'CANCEL' })
      expect(actor.getSnapshot().value).toBe('CANCELED')
      actor.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not send stale CANCEL after explicit Retry clears the marker during cleanup', async () => {
    vi.useFakeTimers()
    try {
      const clearWindows = vi.spyOn(questionWindows, 'clearTicketWindows')
      let cancellationPending = true
      isTicketCancellationPendingMock.mockImplementation(() => cancellationPending)
      abortTicketSessionsMock.mockImplementationOnce(async () => {
        // Model the explicit Retry route finishing its stop/reset hand-off
        // while this older cleanup pass is still awaiting the session stop.
        cancellationPending = false
        return true
      })
      const actor = createSnapshotActor('CODING', { status: 'CODING' })
      const sendEvent = vi.fn((event) => actor.send(event))

      actor.start()
      attachWorkflowRunner(TEST.ticketId, actor, sendEvent)
      expect(handleCodingMock).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => expect(abortTicketSessionsMock).toHaveBeenCalledOnce())
      expect(sendEvent).not.toHaveBeenCalledWith({ type: 'CANCEL' })
      expect(clearWindows).not.toHaveBeenCalled()
      expect(actor.getSnapshot().value).toBe('CODING')
      actor.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues CODING after a bead-complete self-transition', async () => {
    isMockOpenCodeModeMock.mockReturnValue(false)

    handleCodingMock
      .mockImplementationOnce(async (_ticketId, _context, sendEvent) => {
        sendEvent({ type: 'BEAD_COMPLETE' })
      })
      .mockImplementationOnce(async (_ticketId, _context, sendEvent) => {
        sendEvent({ type: 'ALL_BEADS_DONE' })
      })

    handleFinalTestMock.mockResolvedValue(undefined)

    const actor = createSnapshotActor('CODING', {
      title: 'Runner test',
      status: 'CODING',
      previousStatus: 'PRE_FLIGHT_CHECK',
      beadProgress: { total: 5, completed: 1, current: 'bead-2' },
      iterationCount: 1,
    })

    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, (event) => actor.send(event))
    actor.send({ type: 'BEAD_COMPLETE' })

    await vi.waitFor(() => {
      expect(handleCodingMock).toHaveBeenCalledTimes(2)
    })

    expect(actor.getSnapshot().value).toBe('RUNNING_FINAL_TEST')
    expect(handleFinalTestMock).toHaveBeenCalledTimes(1)
  })

  it('does not block CODING when completed beads exceed maxIterations', () => {
    const actor = createSnapshotActor('CODING', {
      title: 'Runner test',
      status: 'CODING',
      previousStatus: 'PRE_FLIGHT_CHECK',
      beadProgress: { total: 5, completed: 1, current: 'bead-2' },
      iterationCount: 5,
      maxIterations: 1,
    })

    actor.start()
    actor.send({ type: 'BEAD_COMPLETE' })

    expect(actor.getSnapshot().value).toBe('CODING')
    expect(actor.getSnapshot().context.error).toBeNull()
  })

  it('routes GENERATING_EXECUTION_SETUP_PLAN through the mock execution guard in mock mode', async () => {
    isMockOpenCodeModeMock.mockReturnValue(true)

    const actor = createSnapshotActor('PRE_FLIGHT_CHECK', {
      title: 'Runner mock setup test',
      status: 'PRE_FLIGHT_CHECK',
      previousStatus: 'PRE_FLIGHT_CHECK',
      beadProgress: { total: 5, completed: 0, current: null },
    })

    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, (event) => actor.send(event))
    actor.send({ type: 'CHECKS_PASSED' })

    await vi.waitFor(() => {
      expect(handleMockExecutionUnsupportedMock).toHaveBeenCalledWith(
        TEST.ticketId,
        expect.objectContaining({ status: 'GENERATING_EXECUTION_SETUP_PLAN' }),
        'GENERATING_EXECUTION_SETUP_PLAN',
        expect.any(Function),
      )
    })
  })

  it('resumes a restored setup-plan drafting snapshot with its durable request reference', async () => {
    isMockOpenCodeModeMock.mockReturnValue(false)
    handleExecutionSetupPlanGenerationMock.mockResolvedValue(undefined)

    const actor = createSnapshotActor('GENERATING_EXECUTION_SETUP_PLAN', {
      title: 'Runner restored setup-plan drafting test',
      status: 'GENERATING_EXECUTION_SETUP_PLAN',
      previousStatus: 'WAITING_EXECUTION_SETUP_APPROVAL',
      pendingExecutionSetupPlanRequestArtifactId: 73,
    })

    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, (event) => actor.send(event))

    await vi.waitFor(() => {
      expect(handleExecutionSetupPlanGenerationMock).toHaveBeenCalledTimes(1)
    })
    expect(handleExecutionSetupPlanGenerationMock).toHaveBeenCalledWith(
      TEST.ticketId,
      expect.objectContaining({
        status: 'GENERATING_EXECUTION_SETUP_PLAN',
        pendingExecutionSetupPlanRequestArtifactId: 73,
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })

  it('routes PREPARING_EXECUTION_ENV through the mock execution guard in mock mode', async () => {
    isMockOpenCodeModeMock.mockReturnValue(true)

    const actor = createSnapshotActor('WAITING_EXECUTION_SETUP_APPROVAL', {
      title: 'Runner mock execution setup test',
      status: 'WAITING_EXECUTION_SETUP_APPROVAL',
      previousStatus: 'WAITING_EXECUTION_SETUP_APPROVAL',
      beadProgress: { total: 5, completed: 0, current: null },
    })

    actor.start()
    attachWorkflowRunner(TEST.ticketId, actor, (event) => actor.send(event))
    actor.send({ type: 'APPROVE_EXECUTION_SETUP_PLAN' })

    await vi.waitFor(() => {
      expect(handleMockExecutionUnsupportedMock).toHaveBeenCalledWith(
        TEST.ticketId,
        expect.objectContaining({ status: 'PREPARING_EXECUTION_ENV' }),
        'PREPARING_EXECUTION_ENV',
        expect.any(Function),
      )
    })
  })
})
