import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getLatestPhaseArtifact,
  getTicketPaths,
} from '../../storage/tickets'
import { TicketWorkspaceNotInitializedError } from '../../lib/workflowErrors'
import { parseExecutionSetupPlanResult } from '../../phases/executionSetupPlan/parser'
import {
  EXECUTION_SETUP_PLAN_ARTIFACT_TYPE,
  EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE,
  type ExecutionSetupPlan,
  type ExecutionSetupPlanGenerationResult,
  type ExecutionSetupPlanReport,
} from '../../phases/executionSetupPlan/types'
import {
  EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
  writeExecutionSetupPlanRegenerationRequest,
  writeGeneratedExecutionSetupPlanReport,
} from '../../phases/executionSetupPlan/document'
import type { generateExecutionSetupPlan } from '../../phases/executionSetupPlan/generator'
import type { OpenCodePromptCompletedEvent, OpenCodePromptDispatchEvent } from '../runOpenCodePrompt'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { TEST } from '../../test/factories'

const { assembleCouncilContextMock, generateExecutionSetupPlanMock, isMockOpenCodeModeMock } = vi.hoisted(() => ({
  assembleCouncilContextMock: vi.fn(),
  generateExecutionSetupPlanMock: vi.fn(),
  isMockOpenCodeModeMock: vi.fn(),
}))

vi.mock('../../phases/executionSetupPlan/generator', () => ({
  generateExecutionSetupPlan: generateExecutionSetupPlanMock,
}))

vi.mock('../phases/state', () => ({
  adapter: { assembleCouncilContext: assembleCouncilContextMock },
}))

vi.mock('../../opencode/factory', async () => {
  const actual = await vi.importActual<typeof import('../../opencode/factory')>('../../opencode/factory')
  return { ...actual, isMockOpenCodeMode: isMockOpenCodeModeMock }
})

import { handleExecutionSetupPlanGeneration } from '../phases/executionSetupPlanPhase'

const repoManager = createTestRepoManager('execution-setup-plan-phase-')

function buildPlan(ticketId = 'T-1'): ExecutionSetupPlan {
  const payload = {
    schema_version: 1,
    ticket_id: ticketId,
    artifact: 'execution_setup_plan',
    status: 'draft',
    summary: 'Workspace setup is ready for review.',
    readiness: {
      status: 'partial',
      actions_required: true,
      evidence: ['Project manifest exists.'],
      gaps: ['Dependencies are missing.'],
    },
    workspace_inputs: [],
    workspace_probes: [],
    git_hooks: { validation_commands: [] },
    steps: [],
    project_commands: { prepare: [], test_full: [], lint_full: [], typecheck_full: [] },
    quality_gate_policy: {
      tests: 'bead-test-commands-first',
      lint: 'impacted-or-package',
      typecheck: 'impacted-or-package',
      full_project_fallback: 'never-block-on-unrelated-baseline',
    },
    cautions: [],
  }
  const parsed = parseExecutionSetupPlanResult(`<EXECUTION_SETUP_PLAN>\n${JSON.stringify(payload)}\n</EXECUTION_SETUP_PLAN>`)
  if (!parsed.plan) throw new Error(`Expected a valid setup plan: ${parsed.errors.join('; ')}`)
  return parsed.plan
}

function generationResult(plan: ExecutionSetupPlan | null): ExecutionSetupPlanGenerationResult {
  return {
    session: { id: 'setup-plan-session' } as ExecutionSetupPlanGenerationResult['session'],
    output: 'model setup plan output',
    plan,
    parse: {
      markerFound: plan !== null,
      plan,
      errors: plan ? [] : ['The model output did not contain a usable setup plan.'],
    },
    structuredOutput: { repairApplied: false, repairWarnings: [], autoRetryCount: 0 },
    rawAttempts: [],
  }
}

function reportFor(
  plan: ExecutionSetupPlan | null,
  overrides: Partial<ExecutionSetupPlanReport> = {},
): ExecutionSetupPlanReport {
  return {
    status: plan ? 'draft' : 'failed',
    ready: plan !== null,
    generatedAt: TEST.timestamp,
    generatedBy: TEST.implementer,
    summary: plan?.summary,
    plan,
    modelOutput: 'persisted model output',
    errors: plan ? [] : ['The model output did not contain a usable setup plan.'],
    structuredOutput: { repairApplied: false, repairWarnings: [], autoRetryCount: 0 },
    rawAttempts: [],
    notes: [],
    source: 'auto',
    ...overrides,
  }
}

