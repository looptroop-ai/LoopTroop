import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import type { Bead } from '../../phases/beads/types'
import { makeTicketContextFromTicket } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { getLatestPhaseArtifact, getTicketByRef, getTicketContext, getTicketPaths, upsertLatestPhaseArtifact } from '../../storage/tickets'
import { opencodeSessions, profiles } from '../../db/schema'
import { db as appDatabase } from '../../db/index'
import { listOpenCodeSessionsForTicket } from '../../opencode/sessionManager'
import { applyOpencodeStepsConfig, restoreOpencodeStepsConfig } from '../../phases/execution/opencodeStepsConfig'
import {
  readTicketBeads,
  recoverCodingBeadWithReset,
  writeTicketBeads,
} from '../phases/beadsPhase'
import { phaseIntermediate } from '../phases/state'
import { BEAD_RETRY_BUDGET_EXHAUSTED, OPENCODE_PROVIDER_ERROR } from '../../../shared/errorCodes'
import {
  clearAllPendingSessionContinuationsForTests,
  requestSessionContinuation,
} from '../../opencode/sessionContinuation'

const {
  executeBeadMock,
  recordBeadStartCommitMock,
  commitBeadChangesMock,
  resetToBeadStartMock,
  captureBeadDiffMock,
  assembleBeadContextMock,
  isMockOpenCodeModeMock,
  broadcastMock,
  abortSessionMock,
} = vi.hoisted(() => ({
  executeBeadMock: vi.fn(),
  recordBeadStartCommitMock: vi.fn(),
  commitBeadChangesMock: vi.fn(),
  resetToBeadStartMock: vi.fn(),
  captureBeadDiffMock: vi.fn(),
  assembleBeadContextMock: vi.fn(),
  isMockOpenCodeModeMock: vi.fn(),
  broadcastMock: vi.fn(),
  abortSessionMock: vi.fn(),
}))

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({}),
  isMockOpenCodeMode: isMockOpenCodeModeMock,
}))

vi.mock('../../opencode/connection', async () => {
  const actual = await vi.importActual<typeof import('../../opencode/connection')>('../../opencode/connection')
  return {
    ...actual,
    getOpenCodeConnection: vi.fn().mockResolvedValue({ protocol: 'v1', version: '1.0.0', headers: {} }),
  }
})

vi.mock('../../phases/execution/executor', () => ({
  executeBead: executeBeadMock,
}))

vi.mock('../../phases/execution/gitOps', () => ({
  WORKTREE_RESET_PRESERVE_PATHS: ['.ticket'],
  recordBeadStartCommit: recordBeadStartCommitMock,
  commitBeadChanges: commitBeadChangesMock,
  resetToBeadStart: resetToBeadStartMock,
  captureBeadDiff: captureBeadDiffMock,
}))

vi.mock('../phases/state', async () => {
  const actual = await vi.importActual<typeof import('../phases/state')>('../phases/state')
  return {
    ...actual,
    adapter: {
      assembleBeadContext: assembleBeadContextMock,
      abortSession: abortSessionMock,
    },
  }
})

vi.mock('../../sse/broadcaster', () => ({
  broadcaster: {
    broadcast: broadcastMock,
  },
  SSEBroadcaster: class {},
}))

import { handleCoding, recoverSuccessfulExecutionCheckpointForFinalization } from '../phases/executionPhase'

const repoManager = createTestRepoManager('execution-phase-')

function makePendingBead(id: string, priority: number, extra: Partial<Bead> = {}): Bead {
  return {
    id,
    title: `Bead ${id}`,
    description: `Test bead ${id}`,
    status: 'pending',
    priority,
    prdRefs: [],
    acceptanceCriteria: [],
    tests: [],
    testCommands: [],
    contextGuidance: { patterns: [], anti_patterns: [] },
    issueType: 'task',
    externalRef: 'TEST-1',
    labels: [],
    dependencies: { blocked_by: [], blocks: [] },
    targetFiles: [],
    failedIterationNotes: [],
    userRetryNotes: [],
    finalizationFailureNotes: [],
    iteration: 1,
    createdAt: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '',
    startedAt: '',
    beadStartCommit: null,
    ...extra,
  }
}

function makeDoneBead(id: string, priority: number): Bead {
  return makePendingBead(id, priority, {
    status: 'done',
    completedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    iteration: 1,
  })
}

function makeNote(content: string, iteration = 1) {
  return { timestamp: '2026-01-01T00:00:00.000Z', iteration, content }
}

