import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { makeBeadsYaml, makeTicketContextFromTicket, TEST } from '../../test/factories'
import { createInitializedTestTicket as createGitBackedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { createTicket, getLatestPhaseArtifact, getTicketPaths, upsertLatestPhaseArtifact } from '../../storage/tickets'
import { attachProject, updateProject } from '../../storage/projects'
import { resolveContainedPath } from '../../lib/containedPath'
import type {
  ExecutionSetupProfile,
  ExecutionSetupReport,
  ExecutionSetupResult,
} from '../../phases/executionSetup/types'
import type { ExecutionSetupAttemptTiming } from '../../phases/executionSetup/executor'
import type { OpenCodeResponseMeta } from '../../opencode/assistantMessageAnalysis'
import type { PromptPart, Session, StreamEvent } from '../../opencode/types'
import type { OpenCodePromptCompletedEvent, OpenCodePromptDispatchEvent } from '../runOpenCodePrompt'
import {
  clearAllPendingSessionContinuationsForTests,
  requestSessionContinuation,
} from '../../opencode/sessionContinuation'
import { SessionManager } from '../../opencode/sessionManager'
import { createShellCommandSpec } from '@shared/commandSpec'
import { detectHostContext } from '../../lib/hostContext'
import type { CommandSpec } from '@shared/commandSpec'

const executionSetupWrapperPath = `.ticket/runtime/execution-setup/run${process.platform === 'win32' ? '.cmd' : ''}`
const executionSetupWrapperArtifact = {
  path: executionSetupWrapperPath,
  kind: 'command-wrapper' as const,
  purpose: 'sources prepared runtime before commands',
}

const {
  executeExecutionSetupWithRetriesMock,
  runOpenCodeSessionPromptMock,
  recordWorktreeStartCommitMock,
  resetWorktreeToCommitMock,
  isMockOpenCodeModeMock,
  materializeExecutionSetupWorkspaceInputsMock,
} = vi.hoisted(() => ({
  executeExecutionSetupWithRetriesMock: vi.fn(),
  runOpenCodeSessionPromptMock: vi.fn(),
  recordWorktreeStartCommitMock: vi.fn(),
  resetWorktreeToCommitMock: vi.fn(),
  isMockOpenCodeModeMock: vi.fn(),
  materializeExecutionSetupWorkspaceInputsMock: vi.fn(() => ({ copiedPaths: [] })),
}))

vi.mock('../../phases/executionSetup/executor', () => ({
  executeExecutionSetupWithRetries: executeExecutionSetupWithRetriesMock,
}))

vi.mock('../runOpenCodePrompt', async () => {
  const actual = await vi.importActual<typeof import('../runOpenCodePrompt')>('../runOpenCodePrompt')
  return { ...actual, runOpenCodeSessionPrompt: runOpenCodeSessionPromptMock }
})

vi.mock('../../phases/execution/gitOps', () => ({
  WORKTREE_RESET_PRESERVE_PATHS: ['.ticket'],
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

vi.mock('../../phases/executionSetup/workspaceInputs', () => ({
  materializeExecutionSetupWorkspaceInputs: materializeExecutionSetupWorkspaceInputsMock,
}))

import { handleExecutionSetup } from '../phases/executionSetupPhase'

const repoManager = createTestRepoManager('execution-setup-phase-')

function createExecutionSetupTestTicket(overrides: { title: string }) {
  const repoDir = repoManager.createRepo()
  const project = attachProject({ folderPath: repoDir, name: TEST.projectName, shortname: TEST.shortname })
  const ticket = createTicket({ projectId: project.id, title: overrides.title, description: 'Test description.' })
  const paths = getTicketPaths(ticket.id)
  if (!paths) throw new Error('Expected ticket paths after creation')
  mkdirSync(paths.executionSetupDir, { recursive: true })
  mkdirSync(dirname(paths.beadsPath), { recursive: true })
  return { ticket, context: makeTicketContextFromTicket(ticket), paths }
}

function writeExecutionSetupPlan(
  ticketId: string,
  externalId: string,
  options: {
    gitHookPolicy?: 'validate_advisory' | 'validate_required'
    validationCommands?: Array<{ id: string; hook: string; command: CommandSpec; purpose: string }>
    steps?: Array<{
      id: string
      title: string
      purpose: string
      required: boolean
      rationale: string
      commands: string[]
      cautions: string[]
    }>
  } = {},
) {
  upsertLatestPhaseArtifact(ticketId, 'execution_setup_plan', 'WAITING_EXECUTION_SETUP_APPROVAL', JSON.stringify({
    schema_version: 1,
    ticket_id: externalId,
    artifact: 'execution_setup_plan',
    status: 'draft',
    summary: 'Workspace is ready.',
    readiness: {
      status: 'ready',
      actions_required: false,
      evidence: ['Repository files are present.'],
      gaps: [],
    },
    temp_roots: ['.ticket/runtime/execution-setup'],
    steps: options.steps ?? [],
    project_commands: {
      prepare: [],
      test_full: [],
      lint_full: [],
      typecheck_full: [],
    },
    quality_gate_policy: {
      tests: 'bead-test-commands-first',
      lint: 'impacted-or-package',
      typecheck: 'impacted-or-package',
      full_project_fallback: 'never-block-on-unrelated-baseline',
    },
    git_hooks: {
      policy: options.gitHookPolicy ?? 'validate_advisory',
      validation_commands: options.validationCommands ?? [],
    },
    cautions: [],
  }, null, 2))
}

function readyExecutionSetupReport(ticketId: string): ExecutionSetupReport {
  return {
    status: 'ready' as const,
    ready: true,
    checkedAt: '2026-04-09T12:00:00.000Z',
    preparedBy: TEST.implementer,
    summary: 'ready',
    profile: {
      schemaVersion: 1,
      ticketId,
      artifact: 'execution_setup_profile' as const,
      status: 'ready' as const,
      hostContext: { platform: 'linux', environment: 'native', arch: 'x64', availableShells: ['posix'], preferredShell: 'posix' },
      runtimeEnvironment: { pathPrepend: [], variables: {} },
      summary: 'ready',
      tempRoots: ['.ticket/runtime/execution-setup'],
      workspaceInputs: [],
      bootstrapCommands: [],
      toolingProbeCommands: [],
      workspaceProbes: [],
      gitHooks: {
        policy: 'validate_advisory',
        detected: [],
        validationCommands: [],
      },
      reusableArtifacts: [],
      projectCommands: {
        prepare: [],
        testFull: [],
        lintFull: [],
        typecheckFull: [],
      },
      qualityGatePolicy: {
        tests: 'bead-test-commands-first',
        lint: 'impacted-or-package',
        typecheck: 'impacted-or-package',
        fullProjectFallback: 'never-block-on-unrelated-baseline',
      },
      cautions: [],
    },
    checks: {
      workspace: 'pass',
      tooling: 'pass',
      tempScope: 'pass',
      policy: 'pass',
    },
    modelOutput: '<EXECUTION_SETUP_RESULT>{}</EXECUTION_SETUP_RESULT>',
    errors: [],
  }
}

function readyExecutionSetupProfile(ticketId: string): ExecutionSetupProfile {
  const profile = readyExecutionSetupReport(ticketId).profile
  if (!profile) throw new Error('Expected ready execution setup profile')
  return profile
}

function failedToolRequirementWithAttempts(
  attempts: NonNullable<ExecutionSetupProfile['toolRequirements']>[number]['provisioningAttempts'],
  failureReason = 'tool could not be provisioned',
): NonNullable<ExecutionSetupProfile['toolRequirements']>[number] {
  return {
    launcher: 'project-tool',
    requiredBy: ['project_commands.test_full[0]'],
    status: 'failed',
    missingProbe: 'project-tool --version',
    provisioningAttempts: attempts,
    finalProbe: './.ticket/runtime/execution-setup/run project-tool --version',
    failureReason,
  }
}

function notProvisionableToolRequirement(failureReason: string) {
  return {
    launcher: 'project-tool',
    requiredBy: ['project_commands.test_full[0]'],
    status: 'not_provisionable' as const,
    missingProbe: 'project-tool --version',
    provisioningAttempts: [],
    finalProbe: '',
    failureReason,
  }
}

function buildExecutionSetupGeneration(input: {
  profile: ExecutionSetupProfile
  checks?: ExecutionSetupResult['checks']
  summary?: string
  sessionId?: string
}) {
  return {
    session: { id: input.sessionId ?? 'ses-setup-validation' },
    output: '<EXECUTION_SETUP_RESULT>{"status":"ready"}</EXECUTION_SETUP_RESULT>',
    result: {
      status: 'ready' as const,
      summary: input.summary ?? 'Ready.',
      profile: input.profile,
      checks: input.checks ?? {
        workspace: 'pass',
        tooling: 'pass',
        tempScope: 'pass',
        policy: 'pass',
      },
    },
    parse: {
      markerFound: true,
      result: null,
      errors: [],
    },
    structuredOutput: {
      repairApplied: false,
      repairWarnings: [],
      autoRetryCount: 0,
    },
  }
}

function mockExecutionSetupGeneration(generation: unknown) {
  executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
    const callbacks = args[5] as {
      evaluateGeneration: (entry: { attempt: number; generation: unknown }) => Promise<unknown>
    }
    return callbacks.evaluateGeneration({ attempt: 1, generation })
  })
}

function nodeProcessCommand(script: string): CommandSpec {
  return {
    mode: 'process',
    program: process.execPath,
    args: ['-e', script],
    cwd: '.',
    env: {},
  }
}

function executionSetupWrapperCommand(script: string): CommandSpec {
  return {
    mode: 'process',
    program: `./${executionSetupWrapperPath}`,
    args: [process.execPath, '-e', script],
    cwd: '.',
    env: {},
  }
}

function writeExecutableSetupWrapper(
  wrapperPath: string,
  body = '#!/usr/bin/env sh\nexport LOOP_SETUP_WRAPPER=1\nexec "$@"\n',
) {
  mkdirSync(dirname(wrapperPath), { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(`${wrapperPath}.cmd`, '@echo off\r\nset LOOP_SETUP_WRAPPER=1\r\n%*\r\n')
  } else {
    writeFileSync(wrapperPath, body)
    chmodSync(wrapperPath, 0o755)
  }
}

describe('handleExecutionSetup', () => {
  beforeEach(() => {
    resetTestDb()
    executeExecutionSetupWithRetriesMock.mockReset()
    runOpenCodeSessionPromptMock.mockReset()
    recordWorktreeStartCommitMock.mockReset()
    resetWorktreeToCommitMock.mockReset()
    isMockOpenCodeModeMock.mockReset()
    materializeExecutionSetupWorkspaceInputsMock.mockReset()
    clearAllPendingSessionContinuationsForTests()

    recordWorktreeStartCommitMock.mockReturnValue('setup-start-sha')
    isMockOpenCodeModeMock.mockReturnValue(false)
    materializeExecutionSetupWorkspaceInputsMock.mockReturnValue({ copiedPaths: [] })
  })

  it('stops before setup when OpenCode mock mode is enabled', async () => {
    const { ticket, context } = createExecutionSetupTestTicket({
      title: 'Execution setup mock mode',
    })
    isMockOpenCodeModeMock.mockReturnValueOnce(true)

    const sendEvent = vi.fn()
    await handleExecutionSetup(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ERROR',
      codes: ['MOCK_EXECUTION_UNSUPPORTED'],
    }))
    expect(executeExecutionSetupWithRetriesMock).not.toHaveBeenCalled()
  })

  it.each([
    { remainingMs: undefined, ready: true },
    { remainingMs: 0, ready: false },
  ])('honors the execution setup work budget when validating an approved hook ($remainingMs ms remain)', async ({ remainingMs, ready }) => {
    const { ticket, context, paths } = createExecutionSetupTestTicket({
      title: `Execution setup hook budget ${remainingMs ?? 'unbounded'}`,
    })
    const markerPath = resolveContainedPath(paths.worktreePath, '.ticket/runtime/execution-setup/hook-ran.txt', { allowMissingParents: true })
    const markerScript = `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`
    const command = nodeProcessCommand(markerScript)
    writeExecutionSetupPlan(ticket.id, ticket.externalId, {
      validationCommands: [{
        id: 'write-marker',
        hook: 'pre-commit',
        command,
        purpose: 'Confirm approved hook validation runs within the setup budget.',
      }],
    })

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: {
          attempt: number
          generation: ReturnType<typeof buildExecutionSetupGeneration>
          timing: ExecutionSetupAttemptTiming
        }) => Promise<ExecutionSetupReport>
      }
      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: buildExecutionSetupGeneration({ profile: readyExecutionSetupProfile(ticket.externalId) }),
        timing: {
          timeoutMs: 60_000,
          budget: {
            remainingMs: () => remainingMs,
          } as unknown as NonNullable<ExecutionSetupAttemptTiming['budget']>,
        },
      })
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    if (ready) {
      expect(existsSync(markerPath)).toBe(true)
      expect(sendEvent).toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
    } else {
      expect(existsSync(markerPath)).toBe(false)
      expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'EXECUTION_SETUP_FAILED',
        errors: expect.arrayContaining([expect.stringContaining('while validating Git hooks')]),
      }))
    }
  })

  it.each([
    { policy: 'validate_advisory' as const, ready: true },
    { policy: 'validate_required' as const, ready: false },
  ])('routes hook failures according to the approved $policy policy', async ({ policy, ready }) => {
    const { ticket, context } = createExecutionSetupTestTicket({
      title: `Execution setup ${policy} hook failure`,
    })
    updateProject(ticket.projectId, { gitHookPolicy: policy })
    const passes = nodeProcessCommand('process.exit(0)')
    const fails = nodeProcessCommand('process.stderr.write(String.fromCharCode(104,111,111,107,32,99,104,101,99,107,32,102,97,105,108,101,100)); process.exit(4)')
    writeExecutionSetupPlan(ticket.id, ticket.externalId, {
      gitHookPolicy: policy,
      validationCommands: [
        { id: 'passing-check', hook: 'pre-commit', command: passes, purpose: 'Confirm every approved hook runs.' },
        { id: 'failing-check', hook: 'pre-push', command: fails, purpose: 'Exercise the configured failure policy.' },
      ],
    })

    mockExecutionSetupGeneration(buildExecutionSetupGeneration({ profile: readyExecutionSetupProfile(ticket.externalId) }))

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    const reportArtifact = getLatestPhaseArtifact(ticket.id, 'execution_setup_report', 'PREPARING_EXECUTION_ENV')
    const report = JSON.parse(reportArtifact?.content ?? '{}') as ExecutionSetupReport
    expect(report.profile?.gitHooks.validationReceipts).toMatchObject([
      { id: 'passing-check', status: 'passed' },
      { id: 'failing-check', status: 'failed', outputExcerpt: expect.stringContaining('hook check failed') },
    ])
    expect(report.ready).toBe(ready)
    if (ready) {
      expect(report.profile?.cautions).toEqual(expect.arrayContaining([
        expect.stringContaining('Explicit Git hook validation failed (pre-push)'),
      ]))
      expect(sendEvent).toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
    } else {
      expect(report.errors).toEqual(expect.arrayContaining([
        expect.stringContaining('Explicit Git hook validation failed (pre-push)'),
      ]))
      expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'EXECUTION_SETUP_FAILED' }))
    }
  })

  it('requires a repository-level workspace probe when beads define test commands', async () => {
    const { ticket, context, paths } = createExecutionSetupTestTicket({
      title: 'Execution setup bead test commands need workspace probe',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    writeFileSync(paths.beadsPath, `${JSON.stringify({
      id: 'bead-1',
      title: 'Add a workspace probe',
      status: 'pending',
      testCommands: [createShellCommandSpec('npm run test')],
    })}\n`)

    mockExecutionSetupGeneration(buildExecutionSetupGeneration({ profile: readyExecutionSetupProfile(ticket.externalId) }))

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'EXECUTION_SETUP_FAILED',
      errors: expect.arrayContaining([expect.stringContaining('repository-level workspace_probe')]),
    }))
  })

  it('persists retry notes and reports a terminal tooling blocker', async () => {
    const { ticket, context } = createExecutionSetupTestTicket({
      title: 'Execution setup terminal tooling blocker',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    const profile: ExecutionSetupProfile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      status: 'blocked',
      toolRequirements: [{
        launcher: 'licensed-tool',
        requiredBy: ['project_commands.test_full[0]'],
        status: 'not_provisionable',
        missingProbe: 'licensed-tool --version',
        provisioningAttempts: [],
        finalProbe: 'licensed-tool --version',
        failureReason: 'The only installer requires an interactive license flow.',
      }],
    }

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      type PhaseGeneration = Omit<ReturnType<typeof buildExecutionSetupGeneration>, 'session'> & {
        session?: { id: string }
      }
      type AttemptMetadata = ExecutionSetupAttemptTiming & {
        baseMaxIterations: number
        isManualContinuationAttempt: boolean
        isExtraToolingPersistenceAttempt: boolean
        extraToolingPersistenceAttempt: number
        maxExtraToolingPersistenceAttempts: number
      }
      const callbacks = args[5] as {
        evaluateGeneration: (entry: {
          attempt: number
          generation: PhaseGeneration
          timing: ExecutionSetupAttemptTiming
        }) => Promise<ExecutionSetupReport>
        onAttemptStart?: (attempt: number, metadata: AttemptMetadata) => void | Promise<void>
        onAttemptComplete?: (entry: { attempt: number; report: ExecutionSetupReport; generation: PhaseGeneration }) => void | Promise<void>
        onRetryAnalysisStart?: (entry: { attempt: number; report: ExecutionSetupReport; generation: PhaseGeneration }) => void | Promise<void>
        generateRetryNote?: (entry: {
          attempt: number
          report: ExecutionSetupReport
          generation: PhaseGeneration
          notes: string[]
          timing: ExecutionSetupAttemptTiming
        }) => Promise<string | null | undefined>
        onFailedAttempt?: (entry: {
          attempt: number
          report: ExecutionSetupReport
          generation: PhaseGeneration
          note: string
          notes: string[]
          canRetry: boolean
        }) => void | Promise<void>
        onRetriesExhausted?: (entry: {
          attempt: number
          maxIterations: number
          report: ExecutionSetupReport
          notes: string[]
          reason?: 'exhausted' | 'repeated_tooling_failure' | 'not_provisionable'
        }) => void | Promise<void>
      }
      const timing = { timeoutMs: 60_000 }
      const generation: PhaseGeneration = {
        ...buildExecutionSetupGeneration({
          profile,
          checks: { workspace: 'pass', tooling: 'fail', tempScope: 'pass', policy: 'pass' },
        }),
        session: undefined,
      }
      await callbacks.onAttemptStart?.(1, {
        ...timing,
        baseMaxIterations: 1,
        isManualContinuationAttempt: false,
        isExtraToolingPersistenceAttempt: false,
        extraToolingPersistenceAttempt: 0,
        maxExtraToolingPersistenceAttempts: 2,
      })
      const report = await callbacks.evaluateGeneration({ attempt: 1, generation, timing })
      await callbacks.onAttemptComplete?.({ attempt: 1, report, generation })
      await callbacks.onRetryAnalysisStart?.({ attempt: 1, report, generation })
      const generatedNote = await callbacks.generateRetryNote?.({
        attempt: 1,
        report,
        generation,
        notes: [],
        timing,
      })
      const note = generatedNote ?? 'Attempt 1 failed because no safe licensed-tool provisioning path is available.'
      const notes = [note]
      await callbacks.onFailedAttempt?.({ attempt: 1, report, generation, note, notes, canRetry: false })
      await callbacks.onRetriesExhausted?.({
        attempt: 1,
        maxIterations: 1,
        report,
        notes,
        reason: 'not_provisionable',
      })
      return { ...report, attempt: 1, maxIterations: 1, attemptHistory: [], retryNotes: notes }
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    const retryNotesArtifact = getLatestPhaseArtifact(ticket.id, 'execution_setup_retry_notes', 'PREPARING_EXECUTION_ENV')
    expect(JSON.parse(retryNotesArtifact?.content ?? '{}').notes).toEqual([
      'Attempt 1 failed because no safe licensed-tool provisioning path is available.',
    ])
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'EXECUTION_SETUP_FAILED',
      errors: expect.arrayContaining([expect.stringContaining('required tools check failed')]),
    }))
  })

  it('reports bootstrap commands that were added beyond the approved setup plan', async () => {
    const { ticket, context } = createExecutionSetupTestTicket({
      title: 'Execution setup command additions',
    })
    const shell = detectHostContext().preferredShell
    const approvedCommand = createShellCommandSpec('npm run setup', shell)
    const addedCommand = createShellCommandSpec('npm run generated-setup', shell)
    writeExecutionSetupPlan(ticket.id, ticket.externalId, {
      steps: [{
        id: 'approved-setup',
        title: 'Run approved setup',
        purpose: 'Install the approved project tooling.',
        required: true,
        rationale: 'The setup plan approved the repository command.',
        commands: ['npm run setup'],
        cautions: [],
      }],
    })

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: {
          attempt: number
          generation: ReturnType<typeof buildExecutionSetupGeneration>
        }) => Promise<ExecutionSetupReport>
      }
      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: buildExecutionSetupGeneration({
          profile: {
            ...readyExecutionSetupProfile(ticket.externalId),
            bootstrapCommands: [approvedCommand, addedCommand],
          },
        }),
      })
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    const reportArtifact = getLatestPhaseArtifact(ticket.id, 'execution_setup_report', 'PREPARING_EXECUTION_ENV')
    const report = JSON.parse(reportArtifact?.content ?? '{}') as ExecutionSetupReport
    expect(report.approvedPlanCommands).toEqual([approvedCommand])
    expect(report.executionAddedCommands).toEqual([addedCommand])
    expect(sendEvent).toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it('persists session, stream, prompt, and structured-retry milestones from the setup runner', async () => {
    const { ticket, context, paths } = await createGitBackedTestTicket(repoManager, {
      title: 'Execution setup OpenCode event logs',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    mkdirSync(join(paths.worktreePath, 'node_modules', 'generated-package'), { recursive: true })
    writeFileSync(join(paths.worktreePath, 'node_modules', 'generated-package', 'index.js'), 'module.exports = 1\n')
    const session: Session = { id: 'ses-setup-event-logs' }
    const promptDispatched: OpenCodePromptDispatchEvent = {
      session,
      parts: [],
      promptText: 'Prepare the approved workspace.',
      promptNumber: 1,
      timeoutKind: 'execution_setup',
      model: TEST.implementer,
    }
    const promptCompleted: OpenCodePromptCompletedEvent = {
      session,
      parts: [],
      response: 'Workspace inspection started.',
      messages: [],
      responseMeta: {
        hasAssistantMessage: true,
        latestAssistantWasEmpty: false,
        latestAssistantHasError: false,
        latestAssistantWasStale: false,
      } satisfies OpenCodeResponseMeta,
      attemptMeta: {
        outcome: 'clean',
        responseAccepted: true,
        discardedResponse: false,
        sessionErrored: false,
        latestAssistantErrored: false,
      },
    }

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: {
          attempt: number
          generation: ReturnType<typeof buildExecutionSetupGeneration>
        }) => Promise<ExecutionSetupReport>
        onSessionCreated?: (sessionId: string, attempt: number) => void
        onOpenCodeStreamEvent?: (entry: { sessionId: string; attempt: number; event: StreamEvent }) => void
        onPromptDispatched?: (entry: { sessionId: string; attempt: number; event: OpenCodePromptDispatchEvent }) => void
        onPromptCompleted?: (entry: { attempt: number; stage: string; event: OpenCodePromptCompletedEvent }) => void
        onStructuredRetryStart?: (entry: { attempt: number; sessionId: string; retryAttempt: number }) => void
        onAttemptComplete?: (entry: {
          attempt: number
          report: ExecutionSetupReport
          generation: ReturnType<typeof buildExecutionSetupGeneration>
        }) => void | Promise<void>
      }
      callbacks.onSessionCreated?.(session.id, 1)
      callbacks.onOpenCodeStreamEvent?.({
        sessionId: session.id,
        attempt: 1,
        event: {
          type: 'text',
          sessionId: session.id,
          messageId: 'assistant-message',
          partId: 'part-1',
          text: 'Workspace scan started.',
          streaming: true,
          complete: false,
        },
      })
      callbacks.onPromptDispatched?.({ sessionId: session.id, attempt: 1, event: promptDispatched })
      callbacks.onPromptCompleted?.({ attempt: 1, stage: 'execution_setup', event: promptCompleted })
      callbacks.onStructuredRetryStart?.({ attempt: 1, sessionId: session.id, retryAttempt: 1 })
      const generation = buildExecutionSetupGeneration({
        profile: readyExecutionSetupProfile(ticket.externalId),
        checks: { workspace: 'pass', tooling: 'fail', tempScope: 'pass', policy: 'pass' },
      })
      const report = await callbacks.evaluateGeneration({ attempt: 1, generation })
      await callbacks.onAttemptComplete?.({ attempt: 1, report, generation })
      return report
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    const executionLog = readFileSync(paths.executionLogPath, 'utf8')
    expect(executionLog).toContain('Execution setup attempt 1 session created')
    expect(executionLog).toContain('Prepare the approved workspace.')
    expect(executionLog).toContain('OpenCode execution_setup:')
    expect(executionLog).toContain('Correcting the structured execution setup result')
    expect(executionLog).toContain('Suggested .gitignore entries: node_modules/')
  })

  it('generates a same-session retry note and forwards its prompt lifecycle logs', async () => {
    const { ticket, context, paths } = createExecutionSetupTestTicket({
      title: 'Execution setup retry prompt lifecycle',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    runOpenCodeSessionPromptMock.mockImplementationOnce(async (input: {
      session: Session
      parts: PromptPart[]
      timeoutMs?: number
      timeoutKind?: string
      onPromptDispatched?: (event: OpenCodePromptDispatchEvent) => void
      onPromptCompleted?: (event: OpenCodePromptCompletedEvent) => void
    }) => {
      const responseMeta: OpenCodeResponseMeta = {
        hasAssistantMessage: true,
        latestAssistantWasEmpty: false,
        latestAssistantHasError: false,
        latestAssistantWasStale: false,
      }
      const attemptMeta = {
        outcome: 'clean' as const,
        responseAccepted: true,
        discardedResponse: false,
        sessionErrored: false,
        latestAssistantErrored: false,
      }
      input.onPromptDispatched?.({
        session: input.session,
        parts: input.parts,
        promptText: 'Summarize the setup failure and propose a safe next step.',
        promptNumber: 2,
        timeoutKind: 'execution_setup',
      })
      input.onPromptCompleted?.({
        session: input.session,
        parts: input.parts,
        response: 'Try the repository toolchain.',
        messages: [],
        responseMeta,
        attemptMeta,
      })
      return {
        session: input.session,
        response: '  Try the repository toolchain.  ',
        messages: [],
        responseMeta,
        attemptMeta,
      }
    })

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: {
          attempt: number
          generation: ReturnType<typeof buildExecutionSetupGeneration>
          timing: ExecutionSetupAttemptTiming
        }) => Promise<ExecutionSetupReport>
        generateRetryNote?: (entry: {
          attempt: number
          report: ExecutionSetupReport
          generation: ReturnType<typeof buildExecutionSetupGeneration>
          notes: string[]
          timing: ExecutionSetupAttemptTiming
        }) => Promise<string | null | undefined>
      }
      const generation = buildExecutionSetupGeneration({
        profile: readyExecutionSetupProfile(ticket.externalId),
        checks: { workspace: 'pass', tooling: 'fail', tempScope: 'pass', policy: 'pass' },
      })
      const timing = { timeoutMs: 60_000 }
      const report = await callbacks.evaluateGeneration({ attempt: 1, generation, timing })
      const note = await callbacks.generateRetryNote?.({ attempt: 1, report, generation, notes: [], timing })
      expect(note).toBe('Try the repository toolchain.')
      return report
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    expect(runOpenCodeSessionPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      session: { id: 'ses-setup-validation' },
      timeoutMs: 60_000,
      timeoutKind: 'execution_setup',
    }))
    const executionLog = readFileSync(paths.executionLogPath, 'utf8')
    expect(executionLog).toContain('Summarize the setup failure and propose a safe next step.')
    expect(executionLog).toContain('OpenCode execution_setup_note:')
  })

  it('runs one numbered manual attempt after the latest persisted setup report', async () => {
    const { ticket, context } = createExecutionSetupTestTicket({
      title: 'Execution setup manual session retry',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    upsertLatestPhaseArtifact(
      ticket.id,
      'execution_setup_retry_notes',
      'PREPARING_EXECUTION_ENV',
      JSON.stringify({ notes: ['Older note that does not reflect every attempt.'] }),
    )
    upsertLatestPhaseArtifact(
      ticket.id,
      'execution_setup_report',
      'PREPARING_EXECUTION_ENV',
      JSON.stringify({ attempt: 5, status: 'failed' }),
    )
    requestSessionContinuation({
      ticketId: ticket.id,
      phase: 'PREPARING_EXECUTION_ENV',
      sessionId: 'ses-setup-5',
      prompt: 'Create file x first.',
      additionalRetryAttempts: 1,
    })
    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      expect(args[4]).toMatchObject({
        initialAttempt: 6,
        additionalManualIterations: 1,
      })
      return readyExecutionSetupReport(ticket.externalId)
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it('keeps an honest blocked profile diagnostic-only and does not publish it as reusable runtime state', async () => {
    const { ticket, context, paths } = createExecutionSetupTestTicket({
      title: 'Execution setup honest blocked result',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    const blockedProfile: ExecutionSetupProfile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      status: 'blocked',
      summary: 'The required launcher has no safe temporary provisioning path.',
      toolRequirements: [{
        launcher: 'project-tool',
        requiredBy: ['project_commands.test_full[0]'],
        status: 'not_provisionable',
        missingProbe: 'project-tool --version',
        provisioningAttempts: [],
        finalProbe: 'project-tool --version',
        failureReason: 'No compatible user-space artifact is available.',
      }],
    }
    executeExecutionSetupWithRetriesMock.mockResolvedValueOnce({
      status: 'failed',
      ready: false,
      checkedAt: '2026-07-23T12:00:00.000Z',
      preparedBy: TEST.implementer,
      summary: 'Workspace setup is blocked.',
      profile: blockedProfile,
      checks: {
        workspace: 'pass',
        tooling: 'fail',
        tempScope: 'pass',
        policy: 'pass',
      },
      modelOutput: '<EXECUTION_SETUP_RESULT>{"status":"blocked"}</EXECUTION_SETUP_RESULT>',
      errors: ['The required launcher could not be prepared safely.'],
    } satisfies ExecutionSetupReport)

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'EXECUTION_SETUP_FAILED',
      errors: ['The required launcher could not be prepared safely.'],
    })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
    expect(getLatestPhaseArtifact(ticket.id, 'execution_setup_profile', 'PREPARING_EXECUTION_ENV')).toBeUndefined()
    expect(existsSync(paths.executionSetupProfilePath)).toBe(false)

    const reportArtifact = getLatestPhaseArtifact(ticket.id, 'execution_setup_report', 'PREPARING_EXECUTION_ENV')
    expect(JSON.parse(reportArtifact?.content ?? '{}')).toMatchObject({
      status: 'failed',
      ready: false,
      profile: { status: 'blocked' },
    })
  })

  it('rejects an otherwise ready profile after the aggregate setup-attempt deadline expires', async () => {
    const { ticket, context } = createExecutionSetupTestTicket({
      title: 'Execution setup aggregate deadline',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: {
          attempt: number
          generation: ReturnType<typeof buildExecutionSetupGeneration>
          timing: { timeoutMs: number; timeoutDeadline: number }
        }) => Promise<ExecutionSetupReport>
      }
      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: buildExecutionSetupGeneration({
          profile: readyExecutionSetupProfile(ticket.externalId),
        }),
        timing: {
          timeoutMs: 60_000,
          timeoutDeadline: Date.now() - 1,
        },
      })
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'EXECUTION_SETUP_FAILED',
      errors: [expect.stringContaining('configured 60-second timeout')],
    })
    expect(getLatestPhaseArtifact(ticket.id, 'execution_setup_profile', 'PREPARING_EXECUTION_ENV')).toBeUndefined()
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it('reports an unreadable bead tracker instead of treating it as having no test commands', async () => {
    const { ticket, context, paths } = createExecutionSetupTestTicket({
      title: 'Execution setup malformed bead tracker',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    writeFileSync(paths.beadsPath, '{"id":"bead-1","testCommands":[]}\nnot-json\n')

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: { attempt: number; generation: unknown }) => Promise<ExecutionSetupReport>
      }
      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: buildExecutionSetupGeneration({ profile: readyExecutionSetupProfile(ticket.externalId) }),
      })
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'EXECUTION_SETUP_FAILED',
      errors: [expect.stringContaining('unparseable JSON at line(s) 2')],
    })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it('caps backend setup probes at the time remaining in the aggregate attempt', async () => {
    const { ticket, context } = createExecutionSetupTestTicket({
      title: 'Execution setup remaining validation budget',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    const slowProbe = nodeProcessCommand('setTimeout(() => {}, 1000)')

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: {
          attempt: number
          generation: ReturnType<typeof buildExecutionSetupGeneration>
          timing: { timeoutMs: number; timeoutDeadline: number }
        }) => Promise<ExecutionSetupReport>
      }
      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: buildExecutionSetupGeneration({
          profile: {
            ...readyExecutionSetupProfile(ticket.externalId),
            toolingProbeCommands: [slowProbe],
          },
        }),
        timing: {
          timeoutMs: 60_000,
          timeoutDeadline: Date.now() + 75,
        },
      })
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      { ...context, lockedMainImplementer: TEST.implementer },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'EXECUTION_SETUP_FAILED',
      errors: [expect.stringContaining('configured 60-second timeout while running tooling probes')],
    })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('preserves LoopTroop ticket artifacts when resetting before an execution-setup retry', async () => {
    const { ticket, context, paths } = createExecutionSetupTestTicket({
      title: 'Execution setup reset preservation',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    writeFileSync(paths.beadsPath, makeBeadsYaml({ beadCount: 1 }))
    mkdirSync(join(paths.executionSetupDir, 'tool-cache', 'go'), { recursive: true })
    writeFileSync(join(paths.executionSetupDir, 'tool-cache', 'go', 'VERSION'), 'go1.25.0\n')
    writeFileSync(join(paths.executionSetupDir, 'env.sh'), 'export PATH=tool-cache/go/bin:$PATH\n')
    writeFileSync(join(paths.executionSetupDir, 'run'), '#!/usr/bin/env sh\n. .ticket/runtime/execution-setup/env.sh\nexec "$@"\n')
    writeFileSync(paths.executionSetupProfilePath, '{"status":"stale"}\n')

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        beforeRetry: (entry: {
          attempt: number
          nextAttempt: number
          report: unknown
          generation: { session: { id: string } }
          note: string
          notes: string[]
        }) => Promise<void> | void
      }
      await callbacks.beforeRetry({
        attempt: 1,
        nextAttempt: 2,
        report: { ready: false },
        generation: { session: { id: 'ses-setup-1' } },
        note: 'retry after failed setup',
        notes: ['retry after failed setup'],
      })
      return readyExecutionSetupReport(ticket.externalId)
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
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
      'setup-start-sha',
      expect.objectContaining({
        preservePaths: expect.arrayContaining(['.ticket']),
      }),
    )
    expect(materializeExecutionSetupWorkspaceInputsMock).toHaveBeenCalledTimes(2)
    expect(materializeExecutionSetupWorkspaceInputsMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      projectRoot: paths.projectRoot,
      worktreePath: paths.worktreePath,
      workspaceInputs: [],
    }))
    expect(materializeExecutionSetupWorkspaceInputsMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      projectRoot: paths.projectRoot,
      worktreePath: paths.worktreePath,
      workspaceInputs: [],
    }))
    expect(existsSync(join(paths.executionSetupDir, 'tool-cache', 'go', 'VERSION'))).toBe(true)
    expect(existsSync(join(paths.executionSetupDir, 'env.sh'))).toBe(false)
    expect(existsSync(join(paths.executionSetupDir, 'run'))).toBe(false)
    expect(existsSync(paths.executionSetupProfilePath)).toBe(true)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it('withholds the execution-setup reset until a paused session stop is confirmed', async () => {
    const { ticket, context, paths } = createExecutionSetupTestTicket({
      title: 'Execution setup remote stop confirmation',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    const stopSession = vi.spyOn(SessionManager.prototype, 'abortAndAbandonSession')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const invokeRetry = async () => {
      executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
        const callbacks = args[5] as {
          beforeRetry: (entry: {
            attempt: number
            nextAttempt: number
            report: unknown
            generation: { session: { id: string } }
            note: string
            notes: string[]
          }) => Promise<void>
        }
        await callbacks.beforeRetry({
          attempt: 1,
          nextAttempt: 2,
          report: { ready: false },
          generation: { session: { id: 'ses-setup-paused' } },
          note: 'retry after remote stop check',
          notes: ['retry after remote stop check'],
        })
        return readyExecutionSetupReport(ticket.externalId)
      })
      return handleExecutionSetup(
        ticket.id,
        { ...context, lockedMainImplementer: TEST.implementer },
        vi.fn(),
        new AbortController().signal,
      )
    }

    await expect(invokeRetry()).rejects.toThrow('Could not confirm abort of execution setup session ses-setup-paused')
    expect(resetWorktreeToCommitMock).not.toHaveBeenCalled()

    await invokeRetry()
    expect(stopSession).toHaveBeenCalledTimes(2)
    expect(resetWorktreeToCommitMock).toHaveBeenCalledWith(
      paths.worktreePath,
      'setup-start-sha',
      expect.objectContaining({ preservePaths: expect.arrayContaining(['.ticket']) }),
    )
  })

  it('rejects a schema-compatible setup result when tooling checks fail', async () => {
    const { ticket, context } = createExecutionSetupTestTicket({
      title: 'Execution setup tooling gate',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    mockExecutionSetupGeneration(buildExecutionSetupGeneration({
      profile: readyExecutionSetupProfile(ticket.externalId),
      summary: 'Required launcher is unavailable.',
      sessionId: 'ses-setup-tooling-fail',
      checks: {
        workspace: 'pass',
        tooling: 'fail',
        tempScope: 'pass',
        policy: 'pass',
      },
    }))

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      {
        ...context,
        lockedMainImplementer: TEST.implementer,
      },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'EXECUTION_SETUP_FAILED',
      errors: expect.arrayContaining([
        'Workspace setup cannot continue because the required tools check failed. Required launcher is unavailable.',
        expect.stringContaining('tool_requirements evidence'),
      ]),
    })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it.each([
    {
      title: 'one failed provisioning strategy',
      toolRequirements: [
        failedToolRequirementWithAttempts([
          {
            strategy: 'official archive',
            commands: [createShellCommandSpec('./install-project-tool --prefix .ticket/runtime/execution-setup/tool-cache/project-tool')],
            result: 'failed',
            reason: 'official archive download returned 404',
          },
        ]),
      ],
    },
    {
      title: 'duplicate failed provisioning strategy names',
      toolRequirements: [
        failedToolRequirementWithAttempts([
          {
            strategy: 'official archive',
            commands: [createShellCommandSpec('./install-project-tool --prefix .ticket/runtime/execution-setup/tool-cache/project-tool')],
            result: 'failed',
            reason: 'official archive download returned 404',
          },
          {
            strategy: 'official archive',
            commands: [createShellCommandSpec('./install-project-tool --channel stable --prefix .ticket/runtime/execution-setup/tool-cache/project-tool')],
            result: 'failed',
            reason: 'same strategy label should not count twice',
          },
        ]),
      ],
    },
    {
      title: 'empty provisioning commands',
      toolRequirements: [
        failedToolRequirementWithAttempts([
          {
            strategy: 'official archive',
            commands: [],
            result: 'failed',
            reason: 'empty commands should not count',
          },
          {
            strategy: 'repository version manager',
            commands: [createShellCommandSpec('   ')],
            result: 'failed',
            reason: 'blank commands should not count',
          },
        ]),
      ],
    },
    {
      title: 'not provisionable without reason',
      toolRequirements: [
        notProvisionableToolRequirement(''),
      ],
    },
  ])('rejects incomplete tooling failure evidence for $title', async ({ title, toolRequirements }) => {
    const { ticket, context } = createExecutionSetupTestTicket({
      title: `Execution setup ${title}`,
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    const profile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      toolRequirements,
    }

    mockExecutionSetupGeneration(buildExecutionSetupGeneration({
      profile,
      checks: { workspace: 'pass', tooling: 'fail', tempScope: 'pass', policy: 'pass' },
    }))

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      {
        ...context,
        lockedMainImplementer: TEST.implementer,
      },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'EXECUTION_SETUP_FAILED',
      errors: expect.arrayContaining([
        'Workspace setup cannot continue because the required tools check failed. Ready.',
        expect.stringContaining('provisioning_attempts'),
      ]),
    })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it.each([
    {
      title: 'failed provisioning evidence',
      toolRequirements: [
        failedToolRequirementWithAttempts([
          {
            strategy: 'official archive',
            commands: [createShellCommandSpec('./install-project-tool --prefix .ticket/runtime/execution-setup/tool-cache/project-tool')],
            result: 'failed',
            reason: 'official archive download returned 404',
          },
          {
            strategy: 'repository version manager',
            commands: [createShellCommandSpec('./repo-toolchain install --cache .ticket/runtime/execution-setup/tool-cache/project-tool')],
            result: 'failed',
            reason: 'repository version manager could not resolve the requested version',
          },
        ], 'official archive download returned 404'),
      ],
    },
    {
      title: 'no safe provisioning path evidence',
      toolRequirements: [
        notProvisionableToolRequirement('the repository requires a licensed interactive installer that cannot run safely in temp roots'),
      ],
    },
  ])('accepts tooling failure evidence for $title', async ({ title, toolRequirements }) => {
    const { ticket, context } = createExecutionSetupTestTicket({
      title: `Execution setup ${title}`,
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    const profile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      toolRequirements,
    }

    mockExecutionSetupGeneration(buildExecutionSetupGeneration({
      profile,
      checks: { workspace: 'pass', tooling: 'fail', tempScope: 'pass', policy: 'pass' },
    }))

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      {
        ...context,
        lockedMainImplementer: TEST.implementer,
      },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'EXECUTION_SETUP_FAILED',
      errors: ['Workspace setup cannot continue because the required tools check failed. Ready.'],
    })
    expect(sendEvent).not.toHaveBeenCalledWith({
      type: 'EXECUTION_SETUP_FAILED',
      errors: expect.arrayContaining([expect.stringContaining('tool_requirements evidence')]),
    })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it('rejects a ready setup profile that declares reusable command execution without tooling probes', async () => {
    const { ticket, context, paths } = createExecutionSetupTestTicket({
      title: 'Execution setup missing probes gate',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    writeExecutableSetupWrapper(join(paths.executionSetupDir, 'run'))

    const profile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      reusableArtifacts: [executionSetupWrapperArtifact],
      projectCommands: {
        prepare: [],
        testFull: [createShellCommandSpec('project test')],
        lintFull: [],
        typecheckFull: [],
      },
      toolingProbeCommands: [],
    }

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: { attempt: number; generation: unknown }) => Promise<unknown>
      }
      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: buildExecutionSetupGeneration({ profile }),
      })
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      {
        ...context,
        lockedMainImplementer: TEST.implementer,
      },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'EXECUTION_SETUP_FAILED',
      errors: expect.arrayContaining([expect.stringContaining('tooling_probe_commands')]),
    })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it('rejects a ready setup profile when its declared wrapper is missing', async () => {
    const { ticket, context } = createExecutionSetupTestTicket({
      title: 'Execution setup missing wrapper gate',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    const profile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      reusableArtifacts: [executionSetupWrapperArtifact],
      toolingProbeCommands: [executionSetupWrapperCommand('process.exit(0)')],
    }

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: { attempt: number; generation: unknown }) => Promise<unknown>
      }
      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: buildExecutionSetupGeneration({ profile }),
      })
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      {
        ...context,
        lockedMainImplementer: TEST.implementer,
      },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'EXECUTION_SETUP_FAILED',
      errors: [expect.stringContaining('Execution setup tooling probe failed')],
    })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it('rejects a ready setup profile when a tooling probe fails', async () => {
    const { ticket, context } = createExecutionSetupTestTicket({
      title: 'Execution setup failing probe gate',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    const profile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      projectCommands: {
        prepare: [],
        testFull: [nodeProcessCommand('process.exit(0)')],
        lintFull: [],
        typecheckFull: [],
      },
      toolingProbeCommands: [nodeProcessCommand('process.exit(3)')],
    }

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: { attempt: number; generation: unknown }) => Promise<unknown>
      }
      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: buildExecutionSetupGeneration({ profile }),
      })
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      {
        ...context,
        lockedMainImplementer: TEST.implementer,
      },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'EXECUTION_SETUP_FAILED',
      errors: expect.arrayContaining([expect.stringContaining('Execution setup tooling probe failed')]),
    })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it('accepts a ready setup profile when the wrapper and tooling probe pass', async () => {
    const { ticket, context, paths } = createExecutionSetupTestTicket({
      title: 'Execution setup passing probe gate',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    writeExecutableSetupWrapper(join(paths.executionSetupDir, 'run'))

    const profile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      reusableArtifacts: [executionSetupWrapperArtifact],
      toolingProbeCommands: [executionSetupWrapperCommand("if (process.env.LOOP_SETUP_WRAPPER !== '1') process.exit(9)")],
    }

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: { attempt: number; generation: unknown }) => Promise<unknown>
      }
      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: buildExecutionSetupGeneration({ profile }),
      })
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      {
        ...context,
        lockedMainImplementer: TEST.implementer,
      },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'EXECUTION_SETUP_FAILED' }))
  })

  it.runIf(process.platform !== 'win32')('does not silently apply an unapproved setup wrapper', async () => {
    const { ticket, context, paths } = createExecutionSetupTestTicket({
      title: 'Execution setup canonical wrapper fallback',
    })
    const bareProbeCommand = 'workspace-probe-tool'
    upsertLatestPhaseArtifact(ticket.id, 'execution_setup_plan', 'WAITING_EXECUTION_SETUP_APPROVAL', JSON.stringify({
      schema_version: 1,
      ticket_id: ticket.externalId,
      artifact: 'execution_setup_plan',
      status: 'draft',
      summary: 'Validate the prepared workspace tool.',
      readiness: {
        status: 'partial',
        actions_required: true,
        evidence: ['The repository is present.'],
        gaps: ['The workspace probe tool requires the prepared runtime.'],
      },
      temp_roots: ['.ticket/runtime/execution-setup'],
      workspace_probes: [{
        id: 'prepared-workspace-probe',
        command: bareProbeCommand,
        purpose: 'Prove that the prepared runtime is applied to an approved bare command.',
      }],
      steps: [{
        id: 'prepare-probe-tool',
        title: 'Prepare workspace probe tool',
        purpose: 'Provide the repository workspace probe through the private runtime.',
        required: true,
        rationale: 'Exercise the private runtime handoff.',
        commands: [],
        cautions: [],
      }],
      project_commands: {
        prepare: [],
        test_full: [],
        lint_full: [],
        typecheck_full: [],
      },
      quality_gate_policy: {
        tests: 'bead-test-commands-first',
        lint: 'impacted-or-package',
        typecheck: 'impacted-or-package',
        full_project_fallback: 'never-block-on-unrelated-baseline',
      },
      cautions: [],
    }, null, 2))

    const toolDirectory = join(paths.executionSetupDir, 'tools')
    mkdirSync(toolDirectory, { recursive: true })
    writeExecutableSetupWrapper(
      join(toolDirectory, bareProbeCommand),
      '#!/usr/bin/env sh\nprintf prepared-workspace\n',
    )
    writeExecutableSetupWrapper(
      join(paths.executionSetupDir, 'run'),
      '#!/usr/bin/env sh\nRUNTIME_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport PATH="$RUNTIME_DIR/tools:$PATH"\nexec "$@"\n',
    )

    const profile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      reusableArtifacts: [],
      toolingProbeCommands: [createShellCommandSpec(bareProbeCommand)],
    }
    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: { attempt: number; generation: unknown }) => Promise<unknown>
      }
      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: buildExecutionSetupGeneration({ profile }),
      })
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      {
        ...context,
        lockedMainImplementer: TEST.implementer,
      },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'EXECUTION_SETUP_FAILED',
      errors: expect.arrayContaining([expect.stringContaining('not found')]),
    }))
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it('rejects a ready setup result when setup leaves committable project changes', async () => {
    const { ticket, context, paths } = await createGitBackedTestTicket(repoManager, {
      title: 'Execution setup dirty worktree gate',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: { attempt: number; generation: unknown }) => Promise<unknown>
      }
      writeFileSync(join(paths.worktreePath, 'setup-dirty.cs'), 'namespace Dirty;\n')

      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: {
          session: { id: 'ses-setup-dirty' },
          output: '<EXECUTION_SETUP_RESULT>{"status":"ready"}</EXECUTION_SETUP_RESULT>',
          result: {
            status: 'ready',
            summary: 'Ready but dirty.',
            profile: readyExecutionSetupProfile(ticket.externalId),
            checks: {
              workspace: 'pass',
              tooling: 'pass',
              tempScope: 'pass',
              policy: 'pass',
            },
          },
          parse: {
            markerFound: true,
            result: null,
            errors: [],
          },
          structuredOutput: {
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 0,
          },
        },
      })
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      {
        ...context,
        lockedMainImplementer: TEST.implementer,
      },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'EXECUTION_SETUP_FAILED',
      errors: [expect.stringContaining('setup-dirty.cs')],
    })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it('allows generated setup noise but records gitignore suggestions as profile cautions', async () => {
    const { ticket, context, paths } = await createGitBackedTestTicket(repoManager, {
      title: 'Execution setup generated noise warning',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: { attempt: number; generation: unknown }) => Promise<unknown>
      }
      mkdirSync(join(paths.worktreePath, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(paths.worktreePath, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')

      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: {
          session: { id: 'ses-setup-generated-noise' },
          output: '<EXECUTION_SETUP_RESULT>{"status":"ready"}</EXECUTION_SETUP_RESULT>',
          result: {
            status: 'ready',
            summary: 'Ready with generated noise.',
            profile: readyExecutionSetupProfile(ticket.externalId),
            checks: {
              workspace: 'pass',
              tooling: 'pass',
              tempScope: 'pass',
              policy: 'pass',
            },
          },
          parse: {
            markerFound: true,
            result: null,
            errors: [],
          },
          structuredOutput: {
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 0,
          },
        },
      })
    })

    const sendEvent = vi.fn()
    await handleExecutionSetup(
      ticket.id,
      {
        ...context,
        lockedMainImplementer: TEST.implementer,
      },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
    const profileArtifact = getLatestPhaseArtifact(ticket.id, 'execution_setup_profile', 'PREPARING_EXECUTION_ENV')
    expect(profileArtifact?.content).toContain('node_modules/pkg/index.js')
    expect(profileArtifact?.content).toContain('Suggested .gitignore entries: node_modules/')
  })
})
