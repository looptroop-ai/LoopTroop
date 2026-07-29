import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { FINAL_TEST_FAILED } from '@shared/errorCodes'
import { ticketMachine } from '../ticketMachine'

describe('ticketMachine execution setup flow', () => {
  it('records a stable cause code when Final Testing fails', () => {
    const actor = createActor(ticketMachine, {
      snapshot: {
        status: 'active',
        value: 'RUNNING_FINAL_TEST',
        historyValue: {},
        context: {
          ticketId: '1:T-1', projectId: 1, externalId: 'T-1', title: 'Final test failure', status: 'RUNNING_FINAL_TEST',
          lockedMainImplementer: 'model-a', lockedMainImplementerVariant: null,
          lockedCouncilMembers: ['model-a'], lockedCouncilMemberVariants: null,
          lockedInterviewQuestions: null, lockedCoverageFollowUpBudgetPercent: null,
          lockedMaxCoveragePasses: null, lockedMaxPrdCoveragePasses: null,
          lockedMaxBeadsCoveragePasses: null, lockedStructuredRetryCount: null,
          lockedManualQaEnabled: false, lockedManualQaSource: 'profile',
          previousStatus: 'CODING', error: null, errorCodes: [], errorDiagnostics: null,
          blockedErrorResolution: null, beadProgress: { total: 1, completed: 1, current: null },
          iterationCount: 0, maxIterations: 5, councilResults: null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
        children: {},
      } as unknown as never,
      input: {},
    })

    actor.start()
    actor.send({ type: 'TESTS_FAILED' })

    expect(actor.getSnapshot().value).toBe('BLOCKED_ERROR')
    expect(actor.getSnapshot().context.errorCodes).toEqual([FINAL_TEST_FAILED])
  })

  it('routes passed final tests through Manual QA only when the started ticket locked it on', () => {
    const makeActor = (enabled: boolean | null) => createActor(ticketMachine, {
      snapshot: {
        status: 'active',
        value: 'RUNNING_FINAL_TEST',
        historyValue: {},
        context: {
          ticketId: '1:T-1', projectId: 1, externalId: 'T-1', title: 'Manual QA gate', status: 'RUNNING_FINAL_TEST',
          lockedMainImplementer: 'model-a', lockedMainImplementerVariant: null,
          lockedCouncilMembers: ['model-a'], lockedCouncilMemberVariants: null,
          lockedInterviewQuestions: null, lockedCoverageFollowUpBudgetPercent: null,
          lockedMaxCoveragePasses: null, lockedMaxPrdCoveragePasses: null,
          lockedMaxBeadsCoveragePasses: null, lockedStructuredRetryCount: null,
          lockedManualQaEnabled: enabled, lockedManualQaSource: enabled === null ? null : 'profile',
          previousStatus: 'CODING', error: null, errorCodes: [], errorDiagnostics: null,
          blockedErrorResolution: null, beadProgress: { total: 1, completed: 1, current: null },
          iterationCount: 0, maxIterations: 5, councilResults: null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
        children: {},
      } as unknown as never,
      input: {},
    })

    const enabled = makeActor(true)
    enabled.start()
    enabled.send({ type: 'TESTS_PASSED' })
    expect(enabled.getSnapshot().value).toBe('GENERATING_QA_CHECKLIST')
    enabled.send({ type: 'QA_CHECKLIST_READY' })
    expect(enabled.getSnapshot().value).toBe('WAITING_MANUAL_QA')
    enabled.send({ type: 'MANUAL_QA_FIXES_CREATED' })
    expect(enabled.getSnapshot().value).toBe('CODING')

    for (const lockedValue of [false, null] as const) {
      const disabled = makeActor(lockedValue)
      disabled.start()
      disabled.send({ type: 'TESTS_PASSED' })
      expect(disabled.getSnapshot().value).toBe('INTEGRATING_CHANGES')
    }
  })

  it('records and clears structured diagnostics for blocked ERROR events', () => {
    const actor = createActor(ticketMachine, {
      input: {
        ticketId: '1:T-1',
        projectId: 1,
        externalId: 'T-1',
        title: 'Diagnostic blocked error',
        maxIterations: 5,
      },
    })

    actor.start()
    actor.send({ type: 'START', lockedMainImplementer: 'model-a', lockedCouncilMembers: ['model-a'] })
    actor.send({
      type: 'ERROR',
      message: 'Relevant files scan failed',
      codes: ['RELEVANT_FILES_SCAN_FAILED', 'OPENCODE_PROVIDER_AUTH_FAILED'],
      diagnostics: {
        kind: 'opencode_provider',
        source: 'provider',
        summary: 'invalid_request_error: token invalidated (HTTP 401)',
        modelId: 'model-a',
        sessionId: 'ses-auth',
        statusCode: 401,
      },
    })

    expect(actor.getSnapshot().value).toBe('BLOCKED_ERROR')
    expect(actor.getSnapshot().context.errorDiagnostics).toMatchObject({
      kind: 'opencode_provider',
      source: 'provider',
      statusCode: 401,
    })

    actor.send({ type: 'RETRY' })

    expect(actor.getSnapshot().value).toBe('SCANNING_RELEVANT_FILES')
    expect(actor.getSnapshot().context.errorDiagnostics).toBeNull()
  })

  it('records and clears structured diagnostics for blocked BEAD_ERROR events', () => {
    const actor = createActor(ticketMachine, {
      snapshot: {
        status: 'active',
        value: 'CODING',
        historyValue: {},
        context: {
          ticketId: '1:T-1',
          projectId: 1,
          externalId: 'T-1',
          title: 'Diagnostic bead error',
          status: 'CODING',
          lockedMainImplementer: 'openai/gpt-5.2',
          lockedMainImplementerVariant: null,
          lockedCouncilMembers: ['openai/gpt-5.2'],
          lockedCouncilMemberVariants: null,
          lockedInterviewQuestions: null,
          lockedCoverageFollowUpBudgetPercent: null,
          lockedMaxCoveragePasses: null,
          lockedMaxPrdCoveragePasses: null,
          lockedMaxBeadsCoveragePasses: null,
          lockedStructuredRetryCount: null,
          previousStatus: 'PREPARING_EXECUTION_ENV',
          error: null,
          errorCodes: [],
          errorDiagnostics: null,
          blockedErrorResolution: null,
          beadProgress: { total: 1, completed: 0, current: 'bead-1' },
          iterationCount: 0,
          maxIterations: 5,
          councilResults: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        children: {},
      } as unknown as never,
      input: {
        ticketId: '1:T-1',
        projectId: 1,
        externalId: 'T-1',
        title: 'Diagnostic bead error',
        maxIterations: 5,
        lockedMainImplementer: 'openai/gpt-5.2',
        lockedCouncilMembers: ['openai/gpt-5.2'],
      },
    })

    actor.start()
    actor.send({
      type: 'BEAD_ERROR',
      codes: ['BEAD_RETRY_BUDGET_EXHAUSTED', 'OPENCODE_PROVIDER_ERROR'],
      diagnostics: {
        kind: 'opencode_provider',
        source: 'provider',
        summary: 'The usage limit has been reached',
        modelId: 'openai/gpt-5.2',
        sessionId: 'ses-limit',
      },
    })

    expect(actor.getSnapshot().value).toBe('BLOCKED_ERROR')
    expect(actor.getSnapshot().context.errorCodes).toEqual(['BEAD_RETRY_BUDGET_EXHAUSTED', 'OPENCODE_PROVIDER_ERROR'])
    expect(actor.getSnapshot().context.errorDiagnostics).toMatchObject({
      kind: 'opencode_provider',
      source: 'provider',
      summary: 'The usage limit has been reached',
      sessionId: 'ses-limit',
    })

    actor.send({ type: 'RETRY' })

    expect(actor.getSnapshot().value).toBe('CODING')
    expect(actor.getSnapshot().context.errorDiagnostics).toBeNull()
  })

  it('routes approval through pre-flight, setup-plan drafting, approval, and execution setup before coding', () => {
    const actor = createActor(ticketMachine, {
      input: {
        ticketId: '1:T-1',
        projectId: 1,
        externalId: 'T-1',
        title: 'Execution setup flow',
        maxIterations: 5,
        lockedMainImplementer: 'model-a',
        lockedCouncilMembers: ['model-a', 'model-b'],
      },
    })

    actor.start()
    actor.send({ type: 'START', lockedMainImplementer: 'model-a', lockedCouncilMembers: ['model-a', 'model-b'] })
    actor.send({ type: 'RELEVANT_FILES_READY' })
    actor.send({ type: 'QUESTIONS_READY', result: {} })
    actor.send({ type: 'WINNER_SELECTED', winner: 'model-a' })
    actor.send({ type: 'READY' })
    actor.send({ type: 'INTERVIEW_COMPLETE' })
    actor.send({ type: 'COVERAGE_CLEAN' })
    actor.send({ type: 'APPROVE' })
    actor.send({ type: 'DRAFTS_READY' })
    actor.send({ type: 'WINNER_SELECTED', winner: 'model-a' })
    actor.send({ type: 'REFINED' })
    actor.send({ type: 'COVERAGE_CLEAN' })
    actor.send({ type: 'APPROVE' })
    actor.send({ type: 'DRAFTS_READY' })
    actor.send({ type: 'WINNER_SELECTED', winner: 'model-a' })
    actor.send({ type: 'REFINED' })
    actor.send({ type: 'COVERAGE_CLEAN' })
    actor.send({ type: 'EXPANDED' })
    actor.send({ type: 'APPROVE' })

    actor.send({ type: 'CHECKS_PASSED' })
    expect(actor.getSnapshot().value).toBe('GENERATING_EXECUTION_SETUP_PLAN')

    actor.send({ type: 'EXECUTION_SETUP_PLAN_FAILED', errors: ['Invalid generated draft'] })
    expect(actor.getSnapshot().value).toBe('WAITING_EXECUTION_SETUP_APPROVAL')
    expect(actor.getSnapshot().context.error).toBeNull()

    actor.send({ type: 'REGENERATE_EXECUTION_SETUP_PLAN', requestArtifactId: 41 })
    expect(actor.getSnapshot().value).toBe('GENERATING_EXECUTION_SETUP_PLAN')
    expect(actor.getSnapshot().context.pendingExecutionSetupPlanRequestArtifactId).toBe(41)

    actor.send({ type: 'EXECUTION_SETUP_PLAN_READY' })
    expect(actor.getSnapshot().value).toBe('WAITING_EXECUTION_SETUP_APPROVAL')
    expect(actor.getSnapshot().context.pendingExecutionSetupPlanRequestArtifactId).toBeNull()

    actor.send({ type: 'APPROVE_EXECUTION_SETUP_PLAN' })
    expect(actor.getSnapshot().value).toBe('PREPARING_EXECUTION_ENV')

    actor.send({ type: 'EXECUTION_SETUP_EVIDENCE_CHANGED' })
    expect(actor.getSnapshot().value).toBe('WAITING_EXECUTION_SETUP_APPROVAL')

    actor.send({ type: 'APPROVE_EXECUTION_SETUP_PLAN' })
    expect(actor.getSnapshot().value).toBe('PREPARING_EXECUTION_ENV')

    actor.send({ type: 'REGENERATE_EXECUTION_SETUP_PLAN', requestArtifactId: 42 })
    expect(actor.getSnapshot().value).toBe('GENERATING_EXECUTION_SETUP_PLAN')
    expect(actor.getSnapshot().context.pendingExecutionSetupPlanRequestArtifactId).toBe(42)

    actor.send({ type: 'EXECUTION_SETUP_PLAN_READY' })
    actor.send({ type: 'APPROVE_EXECUTION_SETUP_PLAN' })
    actor.send({ type: 'EXECUTION_SETUP_READY' })
    expect(actor.getSnapshot().value).toBe('CODING')
  })

  it('preserves a pending regeneration request through blocked-error retry', () => {
    const actor = createActor(ticketMachine, {
      snapshot: {
        status: 'active',
        value: 'GENERATING_EXECUTION_SETUP_PLAN',
        historyValue: {},
        context: {
          ticketId: '1:T-1',
          projectId: 1,
          externalId: 'T-1',
          title: 'Restart-safe setup-plan regeneration',
          status: 'GENERATING_EXECUTION_SETUP_PLAN',
          lockedMainImplementer: 'model-a',
          lockedMainImplementerVariant: null,
          lockedCouncilMembers: ['model-a'],
          lockedCouncilMemberVariants: null,
          lockedInterviewQuestions: null,
          lockedCoverageFollowUpBudgetPercent: null,
          lockedMaxCoveragePasses: null,
          lockedMaxPrdCoveragePasses: null,
          lockedMaxBeadsCoveragePasses: null,
          lockedStructuredRetryCount: null,
          lockedManualQaEnabled: false,
          lockedManualQaSource: 'profile',
          pendingExecutionSetupPlanRequestArtifactId: 73,
          previousStatus: 'WAITING_EXECUTION_SETUP_APPROVAL',
          error: null,
          errorCodes: [],
          errorDiagnostics: null,
          blockedErrorResolution: null,
          beadProgress: { total: 1, completed: 0, current: null },
          iterationCount: 0,
          maxIterations: 5,
          councilResults: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        children: {},
      } as unknown as never,
      input: {},
    })

    actor.start()
    actor.send({ type: 'ERROR', message: 'Provider interrupted setup-plan drafting' })

    expect(actor.getSnapshot().value).toBe('BLOCKED_ERROR')
    expect(actor.getSnapshot().context.previousStatus).toBe('GENERATING_EXECUTION_SETUP_PLAN')
    expect(actor.getSnapshot().context.pendingExecutionSetupPlanRequestArtifactId).toBe(73)

    actor.send({ type: 'RETRY' })

    expect(actor.getSnapshot().value).toBe('GENERATING_EXECUTION_SETUP_PLAN')
    expect(actor.getSnapshot().context.pendingExecutionSetupPlanRequestArtifactId).toBe(73)
  })

  it('retries back into PREPARING_EXECUTION_ENV from blocked error', () => {
    const actor = createActor(ticketMachine, {
      snapshot: {
        status: 'active',
        value: 'BLOCKED_ERROR',
        historyValue: {},
        context: {
          ticketId: '1:T-1',
          projectId: 1,
          externalId: 'T-1',
          title: 'Execution setup retry',
          status: 'BLOCKED_ERROR',
          lockedMainImplementer: 'model-a',
          lockedMainImplementerVariant: null,
          lockedCouncilMembers: ['model-a', 'model-b'],
          lockedCouncilMemberVariants: null,
          lockedInterviewQuestions: null,
          lockedCoverageFollowUpBudgetPercent: null,
          lockedMaxCoveragePasses: null,
          previousStatus: 'PREPARING_EXECUTION_ENV',
          error: 'Execution setup failed',
          errorCodes: ['EXECUTION_SETUP_FAILED'],
          beadProgress: { total: 2, completed: 0, current: null },
          iterationCount: 0,
          maxIterations: 5,
          councilResults: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        children: {},
      } as unknown as never,
      input: {
        ticketId: '1:T-1',
        projectId: 1,
        externalId: 'T-1',
        title: 'Execution setup retry',
        maxIterations: 5,
        lockedMainImplementer: 'model-a',
        lockedCouncilMembers: ['model-a', 'model-b'],
      },
    })

    actor.start()
    actor.send({ type: 'RETRY' })

    expect(actor.getSnapshot().value).toBe('PREPARING_EXECUTION_ENV')
    expect(actor.getSnapshot().context.error).toBeNull()
  })

  it('continues back into PREPARING_EXECUTION_ENV from blocked error', () => {
    const actor = createActor(ticketMachine, {
      snapshot: {
        status: 'active',
        value: 'BLOCKED_ERROR',
        historyValue: {},
        context: {
          ticketId: '1:T-1',
          projectId: 1,
          externalId: 'T-1',
          title: 'Execution setup continue',
          status: 'BLOCKED_ERROR',
          lockedMainImplementer: 'model-a',
          lockedMainImplementerVariant: null,
          lockedCouncilMembers: ['model-a', 'model-b'],
          lockedCouncilMemberVariants: null,
          lockedInterviewQuestions: null,
          lockedCoverageFollowUpBudgetPercent: null,
          lockedMaxCoveragePasses: null,
          lockedMaxPrdCoveragePasses: null,
          lockedMaxBeadsCoveragePasses: null,
          lockedStructuredRetryCount: null,
          previousStatus: 'PREPARING_EXECUTION_ENV',
          error: 'Usage limit reached',
          errorCodes: [],
          errorDiagnostics: null,
          blockedErrorResolution: null,
          beadProgress: { total: 2, completed: 0, current: null },
          iterationCount: 0,
          maxIterations: 5,
          councilResults: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        children: {},
      } as unknown as never,
      input: {
        ticketId: '1:T-1',
        projectId: 1,
        externalId: 'T-1',
        title: 'Execution setup continue',
        maxIterations: 5,
        lockedMainImplementer: 'model-a',
        lockedCouncilMembers: ['model-a', 'model-b'],
      },
    })

    actor.start()
    actor.send({ type: 'CONTINUE' })

    expect(actor.getSnapshot().value).toBe('PREPARING_EXECUTION_ENV')
    expect(actor.getSnapshot().context.error).toBeNull()
    expect(actor.getSnapshot().context.blockedErrorResolution).toBe('CONTINUED')
  })

  it('retries back into setup-plan approval from blocked error', () => {
    const actor = createActor(ticketMachine, {
      snapshot: {
        status: 'active',
        value: 'BLOCKED_ERROR',
        historyValue: {},
        context: {
          ticketId: '1:T-1',
          projectId: 1,
          externalId: 'T-1',
          title: 'Execution setup plan retry',
          status: 'BLOCKED_ERROR',
          lockedMainImplementer: 'model-a',
          lockedMainImplementerVariant: null,
          lockedCouncilMembers: ['model-a', 'model-b'],
          lockedCouncilMemberVariants: null,
          lockedInterviewQuestions: null,
          lockedCoverageFollowUpBudgetPercent: null,
          lockedMaxCoveragePasses: null,
          previousStatus: 'WAITING_EXECUTION_SETUP_APPROVAL',
          error: 'Execution setup plan failed',
          errorCodes: ['EXECUTION_SETUP_PLAN_FAILED'],
          beadProgress: { total: 2, completed: 0, current: null },
          iterationCount: 0,
          maxIterations: 5,
          councilResults: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        children: {},
      } as unknown as never,
      input: {
        ticketId: '1:T-1',
        projectId: 1,
        externalId: 'T-1',
        title: 'Execution setup plan retry',
        maxIterations: 5,
        lockedMainImplementer: 'model-a',
        lockedCouncilMembers: ['model-a', 'model-b'],
      },
    })

    actor.start()
    actor.send({ type: 'RETRY' })

    expect(actor.getSnapshot().value).toBe('WAITING_EXECUTION_SETUP_APPROVAL')
    expect(actor.getSnapshot().context.error).toBeNull()
  })

  it('does not retry blocked errors when previousStatus is missing', () => {
    const actor = createActor(ticketMachine, {
      snapshot: {
        status: 'active',
        value: 'BLOCKED_ERROR',
        historyValue: {},
        context: {
          ticketId: '1:T-1',
          projectId: 1,
          externalId: 'T-1',
          title: 'Missing retry target',
          status: 'BLOCKED_ERROR',
          lockedMainImplementer: 'model-a',
          lockedMainImplementerVariant: null,
          lockedCouncilMembers: ['model-a', 'model-b'],
          lockedCouncilMemberVariants: null,
          lockedInterviewQuestions: null,
          lockedCoverageFollowUpBudgetPercent: null,
          lockedMaxCoveragePasses: null,
          lockedMaxPrdCoveragePasses: null,
          lockedMaxBeadsCoveragePasses: null,
          previousStatus: null,
          error: 'Unknown failure',
          errorCodes: ['UNKNOWN'],
          beadProgress: { total: 0, completed: 0, current: null },
          iterationCount: 0,
          maxIterations: 5,
          councilResults: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        children: {},
      } as unknown as never,
      input: {
        ticketId: '1:T-1',
        projectId: 1,
        externalId: 'T-1',
        title: 'Missing retry target',
        maxIterations: 5,
        lockedMainImplementer: 'model-a',
        lockedCouncilMembers: ['model-a', 'model-b'],
      },
    })

    actor.start()
    actor.send({ type: 'RETRY' })

    expect(actor.getSnapshot().value).toBe('BLOCKED_ERROR')
    expect(actor.getSnapshot().context.error).toBe('Unknown failure')
  })
})
