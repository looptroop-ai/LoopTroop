import { z } from 'zod'
import { hostContextSchema } from '@shared/hostContext'
import { commandSpecSchema } from '@shared/commandSpec'
import { SKIP_REASON_MAX_LENGTH } from '@shared/skipReceipt'
import { AI_QUESTION_WINDOW_MAX_MS, AI_QUESTION_WINDOW_MIN_MS } from '@shared/aiQuestions'

/**
 * Every skip reason on every surface, validated once.
 *
 * Empty and whitespace-only reasons are normalized to `null` at the storage
 * boundary rather than rejected here — a person clearing the box is saying "no
 * reason", not making a mistake.
 */
export const skipReasonSchema = z.string()
  .max(SKIP_REASON_MAX_LENGTH, `Reason must be ${SKIP_REASON_MAX_LENGTH.toLocaleString('en-US')} characters or fewer`)


export const createTicketSchema = z.object({
  projectId: z.number().int().positive(),
  title: z.string().min(1).max(500),
  description: z.string().max(50000).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  manualQaOverride: z.boolean().nullable().optional(),
  aiQuestionsOverride: z.boolean().nullable().optional(),
  aiQuestionWindowOverride: z.number().int().min(AI_QUESTION_WINDOW_MIN_MS).max(AI_QUESTION_WINDOW_MAX_MS).nullable().optional(),
}).strict()

export const updateTicketSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(50000).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  manualQaOverride: z.boolean().nullable().optional(),
  aiQuestionsOverride: z.boolean().nullable().optional(),
  aiQuestionWindowOverride: z.number().int().min(AI_QUESTION_WINDOW_MIN_MS).max(AI_QUESTION_WINDOW_MAX_MS).nullable().optional(),
}).strict()

export const cancelTicketSchema = z.object({
  deleteContent: z.boolean().default(false),
  deleteLog: z.boolean().default(false),
  deleteTicket: z.boolean().default(false),
  /**
   * Why the ticket was canceled. Stored on the ticket row, not as a phase
   * artifact: `deleteContent` removes every phase artifact for the ticket, so a
   * receipt would be erased by the same action that wrote it.
   */
  reason: skipReasonSchema.optional(),
}).strict()

export const closeUnmergedSchema = z.object({
  /** Why the work is being finished without merging. Lands on `merge_report`. */
  reason: skipReasonSchema.optional(),
}).strict()

export const retryTicketSchema = z.object({
  note: z.string()
    .max(20_000, 'Retry note must be 20,000 characters or fewer')
    .refine((note) => note.trim().length > 0, 'Retry note must contain non-whitespace text')
    .optional(),
}).strict()

export const uiStateScopeSchema = z.object({
  scope: z.string().min(1).max(80).regex(/^[a-zA-Z0-9:_-]+$/),
})

export const upsertUiStateSchema = z.object({
  scope: z.string().min(1).max(80).regex(/^[a-zA-Z0-9:_-]+$/),
  data: z.unknown(),
  expectedRevision: z.number().int().nonnegative().nullable(),
  actionId: z.string().min(1).max(120),
})

const interviewAnswerFieldsSchema = {
  answers: z.record(z.string(), z.string()).default({}),
  selectedOptions: z.record(z.string(), z.array(z.string())).optional().default({}),
  /** Keyed by question id. Validated against the questions the batch actually skips. */
  skipReasons: z.record(z.string().min(1), skipReasonSchema).optional().default({}),
}

/**
 * `/answer-batch` and `/skip` used to share one schema, which is exactly how a
 * field added for one route gets silently ignored on the other. They are
 * separate now, and both are strict.
 */
export const interviewBatchAnswerPayloadSchema = z.object(interviewAnswerFieldsSchema).strict()

export const interviewSkipAllPayloadSchema = z.object({
  ...interviewAnswerFieldsSchema,
  /** One reason for the whole action. Never overwrites a per-question reason. */
  bulkSkipReason: skipReasonSchema.optional(),
}).strict()

export const editAnswerSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string(),
  /** Only meaningful when the edit clears the answer, which is a skip. */
  skipReason: skipReasonSchema.nullable().optional(),
}).strict()

export const interviewApprovalAnswerSchema = z.object({
  questions: z.array(z.object({
    id: z.string().min(1),
    answer: z.object({
      skipped: z.boolean(),
      selected_option_ids: z.array(z.string()).default([]),
      free_text: z.string(),
      /**
       * Omitted means "leave whatever is stored alone"; explicit `null` clears
       * it. An editor that sends nothing must not silently wipe a reason, and
       * one that answers the question must be able to.
       */
      skip_reason: skipReasonSchema.nullable().optional(),
    }),
  })).min(1),
})

const RAW_ARTIFACT_CONTENT_MAX_BYTES = 1_000_000

export const rawInterviewSaveSchema = z.object({
  content: z.string().max(RAW_ARTIFACT_CONTENT_MAX_BYTES),
})

export const rawPrdSaveSchema = z.object({
  content: z.string().max(RAW_ARTIFACT_CONTENT_MAX_BYTES),
})

const prdUserStorySchema = z.object({
  id: z.string(),
  title: z.string(),
  acceptance_criteria: z.array(z.string()),
  implementation_steps: z.array(z.string()),
  verification: z.object({
    required_commands: z.array(commandSpecSchema),
  }).strict(),
}).strict()

const prdEpicSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string(),
  implementation_steps: z.array(z.string()),
  user_stories: z.array(prdUserStorySchema),
}).strict()

