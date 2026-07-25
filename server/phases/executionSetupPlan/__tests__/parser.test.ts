import { describe, expect, it } from 'vitest'
import { parseExecutionSetupPlanResult } from '../parser'
import { serializeExecutionSetupPlan } from '../types'

function wrapPlan(body: string): string {
  return `<EXECUTION_SETUP_PLAN>\n${body}\n</EXECUTION_SETUP_PLAN>`
}

function buildPlanPayload(steps: unknown[], workspaceInputs: unknown[] = []) {
  return {
    summary: 'Workspace needs setup before coding.',
    readiness: {
      status: 'partial',
      actions_required: true,
      evidence: ['Project manifest exists.'],
      gaps: ['Dependencies are missing.'],
    },
    workspace_inputs: workspaceInputs,
    workspace_probes: [{ id: 'workspace-1', command: 'project inspect', purpose: 'load the repository project' }],
    git_hooks: {
      validation_commands: [],
    },
    steps,
    project_commands: {
      prepare: ['project bootstrap'],
      test_full: ['project test'],
      lint_full: [],
      typecheck_full: [],
    },
    cautions: [],
  }
}

function buildPlanWithSteps(steps: unknown[]): string {
  return wrapPlan(JSON.stringify(buildPlanPayload(steps)))
}

