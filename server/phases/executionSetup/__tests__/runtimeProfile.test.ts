import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, removeTempDir } from '../../../test/tempDir'
import type { ExecutionSetupProfile } from '../types'
import {
  EXECUTION_SETUP_RUN_WRAPPER,
  commandMentionsExecutionSetupWrapper,
  findCanonicalExecutionSetupCommandWrapper,
  getExecutionSetupCommandWrapper,
  getExecutionSetupCommandWrapperFromContent,
  getExecutionSetupCommandWrapperFromRecord,
  hasExecutionSetupProjectCommands,
  normalizeExecutionSetupCommandPath,
  repairExecutionSetupCommandWrapper,
} from '../runtimeProfile'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    removeTempDir(directory)
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
  it('normalizes wrapper paths in strings and rendered command specs', () => {
    expect(normalizeExecutionSetupCommandPath('.\\.ticket\\runtime\\execution-setup\\run')).toBe(EXECUTION_SETUP_RUN_WRAPPER)
    expect(normalizeExecutionSetupCommandPath(`  ./${EXECUTION_SETUP_RUN_WRAPPER}  `)).toBe(`./${EXECUTION_SETUP_RUN_WRAPPER}`)
    expect(commandMentionsExecutionSetupWrapper(`  node .\\${EXECUTION_SETUP_RUN_WRAPPER} test  `)).toBe(true)
    expect(commandMentionsExecutionSetupWrapper({
      mode: 'shell',
      shell: 'posix',
      script: `./${EXECUTION_SETUP_RUN_WRAPPER} test`,
      cwd: '.',
      env: {},
    })).toBe(true)
    expect(commandMentionsExecutionSetupWrapper('npm test', 'tools/run')).toBe(false)
  })

  it('prefers an explicitly declared wrapper over the canonical disk fallback', () => {
    const worktree = makeWorktree()
    writeCanonicalWrapper(worktree)
    const configured = profile({
      reusableArtifacts: [{ path: 'tools/custom-run', kind: 'command-wrapper', purpose: 'Custom wrapper' }],
    })

    expect(getExecutionSetupCommandWrapper(configured, worktree)).toBe('tools/custom-run')
  })

  it('finds wrapper declarations in artifacts and project commands', () => {
    expect(getExecutionSetupCommandWrapper(profile({
      reusableArtifacts: [
        { path: '   ', kind: 'command-wrapper', purpose: 'Empty path' },
        { path: `./${EXECUTION_SETUP_RUN_WRAPPER}`, kind: 'script', purpose: 'Canonical wrapper' },
      ],
    }))).toBe(`./${EXECUTION_SETUP_RUN_WRAPPER}`)
    expect(getExecutionSetupCommandWrapper(profile({
      projectCommands: {
        prepare: [],
        testFull: [],
        lintFull: [],
        typecheckFull: [{
          mode: 'shell',
          shell: 'posix',
          script: `node ./${EXECUTION_SETUP_RUN_WRAPPER} typecheck`,
          cwd: '.',
          env: {},
        }],
      },
    }))).toBe(EXECUTION_SETUP_RUN_WRAPPER)
    expect(getExecutionSetupCommandWrapper(null)).toBeNull()
    expect(getExecutionSetupCommandWrapper(profile())).toBeNull()

    const worktree = makeWorktree()
    writeCanonicalWrapper(worktree)
    expect(getExecutionSetupCommandWrapper(profile(), worktree)).toBe(EXECUTION_SETUP_RUN_WRAPPER)
  })

  it('reports project commands in any supported command group', () => {
    expect(hasExecutionSetupProjectCommands(null)).toBe(false)
    for (const group of ['prepare', 'testFull', 'lintFull', 'typecheckFull'] as const) {
      expect(hasExecutionSetupProjectCommands(profile({
        projectCommands: { prepare: [], testFull: [], lintFull: [], typecheckFull: [], [group]: ['npm test'] },
      }))).toBe(true)
    }
    expect(hasExecutionSetupProjectCommands(profile())).toBe(false)
  })

  it('reads nested and flat wrapper records, including persisted field aliases', () => {
    expect(getExecutionSetupCommandWrapperFromRecord({
      profile: {
        reusable_artifacts: [
          null,
          { path: 42, kind: 'command-wrapper' },
          { path: '  tools/custom-run  ', kind: ' command-wrapper ' },
        ],
      },
    })).toBe('tools/custom-run')

    expect(getExecutionSetupCommandWrapperFromRecord({
      reusableArtifacts: [
        false,
        { path: 42, kind: 3 },
        { path: `./${EXECUTION_SETUP_RUN_WRAPPER}`, kind: 'script' },
      ],
    })).toBe(`./${EXECUTION_SETUP_RUN_WRAPPER}`)

    expect(getExecutionSetupCommandWrapperFromRecord({
      profile: {
        project_commands: {
          prepare: [null, '  '],
          test_full: [`node ./${EXECUTION_SETUP_RUN_WRAPPER} test`],
          lint_full: [],
          typecheck_full: [],
        },
      },
    })).toBe(EXECUTION_SETUP_RUN_WRAPPER)
    expect(getExecutionSetupCommandWrapperFromRecord({
      profile: [],
      projectCommands: { prepare: 1 },
      reusableArtifacts: 'invalid',
    })).toBeNull()
    expect(getExecutionSetupCommandWrapperFromRecord({ projectCommands: 1 })).toBeNull()

    const worktree = makeWorktree()
    writeCanonicalWrapper(worktree)
    expect(getExecutionSetupCommandWrapperFromRecord({ projectCommands: {} }, worktree)).toBe(EXECUTION_SETUP_RUN_WRAPPER)
  })

  it('reads wrapper declarations from JSON content and ignores non-record JSON', () => {
    expect(getExecutionSetupCommandWrapperFromContent(JSON.stringify({
      reusable_artifacts: [{ path: 'tools/run', kind: 'command-wrapper' }],
    }))).toBe('tools/run')
    expect(getExecutionSetupCommandWrapperFromContent('[]')).toBeNull()
    const worktree = makeWorktree()
    writeCanonicalWrapper(worktree)
    expect(getExecutionSetupCommandWrapperFromContent('[]', worktree)).toBe(EXECUTION_SETUP_RUN_WRAPPER)
    expect(getExecutionSetupCommandWrapperFromContent(null)).toBeNull()
    expect(getExecutionSetupCommandWrapperFromContent('{invalid')).toBeNull()
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

  it('adds the canonical artifact when missing without duplicating an existing caution', () => {
    const worktree = makeWorktree()
    writeCanonicalWrapper(worktree)
    const existingCaution = 'LoopTroop detected and recorded the canonical execution setup command wrapper.'
    const original = profile({ cautions: [existingCaution], reusableArtifacts: [{
      path: 'tools/other',
      kind: 'binary',
      purpose: 'Other tool',
    }] })

    const repaired = repairExecutionSetupCommandWrapper(original, worktree)

    expect(repaired.repaired).toBe(true)
    expect(repaired.profile.reusableArtifacts).toContainEqual({
      path: EXECUTION_SETUP_RUN_WRAPPER,
      kind: 'command-wrapper',
      purpose: 'Preserves the execution setup environment for later project commands.',
    })
    expect(repaired.profile.cautions).toEqual([existingCaution])
  })

  it('leaves a profile unchanged when the canonical wrapper is absent', () => {
    const original = profile()

    expect(repairExecutionSetupCommandWrapper(original, makeWorktree())).toEqual({ profile: original, repaired: false })
  })
})
