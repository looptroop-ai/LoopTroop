import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { parseUiArtifactCompanionArtifact } from '@shared/artifactCompanions'
import { makePrdYaml, TEST } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { getLatestPhaseArtifact, insertPhaseArtifact } from '../../storage/tickets'
import {
  buildPersistedBatch,
  createInterviewSessionSnapshot,
  INTERVIEW_SESSION_ARTIFACT,
  recordBatchAnswers,
  recordPreparedBatch,
  serializeInterviewSessionSnapshot,
} from '../../phases/interview/sessionState'
import type { PreFlightRunOptions } from '../../phases/preflight/doctor'
import type { DiagnosticCheck, PreFlightReport } from '../../phases/preflight/types'
import type { executeFinalTestWithRetries } from '../../phases/finalTest/executor'
import type { FinalTestGenerationResult } from '../../phases/finalTest/generator'
import type { FinalTestExecutionReport } from '../../phases/finalTest/runner'

const {
  executeFinalTestWithRetriesMock,
  isMockOpenCodeModeMock,
  recordWorktreeStartCommitMock,
  runOpenCodePromptMock,
  runPreFlightChecksMock,
} = vi.hoisted(() => ({
  executeFinalTestWithRetriesMock: vi.fn(),
  isMockOpenCodeModeMock: vi.fn(),
  recordWorktreeStartCommitMock: vi.fn(),
  runOpenCodePromptMock: vi.fn(),
  runPreFlightChecksMock: vi.fn(),
}))

vi.mock('../../phases/finalTest/executor', () => ({
  executeFinalTestWithRetries: executeFinalTestWithRetriesMock,
}))

vi.mock('../../phases/execution/gitOps', () => ({
  WORKTREE_RESET_PRESERVE_PATHS: ['.ticket'],
  getExecutionSetupCommitExcludedRoots: vi.fn(() => []),
  recordWorktreeStartCommit: recordWorktreeStartCommitMock,
  resetWorktreeToCommit: vi.fn(),
  recordBeadStartCommit: vi.fn(),
  resetToBeadStart: vi.fn(),
  commitBeadChanges: vi.fn(),
  captureBeadDiff: vi.fn(),
}))

vi.mock('../../phases/preflight/doctor', () => ({
  runPreFlightChecks: runPreFlightChecksMock,
}))

vi.mock('../../opencode/factory', async () => {
  const actual = await vi.importActual<typeof import('../../opencode/factory')>('../../opencode/factory')
  return { ...actual, isMockOpenCodeMode: isMockOpenCodeModeMock }
})

vi.mock('../runOpenCodePrompt', async () => {
  const actual = await vi.importActual<typeof import('../runOpenCodePrompt')>('../runOpenCodePrompt')
  return { ...actual, runOpenCodePrompt: runOpenCodePromptMock }
})

import {
  handleCoverageVerification,
  handleFinalTest,
  handleMockBeadsExpansion,
  handleMockCoverage,
  handlePreFlight,
  performCoverageExtraFix,
} from '../phases/verificationPhase'

const repoManager = createTestRepoManager('verification-phase-coverage-')

beforeEach(() => {
  resetTestDb()
  executeFinalTestWithRetriesMock.mockReset()
  isMockOpenCodeModeMock.mockReset().mockReturnValue(false)
  recordWorktreeStartCommitMock.mockReset().mockReturnValue('abc123')
  runOpenCodePromptMock.mockReset()
  runPreFlightChecksMock.mockReset()
})

afterAll(() => {
  resetTestDb()
  repoManager.cleanup()
})

