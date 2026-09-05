import { describe, expect, it } from 'vitest'
import { normalizeExecutionSetupPlanOutput } from '../completionOutput'
import { detectHostContext } from '../../lib/hostContext'

/**
 * A stored plan records the host it was written and approved on. Re-normalising
 * its commands against `detectHostContext()` rewrote them for whatever machine
 * happened to be reading them, which is how a command approved on one platform
 * came back with the other platform's shell quoting.
 */
function storedPlan(
  preferredShell: 'powershell' | 'posix',
  platform: 'windows' | 'linux',
  overrides: Record<string, unknown> = {},
): string {
  return `<EXECUTION_SETUP_PLAN>\n${JSON.stringify({
    schema_version: 1,
    ticket_id: 'TEST-1',
    artifact: 'execution_setup_plan',
    status: 'draft',
    host_context: {
      platform,
      environment: 'native',
      arch: 'x64',
      availableShells: [preferredShell],
      preferredShell,
    },
    summary: 'Stored plan',
    temp_roots: [],
    workspace_inputs: [],
    workspace_probes: [],
    readiness: { status: 'partial', actions_required: true, evidence: [] },
    steps: [{
      id: 'step-1',
      title: 'Install',
      purpose: 'Install deps',
      rationale: 'needed',
      commands: ['npm ci'],
      required: true,
    }],
    project_commands: { prepare: [], test_full: [], lint_full: [], typecheck_full: [] },
    quality_gate_policy: {
      tests: 'bead-test-commands-first',
      lint: 'impacted-or-package',
      typecheck: 'impacted-or-package',
      full_project_fallback: 'never-block-on-unrelated-baseline',
    },
    git_hooks: { policy: 'observe_only', detected: [], validation_commands: [] },
    cautions: [],
    ...overrides,
  })}\n</EXECUTION_SETUP_PLAN>`
}

const runningOnWindows = detectHostContext().platform === 'windows'

describe('execution setup plan host context', () => {
  it('normalises a stored plan against the host it records, not the one running', () => {
    const foreign = runningOnWindows ? storedPlan('posix', 'linux') : storedPlan('powershell', 'windows')

    const result = normalizeExecutionSetupPlanOutput(foreign, { preserveBackendFields: true })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.value.hostContext.platform).toBe(runningOnWindows ? 'linux' : 'windows')
    const command = result.value.steps[0]?.commands[0]
    expect(command?.mode).toBe('shell')
    expect(command?.mode === 'shell' ? command.shell : null).toBe(runningOnWindows ? 'posix' : 'powershell')
  })

  it('falls back to the running host when parsing fresh model output', () => {
    // Model output carries no authoritative host, so the live one is correct
    // and the plan's own `host_context` is deliberately overwritten.
    const result = normalizeExecutionSetupPlanOutput(storedPlan('posix', 'linux'), { preserveBackendFields: false })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.value.hostContext.platform).toBe(detectHostContext().platform)
    const command = result.value.steps[0]?.commands[0]
    expect(command?.mode === 'shell' ? command.shell : null)
      .toBe(runningOnWindows ? 'powershell' : 'posix')
  })

  it('normalises stored project_commands against the recorded host too', () => {
    // `steps` was threaded through and `project_commands` was not, so the same
    // stored plan produced step commands quoted for the recorded host and
    // project commands quoted for the running one.
    const foreign = runningOnWindows
      ? storedPlan('posix', 'linux', { project_commands: { prepare: ['npm ci'], test_full: [], lint_full: [], typecheck_full: [] } })
      : storedPlan('powershell', 'windows', { project_commands: { prepare: ['npm ci'], test_full: [], lint_full: [], typecheck_full: [] } })

    const result = normalizeExecutionSetupPlanOutput(foreign, { preserveBackendFields: true })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    const prepare = result.value.projectCommands.prepare[0]
    expect(prepare?.mode).toBe('shell')
    expect(prepare?.mode === 'shell' ? prepare.shell : null).toBe(runningOnWindows ? 'posix' : 'powershell')
  })

  it('keeps the measured copy size of a stored workspace input', () => {
    // Measured on disk after generation, so the model cannot supply them and a
    // re-read must not lose them: without this the shared serialiser wrote
    // file_count and total_bytes and the very next parse dropped them, so an
    // edit saved from the UI came back with no copy-size metadata.
    const input = {
      path: '.env.local',
      kind: 'file',
      source_status: 'ignored',
      category: 'local_config',
      reason: 'Local credentials the tests read.',
      file_count: 1,
      total_bytes: 4096,
    }

    const stored = normalizeExecutionSetupPlanOutput(
      storedPlan('posix', 'linux', { workspace_inputs: [input] }),
      { preserveBackendFields: true },
    )
    expect(stored.ok).toBe(true)
    if (!stored.ok) throw new Error(stored.error)
    expect(stored.value.workspaceInputs[0]).toMatchObject({ fileCount: 1, totalBytes: 4096 })

    // Fresh model output is the other half of the rule: a model claiming a size
    // it cannot have measured is dropped, and the drop is reported.
    const fresh = normalizeExecutionSetupPlanOutput(
      storedPlan('posix', 'linux', { workspace_inputs: [input] }),
      { preserveBackendFields: false },
    )
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) throw new Error(fresh.error)
    expect(fresh.value.workspaceInputs[0]).not.toHaveProperty('fileCount')
    expect(fresh.value.workspaceInputs[0]).not.toHaveProperty('totalBytes')
    expect(fresh.repairWarnings.join(' ')).toContain('file_count/total_bytes')
  })
})
