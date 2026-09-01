import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { PROFILE_DEFAULTS } from '../../db/defaults'
import { makeTicketContext } from '../../test/factories'
import { buildMachineContext } from '../persistence'
import { ticketMachine } from '../ticketMachine'
import { buildTicketContextFromTicket, type TicketContextSource } from '../ticketContext'
import { TICKET_CONTEXT_KEYS } from '../types'

function makeSourceTicket(overrides: Partial<TicketContextSource> = {}): TicketContextSource {
  return {
    id: '1:TEST-1',
    projectId: 1,
    externalId: 'TEST-1',
    title: 'Test ticket',
    status: 'CODING',
    previousStatus: 'PREPARING_EXECUTION_ENV',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    lockedMainImplementer: 'test-vendor/test-model',
    lockedMainImplementerVariant: null,
    lockedCouncilMembers: ['test-vendor/test-model'],
    lockedCouncilMemberVariants: null,
    lockedInterviewQuestions: null,
    lockedCoverageFollowUpBudgetPercent: null,
    lockedMaxCoveragePasses: null,
    lockedMaxPrdCoveragePasses: null,
    lockedMaxBeadsCoveragePasses: null,
    lockedStructuredRetryCount: null,
    lockedManualQaEnabled: null,
    lockedManualQaSource: null,
    lockedAiQuestionsEnabled: null,
    lockedAiQuestionsSource: null,
    lockedAiQuestionWindow: null,
    lockedAiQuestionWindowSource: null,
    errorMessage: null,
    errorOccurrences: [],
    runtime: {
      totalBeads: 0,
      completedBeads: 0,
      activeBeadId: null,
      iterationCount: 0,
      maxIterations: null,
    },
    ...overrides,
  } as TicketContextSource
}

describe('buildTicketContextFromTicket', () => {
  it('emits exactly the machine context fields', () => {
    const context = buildTicketContextFromTicket(makeSourceTicket())
    expect(Object.keys(context).sort()).toEqual([...TICKET_CONTEXT_KEYS].sort())
  })

  it('carries the ticket identity and locked model selection through', () => {
    const context = buildTicketContextFromTicket(makeSourceTicket())
    expect(context.ticketId).toBe('1:TEST-1')
    expect(context.externalId).toBe('TEST-1')
    expect(context.status).toBe('CODING')
    expect(context.previousStatus).toBe('PREPARING_EXECUTION_ENV')
    expect(context.lockedMainImplementer).toBe('test-vendor/test-model')
    expect(context.lockedCouncilMembers).toEqual(['test-vendor/test-model'])
  })

  it('carries the ticket error, its codes and its diagnostics', () => {
    // One of the two builders this replaces hardcoded null/[] here, so a
    // context built during Manual QA reported no error on a blocked ticket.
    const context = buildTicketContextFromTicket(makeSourceTicket({
      errorMessage: 'Bead finalisation failed',
      errorOccurrences: [
        { errorCodes: ['STALE'], diagnostics: null },
        { errorCodes: ['BEAD_FINALIZATION_FAILED'], diagnostics: { kind: 'runtime', source: 'system', summary: 'boom' } },
      ] as TicketContextSource['errorOccurrences'],
    }))

    expect(context.error).toBe('Bead finalisation failed')
    expect(context.errorCodes).toEqual(['BEAD_FINALIZATION_FAILED'])
    expect(context.errorDiagnostics).toEqual({ kind: 'runtime', source: 'system', summary: 'boom' })
  })

  it('normalises every setting source, including the Manual QA one', () => {
    // The Manual QA builder passed lockedManualQaSource through unnormalised,
    // so a stale column value reached the machine context verbatim.
    const context = buildTicketContextFromTicket(makeSourceTicket({
      lockedManualQaSource: 'nonsense' as TicketContextSource['lockedManualQaSource'],
      lockedAiQuestionsSource: 'project',
      lockedAiQuestionWindowSource: 'also nonsense' as TicketContextSource['lockedAiQuestionWindowSource'],
    }))

    expect(context.lockedManualQaSource).toBeNull()
    expect(context.lockedAiQuestionsSource).toBe('project')
    expect(context.lockedAiQuestionWindowSource).toBeNull()
  })

  it('falls back to the profile default when the ticket has no iteration cap', () => {
    // The two builders used 0 and 1 here; neither matched any other path.
    const context = buildTicketContextFromTicket(makeSourceTicket())
    expect(context.maxIterations).toBe(PROFILE_DEFAULTS.maxIterations)
  })

  it('keeps the ticket cap when it has one', () => {
    const context = buildTicketContextFromTicket(makeSourceTicket({
      runtime: { totalBeads: 4, completedBeads: 1, activeBeadId: 'bead-2', iterationCount: 3, maxIterations: 9 } as TicketContextSource['runtime'],
    }))

    expect(context.maxIterations).toBe(9)
    expect(context.iterationCount).toBe(3)
    expect(context.beadProgress).toEqual({ total: 4, completed: 1, current: 'bead-2' })
  })
})

describe('makeTicketContext', () => {
  it('emits exactly the machine context fields', () => {
    // The test factory is a fourth builder of the same record. A field added to
    // TicketContext as optional would compile without it, and every test using
    // the factory would then exercise a context production never produces.
    expect(Object.keys(makeTicketContext()).sort()).toEqual([...TICKET_CONTEXT_KEYS].sort())
  })
})

describe('buildMachineContext', () => {
  it('emits exactly the machine context fields', () => {
    // The actor-creation builder. It takes actor input rather than a ticket
    // row, which is why it is not the shared builder — but it assembles the
    // same record, so an optional field omitted here would be just as invisible.
    const context = buildMachineContext(
      { ticketId: '1:TEST-1', projectId: 1, externalId: 'TEST-1', title: 'Test ticket' },
      { status: 'DRAFT' },
    )

    expect(Object.keys(context).sort()).toEqual([...TICKET_CONTEXT_KEYS].sort())
  })
})

describe('the state machine context factory', () => {
  it('emits exactly the machine context fields', () => {
    // The fourth assembler: xstate builds the initial context itself, so a
    // field missing here is missing from every actor that starts fresh.
    const actor = createActor(ticketMachine, {
      input: { ticketId: '1:TEST-1', projectId: 1, externalId: 'TEST-1', title: 'Test ticket' },
    })
    actor.start()

    try {
      expect(Object.keys(actor.getSnapshot().context).sort()).toEqual([...TICKET_CONTEXT_KEYS].sort())
    } finally {
      actor.stop()
    }
  })
})
