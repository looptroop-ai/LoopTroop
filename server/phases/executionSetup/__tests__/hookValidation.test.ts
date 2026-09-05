import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runExplicitGitHookValidation, runGitHookValidationCommand, runGitHookValidationCommands } from '../hookValidation'
import { createShellCommandSpec } from '@shared/commandSpec'
import { detectHostContext } from '../../../lib/hostContext'

/** A command spec for whichever shell this machine actually runs. */
function shellSpec(script: string) {
  return createShellCommandSpec(script, detectHostContext().preferredShell)
}
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

  it('reports a failed restore as an error instead of throwing over the run', async () => {
    const root = makeRepo()

    // Moving the repository out from under the run is the one sabotage that
    // reliably breaks both halves of the restore. Reaching the assertions at
    // all is the point: a restore that throws replaces everything the
    // validation found with an exception about the cleanup.
    const result = await runExplicitGitHookValidation({
      profileContent: profile('validate_advisory', 'node -e "require(\'fs\').renameSync(\'.git\', \'.git-moved\')"'),
      worktreePath: root,
    })

    expect(result.receipts).toEqual([expect.objectContaining({ id: 'pre-commit', status: 'passed' })])
    // Blocking under either policy: the next phase would otherwise start from
    // whatever the hooks left behind.
    expect(result.errors).toEqual([expect.stringContaining('could not restore the worktree')])
  })
})

describe('runGitHookValidationCommands', () => {
  /** One approved command, described the way a profile describes it. */
  function hookCommand(id: string, script: string) {
    return { id, hook: id, command: shellSpec(script) }
  }

  const writesTrackedFile = 'node -e "require(\'fs\').writeFileSync(\'tracked.txt\', \'after\\n\')"'
  const fails = 'node -e "process.exit(3)"'
  const passes = 'node -e "process.exit(0)"'

  it('stops at the first failure, or runs every command, as asked', async () => {
    const commands = [hookCommand('first', fails), hookCommand('second', passes)]

    const stopping = await runGitHookValidationCommands({
      commands,
      worktreePath: makeRepo(),
      stopOnFirstFailure: true,
      protectWorktree: false,
      auditFileMutation: false,
      nextTimeoutMs: () => 30_000,
    })
    expect(stopping.outcomes.map((outcome) => outcome.command.id)).toEqual(['first'])

    // The setup-profile validator wants every command run: its hooks are part
    // of preparing the workspace, not a check that has to stop at the first no.
    const continuing = await runGitHookValidationCommands({
      commands,
      worktreePath: makeRepo(),
      stopOnFirstFailure: false,
      protectWorktree: false,
      auditFileMutation: false,
      nextTimeoutMs: () => 30_000,
    })
    expect(continuing.outcomes.map((outcome) => outcome.command.id)).toEqual(['first', 'second'])
    expect(continuing.outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'passed'])
  })

  it('restores what the commands wrote only when asked to protect the worktree', async () => {
    const protectedRoot = makeRepo()
    const protectedRun = await runGitHookValidationCommands({
      commands: [hookCommand('writer', writesTrackedFile)],
      worktreePath: protectedRoot,
      stopOnFirstFailure: true,
      protectWorktree: true,
      auditFileMutation: false,
      nextTimeoutMs: () => 30_000,
    })
    expect(protectedRun.restoreFailure).toBeNull()
    expect(readFileSync(join(protectedRoot, 'tracked.txt'), 'utf8')).toBe('before\n')

    const unprotectedRoot = makeRepo()
    await runGitHookValidationCommands({
      commands: [hookCommand('writer', writesTrackedFile)],
      worktreePath: unprotectedRoot,
      stopOnFirstFailure: false,
      protectWorktree: false,
      auditFileMutation: false,
      nextTimeoutMs: () => 30_000,
    })
    expect(readFileSync(join(unprotectedRoot, 'tracked.txt'), 'utf8')).toBe('after\n')
  })

  it('reports what the commands changed only when asked to audit', async () => {
    const audited = await runGitHookValidationCommands({
      commands: [hookCommand('writer', writesTrackedFile)],
      worktreePath: makeRepo(),
      stopOnFirstFailure: true,
      protectWorktree: true,
      auditFileMutation: true,
      nextTimeoutMs: () => 30_000,
    })
    // Captured before the restore erases it, which is the only moment it exists.
    expect(audited.fileAudit).toMatchObject({ mutated: true, candidatePaths: ['tracked.txt'] })

    const unaudited = await runGitHookValidationCommands({
      commands: [hookCommand('writer', writesTrackedFile)],
      worktreePath: makeRepo(),
      stopOnFirstFailure: false,
      protectWorktree: false,
      auditFileMutation: false,
      nextTimeoutMs: () => 30_000,
    })
    expect(unaudited.fileAudit).toEqual({
      mutated: false,
      candidatePaths: [],
      temporaryPaths: [],
      internalPaths: [],
    })
  })

  it('ends the run when the caller has no budget left for the next command', async () => {
    const run = await runGitHookValidationCommands({
      commands: [hookCommand('first', passes), hookCommand('second', passes)],
      worktreePath: makeRepo(),
      stopOnFirstFailure: false,
      protectWorktree: false,
      auditFileMutation: false,
      // The execution-setup attempt has its own deadline, and a command it
      // cannot fit is not started rather than started with no time.
      nextTimeoutMs: (command) => (command.id === 'second' ? null : 30_000),
    })
    expect(run.outcomes.map((outcome) => outcome.command.id)).toEqual(['first'])
    expect(run.receipts).toHaveLength(1)
  })

  it('refuses to run at all when protection was asked for and cannot be arranged', async () => {
    const root = makeTempDir('looptroop-hook-validation-')
    roots.push(root)

    const run = await runGitHookValidationCommands({
      commands: [hookCommand('writer', 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'x\')"')],
      worktreePath: root,
      stopOnFirstFailure: true,
      protectWorktree: true,
      auditFileMutation: true,
      nextTimeoutMs: () => 30_000,
    })

    expect(run.refused).toBe(true)
    expect(run.outcomes).toEqual([])
    expect(() => readFileSync(join(root, 'ran.txt'), 'utf8')).toThrow()
  })
})

