import type {
  ExecutionSetupProfilePayload,
  ExecutionSetupResultPayload,
  StructuredOutputMetadata,
} from '../../structuredOutput/types'
import type { Session } from '../../opencode/types'
import type { StructuredRetryDiagnostic } from '@shared/structuredRetryDiagnostics'
import type { RawAttempt } from '../../council/types'
import type { CommandSpec } from '@shared/commandSpec'
import { DEFAULT_GIT_HOOK_POLICY } from '@shared/gitHookPolicy'
import { closeTag, openTag, PROTOCOL_TAGS } from '@shared/protocolTags'

export const EXECUTION_SETUP_PROFILE_ARTIFACT_TYPE = 'execution_setup_profile'
export const EXECUTION_SETUP_REPORT_ARTIFACT_TYPE = 'execution_setup_report'
export const EXECUTION_SETUP_RETRY_NOTES_ARTIFACT_TYPE = 'execution_setup_retry_notes'
export const EXECUTION_SETUP_RESULT_MARKER = openTag(PROTOCOL_TAGS.EXECUTION_SETUP_RESULT)
export const EXECUTION_SETUP_RESULT_END = closeTag(PROTOCOL_TAGS.EXECUTION_SETUP_RESULT)

export const EXECUTION_SETUP_RUNTIME_DIR = '.ticket/runtime/execution-setup'
export const EXECUTION_SETUP_PROFILE_MIRROR = '.ticket/runtime/execution-setup-profile.json'
export const EXECUTION_LOG_RUNTIME_PATH = '.ticket/runtime/execution-log.jsonl'

export type ExecutionSetupProfile = ExecutionSetupProfilePayload
export type ExecutionSetupResult = ExecutionSetupResultPayload

export interface ExecutionSetupParseResult {
  markerFound: boolean
  result: ExecutionSetupResult | null
  errors: string[]
  repairApplied?: boolean
  repairWarnings?: string[]
  validationError?: string
  retryDiagnostic?: StructuredRetryDiagnostic
}

export interface ExecutionSetupGenerationResult {
  session: Session | null
  output: string
  result: ExecutionSetupResult | null
  parse: ExecutionSetupParseResult
  structuredOutput: StructuredOutputMetadata
  rawAttempts?: RawAttempt[]
}

export interface ExecutionSetupAttemptHistoryEntry {
  attempt: number
  status: 'ready' | 'failed'
  checkedAt: string
  summary?: string
  tempRoots: string[]
  bootstrapCommands: CommandSpec[]
  toolingProbeCommands: CommandSpec[]
  errors: string[]
  failureReason?: string
  noteAppended?: string
}

export interface ExecutionSetupReport {
  status: 'ready' | 'failed'
  ready: boolean
  checkedAt: string
  preparedBy: string
  summary?: string
  profile: ExecutionSetupProfile | null
  checks: ExecutionSetupResult['checks'] | null
  modelOutput: string
  errors: string[]
  worktreeWarnings?: string[]
  structuredOutput?: StructuredOutputMetadata
  rawAttempts?: RawAttempt[]
  attempt?: number
  maxIterations?: number | null
  attemptHistory?: ExecutionSetupAttemptHistoryEntry[]
  retryNotes?: string[]
  approvedPlanCommands?: CommandSpec[]
  executionAddedCommands?: CommandSpec[]
}

export function serializeExecutionSetupRetryNotes(notes: string[]): string {
  return JSON.stringify({ notes })
}

export function toExecutionSetupProfileArtifact(profile: ExecutionSetupProfile): Record<string, unknown> {
  const gitHooks = profile.gitHooks ?? {
    policy: DEFAULT_GIT_HOOK_POLICY,
    detected: [],
    validationCommands: [],
  }
  return {
    schema_version: profile.schemaVersion,
    ticket_id: profile.ticketId,
    artifact: profile.artifact,
    status: profile.status,
    host_context: profile.hostContext,
    summary: profile.summary,
    temp_roots: profile.tempRoots,
    workspace_inputs: profile.workspaceInputs.map((input) => ({
      path: input.path,
      kind: input.kind,
      source_status: input.sourceStatus,
      category: input.category,
      ...(input.allowLargeCopy === undefined ? {} : { allow_large_copy: input.allowLargeCopy }),
      ...(input.fileCount === undefined ? {} : { file_count: input.fileCount }),
      ...(input.totalBytes === undefined ? {} : { total_bytes: input.totalBytes }),
      reason: input.reason,
    })),
    runtime_environment: profile.runtimeEnvironment,
    bootstrap_commands: profile.bootstrapCommands,
    tooling_probe_commands: profile.toolingProbeCommands,
    workspace_probes: profile.workspaceProbes ?? [],
    ...(profile.workspaceProbeReceipts ? { workspace_probe_receipts: profile.workspaceProbeReceipts } : {}),
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
      ...(gitHooks.validationReceipts ? { validation_receipts: gitHooks.validationReceipts } : {}),
    },
    ...(profile.toolRequirements
      ? {
          tool_requirements: profile.toolRequirements.map((requirement) => ({
            launcher: requirement.launcher,
            required_by: requirement.requiredBy,
            status: requirement.status,
            missing_probe: requirement.missingProbe,
            provisioning_attempts: requirement.provisioningAttempts.map((attempt) => ({
              strategy: attempt.strategy,
              commands: attempt.commands,
              result: attempt.result,
              reason: attempt.reason,
            })),
            final_probe: requirement.finalProbe,
            failure_reason: requirement.failureReason,
          })),
        }
      : {}),
    reusable_artifacts: profile.reusableArtifacts.map((artifact) => ({
      path: artifact.path,
      kind: artifact.kind,
      purpose: artifact.purpose,
    })),
    project_commands: {
      prepare: profile.projectCommands.prepare,
      test_full: profile.projectCommands.testFull,
      lint_full: profile.projectCommands.lintFull,
      typecheck_full: profile.projectCommands.typecheckFull,
    },
    quality_gate_policy: {
      tests: profile.qualityGatePolicy.tests,
      lint: profile.qualityGatePolicy.lint,
      typecheck: profile.qualityGatePolicy.typecheck,
      full_project_fallback: profile.qualityGatePolicy.fullProjectFallback,
    },
    cautions: profile.cautions,
  }
}

export function serializeExecutionSetupProfile(profile: ExecutionSetupProfile): string {
  return JSON.stringify(toExecutionSetupProfileArtifact(profile), null, 2)
}

export function parseExecutionSetupRetryNotes(content?: string | null): string[] {
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
