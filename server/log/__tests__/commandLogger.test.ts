import { describe, it, expect } from 'vitest'
import { logCommand, withCommandLogging } from '../../log/commandLogger'

describe('commandLogger', () => {
  it('logCommand is a no-op without context', () => {
    logCommand('git', ['status'], { ok: true, stdout: 'fine' })
    expect(true).toBe(true)
  })

  it('logCommand emits when context is active', () => {
    const logs: string[] = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'DRAFT',
      () => {
        logCommand('git', ['-C', '/some/path', 'status'], { ok: true, stdout: 'on branch main' })
      },
      (_phase, _type, content) => { logs.push(content) },
    )
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain('[CMD]')
    expect(logs[0]).toContain('$ git')
    expect(logs[0]).toContain('on branch main')
  })

  it('emits compact single-line command logs with [CMD] prefix', () => {
    const logs: Array<{ phase: string; type: string; content: string }> = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'DRAFT',
      () => {
        logCommand('git', ['worktree', 'add', '/tmp/wt', 'BR-1'], { ok: true, stdout: 'Preparing worktree' })
        logCommand('git', ['rev-parse', '--show-toplevel'], { ok: true })
        logCommand('git', ['push'], { ok: false, error: 'remote rejected' })
      },
      (phase, type, content) => { logs.push({ phase, type, content }) },
    )

    expect(logs).toHaveLength(3)

    // Success with stdout — compact arrow format
    expect(logs[0]!.type).toBe('info')
    expect(logs[0]!.content).toBe('[CMD] $ git worktree add /tmp/wt BR-1  →  Preparing worktree')

    // Success without stdout — arrow format
    expect(logs[1]!.type).toBe('info')
    expect(logs[1]!.content).toBe('[CMD] $ git rev-parse --show-toplevel  →  ok')

    // Failure — compact error format
    expect(logs[2]!.type).toBe('error')
    expect(logs[2]!.content).toBe('[CMD] $ git push  →  error: remote rejected')
  })

  it('redacts Windows path prefixes as path segments', () => {
    const logs: string[] = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'DRAFT',
      () => {
        logCommand('git', ['-C', String.raw`C:\Users\Alice\project\worktree`, 'status'], { ok: true })
      },
      (_phase, _type, content) => { logs.push(content) },
    )

    expect(logs[0]).toContain('-C project/worktree')
    expect(logs[0]).not.toContain('Alice')
  })

  it('does not expose a profile name when the path has one visible segment', () => {
    const logs: string[] = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'DRAFT',
      () => {
        logCommand('git', ['-C', String.raw`C:\Users\Alice\project`, 'status'], { ok: true })
      },
      (_phase, _type, content) => { logs.push(content) },
    )

    expect(logs[0]).toContain('-C project')
    expect(logs[0]).not.toContain('Alice')
  })

  it('summarizes silent internal commands instead of showing generic ok', () => {
    const logs: string[] = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'CODING',
      () => {
        logCommand('git', ['status', '--porcelain'], { ok: true })
        logCommand('git', ['ls-files', '--others', '--exclude-standard'], { ok: true })
        logCommand('git', ['clean', '-fd'], { ok: true })
        logCommand('git', ['worktree', 'remove', '/tmp/wt'], { ok: true })
        logCommand('git', ['push', 'origin', 'HEAD:refs/heads/TEST-1'], { ok: true })
        logCommand('gh', ['pr', 'ready', '123'], { ok: true })
      },
      (_phase, _type, content) => { logs.push(content) },
    )

    expect(logs).toEqual([
      '[CMD] $ git status --porcelain  →  worktree clean',
      '[CMD] $ git ls-files --others --exclude-standard  →  no untracked files',
      '[CMD] $ git clean -fd  →  no files removed',
      '[CMD] $ git worktree remove /tmp/wt  →  worktree removed',
      '[CMD] $ git push origin HEAD:refs/heads/TEST-1  →  push completed',
      '[CMD] $ gh pr ready 123  →  pull request marked ready',
    ])
  })

  it('summarizes git push with informational remote stderr as compact push completed', () => {
    const logs: Array<{ type: string; content: string }> = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'CODING',
      () => {
        logCommand('git', ['-C', '/tmp/worktrees/SYTH-10', 'push', 'origin', 'HEAD:refs/heads/SYTH-10'], {
          ok: true,
          stderr: [
            'remote: ',
            'remote: Create a pull request for \'SYTH-10\' on GitHub by visiting:',
            'remote:      https://github.com/org/repo/pull/new/SYTH-10',
            'remote: ',
            'To github.com:org/repo.git',
            ' * [new branch]      HEAD -> SYTH-10',
          ].join('\n'),
        })
      },
      (_phase, type, content) => { logs.push({ type, content }) },
    )

    expect(logs).toEqual([
      {
        type: 'info',
        content: [
          '[CMD] $ git -C worktrees/SYTH-10 push origin HEAD:refs/heads/SYTH-10  →  push completed',
          'REMOTE:',
          'remote: ',
          'remote: Create a pull request for \'SYTH-10\' on GitHub by visiting:',
          'remote:      https://github.com/org/repo/pull/new/SYTH-10',
          'remote: ',
          'To github.com:org/repo.git',
          ' * [new branch]      HEAD -> SYTH-10',
        ].join('\n'),
      },
    ])
  })

  it('summarizes git push with stdout and stderr as compact push completed', () => {
    const logs: Array<{ type: string; content: string }> = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'CODING',
      () => {
        logCommand('git', ['push', 'origin', 'HEAD:refs/heads/SYTH-10'], {
          ok: true,
          stdout: '',
          stderr: 'To github.com:org/repo.git\n   d9c79cc..2a383e0  HEAD -> SYTH-10',
        })
      },
      (_phase, type, content) => { logs.push({ type, content }) },
    )

    expect(logs).toEqual([
      {
        type: 'info',
        content: [
          '[CMD] $ git push origin HEAD:refs/heads/SYTH-10  →  push completed',
          'REMOTE:',
          'To github.com:org/repo.git',
          '   d9c79cc..2a383e0  HEAD -> SYTH-10',
        ].join('\n'),
      },
    ])
  })

  it('emits stderr-only output as a structured command section', () => {
    const logs: string[] = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'DRAFT',
      () => {
        logCommand('git', ['worktree', 'add', '/tmp/wt', 'BRANCH'], {
          ok: true,
          stderr: 'Preparing worktree (new branch \'BRANCH\')',
        })
      },
      (_phase, _type, content) => { logs.push(content) },
    )
    expect(logs[0]).toBe([
      '[CMD] $ git worktree add /tmp/wt BRANCH',
      'STDERR:',
      'Preparing worktree (new branch \'BRANCH\')',
    ].join('\n'))
  })

  it('shows stdout and stderr as separate command sections', () => {
    const logs: string[] = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'DRAFT',
      () => {
        logCommand('git', ['commit', '-m', 'msg'], { ok: true, stdout: 'abc1234', stderr: '1 file changed' })
      },
      (_phase, _type, content) => { logs.push(content) },
    )
    expect(logs[0]).toBe([
      '[CMD] $ git commit -m msg',
      'STDOUT:',
      'abc1234',
      'STDERR:',
      '1 file changed',
    ].join('\n'))
  })

  it('preserves multi-line stdout as a structured section', () => {
    const logs: string[] = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'DRAFT',
      () => {
        logCommand('git', ['status', '--porcelain'], {
          ok: true,
          stdout: 'M  file1.ts\nA  file2.ts\nD  file3.ts',
        })
      },
      (_phase, _type, content) => { logs.push(content) },
    )
    expect(logs[0]).toBe([
      '[CMD] $ git status --porcelain',
      'STDOUT:',
      'M  file1.ts',
      'A  file2.ts',
      'D  file3.ts',
    ].join('\n'))
  })

  it('normalizes NUL-delimited command output into readable structured lines', () => {
    const logs: string[] = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'DRAFT',
      () => {
        logCommand('git', ['ls-files', '-z'], {
          ok: true,
          stdout: 'src/app.ts\0src/main.ts\0',
        })
      },
      (_phase, _type, content) => { logs.push(content) },
    )
    expect(logs[0]).toBe([
      '[CMD] $ git ls-files -z',
      'STDOUT:',
      'src/app.ts',
      'src/main.ts',
    ].join('\n'))
  })

  it('captures stdin stdout and stderr separately for structured failures', () => {
    const logs: Array<{ type: string; content: string }> = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'CODING',
      () => {
        logCommand('gh', ['api', 'graphql'], {
          ok: false,
          error: 'exit code 1',
          stdin: '{"query":"{ viewer { login } }"}',
          stdout: '{"data":null}',
          stderr: 'token expired',
        })
      },
      (_phase, type, content) => { logs.push({ type, content }) },
    )

    expect(logs).toEqual([
      {
        type: 'error',
        content: [
          '[CMD] $ gh api graphql',
          'STDIN:',
          '{"query":"{ viewer { login } }"}',
          'ERROR:',
          'exit code 1',
          'STDOUT:',
          '{"data":null}',
          'STDERR:',
          'token expired',
        ].join('\n'),
      },
    ])
  })

  it('downgrades missing origin/HEAD probes to info', () => {
    const logs: Array<{ type: string; content: string }> = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'DRAFT',
      () => {
        logCommand('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
          ok: false,
          error: 'exit code 1',
        })
      },
      (_phase, type, content) => { logs.push({ type, content }) },
    )

    expect(logs).toEqual([
      {
        type: 'info',
        content: '[CMD] $ git symbolic-ref --quiet --short refs/remotes/origin/HEAD  →  origin/HEAD not set',
      },
    ])
  })

  it('downgrades missing ref probes to info', () => {
    const logs: Array<{ type: string; content: string }> = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'DRAFT',
      () => {
        logCommand('git', ['show-ref', '--verify', '--quiet', 'refs/heads/LTL-5'], {
          ok: false,
          error: 'exit code 1',
        })
      },
      (_phase, type, content) => { logs.push({ type, content }) },
    )

    expect(logs).toEqual([
      {
        type: 'info',
        content: '[CMD] $ git show-ref --verify --quiet refs/heads/LTL-5  →  ref not found',
      },
    ])
  })

  it('downgrades staged diff probes to info', () => {
    const logs: Array<{ type: string; content: string }> = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'CODING',
      () => {
        logCommand('git', ['-C', '/tmp/worktrees/POBA-1', 'diff', '--cached', '--quiet'], {
          ok: false,
          error: 'exit code 1',
        })
      },
      (_phase, type, content) => { logs.push({ type, content }) },
    )

    expect(logs).toEqual([
      {
        type: 'info',
        content: '[CMD] $ git -C worktrees/POBA-1 diff --cached --quiet  →  staged changes present',
      },
    ])
  })

  it('keeps real staged diff probe failures as errors', () => {
    const logs: Array<{ type: string; content: string }> = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'CODING',
      () => {
        logCommand('git', ['diff', '--cached', '--quiet'], {
          ok: false,
          error: 'fatal: unable to read index',
        })
      },
      (_phase, type, content) => { logs.push({ type, content }) },
    )

    expect(logs).toEqual([
      {
        type: 'error',
        content: '[CMD] $ git diff --cached --quiet  →  error: fatal: unable to read index',
      },
    ])
  })

  it('uses globalThis singleton so separate module loads share the context', () => {
    // The globalThis singleton ensures that even if commandLogger is loaded
    // separately (via require() in production), the AsyncLocalStorage is shared.
    // Verify the store key exists on globalThis after import.
    const storeKey = Symbol.for('looptroop:commandLogStore')
    const g = globalThis as unknown as Record<symbol, unknown>
    expect(g[storeKey]).toBeDefined()

    // Verify logCommand within withCommandLogging still works as before
    const logs: string[] = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'DRAFT',
      () => {
        logCommand('git', ['status'], { ok: true, stdout: 'all clean' })
      },
      (_phase, _type, content) => { logs.push(content) },
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('[CMD]')
    expect(logs[0]).toContain('all clean')
  })

  it('suppresses nested command logs triggered while a command log is being emitted', () => {
    const logs: string[] = []
    withCommandLogging(
      'test-ticket', 'TEST-1', 'CODING',
      () => {
        logCommand('git', ['status'], { ok: true, stdout: 'outer command' })
      },
      (_phase, _type, content) => {
        logs.push(content)
        logCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { ok: true, stdout: 'main' })
      },
    )

    expect(logs).toEqual([
      '[CMD] $ git status  →  outer command',
    ])
  })

  it('dedupes identical command logs within the same async context', () => {
    const logs: string[] = []

    withCommandLogging(
      'test-ticket', 'TEST-1', 'CODING',
      () => {
        logCommand('git', ['status'], { ok: true, stdout: 'all clean' })
        logCommand('git', ['status'], { ok: true, stdout: 'all clean' })
      },
      (_phase, _type, content) => { logs.push(content) },
    )

    expect(logs).toEqual([
      '[CMD] $ git status  →  all clean',
    ])
  })

  it('does not cross-dedupe identical command logs across separate async contexts', () => {
    const logs: string[] = []

    withCommandLogging(
      'test-ticket', 'TEST-1', 'CODING',
      () => {
        logCommand('git', ['status'], { ok: true, stdout: 'all clean' })
      },
      (_phase, _type, content) => { logs.push(content) },
    )

    withCommandLogging(
      'test-ticket', 'TEST-1', 'CODING',
      () => {
        logCommand('git', ['status'], { ok: true, stdout: 'all clean' })
      },
      (_phase, _type, content) => { logs.push(content) },
    )

    expect(logs).toEqual([
      '[CMD] $ git status  →  all clean',
      '[CMD] $ git status  →  all clean',
    ])
  })

  it('truncates output at 2500 characters', () => {
    const logs: string[] = []
    const longOutput = 'x'.repeat(3000)
    withCommandLogging(
      'test-ticket', 'TEST-1', 'DRAFT',
      () => {
        logCommand('git', ['diff'], { ok: true, stdout: longOutput })
      },
      (_phase, _type, content) => { logs.push(content) },
    )
    expect(logs[0]).toContain('… (truncated)')
    // The full content = "[CMD] $ git diff  →  " prefix + truncated output.
    const prefix = '[CMD] $ git diff'
    expect(logs[0]!.length).toBeLessThan(prefix.length + 2500 + 20)
  })
})
