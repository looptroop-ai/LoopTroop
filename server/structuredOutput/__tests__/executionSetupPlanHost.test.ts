import { describe, expect, it } from 'vitest'
import { normalizeExecutionSetupPlanOutput } from '../completionOutput'
import { detectHostContext } from '../../lib/hostContext'

/**
 * A stored plan records the host it was written and approved on. Re-normalising
 * its commands against `detectHostContext()` rewrote them for whatever machine
 * happened to be reading them, which is how a command approved on one platform
 * came back with the other platform's shell quoting.
 */
function storedPlan(preferredShell: 'powershell' | 'posix', platform: 'windows' | 'linux'): string {
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
})
