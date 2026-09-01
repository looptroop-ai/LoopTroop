import type {
  ExecutionSetupPlanPayload,
  StructuredOutputMetadata,
} from '../../structuredOutput/types'
import type { Session } from '../../opencode/types'
import type { StructuredRetryDiagnostic } from '@shared/structuredRetryDiagnostics'
import type { RawAttempt } from '../../council/types'
import type { CommandSpec } from '@shared/commandSpec'
import { DEFAULT_GIT_HOOK_POLICY } from '@shared/gitHookPolicy'

export const EXECUTION_SETUP_PLAN_ARTIFACT_TYPE = 'execution_setup_plan'
export const EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE = 'execution_setup_plan_report'
export const EXECUTION_SETUP_PLAN_NOTES_ARTIFACT_TYPE = 'execution_setup_plan_notes'
export const EXECUTION_SETUP_PLAN_REGENERATION_REQUEST_ARTIFACT_TYPE = 'execution_setup_plan_regeneration_request'
export const EXECUTION_SETUP_PLAN_RESULT_MARKER = '<EXECUTION_SETUP_PLAN>'
export const EXECUTION_SETUP_PLAN_RESULT_END = '</EXECUTION_SETUP_PLAN>'

export type ExecutionSetupPlan = ExecutionSetupPlanPayload

export interface ExecutionSetupPlanParseResult {
  markerFound: boolean
  plan: ExecutionSetupPlan | null
  errors: string[]
  repairApplied?: boolean
  repairWarnings?: string[]
  validationError?: string
  retryDiagnostic?: StructuredRetryDiagnostic
}

export interface ExecutionSetupPlanGenerationResult {
  session: Session
  output: string
  plan: ExecutionSetupPlan | null
  parse: ExecutionSetupPlanParseResult
  structuredOutput: StructuredOutputMetadata
  rawAttempts?: RawAttempt[]
}

export interface ExecutionSetupPlanReport {
  status: 'draft' | 'failed'
  ready: boolean
  generatedAt: string
  generatedBy: string
  summary?: string
  plan: ExecutionSetupPlan | null
  modelOutput: string
  errors: string[]
  structuredOutput?: StructuredOutputMetadata
  rawAttempts?: RawAttempt[]
  notes?: string[]
  source: 'auto' | 'regenerate'
}

export interface ExecutionSetupPlanRegenerationRequest {
  commentary: string
  currentPlanRaw: string | null
  notes: string[]
  createdAt: string
}

export function serializeExecutionSetupPlan(plan: ExecutionSetupPlan): string {
  const gitHooks = plan.gitHooks ?? {
    policy: DEFAULT_GIT_HOOK_POLICY,
    detected: [],
    validationCommands: [],
  }
  return JSON.stringify({
    schema_version: plan.schemaVersion,
    ticket_id: plan.ticketId,
    artifact: plan.artifact,
    status: plan.status,
    host_context: plan.hostContext,
    summary: plan.summary,
    readiness: {
      status: plan.readiness.status,
      actions_required: plan.readiness.actionsRequired,
      evidence: plan.readiness.evidence,
      gaps: plan.readiness.gaps,
    },
    temp_roots: plan.tempRoots,
    workspace_inputs: plan.workspaceInputs.map((input) => ({
      path: input.path,
      kind: input.kind,
      source_status: input.sourceStatus,
      category: input.category,
      ...(input.allowLargeCopy === undefined ? {} : { allow_large_copy: input.allowLargeCopy }),
      ...(input.fileCount === undefined ? {} : { file_count: input.fileCount }),
      ...(input.totalBytes === undefined ? {} : { total_bytes: input.totalBytes }),
      reason: input.reason,
    })),
    workspace_probes: plan.workspaceProbes ?? [],
    git_hooks: {
      policy: gitHooks.policy,
      detected: gitHooks.detected.map((hook) => ({
        name: hook.name,
        path: hook.path,
        source: hook.source,
        kind: hook.kind,
        runnable: hook.runnable,
        ...(hook.managerHint ? { manager_hint: hook.managerHint } : {}),
      })),
      validation_commands: gitHooks.validationCommands,
    },
    steps: plan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      purpose: step.purpose,
      commands: step.commands,
      required: step.required,
      rationale: step.rationale,
      cautions: step.cautions,
    })),
    project_commands: {
      prepare: plan.projectCommands.prepare,
      test_full: plan.projectCommands.testFull,
      lint_full: plan.projectCommands.lintFull,
      typecheck_full: plan.projectCommands.typecheckFull,
    },
    quality_gate_policy: {
      tests: plan.qualityGatePolicy.tests,
      lint: plan.qualityGatePolicy.lint,
      typecheck: plan.qualityGatePolicy.typecheck,
      full_project_fallback: plan.qualityGatePolicy.fullProjectFallback,
    },
    cautions: plan.cautions,
  }, null, 2)
}

export function serializeExecutionSetupPlanNotes(notes: string[]): string {
  return JSON.stringify({ notes })
}

export function parseExecutionSetupPlanNotes(content?: string | null): string[] {
  if (!content) return []
  try {
    const parsed = JSON.parse(content) as { notes?: unknown }
    return Array.isArray(parsed.notes)
      ? parsed.notes.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : []
  } catch {
    return []
  }
}

export function flattenExecutionSetupPlanCommands(plan: ExecutionSetupPlan | null | undefined): CommandSpec[] {
  if (!plan) return []
  return plan.steps.flatMap((step) => step.commands)
}
