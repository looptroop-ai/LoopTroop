import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandSpec } from '../../../shared/commandSpec'
import { buildCommandInvocation, executeCommand, resolveCommandCwd, resolveCommandProgram } from '../commandExecutor'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import { FORCE_KILL_DELAY_MS, PROCESS_ABANDON_GRACE_MS } from '../constants'

const tempDirectories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const directory of tempDirectories.splice(0)) {
    removeTempDir(directory)
  }
})

/**
 * A child that never exits and never closes its pipes.
 *
 * This is what a process tree that survives its own kill looks like from here:
 * `taskkill` reports nothing back, the grandchild keeps the pipes open, and
 * `close` never arrives.
 */
function makeUnkillableChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => true,
    unref: vi.fn(),
  })
  return child
}

function makeRepo(): string {
  const repository = makeTempDir('looptroop-command-executor-')
  tempDirectories.push(repository)
  return repository
}

describe('resolveCommandProgram', () => {
  function makeExecutable(directory: string, name: string): string {
    mkdirSync(directory, { recursive: true })
    const path = join(directory, name)
    writeFileSync(path, '#!/bin/sh\nexit 0\n')
    chmodSync(path, 0o755)
    return path
  }

  it.runIf(process.platform !== 'win32')('resolves a bare name against the child\'s PATH, not the daemon\'s', () => {
    // `pathPrepend` puts a project's own `node_modules/.bin` on the child's
    // PATH. Resolving against `process.env` would refuse every project-local
    // tool while the plan claims to support them.
    const repository = makeRepo()
    const tool = makeExecutable(join(repository, 'node_modules', '.bin'), 'project-linter')

    expect(resolveCommandProgram('project-linter', {
      env: { PATH: join(repository, 'node_modules', '.bin') },
      cwd: repository,
      repoRoot: repository,
    })).toEqual({ path: tool })
  })

  it.runIf(process.platform !== 'win32')('resolves a relative program against the command directory', () => {
    const repository = makeRepo()
    const tool = makeExecutable(join(repository, 'tools'), 'check')

    expect(resolveCommandProgram('./check', {
      env: { PATH: '' },
      cwd: join(repository, 'tools'),
      repoRoot: repository,
    })).toEqual({ path: tool })
  })

  it('refuses a relative program that climbs out of the repository', () => {
    // The containment check is the point of the path-separator branch, not a
    // formality: without it, a program is resolved against whatever directory
    // happens to be current and the exception becomes an injection route.
    const repository = makeRepo()

    expect(resolveCommandProgram('../../usr/bin/whatever', {
      env: { PATH: '' },
      cwd: repository,
      repoRoot: repository,
    }).reason).toContain('must stay within the repository root')
  })

  it('accepts an absolute program that names an executable file', () => {
    // A plan naming `/usr/bin/make` is naming a tool, not escaping a root, and
    // `process.execPath` reaches here from the test runner itself.
    expect(resolveCommandProgram(process.execPath, {
      env: { PATH: '' },
      cwd: makeRepo(),
      repoRoot: makeRepo(),
    }).path).toBeDefined()
  })

  it('refuses an absolute path that is not an executable file', () => {
    const repository = makeRepo()

    expect(resolveCommandProgram(join(repository, 'nothing-here'), {
      env: { PATH: '' },
      cwd: repository,
      repoRoot: repository,
    }).reason).toContain('is not an executable file')
  })
})

describe('buildCommandInvocation', () => {
  it('does not invoke a shell for direct process commands', () => {
    expect(buildCommandInvocation({
      mode: 'process',
      program: 'node',
      args: ['script.js', 'two words'],
      cwd: '.',
      env: {},
    })).toEqual({
      bin: 'node',
      args: ['script.js', 'two words'],
    })
  })

  it.each([
    [
      { mode: 'shell', shell: 'posix', script: 'echo ok', cwd: '.', env: {} } satisfies CommandSpec,
      { bin: '/custom/sh', args: ['-c', 'echo ok'] },
    ],
    [
      { mode: 'shell', shell: 'cmd', script: 'echo ok', cwd: '.', env: {} } satisfies CommandSpec,
      { bin: 'custom-cmd.exe', args: ['/d', '/s', '/c', 'echo ok'] },
    ],
    [
      { mode: 'shell', shell: 'powershell', script: 'Write-Output ok', cwd: '.', env: {} } satisfies CommandSpec,
      {
        bin: 'custom-pwsh',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Write-Output ok\nif (Test-Path -LiteralPath variable:\\LASTEXITCODE) { exit $LASTEXITCODE }',
        ],
      },
    ],
  ])('builds an explicit shell invocation', (command, expected) => {
    expect(buildCommandInvocation(command, {
      shellBinaries: {
        posix: '/custom/sh',
        cmd: 'custom-cmd.exe',
        powershell: 'custom-pwsh',
      },
    })).toEqual(expected)
  })

  it.runIf(process.platform === 'win32')('propagates a native program exit code through PowerShell', async () => {
    const repository = makeRepo()
    const result = await executeCommand({
      mode: 'shell',
      shell: 'powershell',
      script: 'node -e "process.exit(4)"',
      cwd: '.',
      env: {},
    }, { repoRoot: repository })
    expect(result.exitCode).toBe(4)
  })
})

