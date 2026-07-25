import type { DBartifact } from '@/hooks/useTicketArtifacts'
import { TEST } from '@/test/factories'

interface InterviewDocumentContentOptions {
  questions?: Array<Record<string, unknown>>
  summary?: Record<string, unknown>
  status?: 'draft' | 'approved'
  winnerModel?: string
  generatedAt?: string
}

interface PrdDocumentContentOptions {
  epicTitle?: string
  storyTitle?: string
  acceptanceCriterion?: string
  architectureConstraint?: string
  status?: 'draft' | 'approved'
}

interface BeadsDraftContentOptions {
  title?: string
  guidance?: string | {
    patterns?: string[]
    anti_patterns?: string[]
  }
}

interface BeadDocumentContent {
  id: string
  title: string
  description?: string
}

const DEFAULT_GENERATED_AT = '2026-03-25T09:00:00.000Z'
const DEFAULT_WINNER_MODEL = 'openai/gpt-5'
const DEFAULT_EXECUTION_SETUP_ROOT = '.ticket/runtime/execution-setup'

export function buildCanonicalInterviewContent(questions: Array<Record<string, unknown>>) {
  return JSON.stringify({
    artifact: 'interview',
    questions,
  })
}

export function buildInterviewDocumentContent({
  questions = [],
  summary,
  status = 'draft',
  winnerModel = DEFAULT_WINNER_MODEL,
  generatedAt = DEFAULT_GENERATED_AT,
}: InterviewDocumentContentOptions = {}) {
  return JSON.stringify({
    schema_version: 1,
    ticket_id: TEST.externalId,
    artifact: 'interview',
    status,
    generated_by: {
      winner_model: winnerModel,
      generated_at: generatedAt,
    },
    questions,
    follow_up_rounds: [],
    summary: summary ?? {
      goals: [],
      constraints: [],
      non_goals: [],
      final_free_form_answer: '',
    },
    approval: {
      approved_by: '',
      approved_at: '',
    },
  })
}

export function buildPhaseArtifactsInterviewDocumentContent() {
  return [
    'schema_version: 1',
    `ticket_id: ${TEST.externalId}`,
    'artifact: interview',
    'status: draft',
    'generated_by:',
    '  winner_model: openai/gpt-5.2',
    `  generated_at: ${DEFAULT_GENERATED_AT}`,
    'questions:',
    '  - id: Q01',
    '    phase: Foundation',
    '    prompt: "How should skipped answers be completed?"',
    '    source: compiled',
    '    answer_type: free_text',
    '    options: []',
    '    answer:',
    '      skipped: false',
    '      selected_option_ids: []',
    '      free_text: "Use AI-authored answers and label them clearly."',
    '      answered_by: ai_skip',
    `      answered_at: ${DEFAULT_GENERATED_AT}`,
    'follow_up_rounds: []',
    'summary:',
    '  goals: []',
    '  constraints: []',
    '  non_goals: []',
    '  final_free_form_answer: ""',
    'approval:',
    '  approved_by: ""',
    '  approved_at: ""',
  ].join('\n')
}

export function buildPrdDocumentContent({
  epicTitle = 'Restore rich PRD views',
  storyTitle = 'Review PRD drafts',
  acceptanceCriterion = 'Show epics and user stories in the structured view.',
  architectureConstraint = 'UI-only change',
  status = 'draft',
}: PrdDocumentContentOptions = {}) {
  return [
    'schema_version: 1',
    `ticket_id: ${TEST.externalId}`,
    'artifact: prd',
    `status: ${status}`,
    'source_interview:',
    '  content_sha256: mock-sha',
    'product:',
    '  problem_statement: "Restore the richer PRD artifact viewer."',
    '  target_users:',
    '    - "LoopTroop maintainers"',
    'scope:',
    '  in_scope:',
    '    - "PRD artifact dialogs"',
    '  out_of_scope:',
    '    - "Workflow logic"',
    'technical_requirements:',
    '  architecture_constraints:',
    `    - "${architectureConstraint}"`,
    '  data_model: []',
    '  api_contracts: []',
    '  security_constraints: []',
    '  performance_constraints: []',
    '  reliability_constraints: []',
    '  error_handling_rules: []',
    '  tooling_assumptions: []',
    'epics:',
    `  - id: "${TEST.epicId}"`,
    `    title: "${epicTitle}"`,
    '    objective: "Make PRD artifacts easy to inspect."',
    '    user_stories:',
    `      - id: "${TEST.storyId}"`,
    `        title: "${storyTitle}"`,
    '        acceptance_criteria:',
    `          - "${acceptanceCriterion}"`,
    'approval:',
    '  approved_by: ""',
    '  approved_at: ""',
  ].join('\n')
}

