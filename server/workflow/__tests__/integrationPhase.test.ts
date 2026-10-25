import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TicketEvent } from '../../machines/types'
import { TEST, makeTicketContext } from '../../test/factories'
import { CancelledError } from '../../council/types'

const {
  prepareSquashCandidateMock,
  getLatestPhaseArtifactMock,
  getTicketPathsMock,
  insertPhaseArtifactMock,
  emitPhaseLogMock,
  runExplicitGitHookValidationMock,
  isMockOpenCodeModeMock,
  handleMockExecutionUnsupportedMock,
  readManualQaDeliverySummaryMock,
} = vi.hoisted(() => ({
  prepareSquashCandidateMock: vi.fn(),
  getLatestPhaseArtifactMock: vi.fn(),
  getTicketPathsMock: vi.fn(),
  insertPhaseArtifactMock: vi.fn(),
  emitPhaseLogMock: vi.fn(),
  runExplicitGitHookValidationMock: vi.fn(),
  isMockOpenCodeModeMock: vi.fn(),
  handleMockExecutionUnsupportedMock: vi.fn(),
  readManualQaDeliverySummaryMock: vi.fn(),
}))

vi.mock('../../phases/integration/squash', () => ({
  prepareSquashCandidate: prepareSquashCandidateMock,
}))

vi.mock('../../phases/manualQa/delivery', () => ({
  readManualQaDeliverySummaryForTicket: readManualQaDeliverySummaryMock,
}))

vi.mock('../../storage/tickets', () => ({
  getLatestPhaseArtifact: getLatestPhaseArtifactMock,
  getTicketPaths: getTicketPathsMock,
  insertPhaseArtifact: insertPhaseArtifactMock,
}))

vi.mock('../../opencode/factory', async () => {
  const actual = await vi.importActual<typeof import('../../opencode/factory')>('../../opencode/factory')
  return {
    ...actual,
    isMockOpenCodeMode: isMockOpenCodeModeMock,
  }
})

vi.mock('../phases/helpers', async () => {
  const actual = await vi.importActual<typeof import('../phases/helpers')>('../phases/helpers')
  return {
    ...actual,
    emitPhaseLog: emitPhaseLogMock,
  }
})

vi.mock('../phases/executionPhase', () => ({
  handleMockExecutionUnsupported: handleMockExecutionUnsupportedMock,
}))

vi.mock('../../log/commandLogger', () => ({
  withCommandLoggingAsync: async (_tid: string, _eid: string, _phase: string, fn: () => Promise<unknown>) => fn(),
  // Every git command now goes through the shared runner, which logs; a mock
  // that omits this export makes the runner throw rather than stay quiet.
  logCommand: vi.fn(),
}))

vi.mock('../../phases/executionSetup/hookValidation', () => ({
  runExplicitGitHookValidation: runExplicitGitHookValidationMock,
}))

import { handleIntegration } from '../phases/integrationPhase'

const defaultPaths = {
  worktreePath: '/fake/worktree',
  baseBranch: 'main',
  ticketDir: '/fake/worktree/.ticket',
  executionLogPath: '/fake/worktree/.ticket/runtime/execution-log.jsonl',
  debugLogPath: '/fake/worktree/.ticket/runtime/execution-log.debug.jsonl',
  aiLogPath: '/fake/worktree/.ticket/runtime/execution-log.ai.jsonl',
  executionSetupDir: '/fake/worktree/.ticket/runtime/execution-setup',
  executionSetupProfilePath: '/fake/worktree/.ticket/runtime/execution-setup-profile.json',
  beadsPath: '/fake/worktree/.ticket/beads.yaml',
}

const successSquash = {
  success: true,
  message: 'Squashed successfully',
  commitHash: 'abc1234',
  mergeBase: 'def5678',
  preSquashHead: '999aaa',
  commitCount: 3,
}

