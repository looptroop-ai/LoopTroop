import * as jsYaml from 'js-yaml'
import {
  normalizeCommandSpec,
  type CommandSpec,
} from '@shared/commandSpec'
import {
  hostContextSchema,
  type HostContext,
} from '@shared/hostContext'
import { isRecord } from '@shared/typeGuards'
import { DEFAULT_GIT_HOOK_POLICY, migrateGitHookPolicy, type GitHookPolicy } from '@shared/gitHookPolicy'
import {
  isExecutionSetupWorkspaceInputCategory,
  type ExecutionSetupWorkspaceInputCategory,
} from '@shared/executionSetupCategories'

export const EXECUTION_SETUP_PLAN_APPROVAL_FOCUS_EVENT = 'looptroop:execution-setup-plan-focus'

export interface ExecutionSetupPlanStep {
  id: string
  title: string
  purpose: string
  commands: CommandSpec[]
  required: boolean
  rationale: string
  cautions: string[]
}

export interface ExecutionSetupPlanReadiness {
  status: 'ready' | 'partial' | 'missing'
  actionsRequired: boolean
  evidence: string[]
  gaps: string[]
}

export interface ExecutionSetupWorkspaceInput {
  path: string
  kind: 'file' | 'directory'
  sourceStatus: 'ignored' | 'untracked'
  category: ExecutionSetupWorkspaceInputCategory
  allowLargeCopy?: boolean
  reason: string
}

export type { GitHookPolicy } from '@shared/gitHookPolicy'

export interface ExecutionSetupWorkspaceProbe {
  id: string
  command: CommandSpec
  purpose: string
}

export interface ExecutionSetupDetectedGitHook {
  name: string
  path: string
  source: string
  kind: 'hook' | 'manager_config'
  runnable: 'yes' | 'no' | 'unknown'
  managerHint?: string
}

export interface ExecutionSetupGitHookValidationCommand {
  id: string
  hook: string
  command: CommandSpec
  purpose: string
}

