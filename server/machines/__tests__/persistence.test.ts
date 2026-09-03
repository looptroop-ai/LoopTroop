import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { appendLogEvent } from '../../log/executionLog'
import { broadcaster } from '../../sse/broadcaster'
import { DISPLAY_ONLY_MOCK_BRANCH_NAME, patchTicket, getTicketByRef, getTicketPaths } from '../../storage/tickets'
import { TEST, makeTicketContextFromTicket } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { ensureActorForTicket, getTicketState, hydrateAllTickets, revertTicketToApprovalStatus, stopActor } from '../persistence'
import { attachWorkflowRunner } from '../../workflow/runner'

vi.mock('../../workflow/runner', () => ({
  attachWorkflowRunner: vi.fn(),
}))

const repoManager = createTestRepoManager('persistence-')

describe('hydrateAllTickets', () => {
  beforeEach(() => {
    resetTestDb()
    vi.clearAllMocks()
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('does not append active-state log noise when restoring a paused ticket', () => {
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Hydrated review pause',
    })

    appendLogEvent(
      ticket.id,
      'info',
      'WAITING_PR_REVIEW',
      '[SYS] Draft pull request ready.',
      { timestamp: TEST.timestamp },
      'system',
      'WAITING_PR_REVIEW',
    )

    const snapshot = {
      status: 'active',
      value: 'WAITING_PR_REVIEW',
      historyValue: {},
      context: makeTicketContextFromTicket(ticket, {
        status: 'WAITING_PR_REVIEW',
        previousStatus: 'CREATING_PULL_REQUEST',
      }),
      children: {},
    }

    patchTicket(ticket.id, {
      status: 'WAITING_PR_REVIEW',
      xstateSnapshot: JSON.stringify(snapshot),
    })

    const paths = getTicketPaths(ticket.id)
    if (!paths || !existsSync(paths.executionLogPath)) {
      throw new Error('Execution log path was not initialized')
    }

    const beforeHydration = readFileSync(paths.executionLogPath, 'utf8')

    try {
      expect(hydrateAllTickets()).toBe(1)
      expect(readFileSync(paths.executionLogPath, 'utf8')).toBe(beforeHydration)
    } finally {
      stopActor(ticket.id)
    }
  })

  it('blocks a non-draft ticket instead of regressing to draft when its snapshot is corrupt', () => {
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Corrupt snapshot recovery',
    })

    patchTicket(ticket.id, {
      status: 'CODING',
      xstateSnapshot: '{not-json',
    })

    try {
      expect(hydrateAllTickets()).toBe(1)
      const recovered = getTicketByRef(ticket.id)
      expect(recovered?.status).toBe('BLOCKED_ERROR')
      expect(recovered?.previousStatus).toBe('CODING')
      expect(recovered?.errorMessage).toContain('workflow snapshot could not be restored safely')
      expect(recovered?.errorOccurrences.at(-1)?.errorCodes).toContain('SNAPSHOT_RECOVERY_FAILED')
    } finally {
      stopActor(ticket.id)
    }
  })

  it('drops invalid persisted context fields instead of restoring them', () => {
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Malformed persisted context',
    })

    const snapshot = {
      status: 'active',
      value: 'WAITING_PR_REVIEW',
      historyValue: {},
      context: {
        ...makeTicketContextFromTicket(ticket, { status: 'WAITING_PR_REVIEW' }),
        maxIterations: -3,
        iterationCount: -2,
        // `completed > total` reads as "every bead is done" to the coding
        // guard, so a restored snapshot could skip straight to final testing.
        beadProgress: { total: 1, completed: 99, current: null },
        // Repaired only for a blocked ticket before; anywhere else it restored
        // as written and reached the public payload.
        previousStatus: 'not-a-workflow-phase',
        councilResults: 'not-an-object',
        createdAt: 12345,
        errorCodes: ['ok', 7],
      },
      children: {},
    }

    patchTicket(ticket.id, {
      status: 'WAITING_PR_REVIEW',
      xstateSnapshot: JSON.stringify(snapshot),
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(hydrateAllTickets()).toBe(1)
      const restored = getTicketState(ticket.id)
      expect(restored?.context.maxIterations).toBe(5)
      expect(restored?.context.iterationCount).toBe(0)
      expect(restored?.context.beadProgress).toEqual({ total: 0, completed: 0, current: null })
      expect(restored?.context.councilResults).toBeNull()
      // The fallback used to write `''`, which is not a timestamp either and is
      // exactly the value it was replacing.
      expect(restored?.context.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(restored?.context.errorCodes).toEqual([])
      expect(restored?.context.previousStatus).toBeNull()
      // The ticket keeps running: one bad field does not discard the session.
      expect(getTicketByRef(ticket.id)?.status).toBe('WAITING_PR_REVIEW')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      stopActor(ticket.id)
    }
  })

  it('keeps valid persisted context fields untouched', () => {
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Valid persisted context',
    })

    const snapshot = {
      status: 'active',
      value: 'WAITING_PR_REVIEW',
      historyValue: {},
      context: {
        ...makeTicketContextFromTicket(ticket, { status: 'WAITING_PR_REVIEW' }),
        // 0 means "no cap" to the executor, so it must survive a restore.
        maxIterations: 0,
        iterationCount: 3,
        beadProgress: { total: 4, completed: 2, current: 'bead-2' },
        councilResults: { interview: 'done' },
        errorCodes: ['BEAD_AGENT_RESPONSE_INVALID'],
      },
      children: {},
    }

    patchTicket(ticket.id, {
      status: 'WAITING_PR_REVIEW',
      xstateSnapshot: JSON.stringify(snapshot),
    })

    try {
      expect(hydrateAllTickets()).toBe(1)
      const restored = getTicketState(ticket.id)
      expect(restored?.context.maxIterations).toBe(0)
      expect(restored?.context.iterationCount).toBe(3)
      expect(restored?.context.beadProgress).toEqual({ total: 4, completed: 2, current: 'bead-2' })
      expect(restored?.context.councilResults).toEqual({ interview: 'done' })
      expect(restored?.context.errorCodes).toEqual(['BEAD_AGENT_RESPONSE_INVALID'])
    } finally {
      stopActor(ticket.id)
    }
  })

  it('does not hydrate or actor-create display-only mock tickets', () => {
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Display-only mock actor guard',
    })

    const snapshot = {
      status: 'active',
      value: 'SCANNING_RELEVANT_FILES',
      historyValue: {},
      context: makeTicketContextFromTicket(ticket, {
        status: 'SCANNING_RELEVANT_FILES',
      }),
      children: {},
    }

    patchTicket(ticket.id, {
      branchName: DISPLAY_ONLY_MOCK_BRANCH_NAME,
      status: 'SCANNING_RELEVANT_FILES',
      xstateSnapshot: JSON.stringify(snapshot),
    })

    expect(getTicketByRef(ticket.id)?.availableActions).toEqual(['cancel'])
    expect(hydrateAllTickets()).toBe(0)
    expect(attachWorkflowRunner).not.toHaveBeenCalled()
    expect(() => ensureActorForTicket(ticket.id)).toThrow(/display-only mock ticket/i)
  })

  it('persists blocked-error diagnostics from actor ERROR events into public tickets', () => {
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Persist blocked diagnostics',
    })
    const broadcastSpy = vi.spyOn(broadcaster, 'broadcast')

    try {
      const actor = ensureActorForTicket(ticket.id)
      actor.send({ type: 'START', lockedMainImplementer: 'model-a', lockedCouncilMembers: ['model-a'] })
      actor.send({
        type: 'ERROR',
        message: 'Relevant files scan failed validation after 1 structured retry attempt(s): Relevant files output was empty. Underlying OpenCode error: rate_limit_error: Model usage limit reached (HTTP 429)',
        codes: ['RELEVANT_FILES_SCAN_FAILED', 'OPENCODE_PROVIDER_ERROR'],
        diagnostics: {
          kind: 'opencode_provider',
          source: 'provider',
          summary: 'rate_limit_error: Model usage limit reached (HTTP 429)',
          modelId: 'model-a',
          sessionId: 'ses-limit',
          statusCode: 429,
          providerErrorType: 'rate_limit_error',
          providerErrorMessage: 'Model usage limit reached',
          isRetryable: true,
        },
      })

      const recovered = getTicketByRef(ticket.id)
      expect(recovered?.status).toBe('BLOCKED_ERROR')
      expect(recovered?.errorOccurrences.at(-1)).toMatchObject({
        blockedFromStatus: 'SCANNING_RELEVANT_FILES',
        errorCodes: ['RELEVANT_FILES_SCAN_FAILED', 'OPENCODE_PROVIDER_ERROR'],
        diagnostics: expect.objectContaining({
          kind: 'opencode_provider',
          source: 'provider',
          modelId: 'model-a',
          sessionId: 'ses-limit',
          statusCode: 429,
          providerErrorType: 'rate_limit_error',
          providerErrorMessage: 'Model usage limit reached',
          isRetryable: true,
        }),
      })
      expect(broadcastSpy).toHaveBeenCalledWith(
        ticket.id,
        'state_change',
        expect.objectContaining({
          to: 'BLOCKED_ERROR',
          phaseAttempt: 1,
        }),
      )
      expect(broadcastSpy).toHaveBeenCalledWith(
        ticket.id,
        'log',
        expect.objectContaining({
          type: 'error',
          phase: 'BLOCKED_ERROR',
          phaseAttempt: 1,
        }),
      )
    } finally {
      stopActor(ticket.id)
      broadcastSpy.mockRestore()
    }
  })

  it('resolves blocked-error occurrences as continued when CONTINUE resumes the previous status', () => {
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Persist blocked continue',
    })

    try {
      const actor = ensureActorForTicket(ticket.id)
      actor.send({ type: 'START', lockedMainImplementer: 'model-a', lockedCouncilMembers: ['model-a'] })
      actor.send({
        type: 'ERROR',
        message: 'Usage limit reached.',
        diagnostics: {
          kind: 'opencode_provider',
          source: 'provider',
          summary: 'usage limit reached',
          modelId: 'model-a',
          sessionId: 'ses-limit',
          statusCode: 429,
          isRetryable: true,
        },
      })
      actor.send({ type: 'CONTINUE' })

      const recovered = getTicketByRef(ticket.id)
      expect(recovered?.status).toBe('SCANNING_RELEVANT_FILES')
      expect(recovered?.errorOccurrences.at(-1)).toMatchObject({
        blockedFromStatus: 'SCANNING_RELEVANT_FILES',
        resolutionStatus: 'CONTINUED',
        resumedToStatus: 'SCANNING_RELEVANT_FILES',
      })
    } finally {
      stopActor(ticket.id)
    }
  })

  it('reconstructs a missing active snapshot from the durable ticket status', () => {
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Missing snapshot recovery',
    })

    patchTicket(ticket.id, {
      status: 'WAITING_PR_REVIEW',
      xstateSnapshot: null,
    })

    try {
      expect(hydrateAllTickets()).toBe(1)
      const recovered = getTicketByRef(ticket.id)
      expect(recovered?.status).toBe('WAITING_PR_REVIEW')
      expect(recovered?.xstateSnapshot).toContain('WAITING_PR_REVIEW')
    } finally {
      stopActor(ticket.id)
    }
  })

  it('persists a planning edit rewind when reverting an active actor to approval', () => {
    const { ticket, paths } = createInitializedTestTicket(repoManager, {
      title: 'Persist planning edit rewind',
    })

    const snapshot = {
      status: 'active',
      value: 'REFINING_PRD',
      historyValue: {},
      context: makeTicketContextFromTicket(ticket, {
        status: 'REFINING_PRD',
        previousStatus: 'COUNCIL_VOTING_PRD',
      }),
      children: {},
    }

    patchTicket(ticket.id, {
      status: 'REFINING_PRD',
      xstateSnapshot: JSON.stringify(snapshot),
    })

    try {
      expect(ensureActorForTicket(ticket.id).getSnapshot().value).toBe('REFINING_PRD')

      const rewoundActor = revertTicketToApprovalStatus(ticket.id, 'WAITING_INTERVIEW_APPROVAL')
      expect(rewoundActor.getSnapshot().value).toBe('WAITING_INTERVIEW_APPROVAL')

      const rewound = getTicketByRef(ticket.id)
      expect(rewound?.status).toBe('WAITING_INTERVIEW_APPROVAL')
      expect(rewound?.xstateSnapshot).toContain('WAITING_INTERVIEW_APPROVAL')

      const persistedSnapshot = JSON.parse(rewound?.xstateSnapshot ?? '{}') as {
        value?: string
        context?: { status?: string; previousStatus?: string }
      }
      expect(persistedSnapshot.value).toBe('WAITING_INTERVIEW_APPROVAL')
      expect(persistedSnapshot.context?.status).toBe('WAITING_INTERVIEW_APPROVAL')
      expect(persistedSnapshot.context?.previousStatus).toBe('REFINING_PRD')
      expect(readFileSync(`${paths.ticketDir}/runtime/state.yaml`, 'utf8')).toContain('status: WAITING_INTERVIEW_APPROVAL')
    } finally {
      stopActor(ticket.id)
    }
  })

  it('can revert an actor without immediately processing the restored approval snapshot', () => {
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Quiet runtime setup rewind',
    })

    const snapshot = {
      status: 'active',
      value: 'PREPARING_EXECUTION_ENV',
      historyValue: {},
      context: makeTicketContextFromTicket(ticket, {
        status: 'PREPARING_EXECUTION_ENV',
        previousStatus: 'WAITING_EXECUTION_SETUP_APPROVAL',
      }),
      children: {},
    }

    patchTicket(ticket.id, {
      status: 'PREPARING_EXECUTION_ENV',
      xstateSnapshot: JSON.stringify(snapshot),
    })

    try {
      expect(ensureActorForTicket(ticket.id).getSnapshot().value).toBe('PREPARING_EXECUTION_ENV')
      vi.mocked(attachWorkflowRunner).mockClear()

      const rewoundActor = revertTicketToApprovalStatus(ticket.id, 'WAITING_EXECUTION_SETUP_APPROVAL', {
        skipInitialWorkflowRun: true,
      })
      expect(rewoundActor.getSnapshot().value).toBe('WAITING_EXECUTION_SETUP_APPROVAL')
      expect(vi.mocked(attachWorkflowRunner)).toHaveBeenCalledWith(
        ticket.id,
        rewoundActor,
        expect.any(Function),
        { processInitialSnapshot: false },
      )
    } finally {
      stopActor(ticket.id)
    }
  })

  it('hydrates an actor with malformed locked council JSON without crashing', () => {
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Malformed locked council hydration',
    })

    const snapshot = {
      status: 'active',
      value: 'REFINING_PRD',
      historyValue: {},
      context: makeTicketContextFromTicket(ticket, {
        status: 'REFINING_PRD',
        previousStatus: 'COUNCIL_VOTING_PRD',
      }),
      children: {},
    }

    patchTicket(ticket.id, {
      status: 'REFINING_PRD',
      lockedCouncilMembers: '{not-json',
      lockedCouncilMemberVariants: '{not-json',
      xstateSnapshot: JSON.stringify(snapshot),
    })

    try {
      const actor = ensureActorForTicket(ticket.id)
      expect(actor.getSnapshot().value).toBe('REFINING_PRD')
      expect(actor.getSnapshot().context.lockedCouncilMembers).toEqual([])
      expect(actor.getSnapshot().context.lockedCouncilMemberVariants).toBeNull()
    } finally {
      stopActor(ticket.id)
    }
  })

  it('reverts an active actor with malformed locked council JSON without crashing', () => {
    const { ticket } = createInitializedTestTicket(repoManager, {
      title: 'Malformed locked council revert',
    })

    const snapshot = {
      status: 'active',
      value: 'REFINING_BEADS',
      historyValue: {},
      context: makeTicketContextFromTicket(ticket, {
        status: 'REFINING_BEADS',
        previousStatus: 'COUNCIL_VOTING_BEADS',
      }),
      children: {},
    }

    patchTicket(ticket.id, {
      status: 'REFINING_BEADS',
      lockedCouncilMembers: '{not-json',
      lockedCouncilMemberVariants: '{"model-a":',
      xstateSnapshot: JSON.stringify(snapshot),
    })

    try {
      expect(ensureActorForTicket(ticket.id).getSnapshot().value).toBe('REFINING_BEADS')

      const rewoundActor = revertTicketToApprovalStatus(ticket.id, 'WAITING_PRD_APPROVAL')
      expect(rewoundActor.getSnapshot().value).toBe('WAITING_PRD_APPROVAL')
      expect(rewoundActor.getSnapshot().context.lockedCouncilMembers).toEqual([])
      expect(rewoundActor.getSnapshot().context.lockedCouncilMemberVariants).toBeNull()
    } finally {
      stopActor(ticket.id)
    }
  })
})
