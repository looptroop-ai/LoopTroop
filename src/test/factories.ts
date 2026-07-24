/**
 * Shared test factories for client-side tests.
 * Eliminates hardcoded ticket IDs, model names, and project-specific data.
 */
import type { Ticket } from '@/hooks/useTickets'
import type { PrdDocument } from '@/lib/prdDocument'

// ---------------------------------------------------------------------------
// Generic test constants — never reference real ticket/project names
// ---------------------------------------------------------------------------
export const TEST = {
  ticketId: '1:TEST-1',
  externalId: 'TEST-1',
  projectId: 1,
  projectName: 'TestProject',
  shortname: 'TEST',
  shortnameB: 'TSTB',
  shortnameC: 'TSTC',
  model: 'test-vendor/test-model',
  implementer: 'test-vendor/test-implementer',
  councilMembers: ['test-vendor/council-a', 'test-vendor/council-b'] as string[],
  timestamp: '2026-01-01T00:00:00.000Z',
  epicId: 'EPIC-A',
  storyId: 'US-A1',
} as const

// ---------------------------------------------------------------------------
// Client Ticket factory
// ---------------------------------------------------------------------------
type TicketRuntime = Ticket['runtime']
type RuntimeBead = NonNullable<TicketRuntime['beads']>[number]
export type RuntimeBeadInput = Omit<RuntimeBead, 'failedIterationNotes' | 'userRetryNotes' | 'finalizationFailureNotes'> & Partial<Pick<RuntimeBead, 'failedIterationNotes' | 'userRetryNotes' | 'finalizationFailureNotes'>>
type TicketOverrides = Omit<Partial<Ticket>, 'runtime'> & {
  runtime?: Omit<Partial<TicketRuntime>, 'beads'> & { beads?: RuntimeBeadInput[] }
}

export function makeRuntimeBead(overrides: RuntimeBeadInput): RuntimeBead {
  return {
    ...overrides,
    failedIterationNotes: overrides.failedIterationNotes ?? [],
    userRetryNotes: overrides.userRetryNotes ?? [],
    finalizationFailureNotes: overrides.finalizationFailureNotes ?? [],
  }
}

export function makeTicket(overrides: TicketOverrides = {}): Ticket {
  const { runtime: runtimeOverrides, ...ticketOverrides } = overrides
  return {
    id: TEST.ticketId,
    externalId: TEST.externalId,
    projectId: TEST.projectId,
    isDisplayOnlyMock: false,
    title: 'Test ticket',
    description: null,
    priority: 3,
    status: 'DRAFT',
    xstateSnapshot: null,
    branchName: null,
    currentBead: null,
    totalBeads: null,
    percentComplete: null,
    errorMessage: null,
    errorSeenSignature: null,
    needsInputSeenSignature: null,
    implementationTiming: {
      activeDurationMs: 0,
      startedAt: null,
      lastBeadFinishedAt: null,
      workspacePreparationDurationMs: 0,
      workspacePreparationStartedAt: null,
      finalTestingDurationMs: 0,
      finalTestingStartedAt: null,
    },
    errorOccurrences: [],
    activeErrorOccurrenceId: null,
    hasPastErrors: false,
    completionDisposition: null,
    lockedMainImplementer: null,
    lockedMainImplementerVariant: null,
    lockedInterviewQuestions: null,
    lockedCoverageFollowUpBudgetPercent: null,
    lockedMaxCoveragePasses: null,
    lockedMaxPrdCoveragePasses: null,
    lockedMaxBeadsCoveragePasses: null,
    lockedStructuredRetryCount: null,
    lockedCouncilMembers: [...TEST.councilMembers],
    lockedCouncilMemberVariants: null,
    availableActions: [],
    previousStatus: null,
    reviewCutoffStatus: null,
    runtime: {
      baseBranch: 'main',
      currentBead: 0,
      completedBeads: 0,
      totalBeads: 0,
      percentComplete: 0,
      iterationCount: 0,
      maxIterations: null,
      maxIterationsPerBead: null,
      activeBeadId: null,
      activeBeadIteration: null,
      lastFailedBeadId: null,
      artifactRoot: '/tmp/test-ticket',
      candidateCommitSha: null,
      preSquashHead: null,
      finalTestStatus: 'pending',
      prNumber: null,
      prUrl: null,
      prState: null,
      prHeadSha: null,
      ...runtimeOverrides,
      beads: runtimeOverrides?.beads?.map(makeRuntimeBead) ?? [],
    },
    startedAt: null,
    plannedDate: null,
    createdAt: TEST.timestamp,
    updatedAt: TEST.timestamp,
    ...ticketOverrides,
  }
}

// ---------------------------------------------------------------------------
// Log entry factory
// ---------------------------------------------------------------------------
export function makeLogEntry(overrides: Record<string, unknown> = {}) {
  return {
    ts: Date.now(),
    phase: 'CODING',
    event: 'test_event',
    detail: 'Test detail',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// PrdDocument factory
// ---------------------------------------------------------------------------
export function makePrdDocument(overrides: Partial<PrdDocument> = {}): PrdDocument {
  return {
    schema_version: 1,
    ticket_id: TEST.externalId,
    artifact: 'prd',
    status: 'draft',
    source_interview: { content_sha256: 'mock-sha' },
    product: {
      problem_statement: 'Test problem statement.',
      target_users: ['Operators'],
    },
    scope: {
      in_scope: ['Test scope item'],
      out_of_scope: ['Out of scope item'],
    },
    technical_requirements: {
      architecture_constraints: ['Use the existing worker.'],
      data_model: [],
      api_contracts: [],
      security_constraints: [],
      performance_constraints: [],
      reliability_constraints: [],
      error_handling_rules: [],
      tooling_assumptions: [],
    },
    epics: [
      {
        id: TEST.epicId,
        title: 'Test epic',
        objective: 'Validate the test scenario.',
        implementation_steps: ['Add test step'],
        user_stories: [
          {
            id: TEST.storyId,
            title: 'As a user, I can perform the test action.',
            acceptance_criteria: ['Test criterion is met.'],
            implementation_steps: ['Render the test panel.'],
            verification: { required_commands: ['npm test'] },
          },
        ],
      },
    ],
    risks: [],
    approval: { approved_by: '', approved_at: '' },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Bead factory
// ---------------------------------------------------------------------------
export function makeBead(overrides: Record<string, unknown> = {}) {
  return {
    id: `${TEST.shortname.toLowerCase()}-1-test-bead`,
    title: 'Test bead task',
    prdRefs: [TEST.epicId, TEST.storyId],
    description: 'A test bead description.',
    contextGuidance: {
      patterns: ['Reuse the shared renderer.'],
      anti_patterns: ['Do not duplicate layout.'],
    },
    acceptanceCriteria: ['Test criterion is met.'],
    tests: ['Run the test.'],
    testCommands: ['npm test'],
    priority: 1,
    status: 'pending',
    issueType: 'task',
    externalRef: TEST.externalId,
    labels: [`ticket:${TEST.shortname}-1`],
    dependencies: { blocked_by: [], blocks: [] },
    targetFiles: ['src/test/example.ts'],
    failedIterationNotes: [],
    userRetryNotes: [],
    finalizationFailureNotes: [],
    iteration: 1,
    createdAt: '',
    updatedAt: TEST.timestamp,
    completedAt: '',
    startedAt: '',
    beadStartCommit: null,
    ...overrides,
  }
}