beforeEach(() => {
  resetTestDb()
  assembleCouncilContextMock.mockReset().mockResolvedValue([
    { type: 'text', source: 'ticket_context', content: 'Ticket context' },
  ])
  generateExecutionSetupPlanMock.mockReset()
  isMockOpenCodeModeMock.mockReset().mockReturnValue(false)
})

afterAll(() => {
  resetTestDb()
  repoManager.cleanup()
})

describe('handleExecutionSetupPlanGeneration', () => {
  it.each([
    { label: 'ready', plan: true },
    { label: 'failed', plan: false },
  ])('publishes an existing $label report without generating again', async ({ plan: isReady }) => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    const currentPlan = isReady ? buildPlan(ticket.externalId) : null
    const existingReport = reportFor(currentPlan, {
      notes: ['Keep the existing review note.'],
      source: 'regenerate',
    })
    writeGeneratedExecutionSetupPlanReport(ticket.id, existingReport)
    const sendEvent = vi.fn()

    await handleExecutionSetupPlanGeneration(ticket.id, context, sendEvent, new AbortController().signal)

    expect(generateExecutionSetupPlanMock).not.toHaveBeenCalled()
    expect(sendEvent).toHaveBeenCalledWith(isReady
      ? { type: 'EXECUTION_SETUP_PLAN_READY' }
      : { type: 'EXECUTION_SETUP_PLAN_FAILED', errors: existingReport.errors })
    expect(getLatestPhaseArtifact(
      ticket.id,
      EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE,
      EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
    )?.content).toBe(JSON.stringify(existingReport))
    expect(getLatestPhaseArtifact(ticket.id, 'execution_setup_plan_notes', EXECUTION_SETUP_PLAN_APPROVAL_PHASE)?.content)
      .toBe(JSON.stringify({ notes: ['Keep the existing review note.'] }))
  })

  it('generates, validates, and publishes a new plan for approval', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    const plan = buildPlan(ticket.externalId)
    const generation = generationResult(plan)
    generateExecutionSetupPlanMock.mockImplementationOnce(async (...args: Parameters<typeof generateExecutionSetupPlan>) => {
      const [adapterArg, promptContext, worktreePath, signal, options] = args
      if (!options) throw new Error('Expected execution setup plan callbacks')
      expect(adapterArg).toEqual(expect.objectContaining({ assembleCouncilContext: expect.any(Function) }))
      expect(promptContext.map((part) => part.source)).toEqual([
        'ticket_context',
        'workspace_locations',
        'host_context',
      ])
      expect(worktreePath).toBe(paths.worktreePath)
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(options).toMatchObject({
        ticketId: ticket.id,
        model: context.lockedMainImplementer,
        variant: context.lockedMainImplementerVariant ?? undefined,
      })
      expect(await options.validatePlan?.(plan)).toEqual([])
      options.onSessionCreated?.('setup-plan-session')
      options.onOpenCodeStreamEvent?.({
        sessionId: 'setup-plan-session',
        event: {
          type: 'text',
          sessionId: 'setup-plan-session',
          messageId: 'message-1',
          partId: 'part-1',
          text: 'Preparing the workspace plan.',
          streaming: false,
          complete: true,
        },
      })
      const session = { id: 'setup-plan-session' } as OpenCodePromptDispatchEvent['session']
      options.onPromptDispatched?.({
        sessionId: session.id,
        event: {
          session,
          parts: [],
          promptText: 'Plan the workspace setup.',
          promptNumber: 1,
          timeoutKind: 'ai_response',
        },
      })
      options.onPromptCompleted?.({
        stage: 'execution_setup_plan_main',
        event: {
          session,
          parts: [],
          response: 'Plan generated.',
          messages: [],
        } as OpenCodePromptCompletedEvent,
      })
      return generation
    })
    const sendEvent = vi.fn()

    await handleExecutionSetupPlanGeneration(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_PLAN_READY' })
    expect(JSON.parse(getLatestPhaseArtifact(
      ticket.id,
      EXECUTION_SETUP_PLAN_ARTIFACT_TYPE,
      EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
    )!.content)).toMatchObject({ ticket_id: ticket.externalId })
    const report = JSON.parse(getLatestPhaseArtifact(
      ticket.id,
      EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE,
      EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
    )!.content) as ExecutionSetupPlanReport
    expect(report).toMatchObject({
      status: 'draft',
      ready: true,
      generatedBy: context.lockedMainImplementer,
      source: 'auto',
      notes: [],
      summary: plan.summary,
    })
    expect(assembleCouncilContextMock).toHaveBeenCalledWith(ticket.id, 'execution_setup_plan')
  })

  it('includes the current plan and accumulated notes when regenerating from a request', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    const currentPlan = buildPlan(ticket.externalId)
    const requestId = writeExecutionSetupPlanRegenerationRequest(ticket.id, {
      commentary: 'Include a check for the local launch command.',
      currentPlan,
      notes: ['Retain the repository-specific setup detail.'],
    })
    const regeneratedPlan = buildPlan(ticket.externalId)
    generateExecutionSetupPlanMock.mockImplementationOnce(async (...args: Parameters<typeof generateExecutionSetupPlan>) => {
      const [,, worktreePath,, options] = args
      expect(worktreePath).toBe(paths.worktreePath)
      expect(options.promptTemplate).toBeDefined()
      const promptContext = args[1]
      expect(promptContext.map((part) => part.source)).toEqual([
        'ticket_context',
        'workspace_locations',
        'host_context',
        'execution_setup_plan',
        'execution_setup_plan_note',
        'execution_setup_plan_notes',
      ])
      expect(promptContext.find((part) => part.source === 'execution_setup_plan')?.content)
        .toContain(currentPlan.summary)
      expect(promptContext.find((part) => part.source === 'execution_setup_plan_note')?.content)
        .toContain('Include a check for the local launch command.')
      expect(promptContext.find((part) => part.source === 'execution_setup_plan_notes')?.content)
        .toContain('Retain the repository-specific setup detail.')
      return generationResult(regeneratedPlan)
    })
    const sendEvent = vi.fn()

    await handleExecutionSetupPlanGeneration(
      ticket.id,
      { ...context, pendingExecutionSetupPlanRequestArtifactId: requestId },
      sendEvent,
      new AbortController().signal,
    )

    expect(sendEvent).toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_PLAN_READY' })
    expect(JSON.parse(getLatestPhaseArtifact(
      ticket.id,
      EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE,
      EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
    )!.content)).toMatchObject({ source: 'regenerate', notes: ['Retain the repository-specific setup detail.'] })
  })

  it('reports a failed plan when workspace input validation rejects generated content', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    const invalidPlan: ExecutionSetupPlan = {
      ...buildPlan(ticket.externalId),
      workspaceInputs: [{
        path: '../outside-project',
        kind: 'file',
        sourceStatus: 'untracked',
        category: 'local_config',
        reason: 'Required by the project setup command.',
      }],
    }
    generateExecutionSetupPlanMock.mockImplementationOnce(async (...args: Parameters<typeof generateExecutionSetupPlan>) => {
      const options = args[4]
      if (!options) throw new Error('Expected execution setup plan callbacks')
      expect(options.validatePlan?.(invalidPlan)).toEqual([
        'Workspace input path must stay inside the project: ../outside-project',
      ])
      return generationResult(invalidPlan)
    })
    const sendEvent = vi.fn()

    await handleExecutionSetupPlanGeneration(ticket.id, context, sendEvent, new AbortController().signal)

    const report = JSON.parse(getLatestPhaseArtifact(
      ticket.id,
      EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE,
      EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
    )!.content) as ExecutionSetupPlanReport
    expect(report).toMatchObject({ status: 'failed', ready: false, plan: null })
    expect(report.errors).toContain('Workspace input path must stay inside the project: ../outside-project')
    expect(sendEvent).toHaveBeenCalledWith({ type: 'EXECUTION_SETUP_PLAN_FAILED', errors: report.errors })
  })

  it('rejects missing workspace and implementer inputs', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    const missingTicketId = 'unknown-ticket-reference'
    expect(getTicketPaths(missingTicketId)).toBeUndefined()
    await expect(handleExecutionSetupPlanGeneration(
      missingTicketId,
      context,
      vi.fn(),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(TicketWorkspaceNotInitializedError)

    await expect(handleExecutionSetupPlanGeneration(
      ticket.id,
      { ...context, lockedMainImplementer: null },
      vi.fn(),
      new AbortController().signal,
    )).rejects.toThrow('No locked main implementer is configured for execution setup planning')
    expect(generateExecutionSetupPlanMock).not.toHaveBeenCalled()
  })

  it('reports that execution cannot continue in mock OpenCode mode', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    isMockOpenCodeModeMock.mockReturnValue(true)
    const sendEvent = vi.fn()

    await handleExecutionSetupPlanGeneration(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ERROR',
      codes: ['MOCK_EXECUTION_UNSUPPORTED'],
      message: expect.stringContaining('Mock OpenCode mode stops before execution.'),
    }))
    expect(generateExecutionSetupPlanMock).not.toHaveBeenCalled()
  })
})