export function buildBeadsDraftContent({
  title = 'Render structured guidance safely',
  guidance = {
    patterns: ['Reuse the shared bead viewer for every artifact path.'],
    anti_patterns: ['Do not render structured guidance objects directly into JSX.'],
  },
}: BeadsDraftContentOptions = {}) {
  return JSON.stringify([
    {
      id: 'bead-1',
      title,
      prdRefs: [TEST.epicId, TEST.storyId],
      description: 'Keep bead guidance readable in artifact dialogs.',
      contextGuidance: guidance,
    },
  ])
}

export function buildBeadsDocumentContent(
  beads: BeadDocumentContent[] = [{ id: 'bead-1', title: 'Validate refinement attribution' }],
) {
  return [
    'beads:',
    ...beads.flatMap((bead) => [
      `  - id: "${bead.id}"`,
      `    title: "${bead.title}"`,
      `    prdRefs: ["${TEST.epicId} / ${TEST.storyId}"]`,
      `    description: "${bead.description ?? `Deliver ${bead.title.toLowerCase()}.`}"`,
      '    contextGuidance: "Keep attribution deterministic."',
      '    acceptanceCriteria:',
      `      - "Validate ${bead.title.toLowerCase()}"`,
      '    tests:',
      `      - "Test ${bead.title.toLowerCase()}"`,
      '    testCommands:',
      '      - "npm run test:server"',
    ]),
  ].join('\n')
}

export function buildBeadsDraftCompanionContent() {
  return JSON.stringify({
    baseArtifactType: 'beads_drafts',
    generatedAt: '2026-03-12T11:49:31.000Z',
    payload: {
      draftDetails: [
        {
          memberId: 'openai/gpt-5.2',
          duration: 42,
          draftMetrics: {
            beadCount: 2,
            totalTestCount: 5,
            totalAcceptanceCriteriaCount: 6,
          },
        },
      ],
    },
  })
}

export function buildExecutionSetupPlanContent(summary = 'Prepare workspace runtime assets safely.') {
  return JSON.stringify({
    schema_version: 1,
    ticket_id: TEST.externalId,
    artifact: 'execution_setup_plan',
    status: 'draft',
    summary,
    readiness: {
      status: 'partial',
      actions_required: true,
      evidence: ['Manifest and lockfile were detected.'],
      gaps: ['Workspace bootstrap outputs are still missing.'],
    },
    temp_roots: [DEFAULT_EXECUTION_SETUP_ROOT, `${DEFAULT_EXECUTION_SETUP_ROOT}/tool-cache`],
    workspace_probes: [{ id: 'workspace', command: 'project test --list', purpose: 'Load the actual workspace.' }],
    git_hooks: {
      policy: 'validate_advisory',
      detected: [{ name: 'pre-commit', path: '.husky/pre-commit', source: 'husky', kind: 'hook', runnable: 'yes', manager_hint: 'husky' }],
      validation_commands: [{ id: 'pre-commit-check', hook: 'pre-commit', command: 'project check', purpose: 'Run the pre-commit checks explicitly.' }],
    },
    steps: [
      {
        id: 'bootstrap',
        title: 'Bootstrap workspace',
        purpose: 'Prepare the runtime for later coding beads.',
        commands: ['project bootstrap'],
        required: true,
        rationale: 'Later commands depend on the workspace setup outputs being present.',
        cautions: ['This can take longer on the first run.'],
      },
    ],
    project_commands: {
      prepare: ['project bootstrap'],
      test_full: ['project test'],
      lint_full: ['project lint'],
      typecheck_full: ['project typecheck'],
    },
    quality_gate_policy: {
      tests: 'bead-test-commands-first',
      lint: 'impacted-or-package',
      typecheck: 'impacted-or-package',
      full_project_fallback: 'never-block-on-unrelated-baseline',
    },
    cautions: ['Repository-native bootstrap may create local dependency caches.'],
  }, null, 2)
}

export function buildExecutionSetupPlanReportContent() {
  return JSON.stringify({
    status: 'draft',
    ready: true,
    generatedAt: '2026-03-25T10:15:00.000Z',
    generatedBy: 'openai/gpt-5',
    summary: 'Prepare workspace runtime assets safely.',
    modelOutput: '<EXECUTION_SETUP_PLAN>\nsummary: regenerated\n</EXECUTION_SETUP_PLAN>',
    errors: [],
    notes: ['Switch to the project-native bootstrap command.'],
    source: 'regenerate',
  })
}

