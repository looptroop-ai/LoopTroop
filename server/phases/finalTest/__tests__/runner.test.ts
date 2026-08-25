import { describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { executeFinalTestCommands } from '../runner'
import { makeTempDir, removeTempDir } from '../../../test/tempDir'
import type { CommandSpec } from '@shared/commandSpec'

function nodeCommand(script: string, overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    mode: 'process',
    program: process.execPath,
    args: ['-e', script],
    cwd: '.',
    env: {},
    ...overrides,
  } as CommandSpec
}

describe('executeFinalTestCommands', () => {
  it('caps captured command output', async () => {
    const report = await executeFinalTestCommands({
      commands: [nodeCommand("process.stdout.write('x'.repeat(1000100))")],
      cwd: process.cwd(),
      plannedBy: 'test-vendor/test-model',
      modelOutput: '<FINAL_TEST_COMMANDS>{"commands":[]}</FINAL_TEST_COMMANDS>',
    })

    expect(report.commands[0]?.stdout.length).toBeLessThan(1_001_000)
    expect(report.commands[0]?.stdout).toContain('LoopTroop truncated command output')
  })

  it('applies the phase timeout when a command has no explicit timeout', async () => {
    const report = await executeFinalTestCommands({
      commands: [nodeCommand("setTimeout(() => console.log('late'), 200)")],
      cwd: process.cwd(),
      timeoutMs: 25,
      plannedBy: 'test-vendor/test-model',
      modelOutput: '<FINAL_TEST_COMMANDS>{"commands":[]}</FINAL_TEST_COMMANDS>',
    })

    expect(report.passed).toBe(false)
    expect(report.commands[0]).toMatchObject({
      command: expect.objectContaining({ mode: 'process', program: process.execPath }),
      displayCommand: expect.stringContaining(process.execPath),
      timedOut: true,
    })
    expect(report.errors[0]).toContain('Command timed out')
  })

  it('preserves process arguments, repository-relative cwd, and command environment', async () => {
    const worktree = makeTempDir('looptroop-final-test-runner-')
    try {
      mkdirSync(join(worktree, 'folder with spaces'))
      const report = await executeFinalTestCommands({
        commands: [nodeCommand(
          "console.log(JSON.stringify({cwd:process.cwd(),arg:process.argv[1],env:process.env.LOOP_VALUE}))",
          { args: ['-e', "console.log(JSON.stringify({cwd:process.cwd(),arg:process.argv[1],env:process.env.LOOP_VALUE}))", 'héllo world'], cwd: 'folder with spaces', env: { LOOP_VALUE: '✓' } },
        )],
        cwd: worktree,
        plannedBy: 'test-vendor/test-model',
        modelOutput: '<FINAL_TEST_COMMANDS>{"commands":[]}</FINAL_TEST_COMMANDS>',
      })

      expect(report.passed).toBe(true)
      expect(report.commands[0]?.stdout).toContain('"arg":"héllo world"')
      expect(report.commands[0]?.stdout).toContain('"env":"✓"')
      expect(report.commands[0]?.stdout).toContain('folder with spaces')
    } finally {
      removeTempDir(worktree)
    }
  })

  it('applies the structured runtime environment directly', async () => {
    const worktree = makeTempDir('looptroop-final-test-runtime-')
    try {
      mkdirSync(join(worktree, 'local-bin'))
      const report = await executeFinalTestCommands({
        commands: [nodeCommand("console.log(process.env.LOOP_RUNTIME); console.log(process.env.PATH)")],
        cwd: worktree,
        plannedBy: 'test-vendor/test-model',
        modelOutput: '<FINAL_TEST_COMMANDS>{"commands":[]}</FINAL_TEST_COMMANDS>',
        runtimeEnvironment: {
          pathPrepend: ['local-bin'],
          variables: { LOOP_RUNTIME: 'ready' },
        },
      })

      expect(report.passed).toBe(true)
      expect(report.commands[0]?.stdout).toContain('ready')
      expect(report.commands[0]?.stdout).toContain(join(worktree, 'local-bin'))
    } finally {
      removeTempDir(worktree)
    }
  })

  it('stops after the first failed structured command', async () => {
    const report = await executeFinalTestCommands({
      commands: [
        nodeCommand('process.exit(7)'),
        nodeCommand("console.log('must not run')"),
      ],
      cwd: process.cwd(),
      plannedBy: 'test-vendor/test-model',
      modelOutput: '<FINAL_TEST_COMMANDS>{"commands":[]}</FINAL_TEST_COMMANDS>',
    })

    expect(report.passed).toBe(false)
    expect(report.commands).toHaveLength(1)
    expect(report.errors[0]).toContain('Command failed (7)')
  })
})
