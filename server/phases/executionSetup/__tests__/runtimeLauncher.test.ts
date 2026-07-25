import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeExecutionSetupRuntimeLauncher } from '../runtimeLauncher'
import type { ExecutionSetupProfile } from '../types'

function profile(preferredShell: 'posix' | 'cmd' | 'powershell'): ExecutionSetupProfile {
  return {
    schemaVersion: 1,
    ticketId: 'T-1',
    artifact: 'execution_setup_profile',
    status: 'ready',
    hostContext: {
      platform: preferredShell === 'posix' ? 'linux' : 'windows',
      environment: 'native',
      arch: 'x64',
      availableShells: [preferredShell],
      preferredShell,
    },
    summary: 'ready',
    tempRoots: ['.ticket/runtime/execution-setup'],
    workspaceInputs: [],
    runtimeEnvironment: {
      pathPrepend: ['.ticket/runtime/execution-setup/tool-cache/bin'],
      variables: { TOOL_MODE: 'ticket value' },
    },
    bootstrapCommands: [],
    toolingProbeCommands: [],
    workspaceProbes: [],
    gitHooks: { policy: 'validate_advisory', detected: [], validationCommands: [] },
    reusableArtifacts: [],
    projectCommands: { prepare: [], testFull: [], lintFull: [], typecheckFull: [] },
    qualityGatePolicy: { tests: '', lint: '', typecheck: '', fullProjectFallback: '' },
    cautions: [],
  }
}

describe('execution setup runtime launcher', () => {
  it.each([
    ['posix', 'launcher.sh', 'exec "$@"'],
    ['powershell', 'launcher.ps1', '& $program @programArgs'],
    ['cmd', 'launcher.cmd', '%*'],
  ] as const)('writes a host-specific %s launcher', (shell, filename, invocation) => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'looptroop-launcher-'))
    const artifact = writeExecutionSetupRuntimeLauncher({ worktreePath, profile: profile(shell) })

    expect(artifact.path).toBe(`.ticket/runtime/execution-setup/${filename}`)
    const content = readFileSync(join(worktreePath, artifact.path), 'utf8')
    expect(content).toContain(invocation)
    expect(content).toContain('TOOL_MODE')
    expect(content).toContain('tool-cache')
  })
})
