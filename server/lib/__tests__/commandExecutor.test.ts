import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandSpec } from '../../../shared/commandSpec'
import { buildCommandInvocation, executeCommand, resolveCommandCwd } from '../commandExecutor'
import { makeTempDir } from '../../test/tempDir'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function makeRepo(): string {
  const repository = makeTempDir('looptroop-command-executor-')
  tempDirectories.push(repository)
  return repository
}

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
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output ok'],
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

  it('rejects traversal before starting a process', async () => {
    const repository = makeRepo()
    expect(() => resolveCommandCwd(repository, '../outside')).toThrow(/repository root/)
  })
})
