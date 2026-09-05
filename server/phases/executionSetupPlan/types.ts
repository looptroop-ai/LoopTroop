import type {
  ExecutionSetupPlanPayload,
  StructuredOutputMetadata,
} from '../../structuredOutput/types'
import type { Session } from '../../opencode/types'
import type { StructuredRetryDiagnostic } from '@shared/structuredRetryDiagnostics'
import type { RawAttempt } from '../../council/types'
import type { CommandSpec } from '@shared/commandSpec'

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

export { serializeExecutionSetupPlan } from '@shared/executionSetupPlanSerialization'

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
