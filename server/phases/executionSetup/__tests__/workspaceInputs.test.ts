import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionSetupWorkspaceInputPayload } from '../../../structuredOutput/types'
import {
  materializeExecutionSetupWorkspaceInputs,
  validateExecutionSetupWorkspaceInputs,
} from '../workspaceInputs'

interface WorkspaceFixture {
  projectRoot: string
  worktreePath: string
}

const fixtureRoots: string[] = []

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function createWorkspaceFixture(): WorkspaceFixture {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'execution-setup-workspace-inputs-'))
  fixtureRoots.push(fixtureRoot)
  const projectRoot = join(fixtureRoot, 'original')
  const worktreePath = join(fixtureRoot, 'ticket-worktree')
  mkdirSync(projectRoot, { recursive: true })
  runGit(projectRoot, ['init', '--initial-branch=main'])
  runGit(projectRoot, ['config', 'user.email', 'test@example.com'])
  runGit(projectRoot, ['config', 'user.name', 'Test'])
  writeFileSync(join(projectRoot, '.gitignore'), 'ignored-inputs/\nignored-file.json\n')
  mkdirSync(join(projectRoot, 'mixed-inputs'), { recursive: true })
  writeFileSync(join(projectRoot, 'mixed-inputs', 'tracked.txt'), 'tracked baseline\n')
  writeFileSync(join(projectRoot, 'README.md'), 'fixture\n')
  runGit(projectRoot, ['add', '.gitignore', 'README.md', 'mixed-inputs/tracked.txt'])
  runGit(projectRoot, ['commit', '-m', 'initial'])
  runGit(projectRoot, ['worktree', 'add', '-b', 'ticket-test', worktreePath, 'HEAD'])
  return { projectRoot, worktreePath }
}