describe('runGitHookValidationCommand', () => {
  it('scores a passing, a failing and a timed-out command the same way for both callers', async () => {
    const root = makeRepo()

    const passed = await runGitHookValidationCommand({
      id: 'ok',
      command: shellSpec('node -e "process.exit(0)"'),
      worktreePath: root,
      timeoutMs: 30_000,
    })
    expect(passed.status).toBe('passed')
    expect(passed.receipt).toMatchObject({ id: 'ok', status: 'passed', exitCode: 0 })

    const failed = await runGitHookValidationCommand({
      id: 'bad',
      command: shellSpec('node -e "process.stderr.write(\'nope\'); process.exit(7)"'),
      worktreePath: root,
      timeoutMs: 30_000,
    })
    expect(failed.status).toBe('failed')
    expect(failed.receipt).toMatchObject({ id: 'bad', status: 'failed', exitCode: 7 })
    expect(failed.outputExcerpt).toContain('nope')

    const timedOut = await runGitHookValidationCommand({
      id: 'slow',
      command: shellSpec('node -e "setTimeout(() => {}, 60000)"'),
      worktreePath: root,
      timeoutMs: 200,
    })
    expect(timedOut.status).toBe('timed_out')
    expect(timedOut.receipt.status).toBe('timed_out')
  })

  it('leaves a command that carries its own timeout alone', async () => {
    const root = makeRepo()
    const outcome = await runGitHookValidationCommand({
      id: 'own-timeout',
      command: { ...shellSpec('node -e "process.exit(0)"'), timeoutMs: 5_000 },
      worktreePath: root,
      timeoutMs: 200,
    })
    expect(outcome.status).toBe('passed')
    expect(outcome.receipt.command).toMatchObject({ timeoutMs: 5_000 })
  })
})
