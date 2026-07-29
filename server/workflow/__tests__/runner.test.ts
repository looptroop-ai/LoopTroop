import { createActor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TicketContext } from '../../machines/types'
import { ticketMachine } from '../../machines/ticketMachine'
import { attachWorkflowRunner } from '../runner'
import { phaseIntermediate, runningPhases, ticketAbortControllers } from '../phases'
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
  handleCodingMock,
  handleFinalTestMock,
  handlePrdRefineMock,
  handleExecutionSetupPlanGenerationMock,
  handleMockExecutionUnsupportedMock,
  emitPhaseLogMock,
  isMockOpenCodeModeMock,
} = vi.hoisted(() => ({
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
    handleCodingMock.mockReset()
    handleFinalTestMock.mockReset()
    handlePrdRefineMock.mockReset()
    handleExecutionSetupPlanGenerationMock.mockReset()
    handleMockExecutionUnsupportedMock.mockReset()
    emitPhaseLogMock.mockReset()
    isMockOpenCodeModeMock.mockReset()
    phaseIntermediate.clear()
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