export function buildExecutionSetupProfileContent(summary = 'Runtime cache and command policy are ready.') {
  return JSON.stringify({
    schema_version: 1,
    ticket_id: TEST.externalId,
    artifact: 'execution_setup_profile',
    status: 'ready',
    summary,
    temp_roots: [DEFAULT_EXECUTION_SETUP_ROOT],
    bootstrap_commands: ['project bootstrap'],
    tooling_probe_commands: ['project --version'],
    workspace_probes: [{ id: 'workspace', command: 'project test --list', purpose: 'Load the workspace.' }],
    workspace_probe_receipts: [{ id: 'workspace', command: 'project test --list', status: 'passed', exitCode: 0, durationMs: 40, outputExcerpt: 'tests discovered' }],
    git_hooks: { policy: 'validate_advisory', detected: [], validation_commands: [], validation_receipts: [] },
    reusable_artifacts: [
      {
        path: `${DEFAULT_EXECUTION_SETUP_ROOT}/cache.json`,
        kind: 'cache',
        purpose: 'Reuse warmed runtime metadata during coding beads.',
      },
    ],
    project_commands: {
      prepare: ['project bootstrap'],
      test_full: ['project test'],
      lint_full: ['project lint'],
      typecheck_full: ['project typecheck'],
    },
    quality_gate_policy: {
      tests: 'bead-test-commands-first',
      lint: 'impacted-or-package',
      typecheck: 'impacted-or-package',
      full_project_fallback: 'never-block-on-unrelated-baseline',
    },
    cautions: ['Keep generated files under runtime roots.'],
  }, null, 2)
}

export function buildExecutionSetupProfileArtifactContent() {
  return JSON.stringify({
    schema_version: 1,
    ticket_id: TEST.externalId,
    artifact: 'execution_setup_profile',
    status: 'ready',
    summary: 'Runtime cache ready for implementation beads.',
    temp_roots: [DEFAULT_EXECUTION_SETUP_ROOT],
    bootstrap_commands: ['project bootstrap'],
    tooling_probe_commands: ['project --version'],
    workspace_probes: [{ id: 'workspace', command: 'project test --list', purpose: 'Load the workspace.' }],
    workspace_probe_receipts: [{ id: 'workspace', command: 'project test --list', status: 'passed', exitCode: 0, durationMs: 40, outputExcerpt: 'tests discovered' }],
    git_hooks: { policy: 'validate_advisory', detected: [], validation_commands: [], validation_receipts: [] },
    reusable_artifacts: [
      {
        path: `${DEFAULT_EXECUTION_SETUP_ROOT}/cache.json`,
        kind: 'cache',
        purpose: 'Reuse warmed runtime metadata.',
      },
    ],
    project_commands: {
      prepare: ['project bootstrap'],
      test_full: ['project test'],
      lint_full: ['project lint'],
      typecheck_full: ['project typecheck'],
    },
    quality_gate_policy: {
      tests: 'bead-test-commands-first',
      lint: 'impacted-or-package',
      typecheck: 'impacted-or-package',
      full_project_fallback: 'never-block-on-unrelated-baseline',
    },
    cautions: ['Keep generated files under runtime roots.'],
  })
}

export function buildExecutionSetupRuntimeReportContent() {
  return JSON.stringify({
    status: 'ready',
    ready: true,
    checkedAt: '2026-03-25T10:20:00.000Z',
    preparedBy: 'openai/gpt-5',
    summary: 'Runtime profile is ready for coding beads.',
    profile: {
      schemaVersion: 1,
      ticketId: TEST.externalId,
      artifact: 'execution_setup_profile',
      status: 'ready',
      summary: 'Runtime cache and command policy are ready.',
      tempRoots: [DEFAULT_EXECUTION_SETUP_ROOT],
      bootstrapCommands: ['project bootstrap'],
      toolingProbeCommands: ['project --version'],
      workspaceProbes: [{ id: 'workspace', command: 'project test --list', purpose: 'Load the workspace.' }],
      workspaceProbeReceipts: [{ id: 'workspace', command: 'project test --list', status: 'passed', exitCode: 0, durationMs: 40, outputExcerpt: 'tests discovered' }],
      gitHooks: { policy: 'validate_advisory', detected: [], validationCommands: [], validationReceipts: [] },
      reusableArtifacts: [
        {
          path: `${DEFAULT_EXECUTION_SETUP_ROOT}/cache.json`,
          kind: 'cache',
          purpose: 'Reuse warmed runtime metadata during coding beads.',
        },
      ],
      projectCommands: {
        prepare: ['project bootstrap'],
        testFull: ['project test'],
        lintFull: ['project lint'],
        typecheckFull: ['project typecheck'],
      },
      qualityGatePolicy: {
        tests: 'bead-test-commands-first',
        lint: 'impacted-or-package',
        typecheck: 'impacted-or-package',
        fullProjectFallback: 'never-block-on-unrelated-baseline',
      },
      cautions: ['Keep generated files under runtime roots.'],
    },
    checks: {
      workspace: 'pass',
      tooling: 'pass',
      tempScope: 'pass',
      policy: 'pass',
    },
    modelOutput: '<EXECUTION_SETUP_RESULT>{"status":"ready"}</EXECUTION_SETUP_RESULT>',
    errors: [],
    structuredOutput: {
      repairApplied: true,
      repairWarnings: ['Recovered setup result from model wrapper.'],
    },
    attempt: 1,
    maxIterations: 3,
    attemptHistory: [
      {
        attempt: 1,
        status: 'ready',
        checkedAt: '2026-03-25T10:20:00.000Z',
        summary: 'Runtime profile is ready for coding beads.',
        tempRoots: [DEFAULT_EXECUTION_SETUP_ROOT],
        bootstrapCommands: ['project bootstrap'],
        toolingProbeCommands: ['project --version'],
        errors: [],
      },
    ],
    retryNotes: [],
    approvedPlanCommands: ['project bootstrap'],
    executionAddedCommands: ['project cache verify'],
  })
}

