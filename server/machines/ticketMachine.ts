import { assign, setup } from 'xstate'
import type { TicketContext, TicketEvent } from './types'
import { PROFILE_DEFAULTS } from '../db/defaults'
import { FINAL_TEST_FAILED } from '@shared/errorCodes'

type TicketInput = Partial<TicketContext>

/** Every non-terminal status that BLOCKED_ERROR can resume to via Retry or Continue. */
const BLOCKED_ERROR_RESUME_STATUSES = [
  'DRAFT',
  'SCANNING_RELEVANT_FILES',
  'COUNCIL_DELIBERATING',
  'COUNCIL_VOTING_INTERVIEW',
  'COMPILING_INTERVIEW',
  'WAITING_INTERVIEW_ANSWERS',
  'VERIFYING_INTERVIEW_COVERAGE',
  'WAITING_INTERVIEW_APPROVAL',
  'DRAFTING_PRD',
  'COUNCIL_VOTING_PRD',
  'REFINING_PRD',
  'VERIFYING_PRD_COVERAGE',
  'WAITING_PRD_APPROVAL',
  'DRAFTING_BEADS',
  'COUNCIL_VOTING_BEADS',
  'REFINING_BEADS',
  'VERIFYING_BEADS_COVERAGE',
  'EXPANDING_BEADS',
  'WAITING_BEADS_APPROVAL',
  'PRE_FLIGHT_CHECK',
  'GENERATING_EXECUTION_SETUP_PLAN',
  'WAITING_EXECUTION_SETUP_APPROVAL',
  'PREPARING_EXECUTION_ENV',
  'CODING',
  'RUNNING_FINAL_TEST',
  'GENERATING_QA_CHECKLIST',
  'WAITING_MANUAL_QA',
  'INTEGRATING_CHANGES',
  'CREATING_PULL_REQUEST',
  'WAITING_PR_REVIEW',
  'CLEANING_ENV',
] as const

function buildBlockedErrorResumeTransitions() {
  return BLOCKED_ERROR_RESUME_STATUSES.map((status) => ({
    guard: ({ context }: { context: TicketContext }) => context.previousStatus === status,
    target: status,
    actions: ['clearError'] as const,
  }))
}

/**
 * XState machine defining every ticket lifecycle state and its allowed transitions.
 * States progress linearly through planning → execution → post-implementation,
 * with BLOCKED_ERROR as the universal error‐recovery state and CANCELED / COMPLETED
 * as terminal states.
 */
