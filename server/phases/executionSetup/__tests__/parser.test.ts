import { describe, expect, it } from 'vitest'
import { parseExecutionSetupResult } from '../parser'
import { serializeExecutionSetupProfile } from '../types'

function buildExecutionSetupPayload(body: string): string {
  return `<EXECUTION_SETUP_RESULT>\n${body}\n</EXECUTION_SETUP_RESULT>`
}

function buildMinimalExecutionSetupResult(
  status: 'ready' | 'blocked',
  checks: Record<'workspace' | 'tooling' | 'temp_scope' | 'policy', 'pass' | 'fail'>,
) {
  return {
    status,
    summary: status === 'ready' ? 'environment initialized' : 'environment setup is blocked',
    profile: {
      schema_version: 1,
      ticket_id: 'T-1',
      artifact: 'execution_setup_profile',
      status,
      summary: status === 'ready' ? 'environment initialized and reusable' : 'required tooling is unavailable',
      temp_roots: ['.ticket/runtime/execution-setup'],
      bootstrap_commands: [],
      reusable_artifacts: [],
      project_commands: {
        prepare: [],
        test_full: [],
        lint_full: [],
        typecheck_full: [],
      },
      quality_gate_policy: {
        tests: 'bead-test-commands-first',
        lint: 'impacted-or-package',
        typecheck: 'impacted-or-package',
        full_project_fallback: 'never-block-on-unrelated-baseline',
      },
      cautions: [],
    },
    checks,
  }
}