export interface ExecutionSetupPlan {
  schemaVersion: number
  ticketId: string
  artifact: 'execution_setup_plan'
  status: 'draft'
  summary: string
  hostContext: HostContext
  readiness: ExecutionSetupPlanReadiness
  tempRoots: string[]
  workspaceInputs: ExecutionSetupWorkspaceInput[]
  workspaceProbes: ExecutionSetupWorkspaceProbe[]
  gitHooks: {
    policy: GitHookPolicy
    detected: ExecutionSetupDetectedGitHook[]
    validationCommands: ExecutionSetupGitHookValidationCommand[]
  }
  steps: ExecutionSetupPlanStep[]
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

export interface ExecutionSetupPlanParseResult {
  plan: ExecutionSetupPlan | null
  error: string | null
  warnings: string[]
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function normalizeReadinessStatus(value: unknown): ExecutionSetupPlanReadiness['status'] {
  if (typeof value !== 'string') return 'ready'
  const normalized = value.trim().toLowerCase()
  if (normalized === 'ready') return 'ready'
  if (normalized === 'missing') return 'missing'
  if (['partial', 'needs_setup', 'needs-setup', 'incomplete'].includes(normalized)) return 'partial'
  return 'ready'
}

function normalizeGitHookPolicy(value: unknown, warnings: string[]): GitHookPolicy {
  const migrated = migrateGitHookPolicy(value)
  if (migrated) return migrated
  // A plan that names a policy nobody recognises is a parse problem, not a
  // preference. Coercing it silently is how an unknown value used to read back
  // as advisory validation and look deliberate.
  //
  // Into the same `warnings` array every other normalisation uses, not the
  // console: the parser hands that array back to the screen showing the plan,
  // so a warning that only reaches devtools is one nobody reads.
  if (value !== undefined && value !== null) {
    warnings.push(`git_hooks.policy: unknown value ${JSON.stringify(value)}; using ${DEFAULT_GIT_HOOK_POLICY}.`)
  }
  return DEFAULT_GIT_HOOK_POLICY
}

function fallbackHostContext(): HostContext {
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/windows/i.test(userAgent)) {
    return {
      platform: 'windows',
      environment: 'native',
      arch: 'unknown',
      availableShells: ['powershell', 'cmd'],
      preferredShell: 'powershell',
    }
  }
  return {
    platform: /macintosh|mac os/i.test(userAgent) ? 'macos' : 'linux',
    environment: 'native',
    arch: 'unknown',
    availableShells: ['posix'],
    preferredShell: 'posix',
  }
}

function normalizeHostContext(value: unknown): HostContext {
  const candidate = isRecord(value)
    ? {
        platform: value.platform,
        environment: value.environment,
        arch: value.arch,
        availableShells: value.availableShells ?? value.available_shells,
        preferredShell: value.preferredShell ?? value.preferred_shell,
      }
    : value
  const parsed = hostContextSchema.safeParse(candidate)
  return parsed.success ? parsed.data : fallbackHostContext()
}

function normalizeCommands(
  value: unknown,
  hostContext: HostContext,
  warnings: string[],
  field: string,
): CommandSpec[] {
  if (!Array.isArray(value)) return []
  return value.map((entry, index) => normalizeCommand(entry, hostContext, warnings, `${field}[${index}]`))
}

function normalizeCommand(
  value: unknown,
  hostContext: HostContext,
  warnings: string[],
  field: string,
): CommandSpec {
  const candidate = isRecord(value) && value.timeout_ms !== undefined
    ? { ...value, timeoutMs: value.timeout_ms }
    : value
  const result = normalizeCommandSpec(candidate, hostContext)
  if (result.warning) warnings.push(`${field}: ${result.warning}`)
  return result.command
}

function toExecutionSetupPlan(value: unknown, warnings: string[]): ExecutionSetupPlan | null {
  if (!isRecord(value)) return null
  const hostContext = normalizeHostContext(value.hostContext ?? value.host_context)

  const projectCommands = isRecord(value.projectCommands)
    ? value.projectCommands
    : isRecord(value.project_commands)
      ? value.project_commands
      : {}

  const qualityGatePolicy = isRecord(value.qualityGatePolicy)
    ? value.qualityGatePolicy
    : isRecord(value.quality_gate_policy)
      ? value.quality_gate_policy
      : {}

  const gitHooks = isRecord(value.gitHooks)
    ? value.gitHooks
    : isRecord(value.git_hooks)
      ? value.git_hooks
      : {}

  const workspaceProbesRaw = value.workspaceProbes ?? value.workspace_probes
  const workspaceProbes = Array.isArray(workspaceProbesRaw)
    ? workspaceProbesRaw.flatMap((probe) => !isRecord(probe) ? [] : [{
        id: typeof probe.id === 'string' ? probe.id : '',
        command: normalizeCommand(probe.command, hostContext, warnings, `workspace_probes[${String(probe.id ?? '')}].command`),
        purpose: typeof probe.purpose === 'string' ? probe.purpose : '',
      } satisfies ExecutionSetupWorkspaceProbe])
    : []

  const workspaceInputsRaw = value.workspaceInputs ?? value.workspace_inputs
  const workspaceInputs = Array.isArray(workspaceInputsRaw)
    ? workspaceInputsRaw.flatMap((entry) => {
        if (!isRecord(entry)) return []
        const kind = entry.kind === 'directory' ? 'directory' : 'file'
        const sourceStatus = (entry.sourceStatus ?? entry.source_status) === 'untracked' ? 'untracked' : 'ignored'
        return [{
          path: typeof entry.path === 'string' ? entry.path : '',
          kind,
          sourceStatus,
          category: isExecutionSetupWorkspaceInputCategory(entry.category) ? entry.category : 'other_non_reproducible',
          ...((entry.allowLargeCopy ?? entry.allow_large_copy) === true ? { allowLargeCopy: true } : {}),
          reason: typeof entry.reason === 'string' ? entry.reason : '',
        } satisfies ExecutionSetupWorkspaceInput]
      })
    : []

  const detectedRaw = gitHooks.detected
  const detected = Array.isArray(detectedRaw)
    ? detectedRaw.flatMap((hook) => !isRecord(hook) ? [] : [{
        name: typeof hook.name === 'string' ? hook.name : '',
        path: typeof hook.path === 'string' ? hook.path : '',
        source: typeof hook.source === 'string' ? hook.source : '',
        kind: hook.kind === 'manager_config' ? 'manager_config' : 'hook',
        runnable: hook.runnable === 'yes' || hook.runnable === 'no' ? hook.runnable : 'unknown',
        ...(typeof (hook.managerHint ?? hook.manager_hint) === 'string'
          ? { managerHint: String(hook.managerHint ?? hook.manager_hint) }
          : {}),
      } satisfies ExecutionSetupDetectedGitHook])
    : []

  const validationCommandsRaw = gitHooks.validationCommands ?? gitHooks.validation_commands
  const validationCommands = Array.isArray(validationCommandsRaw)
    ? validationCommandsRaw.flatMap((entry) => !isRecord(entry) ? [] : [{
        id: typeof entry.id === 'string' ? entry.id : '',
        hook: typeof entry.hook === 'string' ? entry.hook : '',
        command: normalizeCommand(entry.command, hostContext, warnings, `git_hooks.validation_commands[${String(entry.id ?? '')}].command`),
        purpose: typeof entry.purpose === 'string' ? entry.purpose : '',
      } satisfies ExecutionSetupGitHookValidationCommand])
    : []

  const steps = Array.isArray(value.steps)
    ? value.steps.flatMap((step) => {
        if (!isRecord(step)) return []
        return [{
          id: typeof step.id === 'string' ? step.id : '',
          title: typeof step.title === 'string' ? step.title : '',
          purpose: typeof step.purpose === 'string' ? step.purpose : '',
          commands: normalizeCommands(step.commands, hostContext, warnings, `steps[${String(step.id ?? '')}].commands`),
          required: Boolean(step.required),
          rationale: typeof step.rationale === 'string' ? step.rationale : '',
          cautions: toStringArray(step.cautions),
        } satisfies ExecutionSetupPlanStep]
      })
    : []

  const readinessRecord = isRecord(value.readiness)
    ? value.readiness
    : isRecord(value.environment_readiness)
      ? value.environment_readiness
      : null

  const derivedReadinessStatus: ExecutionSetupPlanReadiness['status'] = steps.length > 0 || workspaceInputs.length > 0
    ? 'partial'
    : 'ready'
  const readinessStatus = readinessRecord
    ? normalizeReadinessStatus(readinessRecord.status)
    : derivedReadinessStatus
  const actionsRequired = readinessRecord && typeof readinessRecord.actionsRequired === 'boolean'
    ? readinessRecord.actionsRequired
    : readinessRecord && typeof readinessRecord.actions_required === 'boolean'
      ? readinessRecord.actions_required
      : readinessStatus !== 'ready'

  return {
    schemaVersion: typeof value.schemaVersion === 'number'
      ? value.schemaVersion
      : typeof value.schema_version === 'number'
        ? value.schema_version
        : 1,
    ticketId: typeof value.ticketId === 'string'
      ? value.ticketId
      : typeof value.ticket_id === 'string'
        ? value.ticket_id
        : '',
    artifact: 'execution_setup_plan',
    status: 'draft',
    summary: typeof value.summary === 'string' ? value.summary : '',
    hostContext,
    readiness: {
      status: readinessStatus,
      actionsRequired,
      evidence: toStringArray(readinessRecord?.evidence),
      gaps: toStringArray(readinessRecord?.gaps),
    },
    tempRoots: toStringArray(value.tempRoots ?? value.temp_roots),
    workspaceInputs,
    workspaceProbes,
    gitHooks: {
      policy: normalizeGitHookPolicy(gitHooks.policy, warnings),
      detected,
      validationCommands,
    },
    steps,
    projectCommands: {
      prepare: normalizeCommands(projectCommands.prepare, hostContext, warnings, 'project_commands.prepare'),
      testFull: normalizeCommands(projectCommands.testFull ?? projectCommands.test_full, hostContext, warnings, 'project_commands.test_full'),
      lintFull: normalizeCommands(projectCommands.lintFull ?? projectCommands.lint_full, hostContext, warnings, 'project_commands.lint_full'),
      typecheckFull: normalizeCommands(projectCommands.typecheckFull ?? projectCommands.typecheck_full, hostContext, warnings, 'project_commands.typecheck_full'),
    },
    qualityGatePolicy: {
      tests: typeof qualityGatePolicy.tests === 'string' ? qualityGatePolicy.tests : '',
      lint: typeof qualityGatePolicy.lint === 'string' ? qualityGatePolicy.lint : '',
      typecheck: typeof qualityGatePolicy.typecheck === 'string' ? qualityGatePolicy.typecheck : '',
      fullProjectFallback: typeof qualityGatePolicy.fullProjectFallback === 'string'
        ? qualityGatePolicy.fullProjectFallback
        : typeof qualityGatePolicy.full_project_fallback === 'string'
          ? qualityGatePolicy.full_project_fallback
          : '',
    },
    cautions: toStringArray(value.cautions),
  }
}

export function parseExecutionSetupPlanContent(content: string): ExecutionSetupPlanParseResult {
  const trimmed = content.trim()
  if (!trimmed) {
    return { plan: null, error: 'Execution setup plan content is empty.', warnings: [] }
  }

  try {
    const warnings: string[] = []
    const parsed = trimmed.startsWith('{') || trimmed.startsWith('[')
      ? JSON.parse(trimmed)
      : jsYaml.load(trimmed)
    const plan = toExecutionSetupPlan(parsed, warnings)
    if (!plan || !plan.summary) {
      return { plan: null, error: 'Execution setup plan content is missing required fields.', warnings }
    }
    if (plan.readiness.status === 'ready') {
      if (plan.readiness.actionsRequired) {
        return { plan: null, error: 'Ready execution setup plans cannot require actions.', warnings }
      }
      if (plan.readiness.gaps.length > 0) {
        return { plan: null, error: 'Ready execution setup plans cannot list unresolved gaps.', warnings }
      }
      if (plan.steps.length > 0 || plan.workspaceInputs.length > 0) {
        return { plan: null, error: 'Ready execution setup plans must not include setup steps or workspace inputs.', warnings }
      }
    } else if (plan.steps.length === 0 && plan.workspaceInputs.length === 0) {
      return { plan: null, error: 'Execution setup plans with missing work must include at least one setup step or workspace input.', warnings }
    }
    return { plan, error: null, warnings }
  } catch (error) {
    return {
      plan: null,
      error: error instanceof Error ? error.message : 'Failed to parse execution setup plan content.',
      warnings: [],
    }
  }
}

export function serializeExecutionSetupPlan(plan: ExecutionSetupPlan): string {
  return JSON.stringify({
    schema_version: plan.schemaVersion,
    ticket_id: plan.ticketId,
    artifact: plan.artifact,
    status: plan.status,
    summary: plan.summary,
    host_context: plan.hostContext,
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
      ...(input.allowLargeCopy ? { allow_large_copy: true } : {}),
      reason: input.reason,
    })),
    workspace_probes: plan.workspaceProbes,
    git_hooks: {
      policy: plan.gitHooks.policy,
      detected: plan.gitHooks.detected.map((hook) => ({
        name: hook.name,
        path: hook.path,
        source: hook.source,
        kind: hook.kind,
        runnable: hook.runnable,
        ...(hook.managerHint ? { manager_hint: hook.managerHint } : {}),
      })),
      validation_commands: plan.gitHooks.validationCommands,
    },
    steps: plan.steps,
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