function input(
  path: string,
  kind: ExecutionSetupWorkspaceInputPayload['kind'],
  sourceStatus: ExecutionSetupWorkspaceInputPayload['sourceStatus'],
): ExecutionSetupWorkspaceInputPayload {
  return { path, kind, sourceStatus, reason: 'Required by the workspace setup.' }
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('execution setup workspace inputs', () => {
  it('validates ignored files and untracked directories from the original checkout', () => {
    const fixture = createWorkspaceFixture()
    writeFileSync(join(fixture.projectRoot, 'ignored-file.json'), '{}\n')
    mkdirSync(join(fixture.projectRoot, 'untracked-inputs', 'nested'), { recursive: true })
    writeFileSync(join(fixture.projectRoot, 'untracked-inputs', 'nested', 'fixture.txt'), 'fixture\n')

    expect(validateExecutionSetupWorkspaceInputs({
      ...fixture,
      workspaceInputs: [
        input('./ignored-file.json', 'file', 'ignored'),
        input('untracked-inputs', 'directory', 'untracked'),
      ],
    })).toEqual([
      input('ignored-file.json', 'file', 'ignored'),
      input('untracked-inputs', 'directory', 'untracked'),
    ])
  })

  it.each([
    ['parent traversal', '../outside.txt', 'file', 'untracked', 'must stay inside the project'],
    ['Git internals', '.git/config', 'file', 'untracked', 'cannot target Git or LoopTroop internals'],
    ['ticket internals', '.ticket/runtime/state.json', 'file', 'untracked', 'cannot target Git or LoopTroop internals'],
    ['LoopTroop internals', '.looptroop/project.json', 'file', 'untracked', 'cannot target Git or LoopTroop internals'],
    ['missing source', 'missing.txt', 'file', 'untracked', 'does not exist in the original checkout'],
    ['tracked source', 'README.md', 'file', 'untracked', 'is not untracked in the original checkout'],
  ] as const)('rejects %s workspace inputs', (_label, path, kind, sourceStatus, message) => {
    const fixture = createWorkspaceFixture()

    expect(() => validateExecutionSetupWorkspaceInputs({
      ...fixture,
      workspaceInputs: [input(path, kind, sourceStatus)],
    })).toThrow(message)
  })

  it('rejects incorrect source classification, kind mismatches, duplicate paths, and empty reasons', () => {
    const fixture = createWorkspaceFixture()
    writeFileSync(join(fixture.projectRoot, 'ignored-file.json'), '{}\n')
    mkdirSync(join(fixture.projectRoot, 'untracked-directory'), { recursive: true })
    writeFileSync(join(fixture.projectRoot, 'untracked-directory', 'fixture.txt'), 'fixture\n')

    expect(() => validateExecutionSetupWorkspaceInputs({
      ...fixture,
      workspaceInputs: [input('ignored-file.json', 'file', 'untracked')],
    })).toThrow('is not untracked in the original checkout')
    expect(() => validateExecutionSetupWorkspaceInputs({
      ...fixture,
      workspaceInputs: [input('ignored-file.json', 'directory', 'ignored')],
    })).toThrow('is not a directory')
    expect(() => validateExecutionSetupWorkspaceInputs({
      ...fixture,
      workspaceInputs: [
        input('ignored-file.json', 'file', 'ignored'),
        input('./ignored-file.json', 'file', 'ignored'),
      ],
    })).toThrow('is duplicated')
    expect(() => validateExecutionSetupWorkspaceInputs({
      ...fixture,
      workspaceInputs: [{ ...input('ignored-file.json', 'file', 'ignored'), reason: '  ' }],
    })).toThrow('requires a reason')
  })

  it('rejects paths that escape the original checkout through a symlinked ancestor', () => {
    const fixture = createWorkspaceFixture()
    const outside = join(fixture.projectRoot, '..', 'outside-inputs')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'manifest.json'), '{}\n')
    symlinkSync(outside, join(fixture.projectRoot, 'linked-inputs'), 'dir')

    expect(() => validateExecutionSetupWorkspaceInputs({
      ...fixture,
      workspaceInputs: [input('linked-inputs/manifest.json', 'file', 'untracked')],
    })).toThrow('escapes the project')
  })

  it('recursively materializes eligible inputs without overwriting tracked worktree files', () => {
    const fixture = createWorkspaceFixture()
    writeFileSync(join(fixture.projectRoot, 'mixed-inputs', 'tracked.txt'), 'original dirty tracked content\n')
    mkdirSync(join(fixture.projectRoot, 'mixed-inputs', 'nested'), { recursive: true })
    writeFileSync(join(fixture.projectRoot, 'mixed-inputs', 'local.txt'), 'local input\n')
    writeFileSync(join(fixture.projectRoot, 'mixed-inputs', 'nested', 'fixture.txt'), 'nested input\n')

    const result = materializeExecutionSetupWorkspaceInputs({
      ...fixture,
      workspaceInputs: [input('mixed-inputs', 'directory', 'untracked')],
    })

    expect(result.copiedPaths).toEqual(['mixed-inputs'])
    expect(readFileSync(join(fixture.worktreePath, 'mixed-inputs', 'tracked.txt'), 'utf8')).toBe('tracked baseline\n')
    expect(readFileSync(join(fixture.worktreePath, 'mixed-inputs', 'local.txt'), 'utf8')).toBe('local input\n')
    expect(readFileSync(join(fixture.worktreePath, 'mixed-inputs', 'nested', 'fixture.txt'), 'utf8')).toBe('nested input\n')
  })

  it('rematerializes approved inputs after a retry reset removes them', () => {
    const fixture = createWorkspaceFixture()
    mkdirSync(join(fixture.projectRoot, 'ignored-inputs', 'nested'), { recursive: true })
    writeFileSync(join(fixture.projectRoot, 'ignored-inputs', 'nested', 'state.txt'), 'prepared input\n')
    const workspaceInputs = [input('ignored-inputs', 'directory', 'ignored')]

    materializeExecutionSetupWorkspaceInputs({ ...fixture, workspaceInputs })
    rmSync(join(fixture.worktreePath, 'ignored-inputs'), { recursive: true, force: true })
    materializeExecutionSetupWorkspaceInputs({ ...fixture, workspaceInputs })

    expect(readFileSync(join(fixture.worktreePath, 'ignored-inputs', 'nested', 'state.txt'), 'utf8')).toBe('prepared input\n')
  })
})
