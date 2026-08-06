import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir } from '../../../test/tempDir'
import type { ExecutionSetupProfile } from '../types'
import {
  EXECUTION_SETUP_RUN_WRAPPER,
  findCanonicalExecutionSetupCommandWrapper,
  getExecutionSetupCommandWrapper,
  getExecutionSetupCommandWrapperFromContent,
  repairExecutionSetupCommandWrapper,
} from '../runtimeProfile'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function makeWorktree(): string {
  const worktree = makeTempDir('looptroop-runtime-profile-')
  tempDirectories.push(worktree)
  return worktree
}

function writeCanonicalWrapper(worktree: string, executable = true): string {
  const wrapperPath = join(worktree, EXECUTION_SETUP_RUN_WRAPPER)
  mkdirSync(join(worktree, '.ticket', 'runtime', 'execution-setup'), { recursive: true })
  writeFileSync(wrapperPath, '#!/bin/sh\nexec "$@"\n')
  chmodSync(wrapperPath, executable ? 0o755 : 0o644)
  return wrapperPath
}

function profile(overrides: Partial<ExecutionSetupProfile> = {}): ExecutionSetupProfile {
  return {
    schemaVersion: 1,
    ticketId: 'TEST-1',
    artifact: 'execution_setup_profile',
    status: 'ready',
    hostContext: { platform: 'linux', environment: 'native', arch: 'x64', availableShells: ['posix'], preferredShell: 'posix' },
    runtimeEnvironment: { pathPrepend: [], variables: {} },
    summary: 'Ready',
    tempRoots: [],
    workspaceInputs: [],
    bootstrapCommands: [],
    toolingProbeCommands: [],
    workspaceProbes: [],
    gitHooks: { policy: 'validate_advisory', detected: [], validationCommands: [] },
    reusableArtifacts: [],
    projectCommands: { prepare: [], testFull: [], lintFull: [], typecheckFull: [] },
    qualityGatePolicy: { tests: '', lint: '', typecheck: '', fullProjectFallback: '' },
    cautions: [],
    ...overrides,
  }
}

describe('execution setup runtime profile', () => {
  it('prefers an explicitly declared wrapper over the canonical disk fallback', () => {
    const worktree = makeWorktree()
    writeCanonicalWrapper(worktree)
    const configured = profile({
      reusableArtifacts: [{ path: 'tools/custom-run', kind: 'command-wrapper', purpose: 'Custom wrapper' }],
    })

    expect(getExecutionSetupCommandWrapper(configured, worktree)).toBe('tools/custom-run')
  })

  it.runIf(process.platform !== 'win32')('discovers only an executable canonical regular file', () => {
    const worktree = makeWorktree()
    expect(findCanonicalExecutionSetupCommandWrapper(worktree)).toBeNull()

    writeCanonicalWrapper(worktree, false)
    expect(findCanonicalExecutionSetupCommandWrapper(worktree)).toBeNull()

    chmodSync(join(worktree, EXECUTION_SETUP_RUN_WRAPPER), 0o755)
    expect(findCanonicalExecutionSetupCommandWrapper(worktree)).toBe(EXECUTION_SETUP_RUN_WRAPPER)
    expect(getExecutionSetupCommandWrapperFromContent(undefined, worktree)).toBe(EXECUTION_SETUP_RUN_WRAPPER)
    expect(getExecutionSetupCommandWrapperFromContent('{invalid', worktree)).toBe(EXECUTION_SETUP_RUN_WRAPPER)
  })

  it('rejects a canonical-path symlink instead of following an arbitrary target', () => {
    const worktree = makeWorktree()
    const outside = makeWorktree()
    const outsideWrapper = writeCanonicalWrapper(outside)
    const runtimeDirectory = join(worktree, '.ticket', 'runtime', 'execution-setup')
    mkdirSync(runtimeDirectory, { recursive: true })
    symlinkSync(outsideWrapper, join(runtimeDirectory, 'run'))

    expect(findCanonicalExecutionSetupCommandWrapper(worktree)).toBeNull()
  })

  it('repairs the canonical artifact without duplicates and adds one audit caution', () => {
    const worktree = makeWorktree()
    writeCanonicalWrapper(worktree)
    const original = profile({
      reusableArtifacts: [
        { path: './.ticket/runtime/execution-setup/run', kind: 'script', purpose: '' },
        { path: '.ticket/runtime/execution-setup/run', kind: 'runtime', purpose: 'duplicate' },
        { path: 'tools/other', kind: 'binary', purpose: 'Other tool' },
      ],
    })

    const first = repairExecutionSetupCommandWrapper(original, worktree)
    const second = repairExecutionSetupCommandWrapper(first.profile, worktree)

    expect(first.repaired).toBe(true)
    expect(first.profile).not.toBe(original)
    expect(first.profile.reusableArtifacts).toEqual([
      {
        path: EXECUTION_SETUP_RUN_WRAPPER,
        kind: 'command-wrapper',
        purpose: 'Preserves the execution setup environment for later project commands.',
      },
      { path: 'tools/other', kind: 'binary', purpose: 'Other tool' },
    ])
    expect(first.profile.cautions).toHaveLength(1)
    expect(second).toEqual({ profile: first.profile, repaired: false })
  })
})
