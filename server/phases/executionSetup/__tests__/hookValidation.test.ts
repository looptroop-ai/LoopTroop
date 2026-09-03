import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runExplicitGitHookValidation } from '../hookValidation'
import { makeTempDir, pinGitLineEndings, removeTempDir } from '../../../test/tempDir'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeTempDir(root)
})

/**
 * Validation only runs where its side effects can be undone, so every fixture
 * is a real repository — which is what production always hands it.
 */
function makeRepo(): string {
  const root = makeTempDir('looptroop-hook-validation-')
  roots.push(root)
  execFileSync('git', ['init', root], { stdio: 'ignore' })
  pinGitLineEndings(root)
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
  writeFileSync(join(root, 'tracked.txt'), 'before\n')
  execFileSync('git', ['-C', root, 'add', 'tracked.txt'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'initial'], { stdio: 'ignore' })
  return root
}

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
    const root = makeRepo()
    const result = await runExplicitGitHookValidation({
      profileContent: profile('validate_advisory', 'node -e "process.exit(0)"'),
      worktreePath: root,
    })
    expect(result.errors).toEqual([])
    expect(result.receipts).toEqual([expect.objectContaining({ id: 'pre-commit', status: 'passed', exitCode: 0 })])
  })

  it('reports advisory validation failure without blocking', async () => {
    const root = makeRepo()
    const result = await runExplicitGitHookValidation({
      // Single quotes for the inner JS string: PowerShell has no backslash
      // escape, so \" would end the argument and node would get a broken script.
      profileContent: profile('validate_advisory', 'node -e "process.stderr.write(\'missing prerequisite\'); process.exit(4)"'),
      worktreePath: root,
    })
    expect(result.receipts[0]).toMatchObject({ status: 'failed', exitCode: 4, outputExcerpt: expect.stringContaining('missing prerequisite') })
    expect(result.errors).toEqual([])
    expect(result.warnings[0]).toContain('missing prerequisite')
  })

  it('returns required validation failure as a blocking error', async () => {
    const root = makeRepo()
    const result = await runExplicitGitHookValidation({
      profileContent: profile('validate_required', 'node -e "process.exit(4)"'),
      worktreePath: root,
    })
    expect(result.errors[0]).toContain('validation failed')
    expect(result.warnings).toEqual([])
  })

  it.each(['use_native_hooks', 'observe_only'] as const)('does not run explicit commands for %s', async (policy) => {
    const root = makeRepo()
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
    const root = makeRepo()

    const result = await runExplicitGitHookValidation({
      profileContent: profile('validate_advisory', 'node -e "require(\'fs\').writeFileSync(\'tracked.txt\', \'after\\n\')"'),
      worktreePath: root,
    })
    expect(result.fileAudit).toMatchObject({ mutated: true, candidatePaths: ['tracked.txt'] })
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('before\n')
  })

  it('restores the worktree when a command fails part-way through', async () => {
    const root = makeRepo()

    const result = await runExplicitGitHookValidation({
      profileContent: profile('validate_required', 'node -e "require(\'fs\').writeFileSync(\'tracked.txt\', \'after\\n\'); process.exit(1)"'),
      worktreePath: root,
    })

    // The restore used to sit after the loop, so a failing command's file
    // changes survived alongside the error it reported.
    expect(result.errors).toHaveLength(1)
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('before\n')
    expect(result.fileAudit.mutated).toBe(true)
  })

  it('unstages what a hook staged, not just what it wrote', async () => {
    const root = makeRepo()

    await runExplicitGitHookValidation({
      profileContent: profile(
        'validate_advisory',
        'node -e "require(\'fs\').writeFileSync(\'added.txt\', \'x\'); require(\'child_process\').execFileSync(\'git\', [\'add\', \'added.txt\'])"',
      ),
      worktreePath: root,
    })

    // Restoring the worktree alone left the hook's `git add` in the index, so
    // the file came back as `AD` — staged as added, missing from the worktree.
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain=v1'], { encoding: 'utf8' })
    expect(status).toBe('')
  })

  it('restores the worktree when the run is aborted between commands', async () => {
    const root = makeRepo()
    // Aborted on the second read, so the first command runs and the second
    // iteration throws — the path that used to skip the restore entirely,
    // because it sat after the loop rather than in a finally.
    let reads = 0
    const signal = {
      get aborted() {
        reads += 1
        return reads > 1
      },
      reason: new Error('cancelled'),
    } as unknown as AbortSignal

    const twoCommands = JSON.stringify({
      git_hooks: {
        policy: 'validate_advisory',
        validation_commands: [
          { id: 'first', hook: 'pre-commit', command: 'node -e "require(\'fs\').writeFileSync(\'tracked.txt\', \'after\\n\')"', purpose: 'test' },
          { id: 'second', hook: 'pre-push', command: 'node -e "process.exit(0)"', purpose: 'test' },
        ],
      },
    })

    await expect(runExplicitGitHookValidation({
      profileContent: twoCommands,
      worktreePath: root,
      signal,
    })).rejects.toThrow('cancelled')

    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('before\n')
  })

  it('refuses to run at all when the worktree cannot be snapshotted', async () => {
    const root = makeTempDir('looptroop-hook-validation-')
    roots.push(root)

    const result = await runExplicitGitHookValidation({
      profileContent: profile('validate_required', 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'x\')"'),
      worktreePath: root,
    })

    // Not a git repository, so nothing could be undone. Running the commands
    // anyway is how hook side effects used to survive.
    expect(result.receipts).toEqual([expect.objectContaining({ status: 'skipped' })])
    expect(result.errors).toHaveLength(1)
    expect(() => readFileSync(join(root, 'ran.txt'), 'utf8')).toThrow()
  })
})
