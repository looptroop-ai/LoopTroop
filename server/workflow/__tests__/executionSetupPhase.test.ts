import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { makeBeadsYaml, TEST } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { getLatestPhaseArtifact, upsertLatestPhaseArtifact } from '../../storage/tickets'
import { quoteShellArg } from '../../lib/shellCommand'
import type {
  ExecutionSetupProfile,
  ExecutionSetupReport,
  ExecutionSetupResult,
} from '../../phases/executionSetup/types'
import {
  clearAllPendingSessionContinuationsForTests,
  requestSessionContinuation,
} from '../../opencode/sessionContinuation'
import { createShellCommandSpec } from '@shared/commandSpec'

const {
  executeExecutionSetupWithRetriesMock,
  recordWorktreeStartCommitMock,
  resetWorktreeToCommitMock,
  isMockOpenCodeModeMock,
  materializeExecutionSetupWorkspaceInputsMock,
} = vi.hoisted(() => ({
  executeExecutionSetupWithRetriesMock: vi.fn(),
  recordWorktreeStartCommitMock: vi.fn(),
  resetWorktreeToCommitMock: vi.fn(),
  isMockOpenCodeModeMock: vi.fn(),
  materializeExecutionSetupWorkspaceInputsMock: vi.fn(() => ({ copiedPaths: [] })),
}))

vi.mock('../../phases/executionSetup/executor', () => ({
  executeExecutionSetupWithRetries: executeExecutionSetupWithRetriesMock,
}))

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

function writeExecutionSetupPlan(ticketId: string, externalId: string) {
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
    steps: [],
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
): NonNullable<ExecutionSetupProfile['toolRequirements']>[number] {
  return {
    launcher: 'project-tool',
    requiredBy: ['project_commands.test_full[0]'],
    status: 'failed',
    missingProbe: 'project-tool --version',
    provisioningAttempts: attempts,
    finalProbe: './.ticket/runtime/execution-setup/run project-tool --version',
    failureReason: 'tool could not be provisioned',
  }
}