describe('handlePreFlight', () => {
  it('persists passing diagnostics and streams probe errors', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    const warning: DiagnosticCheck = {
      name: 'Optional configuration',
      category: 'config',
      result: 'warning',
      message: 'An optional setting is missing.',
    }
    const report: PreFlightReport = {
      passed: true,
      checks: [
        { name: 'OpenCode', category: 'connectivity', result: 'pass', message: 'Available.' },
        warning,
      ],
      criticalFailures: [],
      warnings: [warning],
    }

    runPreFlightChecksMock.mockImplementationOnce(async (...args: Parameters<typeof import('../../phases/preflight/doctor').runPreFlightChecks>) => {
      const options = args[6] as PreFlightRunOptions
      expect(Array.isArray(args[2])).toBe(true)
      expect(args[3]).toEqual({
        lockedMainImplementer: context.lockedMainImplementer,
        lockedMainImplementerVariant: context.lockedMainImplementerVariant,
        maxIterations: context.maxIterations,
      })
      options.onOpenCodeStreamEvent?.({
        session: { id: 'preflight-session' },
        modelId: TEST.implementer,
        event: { type: 'session_status', sessionId: 'preflight-session', status: 'idle' },
      })
      options.onOpenCodeStreamEvent?.({
        session: { id: 'preflight-session' },
        modelId: TEST.implementer,
        event: { type: 'session_error', sessionId: 'preflight-session', error: 'Probe failed.' },
      })
      return report
    })

    const sendEvent = vi.fn()
    await handlePreFlight(ticket.id, context, sendEvent, new AbortController().signal)

    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'preflight_report', 'PRE_FLIGHT_CHECK')!.content)).toEqual(report)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'CHECKS_PASSED' })
  })

  it('emits critical failures without advancing bead progress', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    const failure: DiagnosticCheck = {
      name: 'OpenCode',
      category: 'connectivity',
      result: 'fail',
      message: 'OpenCode is unreachable.',
    }
    const report: PreFlightReport = {
      passed: false,
      checks: [failure],
      criticalFailures: [failure],
      warnings: [],
    }
    runPreFlightChecksMock.mockResolvedValueOnce(report)

    const sendEvent = vi.fn()
    await handlePreFlight(ticket.id, context, sendEvent, new AbortController().signal)

    expect(getLatestPhaseArtifact(ticket.id, 'preflight_report', 'PRE_FLIGHT_CHECK')?.content).toBe(JSON.stringify(report))
    expect(sendEvent).toHaveBeenCalledWith({ type: 'CHECKS_FAILED', errors: ['OpenCode is unreachable.'] })
  })
})

describe('mock verification handlers', () => {
  it.each(['interview', 'prd', 'beads'] as const)('records a clean mock %s coverage run', async (phase) => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    const sendEvent = vi.fn()

    await handleMockCoverage(ticket.id, context, phase, sendEvent)

    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, `${phase}_coverage`)!.content)).toMatchObject({
      hasGaps: false,
      coverageRunNumber: 1,
      limitReached: false,
      terminationReason: 'clean',
    })
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_CLEAN' })
  })

  it('persists hydrated mock beads and progress', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    const sendEvent = vi.fn()

    await handleMockBeadsExpansion(ticket.id, context, sendEvent)

    const artifact = getLatestPhaseArtifact(ticket.id, 'beads_expanded', 'EXPANDING_BEADS')
    expect(JSON.parse(artifact!.content)).toMatchObject({
      candidateVersion: 1,
      refinedContent: expect.stringContaining('"id":"test-1-bead-1"'),
      expandedContent: expect.stringContaining('"id":"test-1-bead-1"'),
    })
    expect(sendEvent).toHaveBeenCalledWith({ type: 'EXPANDED' })
  })
})