export const ticketMachine = setup({
  types: {
    context: {} as TicketContext,
    events: {} as TicketEvent,
    input: {} as TicketInput,
  },
  actions: {
    recordError: assign({
      error: ({ event }) => {
        if (event.type === 'ERROR') return event.message
        if (event.type === 'INIT_FAILED') return event.message
        if (event.type === 'CHECKS_FAILED') return 'Pre-flight check failed'
        if (event.type === 'EXECUTION_SETUP_PLAN_FAILED') return 'Execution setup plan failed'
        if (event.type === 'EXECUTION_SETUP_FAILED') return 'Execution setup failed'
        if (event.type === 'TESTS_FAILED') return 'Final test failed'
        if (event.type === 'BEAD_ERROR') return 'Bead execution failed'
        return 'Unknown error'
      },
      errorCodes: ({ event }) => {
        if (event.type === 'ERROR') return event.codes ?? []
        if (event.type === 'INIT_FAILED') return event.codes ?? []
        if (event.type === 'CHECKS_FAILED') return event.errors
        if (event.type === 'EXECUTION_SETUP_PLAN_FAILED') return event.errors ?? []
        if (event.type === 'EXECUTION_SETUP_FAILED') return event.errors ?? []
        if (event.type === 'BEAD_ERROR') return event.codes ?? []
        if (event.type === 'TESTS_FAILED') return [FINAL_TEST_FAILED]
        return []
      },
      errorDiagnostics: ({ event }) => {
        if (event.type === 'ERROR') return event.diagnostics ?? null
        if (event.type === 'BEAD_ERROR') return event.diagnostics ?? null
        return null
      },
      blockedErrorResolution: () => null,
    }),
    clearError: assign({
      error: () => null,
      errorCodes: () => [] as string[],
      errorDiagnostics: () => null,
      blockedErrorResolution: ({ event }) => {
        if (event.type === 'CONTINUE') return 'CONTINUED' as const
        if (event.type === 'RETRY') return 'RETRIED' as const
        return null
      },
    }),
    rememberExecutionSetupPlanRequest: assign({
      pendingExecutionSetupPlanRequestArtifactId: ({ event }) =>
        event.type === 'REGENERATE_EXECUTION_SETUP_PLAN' ? event.requestArtifactId : null,
    }),
    clearExecutionSetupPlanRequest: assign({
      pendingExecutionSetupPlanRequestArtifactId: () => null,
    }),
    updateStatus: assign({
      previousStatus: ({ context }) => context.status,
      status: (_, params: { status: string }) => params.status,
      updatedAt: () => new Date().toISOString(),
    }),
  },
  guards: {
    // total > 0 prevents 0/0 from passing as "complete"
    allBeadsComplete: ({ context }) =>
      context.beadProgress.completed >= context.beadProgress.total &&
      context.beadProgress.total > 0,
    manualQaEnabled: ({ context }) => context.lockedManualQaEnabled === true,
  },
}).createMachine({
  id: 'ticket',
  initial: 'DRAFT',
  context: ({ input }) => ({
    ticketId: input.ticketId ?? '',
    projectId: input.projectId ?? 0,
    externalId: input.externalId ?? '',
    title: input.title ?? '',
    status: 'DRAFT',
    lockedMainImplementer: input.lockedMainImplementer ?? null,
    lockedMainImplementerVariant: input.lockedMainImplementerVariant ?? null,
    lockedCouncilMembers: input.lockedCouncilMembers ?? null,
    lockedCouncilMemberVariants: input.lockedCouncilMemberVariants ?? null,
    lockedInterviewQuestions: input.lockedInterviewQuestions ?? null,
    lockedCoverageFollowUpBudgetPercent: input.lockedCoverageFollowUpBudgetPercent ?? null,
    lockedMaxCoveragePasses: input.lockedMaxCoveragePasses ?? null,
    lockedMaxPrdCoveragePasses: input.lockedMaxPrdCoveragePasses ?? null,
    lockedMaxBeadsCoveragePasses: input.lockedMaxBeadsCoveragePasses ?? null,
    lockedStructuredRetryCount: input.lockedStructuredRetryCount ?? null,
    lockedManualQaEnabled: input.lockedManualQaEnabled ?? null,
    lockedManualQaSource: input.lockedManualQaSource ?? null,
    pendingExecutionSetupPlanRequestArtifactId: null,
    previousStatus: null,
    error: null,
    errorCodes: [],
    errorDiagnostics: null,
    blockedErrorResolution: null,
    beadProgress: { total: 0, completed: 0, current: null },
    iterationCount: 0,
    maxIterations: input.maxIterations ?? PROFILE_DEFAULTS.maxIterations,
    councilResults: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
  states: {
    DRAFT: {
      entry: [
        { type: 'updateStatus', params: { status: 'DRAFT' } },
      ],
      on: {
        START: {
          target: 'SCANNING_RELEVANT_FILES',
          actions: assign({
            lockedMainImplementer: ({ event }) => event.lockedMainImplementer ?? null,
            lockedMainImplementerVariant: ({ event }) => event.lockedMainImplementerVariant ?? null,
            lockedCouncilMembers: ({ event }) => event.lockedCouncilMembers ?? null,
            lockedCouncilMemberVariants: ({ event }) => event.lockedCouncilMemberVariants ?? null,
            lockedInterviewQuestions: ({ event }) => event.lockedInterviewQuestions ?? null,
            lockedCoverageFollowUpBudgetPercent: ({ event }) => event.lockedCoverageFollowUpBudgetPercent ?? null,
            lockedMaxCoveragePasses: ({ event }) => event.lockedMaxCoveragePasses ?? null,
            lockedMaxPrdCoveragePasses: ({ event }) => event.lockedMaxPrdCoveragePasses ?? null,
            lockedMaxBeadsCoveragePasses: ({ event }) => event.lockedMaxBeadsCoveragePasses ?? null,
            lockedStructuredRetryCount: ({ event }) => event.lockedStructuredRetryCount ?? null,
            lockedManualQaEnabled: ({ event }) => event.lockedManualQaEnabled ?? false,
            lockedManualQaSource: ({ event }) => event.lockedManualQaSource ?? null,
          }),
        },
        INIT_FAILED: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    SCANNING_RELEVANT_FILES: {
      entry: [
        { type: 'updateStatus', params: { status: 'SCANNING_RELEVANT_FILES' } },
      ],
      on: {
        RELEVANT_FILES_READY: { target: 'COUNCIL_DELIBERATING' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    COUNCIL_DELIBERATING: {
      entry: [
        { type: 'updateStatus', params: { status: 'COUNCIL_DELIBERATING' } },
      ],
      on: {
        QUESTIONS_READY: { target: 'COUNCIL_VOTING_INTERVIEW' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    COUNCIL_VOTING_INTERVIEW: {
      entry: [
        {
          type: 'updateStatus',
          params: { status: 'COUNCIL_VOTING_INTERVIEW' },
        },
      ],
      on: {
        WINNER_SELECTED: { target: 'COMPILING_INTERVIEW' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    COMPILING_INTERVIEW: {
      entry: [
        { type: 'updateStatus', params: { status: 'COMPILING_INTERVIEW' } },
      ],
      on: {
        READY: { target: 'WAITING_INTERVIEW_ANSWERS' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    WAITING_INTERVIEW_ANSWERS: {
      entry: [
        {
          type: 'updateStatus',
          params: { status: 'WAITING_INTERVIEW_ANSWERS' },
        },
      ],
      on: {
        BATCH_ANSWERED: { target: 'WAITING_INTERVIEW_ANSWERS' },
        INTERVIEW_COMPLETE: { target: 'VERIFYING_INTERVIEW_COVERAGE' },
        SKIP_ALL_TO_APPROVAL: { target: 'WAITING_INTERVIEW_APPROVAL' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    VERIFYING_INTERVIEW_COVERAGE: {
      entry: [
        {
          type: 'updateStatus',
          params: { status: 'VERIFYING_INTERVIEW_COVERAGE' },
        },
      ],
      on: {
        COVERAGE_CLEAN: { target: 'WAITING_INTERVIEW_APPROVAL' },
        GAPS_FOUND: { target: 'WAITING_INTERVIEW_ANSWERS' },
        COVERAGE_LIMIT_REACHED: { target: 'WAITING_INTERVIEW_APPROVAL' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    WAITING_INTERVIEW_APPROVAL: {
      entry: [
        {
          type: 'updateStatus',
          params: { status: 'WAITING_INTERVIEW_APPROVAL' },
        },
      ],
      on: {
        APPROVE: { target: 'DRAFTING_PRD' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    DRAFTING_PRD: {
      entry: [
        { type: 'updateStatus', params: { status: 'DRAFTING_PRD' } },
      ],
      on: {
        DRAFTS_READY: { target: 'COUNCIL_VOTING_PRD' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    COUNCIL_VOTING_PRD: {
      entry: [
        { type: 'updateStatus', params: { status: 'COUNCIL_VOTING_PRD' } },
      ],
      on: {
        WINNER_SELECTED: { target: 'REFINING_PRD' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    REFINING_PRD: {
      entry: [
        { type: 'updateStatus', params: { status: 'REFINING_PRD' } },
      ],
      on: {
        REFINED: { target: 'VERIFYING_PRD_COVERAGE' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    VERIFYING_PRD_COVERAGE: {
      entry: [
        { type: 'updateStatus', params: { status: 'VERIFYING_PRD_COVERAGE' } },
      ],
      on: {
        COVERAGE_CLEAN: { target: 'WAITING_PRD_APPROVAL' },
        // Dead transition — PRD coverage loops internally via handlePrdCoverageVerificationLoop
        // and only emits COVERAGE_CLEAN or COVERAGE_LIMIT_REACHED. Kept for defensive safety.
        GAPS_FOUND: { target: 'REFINING_PRD' },
        COVERAGE_LIMIT_REACHED: { target: 'WAITING_PRD_APPROVAL' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    WAITING_PRD_APPROVAL: {
      entry: [
        { type: 'updateStatus', params: { status: 'WAITING_PRD_APPROVAL' } },
      ],
      on: {
        APPROVE: { target: 'DRAFTING_BEADS' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    DRAFTING_BEADS: {
      entry: [
        { type: 'updateStatus', params: { status: 'DRAFTING_BEADS' } },
      ],
      on: {
        DRAFTS_READY: { target: 'COUNCIL_VOTING_BEADS' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    COUNCIL_VOTING_BEADS: {
      entry: [
        { type: 'updateStatus', params: { status: 'COUNCIL_VOTING_BEADS' } },
      ],
      on: {
        WINNER_SELECTED: { target: 'REFINING_BEADS' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    REFINING_BEADS: {
      entry: [
        { type: 'updateStatus', params: { status: 'REFINING_BEADS' } },
      ],
      on: {
        REFINED: { target: 'VERIFYING_BEADS_COVERAGE' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    VERIFYING_BEADS_COVERAGE: {
      entry: [
        {
          type: 'updateStatus',
          params: { status: 'VERIFYING_BEADS_COVERAGE' },
        },
      ],
      on: {
        COVERAGE_CLEAN: { target: 'EXPANDING_BEADS' },
        // Dead transition — beads coverage loops internally via handleBeadsCoverageVerificationLoop
        // and only emits COVERAGE_CLEAN or COVERAGE_LIMIT_REACHED. Kept for defensive safety.
        GAPS_FOUND: { target: 'REFINING_BEADS' },
        COVERAGE_LIMIT_REACHED: { target: 'EXPANDING_BEADS' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    EXPANDING_BEADS: {
      entry: [
        { type: 'updateStatus', params: { status: 'EXPANDING_BEADS' } },
      ],
      on: {
        EXPANDED: { target: 'WAITING_BEADS_APPROVAL' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    WAITING_BEADS_APPROVAL: {
      entry: [
        { type: 'updateStatus', params: { status: 'WAITING_BEADS_APPROVAL' } },
      ],
      on: {
        APPROVE: { target: 'PRE_FLIGHT_CHECK' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    PRE_FLIGHT_CHECK: {
      entry: [
        { type: 'updateStatus', params: { status: 'PRE_FLIGHT_CHECK' } },
      ],
      on: {
        CHECKS_PASSED: { target: 'GENERATING_EXECUTION_SETUP_PLAN' },
        CHECKS_FAILED: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    GENERATING_EXECUTION_SETUP_PLAN: {
      entry: [
        { type: 'updateStatus', params: { status: 'GENERATING_EXECUTION_SETUP_PLAN' } },
      ],
      on: {
        EXECUTION_SETUP_PLAN_READY: {
          target: 'WAITING_EXECUTION_SETUP_APPROVAL',
          actions: ['clearExecutionSetupPlanRequest'],
        },
        EXECUTION_SETUP_PLAN_FAILED: {
          target: 'WAITING_EXECUTION_SETUP_APPROVAL',
          actions: ['clearExecutionSetupPlanRequest'],
        },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    WAITING_EXECUTION_SETUP_APPROVAL: {
      entry: [
        { type: 'updateStatus', params: { status: 'WAITING_EXECUTION_SETUP_APPROVAL' } },
      ],
      on: {
        REGENERATE_EXECUTION_SETUP_PLAN: {
          target: 'GENERATING_EXECUTION_SETUP_PLAN',
          actions: ['rememberExecutionSetupPlanRequest'],
        },
        APPROVE_EXECUTION_SETUP_PLAN: { target: 'PREPARING_EXECUTION_ENV' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    PREPARING_EXECUTION_ENV: {
      entry: [
        { type: 'updateStatus', params: { status: 'PREPARING_EXECUTION_ENV' } },
      ],
      on: {
        EXECUTION_SETUP_EVIDENCE_CHANGED: { target: 'WAITING_EXECUTION_SETUP_APPROVAL' },
        REGENERATE_EXECUTION_SETUP_PLAN: {
          target: 'GENERATING_EXECUTION_SETUP_PLAN',
          actions: ['rememberExecutionSetupPlanRequest'],
        },
        EXECUTION_SETUP_READY: { target: 'CODING' },
        EXECUTION_SETUP_FAILED: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    CODING: {
      entry: [
        { type: 'updateStatus', params: { status: 'CODING' } },
      ],
      on: {
        // Guard-first: if all beads are done, advance to final testing;
        // otherwise stay in CODING and pick the next runnable bead.
        BEAD_COMPLETE: [
          { guard: 'allBeadsComplete', target: 'RUNNING_FINAL_TEST' },
          { target: 'CODING' },
        ],
        ALL_BEADS_DONE: { target: 'RUNNING_FINAL_TEST' },
        BEAD_ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    RUNNING_FINAL_TEST: {
      entry: [
        { type: 'updateStatus', params: { status: 'RUNNING_FINAL_TEST' } },
      ],
      on: {
        TESTS_PASSED: [
          { guard: 'manualQaEnabled', target: 'GENERATING_QA_CHECKLIST' },
          { target: 'INTEGRATING_CHANGES' },
        ],
        TESTS_FAILED: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    GENERATING_QA_CHECKLIST: {
      entry: [
        { type: 'updateStatus', params: { status: 'GENERATING_QA_CHECKLIST' } },
      ],
      on: {
        QA_CHECKLIST_READY: { target: 'WAITING_MANUAL_QA' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    WAITING_MANUAL_QA: {
      entry: [
        { type: 'updateStatus', params: { status: 'WAITING_MANUAL_QA' } },
      ],
      on: {
        MANUAL_QA_COMPLETE: { target: 'INTEGRATING_CHANGES' },
        MANUAL_QA_SKIPPED: { target: 'INTEGRATING_CHANGES' },
        MANUAL_QA_FIXES_CREATED: { target: 'CODING' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    INTEGRATING_CHANGES: {
      entry: [
        { type: 'updateStatus', params: { status: 'INTEGRATING_CHANGES' } },
      ],
      on: {
        INTEGRATION_DONE: { target: 'CREATING_PULL_REQUEST' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    CREATING_PULL_REQUEST: {
      entry: [
        {
          type: 'updateStatus',
          params: { status: 'CREATING_PULL_REQUEST' },
        },
      ],
      on: {
        PULL_REQUEST_READY: { target: 'WAITING_PR_REVIEW' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    WAITING_PR_REVIEW: {
      entry: [
        {
          type: 'updateStatus',
          params: { status: 'WAITING_PR_REVIEW' },
        },
      ],
      on: {
        MERGE_COMPLETE: { target: 'CLEANING_ENV' },
        CLOSE_UNMERGED_COMPLETE: { target: 'CLEANING_ENV' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    CLEANING_ENV: {
      entry: [
        { type: 'updateStatus', params: { status: 'CLEANING_ENV' } },
      ],
      on: {
        CLEANUP_DONE: { target: 'COMPLETED' },
        ERROR: { target: 'BLOCKED_ERROR', actions: ['recordError'] },
        CANCEL: { target: 'CANCELED' },
      },
    },
    BLOCKED_ERROR: {
      entry: [
        { type: 'updateStatus', params: { status: 'BLOCKED_ERROR' } },
      ],
      on: {
        RETRY: buildBlockedErrorResumeTransitions(),
        CONTINUE: buildBlockedErrorResumeTransitions(),
        CANCEL: { target: 'CANCELED' },
      },
    },
    COMPLETED: {
      type: 'final' as const,
      entry: [
        { type: 'updateStatus', params: { status: 'COMPLETED' } },
      ],
    },
    CANCELED: {
      type: 'final' as const,
      entry: [
        { type: 'updateStatus', params: { status: 'CANCELED' } },
      ],
    },
  },
})
