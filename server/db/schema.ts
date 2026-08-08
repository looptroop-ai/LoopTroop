import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'
import { PROFILE_DEFAULTS } from './defaults'

export const profiles = sqliteTable('profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  mainImplementer: text('main_implementer'),
  mainImplementerVariant: text('main_implementer_variant'),
  councilMembers: text('council_members'), // JSON array of model IDs
  councilMemberVariants: text('council_member_variants'), // JSON map: { "provider/model": "variant" }
  manualQaEnabled: integer('manual_qa_enabled', { mode: 'boolean' }).notNull().default(PROFILE_DEFAULTS.manualQaEnabled),
  gitHookPolicy: text('git_hook_policy').notNull().default(PROFILE_DEFAULTS.gitHookPolicy),
  minCouncilQuorum: integer('min_council_quorum').default(PROFILE_DEFAULTS.minCouncilQuorum),
  perIterationTimeout: integer('per_iteration_timeout').default(PROFILE_DEFAULTS.perIterationTimeout),
  executionSetupTimeout: integer('execution_setup_timeout').default(PROFILE_DEFAULTS.executionSetupTimeout),
  councilResponseTimeout: integer('council_response_timeout').default(PROFILE_DEFAULTS.councilResponseTimeout),
  interviewQuestions: integer('interview_questions').default(PROFILE_DEFAULTS.interviewQuestions),
  coverageFollowUpBudgetPercent: integer('coverage_follow_up_budget_percent').default(PROFILE_DEFAULTS.coverageFollowUpBudgetPercent),
  maxCoveragePasses: integer('max_coverage_passes').default(PROFILE_DEFAULTS.maxCoveragePasses),
  maxPrdCoveragePasses: integer('max_prd_coverage_passes').default(PROFILE_DEFAULTS.maxPrdCoveragePasses),
  maxBeadsCoveragePasses: integer('max_beads_coverage_passes').default(PROFILE_DEFAULTS.maxBeadsCoveragePasses),
  structuredRetryCount: integer('structured_retry_count').default(PROFILE_DEFAULTS.structuredRetryCount),
  maxIterations: integer('max_iterations').default(PROFILE_DEFAULTS.maxIterations),
  opencodeRetryLimit: integer('opencode_retry_limit').default(PROFILE_DEFAULTS.opencodeRetryLimit),
  opencodeRetryDelay: integer('opencode_retry_delay').default(PROFILE_DEFAULTS.opencodeRetryDelay),
  opencodeSteps: integer('opencode_steps').default(PROFILE_DEFAULTS.opencodeSteps),
  toolInputMaxChars: integer('tool_input_max_chars').default(PROFILE_DEFAULTS.toolInputMaxChars),
  toolOutputMaxChars: integer('tool_output_max_chars').default(PROFILE_DEFAULTS.toolOutputMaxChars),
  toolErrorMaxChars: integer('tool_error_max_chars').default(PROFILE_DEFAULTS.toolErrorMaxChars),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const attachedProjects = sqliteTable('attached_projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  folderPath: text('folder_path').notNull().unique(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  shortname: text('shortname').notNull(),
  icon: text('icon').default('📁'),
  color: text('color').default('#3b82f6'),
  folderPath: text('folder_path').notNull(),
  profileId: integer('profile_id'),
  councilMembers: text('council_members'), // JSON array, nullable override
  manualQaOverride: integer('manual_qa_override', { mode: 'boolean' }),
  gitHookPolicy: text('git_hook_policy'),
  maxIterations: integer('max_iterations'),
  perIterationTimeout: integer('per_iteration_timeout'),
  executionSetupTimeout: integer('execution_setup_timeout'),
  councilResponseTimeout: integer('council_response_timeout'),
  minCouncilQuorum: integer('min_council_quorum'),
  interviewQuestions: integer('interview_questions'),
  ignoreMode: text('ignore_mode'),
  ticketCounter: integer('ticket_counter').default(0),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const tickets = sqliteTable('tickets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  externalId: text('external_id').notNull().unique(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  priority: integer('priority').default(3),
  status: text('status').notNull().default('DRAFT'),
  xstateSnapshot: text('xstate_snapshot'), // JSON serialized XState snapshot
  branchName: text('branch_name'),
  currentBead: integer('current_bead'),
  totalBeads: integer('total_beads'),
  percentComplete: real('percent_complete'),
  errorMessage: text('error_message'),
  manualQaOverride: integer('manual_qa_override', { mode: 'boolean' }),
  gitHookPolicy: text('git_hook_policy'),
  lockedMainImplementer: text('locked_main_implementer'),
  lockedMainImplementerVariant: text('locked_main_implementer_variant'),
  lockedCouncilMembers: text('locked_council_members'), // JSON array of model IDs, frozen at start
  lockedCouncilMemberVariants: text('locked_council_member_variants'), // JSON map frozen at start
  lockedInterviewQuestions: integer('locked_interview_questions'),
  lockedCoverageFollowUpBudgetPercent: integer('locked_coverage_follow_up_budget_percent'),
  lockedMaxCoveragePasses: integer('locked_max_coverage_passes'),
  lockedMaxPrdCoveragePasses: integer('locked_max_prd_coverage_passes'),
  lockedMaxBeadsCoveragePasses: integer('locked_max_beads_coverage_passes'),
  lockedStructuredRetryCount: integer('locked_structured_retry_count'),
  lockedManualQaEnabled: integer('locked_manual_qa_enabled', { mode: 'boolean' }),
  lockedManualQaSource: text('locked_manual_qa_source'),
  lockedGitHookPolicy: text('locked_git_hook_policy'),
  lockedGitHookPolicySource: text('locked_git_hook_policy_source'),
  workflowRevision: integer('workflow_revision').notNull().default(0),
  startedAt: text('started_at'),
  plannedDate: text('planned_date'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const phaseArtifacts = sqliteTable('phase_artifacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketId: integer('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  phase: text('phase').notNull(),
  phaseAttempt: integer('phase_attempt').notNull().default(1),
  artifactType: text('artifact_type'),
  content: text('content').notNull(), // JSON stringified artifact
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const manualQaOperations = sqliteTable('manual_qa_operations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketId: integer('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  actionId: text('action_id').notNull(),
  version: integer('version').notNull(),
  checklistHash: text('checklist_hash').notNull(),
  draftRevision: integer('draft_revision').notNull(),
  state: text('state').notNull().default('staged'),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const manualQaImprovementTickets = sqliteTable('manual_qa_improvement_tickets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  originId: text('origin_id').notNull().unique(),
  destinationTicketId: integer('destination_ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  actionId: text('action_id').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const ticketPhaseAttempts = sqliteTable('ticket_phase_attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketId: integer('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  phase: text('phase').notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  state: text('state').notNull().default('active'),
  archivedReason: text('archived_reason'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  archivedAt: text('archived_at'),
})

export const opencodeSessions = sqliteTable('opencode_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  ticketId: integer('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  phase: text('phase').notNull(),
  phaseAttempt: integer('phase_attempt').default(1),
  memberId: text('member_id'), // council member model ID
  beadId: text('bead_id'),
  iteration: integer('iteration'),
  step: text('step'), // optional sub-step when a phase owns multiple sessions
  state: text('state').notNull().default('active'), // active, completed, abandoned
  lastEventId: text('last_event_id'),
  lastEventAt: text('last_event_at'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const ticketStatusHistory = sqliteTable('ticket_status_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketId: integer('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  previousStatus: text('previous_status'),
  newStatus: text('new_status').notNull(),
  reason: text('reason'),
  changedAt: text('changed_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const ticketErrorOccurrences = sqliteTable('ticket_error_occurrences', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketId: integer('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  occurrenceNumber: integer('occurrence_number').notNull(),
  blockedFromStatus: text('blocked_from_status').notNull(),
  errorMessage: text('error_message'),
  errorCodes: text('error_codes'),
  diagnosticDetails: text('diagnostic_details'),
  occurredAt: text('occurred_at').notNull().$defaultFn(() => new Date().toISOString()),
  resolvedAt: text('resolved_at'),
  resolutionStatus: text('resolution_status'),
  resumedToStatus: text('resumed_to_status'),
})

// One row per completed bead. Powers deterministic throughput/ETA forecasting and is the
// forward-compatible foundation for the future Cost Management feature (token/cost columns are
// reserved but intentionally left unset by the ETA feature).
export const beadExecutionMetrics = sqliteTable('bead_execution_metrics', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketId: integer('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  beadId: text('bead_id').notNull(),
  sizeBucket: text('size_bucket').notNull(), // 'S' | 'M' | 'L' by total bead count
  effortTier: text('effort_tier').notNull(), // implementer reasoning variant (e.g. 'medium')
  iterations: integer('iterations').notNull().default(1), // attempts including retries
  activeDurationMs: integer('active_duration_ms').notNull(), // bead completion time, excluding non-CODING waits
  wallClockMs: integer('wall_clock_ms'), // completedAt - startedAt (diagnostic)
  completedAt: text('completed_at').notNull(),
  schemaVersion: integer('schema_version').notNull().default(1),
  // Reserved for Cost Management (not populated by the ETA feature):
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsd: real('cost_usd'),
})

// One idempotent row per completed OpenCode assistant message. These rows are
// intentionally forward-only: prompt completion records new activity, but
// project initialization never backfills historical OpenCode sessions.
export const ticketAiTurnMetrics = sqliteTable('ticket_ai_turn_metrics', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketId: integer('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  phase: text('phase').notNull(),
  phaseAttempt: integer('phase_attempt').notNull().default(1),
  sessionId: text('session_id').notNull(),
  assistantMessageId: text('assistant_message_id').notNull(),
  modelId: text('model_id').notNull(),
  variant: text('variant'),
  agent: text('agent'),
  finishReason: text('finish_reason'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  durationMs: integer('duration_ms'),
  costUsd: real('cost_usd'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  reasoningTokens: integer('reasoning_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  schemaVersion: integer('schema_version').notNull().default(1),
})
