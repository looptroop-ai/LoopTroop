import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionSetupPlan } from '../types'
import { validateGeneratedExecutionSetupPlan } from '../commandValidation'

const roots: string[] = []

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'looptroop-setup-command-validation-'))
  roots.push(root)
  return root
}

function write(root: string, path: string, content: string): string {
  const absolutePath = join(root, path)
  mkdirSync(join(absolutePath, '..'), { recursive: true })
  writeFileSync(absolutePath, content)
  return absolutePath
}

function plan(
  readiness: ExecutionSetupPlan['readiness'],
  workspaceProbes: ExecutionSetupPlan['workspaceProbes'] = [],
): ExecutionSetupPlan {
  return {
    schemaVersion: 1,
    ticketId: 'T-1',
    artifact: 'execution_setup_plan',
    status: 'draft',
    summary: 'Validate repository-native commands.',
    readiness,
    tempRoots: ['.ticket/runtime/execution-setup'],
    workspaceInputs: [],
    workspaceProbes,
    gitHooks: {
      policy: 'validate_explicitly',
      detected: [],
      validationCommands: [],
    },
    steps: [],
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
  }
}

function partialReadiness(): ExecutionSetupPlan['readiness'] {
  return {
    status: 'partial',
    actionsRequired: true,
    evidence: ['Repository manifest detected.'],
    gaps: ['Required launcher must be provisioned.'],
  }
}

function readyReadiness(): ExecutionSetupPlan['readiness'] {
  return {
    status: 'ready',
    actionsRequired: false,
    evidence: ['Workspace is ready.'],
    gaps: [],
  }
}

function withoutPath<T>(callback: () => T): T {
  const originalPath = process.env.PATH
  process.env.PATH = ''
  try {
    return callback()
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('validateGeneratedExecutionSetupPlan', () => {
  it('rejects an npm bead command in a Go repository', () => {
    const root = worktree()
    write(root, 'go.mod', 'module example.com/project\n\ngo 1.24\n')
    const beadsPath = write(root, '.ticket/beads.jsonl', `${JSON.stringify({
      id: 'B-001',
      testCommands: ['npm test'],
    })}\n`)

    const errors = validateGeneratedExecutionSetupPlan({
      plan: plan(partialReadiness()),
      worktreePath: root,
      beadsPath,
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('bead B-001 testCommands[0]')
    expect(errors[0]).toContain('npm test')
    expect(errors[0]).toContain('no package.json')
  })

  it('accepts repository-supported Go commands in a partial plan when Go is unavailable', () => {
    const root = worktree()
    write(root, 'go.mod', 'module example.com/project\n\ngo 1.24\n')
    const beadsPath = write(root, '.ticket/beads.jsonl', `${JSON.stringify({
      id: 'B-001',
      testCommands: ['go test ./...'],
    })}\n`)

    const errors = withoutPath(() => validateGeneratedExecutionSetupPlan({
      plan: plan(partialReadiness(), [{
        id: 'workspace-1',
        command: 'go list ./...',
        purpose: 'Load repository packages.',
      }]),
      worktreePath: root,
      beadsPath,
    }))

    expect(errors).toEqual([])
  })

  it('rejects ready/no-actions when a required Go launcher is unavailable', () => {
    const root = worktree()
    write(root, 'go.mod', 'module example.com/project\n\ngo 1.24\n')
    const beadsPath = write(root, '.ticket/beads.jsonl', '')

    const errors = withoutPath(() => validateGeneratedExecutionSetupPlan({
      plan: plan(readyReadiness(), [{
        id: 'workspace-1',
        command: 'go list ./...',
        purpose: 'Load repository packages.',
      }]),
      worktreePath: root,
      beadsPath,
    }))

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('cannot be ready')
    expect(errors[0]).toContain('required launcher "go" is unavailable')
    expect(errors[0]).toContain('mark readiness partial or missing and add a setup step')
  })

  it('accepts a Node task declared by package.json', () => {
    const root = worktree()
    write(root, 'package.json', JSON.stringify({
      scripts: {
        test: 'vitest run',
      },
    }))
    const beadsPath = write(root, '.ticket/beads.jsonl', `${JSON.stringify({
      id: 'B-001',
      testCommands: ['npm test'],
    })}\n`)

    const errors = validateGeneratedExecutionSetupPlan({
      plan: plan(partialReadiness()),
      worktreePath: root,
      beadsPath,
    })

    expect(errors).toEqual([])
  })

  it('accepts a repository-backed package install as a prepare command', () => {
    const root = worktree()
    write(root, 'package.json', JSON.stringify({ private: true }))
    const beadsPath = write(root, '.ticket/beads.jsonl', '')
    const candidate = plan(partialReadiness())
    candidate.projectCommands.prepare = ['npm ci']

    const errors = validateGeneratedExecutionSetupPlan({
      plan: candidate,
      worktreePath: root,
      beadsPath,
    })

    expect(errors).toEqual([])
  })
})