export const prdDocumentSchema = z.object({
  schema_version: z.number(),
  ticket_id: z.string(),
  artifact: z.literal('prd'),
  status: z.enum(['draft', 'approved']),
  source_interview: z.object({
    content_sha256: z.string(),
  }).strict(),
  product: z.object({
    problem_statement: z.string(),
    target_users: z.array(z.string()),
  }).strict(),
  scope: z.object({
    in_scope: z.array(z.string()),
    out_of_scope: z.array(z.string()),
  }).strict(),
  technical_requirements: z.object({
    architecture_constraints: z.array(z.string()),
    data_model: z.array(z.string()),
    api_contracts: z.array(z.string()),
    security_constraints: z.array(z.string()),
    performance_constraints: z.array(z.string()),
    reliability_constraints: z.array(z.string()),
    error_handling_rules: z.array(z.string()),
    tooling_assumptions: z.array(z.string()),
  }).strict(),
  epics: z.array(prdEpicSchema).min(1),
  risks: z.array(z.string()),
  approval: z.object({
    approved_by: z.string(),
    approved_at: z.string(),
  }).strict(),
}).strict()

export const structuredPrdSaveSchema = z.object({
  document: prdDocumentSchema,
}).strict()

export const rawExecutionSetupPlanSaveSchema = z.object({
  content: z.string().max(RAW_ARTIFACT_CONTENT_MAX_BYTES),
})

export const executionSetupPlanSchema = z.object({
  schemaVersion: z.number(),
  ticketId: z.string(),
  artifact: z.literal('execution_setup_plan'),
  status: z.literal('draft'),
  hostContext: hostContextSchema,
  summary: z.string(),
  readiness: z.object({
    status: z.enum(['ready', 'partial', 'missing']),
    actionsRequired: z.boolean(),
    evidence: z.array(z.string()),
    gaps: z.array(z.string()),
  }).strict(),
  tempRoots: z.array(z.string()),
  workspaceInputs: z.array(z.object({
    path: z.string(),
    kind: z.enum(['file', 'directory']),
    sourceStatus: z.enum(['ignored', 'untracked']),
    category: z.enum(['local_config', 'secret', 'fixture', 'dataset', 'other_non_reproducible']),
    allowLargeCopy: z.boolean().optional(),
    fileCount: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    reason: z.string(),
  }).strict()).default([]),
  workspaceProbes: z.array(z.object({
    id: z.string(),
    command: commandSpecSchema,
    purpose: z.string(),
  }).strict()).default([]),
  gitHooks: z.object({
    policy: z.enum(['observe_only', 'validate_advisory', 'validate_required', 'use_native_hooks']),
    detected: z.array(z.object({
      name: z.string(),
      path: z.string(),
      source: z.string(),
      kind: z.enum(['hook', 'manager_config']),
      runnable: z.enum(['yes', 'no', 'unknown']),
      managerHint: z.string().optional(),
    }).strict()),
    validationCommands: z.array(z.object({
      id: z.string(),
      hook: z.string(),
      command: commandSpecSchema,
      purpose: z.string(),
    }).strict()),
  }).strict().default({
    policy: 'validate_advisory',
    detected: [],
    validationCommands: [],
  }),
  steps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      purpose: z.string(),
      commands: z.array(commandSpecSchema),
      required: z.boolean(),
      rationale: z.string(),
      cautions: z.array(z.string()),
    }).strict()
  ),
  projectCommands: z.object({
    prepare: z.array(commandSpecSchema),
    testFull: z.array(commandSpecSchema),
    lintFull: z.array(commandSpecSchema),
    typecheckFull: z.array(commandSpecSchema),
  }).strict(),
  qualityGatePolicy: z.object({
    tests: z.string(),
    lint: z.string(),
    typecheck: z.string(),
    fullProjectFallback: z.string(),
  }).strict(),
  cautions: z.array(z.string()),
}).strict()

export const structuredExecutionSetupPlanSaveSchema = z.object({
  plan: executionSetupPlanSchema,
}).strict()

export const approvalRequestSchema = z.object({
  expectedContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  /**
   * Why the operator approved despite known coverage gaps.
   *
   * Optional, and only offered by the UI when there are gaps to acknowledge.
   */
  gapAcknowledgementReason: skipReasonSchema.optional(),
}).strict()

export const regenerateExecutionSetupPlanSchema = z.object({
  commentary: z.string().trim().min(1),
  plan: executionSetupPlanSchema.optional(),
  rawContent: z.string().max(RAW_ARTIFACT_CONTENT_MAX_BYTES).optional(),
}).strict()

export const opencodeQuestionReplySchema = z.object({
  answers: z.array(z.array(z.string())),
}).strict()

/**
 * Skipping a question takes an optional reason, like every other skip surface.
 *
 * `skippedBy` is deliberately absent: a client claiming `timeout` would be
 * forging a machine decision into the audit trail. This route always writes
 * `user`, because a person pressed the button.
 */
export const opencodeQuestionSkipSchema = z.object({
  reason: skipReasonSchema.optional(),
}).strict()

/** Stopping the countdown carries nothing. It is a fact, not a request. */
export const opencodeQuestionTimerStopSchema = z.object({}).strict()

export const devEventSchema = z.object({
  type: z.enum([
    'READY',
    'APPROVE',
    'DRAFTS_READY',
    'REFINED',
    'CHECKS_PASSED',
    'EXECUTION_SETUP_PLAN_READY',
    'APPROVE_EXECUTION_SETUP_PLAN',
    'EXECUTION_SETUP_READY',
    'BEAD_COMPLETE',
    'ALL_BEADS_DONE',
    'TESTS_PASSED',
    'INTEGRATION_DONE',
    'PULL_REQUEST_READY',
    'MERGE_COMPLETE',
    'CLOSE_UNMERGED_COMPLETE',
    'CLEANUP_DONE',
    'CANCEL',
    'RETRY',
  ]),
}).passthrough()