export function buildExecutionSetupReportArtifactContent() {
  return JSON.stringify({
    status: 'ready',
    ready: true,
    checkedAt: '2026-03-25T10:20:00.000Z',
    preparedBy: 'openai/gpt-5',
    summary: 'Runtime profile is ready for coding beads.',
    profile: {
      schemaVersion: 1,
      ticketId: TEST.externalId,
      artifact: 'execution_setup_profile',
      status: 'ready',
      summary: 'Runtime cache ready for implementation beads.',
      tempRoots: [DEFAULT_EXECUTION_SETUP_ROOT],
      bootstrapCommands: ['project bootstrap'],
      toolingProbeCommands: ['project --version'],
      workspaceProbes: [{ id: 'workspace', command: 'project test --list', purpose: 'Load the workspace.' }],
      workspaceProbeReceipts: [{ id: 'workspace', command: 'project test --list', status: 'passed', exitCode: 0, durationMs: 40, outputExcerpt: 'tests discovered' }],
      gitHooks: { policy: 'validate_advisory', detected: [], validationCommands: [], validationReceipts: [] },
      reusableArtifacts: [
        {
          path: `${DEFAULT_EXECUTION_SETUP_ROOT}/cache.json`,
          kind: 'cache',
          purpose: 'Reuse warmed runtime metadata.',
        },
      ],
      projectCommands: {
        prepare: ['project bootstrap'],
        testFull: ['project test'],
        lintFull: ['project lint'],
        typecheckFull: ['project typecheck'],
      },
      qualityGatePolicy: {
        tests: 'bead-test-commands-first',
        lint: 'impacted-or-package',
        typecheck: 'impacted-or-package',
        fullProjectFallback: 'never-block-on-unrelated-baseline',
      },
      cautions: ['Keep generated files under runtime roots.'],
    },
    checks: {
      workspace: 'pass',
      tooling: 'pass',
      tempScope: 'pass',
      policy: 'pass',
    },
    modelOutput: '<EXECUTION_SETUP_RESULT>{"status":"ready"}</EXECUTION_SETUP_RESULT>',
    errors: [],
    attempt: 1,
    maxIterations: 3,
    attemptHistory: [
      {
        attempt: 1,
        status: 'ready',
        checkedAt: '2026-03-25T10:20:00.000Z',
        summary: 'Runtime profile is ready for coding beads.',
        tempRoots: [DEFAULT_EXECUTION_SETUP_ROOT],
        bootstrapCommands: ['project bootstrap'],
        toolingProbeCommands: ['project --version'],
        errors: [],
      },
    ],
    retryNotes: [],
    approvedPlanCommands: ['project bootstrap'],
    executionAddedCommands: ['project cache verify'],
  })
}

export function createArtifactFactory() {
  let nextArtifactId = 1

  return {
    makeArtifact(
      overrides: Partial<DBartifact> & Pick<DBartifact, 'phase' | 'artifactType' | 'content'>,
    ): DBartifact {
      return {
        id: nextArtifactId++,
        ticketId: TEST.ticketId,
        phaseAttempt: 1,
        filePath: null,
        createdAt: TEST.timestamp,
        updatedAt: TEST.timestamp,
        ...overrides,
      }
    },
    resetArtifactIds() {
      nextArtifactId = 1
    },
  }
}
