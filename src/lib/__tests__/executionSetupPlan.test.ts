import { describe, expect, it } from 'vitest'
import { parseExecutionSetupPlanContent, serializeExecutionSetupPlan } from '../executionSetupPlan'

describe('execution setup workspace verification contract', () => {
  it('parses aliases and round-trips workspace inputs, probes, and Git hook configuration', () => {
    const parsed = parseExecutionSetupPlanContent(JSON.stringify({
      schema_version: 2,
      ticket_id: 'TEST-1',
      artifact: 'execution_setup_plan',
      status: 'draft',
      summary: 'Workspace input required.',
      host_context: {
        platform: 'windows',
        environment: 'native',
        arch: 'x64',
        availableShells: ['powershell', 'cmd'],
        preferredShell: 'powershell',
      },
      readiness: {
        status: 'partial',
        actions_required: true,
        evidence: ['The original checkout contains the required fixture directory.'],
        gaps: ['The ticket worktree does not contain the fixture directory.'],
      },
      temp_roots: [],
      workspace_inputs: [{
        path: 'fixtures/local',
        kind: 'directory',
        source_status: 'untracked',
        category: 'fixture',
        allow_large_copy: true,
        reason: 'The workspace tests require local generated fixtures.',
      }],
      workspace_probes: [{ id: 'workspace', command: 'project test --list', purpose: 'Load the workspace.' }],
      git_hooks: {
        policy: 'validate_advisory',
        detected: [{ name: 'pre-commit', path: '.husky/pre-commit', source: 'husky', kind: 'hook', runnable: 'unknown', manager_hint: 'husky' }],
        validation_commands: [{ id: 'check', hook: 'pre-commit', command: 'project check', purpose: 'Validate commit.' }],
      },
      steps: [],
      project_commands: { prepare: [], test_full: [], lint_full: [], typecheck_full: [] },
      quality_gate_policy: { tests: '', lint: '', typecheck: '', full_project_fallback: '' },
      cautions: [],
    }))

    expect(parsed.error).toBeNull()
    expect(parsed.plan?.workspaceProbes.at(0)?.command).toEqual({
      mode: 'shell',
      shell: 'powershell',
      script: 'project test --list',
      cwd: '.',
      env: {},
    })
    expect(parsed.warnings).toHaveLength(2)
    expect(parsed.plan?.workspaceInputs).toEqual([{
      path: 'fixtures/local',
      kind: 'directory',
      sourceStatus: 'untracked',
      category: 'fixture',
      allowLargeCopy: true,
      reason: 'The workspace tests require local generated fixtures.',
    }])
    expect(parsed.plan?.gitHooks.detected.at(0)?.managerHint).toBe('husky')
    expect(parsed.plan?.gitHooks.validationCommands.at(0)?.command).toMatchObject({
      mode: 'shell',
      shell: 'powershell',
      script: 'project check',
    })

    const serialized = JSON.parse(serializeExecutionSetupPlan(parsed.plan!))
    expect(serialized.git_hooks.policy).toBe('validate_advisory')
    expect(serialized.git_hooks.validation_commands).toHaveLength(1)
    expect(serialized.workspace_probes).toHaveLength(1)
    expect(serialized.workspace_inputs).toEqual([{
      path: 'fixtures/local',
      kind: 'directory',
      source_status: 'untracked',
      category: 'fixture',
      allow_large_copy: true,
      reason: 'The workspace tests require local generated fixtures.',
    }])
  })

  it('keeps structured commands unchanged and emits no repair warning', () => {
    const parsed = parseExecutionSetupPlanContent(JSON.stringify({
      summary: 'Ready.',
      readiness: { status: 'ready', actions_required: false, evidence: [], gaps: [] },
      workspace_inputs: [],
      workspace_probes: [{
        id: 'probe',
        purpose: 'Probe.',
        command: { mode: 'process', program: 'tool', args: ['test'], cwd: '.', env: {} },
      }],
      git_hooks: { policy: 'validate_advisory', detected: [], validation_commands: [] },
      steps: [],
      project_commands: { prepare: [], test_full: [], lint_full: [], typecheck_full: [] },
    }))

    expect(parsed.error).toBeNull()
    expect(parsed.warnings).toEqual([])
    expect(parsed.plan?.workspaceProbes[0]?.command.mode).toBe('process')
  })
  it('warns and falls back when the plan names an unrecognised git hook policy', () => {
    const parsed = parseExecutionSetupPlanContent(JSON.stringify({
      summary: 'Ready.',
      readiness: { status: 'ready', actions_required: false, evidence: [], gaps: [] },
      workspace_inputs: [],
      workspace_probes: [],
      git_hooks: { policy: 'not_a_policy', detected: [], validation_commands: [] },
      steps: [],
      project_commands: { prepare: [], test_full: [], lint_full: [], typecheck_full: [] },
    }))

    // Silently reading back as advisory validation is indistinguishable from a
    // plan that asked for it, which is why this has to be said out loud.
    expect(parsed.plan?.gitHooks.policy).toBe('validate_advisory')
    expect(parsed.warnings).toEqual([
      expect.stringContaining('git_hooks.policy'),
    ])
  })

  it('migrates a legacy git hook policy name without warning', () => {
    const parsed = parseExecutionSetupPlanContent(JSON.stringify({
      summary: 'Ready.',
      readiness: { status: 'ready', actions_required: false, evidence: [], gaps: [] },
      workspace_inputs: [],
      workspace_probes: [],
      git_hooks: { policy: 'use_on_internal_commits', detected: [], validation_commands: [] },
      steps: [],
      project_commands: { prepare: [], test_full: [], lint_full: [], typecheck_full: [] },
    }))

    expect(parsed.plan?.gitHooks.policy).toBe('use_native_hooks')
    expect(parsed.warnings).toEqual([])
  })

  it('does not treat an inherited property name as a legacy policy', () => {
    const parsed = parseExecutionSetupPlanContent(JSON.stringify({
      summary: 'Ready.',
      readiness: { status: 'ready', actions_required: false, evidence: [], gaps: [] },
      workspace_inputs: [],
      workspace_probes: [],
      git_hooks: { policy: 'constructor', detected: [], validation_commands: [] },
      steps: [],
      project_commands: { prepare: [], test_full: [], lint_full: [], typecheck_full: [] },
    }))

    expect(parsed.plan?.gitHooks.policy).toBe('validate_advisory')
    expect(parsed.warnings).toEqual([
      expect.stringContaining('git_hooks.policy'),
    ])
  })
})
