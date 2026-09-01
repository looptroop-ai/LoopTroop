import type { BeadChecks } from '../phases/execution/completionSchema'
import type { StructuredIntervention } from '@shared/structuredInterventions'
import type { StructuredRetryDiagnostic } from '@shared/structuredRetryDiagnostics'
import type { HostContext } from '@shared/hostContext'
import type { CommandSpec, RuntimeEnvironment } from '@shared/commandSpec'

export interface StructuredOutputSuccess<T> {
  ok: true
  value: T
  normalizedContent: string
  repairApplied: boolean
  repairWarnings: string[]
}

export interface StructuredOutputFailure {
  ok: false
  error: string
  repairApplied: boolean
  repairWarnings: string[]
  retryDiagnostic?: StructuredRetryDiagnostic
}

export type StructuredOutputResult<T> = StructuredOutputSuccess<T> | StructuredOutputFailure

export interface StructuredOutputMetadata {
  repairApplied: boolean
  repairWarnings: string[]
  autoRetryCount: number
  validationError?: string
  retryDiagnostics?: StructuredRetryDiagnostic[]
  interventions?: StructuredIntervention[]
}

export interface CoverageFollowUpQuestion {
  id?: string
  question: string
  phase?: string
  priority?: string
  rationale?: string
  answerType?: 'free_text' | 'single_choice' | 'multiple_choice'
  options?: Array<{ id: string; label: string }>
}

export interface CoverageResultEnvelope {
  status: 'clean' | 'gaps'
  gaps: string[]
  followUpQuestions: CoverageFollowUpQuestion[]
}

export interface InterviewQuestionOption {
  id: string
  label: string
}

export interface InterviewBatchPayloadQuestion {
  id: string
  question: string
  phase?: string
  priority?: string
  rationale?: string
  answerType?: 'free_text' | 'single_choice' | 'multiple_choice'
  options?: InterviewQuestionOption[]
}

export interface InterviewBatchPayload {
  batchNumber: number
  progress: {
    current: number
    total: number
  }
  isFinalFreeForm: boolean
  aiCommentary: string
  questions: InterviewBatchPayloadQuestion[]
}

export type InterviewTurnOutput =
  | {
      kind: 'batch'
      batch: InterviewBatchPayload
    }
  | {
      kind: 'complete'
      finalYaml: string
    }

export interface BeadCompletionPayload {
  beadId: string
  status: 'done' | 'error'
  checks: BeadChecks
  reason?: string
}

export interface FinalTestCommandPayload {
  commands: CommandSpec[]
  summary: string | null
  testFiles: string[]
  modifiedFiles: string[]
  fileEffects: FinalTestFileEffect[]
  testsCount: number | null
}

export type FinalTestFileEffectIntent = 'candidate' | 'temporary' | 'unexpected'

export interface FinalTestFileEffect {
  path: string
  intent: FinalTestFileEffectIntent
  reason?: string
}

export interface ExecutionSetupReusableArtifactPayload {
  path: string
  kind: string
  purpose: string
}

export type ExecutionSetupToolRequirementStatus = 'available' | 'provisioned' | 'failed' | 'not_provisionable'

export interface ExecutionSetupProvisioningAttemptPayload {
  strategy: string
  commands: CommandSpec[]
  result: string
  reason: string
}

export interface ExecutionSetupToolRequirementPayload {
  launcher: string
  requiredBy: string[]
  status: ExecutionSetupToolRequirementStatus
  missingProbe: string
  provisioningAttempts: ExecutionSetupProvisioningAttemptPayload[]
  finalProbe: string
  failureReason: string
}

export interface ExecutionSetupPlanStepPayload {
  id: string
  title: string
  purpose: string
  commands: CommandSpec[]
  required: boolean
  rationale: string
  cautions: string[]
}

export interface ExecutionSetupPlanReadinessPayload {
  status: 'ready' | 'partial' | 'missing'
  actionsRequired: boolean
  evidence: string[]
  gaps: string[]
}

export type ExecutionSetupWorkspaceInputKind = 'file' | 'directory'
export type ExecutionSetupWorkspaceInputSourceStatus = 'ignored' | 'untracked'
import type { ExecutionSetupWorkspaceInputCategory } from '@shared/executionSetupCategories'
export type { ExecutionSetupWorkspaceInputCategory }
export {
  EXECUTION_SETUP_WORKSPACE_INPUT_CATEGORIES,
  isExecutionSetupWorkspaceInputCategory,
} from '@shared/executionSetupCategories'

export interface ExecutionSetupWorkspaceInputPayload {
  path: string
  kind: ExecutionSetupWorkspaceInputKind
  sourceStatus: ExecutionSetupWorkspaceInputSourceStatus
  category: ExecutionSetupWorkspaceInputCategory
  allowLargeCopy?: boolean
  fileCount?: number
  totalBytes?: number
  reason: string
}

