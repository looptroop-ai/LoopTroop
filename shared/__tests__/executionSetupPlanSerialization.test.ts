import { describe, expect, it } from 'vitest'
import { serializeExecutionSetupPlan, type SerializableExecutionSetupPlan } from '../executionSetupPlanSerialization'

function plan(overrides: Partial<SerializableExecutionSetupPlan> = {}): SerializableExecutionSetupPlan {
  return {
    schemaVersion: 1,
    ticketId: 'TEST-1',
    artifact: 'execution_setup_plan',
    status: 'draft',
    hostContext: { platform: 'linux', environment: 'native', arch: 'x64', availableShells: ['posix'], preferredShell: 'posix' },
    summary: 'Setup',
    readiness: { status: 'partial', actionsRequired: true, evidence: [], gaps: [] },
    tempRoots: [],
    workspaceInputs: [],
    workspaceProbes: [],
    gitHooks: { policy: 'observe_only', detected: [], validationCommands: [] },
    steps: [],
    projectCommands: { prepare: [], testFull: [], lintFull: [], typecheckFull: [] },
    qualityGatePolicy: { tests: 't', lint: 'l', typecheck: 'tc', fullProjectFallback: 'f' },
    cautions: [],
    ...overrides,
  }
}

function inputs(serialized: string): Array<Record<string, unknown>> {
  return (JSON.parse(serialized) as { workspace_inputs: Array<Record<string, unknown>> }).workspace_inputs
}

describe('serializeExecutionSetupPlan', () => {
  it('keeps the copy-size metadata the generator measured', () => {
    const serialized = serializeExecutionSetupPlan(plan({
      workspaceInputs: [{
        path: 'assets',
        kind: 'directory',
        sourceStatus: 'ignored',
        category: 'build_output',
        allowLargeCopy: true,
        fileCount: 1200,
        totalBytes: 5_000_000,
        reason: 'Needed for the build.',
      }],
    }))

    // The client serialiser omitted both fields, so saving an edited plan from
    // the UI round-tripped away what the generator had measured.
    expect(inputs(serialized)[0]).toMatchObject({ file_count: 1200, total_bytes: 5_000_000, allow_large_copy: true })
  })

  it('keeps an explicit allow_large_copy: false', () => {
    const serialized = serializeExecutionSetupPlan(plan({
      workspaceInputs: [{
        path: 'assets',
        kind: 'directory',
        sourceStatus: 'ignored',
        category: 'build_output',
        allowLargeCopy: false,
        reason: 'Too large to copy.',
      }],
    }))

    // Emitting it only when truthy turned a recorded decision into an absent
    // field, which reads back as "never decided".
    expect(Object.hasOwn(inputs(serialized)[0]!, 'allow_large_copy')).toBe(true)
    expect(inputs(serialized)[0]?.allow_large_copy).toBe(false)
  })

  it('omits the optional fields entirely when there is nothing to record', () => {
    const serialized = serializeExecutionSetupPlan(plan({
      workspaceInputs: [{ path: 'a', kind: 'file', sourceStatus: 'untracked', category: 'other', reason: 'r' }],
    }))
    const input = inputs(serialized)[0]!
    expect(Object.hasOwn(input, 'allow_large_copy')).toBe(false)
    expect(Object.hasOwn(input, 'file_count')).toBe(false)
    expect(Object.hasOwn(input, 'total_bytes')).toBe(false)
  })

  it('fills in the git-hook defaults when a plan carries none', () => {
    const serialized = serializeExecutionSetupPlan(plan({ gitHooks: undefined, workspaceProbes: undefined }))
    const parsed = JSON.parse(serialized) as { git_hooks: { detected: unknown[] }; workspace_probes: unknown[] }
    expect(parsed.git_hooks.detected).toEqual([])
    expect(parsed.workspace_probes).toEqual([])
  })

  it('writes the keys in the order the canonical artifact uses', () => {
    // A content hash is taken over these bytes, so the order is part of the
    // contract — and the two serialisers disagreed about it.
    expect(Object.keys(JSON.parse(serializeExecutionSetupPlan(plan())) as Record<string, unknown>)).toEqual([
      'schema_version',
      'ticket_id',
      'artifact',
      'status',
      'host_context',
      'summary',
      'readiness',
      'temp_roots',
      'workspace_inputs',
      'workspace_probes',
      'git_hooks',
      'steps',
      'project_commands',
      'quality_gate_policy',
      'cautions',
    ])
  })
})
