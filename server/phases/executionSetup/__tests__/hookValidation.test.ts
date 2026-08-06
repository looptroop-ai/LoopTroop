import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runExplicitGitHookValidation } from '../hookValidation'
import { makeTempDir, pinGitLineEndings } from '../../../test/tempDir'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function profile(policy: string, command = ''): string {
  return JSON.stringify({
    git_hooks: {
      policy,
      validation_commands: command ? [{ id: 'pre-commit', hook: 'pre-commit', command, purpose: 'test' }] : [],
    },
  })
}

describe('runExplicitGitHookValidation', () => {
  it('runs approved commands and persists a passing receipt', async () => {
    const root = makeTempDir('looptroop-hook-validation-')
    roots.push(root)
    const result = await runExplicitGitHookValidation({
      profileContent: profile('validate_advisory', 'node -e "process.exit(0)"'),
      worktreePath: root,
    })
    expect(result.errors).toEqual([])
    expect(result.receipts).toEqual([expect.objectContaining({ id: 'pre-commit', status: 'passed', exitCode: 0 })])
  })

  it('reports advisory validation failure without blocking', async () => {
    const root = makeTempDir('looptroop-hook-validation-')
    roots.push(root)
    const result = await runExplicitGitHookValidation({
      profileContent: profile('validate_advisory', 'node -e "process.stderr.write(\'missing prerequisite\'); process.exit(4)"'),
      worktreePath: root,
    })
    expect(result.receipts[0]).toMatchObject({ status: 'failed', exitCode: 4, outputExcerpt: expect.stringContaining('missing prerequisite') })
    expect(result.errors).toEqual([])
    expect(result.warnings[0]).toContain('missing prerequisite')
  })

  it('returns required validation failure as a blocking error', async () => {
    const root = makeTempDir('looptroop-hook-validation-')
    roots.push(root)
    const result = await runExplicitGitHookValidation({
      profileContent: profile('validate_required', 'node -e "process.exit(4)"'),
      worktreePath: root,
    })
    expect(result.errors[0]).toContain('validation failed')
    expect(result.warnings).toEqual([])
  })

  it.each(['use_native_hooks', 'observe_only'] as const)('does not run explicit commands for %s', async (policy) => {
    const root = makeTempDir('looptroop-hook-validation-')
    roots.push(root)
    const result = await runExplicitGitHookValidation({
      profileContent: profile(policy, 'node -e "process.exit(9)"'),
      worktreePath: root,
    })
    expect(result).toMatchObject({
      policy,
      errors: [],
      receipts: [expect.objectContaining({ status: 'skipped' })],
      fileAudit: { mutated: false, candidatePaths: [], temporaryPaths: [], internalPaths: [] },
    })
  })

  it('audits files mutated by an explicit hook command', async () => {
    const root = makeTempDir('looptroop-hook-validation-')
    roots.push(root)
    const { execFileSync } = await import('node:child_process')
    const { writeFileSync } = await import('node:fs')
    execFileSync('git', ['init', root], { stdio: 'ignore' })
    pinGitLineEndings(root)
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'tracked.txt'), 'before\n')
    execFileSync('git', ['-C', root, 'add', 'tracked.txt'])
    execFileSync('git', ['-C', root, 'commit', '-m', 'initial'], { stdio: 'ignore' })

    const result = await runExplicitGitHookValidation({
      profileContent: profile('validate_advisory', 'node -e "require(\'fs\').writeFileSync(\'tracked.txt\', \'after\\n\')"'),
      worktreePath: root,
    })
    expect(result.fileAudit).toMatchObject({ mutated: true, candidatePaths: ['tracked.txt'] })
    expect((await import('node:fs')).readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('before\n')
  })
})