import type { GitHookPolicy } from '@shared/gitHookPolicy'
export type { GitHookPolicy }

export interface ExecutionSetupCommandProbePayload {
  id: string
  command: CommandSpec
  purpose: string
}

export interface ExecutionSetupCommandReceiptPayload {
  id: string
  command?: CommandSpec
  status: 'passed' | 'failed' | 'timed_out' | 'skipped'
  exitCode: number | null
  durationMs: number
  outputExcerpt: string
}

export interface DetectedGitHookPayload {
  name: string
  path: string
  source: string
  kind: 'hook' | 'manager_config'
  runnable: 'yes' | 'no' | 'unknown'
  managerHint?: string
}

export interface GitHookValidationCommandPayload extends ExecutionSetupCommandProbePayload {
  hook: string
}

export interface ExecutionSetupGitHooksPayload {
  policy: GitHookPolicy
  detected: DetectedGitHookPayload[]
  validationCommands: GitHookValidationCommandPayload[]
  validationReceipts?: ExecutionSetupCommandReceiptPayload[]
}

export interface ExecutionSetupPlanPayload {
  schemaVersion: number
  ticketId: string
  artifact: 'execution_setup_plan'
  status: 'draft'
  hostContext: HostContext
  summary: string
  readiness: ExecutionSetupPlanReadinessPayload
  tempRoots: string[]
  workspaceInputs: ExecutionSetupWorkspaceInputPayload[]
  workspaceProbes: ExecutionSetupCommandProbePayload[]
  gitHooks: ExecutionSetupGitHooksPayload
  steps: ExecutionSetupPlanStepPayload[]
  projectCommands: {
    prepare: CommandSpec[]
    testFull: CommandSpec[]
    lintFull: CommandSpec[]
    typecheckFull: CommandSpec[]
  }
  qualityGatePolicy: {
    tests: string
    lint: string
    typecheck: string
    fullProjectFallback: string
  }
  cautions: string[]
}

export type ExecutionSetupStatus = 'ready' | 'blocked'

export interface ExecutionSetupProfilePayload {
  schemaVersion: number
  ticketId: string
  artifact: 'execution_setup_profile'
  status: ExecutionSetupStatus
  hostContext: HostContext
  summary: string
  tempRoots: string[]
  workspaceInputs: ExecutionSetupWorkspaceInputPayload[]
  runtimeEnvironment: RuntimeEnvironment
  bootstrapCommands: CommandSpec[]
  toolingProbeCommands: CommandSpec[]
  workspaceProbes: ExecutionSetupCommandProbePayload[]
  workspaceProbeReceipts?: ExecutionSetupCommandReceiptPayload[]
  gitHooks: ExecutionSetupGitHooksPayload
  toolRequirements?: ExecutionSetupToolRequirementPayload[]
  reusableArtifacts: ExecutionSetupReusableArtifactPayload[]
  projectCommands: {
    prepare: CommandSpec[]
    testFull: CommandSpec[]
    lintFull: CommandSpec[]
    typecheckFull: CommandSpec[]
  }
  qualityGatePolicy: {
    tests: string
    lint: string
    typecheck: string
    fullProjectFallback: string
  }
  cautions: string[]
}

export interface ExecutionSetupResultPayload {
  status: ExecutionSetupStatus
  summary: string
  profile: ExecutionSetupProfilePayload
  checks: {
    workspace: string
    tooling: string
    tempScope: string
    policy: string
  }
}

export interface VoteScorecard {
  draftScores: Record<string, Record<string, number>>
}

export interface PrdDraftMetrics {
  epicCount: number
  userStoryCount: number
}

export interface PrdDocument {
  schema_version: number
  ticket_id: string
  artifact: 'prd'
  status: 'draft' | 'approved'
  source_interview: {
    content_sha256: string
  }
  product: {
    problem_statement: string
    target_users: string[]
  }
  scope: {
    in_scope: string[]
    out_of_scope: string[]
  }
  technical_requirements: {
    architecture_constraints: string[]
    data_model: string[]
    api_contracts: string[]
    security_constraints: string[]
    performance_constraints: string[]
    reliability_constraints: string[]
    error_handling_rules: string[]
    tooling_assumptions: string[]
  }
  epics: Array<{
    id: string
    title: string
    objective: string
    implementation_steps: string[]
    user_stories: Array<{
      id: string
      title: string
      acceptance_criteria: string[]
      implementation_steps: string[]
      verification: {
        required_commands: CommandSpec[]
      }
    }>
  }>
  risks: string[]
  approval: {
    approved_by: string
    approved_at: string
  }
}

export interface RelevantFilesOutputEntry {
  path: string
  rationale: string
  relevance: string
  likely_action: string
  content: string
  content_preview: string
}

export interface RelevantFilesOutputPayload {
  file_count: number
  files: RelevantFilesOutputEntry[]
}