function buildExecutionSetupGeneration(input: {
  profile: ExecutionSetupProfile
  checks?: ExecutionSetupResult['checks']
  summary?: string
}) {
  return {
    session: { id: 'ses-setup-validation' },
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

function writeExecutableSetupWrapper(wrapperPath: string, body = '#!/usr/bin/env sh\nexec "$@"\n') {
  mkdirSync(dirname(wrapperPath), { recursive: true })
  writeFileSync(wrapperPath, body)
  chmodSync(wrapperPath, 0o755)
}

describe('handleExecutionSetup', () => {
  beforeEach(() => {
    resetTestDb()
    executeExecutionSetupWithRetriesMock.mockReset()
    recordWorktreeStartCommitMock.mockReset()
    resetWorktreeToCommitMock.mockReset()
    isMockOpenCodeModeMock.mockReset()
    materializeExecutionSetupWorkspaceInputsMock.mockReset()
    clearAllPendingSessionContinuationsForTests()

    recordWorktreeStartCommitMock.mockReturnValue('setup-start-sha')
    isMockOpenCodeModeMock.mockReturnValue(false)
    materializeExecutionSetupWorkspaceInputsMock.mockReturnValue({ copiedPaths: [] })
  })

  it('runs one numbered manual attempt after the latest persisted setup report', async () => {
    const { ticket, context } = createInitializedTestTicket(repoManager, {
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
    const { ticket, context, paths } = createInitializedTestTicket(repoManager, {
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
    const { ticket, context } = createInitializedTestTicket(repoManager, {
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

  it('caps backend setup probes at the time remaining in the aggregate attempt', async () => {
    const { ticket, context } = createInitializedTestTicket(repoManager, {
      title: 'Execution setup remaining validation budget',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    const slowProbe = `${quoteShellArg(process.execPath)} -e ${quoteShellArg('setTimeout(() => {}, 1000)')}`

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
            toolingProbeCommands: [createShellCommandSpec(slowProbe)],
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
    const { ticket, context, paths } = createInitializedTestTicket(repoManager, {
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

  it('rejects a schema-compatible setup result when tooling checks fail', async () => {
    const { ticket, context } = createInitializedTestTicket(repoManager, {
      title: 'Execution setup tooling gate',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: { attempt: number; generation: unknown }) => Promise<unknown>
      }
      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: {
          session: { id: 'ses-setup-tooling-fail' },
          output: '<EXECUTION_SETUP_RESULT>{"status":"ready"}</EXECUTION_SETUP_RESULT>',
          result: {
            status: 'ready',
            summary: 'Required launcher is unavailable.',
            profile: readyExecutionSetupProfile(ticket.externalId),
            checks: {
              workspace: 'pass',
              tooling: 'fail',
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
        {
          launcher: 'project-tool',
          requiredBy: ['project_commands.test_full[0]'],
          status: 'not_provisionable' as const,
          missingProbe: 'project-tool --version',
          provisioningAttempts: [],
          finalProbe: '',
          failureReason: '',
        },
      ],
    },
  ])('rejects incomplete tooling failure evidence for $title', async ({ title, toolRequirements }) => {
    const { ticket, context } = createInitializedTestTicket(repoManager, {
      title: `Execution setup ${title}`,
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    const profile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      toolRequirements,
    }

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: { attempt: number; generation: unknown }) => Promise<unknown>
      }
      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: buildExecutionSetupGeneration({
          profile,
          checks: {
            workspace: 'pass',
            tooling: 'fail',
            tempScope: 'pass',
            policy: 'pass',
          },
        }),
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
        {
          launcher: 'project-tool',
          requiredBy: ['project_commands.test_full[0]'],
          status: 'failed' as const,
          missingProbe: 'project-tool --version',
          provisioningAttempts: [
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
          ],
          finalProbe: './.ticket/runtime/execution-setup/run project-tool --version',
          failureReason: 'official archive download returned 404',
        },
      ],
    },
    {
      title: 'no safe provisioning path evidence',
      toolRequirements: [
        {
          launcher: 'project-tool',
          requiredBy: ['project_commands.test_full[0]'],
          status: 'not_provisionable' as const,
          missingProbe: 'project-tool --version',
          provisioningAttempts: [],
          finalProbe: '',
          failureReason: 'the repository requires a licensed interactive installer that cannot run safely in temp roots',
        },
      ],
    },
  ])('accepts tooling failure evidence for $title', async ({ title, toolRequirements }) => {
    const { ticket, context } = createInitializedTestTicket(repoManager, {
      title: `Execution setup ${title}`,
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    const profile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      toolRequirements,
    }

    executeExecutionSetupWithRetriesMock.mockImplementationOnce(async (...args: unknown[]) => {
      const callbacks = args[5] as {
        evaluateGeneration: (entry: { attempt: number; generation: unknown }) => Promise<unknown>
      }
      return await callbacks.evaluateGeneration({
        attempt: 1,
        generation: buildExecutionSetupGeneration({
          profile,
          checks: {
            workspace: 'pass',
            tooling: 'fail',
            tempScope: 'pass',
            policy: 'pass',
          },
        }),
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
      errors: ['Workspace setup cannot continue because the required tools check failed. Ready.'],
    })
    expect(sendEvent).not.toHaveBeenCalledWith({
      type: 'EXECUTION_SETUP_FAILED',
      errors: expect.arrayContaining([expect.stringContaining('tool_requirements evidence')]),
    })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it('rejects a ready setup profile that declares reusable command execution without tooling probes', async () => {
    const { ticket, context, paths } = createInitializedTestTicket(repoManager, {
      title: 'Execution setup missing probes gate',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    writeExecutableSetupWrapper(join(paths.executionSetupDir, 'run'))

    const profile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      reusableArtifacts: [
        {
          path: '.ticket/runtime/execution-setup/run',
          kind: 'command-wrapper',
          purpose: 'sources prepared runtime before commands',
        },
      ],
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
    const { ticket, context } = createInitializedTestTicket(repoManager, {
      title: 'Execution setup missing wrapper gate',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    const profile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      reusableArtifacts: [
        {
          path: '.ticket/runtime/execution-setup/run',
          kind: 'command-wrapper',
          purpose: 'sources prepared runtime before commands',
        },
      ],
      toolingProbeCommands: [createShellCommandSpec(`./.ticket/runtime/execution-setup/run ${quoteShellArg(process.execPath)} -e ${quoteShellArg('process.exit(0)')}`)],
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
      // Shells word this differently: bash says "not found", macOS and BSD
      // /bin/sh say "No such file or directory". Match the exit code instead.
      errors: [expect.stringContaining('exit code 127')],
    })
    expect(sendEvent).not.toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_READY' })
  })

  it('rejects a ready setup profile when a tooling probe fails', async () => {
    const { ticket, context } = createInitializedTestTicket(repoManager, {
      title: 'Execution setup failing probe gate',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)

    const profile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      projectCommands: {
        prepare: [],
        testFull: [createShellCommandSpec(`${quoteShellArg(process.execPath)} -e ${quoteShellArg('process.exit(0)')}`)],
        lintFull: [],
        typecheckFull: [],
      },
      toolingProbeCommands: [createShellCommandSpec(`${quoteShellArg(process.execPath)} -e ${quoteShellArg('process.exit(3)')}`)],
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
    const { ticket, context, paths } = createInitializedTestTicket(repoManager, {
      title: 'Execution setup passing probe gate',
    })
    writeExecutionSetupPlan(ticket.id, ticket.externalId)
    writeExecutableSetupWrapper(
      join(paths.executionSetupDir, 'run'),
      '#!/usr/bin/env sh\nexport LOOP_SETUP_WRAPPER=1\nexec "$@"\n',
    )

    const profile = {
      ...readyExecutionSetupProfile(ticket.externalId),
      reusableArtifacts: [
        {
          path: '.ticket/runtime/execution-setup/run',
          kind: 'command-wrapper',
          purpose: 'sources prepared runtime before commands',
        },
      ],
      toolingProbeCommands: [
        createShellCommandSpec(`./.ticket/runtime/execution-setup/run ${quoteShellArg(process.execPath)} -e ${quoteShellArg("if (process.env.LOOP_SETUP_WRAPPER !== '1') process.exit(9)")}`),
      ],
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
    const { ticket, context, paths } = createInitializedTestTicket(repoManager, {
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
    const { ticket, context, paths } = createInitializedTestTicket(repoManager, {
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
    const { ticket, context, paths } = createInitializedTestTicket(repoManager, {
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
