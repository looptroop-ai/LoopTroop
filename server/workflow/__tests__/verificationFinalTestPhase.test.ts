import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import {
  makeBeadsYaml,
  makeInterviewYaml,
  makePrdYaml,
  TEST,
} from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { getLatestPhaseArtifact, upsertLatestPhaseArtifact } from '../../storage/tickets'
import { updateProject } from '../../storage/projects'

const {
  executeFinalTestWithRetriesMock,
  recordWorktreeStartCommitMock,
  resetWorktreeToCommitMock,
  isMockOpenCodeModeMock,
  runOpenCodeSessionPromptMock,
} = vi.hoisted(() => ({
  executeFinalTestWithRetriesMock: vi.fn(),
  recordWorktreeStartCommitMock: vi.fn(),
  resetWorktreeToCommitMock: vi.fn(),
  isMockOpenCodeModeMock: vi.fn(),
  runOpenCodeSessionPromptMock: vi.fn(),
}))

vi.mock('../../phases/finalTest/executor', () => ({
  executeFinalTestWithRetries: executeFinalTestWithRetriesMock,
}))

vi.mock('../../phases/execution/gitOps', () => ({
  WORKTREE_RESET_PRESERVE_PATHS: ['.ticket'],
  getExecutionSetupCommitExcludedRoots: vi.fn(() => []),
  recordWorktreeStartCommit: recordWorktreeStartCommitMock,
  resetWorktreeToCommit: resetWorktreeToCommitMock,
  recordBeadStartCommit: vi.fn(),
  resetToBeadStart: vi.fn(),
  commitBeadChanges: vi.fn(),
  captureBeadDiff: vi.fn(),
}))

vi.mock('../../opencode/factory', async () => {
  const actual = await vi.importActual<typeof import('../../opencode/factory')>('../../opencode/factory')
  return {
    ...actual,
    isMockOpenCodeMode: isMockOpenCodeModeMock,
  }
})

vi.mock('../runOpenCodePrompt', async () => {
  const actual = await vi.importActual<typeof import('../runOpenCodePrompt')>('../runOpenCodePrompt')
  return {
    ...actual,
    runOpenCodeSessionPrompt: runOpenCodeSessionPromptMock,
  }
})

import { handleFinalTest } from '../phases/verificationPhase'

const repoManager = createTestRepoManager('verification-final-test-')