describe('parseExecutionSetupResult', () => {
  it('parses an exact execution setup marker payload', () => {
    const parsed = parseExecutionSetupResult(buildExecutionSetupPayload(JSON.stringify({
      status: 'ready',
      summary: 'environment initialized',
      profile: {
        schema_version: 1,
        ticket_id: 'T-1',
        artifact: 'execution_setup_profile',
        status: 'ready',
        summary: 'environment initialized and reusable',
        temp_roots: ['.ticket/runtime/execution-setup', '.ticket/runtime/execution-setup/tool-cache'],
        bootstrap_commands: ['project bootstrap'],
        tooling_probe_commands: ['./.ticket/runtime/execution-setup/run go version'],
        workspace_probes: [{ id: 'workspace-1', command: 'go list ./...', purpose: 'load packages' }],
        git_hooks: {
          policy: 'validate_explicitly',
          detected: [{ name: 'pre-commit', path: '.husky/pre-commit', source: 'core.hooksPath', executable: true, manager_hint: 'husky' }],
          validation_commands: [{ id: 'hook-1', hook: 'pre-commit', command: 'project check', purpose: 'validate commit' }],
        },
        tool_requirements: [
          {
            launcher: 'project-tool',
            required_by: ['project_commands.test_full[0]'],
            status: 'provisioned',
            missing_probe: 'project-tool --version',
            provisioning_attempts: [
              {
                strategy: 'official archive',
                commands: ['./install-project-tool --prefix .ticket/runtime/execution-setup/tool-cache/project-tool'],
                result: 'provisioned',
                reason: '',
              },
            ],
            final_probe: './.ticket/runtime/execution-setup/run project-tool --version',
            failure_reason: '',
          },
        ],
        reusable_artifacts: [
          { path: '.ticket/runtime/execution-setup/tool-cache/dependencies', kind: 'cache', purpose: 'project dependency cache' },
          { path: '.ticket/runtime/execution-setup/env.sh', kind: 'environment', purpose: 'prepared runtime environment' },
          { path: '.ticket/runtime/execution-setup/run', kind: 'command-wrapper', purpose: 'sources env before commands' },
        ],
        project_commands: {
          prepare: ['project bootstrap'],
          test_full: ['./.ticket/runtime/execution-setup/run go test ./...'],
          lint_full: [],
          typecheck_full: [],
        },
        quality_gate_policy: {
          tests: 'bead-test-commands-first',
          lint: 'impacted-or-package',
          typecheck: 'impacted-or-package',
          full_project_fallback: 'never-block-on-unrelated-baseline',
        },
        cautions: [],
      },
      checks: {
        workspace: 'pass',
        tooling: 'pass',
        temp_scope: 'pass',
        policy: 'pass',
      },
    })))

    expect(parsed.markerFound).toBe(true)
    expect(parsed.errors).toEqual([])
    expect(parsed.result?.profile.artifact).toBe('execution_setup_profile')
    expect(parsed.result?.profile.tempRoots).toEqual(['.ticket/runtime/execution-setup', '.ticket/runtime/execution-setup/tool-cache'])
    expect(parsed.result?.profile.reusableArtifacts[0]?.path).toBe('.ticket/runtime/execution-setup/tool-cache/dependencies')
    expect(parsed.result?.profile.reusableArtifacts.map((artifact) => artifact.path)).toEqual([
      '.ticket/runtime/execution-setup/tool-cache/dependencies',
      '.ticket/runtime/execution-setup/env.sh',
      '.ticket/runtime/execution-setup/run',
    ])
    expect(parsed.result?.profile.toolingProbeCommands).toEqual(['./.ticket/runtime/execution-setup/run go version'])
    expect(parsed.result?.profile.workspaceProbes).toEqual([{ id: 'workspace-1', command: 'go list ./...', purpose: 'load packages' }])
    expect(parsed.result?.profile.gitHooks).toEqual({
      policy: 'validate_explicitly',
      detected: [{ name: 'pre-commit', path: '.husky/pre-commit', source: 'core.hooksPath', executable: true, managerHint: 'husky' }],
      validationCommands: [{ id: 'hook-1', hook: 'pre-commit', command: 'project check', purpose: 'validate commit' }],
    })
    expect(parsed.result?.profile.toolRequirements).toEqual([
      {
        launcher: 'project-tool',
        requiredBy: ['project_commands.test_full[0]'],
        status: 'provisioned',
        missingProbe: 'project-tool --version',
        provisioningAttempts: [
          {
            strategy: 'official archive',
            commands: ['./install-project-tool --prefix .ticket/runtime/execution-setup/tool-cache/project-tool'],
            result: 'provisioned',
            reason: '',
          },
        ],
        finalProbe: './.ticket/runtime/execution-setup/run project-tool --version',
        failureReason: '',
      },
    ])
    expect(parsed.result?.profile.projectCommands.testFull).toEqual(['./.ticket/runtime/execution-setup/run go test ./...'])
  })

  it('serializes optional tool requirements in execution setup profile artifacts', () => {
    const baseProfile = {
      schemaVersion: 1,
      ticketId: 'T-1',
      artifact: 'execution_setup_profile',
      status: 'ready',
      summary: 'environment initialized and reusable',
      tempRoots: ['.ticket/runtime/execution-setup'],
      workspaceInputs: [],
      bootstrapCommands: [],
      toolingProbeCommands: ['./.ticket/runtime/execution-setup/run go version'],
      workspaceProbes: [],
      gitHooks: {
        policy: 'validate_explicitly',
        detected: [],
        validationCommands: [],
      },
      reusableArtifacts: [],
      projectCommands: {
        prepare: [],
        testFull: [],
        lintFull: [],
        typecheckFull: [],
      },
      qualityGatePolicy: {
        tests: 'bead-test-commands-first',
        lint: 'impacted-or-package',
        typecheck: 'impacted-or-package',
        fullProjectFallback: 'never-block-on-unrelated-baseline',
      },
      cautions: [],
    } satisfies Parameters<typeof serializeExecutionSetupProfile>[0]

    expect(JSON.parse(serializeExecutionSetupProfile(baseProfile))).not.toHaveProperty('tool_requirements')
    expect(JSON.parse(serializeExecutionSetupProfile({
      ...baseProfile,
      status: 'blocked',
    }))).toHaveProperty('status', 'blocked')

    const serialized = serializeExecutionSetupProfile({
      ...baseProfile,
      toolRequirements: [
        {
          launcher: 'project-tool',
          requiredBy: ['project_commands.test_full[0]'],
          status: 'failed',
          missingProbe: 'project-tool --version',
          provisioningAttempts: [
            {
              strategy: 'official archive',
              commands: ['./install-project-tool --prefix .ticket/runtime/execution-setup/tool-cache/project-tool'],
              result: 'failed',
              reason: 'official archive download returned 404',
            },
          ],
          finalProbe: './.ticket/runtime/execution-setup/run project-tool --version',
          failureReason: 'official archive download returned 404',
        },
      ],
    })

    expect(JSON.parse(serialized)).toMatchObject({
      tooling_probe_commands: ['./.ticket/runtime/execution-setup/run go version'],
      tool_requirements: [
        {
          launcher: 'project-tool',
          required_by: ['project_commands.test_full[0]'],
          status: 'failed',
          missing_probe: 'project-tool --version',
          provisioning_attempts: [
            {
              strategy: 'official archive',
              commands: ['./install-project-tool --prefix .ticket/runtime/execution-setup/tool-cache/project-tool'],
              result: 'failed',
              reason: 'official archive download returned 404',
            },
          ],
          final_probe: './.ticket/runtime/execution-setup/run project-tool --version',
          failure_reason: 'official archive download returned 404',
        },
      ],
    })
  })

  it('rejects malformed provisioning attempt entries', () => {
    const parsed = parseExecutionSetupResult(buildExecutionSetupPayload(JSON.stringify({
      status: 'ready',
      summary: 'tooling failed',
      profile: {
        schema_version: 1,
        ticket_id: 'T-1',
        artifact: 'execution_setup_profile',
        status: 'ready',
        summary: 'tooling failed',
        temp_roots: ['.ticket/runtime/execution-setup'],
        bootstrap_commands: [],
        tooling_probe_commands: ['./.ticket/runtime/execution-setup/run project-tool --version'],
        tool_requirements: [
          {
            launcher: 'project-tool',
            required_by: ['project_commands.test_full[0]'],
            status: 'failed',
            missing_probe: 'project-tool --version',
            provisioning_attempts: [
              {
                commands: ['./install-project-tool --prefix .ticket/runtime/execution-setup/tool-cache/project-tool'],
                result: 'failed',
                reason: 'missing strategy should be rejected',
              },
            ],
            final_probe: './.ticket/runtime/execution-setup/run project-tool --version',
            failure_reason: 'official archive download returned 404',
          },
        ],
        reusable_artifacts: [],
        project_commands: {
          prepare: [],
          test_full: ['project-tool test'],
          lint_full: [],
          typecheck_full: [],
        },
        quality_gate_policy: {
          tests: 'bead-test-commands-first',
          lint: 'impacted-or-package',
          typecheck: 'impacted-or-package',
          full_project_fallback: 'never-block-on-unrelated-baseline',
        },
        cautions: [],
      },
      checks: {
        workspace: 'pass',
        tooling: 'fail',
        temp_scope: 'pass',
        policy: 'pass',
      },
    })))

    expect(parsed.result).toBeNull()
    expect(parsed.errors[0]).toContain('tool_requirements[0].provisioning_attempts[0].strategy')
  })

  it('repairs fenced YAML payloads inside the execution setup marker', () => {
    const parsed = parseExecutionSetupResult(buildExecutionSetupPayload([
      '```yaml',
      'status: ready',
      'summary: environment initialized',
      'profile:',
      '  schema_version: 1',
      '  ticket_id: T-1',
      '  artifact: execution_setup_profile',
      '  status: ready',
      '  summary: environment initialized and reusable',
      '  temp_roots:',
      '    - .ticket/runtime/execution-setup',
      '  bootstrap_commands:',
      '    - project bootstrap',
      '  reusable_artifacts: []',
      '  project_commands:',
      '    prepare: []',
      '    test_full: []',
      '    lint_full: []',
      '    typecheck_full: []',
      '  quality_gate_policy:',
      '    tests: bead-test-commands-first',
      '    lint: impacted-or-package',
      '    typecheck: impacted-or-package',
      '    full_project_fallback: never-block-on-unrelated-baseline',
      '  cautions: []',
      'checks:',
      '  workspace: pass',
      '  tooling: pass',
      '  temp_scope: pass',
      '  policy: pass',
      '```',
    ].join('\n')))

    expect(parsed.result?.status).toBe('ready')
    expect(parsed.repairApplied).toBe(true)
    expect(parsed.repairWarnings).toContain('Unwrapped markdown code fence wrapping the YAML payload.')
  })

  it('repairs wrapper objects around the execution setup result payload', () => {
    const parsed = parseExecutionSetupResult(buildExecutionSetupPayload(JSON.stringify({
      execution_setup_result: {
        status: 'ready',
        summary: 'environment initialized',
        profile: {
          schema_version: 1,
          ticket_id: 'T-1',
          artifact: 'execution_setup_profile',
          status: 'ready',
          summary: 'environment initialized and reusable',
          temp_roots: ['.ticket/runtime/execution-setup'],
          bootstrap_commands: [],
          reusable_artifacts: [],
          project_commands: {
            prepare: [],
            test_full: [],
            lint_full: [],
            typecheck_full: [],
          },
          quality_gate_policy: {
            tests: 'bead-test-commands-first',
            lint: 'impacted-or-package',
            typecheck: 'impacted-or-package',
            full_project_fallback: 'never-block-on-unrelated-baseline',
          },
          cautions: [],
        },
        checks: {
          workspace: 'pass',
          tooling: 'pass',
          temp_scope: 'pass',
          policy: 'pass',
        },
      },
    })))

    expect(parsed.result?.summary).toBe('environment initialized')
    expect(parsed.repairApplied).toBe(true)
    expect(parsed.repairWarnings?.some((warning) => warning.includes('Removed wrapper key'))).toBe(true)
  })

  it('parses an honest blocked result when a setup check fails', () => {
    const parsed = parseExecutionSetupResult(buildExecutionSetupPayload(JSON.stringify({
      status: 'blocked',
      summary: 'tooling is missing',
      profile: {
        schema_version: 1,
        ticket_id: 'T-1',
        artifact: 'execution_setup_profile',
        status: 'blocked',
        summary: 'required launcher is unavailable',
        temp_roots: ['.ticket/runtime/execution-setup'],
        bootstrap_commands: ['command -v project-tool || true'],
        reusable_artifacts: [],
        project_commands: {
          prepare: [],
          test_full: ['project-tool test'],
          lint_full: [],
          typecheck_full: [],
        },
        quality_gate_policy: {
          tests: 'bead-test-commands-first',
          lint: 'impacted-or-package',
          typecheck: 'impacted-or-package',
          full_project_fallback: 'never-block-on-unrelated-baseline',
        },
        cautions: ['project-tool is missing'],
      },
      checks: {
        workspace: 'pass',
        tooling: 'fail',
        temp_scope: 'pass',
        policy: 'pass',
      },
    })))

    expect(parsed.errors).toEqual([])
    expect(parsed.result?.status).toBe('blocked')
    expect(parsed.result?.profile.status).toBe('blocked')
    expect(parsed.result?.checks.tooling).toBe('fail')
  })

  it('rejects ready results when any setup check fails', () => {
    const parsed = parseExecutionSetupResult(buildExecutionSetupPayload(JSON.stringify(
      buildMinimalExecutionSetupResult('ready', {
        workspace: 'pass',
        tooling: 'fail',
        temp_scope: 'pass',
        policy: 'pass',
      }),
    )))

    expect(parsed.result).toBeNull()
    expect(parsed.errors[0]).toContain('status ready requires every setup check to pass')
  })

  it('rejects blocked results when every setup check passes', () => {
    const parsed = parseExecutionSetupResult(buildExecutionSetupPayload(JSON.stringify(
      buildMinimalExecutionSetupResult('blocked', {
        workspace: 'pass',
        tooling: 'pass',
        temp_scope: 'pass',
        policy: 'pass',
      }),
    )))

    expect(parsed.result).toBeNull()
    expect(parsed.errors[0]).toContain('status blocked requires at least one setup check to fail')
  })

  it('rejects results whose top-level and profile statuses do not match', () => {
    const payload = buildMinimalExecutionSetupResult('blocked', {
      workspace: 'pass',
      tooling: 'fail',
      temp_scope: 'pass',
      policy: 'pass',
    })
    payload.profile.status = 'ready'

    const parsed = parseExecutionSetupResult(buildExecutionSetupPayload(JSON.stringify(payload)))

    expect(parsed.result).toBeNull()
    expect(parsed.errors[0]).toContain('result status must match profile.status')
  })

  it('rejects prompt echoes clearly', () => {
    const parsed = parseExecutionSetupResult([
      'CRITICAL OUTPUT RULE:',
      'Return exactly one marker.',
      '## Expected Output Format',
      'status: ready',
      '## Context',
      '# Ticket: T-1',
    ].join('\n'))

    expect(parsed.markerFound).toBe(false)
    expect(parsed.result).toBeNull()
    expect(parsed.errors[0]).toContain('echoed the prompt')
  })

  it('fails when the execution setup marker is missing', () => {
    const parsed = parseExecutionSetupResult('status: ready\nsummary: nope')

    expect(parsed.markerFound).toBe(false)
    expect(parsed.result).toBeNull()
    expect(parsed.errors).toEqual(['No execution setup result marker found'])
  })
})
