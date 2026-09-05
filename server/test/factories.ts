/**
 * Shared pure test factories for server-side tests.
 * Keep this module free of DB, filesystem, git, or router helpers.
 */
import * as jsYaml from 'js-yaml'
import type { InterviewDocument, InterviewDocumentQuestion } from '@shared/interviewArtifact'
import type { PrdDocument } from '../structuredOutput/types'
import type { TicketContext } from '../machines/types'
import { createShellCommandSpec } from '@shared/commandSpec'

interface TicketLike {
  id: string
  projectId: number
  externalId: string
  title: string
  status: string
  createdAt: string
  updatedAt: string
}

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
  model: 'test-vendor/test-model',
  implementer: 'test-vendor/test-implementer',
  councilMembers: ['test-vendor/council-a', 'test-vendor/council-b'],
  timestamp: '2026-01-01T00:00:00.000Z',
} as const

function buildYamlDocument(value: unknown): string {
  return jsYaml.dump(value, { lineWidth: 120, noRefs: true }) as string
}

// ---------------------------------------------------------------------------
// Machine TicketContext factory
// ---------------------------------------------------------------------------
export function makeTicketContext(
  overrides: Partial<TicketContext> = {},
): TicketContext {
  return {
    ticketId: TEST.ticketId,
    projectId: TEST.projectId,
    externalId: TEST.externalId,
    title: 'Test ticket',
    status: 'DRAFT',
    lockedMainImplementer: TEST.implementer,
    lockedMainImplementerVariant: null,
    lockedCouncilMembers: [...TEST.councilMembers],
    lockedCouncilMemberVariants: null,
    lockedInterviewQuestions: null,
    lockedCoverageFollowUpBudgetPercent: null,
    lockedMaxCoveragePasses: null,
    lockedMaxPrdCoveragePasses: null,
    lockedMaxBeadsCoveragePasses: null,
    lockedStructuredRetryCount: null,
    pendingExecutionSetupPlanRequestArtifactId: null,
    previousStatus: null,
    error: null,
    errorCodes: [],
    errorDiagnostics: null,
    blockedErrorResolution: null,
    beadProgress: { total: 0, completed: 0, current: null },
    iterationCount: 0,
    maxIterations: 5,
    councilResults: null,
    createdAt: TEST.timestamp,
    updatedAt: TEST.timestamp,
    ...overrides,
    lockedManualQaEnabled: overrides.lockedManualQaEnabled ?? null,
    lockedManualQaSource: overrides.lockedManualQaSource ?? null,
    lockedAiQuestionsEnabled: overrides.lockedAiQuestionsEnabled ?? null,
    lockedAiQuestionsSource: overrides.lockedAiQuestionsSource ?? null,
    lockedAiQuestionWindow: overrides.lockedAiQuestionWindow ?? null,
    lockedAiQuestionWindowSource: overrides.lockedAiQuestionWindowSource ?? null,
  }
}

/**
 * Build a TicketContext from a real PublicTicket-like object returned by createTicket().
 */