describe('interview coverage recovery', () => {
  async function createCompletedInterviewSnapshot(ticketId: string) {
    const winnerId = TEST.councilMembers[0]
    const questions = Array.from({ length: 5 }, (_, index) => ({
      id: `Q0${index + 1}`,
      phase: 'Requirements',
      question: `Which requirement matters most for step ${index + 1}?`,
    }))
    const initialSnapshot = createInterviewSessionSnapshot({
      winnerId,
      compiledQuestions: questions,
      maxInitialQuestions: questions.length,
    })
    const batch = buildPersistedBatch({
      questions,
      progress: { current: questions.length, total: questions.length },
      isComplete: true,
      isFinalFreeForm: false,
      aiCommentary: 'Initial questions completed.',
      batchNumber: 1,
    }, 'prom4', initialSnapshot)
    const answeredSnapshot = recordBatchAnswers(
      recordPreparedBatch(initialSnapshot, batch),
      Object.fromEntries(questions.map((question, index) => [question.id, `Answer ${index + 1}`])),
    )

    insertPhaseArtifact(ticketId, {
      phase: 'REFINING_INTERVIEW',
      artifactType: 'interview_winner',
      content: JSON.stringify({ winnerId }),
    })
    insertPhaseArtifact(ticketId, {
      phase: 'WAITING_INTERVIEW_ANSWERS',
      artifactType: INTERVIEW_SESSION_ARTIFACT,
      content: serializeInterviewSessionSnapshot(answeredSnapshot),
    })
    return { winnerId, questions, answeredSnapshot }
  }

  it('rebuilds missing interview.yaml from the session snapshot before clean coverage', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    const { questions } = await createCompletedInterviewSnapshot(ticket.id)
    const interviewPath = `${paths.ticketDir}/interview.yaml`
    expect(existsSync(interviewPath)).toBe(false)
    runOpenCodePromptMock.mockResolvedValueOnce({
      session: { id: 'interview-coverage-clean', projectPath: paths.worktreePath },
      response: ['status: clean', 'gaps: []', 'follow_up_questions: []'].join('\n'),
      messages: [],
    })
    const sendEvent = vi.fn()

    await handleCoverageVerification(ticket.id, context, sendEvent, 'interview', new AbortController().signal)

    expect(existsSync(interviewPath)).toBe(true)
    const canonicalInterview = readFileSync(interviewPath, 'utf-8')
    expect(canonicalInterview).toContain('Answer 1')
    const prompt = runOpenCodePromptMock.mock.calls[0]?.[0]?.parts.map((part) => part.content).join('\n')
    expect(prompt).toContain('follow_up_budget_total: 1')
    expect(prompt).toContain('follow_up_budget_remaining: 1')
    expect(prompt).toContain(questions[0]!.question)

    const inputArtifact = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:interview_coverage_input', 'VERIFYING_INTERVIEW_COVERAGE')
    const coverageInput = parseUiArtifactCompanionArtifact(inputArtifact!.content)?.payload as {
      interview?: string
      userAnswers?: string
    } | undefined
    expect(coverageInput?.interview).toBe(canonicalInterview)
    expect(coverageInput?.userAnswers).toContain('Q01: Which requirement matters most for step 1?')
    expect(coverageInput?.userAnswers).toContain('Answer: Answer 1')
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'interview_coverage', 'VERIFYING_INTERVIEW_COVERAGE')!.content)).toMatchObject({
      winnerId: TEST.councilMembers[0],
      hasGaps: false,
      coverageRunNumber: 1,
      limitReached: false,
    })
    expect(sendEvent).toHaveBeenCalledWith({ type: 'COVERAGE_CLEAN' })
  })

  it('persists a targeted follow-up batch when coverage finds a resolvable gap', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    const { questions } = await createCompletedInterviewSnapshot(ticket.id)
    const followUpQuestion = 'Which requirement should the first milestone prioritize?'
    runOpenCodePromptMock.mockResolvedValueOnce({
      session: { id: 'interview-coverage-gaps', projectPath: paths.worktreePath },
      response: [
        'status: gaps',
        'gaps:',
        '  - The first milestone priority is unclear.',
        'follow_up_questions:',
        `  - ${followUpQuestion}`,
      ].join('\n'),
      messages: [],
    })
    const sendEvent = vi.fn()

    await handleCoverageVerification(ticket.id, context, sendEvent, 'interview', new AbortController().signal)

    const persistedSnapshot = JSON.parse(getLatestPhaseArtifact(ticket.id, INTERVIEW_SESSION_ARTIFACT)!.content)
    expect(persistedSnapshot.currentBatch).toMatchObject({
      source: 'coverage',
      batchNumber: 2,
      questions: [expect.objectContaining({
        question: followUpQuestion,
        source: 'coverage_follow_up',
        roundNumber: 1,
      })],
    })
    expect(persistedSnapshot.questions).toHaveLength(questions.length + 1)
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'interview_coverage', 'VERIFYING_INTERVIEW_COVERAGE')!.content)).toMatchObject({
      hasGaps: true,
      coverageRunNumber: 1,
      terminationReason: 'gaps',
    })
    expect(sendEvent).toHaveBeenCalledWith({ type: 'GAPS_FOUND' })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'COVERAGE_LIMIT_REACHED' })
  })
})