describe('parseExecutionSetupPlanResult', () => {
  it('repairs setup steps that omitted metadata fields but provided purpose text', () => {
    const parsed = parseExecutionSetupPlanResult(buildPlanWithSteps([
      {
        order: 1,
        purpose: 'Install locked dependencies before running project-native tests.',
        commands: ['project bootstrap'],
        required: true,
      },
    ]))

    expect(parsed.errors).toEqual([])
    expect(parsed.plan?.workspaceProbes).toEqual([{
      id: 'workspace-1',
      command: {
        mode: 'shell',
        shell: 'posix',
        script: 'project inspect',
        cwd: '.',
        env: {},
      },
      purpose: 'load the repository project',
    }])
    expect(parsed.plan?.gitHooks.policy).toBe('validate_advisory')
    expect(parsed.plan?.steps[0]).toMatchObject({
      id: 'setup-step-1',
      title: 'Install locked dependencies before running project-native tests.',
      purpose: 'Install locked dependencies before running project-native tests.',
      rationale: 'Install locked dependencies before running project-native tests.',
      commands: [{
        mode: 'shell',
        shell: 'posix',
        script: 'project bootstrap',
        cwd: '.',
        env: {},
      }],
      required: true,
      cautions: [],
    })
    expect(parsed.repairApplied).toBe(true)
    expect(parsed.repairWarnings).toEqual(expect.arrayContaining([
      'Filled missing execution setup plan step id at index 0 from list position.',
      'Filled missing execution setup plan step title at index 0 from existing purpose text.',
      'Filled missing execution setup plan step rationale at index 0 from existing purpose text.',
    ]))
  })

  it('repairs the retry shape that has id but still omits title and rationale', () => {
    const parsed = parseExecutionSetupPlanResult(buildPlanWithSteps([
      {
        id: 'step-1-bootstrap',
        purpose: 'Install locked dependencies before running project-native tests.',
        commands: ['project bootstrap'],
        required: true,
      },
    ]))

    expect(parsed.errors).toEqual([])
    expect(parsed.plan?.steps[0]).toMatchObject({
      id: 'step-1-bootstrap',
      title: 'Install locked dependencies before running project-native tests.',
      rationale: 'Install locked dependencies before running project-native tests.',
    })
    expect(parsed.repairWarnings).toEqual(expect.arrayContaining([
      'Filled missing execution setup plan step title at index 0 from existing purpose text.',
      'Filled missing execution setup plan step rationale at index 0 from existing purpose text.',
    ]))
  })

  it('repairs execution_setup_plan wrapper objects around the payload', () => {
    const parsed = parseExecutionSetupPlanResult(wrapPlan(JSON.stringify({
      execution_setup_plan: buildPlanPayload([
        {
          id: 'step-1-bootstrap',
          purpose: 'Install locked dependencies before running project-native tests.',
          commands: ['project bootstrap'],
          required: true,
        },
      ]),
    })))

    expect(parsed.errors).toEqual([])
    expect(parsed.plan?.artifact).toBe('execution_setup_plan')
    expect(parsed.repairApplied).toBe(true)
    expect(parsed.repairWarnings).toContain('Removed wrapper key "execution_setup_plan" from top level.')
  })

  it('still rejects setup steps that do not provide purpose text', () => {
    const parsed = parseExecutionSetupPlanResult(buildPlanWithSteps([
      {
        id: 'step-1-bootstrap',
        title: 'Bootstrap project',
        commands: ['project bootstrap'],
        required: true,
      },
    ]))

    expect(parsed.plan).toBeNull()
    expect(parsed.errors).toEqual(['Missing required steps[0].purpose'])
  })

  it('accepts ignored and untracked workspace inputs as the only required setup work', () => {
    const payload = buildPlanPayload([], [
      {
        path: 'packages/runtime/package.json',
        kind: 'file',
        source_status: 'ignored',
        category: 'local_config',
        reason: 'The workspace package manifest is required to resolve repository imports.',
      },
      {
        path: 'fixtures/generated',
        kind: 'directory',
        source_status: 'untracked',
        category: 'fixture',
        reason: 'Repository tests load generated fixtures from this directory.',
      },
    ])
    payload.readiness = {
      status: 'partial',
      actions_required: true,
      evidence: ['Both inputs exist in the original checkout.'],
      gaps: ['The ticket worktree does not contain the inputs.'],
    }

    const parsed = parseExecutionSetupPlanResult(wrapPlan(JSON.stringify(payload)))

    expect(parsed.errors).toEqual([])
    expect(parsed.plan?.steps).toEqual([])
    expect(parsed.plan?.workspaceInputs).toEqual([
      {
        path: 'packages/runtime/package.json',
        kind: 'file',
        sourceStatus: 'ignored',
        category: 'local_config',
        reason: 'The workspace package manifest is required to resolve repository imports.',
      },
      {
        path: 'fixtures/generated',
        kind: 'directory',
        sourceStatus: 'untracked',
        category: 'fixture',
        reason: 'Repository tests load generated fixtures from this directory.',
      },
    ])

    expect(JSON.parse(serializeExecutionSetupPlan(parsed.plan!)).workspace_inputs).toEqual([
      {
        path: 'packages/runtime/package.json',
        kind: 'file',
        source_status: 'ignored',
        category: 'local_config',
        reason: 'The workspace package manifest is required to resolve repository imports.',
      },
      {
        path: 'fixtures/generated',
        kind: 'directory',
        source_status: 'untracked',
        category: 'fixture',
        reason: 'Repository tests load generated fixtures from this directory.',
      },
    ])
  })

  it.each([
    ['unsupported kind', { path: 'local/input', kind: 'tree', source_status: 'ignored', category: 'local_config', reason: 'Needed.' }, 'kind must be file or directory'],
    ['unsupported source status', { path: 'local/input', kind: 'file', source_status: 'tracked', category: 'local_config', reason: 'Needed.' }, 'source_status must be ignored or untracked'],
    ['reproducible category', { path: 'local/input', kind: 'file', source_status: 'ignored', category: 'cache', reason: 'Needed.' }, 'category must be local_config'],
  ])('rejects workspace inputs with an %s', (_label, workspaceInput, expectedError) => {
    const parsed = parseExecutionSetupPlanResult(wrapPlan(JSON.stringify(buildPlanPayload([], [workspaceInput]))))

    expect(parsed.plan).toBeNull()
    expect(parsed.errors.join(' ')).toContain(expectedError)
  })

  it('rejects a ready plan that still contains workspace inputs', () => {
    const payload = buildPlanPayload([], [{
      path: 'local/input',
      kind: 'file',
      source_status: 'ignored',
      category: 'local_config',
      reason: 'Needed by the workspace.',
    }])
    payload.readiness = {
      status: 'ready',
      actions_required: false,
      evidence: ['Workspace is ready.'],
      gaps: [],
    }

    const parsed = parseExecutionSetupPlanResult(wrapPlan(JSON.stringify(payload)))

    expect(parsed.errors).toEqual([])
    expect(parsed.plan?.readiness).toMatchObject({ status: 'partial', actionsRequired: true })
  })

  it('ignores malformed backend-owned fields and keeps model-owned hook suggestions', () => {
    const payload = {
      ...buildPlanPayload([]),
      schema_version: 'wrong',
      ticket_id: { invented: true },
      artifact: 'not-a-plan',
      status: 'blocked',
      temp_roots: false,
      quality_gate_policy: 'wrong',
      git_hooks: {
        policy: { invalid: true },
        detected: [{ invented: true }],
        validation_commands: [{
          id: 'hook-check',
          hook: 'pre-commit',
          command: 'project lint',
          purpose: 'Run the configured validation.',
        }],
      },
    }

    const parsed = parseExecutionSetupPlanResult(wrapPlan(JSON.stringify(payload)))

    expect(parsed.errors).toEqual([])
    expect(parsed.plan).toMatchObject({
      schemaVersion: 1,
      ticketId: '',
      artifact: 'execution_setup_plan',
      status: 'draft',
      gitHooks: {
        policy: 'validate_advisory',
        detected: [],
        validationCommands: [{
          id: 'hook-check',
          command: expect.objectContaining({
            mode: 'shell',
            shell: 'posix',
            script: 'project lint',
          }),
        }],
      },
    })
    expect(parsed.repairWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Ignored model-supplied ticket_id'),
      expect.stringContaining('Ignored model-supplied git_hooks.detected'),
    ]))
  })
})