describe('handleCoding', () => {
  beforeEach(() => {
    resetTestDb()
    clearAllPendingSessionContinuationsForTests()
    phaseIntermediate.clear()
    executeBeadMock.mockReset()
    recordBeadStartCommitMock.mockReset()
    commitBeadChangesMock.mockReset()
    resetToBeadStartMock.mockReset()
    captureBeadDiffMock.mockReset()
    assembleBeadContextMock.mockReset()
    isMockOpenCodeModeMock.mockReset()
    broadcastMock.mockReset()
    abortSessionMock.mockReset()

    // Deterministic defaults
    isMockOpenCodeModeMock.mockReturnValue(false)
    recordBeadStartCommitMock.mockReturnValue('abc123')
    commitBeadChangesMock.mockReturnValue({ committed: true, pushed: false })
    captureBeadDiffMock.mockReturnValue({ ok: true, diff: 'diff --git a/file.ts b/file.ts' })
    assembleBeadContextMock.mockResolvedValue([])
    abortSessionMock.mockResolvedValue(true)
  })

  afterAll(() => {
    clearAllPendingSessionContinuationsForTests()
    resetTestDb()
    repoManager.cleanup()
  })

  it('sends ALL_BEADS_DONE immediately when all beads are already done', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'All beads done shortcut',
    })
    writeTicketBeads(ticket.id, [
      makeDoneBead('bead-1', 1),
      makeDoneBead('bead-2', 2),
    ])
    const sendEvent = vi.fn()

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })
    expect(executeBeadMock).not.toHaveBeenCalled()
  })

  it('fails closed on a malformed tracker without reporting completion or rewriting it', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Malformed tracker completion guard',
    })
    const original = '{"id":"bead-1","status":"done"}\nnot-json\n'
    writeFileSync(paths.beadsPath, original)
    const sendEvent = vi.fn()

    await expect(handleCoding(ticket.id, context, sendEvent, new AbortController().signal))
      .rejects.toThrow(/unparseable JSON at line\(s\) 2/)

    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })
    expect(readFileSync(paths.beadsPath, 'utf8')).toBe(original)
  })

  it('sends ERROR event and returns when mock mode is active', async () => {
    isMockOpenCodeModeMock.mockReturnValue(true)
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Mock mode unsupported',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const sendEvent = vi.fn()

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ERROR', codes: ['MOCK_EXECUTION_UNSUPPORTED'] }),
    )
    expect(executeBeadMock).not.toHaveBeenCalled()
  })

  it('sends BEAD_COMPLETE when one bead succeeds with more beads still pending', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Bead success with more pending',
    })
    writeTicketBeads(ticket.id, [
      makePendingBead('bead-1', 1),
      makePendingBead('bead-2', 2),
    ])
    const sendEvent = vi.fn()

    executeBeadMock.mockResolvedValueOnce({
      success: true,
      beadId: 'bead-1',
      iteration: 1,
      output: 'done',
      errors: [],
      rawAttempts: [
        {
          attempt: 1,
          iteration: 1,
          status: 'accepted',
          outcome: 'accepted',
          initialInput: 'raw bead prompt',
          rawResponse: 'done',
          modelOutput: 'done',
          modelId: 'model-a',
          sessionId: 'session-1',
        },
      ],
    })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith({ type: 'BEAD_COMPLETE' })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })

    // Verify the lowest-priority bead was executed first
    const executedBead = executeBeadMock.mock.calls[0]![1] as Bead
    expect(executedBead.id).toBe('bead-1')
  })

  it('passes OpenCode retry settings to execution and resets the attempt countdown start time', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-02-02T03:04:05.000Z'))
      const { ticket, context } = await createInitializedTestTicket(repoManager, {
        title: 'Attempt countdown reset',
      })
      writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1, {
        startedAt: '2026-01-01T00:00:00.000Z',
      })])
      const sendEvent = vi.fn()

      executeBeadMock.mockImplementationOnce(async (
        _adapter: unknown,
        _bead: unknown,
        _contextParts: unknown,
        _worktreePath: unknown,
        _maxIterations: unknown,
        _perIterationTimeoutMs: unknown,
        _signal: unknown,
        callbacks: {
          opencodeRetryPolicy?: { limit?: number; delayMs?: number }
          onSessionCreated?: (sessionId: string, iteration: number) => void
        },
      ) => {
        expect(callbacks.opencodeRetryPolicy).toEqual({ limit: 10, delayMs: 60_000 })
        callbacks.onSessionCreated?.('ses-retry-policy', 2)
        return {
          success: true,
          beadId: 'bead-1',
          iteration: 2,
          output: 'done',
          errors: [],
        }
      })

      await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

      const finalBead = readTicketBeads(ticket.id).find((bead) => bead.id === 'bead-1')
      expect(finalBead?.startedAt).toBe('2026-01-01T00:00:00.000Z')
      expect(finalBead?.iteration).toBe(2)
      expect(finalBead?.updatedAt).toBe('2026-02-02T03:04:05.000Z')
      expect(sendEvent).toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends ALL_BEADS_DONE when the last pending bead succeeds', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Last bead success',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const sendEvent = vi.fn()

    executeBeadMock.mockResolvedValueOnce({
      success: true,
      beadId: 'bead-1',
      iteration: 1,
      output: 'done',
      errors: [],
      rawAttempts: [
        {
          attempt: 1,
          iteration: 1,
          status: 'accepted',
          outcome: 'accepted',
          initialInput: 'raw bead prompt',
          rawResponse: 'done',
          modelOutput: 'done',
          modelId: 'model-a',
          sessionId: 'session-1',
        },
      ],
    })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'BEAD_COMPLETE' })

    const finalBeads = readTicketBeads(ticket.id)
    expect(finalBeads.find((b) => b.id === 'bead-1')?.status).toBe('done')
  })

  it('sends BEAD_ERROR and does not commit when executeBead fails', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Bead execution failure',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const sendEvent = vi.fn()

    executeBeadMock.mockResolvedValueOnce({
      success: false,
      beadId: 'bead-1',
      iteration: 2,
      output: '',
      errors: ['typecheck failed'],
    })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith({ type: 'BEAD_ERROR' })
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'BEAD_COMPLETE' }))
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ALL_BEADS_DONE' }))
    expect(commitBeadChangesMock).not.toHaveBeenCalled()
    expect(captureBeadDiffMock).not.toHaveBeenCalled()
    expect(broadcastMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'bead_complete',
      expect.anything(),
    )

    const finalBeads = readTicketBeads(ticket.id)
    expect(finalBeads.find((b) => b.id === 'bead-1')?.status).toBe('error')
  })

  it('propagates retry-budget exhaustion codes when a bead uses its per-bead window', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Bead retry budget exhaustion',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1, { iteration: 5 })])
    const sendEvent = vi.fn()

    executeBeadMock.mockResolvedValueOnce({
      success: false,
      beadId: 'bead-1',
      iteration: 10,
      output: '',
      errors: ['Reached the configured per-bead retry budget at iteration 10.'],
      errorCodes: [BEAD_RETRY_BUDGET_EXHAUSTED],
    })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'BEAD_ERROR',
      codes: [BEAD_RETRY_BUDGET_EXHAUSTED],
    })

    const finalBeads = readTicketBeads(ticket.id)
    const failedBead = finalBeads.find((b) => b.id === 'bead-1')
    expect(failedBead?.status).toBe('error')
    expect(failedBead?.iteration).toBe(10)
  })

  it('propagates underlying OpenCode diagnostics with bead failures', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Bead failure with OpenCode diagnostics',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const sendEvent = vi.fn()

    executeBeadMock.mockResolvedValueOnce({
      success: false,
      beadId: 'bead-1',
      iteration: 5,
      output: '',
      errors: ['Iteration 5: No completion marker found'],
      errorCodes: [BEAD_RETRY_BUDGET_EXHAUSTED, OPENCODE_PROVIDER_ERROR],
      diagnostics: {
        kind: 'opencode_provider',
        source: 'provider',
        summary: 'The usage limit has been reached',
        modelId: context.lockedMainImplementer ?? undefined,
        sessionId: 'ses-limit',
      },
    })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'BEAD_ERROR',
      codes: [BEAD_RETRY_BUDGET_EXHAUSTED, OPENCODE_PROVIDER_ERROR],
      diagnostics: expect.objectContaining({
        kind: 'opencode_provider',
        source: 'provider',
        summary: 'The usage limit has been reached',
        sessionId: 'ses-limit',
      }),
    })
  })

  it('lets continuable OpenCode retry errors bubble for the workflow ERROR path instead of BEAD_ERROR', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Continuable OpenCode retry error',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const sendEvent = vi.fn()
    const retryError = Object.assign(new Error('OpenCode retry budget exhausted after 10 retry event(s): The usage limit has been reached'), {
      blockedErrorDiagnostics: {
        kind: 'opencode_provider',
        source: 'provider',
        summary: 'The usage limit has been reached',
        sessionId: 'ses-limit',
        modelId: context.lockedMainImplementer ?? undefined,
        isRetryable: true,
      },
      blockedErrorCodes: ['OPENCODE_PROVIDER_ERROR'],
    })

    executeBeadMock.mockRejectedValueOnce(retryError)

    await expect(
      handleCoding(ticket.id, context, sendEvent, new AbortController().signal),
    ).rejects.toThrow('OpenCode retry budget exhausted')

    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'BEAD_ERROR' }))
    expect(commitBeadChangesMock).not.toHaveBeenCalled()
  })

  it('invokes resetToBeadStart and persists notes through the fresh-reload when onContextWipe fires', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Notes updated triggers reset',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const sendEvent = vi.fn()

    executeBeadMock.mockImplementationOnce(async (
      _adapter: unknown,
      _bead: unknown,
      _contextParts: unknown,
      _worktreePath: unknown,
      _maxIterations: unknown,
      _perIterationTimeoutMs: unknown,
      _signal: unknown,
      callbacks: {
        ticketId: string
        model: string
        onContextWipe: (entry: {
          beadId: string
          failedIterationNotes: Bead['failedIterationNotes']
          iteration: number
          reason: 'failure' | 'iteration_timeout'
          attempt: number
          nextAttempt: number
          maxAttempts: number | null
        }) => Promise<void>
      },
    ) => {
      // Simulate context wipe persistence before executeBead returns.
      await callbacks.onContextWipe({
        beadId: 'bead-1',
        failedIterationNotes: [makeNote('context wiped — retrying with notes')],
        iteration: 1,
        reason: 'failure',
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 5,
      })
      return {
        success: true,
        beadId: 'bead-1',
        iteration: 1,
        output: 'done',
        errors: [],
      }
    })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(resetToBeadStartMock).toHaveBeenCalledWith(
      expect.any(String),
      'abc123',
      expect.objectContaining({
        preservePaths: expect.arrayContaining(['.ticket']),
      }),
    )

    // The fresh-reload in handleCoding must not wipe callback-persisted notes.
    const finalBeads = readTicketBeads(ticket.id)
    const executedBead = finalBeads.find((b) => b.id === 'bead-1')
    expect(executedBead?.failedIterationNotes).toEqual([makeNote('context wiped — retrying with notes')])
    expect(executedBead?.status).toBe('done')
  })

  it('preserves retry notes and iteration when resetToBeadStart fails during context wipe', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Reset failure preserves retry metadata',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1, { iteration: 1 })])
    const sendEvent = vi.fn()

    resetToBeadStartMock.mockImplementation(() => {
      throw new Error('spawnSync git ENOBUFS')
    })

    executeBeadMock.mockImplementationOnce(async (
      _adapter: unknown,
      _bead: unknown,
      _contextParts: unknown,
      _worktreePath: unknown,
      _maxIterations: unknown,
      _perIterationTimeoutMs: unknown,
      _signal: unknown,
      callbacks: {
        onSessionCreated?: (sessionId: string, iteration: number) => void
        onContextWipe: (entry: {
          beadId: string
          failedIterationNotes: Bead['failedIterationNotes']
          iteration: number
          reason: 'failure' | 'iteration_timeout'
          attempt: number
          nextAttempt: number
          maxAttempts: number | null
        }) => Promise<void>
      },
    ) => {
      callbacks.onSessionCreated?.('session-1', 1)
      await expect(callbacks.onContextWipe({
        beadId: 'bead-1',
        failedIterationNotes: [makeNote('retry note after timeout')],
        iteration: 1,
        reason: 'failure',
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 5,
      })).rejects.toThrow('spawnSync git ENOBUFS')
      throw new Error('spawnSync git ENOBUFS')
    })

    await expect(
      handleCoding(ticket.id, context, sendEvent, new AbortController().signal),
    ).rejects.toThrow('spawnSync git ENOBUFS')

    const finalBeads = readTicketBeads(ticket.id)
    const executedBead = finalBeads.find((b) => b.id === 'bead-1')
    expect(executedBead?.status).toBe('error')
    expect(executedBead?.iteration).toBe(2)
    expect(executedBead?.failedIterationNotes).toEqual([makeNote('retry note after timeout')])

    // The reset that failed during the wipe is the same one the retry performs,
    // so let it succeed here: what this asserts is that the notes and iteration
    // the failed wipe left behind are what a retry picks up.
    resetToBeadStartMock.mockImplementation(() => {})
    const recoveredBead = await recoverCodingBeadWithReset(ticket.id, { worktreePath: paths.worktreePath })
    expect(recoveredBead?.id).toBe('bead-1')
    expect(recoveredBead?.status).toBe('pending')
    expect(recoveredBead?.iteration).toBe(2)
    expect(recoveredBead?.failedIterationNotes).toEqual([makeNote('retry note after timeout')])
  })

  // --- Throw paths ---

  it('throws when there are no beads', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'No beads throw',
    })
    // Beads file is empty (no writeTicketBeads call)
    const sendEvent = vi.fn()

    await expect(
      handleCoding(ticket.id, context, sendEvent, new AbortController().signal),
    ).rejects.toThrow('No beads available for execution')
    expect(executeBeadMock).not.toHaveBeenCalled()
  })

  it('throws when no runnable bead exists due to unresolved dependencies', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Blocked bead throw',
    })
    // bead-2 is blocked by bead-1 which is not done (not even present)
    writeTicketBeads(ticket.id, [
      makePendingBead('bead-2', 1, {
        dependencies: { blocked_by: ['bead-1'], blocks: [] },
      }),
    ])
    const sendEvent = vi.fn()

    await expect(
      handleCoding(ticket.id, context, sendEvent, new AbortController().signal),
    ).rejects.toThrow('No runnable bead found; unresolved dependencies remain')
    expect(executeBeadMock).not.toHaveBeenCalled()
  })

  /**
   * The third call site that sorts through `compareBeadRecoveryOrder`.
   *
   * Its other cases each offer one in-progress bead, which cannot tell a sort
   * from a first match — the same weakness the checkpoint cases had.
   */
  it('resumes the most recently touched interrupted bead when several are in progress', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Two interrupted beads',
    })
    writeTicketBeads(ticket.id, [
      makePendingBead('older', 1, {
        status: 'in_progress', updatedAt: '2026-01-01T00:00:00.000Z', beadStartCommit: 'older-sha',
      }),
      makePendingBead('newer', 2, {
        status: 'in_progress', updatedAt: '2026-01-02T00:00:00.000Z', beadStartCommit: 'newer-sha',
      }),
    ])
    const sendEvent = vi.fn()
    executeBeadMock.mockResolvedValue({ success: true, beadId: 'newer', iteration: 2, output: 'done', errors: [] })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    // The reset names the bead it resumed, so it is the unambiguous witness.
    expect(resetToBeadStartMock).toHaveBeenCalledWith(expect.any(String), 'newer-sha', expect.anything())
    expect((executeBeadMock.mock.calls[0]![1] as Bead).id).toBe('newer')
  })

  it('recovers an interrupted in-progress bead before selecting runnable work', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Recover interrupted in-progress bead',
    })
    writeTicketBeads(ticket.id, [
      makePendingBead('bead-1', 1, {
        status: 'in_progress',
        iteration: 2,
        failedIterationNotes: [makeNote('prior interrupted attempt')],
        beadStartCommit: 'start-sha',
      }),
    ])
    const ticketContext = getTicketContext(ticket.id)
    if (!ticketContext) throw new Error('Expected ticket context')
    ticketContext.projectDb.insert(opencodeSessions).values({
      sessionId: 'ses-interrupted',
      ticketId: ticketContext.localTicketId,
      phase: 'CODING',
      phaseAttempt: 1,
      beadId: 'bead-1',
      iteration: 2,
      state: 'active',
    }).run()
    ticketContext.projectDb.insert(opencodeSessions).values({
      sessionId: 'ses-other-iteration',
      ticketId: ticketContext.localTicketId,
      phase: 'CODING',
      phaseAttempt: 1,
      beadId: 'bead-1',
      iteration: 1,
      state: 'active',
    }).run()
    const sendEvent = vi.fn()

    executeBeadMock.mockResolvedValueOnce({
      success: true,
      beadId: 'bead-1',
      iteration: 3,
      output: 'done',
      errors: [],
    })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(resetToBeadStartMock).toHaveBeenCalledWith(
      expect.any(String),
      'start-sha',
      expect.objectContaining({
        preservePaths: expect.arrayContaining(['.ticket']),
      }),
    )
    const executedBead = executeBeadMock.mock.calls[0]![1] as Bead
    expect(executedBead.status).toBe('in_progress')
    expect(executedBead.iteration).toBe(3)
    expect(executedBead.updatedAt).not.toBe('2026-01-01T00:00:00.000Z')
    expect(executeBeadMock.mock.calls[0]![5]).toBe(20 * 60 * 1000)
    expect(executedBead.failedIterationNotes).toEqual([
      makeNote('prior interrupted attempt'),
      expect.objectContaining({
        iteration: 2,
        content: 'Iteration was interrupted before its OpenCode session could be resumed; restarted from the bead start snapshot.',
      }),
    ])
    expect(abortSessionMock).toHaveBeenCalledWith('ses-interrupted')
    expect(abortSessionMock).not.toHaveBeenCalledWith('ses-other-iteration')
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active']).map((session) => session.sessionId))
      .toEqual(['ses-other-iteration'])
    expect(listOpenCodeSessionsForTicket(ticket.id, ['abandoned']).map((session) => session.sessionId))
      .toEqual(['ses-interrupted'])
    expect(sendEvent).toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })
  })

  it('withholds interrupted-bead reset when the remote session stop is unconfirmed', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Do not reset while interrupted session may still run',
    })
    writeTicketBeads(ticket.id, [
      makePendingBead('bead-1', 1, {
        status: 'in_progress',
        iteration: 2,
        beadStartCommit: 'start-sha',
      }),
    ])
    const ticketContext = getTicketContext(ticket.id)
    if (!ticketContext) throw new Error('Expected ticket context')
    ticketContext.projectDb.insert(opencodeSessions).values({
      sessionId: 'ses-unconfirmed-stop',
      ticketId: ticketContext.localTicketId,
      phase: 'CODING',
      phaseAttempt: 1,
      beadId: 'bead-1',
      iteration: 2,
      state: 'active',
    }).run()
    abortSessionMock.mockResolvedValue(false)
    const sendEvent = vi.fn()

    await expect(handleCoding(ticket.id, context, sendEvent, new AbortController().signal))
      .rejects.toThrow(/Could not safely recover bead bead-1/)

    expect(resetToBeadStartMock).not.toHaveBeenCalled()
    expect(executeBeadMock).not.toHaveBeenCalled()
    expect(listOpenCodeSessionsForTicket(ticket.id, ['active']).map((session) => session.sessionId))
      .toEqual(['ses-unconfirmed-stop'])
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })
  })

  it('continues an interrupted in-progress bead without resetting when a session continuation is pending', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Continue interrupted in-progress bead',
    })
    writeTicketBeads(ticket.id, [
      makePendingBead('bead-1', 1, {
        status: 'in_progress',
        iteration: 2,
        failedIterationNotes: [makeNote('prior interrupted attempt')],
        beadStartCommit: 'start-sha',
      }),
    ])
    requestSessionContinuation({
      ticketId: ticket.id,
      phase: 'CODING',
      sessionId: 'ses-continue',
    })
    executeBeadMock.mockResolvedValueOnce({
      success: true,
      beadId: 'bead-1',
      iteration: 2,
      output: 'done',
      errors: [],
    })
    const sendEvent = vi.fn()

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(resetToBeadStartMock).not.toHaveBeenCalled()
    expect(recordBeadStartCommitMock).not.toHaveBeenCalled()
    const executedBead = executeBeadMock.mock.calls[0]![1] as Bead
    expect(executedBead).toMatchObject({
      id: 'bead-1',
      status: 'in_progress',
      iteration: 2,
      failedIterationNotes: [makeNote('prior interrupted attempt')],
      beadStartCommit: 'start-sha',
    })
    expect(sendEvent).toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })
  })

  it('finalizes a current persisted execution checkpoint without re-executing the bead', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Finalize matching execution checkpoint',
    })
    const interruptedBead = makePendingBead('bead-1', 1, {
      status: 'in_progress',
      iteration: 2,
      startedAt: '2026-01-01T00:01:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
      beadStartCommit: 'start-sha',
    })
    writeTicketBeads(ticket.id, [interruptedBead])
    upsertLatestPhaseArtifact(ticket.id, 'bead_execution:bead-1', 'CODING', JSON.stringify({
      success: true,
      beadId: 'bead-1',
      iteration: 2,
      output: 'checkpointed done',
      errors: [],
      checkpoint: {
        beadId: interruptedBead.id,
        iteration: interruptedBead.iteration,
        startedAt: interruptedBead.startedAt,
        updatedAt: interruptedBead.updatedAt,
        beadStartCommit: interruptedBead.beadStartCommit,
      },
    }))
    const sendEvent = vi.fn()

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(executeBeadMock).not.toHaveBeenCalled()
    expect(resetToBeadStartMock).not.toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })
    expect(readTicketBeads(ticket.id).find((bead) => bead.id === 'bead-1')?.status).toBe('done')
  })

  it('does not reuse a stale persisted execution checkpoint after retry/reset changes bead state', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Ignore stale execution checkpoint',
    })
    const interruptedBead = makePendingBead('bead-1', 1, {
      status: 'in_progress',
      iteration: 2,
      startedAt: '2026-01-01T00:01:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
      beadStartCommit: 'start-sha',
    })
    writeTicketBeads(ticket.id, [interruptedBead])
    upsertLatestPhaseArtifact(ticket.id, 'bead_execution:bead-1', 'CODING', JSON.stringify({
      success: true,
      beadId: 'bead-1',
      iteration: 2,
      output: 'stale done',
      errors: [],
      checkpoint: {
        beadId: interruptedBead.id,
        iteration: interruptedBead.iteration,
        startedAt: interruptedBead.startedAt,
        updatedAt: '2026-01-01T00:00:00.000Z',
        beadStartCommit: interruptedBead.beadStartCommit,
      },
    }))
    executeBeadMock.mockResolvedValueOnce({
      success: true,
      beadId: 'bead-1',
      iteration: 3,
      output: 'fresh done',
      errors: [],
    })
    const sendEvent = vi.fn()

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(resetToBeadStartMock).toHaveBeenCalledWith(
      expect.any(String),
      'start-sha',
      expect.objectContaining({
        preservePaths: expect.arrayContaining(['.ticket']),
      }),
    )
    expect(executeBeadMock).toHaveBeenCalledTimes(1)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })

    const execArtifact = getLatestPhaseArtifact(ticket.id, 'bead_execution:bead-1', 'CODING')
    const payload = JSON.parse(execArtifact!.content) as {
      output?: string
      checkpoint?: { updatedAt?: string; beadStartCommit?: string | null }
    }
    expect(payload.output).toBe('fresh done')
    expect(payload.checkpoint?.beadStartCommit).toBe('abc123')
    expect(payload.checkpoint?.updatedAt).not.toBe('2026-01-01T00:00:00.000Z')
    expect(readTicketBeads(ticket.id).find((bead) => bead.id === 'bead-1')).toMatchObject({
      iteration: 3,
      failedIterationNotes: [
        expect.objectContaining({
          iteration: 2,
          content: 'Iteration was interrupted before its OpenCode session could be resumed; restarted from the bead start snapshot.',
        }),
      ],
    })
  })

  it('blocks interrupted coding recovery when no bead start commit exists', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Interrupted bead without reset anchor',
    })
    writeTicketBeads(ticket.id, [
      makePendingBead('bead-1', 1, {
        status: 'in_progress',
        beadStartCommit: null,
      }),
    ])
    const sendEvent = vi.fn()

    await expect(
      handleCoding(ticket.id, context, sendEvent, new AbortController().signal),
    ).rejects.toThrow('missing bead start commit')

    expect(executeBeadMock).not.toHaveBeenCalled()
  })

  it('recovers a pending bead whose checkpoint failed before it started', async () => {
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Pending bead checkpoint retry',
    })
    writeTicketBeads(ticket.id, [
      makePendingBead('bead-1', 1),
    ])

    const recovered = await recoverCodingBeadWithReset(ticket.id, {
      worktreePath: paths.worktreePath,
      requireReset: true,
      userRetryNote: 'Retry after recording the checkpoint.',
    })

    expect(recovered).toMatchObject({
      id: 'bead-1',
      status: 'pending',
      beadStartCommit: null,
      userRetryNotes: [expect.objectContaining({
        content: 'Retry after recording the checkpoint.',
      })],
    })
    expect(resetToBeadStartMock).not.toHaveBeenCalled()
  })

  it('resets a pending bead when its start checkpoint landed before the status update', async () => {
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Pending bead with checkpoint anchor',
    })
    writeTicketBeads(ticket.id, [
      makePendingBead('bead-1', 1, {
        startedAt: '2026-01-01T00:00:00.000Z',
        beadStartCommit: 'start-sha',
      }),
    ])

    const recovered = await recoverCodingBeadWithReset(ticket.id, {
      worktreePath: paths.worktreePath,
      requireReset: true,
    })

    expect(resetToBeadStartMock).toHaveBeenCalledWith(
      paths.worktreePath,
      'start-sha',
      expect.objectContaining({ preservePaths: expect.arrayContaining(['.ticket']) }),
    )
    expect(recovered).toMatchObject({
      id: 'bead-1',
      status: 'pending',
      startedAt: '2026-01-01T00:00:00.000Z',
      beadStartCommit: 'start-sha',
    })
  })

  it('throws when lockedMainImplementer is missing', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager, {
      title: 'Missing implementer throw',
    })
    const context = makeTicketContextFromTicket(ticket, { lockedMainImplementer: null })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const sendEvent = vi.fn()

    await expect(
      handleCoding(ticket.id, context, sendEvent, new AbortController().signal),
    ).rejects.toThrow('No locked main implementer is configured for coding')
    expect(executeBeadMock).not.toHaveBeenCalled()
  })

  // --- Artifact assertions ---

  it('inserts bead_execution artifact on success and bead_diff when beadStartCommit is available', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Success artifacts',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const sendEvent = vi.fn()

    executeBeadMock.mockResolvedValueOnce({
      success: true,
      beadId: 'bead-1',
      iteration: 1,
      output: 'done',
      errors: [],
      rawAttempts: [
        {
          attempt: 1,
          iteration: 1,
          status: 'accepted',
          outcome: 'accepted',
          initialInput: 'raw bead prompt',
          rawResponse: 'done',
          modelOutput: 'done',
          modelId: 'model-a',
          sessionId: 'session-1',
        },
      ],
    })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    const execArtifact = getLatestPhaseArtifact(ticket.id, 'bead_execution:bead-1', 'CODING')
    expect(execArtifact).toBeDefined()
    const execPayload = JSON.parse(execArtifact!.content) as {
      success: boolean
      beadId: string
      rawAttempts?: unknown[]
      checkpoint?: { beadId?: string; beadStartCommit?: string | null }
    }
    expect(execPayload.success).toBe(true)
    expect(execPayload.beadId).toBe('bead-1')
    expect(execPayload.rawAttempts).toEqual([
      {
        attempt: 1,
        iteration: 1,
        status: 'accepted',
        outcome: 'accepted',
        initialInput: 'raw bead prompt',
        rawResponse: 'done',
        modelOutput: 'done',
        modelId: 'model-a',
        sessionId: 'session-1',
      },
    ])
    expect(execPayload.checkpoint).toMatchObject({
      beadId: 'bead-1',
      beadStartCommit: 'abc123',
    })

    const diffArtifact = getLatestPhaseArtifact(ticket.id, 'bead_diff:bead-1', 'CODING')
    expect(diffArtifact).toBeDefined()
    expect(diffArtifact!.content).toBe('diff --git a/file.ts b/file.ts')
  })

  it('inserts bead_execution artifact on failure but does not insert bead_diff', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Failure artifacts',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const sendEvent = vi.fn()

    executeBeadMock.mockResolvedValueOnce({
      success: false,
      beadId: 'bead-1',
      iteration: 1,
      output: '',
      errors: ['lint failed'],
      rawAttempts: [
        {
          attempt: 1,
          iteration: 1,
          status: 'failed',
          outcome: 'failed',
          initialInput: 'raw bead prompt',
          error: 'lint failed',
        },
      ],
    })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    const execArtifact = getLatestPhaseArtifact(ticket.id, 'bead_execution:bead-1', 'CODING')
    expect(execArtifact).toBeDefined()
    const execPayload = JSON.parse(execArtifact!.content) as {
      success: boolean
      rawAttempts?: unknown[]
      checkpoint?: { beadId?: string; beadStartCommit?: string | null }
    }
    expect(execPayload.success).toBe(false)
    expect(execPayload.rawAttempts).toEqual([
      {
        attempt: 1,
        iteration: 1,
        status: 'failed',
        outcome: 'failed',
        initialInput: 'raw bead prompt',
        error: 'lint failed',
      },
    ])
    expect(execPayload.checkpoint).toMatchObject({
      beadId: 'bead-1',
      beadStartCommit: 'abc123',
    })

    const diffArtifact = getLatestPhaseArtifact(ticket.id, 'bead_diff:bead-1', 'CODING')
    expect(diffArtifact).toBeUndefined()
  })

  // --- recordBeadStartCommit failure branch ---

  it('leaves a bead pending when recordBeadStartCommit throws so retry can start it', async () => {
    recordBeadStartCommitMock.mockImplementation(() => {
      throw new Error('git rev-parse failed')
    })
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'recordBeadStartCommit throws',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const sendEvent = vi.fn()

    executeBeadMock.mockResolvedValueOnce({
      success: true,
      beadId: 'bead-1',
      iteration: 1,
      output: 'done',
      errors: [],
    })

    await expect(handleCoding(ticket.id, context, sendEvent, new AbortController().signal))
      .rejects.toThrow(/Could not record bead start commit for bead-1/)

    expect(readTicketBeads(ticket.id).find((bead) => bead.id === 'bead-1')).toMatchObject({
      status: 'pending',
      beadStartCommit: null,
    })
    expect(executeBeadMock).not.toHaveBeenCalled()
    expect(sendEvent).not.toHaveBeenCalled()

    recordBeadStartCommitMock.mockReturnValueOnce('retry-sha')
    executeBeadMock.mockResolvedValueOnce({
      success: true,
      beadId: 'bead-1',
      iteration: 1,
      output: 'done',
      errors: [],
    })
    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(executeBeadMock).toHaveBeenCalledTimes(1)
    expect(readTicketBeads(ticket.id).find((bead) => bead.id === 'bead-1')).toMatchObject({
      status: 'done',
      beadStartCommit: 'retry-sha',
    })
  })

  it('does not publish a new bead as active if canceled while reading its checkpoint', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, { title: 'Canceled checkpoint' })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const controller = new AbortController()
    recordBeadStartCommitMock.mockImplementationOnce(() => {
      controller.abort()
      return 'abc123'
    })

    await expect(handleCoding(ticket.id, context, vi.fn(), controller.signal)).rejects.toThrow()
    expect(readTicketBeads(ticket.id)[0]).toMatchObject({ status: 'pending', beadStartCommit: null, startedAt: '' })
    expect(executeBeadMock).not.toHaveBeenCalled()
  })

  // --- Git error recovery ---

  it('keeps the bead retryable and blocks progress when finalization throws', async () => {
    commitBeadChangesMock.mockImplementation(() => {
      throw new Error('\u001b[31mgit commit failed\u001b[0m')
    })
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'commitBeadChanges throws',
    })
    const existingFinalizationNote = { ...makeNote('Earlier finalization failure'), errorCode: 'BEAD_FINALIZATION_FAILED' }
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1, {
      finalizationFailureNotes: [existingFinalizationNote],
    })])
    const sendEvent = vi.fn()

    executeBeadMock.mockResolvedValueOnce({
      success: true,
      beadId: 'bead-1',
      iteration: 1,
      output: 'done',
      errors: [],
    })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'BEAD_ERROR',
      codes: ['BEAD_FINALIZATION_FAILED'],
    }))
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'BEAD_COMPLETE' })
    expect(broadcastMock).not.toHaveBeenCalledWith(expect.anything(), 'bead_complete', expect.anything())
    expect(captureBeadDiffMock).not.toHaveBeenCalled()
    const finalBeads = readTicketBeads(ticket.id)
    const failedBead = finalBeads.find((b) => b.id === 'bead-1')
    expect(failedBead?.status).toBe('error')
    expect(failedBead?.finalizationFailureNotes).toEqual([
      existingFinalizationNote,
      expect.objectContaining({
        iteration: 1,
        content: expect.stringContaining('Finalization failed after successful implementation: git commit failed'),
        errorCode: 'BEAD_FINALIZATION_FAILED',
      }),
    ])
    expect(failedBead?.finalizationFailureNotes[1]?.content).not.toContain('\u001b[')
  })

  it('keeps the bead retryable and blocks progress when local commit returns an error', async () => {
    commitBeadChangesMock.mockReturnValue({ committed: false, pushed: false, error: 'git add failed: permission denied' })
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'commitBeadChanges returns error',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const sendEvent = vi.fn()

    executeBeadMock.mockResolvedValueOnce({
      success: true,
      beadId: 'bead-1',
      iteration: 1,
      output: 'done',
      errors: [],
    })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'BEAD_ERROR',
      codes: ['BEAD_FINALIZATION_FAILED'],
    }))
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })
    expect(broadcastMock).not.toHaveBeenCalledWith(expect.anything(), 'bead_complete', expect.anything())
    expect(readTicketBeads(ticket.id).find((b) => b.id === 'bead-1')?.status).toBe('error')
  })

  it('marks the bead done when finalization is a true no-op', async () => {
    commitBeadChangesMock.mockReturnValue({ committed: false, pushed: false })
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'No-op finalization',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const sendEvent = vi.fn()

    executeBeadMock.mockResolvedValueOnce({
      success: true,
      beadId: 'bead-1',
      iteration: 1,
      output: 'done',
      errors: [],
    })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })
    expect(readTicketBeads(ticket.id).find((b) => b.id === 'bead-1')?.status).toBe('done')
  })

  it('treats push failure as a warning after successful local commit', async () => {
    commitBeadChangesMock.mockReturnValue({ committed: true, pushed: false, error: 'remote rejected push' })
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Push warning finalization',
    })
    writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
    const sendEvent = vi.fn()

    executeBeadMock.mockResolvedValueOnce({
      success: true,
      beadId: 'bead-1',
      iteration: 1,
      output: 'done',
      errors: [],
    })

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'BEAD_ERROR' }))
    expect(readTicketBeads(ticket.id).find((b) => b.id === 'bead-1')?.status).toBe('done')
  })

  it('re-finalizes a successful execution checkpoint after a finalization retry without resetting work', async () => {
    commitBeadChangesMock.mockReturnValue({ committed: false, pushed: false })
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Re-finalize checkpoint',
    })
    const failedFinalizationBead = makePendingBead('bead-1', 1, {
      status: 'error',
      startedAt: '2026-01-01T00:01:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
      beadStartCommit: 'start-sha',
    })
    writeTicketBeads(ticket.id, [failedFinalizationBead])
    upsertLatestPhaseArtifact(ticket.id, 'bead_execution:bead-1', 'CODING', JSON.stringify({
      success: true,
      beadId: 'bead-1',
      iteration: 1,
      output: 'checkpointed success',
      errors: [],
      checkpoint: {
        beadId: failedFinalizationBead.id,
        iteration: failedFinalizationBead.iteration,
        startedAt: failedFinalizationBead.startedAt,
        updatedAt: failedFinalizationBead.updatedAt,
        beadStartCommit: failedFinalizationBead.beadStartCommit,
      },
    }))
    const sendEvent = vi.fn()

    const recovered = recoverSuccessfulExecutionCheckpointForFinalization(ticket.id)
    expect(recovered?.status).toBe('in_progress')

    await handleCoding(ticket.id, context, sendEvent, new AbortController().signal)

    expect(executeBeadMock).not.toHaveBeenCalled()
    expect(resetToBeadStartMock).not.toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith({ type: 'ALL_BEADS_DONE' })
    expect(readTicketBeads(ticket.id).find((b) => b.id === 'bead-1')?.status).toBe('done')
  })

  /**
   * The checkpoint recovery sorts through the same comparator, and its existing
   * cases each offer one candidate — which cannot tell an ordering from a
   * first-match. Two checkpoints, and the newer one has to win.
   */
  it('re-finalizes the most recent checkpoint when more than one is recoverable', async () => {
    commitBeadChangesMock.mockReturnValue({ committed: false, pushed: false })
    const { ticket } = await createInitializedTestTicket(repoManager, {
      title: 'Two recoverable checkpoints',
    })
    const beads = [
      makePendingBead('older', 1, {
        status: 'error', startedAt: '2026-01-01T00:01:00.000Z', updatedAt: '2026-01-01T00:02:00.000Z', beadStartCommit: 'a',
      }),
      makePendingBead('newer', 2, {
        status: 'error', startedAt: '2026-01-02T00:01:00.000Z', updatedAt: '2026-01-02T00:02:00.000Z', beadStartCommit: 'b',
      }),
    ]
    writeTicketBeads(ticket.id, beads)
    for (const bead of beads) {
      upsertLatestPhaseArtifact(ticket.id, `bead_execution:${bead.id}`, 'CODING', JSON.stringify({
        success: true,
        beadId: bead.id,
        iteration: bead.iteration,
        output: 'checkpointed success',
        errors: [],
        checkpoint: {
          beadId: bead.id,
          iteration: bead.iteration,
          startedAt: bead.startedAt,
          updatedAt: bead.updatedAt,
          beadStartCommit: bead.beadStartCommit,
        },
      }))
    }

    expect(recoverSuccessfulExecutionCheckpointForFinalization(ticket.id)?.id).toBe('newer')
  })

  it('requeues the latest failed bead for retry without clearing notes or iteration', async () => {
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Retry failed coding bead',
    })
    writeTicketBeads(ticket.id, [
      makePendingBead('bead-1', 1, {
        status: 'error',
        iteration: 2,
        failedIterationNotes: [makeNote('retry guidance', 2)],
        beadStartCommit: 'abc123',
      }),
      makePendingBead('bead-2', 2, {
        dependencies: { blocked_by: ['bead-1'], blocks: [] },
      }),
    ])

    const recoveredBead = await recoverCodingBeadWithReset(ticket.id, { worktreePath: paths.worktreePath })

    expect(recoveredBead?.id).toBe('bead-1')
    expect(recoveredBead?.status).toBe('pending')
    expect(recoveredBead?.iteration).toBe(2)
    expect(recoveredBead?.failedIterationNotes).toEqual([makeNote('retry guidance', 2)])
    expect(recoveredBead?.beadStartCommit).toBe('abc123')
  })

  it('appends a verbatim user retry note to the exact recovered bead', async () => {
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Retry failed coding bead with user guidance',
    })
    writeTicketBeads(ticket.id, [
      makePendingBead('bead-1', 1, {
        status: 'error',
        iteration: 2,
        failedIterationNotes: [makeNote('Existing iteration note', 2)],
        beadStartCommit: 'abc123',
      }),
      makePendingBead('bead-2', 2, {
        status: 'pending',
        failedIterationNotes: [makeNote('Unrelated bead note')],
      }),
    ])

    const userRetryNote = '\u001b[35mKeep this line exactly.\u001b[0m\n  Preserve this indentation.  '
    const recoveredBead = await recoverCodingBeadWithReset(ticket.id, {
      worktreePath: paths.worktreePath,
      requireReset: true,
      userRetryNote,
    })

    expect(recoveredBead?.id).toBe('bead-1')
    expect(recoveredBead?.status).toBe('pending')
    expect(recoveredBead?.failedIterationNotes).toEqual([makeNote('Existing iteration note', 2)])
    expect(recoveredBead?.userRetryNotes).toEqual([
      expect.objectContaining({ iteration: 2, content: userRetryNote }),
    ])
    expect(readTicketBeads(ticket.id).find((bead) => bead.id === 'bead-2')?.failedIterationNotes)
      .toEqual([makeNote('Unrelated bead note')])
    expect(getTicketByRef(ticket.id)?.runtime.beads?.find((bead) => bead.id === 'bead-1')?.userRetryNotes)
      .toEqual(recoveredBead?.userRetryNotes)
  })

  it('does not mutate bead state or notes when the required reset fails', async () => {
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Unsafe retry reset',
    })
    const originalBead = makePendingBead('bead-1', 1, {
      status: 'error',
      failedIterationNotes: [makeNote('Existing note only')],
      beadStartCommit: 'abc123',
    })
    writeTicketBeads(ticket.id, [originalBead])
    resetToBeadStartMock.mockImplementationOnce(() => {
      throw new Error('reset failed')
    })

    await expect(recoverCodingBeadWithReset(ticket.id, {
      worktreePath: paths.worktreePath,
      requireReset: true,
      userRetryNote: 'This must not be appended',
    })).rejects.toThrow('reset failed')

    expect(readTicketBeads(ticket.id)).toEqual([originalBead])
  })

  it('requeues the latest in-progress bead when coding blocked before status flipped to error', async () => {
    const { ticket, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Retry blocked in-progress coding bead',
    })
    writeTicketBeads(ticket.id, [
      makePendingBead('bead-1', 1, {
        status: 'in_progress',
        iteration: 2,
        failedIterationNotes: [makeNote('retry guidance', 2)],
        beadStartCommit: 'abc123',
      }),
    ])

    const recoveredBead = await recoverCodingBeadWithReset(ticket.id, { worktreePath: paths.worktreePath })

    expect(recoveredBead?.id).toBe('bead-1')
    expect(recoveredBead?.status).toBe('pending')
    expect(recoveredBead?.iteration).toBe(2)
    expect(recoveredBead?.failedIterationNotes).toEqual([makeNote('retry guidance', 2)])
    expect(recoveredBead?.beadStartCommit).toBe('abc123')
  })

  /**
   * Which failed bead a retry picks up.
   *
   * The order itself is `compareBeadRecoveryOrder`, with its own table in
   * `server/phases/beads/__tests__/recoveryOrder.test.ts`. What is left here is
   * the call site: which beads are candidates at all, and that the recovery
   * sorts through that comparator rather than taking the first row in the file.
   */
  describe('failed bead recovery order', () => {
    /** A bead a retry could pick up, dated so the order is unambiguous. */
    function candidate(id: string, status: Bead['status'], updatedAt: string, extra: Partial<Bead> = {}): Bead {
      return makePendingBead(id, 1, { status, updatedAt, beadStartCommit: 'abc123', ...extra })
    }

    async function recoverFrom(title: string, beads: Bead[], options: { onlyInProgress?: boolean } = {}) {
      const { ticket, paths } = await createInitializedTestTicket(repoManager, { title })
      writeTicketBeads(ticket.id, beads)
      return recoverCodingBeadWithReset(ticket.id, { worktreePath: paths.worktreePath, ...options })
    }

    it('recovers nothing when no bead failed', async () => {
      expect(await recoverFrom('No failed bead', [
        candidate('done', 'done', '2026-01-02T00:00:00.000Z'),
        makePendingBead('pending', 2),
      ])).toBeNull()
    })

    it('recovers nothing from an empty tracker', async () => {
      expect(await recoverFrom('Empty tracker', [])).toBeNull()
    })

    it('sorts the candidates rather than taking the first in the file', async () => {
      const recovered = await recoverFrom('Latest failure wins', [
        candidate('older', 'error', '2026-01-01T00:00:00.000Z'),
        candidate('newer', 'error', '2026-01-02T00:00:00.000Z'),
      ])

      expect(recovered?.id).toBe('newer')
    })

    it('considers in-progress beads alongside failed ones by default', async () => {
      // Recency decides, not the status: an in-progress bead the run abandoned
      // more recently than an older failure is the one to resume.
      const recovered = await recoverFrom('In-progress considered', [
        candidate('errored', 'error', '2026-01-01T00:00:00.000Z'),
        candidate('running', 'in_progress', '2026-01-02T00:00:00.000Z'),
      ])

      expect(recovered?.id).toBe('running')
    })

    it('recovers only in-progress beads when asked to', async () => {
      const recovered = await recoverFrom('Only in progress', [
        candidate('errored', 'error', '2026-01-02T00:00:00.000Z'),
        candidate('running', 'in_progress', '2026-01-01T00:00:00.000Z'),
      ], { onlyInProgress: true })

      expect(recovered?.id).toBe('running')
    })
  })

  describe('the OpenCode step cap', () => {
    function setStepCap(steps: number) {
      appDatabase.insert(profiles).values({
        mainImplementer: 'openai/gpt-5.4',
        councilMembers: '["openai/gpt-5.4"]',
        opencodeSteps: steps,
      }).run()
    }

    function succeedOnce(beadId: string) {
      executeBeadMock.mockResolvedValueOnce({
        success: true,
        beadId,
        iteration: 1,
        output: 'done',
        errors: [],
        rawAttempts: [],
      })
    }

    it('merges the cap into a project configuration and puts the original back', async () => {
      setStepCap(25)
      const { ticket, context } = await createInitializedTestTicket(repoManager, { title: 'Step cap merge' })
      const paths = getTicketPaths(ticket.id)!
      const configPath = join(paths.worktreePath, 'opencode.json')
      const original = `${JSON.stringify({ mcp: { docs: { type: 'local' } } }, null, 2)}\n`
      writeFileSync(configPath, original, 'utf8')
      writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])

      // The cap has to be in force while the model runs, not merely restored after.
      let duringRun: string | undefined
      executeBeadMock.mockImplementationOnce(async () => {
        duringRun = readFileSync(configPath, 'utf8')
        return { success: true, beadId: 'bead-1', iteration: 1, output: 'done', errors: [], rawAttempts: [] }
      })

      await handleCoding(ticket.id, context, vi.fn(), new AbortController().signal)

      expect(JSON.parse(duringRun ?? '{}')).toEqual({ mcp: { docs: { type: 'local' } }, agent: { build: { steps: 25 } } })
      expect(readFileSync(configPath, 'utf8')).toBe(original)
    })

    /**
     * Restoring the worktree afterwards cannot undo a commit, so the run's own
     * modification has to be kept out of the bead commit in the first place.
     */
    it('keeps the capped configuration out of the bead commit', async () => {
      setStepCap(25)
      const { ticket, context } = await createInitializedTestTicket(repoManager, { title: 'Step cap commit' })
      const paths = getTicketPaths(ticket.id)!
      writeFileSync(join(paths.worktreePath, 'opencode.json'), '{"mcp": {}}\n', 'utf8')
      writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
      succeedOnce('bead-1')

      await handleCoding(ticket.id, context, vi.fn(), new AbortController().signal)

      expect(commitBeadChangesMock).toHaveBeenCalledWith(
        paths.worktreePath,
        'bead-1',
        expect.any(String),
        { excludePaths: ['opencode.json'] },
      )
    })

    it('keeps a conflicted restore sidecar excluded for the next bead', async () => {
      setStepCap(25)
      const { ticket, context } = await createInitializedTestTicket(repoManager, { title: 'Step cap conflict recovery' })
      const paths = getTicketPaths(ticket.id)!
      const configPath = join(paths.worktreePath, 'opencode.json')
      // No project config exists before this run: the cap creates it, so this
      // exercises the ownership marker's originalType:'absent' path.
      writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1), makePendingBead('bead-2', 2)])

      executeBeadMock.mockImplementationOnce(async () => {
        writeFileSync(configPath, '{"mcp": {}, "modelEdit": true}\n', 'utf8')
        return { success: true, beadId: 'bead-1', iteration: 1, output: 'done', errors: [], rawAttempts: [] }
      })

      await handleCoding(ticket.id, context, vi.fn(), new AbortController().signal)

      expect(existsSync(join(paths.ticketDir, 'opencode-steps-restore.json'))).toBe(true)
      succeedOnce('bead-2')
      await handleCoding(ticket.id, context, vi.fn(), new AbortController().signal)

      expect(commitBeadChangesMock).toHaveBeenNthCalledWith(
        1,
        paths.worktreePath,
        'bead-1',
        expect.any(String),
        { excludePaths: ['opencode.json'] },
      )
      expect(commitBeadChangesMock).toHaveBeenNthCalledWith(
        2,
        paths.worktreePath,
        'bead-2',
        expect.any(String),
        { excludePaths: ['opencode.json'] },
      )
      expect(readFileSync(configPath, 'utf8')).toContain('modelEdit')
      expect(existsSync(join(paths.ticketDir, 'opencode-steps-restore.json'))).toBe(true)
    })

    it.each([
      ['tracked', true],
      ['untracked', false],
    ] as const)('refuses interrupted %s config recovery without deleting the edit', async (_label, tracked) => {
      setStepCap(25)
      const { ticket, context } = await createInitializedTestTicket(repoManager, { title: `Step cap ${_label} reset guard` })
      const paths = getTicketPaths(ticket.id)!
      const configPath = join(paths.worktreePath, 'opencode.json')
      if (tracked) {
        const original = '{"mcp": {}}\n'
        writeFileSync(configPath, original, 'utf8')
        execFileSync('git', ['-C', paths.worktreePath, 'add', 'opencode.json'], { stdio: 'pipe' })
        execFileSync('git', ['-C', paths.worktreePath, 'commit', '-m', 'track OpenCode config'], { stdio: 'pipe' })
      }
      const applied = applyOpencodeStepsConfig({
        ticketDir: paths.ticketDir,
        worktreePath: paths.worktreePath,
        steps: 25,
        protocol: 'v1',
      })
      if (!applied.applied) throw new Error('expected the step cap to apply')
      writeFileSync(configPath, '{"mcp": {}, "edited": true}\n', 'utf8')
      expect(restoreOpencodeStepsConfig(applied.handle)).toBe('conflict')
      writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1, {
        status: 'in_progress',
        beadStartCommit: 'start-sha',
      })])
      resetToBeadStartMock.mockImplementationOnce((_worktreePath: string, _beadStartCommit: string, options: { preservePaths?: string[] }) => {
        expect(options.preservePaths).toContain('/opencode.json')
        throw new Error('Cannot reset while an OpenCode steps configuration restore is unresolved')
      })

      await expect(handleCoding(ticket.id, context, vi.fn(), new AbortController().signal))
        .rejects.toThrow(/restore is unresolved/)

      expect(readFileSync(configPath, 'utf8')).toContain('"edited": true')
      expect(existsSync(join(paths.ticketDir, 'opencode-steps-restore.json'))).toBe(true)
      expect(readTicketBeads(ticket.id).find((bead) => bead.id === 'bead-1')).toMatchObject({
        status: 'in_progress',
        beadStartCommit: 'start-sha',
      })
      expect(executeBeadMock).not.toHaveBeenCalled()
    })

    it('does not touch opencode.json at all when no cap is set', async () => {
      setStepCap(0)
      const { ticket, context } = await createInitializedTestTicket(repoManager, { title: 'No step cap' })
      const paths = getTicketPaths(ticket.id)!
      const configPath = join(paths.worktreePath, 'opencode.json')
      writeFileSync(configPath, '{"mcp": {}}\n', 'utf8')
      writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
      succeedOnce('bead-1')

      await handleCoding(ticket.id, context, vi.fn(), new AbortController().signal)

      expect(readFileSync(configPath, 'utf8')).toBe('{"mcp": {}}\n')
      expect(existsSync(join(paths.ticketDir, 'opencode-steps-restore.json'))).toBe(false)
      expect(commitBeadChangesMock).toHaveBeenCalledWith(
        paths.worktreePath,
        'bead-1',
        expect.any(String),
        { excludePaths: [] },
      )
    })

    /**
     * Recovering an interrupted bead resets the worktree, which takes a tracked
     * `opencode.json` back to its committed state — cap and all. Without putting
     * the cap back the run continues uncapped, and nothing says so.
     */
    it('puts the cap back after the reset that recovers an interrupted bead', async () => {
      setStepCap(25)
      const { ticket, context } = await createInitializedTestTicket(repoManager, { title: 'Step cap after recovery' })
      const paths = getTicketPaths(ticket.id)!
      const configPath = join(paths.worktreePath, 'opencode.json')
      const original = `${JSON.stringify({ mcp: { docs: { type: 'local' } } }, null, 2)}\n`
      writeFileSync(configPath, original, 'utf8')
      writeTicketBeads(ticket.id, [
        makePendingBead('bead-1', 1, { status: 'in_progress', iteration: 2, beadStartCommit: 'start-sha' }),
      ])
      // What `git reset --hard` does to a configuration the project tracks.
      resetToBeadStartMock.mockImplementationOnce(() => {
        writeFileSync(configPath, original, 'utf8')
      })

      let duringRun: string | undefined
      executeBeadMock.mockImplementationOnce(async () => {
        duringRun = readFileSync(configPath, 'utf8')
        return { success: true, beadId: 'bead-1', iteration: 3, output: 'done', errors: [], rawAttempts: [] }
      })

      await handleCoding(ticket.id, context, vi.fn(), new AbortController().signal)

      expect(resetToBeadStartMock).toHaveBeenCalled()
      expect(JSON.parse(duringRun ?? '{}')).toEqual({
        mcp: { docs: { type: 'local' } },
        agent: { build: { steps: 25 } },
      })
      expect(readFileSync(configPath, 'utf8')).toBe(original)
    })

    it('does not add the temporary config to shared git excludes', async () => {
      setStepCap(25)
      const { ticket, context, repoDir } = await createInitializedTestTicket(repoManager, { title: 'Step cap local visibility' })
      const paths = getTicketPaths(ticket.id)!
      writeTicketBeads(ticket.id, [makePendingBead('bead-1', 1)])
      succeedOnce('bead-1')

      await handleCoding(ticket.id, context, vi.fn(), new AbortController().signal)

      const excludePath = resolve(paths.worktreePath, execFileSync(
        'git',
        ['-C', paths.worktreePath, 'rev-parse', '--git-path', 'info/exclude'],
        { encoding: 'utf8' },
      ).trim())
      expect(readFileSync(excludePath, 'utf8')).not.toContain('/opencode.json')

      // The ticket is a linked worktree. A common info/exclude rule would
      // silently hide this new config from the parent checkout too.
      const parentConfigPath = join(repoDir, 'opencode.json')
      writeFileSync(parentConfigPath, '{"parent": true}\n', 'utf8')
      expect(execFileSync('git', ['-C', repoDir, 'status', '--porcelain', '--', 'opencode.json'], { encoding: 'utf8' }))
        .toContain('?? opencode.json')
      rmSync(parentConfigPath)
    })
  })
})