describe('performCoverageExtraFix', () => {
  it('returns no-op states and rejects a PRD fix without its winner answers', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    const params = { ticketId: ticket.id, context, domain: 'prd' as const, signal: new AbortController().signal }

    await expect(performCoverageExtraFix(params)).resolves.toMatchObject({ noOp: true, remainingGaps: [] })

    insertPhaseArtifact(ticket.id, {
      phase: 'WAITING_PRD_APPROVAL',
      artifactType: 'prd_coverage',
      content: JSON.stringify({ status: 'clean', remainingGaps: [] }),
    })
    await expect(performCoverageExtraFix(params)).resolves.toMatchObject({ noOp: true, status: 'clean' })

    insertPhaseArtifact(ticket.id, {
      phase: 'VERIFYING_PRD_COVERAGE',
      artifactType: 'prd_coverage',
      content: JSON.stringify({ gaps: ['  Keep retry diagnostics visible.  ', 7, '  '] }),
    })
    await expect(performCoverageExtraFix(params)).rejects.toThrow('No persisted council winner found for prd coverage extra fix')

    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_PRD',
      artifactType: 'prd_winner',
      content: JSON.stringify({ winnerId: 'winner-without-answers' }),
    })
    await expect(performCoverageExtraFix(params)).rejects.toThrow("PRD extra fix requires the winning model's Full Answers artifact")
  })

  it('requires an approved PRD and semantic beads before a beads fix', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    const params = { ticketId: ticket.id, context, domain: 'beads' as const, signal: new AbortController().signal }
    insertPhaseArtifact(ticket.id, {
      phase: 'WAITING_BEADS_APPROVAL',
      artifactType: 'beads_coverage',
      content: JSON.stringify({ status: 'gaps', remainingGaps: ['Preserve the validated plan.'] }),
    })
    insertPhaseArtifact(ticket.id, {
      phase: 'REFINING_BEADS',
      artifactType: 'beads_winner',
      content: JSON.stringify({ winnerId: 'beads-winner' }),
    })
    writeFileSync(`${paths.ticketDir}/prd.yaml`, '')

    await expect(performCoverageExtraFix(params)).rejects.toThrow('Beads extra fix requires an approved PRD artifact.')

    writeFileSync(`${paths.ticketDir}/prd.yaml`, makePrdYaml({ ticketId: ticket.externalId }))
    await expect(performCoverageExtraFix(params)).rejects.toThrow('Beads extra fix requires a semantic beads blueprint')
  })
})

describe('final-test retry notes', () => {
  it('builds and persists a model retry note with command diagnostics', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    runOpenCodePromptMock.mockResolvedValueOnce({
      session: { id: 'retry-note-session' },
      response: '  Keep the observed failure while fixing the test.  ',
      messages: [],
    })

    executeFinalTestWithRetriesMock.mockImplementationOnce(async (...args: Parameters<typeof executeFinalTestWithRetries>) => {
      const callbacks = args[5]
      const command = {
        command: { mode: 'shell', shell: 'posix', script: 'npm test', cwd: '.', env: {} },
        displayCommand: 'npm test',
        exitCode: null,
        signal: null,
        stdout: 'expected value was different',
        stderr: 'stack trace',
        durationMs: 42,
        timedOut: true,
      }
      const failedReport: FinalTestExecutionReport = {
        status: 'failed',
        passed: false,
        checkedAt: TEST.timestamp,
        plannedBy: TEST.implementer,
        summary: 'Check retry reporting.',
        testFiles: ['tests/sample.test.ts'],
        modifiedFiles: [],
        fileEffects: [],
        testsCount: 1,
        modelOutput: '<FINAL_TEST_COMMANDS>failed plan</FINAL_TEST_COMMANDS>',
        commands: [command],
        errors: [],
      }
      const generation: FinalTestGenerationResult = {
        output: failedReport.modelOutput,
        commandPlan: {
          markerFound: true,
          commands: [],
          summary: null,
          testFiles: [],
          modifiedFiles: [],
          fileEffects: [],
          testsCount: null,
          errors: ['The plan could not run.'],
        },
        structuredOutput: { repairApplied: false, repairWarnings: [], autoRetryCount: 0 },
      }
      const note = await callbacks.generateRetryNote?.({ attempt: 1, report: failedReport, generation, notes: [] })
      expect(note).toBe('Keep the observed failure while fixing the test.')
      await callbacks.onFailedAttempt?.({
        attempt: 1,
        report: failedReport,
        generation,
        note: note!,
        notes: [note!],
        canRetry: true,
      })

      return {
        ...failedReport,
        status: 'passed',
        passed: true,
        commands: [{ ...command, exitCode: 0, timedOut: false, stdout: 'ok', stderr: '' }],
        errors: [],
        attempt: 2,
        maxIterations: 2,
        attemptHistory: [],
        retryNotes: [note!],
      }
    })

    const sendEvent = vi.fn()
    await handleFinalTest(ticket.id, context, sendEvent, new AbortController().signal)

    const prompt = runOpenCodePromptMock.mock.calls[0]?.[0]
    expect(prompt.parts[0]?.content).toContain('timed out after 42ms')
    expect(prompt.parts[0]?.content).toContain('expected value was different')
    expect(prompt.parts[0]?.content).toContain('The plan could not run.')
    expect(JSON.parse(getLatestPhaseArtifact(ticket.id, 'final_test_retry_notes', 'RUNNING_FINAL_TEST')!.content)).toEqual({
      notes: ['Keep the observed failure while fixing the test.'],
    })
    expect(sendEvent).toHaveBeenCalledWith({ type: 'TESTS_PASSED' })
  })
})