describe('handleFinalTest', () => {
  beforeEach(() => {
    resetTestDb()
    executeFinalTestWithRetriesMock.mockReset()
    recordWorktreeStartCommitMock.mockReset()
    resetWorktreeToCommitMock.mockReset()
    isMockOpenCodeModeMock.mockReset()
    runOpenCodeSessionPromptMock.mockReset()

    recordWorktreeStartCommitMock.mockReturnValue('abc123')
    isMockOpenCodeModeMock.mockReturnValue(false)
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('reloads persisted final-test retry notes into context and uses execution runtime settings', async () => {
    const { ticket, context, paths, project } = await createInitializedTestTicket(repoManager, {
      title: 'Final test retry state',
      description: 'Ensure retries keep prior final-test notes.',
    })
    updateProject(project.id, {
      maxIterations: 2,
      perIterationTimeout: 12345,
      councilResponseTimeout: 67890,
    })

    writeFileSync(`${paths.ticketDir}/interview.yaml`, makeInterviewYaml())
    writeFileSync(`${paths.ticketDir}/prd.yaml`, makePrdYaml({ ticketId: ticket.externalId }))
    writeFileSync(paths.beadsPath, makeBeadsYaml({ beadCount: 1 }))
    upsertLatestPhaseArtifact(
      ticket.id,
      'final_test_retry_notes',
      'RUNNING_FINAL_TEST',
      JSON.stringify({ notes: ['Prior retry note: avoid repeating the broad contrast assertion.'] }),
    )

    let capturedContextParts: Array<{ source?: string; content: string }> = []
    executeFinalTestWithRetriesMock.mockImplementationOnce(async (
      _adapter: unknown,
      contextParts: () => Promise<Array<{ source?: string; content: string }>>,
      _projectPath: string,
      _signal: AbortSignal,
      options: { timeoutMs: number; aiResponseTimeoutMs?: number; maxIterations: number; model: string },
    ) => {
      capturedContextParts = await contextParts()
      expect(options.timeoutMs).toBe(12345)
      expect(options.aiResponseTimeoutMs).toBe(67890)
      expect(options.maxIterations).toBe(2)
      expect(options.model).toBe(TEST.implementer)

      return {
        status: 'passed' as const,
        passed: true,
        checkedAt: '2026-04-09T12:00:00.000Z',
        plannedBy: TEST.implementer,
        summary: 'verify retry state',
        testFiles: ['src/final.test.ts'],
        modifiedFiles: ['src/final.test.ts'],
        fileEffects: [{ path: 'src/final.test.ts', intent: 'candidate' }],
        testsCount: 1,
        modelOutput: '<FINAL_TEST_COMMANDS>{"commands":["npm run test:final"]}</FINAL_TEST_COMMANDS>',
        commands: [
          {
            command: 'npm run test:final',
            exitCode: 0,
            signal: null,
            stdout: 'ok',
            stderr: '',
            durationMs: 10,
            timedOut: false,
          },
        ],
        errors: [],
        attempt: 1,
        maxIterations: 2,
        attemptHistory: [],
        retryNotes: ['Prior retry note: avoid repeating the broad contrast assertion.'],
      }
    })

    const sendEvent = vi.fn()
    await handleFinalTest(
      ticket.id,
      {
        ...context,
        lockedMainImplementer: TEST.implementer,
      },
      sendEvent,
      new AbortController().signal,
    )

    expect(recordWorktreeStartCommitMock).toHaveBeenCalled()
    expect(executeFinalTestWithRetriesMock).toHaveBeenCalledTimes(1)
    expect(capturedContextParts.map((part) => part.source)).toEqual([
      'ticket_details',
      'prd',
      'beads',
      'final_test_note',
    ])
    expect(capturedContextParts.map((part) => part.content).join('\n')).not.toContain('artifact: interview')
    expect(
      capturedContextParts.some((part) => (
        part.source === 'final_test_note'
        && part.content.includes('Prior retry note: avoid repeating the broad contrast assertion.')
      )),
    ).toBe(true)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'TESTS_PASSED' })
  })

  it('preserves LoopTroop ticket artifacts when resetting before a final-test retry', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Final test reset preservation',
    })

    writeFileSync(`${paths.ticketDir}/interview.yaml`, makeInterviewYaml())
    writeFileSync(`${paths.ticketDir}/prd.yaml`, makePrdYaml({ ticketId: ticket.externalId }))
    writeFileSync(paths.beadsPath, makeBeadsYaml({ beadCount: 1 }))

    executeFinalTestWithRetriesMock.mockImplementationOnce(async (
      _adapter: unknown,
      _contextParts: unknown,
      _projectPath: unknown,
      _signal: AbortSignal,
      _options: unknown,
      callbacks: {
        beforeRetry: (entry: { nextAttempt: number }) => void
      },
    ) => {
      callbacks.beforeRetry({ nextAttempt: 2 })
      return {
        status: 'passed' as const,
        passed: true,
        checkedAt: '2026-04-09T12:00:00.000Z',
        plannedBy: TEST.implementer,
        summary: 'passed after retry reset',
        testFiles: [],
        modifiedFiles: [],
        fileEffects: [],
        testsCount: 0,
        modelOutput: '<FINAL_TEST_COMMANDS>{"commands":[]}</FINAL_TEST_COMMANDS>',
        commands: [],
        errors: [],
        attempt: 2,
        maxIterations: 2,
        attemptHistory: [],
        retryNotes: [],
      }
    })

    const sendEvent = vi.fn()
    await handleFinalTest(
      ticket.id,
      {
        ...context,
        lockedMainImplementer: TEST.implementer,
      },
      sendEvent,
      new AbortController().signal,
    )

    expect(resetWorktreeToCommitMock).toHaveBeenCalledWith(
      paths.worktreePath,
      'abc123',
      expect.objectContaining({
        preservePaths: expect.arrayContaining(['.ticket']),
      }),
    )
    expect(sendEvent).toHaveBeenCalledWith({ type: 'TESTS_PASSED' })
  })

  it('reuses the final-test session once to classify an unknown untracked file', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Final-test file classification retry',
    })
    mkdirSync(`${paths.worktreePath}/diagnostics`, { recursive: true })

    executeFinalTestWithRetriesMock.mockImplementationOnce(async (
      _adapter: unknown,
      _contextParts: unknown,
      _projectPath: unknown,
      _signal: AbortSignal,
      _options: unknown,
      callbacks: { onSessionCreated: (sessionId: string, attempt: number) => void },
    ) => {
      callbacks.onSessionCreated('final-test-session', 1)
      writeFileSync(`${paths.worktreePath}/diagnostics/final-output.txt`, 'keep this regression artifact\n')
      return {
        status: 'passed' as const,
        passed: true,
        checkedAt: '2026-04-09T12:00:00.000Z',
        plannedBy: TEST.implementer,
        summary: 'classify final output',
        testFiles: ['diagnostics/final-output.txt'],
        modifiedFiles: ['diagnostics/final-output.txt'],
        fileEffects: [],
        testsCount: 1,
        modelOutput: '<FINAL_TEST_COMMANDS>{"commands":["true"],"test_files":["diagnostics/final-output.txt"],"modified_files":["diagnostics/final-output.txt"],"file_effects":[]}</FINAL_TEST_COMMANDS>',
        commands: [{
          command: 'true',
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: 1,
          timedOut: false,
        }],
        errors: [],
        attempt: 1,
        maxIterations: 1,
        attemptHistory: [],
        retryNotes: [],
      }
    })
    runOpenCodeSessionPromptMock.mockResolvedValueOnce({
      session: { id: 'final-test-session' },
      response: '<FINAL_TEST_COMMANDS>{"commands":["true"],"test_files":["diagnostics/final-output.txt"],"modified_files":["diagnostics/final-output.txt"],"file_effects":[{"path":"diagnostics/final-output.txt","intent":"candidate"}]}</FINAL_TEST_COMMANDS>',
      messages: [],
    })

    const sendEvent = vi.fn()
    await handleFinalTest(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    expect(runOpenCodeSessionPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      session: { id: 'final-test-session' },
      toolPolicy: 'disabled',
    }))
    const artifact = getLatestPhaseArtifact(
      ticket.id,
      'final_test_file_effects_audit',
      'RUNNING_FINAL_TEST',
    )
    expect(artifact).toBeTruthy()
    const audit = JSON.parse(artifact!.content)
    expect(audit.candidateFiles).toEqual(['diagnostics/final-output.txt'])
    expect(audit.localOnlyFiles).toEqual([])
    expect(audit.classificationRetry).toEqual({
      status: 'resolved',
      requestedFiles: ['diagnostics/final-output.txt'],
    })
    expect(sendEvent).toHaveBeenCalledWith({ type: 'TESTS_PASSED' })
  })

  it('keeps an unknown untracked file local-only when the classification retry fails', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Final-test file classification fallback',
    })

    executeFinalTestWithRetriesMock.mockImplementationOnce(async (
      _adapter: unknown,
      _contextParts: unknown,
      _projectPath: unknown,
      _signal: AbortSignal,
      _options: unknown,
      callbacks: { onSessionCreated: (sessionId: string, attempt: number) => void },
    ) => {
      callbacks.onSessionCreated('final-test-session', 1)
      writeFileSync(`${paths.worktreePath}/local-output.txt`, 'leave on disk\n')
      return {
        status: 'passed' as const,
        passed: true,
        checkedAt: '2026-04-09T12:00:00.000Z',
        plannedBy: TEST.implementer,
        testFiles: [],
        modifiedFiles: [],
        fileEffects: [],
        testsCount: 1,
        modelOutput: '<FINAL_TEST_COMMANDS>{"commands":["true"],"test_files":[],"modified_files":[],"file_effects":[]}</FINAL_TEST_COMMANDS>',
        commands: [{
          command: 'true',
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: 1,
          timedOut: false,
        }],
        errors: [],
        attempt: 1,
        maxIterations: 1,
        attemptHistory: [],
        retryNotes: [],
      }
    })
    runOpenCodeSessionPromptMock.mockRejectedValueOnce(new Error('provider unavailable'))

    const sendEvent = vi.fn()
    await handleFinalTest(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    const artifact = getLatestPhaseArtifact(
      ticket.id,
      'final_test_file_effects_audit',
      'RUNNING_FINAL_TEST',
    )
    const audit = JSON.parse(artifact!.content)
    expect(audit.candidateFiles).toEqual([])
    expect(audit.localOnlyFiles).toEqual(['local-output.txt'])
    expect(audit.classificationRetry).toMatchObject({
      status: 'fallback',
      requestedFiles: ['local-output.txt'],
      warning: expect.stringContaining('provider unavailable'),
    })
    expect(readFileSync(`${paths.worktreePath}/local-output.txt`, 'utf8')).toBe('leave on disk\n')
    expect(sendEvent).toHaveBeenCalledWith({ type: 'TESTS_PASSED' })
  })
})
