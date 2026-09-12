import { createActor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TicketContext } from '../../machines/types'
import { ticketMachine } from '../../machines/ticketMachine'
import { attachWorkflowRunner } from '../runner'
import { phaseIntermediate, runningPhases, ticketAbortControllers } from '../phases'
import { OpenCodeUnavailableError, TicketWorkspaceNotInitializedError } from '../../lib/workflowErrors'
import { TEST, makeTicketContext } from '../../test/factories'

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
  handleInterviewDeliberateMock,
  handleCodingMock,
  handleFinalTestMock,
  handlePrdRefineMock,
  handleExecutionSetupPlanGenerationMock,
  handleMockExecutionUnsupportedMock,
  emitPhaseLogMock,
  isMockOpenCodeModeMock,
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
  handleInterviewDeliberateMock: vi.fn(),
  handleCodingMock: vi.fn(),
  handleFinalTestMock: vi.fn(),
  handlePrdRefineMock: vi.fn(),
  handleExecutionSetupPlanGenerationMock: vi.fn(),
  handleMockExecutionUnsupportedMock: vi.fn(),
  emitPhaseLogMock: vi.fn(),
  isMockOpenCodeModeMock: vi.fn(),
}))

vi.mock('../../opencode/factory', async () => {
  const actual = await vi.importActual<typeof import('../../opencode/factory')>('../../opencode/factory')
  return {
    ...actual,
    isMockOpenCodeMode: isMockOpenCodeModeMock,
  }
})

vi.mock('../phases', async () => {
  const actual = await vi.importActual<typeof import('../phases')>('../phases')
  return {
    ...actual,
    ...mockLifecyclePhaseMocks,
    handleInterviewDeliberate: handleInterviewDeliberateMock,
    handleCoding: handleCodingMock,
    handleFinalTest: handleFinalTestMock,
    handlePrdRefine: handlePrdRefineMock,
    handleExecutionSetupPlanGeneration: handleExecutionSetupPlanGenerationMock,
    handleMockExecutionUnsupported: handleMockExecutionUnsupportedMock,
    emitPhaseLog: emitPhaseLogMock,
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
    handleInterviewDeliberateMock.mockReset()
    handleCodingMock.mockReset()
    handleFinalTestMock.mockReset()
    handlePrdRefineMock.mockReset()
    handleExecutionSetupPlanGenerationMock.mockReset()
    handleMockExecutionUnsupportedMock.mockReset()
    emitPhaseLogMock.mockReset()
    isMockOpenCodeModeMock.mockReset()
    phaseIntermediate.clear()
  })

  it.each([
    [new OpenCodeUnavailableError('OpenCode server is not running. Start it with `opencode serve`. (connection refused)'), 'OPENCODE_UNREACHABLE'],
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