describe('executeCommand', () => {
  it.runIf(process.platform !== 'win32')('preserves arguments, cwd, environment, spaces, and Unicode', async () => {
    const repository = makeRepo()
    mkdirSync(join(repository, 'nested folder'))
    const result = await executeCommand({
      mode: 'process',
      program: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),value:process.env.SAMPLE_VALUE,runtime:process.env.RUNTIME_VALUE,path:process.env.PATH}))',
        'two words',
        '✓',
      ],
      cwd: 'nested folder',
      env: { SAMPLE_VALUE: 'env ✓' },
    }, {
      repoRoot: repository,
      env: { PATH: '/base/path' },
      runtimeEnvironment: {
        pathPrepend: ['runtime tools'],
        variables: { RUNTIME_VALUE: 'runtime ✓', SAMPLE_VALUE: 'overridden' },
      },
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      argv: ['two words', '✓'],
      cwd: join(repository, 'nested folder'),
      value: 'env ✓',
      runtime: 'runtime ✓',
      path: `${join(repository, 'runtime tools')}:/base/path`,
    })
  })

  it.runIf(process.platform !== 'win32')('runs an explicit POSIX shell command', async () => {
    const result = await executeCommand({
      mode: 'shell',
      shell: 'posix',
      script: 'printf shell',
      cwd: '.',
      env: {},
    }, { repoRoot: makeRepo() })

    expect(result).toMatchObject({ exitCode: 0, stdout: 'shell', bin: '/bin/sh' })
  })

  it.runIf(process.platform !== 'win32')('enforces a bounded command timeout', async () => {
    const result = await executeCommand({
      mode: 'process',
      program: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      cwd: '.',
      env: {},
      timeoutMs: 100,
    }, { repoRoot: makeRepo() })

    expect(result.timedOut).toBe(true)
    expect(result.signal).not.toBeNull()
  })

  it('reports a timeout even when the process tree will not die', async () => {
    // Killing a tree is a request, not a guarantee — on Windows it is delegated
    // to `taskkill`, whose failure is invisible here. Waiting for a `close` that
    // never comes hung the caller rather than the command, which is how one
    // 200 ms hook-validation command sat unresolved for its caller's whole
    // deadline.
    vi.useFakeTimers()
    const child = makeUnkillableChild()

    const pending = executeCommand({
      mode: 'process',
      program: 'irrelevant',
      args: [],
      cwd: '.',
      env: {},
      timeoutMs: 200,
    }, {
      repoRoot: makeRepo(),
      // Windows so the kill goes through `taskkill`, which is absent here and
      // whose spawn error the terminator already swallows.
      platform: 'windows',
      // The overload set on `spawn` cannot be satisfied by a stub, and the
      // executor only ever uses the pipes, the pid and `unref`.
      spawnProcess: (() => child) as unknown as typeof spawn,
      // This case is about the timeout, not about the program: resolving
      // `irrelevant` for real would end the run before a child was ever made.
      resolveProgram: () => ({ path: 'irrelevant' }),
    })

    await vi.advanceTimersByTimeAsync(200 + FORCE_KILL_DELAY_MS + PROCESS_ABANDON_GRACE_MS + 1)
    const result = await pending

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe('SIGKILL')
  })

  it('reports an unresolvable program as a run that never started', async () => {
    // Byte-for-byte the shape a spawn error already produced for a missing
    // tool: no exit code, the reason on stderr. Nothing that used to degrade
    // becomes a throw.
    const result = await executeCommand({
      mode: 'process',
      program: 'definitely-not-installed',
      args: [],
      cwd: '.',
      env: {},
    }, { repoRoot: makeRepo(), env: { PATH: makeRepo() } })

    expect(result.exitCode).toBeNull()
    expect(result.signal).toBeNull()
    expect(result.stderr).toContain('was not found in any trusted directory')
  })

  it('rejects traversal before starting a process', async () => {
    const repository = makeRepo()
    expect(() => resolveCommandCwd(repository, '../outside')).toThrow(/repository root/)
  })
})
