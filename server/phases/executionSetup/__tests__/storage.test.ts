import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir } from '../../../test/tempDir'
import {
  createExecutionSetupPathSnapshot,
  removeExecutionSetupPathViolations,
  validateExecutionSetupPaths,
} from '../storage'

function createGitRepo(): string {
  const dir = makeTempDir('execution-setup-storage-')
  execFileSync('git', ['-C', dir, 'init'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' })
  writeFileSync(join(dir, 'hello.ts'), 'export const hello = 1\n')
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial'], { stdio: 'pipe' })
  return dir
}

describe('execution setup storage tracking', () => {
  const repoDirs: string[] = []

  function makeFreshRepo(): string {
    const dir = createGitRepo()
    repoDirs.push(dir)
    return dir
  }

  afterAll(() => {
    for (const dir of repoDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allows setup to change tracked repository files outside runtime paths', () => {
    const dir = makeFreshRepo()
    writeFileSync(join(dir, 'hello.ts'), 'export const hello = 2\n')

    const validation = validateExecutionSetupPaths(dir)

    expect(validation.ok).toBe(true)
    expect(validation.violations).toEqual([])
    expect(validation.changedPaths).toContain('hello.ts')
  })

  it('allows setup to create non-ignored untracked files outside runtime paths', () => {
    const dir = makeFreshRepo()
    writeFileSync(join(dir, 'scratch.ts'), 'temporary\n')

    const validation = validateExecutionSetupPaths(dir)

    expect(validation.ok).toBe(true)
    expect(validation.violations).toEqual([])
    expect(validation.changedPaths).toContain('scratch.ts')
  })

  it('allows newly created ignored setup outputs outside runtime paths', () => {
    const dir = makeFreshRepo()
    writeFileSync(join(dir, '.gitignore'), 'tool-cache/\n')
    execFileSync('git', ['-C', dir, 'add', '.gitignore'], { stdio: 'pipe' })
    execFileSync('git', ['-C', dir, 'commit', '-m', 'ignore tool cache'], { stdio: 'pipe' })
    const baseline = createExecutionSetupPathSnapshot(dir)

    mkdirSync(join(dir, 'tool-cache', 'deps'), { recursive: true })
    writeFileSync(join(dir, 'tool-cache', 'deps', 'state.txt'), 'warm\n')

    const validation = validateExecutionSetupPaths(dir, baseline)

    expect(validation.ok).toBe(true)
    expect(validation.violations).toEqual([])
  })

  it('does not remove repository-local setup outputs when cleanup is requested', () => {
    const dir = makeFreshRepo()
    writeFileSync(join(dir, '.gitignore'), 'tool-cache/\n')
    execFileSync('git', ['-C', dir, 'add', '.gitignore'], { stdio: 'pipe' })
    execFileSync('git', ['-C', dir, 'commit', '-m', 'ignore tool cache'], { stdio: 'pipe' })
    const baseline = createExecutionSetupPathSnapshot(dir)

    mkdirSync(join(dir, '.ticket', 'runtime', 'execution-setup'), { recursive: true })
    writeFileSync(join(dir, '.ticket', 'runtime', 'execution-log.jsonl'), '{"message":"keep"}\n')
    writeFileSync(join(dir, '.ticket', 'runtime', 'execution-setup-profile.json'), '{"status":"ready"}\n')
    writeFileSync(join(dir, '.ticket', 'runtime', 'execution-setup', 'cache.txt'), 'warm\n')
    mkdirSync(join(dir, 'tool-cache', 'deps'), { recursive: true })
    writeFileSync(join(dir, 'tool-cache', 'deps', 'state.txt'), 'warm\n')

    const removed = removeExecutionSetupPathViolations(dir, baseline)

    expect(removed).toEqual([])
    expect(existsSync(join(dir, 'tool-cache', 'deps', 'state.txt'))).toBe(true)
    expect(readFileSync(join(dir, '.ticket', 'runtime', 'execution-log.jsonl'), 'utf8')).toContain('"keep"')
    expect(readFileSync(join(dir, '.ticket', 'runtime', 'execution-setup-profile.json'), 'utf8')).toContain('"ready"')
    expect(readFileSync(join(dir, '.ticket', 'runtime', 'execution-setup', 'cache.txt'), 'utf8')).toBe('warm\n')
  })
})
