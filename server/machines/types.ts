import type { BlockedErrorDiagnostics } from '@shared/errorDiagnostics'

/** Which level of the profile → project → ticket cascade a locked setting came from. */
export type SettingSource = 'profile' | 'project' | 'ticket'

export type ManualQaConfigurationSource = SettingSource

/** Source columns are plain text, so anything unrecognised reads as "not locked". */
export function normalizeSettingSource(value: string | null | undefined): SettingSource | null {
  return value === 'profile' || value === 'project' || value === 'ticket' ? value : null
}

export interface TicketContext {
  ticketId: string
  projectId: number
  externalId: string
  title: string
  status: string
  lockedMainImplementer: string | null
  lockedMainImplementerVariant: string | null
  lockedCouncilMembers: string[] | null
  lockedCouncilMemberVariants: Record<string, string> | null
  lockedInterviewQuestions: number | null
  lockedCoverageFollowUpBudgetPercent: number | null
  lockedMaxCoveragePasses: number | null
  lockedMaxPrdCoveragePasses: number | null
  lockedMaxBeadsCoveragePasses: number | null
  lockedStructuredRetryCount: number | null
  lockedManualQaEnabled: boolean | null
  lockedManualQaSource: ManualQaConfigurationSource | null
  lockedAiQuestionsEnabled: boolean | null
  lockedAiQuestionsSource: SettingSource | null
  lockedAiQuestionWindow: number | null
  lockedAiQuestionWindowSource: SettingSource | null
  pendingExecutionSetupPlanRequestArtifactId: number | null
  previousStatus: string | null
  error: string | null
  errorCodes: string[]
  errorDiagnostics?: BlockedErrorDiagnostics | null
  blockedErrorResolution: 'RETRIED' | 'CONTINUED' | null
  beadProgress: {
    total: number
    completed: number
    current: string | null
  }
  iterationCount: number
  maxIterations: number
  councilResults: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export type TicketEvent =
  | {
      type: 'START'
      lockedMainImplementer?: string | null
      lockedMainImplementerVariant?: string | null
      lockedCouncilMembers?: string[] | null
      lockedCouncilMemberVariants?: Record<string, string> | null
      lockedInterviewQuestions?: number | null
      lockedCoverageFollowUpBudgetPercent?: number | null
      lockedMaxCoveragePasses?: number | null
      lockedMaxPrdCoveragePasses?: number | null
      lockedMaxBeadsCoveragePasses?: number | null
      lockedStructuredRetryCount?: number | null
      lockedManualQaEnabled?: boolean | null
      lockedManualQaSource?: ManualQaConfigurationSource | null
      lockedAiQuestionsEnabled?: boolean | null
      lockedAiQuestionsSource?: SettingSource | null
      lockedAiQuestionWindow?: number | null
      lockedAiQuestionWindowSource?: SettingSource | null
    }
  | { type: 'INIT_FAILED'; message: string; codes?: string[] }
  | { type: 'QUESTIONS_READY'; result: Record<string, unknown> }
  | { type: 'WINNER_SELECTED'; winner: string }
  | { type: 'READY' }
  | { type: 'BATCH_ANSWERED'; batchAnswers: Record<string, string>; selectedOptions?: Record<string, string[]> }
  | { type: 'INTERVIEW_COMPLETE' }
  | { type: 'SKIP_ALL_TO_APPROVAL' }
  | { type: 'COVERAGE_CLEAN' }
  | { type: 'GAPS_FOUND' }
  | { type: 'COVERAGE_LIMIT_REACHED' }
  | { type: 'EXPANDED' }
  | { type: 'APPROVE' }
  | { type: 'DRAFTS_READY' }
  | { type: 'REFINED' }
  | { type: 'CHECKS_PASSED' }
  | { type: 'EXECUTION_SETUP_PLAN_READY' }
  | { type: 'EXECUTION_SETUP_PLAN_FAILED'; errors?: string[] }
  | { type: 'REGENERATE_EXECUTION_SETUP_PLAN'; requestArtifactId: number }
  | { type: 'APPROVE_EXECUTION_SETUP_PLAN' }
  | { type: 'EXECUTION_SETUP_EVIDENCE_CHANGED' }
  | { type: 'EXECUTION_SETUP_READY' }
  | { type: 'EXECUTION_SETUP_FAILED'; errors?: string[] }
  | { type: 'CHECKS_FAILED'; errors: string[] }
  | { type: 'BEAD_COMPLETE' }
  | { type: 'BEAD_ERROR'; codes?: string[]; diagnostics?: BlockedErrorDiagnostics | null }
  | { type: 'ALL_BEADS_DONE' }
  | { type: 'TESTS_PASSED' }
  | { type: 'TESTS_FAILED' }
  | { type: 'QA_CHECKLIST_READY' }
  | { type: 'MANUAL_QA_COMPLETE' }
  | { type: 'MANUAL_QA_SKIPPED' }
  | { type: 'MANUAL_QA_FIXES_CREATED' }
  | { type: 'INTEGRATION_DONE' }
  | { type: 'PULL_REQUEST_READY' }
  | { type: 'MERGE_COMPLETE' }
  | { type: 'CLOSE_UNMERGED_COMPLETE' }
  | { type: 'CLEANUP_DONE' }
  | { type: 'RELEVANT_FILES_READY' }
  | { type: 'CANCEL' }
  | { type: 'RETRY' }
  | { type: 'CONTINUE' }
  | { type: 'ERROR'; message: string; codes?: string[]; diagnostics?: BlockedErrorDiagnostics | null }

// Kanban phase mapping
export type KanbanPhase = 'todo' | 'in_progress' | 'needs_input' | 'done'

export const STATUS_TO_PHASE: Record<string, KanbanPhase> = {
  DRAFT: 'todo',
  SCANNING_RELEVANT_FILES: 'in_progress',
  COUNCIL_DELIBERATING: 'in_progress',
  COUNCIL_VOTING_INTERVIEW: 'in_progress',
  COMPILING_INTERVIEW: 'in_progress',
  WAITING_INTERVIEW_ANSWERS: 'needs_input',
  VERIFYING_INTERVIEW_COVERAGE: 'in_progress',
  WAITING_INTERVIEW_APPROVAL: 'needs_input',
  DRAFTING_PRD: 'in_progress',
  COUNCIL_VOTING_PRD: 'in_progress',
  REFINING_PRD: 'in_progress',
  VERIFYING_PRD_COVERAGE: 'in_progress',
  WAITING_PRD_APPROVAL: 'needs_input',
  DRAFTING_BEADS: 'in_progress',
  COUNCIL_VOTING_BEADS: 'in_progress',
  REFINING_BEADS: 'in_progress',
  VERIFYING_BEADS_COVERAGE: 'in_progress',
  EXPANDING_BEADS: 'in_progress',
  WAITING_BEADS_APPROVAL: 'needs_input',
  PRE_FLIGHT_CHECK: 'in_progress',
  GENERATING_EXECUTION_SETUP_PLAN: 'in_progress',
  WAITING_EXECUTION_SETUP_APPROVAL: 'needs_input',
  PREPARING_EXECUTION_ENV: 'in_progress',
  CODING: 'in_progress',
  RUNNING_FINAL_TEST: 'in_progress',
  GENERATING_QA_CHECKLIST: 'in_progress',
  WAITING_MANUAL_QA: 'needs_input',
  INTEGRATING_CHANGES: 'in_progress',
  CREATING_PULL_REQUEST: 'in_progress',
  WAITING_PR_REVIEW: 'needs_input',
  CLEANING_ENV: 'in_progress',
  COMPLETED: 'done',
  CANCELED: 'done',
  BLOCKED_ERROR: 'needs_input',
}

export const TERMINAL_STATES = ['COMPLETED', 'CANCELED'] as const