export function makeTicketContextFromTicket(
  ticket: TicketLike,
  overrides: Partial<TicketContext> = {},
): TicketContext {
  return makeTicketContext({
    ticketId: ticket.id,
    projectId: ticket.projectId,
    externalId: ticket.externalId,
    title: ticket.title,
    status: ticket.status,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Interview document factory
// ---------------------------------------------------------------------------
export function makeInterviewQuestion(
  overrides: Partial<InterviewDocumentQuestion> = {},
): InterviewDocumentQuestion {
  return {
    id: 'Q01',
    phase: 'Foundation',
    prompt: 'What are the key requirements?',
    source: 'compiled',
    follow_up_round: null,
    answer_type: 'free_text',
    options: [],
    answer: {
      skipped: true,
      selected_option_ids: [],
      free_text: '',
      answered_by: 'ai_skip',
      answered_at: '', skip_reason: null,
    },
    ...overrides,
  }
}

export function makeInterviewDocument(
  overrides: Partial<InterviewDocument> = {},
): InterviewDocument {
  return {
    schema_version: 1,
    ticket_id: TEST.externalId,
    artifact: 'interview',
    status: 'approved',
    generated_by: {
      winner_model: TEST.model,
      generated_at: TEST.timestamp,
    },
    questions: [makeInterviewQuestion()],
    follow_up_rounds: [],
    summary: {
      goals: ['Implement the feature'],
      constraints: ['Preserve existing behavior'],
      non_goals: ['Unrelated scope'],
      final_free_form_answer: '',
    },
    approval: {
      approved_by: '',
      approved_at: '',
    },
    ...overrides,
  }
}

export function makeInterviewYaml(
  overrides: Partial<InterviewDocument> = {},
): string {
  return buildYamlDocument(makeInterviewDocument(overrides))
}

// ---------------------------------------------------------------------------
// PRD YAML factory
// ---------------------------------------------------------------------------
export function makePrdYaml(overrides: {
  ticketId?: string
  status?: string
  problemStatement?: string
  epicCount?: number
  storyCount?: number
} = {}): string {
  const tid = overrides.ticketId ?? TEST.externalId
  const status = overrides.status ?? 'draft'
  const problem = overrides.problemStatement ?? 'Implement the planned feature.'
  const epicCount = overrides.epicCount ?? 1
  const storyCount = overrides.storyCount ?? 1

  const epics: string[] = []
  for (let e = 1; e <= epicCount; e++) {
    epics.push(
      `  - id: EPIC-${e}`,
      `    title: Epic ${e}`,
      `    objective: Deliver epic ${e}.`,
      `    implementation_steps: [Implement epic ${e}]`,
      '    user_stories:',
    )
    for (let s = 1; s <= storyCount; s++) {
      epics.push(
        `      - id: US-${s}`,
        `        title: Story ${s}`,
        `        acceptance_criteria: [Criteria ${s}]`,
        `        implementation_steps: [Implement story ${s}]`,
        '        verification:',
        '          required_commands: [npm run test]',
      )
    }
  }

  return [
    'schema_version: 1',
    `ticket_id: ${tid}`,
    'artifact: prd',
    `status: ${status}`,
    'source_interview:',
    '  content_sha256: test-hash',
    'product:',
    `  problem_statement: ${problem}`,
    '  target_users: [Engineers]',
    'scope:',
    '  in_scope: [Feature implementation]',
    '  out_of_scope: [Unrelated scope]',
    'technical_requirements:',
    '  architecture_constraints: [Reuse existing patterns]',
    '  data_model: []',
    '  api_contracts: []',
    '  security_constraints: []',
    '  performance_constraints: []',
    '  reliability_constraints: [Fail fast on invalid input]',
    '  error_handling_rules: [Persist only normalized output]',
    '  tooling_assumptions: [Vitest test runner]',
    'epics:',
    ...epics,
    'risks: []',
    'approval:',
    '  approved_by: ""',
    '  approved_at: ""',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Full interview document builder (for route / approval tests)
// ---------------------------------------------------------------------------
export function buildInterviewDocument(
  ticketId: string,
  status: 'draft' | 'approved' = 'approved',
): InterviewDocument {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    artifact: 'interview',
    status,
    generated_by: {
      winner_model: TEST.model,
      generated_at: TEST.timestamp,
      canonicalization: 'server_normalized',
    },
    questions: [
      {
        id: 'Q01',
        phase: 'Foundation',
        prompt: 'What outcome matters most?',
        source: 'compiled',
        follow_up_round: null,
        answer_type: 'free_text',
        options: [],
        answer: {
          skipped: false,
          selected_option_ids: [],
          free_text: 'Protect the import pipeline.',
          answered_by: 'user',
          answered_at: TEST.timestamp, skip_reason: null,
        },
      },
      {
        id: 'FINAL',
        phase: 'Assembly',
        prompt: 'Anything else the team should know?',
        source: 'final_free_form',
        follow_up_round: null,
        answer_type: 'free_text',
        options: [],
        answer: {
          skipped: false,
          selected_option_ids: [],
          free_text: 'Keep retries observable.',
          answered_by: 'user',
          answered_at: TEST.timestamp, skip_reason: null,
        },
      },
    ],
    follow_up_rounds: [
      {
        round_number: 1,
        source: 'prom4',
        question_ids: ['Q01'],
      },
    ],
    summary: {
      goals: ['Protect imports'],
      constraints: ['No duplicate records'],
      non_goals: ['Bulk reprocessing'],
      final_free_form_answer: 'Keep retries observable.',
    },
    approval: {
      approved_by: status === 'approved' ? 'user' : '',
      approved_at: status === 'approved' ? TEST.timestamp : '',
    },
  }
}

// ---------------------------------------------------------------------------
// Full PRD document builder (for route / approval tests)
// ---------------------------------------------------------------------------
export function buildPrdDocument(ticketId: string, interviewContentSha256: string): PrdDocument {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    artifact: 'prd',
    status: 'draft',
    source_interview: { content_sha256: interviewContentSha256 },
    product: {
      problem_statement: 'Import pipeline needs resilience against transient failures.',
      target_users: ['Backend engineers', 'SRE team'],
    },
    scope: {
      in_scope: ['Retry logic for failed imports', 'Observable retry metrics'],
      out_of_scope: ['Bulk reprocessing UI'],
    },
    technical_requirements: {
      architecture_constraints: ['Must integrate with existing message queue'],
      data_model: ['Add retry_count column to imports table'],
      api_contracts: ['POST /imports/:id/retry'],
      security_constraints: ['Retry tokens must expire after 5 minutes'],
      performance_constraints: ['Retries must complete within 30 seconds'],
      reliability_constraints: ['At-least-once delivery guarantee'],
      error_handling_rules: ['Dead-letter queue for failed retries'],
      tooling_assumptions: ['Node.js 20+', 'PostgreSQL 15+'],
    },
    epics: [
      {
        id: 'E01',
        title: 'Retry infrastructure',
        objective: 'Build core retry mechanism for failed imports.',
        implementation_steps: ['Add retry queue', 'Implement backoff strategy'],
        user_stories: [
          {
            id: 'E01-S01',
            title: 'Retry a single failed import',
            acceptance_criteria: ['Import is retried with exponential backoff', 'Retry count is tracked'],
            implementation_steps: ['Create retry handler', 'Update imports table schema'],
            verification: {
              required_commands: [createShellCommandSpec('npm test -- --grep "retry"')],
            },
          },
        ],
      },
    ],
    risks: ['Queue saturation under high failure rates'],
    approval: {
      approved_by: '',
      approved_at: '',
    },
  }
}

// ---------------------------------------------------------------------------
// Beads YAML factory
// ---------------------------------------------------------------------------
export function makeBeadsYaml(options: {
  beadCount?: number
} = {}): string {
  const count = options.beadCount ?? 1
  const lines = ['beads:']
  for (let i = 1; i <= count; i++) {
    lines.push(
      `  - id: "bead-${i}"`,
      `    title: "Bead ${i}"`,
      `    prdRefs: ["EPIC-1 / US-${i}"]`,
      `    description: "Implement bead ${i}."`,
      '    contextGuidance: |',
      '      Patterns:',
      '      - Follow existing conventions.',
      '      Anti-patterns:',
      '      - Avoid unnecessary scope.',
      '    acceptanceCriteria:',
      `      - "Bead ${i} acceptance criteria met"`,
      '    tests:',
      `      - "Bead ${i} tests pass"`,
      '    testCommands:',
      '      - "npm run test"',
    )
  }
  return lines.join('\n')
}
