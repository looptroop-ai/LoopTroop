import type { CommandSpec } from './commandSpec'
import { DEFAULT_GIT_HOOK_POLICY, type GitHookPolicy } from './gitHookPolicy'
import type { HostContext } from './hostContext'

/**
 * The one serialiser for an execution setup plan.
 *
 * The client and the server each had their own, and they did not agree: the
 * client omitted `file_count` and `total_bytes` entirely and wrote
 * `allow_large_copy` only when it was true. Saving an edited plan from the UI
 * therefore round-tripped away the copy-size metadata the generator had
 * measured, and turned an explicit `allow_large_copy: false` into an absent
 * field.
 *
 * This is the server's shape, because the server writes the canonical artifact
 * — including its key order, which a content hash depends on.
 *
 * Typed structurally rather than against either side's `ExecutionSetupPlan`, so
 * both can pass their own without one importing the other's module graph.
 */

export interface SerializableWorkspaceInput {
  path: string
  kind: string
  sourceStatus: string
  category: string
  allowLargeCopy?: boolean | undefined
  fileCount?: number | undefined
  totalBytes?: number | undefined
  reason: string
}

export interface SerializableDetectedGitHook {
  name: string
  path: string
  source: string
  kind: string
  runnable: string
  managerHint?: string | undefined
}

export interface SerializableExecutionSetupPlan {
  schemaVersion: number
  ticketId: string
  artifact: string
  status: string
  hostContext: HostContext
  summary: string
  readiness: {
    status: string
    actionsRequired: boolean
    evidence: string[]
    gaps?: string[] | undefined
  }
  tempRoots: string[]
  workspaceInputs: SerializableWorkspaceInput[]
  workspaceProbes?: Array<{ id: string; command: CommandSpec; purpose: string }> | undefined
  gitHooks?: {
    policy: GitHookPolicy
    detected: SerializableDetectedGitHook[]
    validationCommands: unknown[]
  } | undefined
  steps: Array<{
    id: string
    title: string
    purpose: string
    commands: CommandSpec[]
    required: boolean
    rationale: string
    cautions: string[]
  }>
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

export function serializeExecutionSetupPlan(plan: SerializableExecutionSetupPlan): string {
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
      // "Defined", not "truthy": an explicit `false` is a decision the operator
      // made, and dropping it is not the same as never having recorded one.
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