describe('handleIntegration', () => {
  let context: ReturnType<typeof makeTicketContext>

  beforeEach(() => {
    vi.resetAllMocks()
    isMockOpenCodeModeMock.mockReturnValue(false)
    getTicketPathsMock.mockReturnValue(defaultPaths)
    getLatestPhaseArtifactMock.mockReturnValue(undefined)
    prepareSquashCandidateMock.mockReturnValue(successSquash)
    readManualQaDeliverySummaryMock.mockReturnValue(null)

    context = makeTicketContext()
  })

  it('finishes integration without a pull request when no repository files changed', async () => {
    prepareSquashCandidateMock.mockResolvedValue({
      success: true, noChanges: true, message: 'No candidate changes were available to squash',
      mergeBase: 'base-sha', preSquashHead: 'base-sha', commitCount: 0,
    })
    const sendEvent = vi.fn()

    await handleIntegration(TEST.ticketId, context, sendEvent)

    expect(sendEvent).toHaveBeenCalledExactlyOnceWith({ type: 'INTEGRATION_NO_CHANGES' })
    const report = JSON.parse(insertPhaseArtifactMock.mock.calls[0]![1].content)
    expect(report).toMatchObject({
      status: 'passed', noRepositoryChanges: true, candidateCommitSha: null,
      pushed: false, pushDeferred: false,
    })
  })

  it('successful integration defers the remote update until manual verification', async () => {
    // The canonical-first read and its artifact fallback are one reader now,
    // and its own tests cover the envelope shapes; this drives its result.
    readManualQaDeliverySummaryMock.mockReturnValue({
      version: 2,
      outcome: 'waived_through',
      createdFixBeadIds: ['qa-fix-1'],
      improvementTicketIds: ['DEMO-2'],
      waivedItemIds: ['qa-v2-001'],
      skipReason: null,
    })
    const sendEvent = vi.fn<(event: TicketEvent) => void>()
    await handleIntegration(TEST.ticketId, context, sendEvent)

    expect(prepareSquashCandidateMock).toHaveBeenCalledWith(
      defaultPaths.worktreePath,
      defaultPaths.baseBranch,
      context.title,
      context.externalId,
      [],
    )

    expect(insertPhaseArtifactMock).toHaveBeenCalledWith(TEST.ticketId, expect.objectContaining({
      phase: 'INTEGRATING_CHANGES',
      artifactType: 'integration_report',
    }))
    const report = JSON.parse(insertPhaseArtifactMock.mock.calls[0]![1].content)
    expect(report.status).toBe('passed')
    expect(report.pushed).toBe(false)
    expect(report.pushDeferred).toBe(true)
    expect(report.pushError).toBeNull()
    expect(report.candidateCommitSha).toBe('abc1234')
    expect(report.manualQa).toEqual({
      version: 2,
      outcome: 'waived_through',
      createdFixBeadIds: ['qa-fix-1'],
      improvementTicketIds: ['DEMO-2'],
      waivedItemIds: ['qa-v2-001'],
      skipReason: null,
    })

    expect(sendEvent).toHaveBeenCalledWith({ type: 'INTEGRATION_DONE' })
    expect(emitPhaseLogMock).toHaveBeenCalled()
  })

  it('preserves early-merge correction lineage across re-integration attempts', async () => {
    getLatestPhaseArtifactMock.mockImplementation((_ticketId: string, artifactType: string) => (
      artifactType === 'integration_report'
        ? { content: JSON.stringify({ earlyMergeCorrectionBranch: 'looptroop/early-merge/pr-42-123456789abc' }) }
        : undefined
    ))

    await handleIntegration(TEST.ticketId, context, vi.fn())

    expect(getLatestPhaseArtifactMock).toHaveBeenCalledWith(TEST.ticketId, 'integration_report')
    const report = JSON.parse(insertPhaseArtifactMock.mock.calls[0]![1].content)
    expect(report).toMatchObject({
      candidateCommitSha: 'abc1234',
      earlyMergeCorrectionBranch: 'looptroop/early-merge/pr-42-123456789abc',
    })
  })

  it('preserves early-merge correction lineage when hook validation blocks integration', async () => {
    getLatestPhaseArtifactMock.mockImplementation((_ticketId: string, artifactType: string) => (
      artifactType === 'integration_report'
        ? { content: JSON.stringify({ earlyMergeCorrectionBranch: 'looptroop/early-merge/pr-42-123456789abc' }) }
        : artifactType === 'execution_setup_profile'
          ? { content: '{}' }
          : undefined
    ))
    runExplicitGitHookValidationMock.mockResolvedValue({
      errors: ['hook failed'],
      warnings: [],
      receipts: [],
    })
    const sendEvent = vi.fn<(event: TicketEvent) => void>()

    await handleIntegration(TEST.ticketId, context, sendEvent)

    const report = JSON.parse(insertPhaseArtifactMock.mock.calls[0]![1].content)
    expect(report).toMatchObject({
      status: 'blocked',
      earlyMergeCorrectionBranch: 'looptroop/early-merge/pr-42-123456789abc',
    })
    expect(prepareSquashCandidateMock).not.toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ codes: ['GIT_HOOK_VALIDATION_FAILED'] }))
  })

  it('squash failure throws', async () => {
    const sendEvent = vi.fn<(event: TicketEvent) => void>()
    prepareSquashCandidateMock.mockReturnValue({
      success: false,
      message: 'merge conflict',
    })

    await expect(handleIntegration(TEST.ticketId, context, sendEvent))
      .rejects.toThrow('merge conflict')

    const report = JSON.parse(insertPhaseArtifactMock.mock.calls[0]![1].content)
    expect(report.status).toBe('failed')
    expect(report.message).toBe('merge conflict')

    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('passes validated final-test modified files into the squash stage', async () => {
    const sendEvent = vi.fn<(event: TicketEvent) => void>()
    getLatestPhaseArtifactMock.mockImplementation((_ticketId: string, artifactType: string) => (
      artifactType === 'final_test_report'
        ? {
            content: JSON.stringify({
              modifiedFiles: ['src/final.test.ts', 'src/feature.ts'],
            }),
          }
        : undefined
    ))

    await handleIntegration(TEST.ticketId, context, sendEvent)

    expect(prepareSquashCandidateMock).toHaveBeenCalledWith(
      defaultPaths.worktreePath,
      defaultPaths.baseBranch,
      context.title,
      context.externalId,
      ['src/final.test.ts', 'src/feature.ts'],
    )
  })

  it('uses audited final-test candidate files when an audit is available', async () => {
    const sendEvent = vi.fn<(event: TicketEvent) => void>()
    getLatestPhaseArtifactMock.mockImplementation((_ticketId: string, artifactType: string) => (
      artifactType === 'final_test_file_effects_audit'
        ? {
            content: JSON.stringify({
              status: 'passed',
              capturedAt: '2026-05-26T00:00:00.000Z',
              baselineDirtyFiles: [],
              dirtyFilesAfterTesting: [],
              producedByFinalTesting: [],
              declaredEffects: [{ path: 'tests/final.spec', intent: 'candidate' }],
              resolvedEffects: [{
                path: 'tests/final.spec',
                disposition: 'candidate',
                reason: 'declared_candidate',
              }],
              candidateFiles: ['tests/final.spec'],
              localOnlyFiles: [],
              classificationRequiredFiles: [],
              classificationRetry: { status: 'not_needed', requestedFiles: [] },
              temporaryFiles: [],
              unexpectedFiles: [],
              warnings: [],
              message: 'Final-test file effects were fully resolved.',
            }),
          }
        : undefined
    ))

    await handleIntegration(TEST.ticketId, context, sendEvent)

    expect(prepareSquashCandidateMock).toHaveBeenCalledWith(
      defaultPaths.worktreePath,
      defaultPaths.baseBranch,
      context.title,
      context.externalId,
      ['tests/final.spec'],
    )
  })

  it('continues integration when the audit keeps undeclared untracked output local-only', async () => {
    const sendEvent = vi.fn<(event: TicketEvent) => void>()
    getLatestPhaseArtifactMock.mockImplementation((_ticketId: string, artifactType: string) => (
      artifactType === 'final_test_file_effects_audit'
        ? {
            content: JSON.stringify({
              status: 'passed',
              capturedAt: '2026-05-26T00:00:00.000Z',
              baselineDirtyFiles: [],
              dirtyFilesAfterTesting: [],
              producedByFinalTesting: [],
              declaredEffects: [],
              resolvedEffects: [{
                path: 'tmp/output.log',
                disposition: 'local_only',
                reason: 'undeclared_fallback',
                warning: 'Undeclared untracked file was kept locally and excluded from delivery: tmp/output.log',
              }],
              candidateFiles: ['tests/final.spec'],
              localOnlyFiles: ['tmp/output.log'],
              classificationRequiredFiles: ['tmp/output.log'],
              classificationRetry: {
                status: 'fallback',
                requestedFiles: ['tmp/output.log'],
              },
              temporaryFiles: [],
              unexpectedFiles: [],
              warnings: ['Undeclared untracked file was kept locally and excluded from delivery: tmp/output.log'],
              message: 'Final-test file effects were resolved with 1 warning(s).',
            }),
          }
        : undefined
    ))

    await handleIntegration(TEST.ticketId, context, sendEvent)

    expect(prepareSquashCandidateMock).toHaveBeenCalledWith(
      defaultPaths.worktreePath,
      defaultPaths.baseBranch,
      context.title,
      context.externalId,
      ['tests/final.spec'],
    )
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ERROR' }))
  })

  it('missing ticket paths throws', async () => {
    const sendEvent = vi.fn<(event: TicketEvent) => void>()
    getTicketPathsMock.mockReturnValue(null)

    await expect(handleIntegration(TEST.ticketId, context, sendEvent))
      .rejects.toThrow('Ticket workspace not initialized')
  })

  it('mock mode delegates to handleMockExecutionUnsupported', async () => {
    const sendEvent = vi.fn<(event: TicketEvent) => void>()
    isMockOpenCodeModeMock.mockReturnValue(true)

    await handleIntegration(TEST.ticketId, context, sendEvent)

    expect(handleMockExecutionUnsupportedMock).toHaveBeenCalledWith(
      TEST.ticketId, context, 'INTEGRATING_CHANGES', sendEvent,
    )
    expect(prepareSquashCandidateMock).not.toHaveBeenCalled()
  })

  it('AbortSignal already aborted throws CancelledError', async () => {
    const sendEvent = vi.fn<(event: TicketEvent) => void>()
    const ac = new AbortController()
    ac.abort()

    await expect(handleIntegration(TEST.ticketId, context, sendEvent, ac.signal))
      .rejects.toThrow(CancelledError)

    expect(prepareSquashCandidateMock).not.toHaveBeenCalled()
  })
})
