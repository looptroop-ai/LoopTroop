import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import { getCommandShell, runShellCommand } from '../shellCommand'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    removeTempDir(directory)
  }
})

function makeWorktree(): string {
  const worktree = makeTempDir('looptroop-shell-command-')
  tempDirectories.push(worktree)
  return worktree
}

describe('runShellCommand', () => {
  it.runIf(process.platform !== 'win32')('preserves a wrapper-prepared PATH with a non-login shell', async () => {
    const worktree = makeWorktree()
    const runtimeDirectory = join(worktree, '.ticket', 'runtime', 'execution-setup')
    const toolDirectory = join(runtimeDirectory, 'tools')
    mkdirSync(toolDirectory, { recursive: true })
    const toolPath = join(toolDirectory, 'private-tool')
    writeFileSync(toolPath, '#!/bin/sh\nprintf prepared\n')
    chmodSync(toolPath, 0o755)
    const wrapperPath = join(runtimeDirectory, 'run')
    writeFileSync(wrapperPath, `#!/bin/sh\nexport PATH=${JSON.stringify(toolDirectory)}:$PATH\nexec "$@"\n`)
    chmodSync(wrapperPath, 0o755)

    const result = await runShellCommand({
      command: 'private-tool',
      cwd: worktree,
      commandWrapper: '.ticket/runtime/execution-setup/run',
    })

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'prepared',
      setupWrapperApplied: true,
      args: [getCommandShell().bin, '-c', 'private-tool'],
    })
    expect(result.effectiveCommand).toContain("'-c'")
    expect(result.effectiveCommand).not.toContain("'-lc'")
  })

  it.runIf(process.platform !== 'win32')('retains login-shell execution when no wrapper is applied', async () => {
    const result = await runShellCommand({
      command: 'printf plain',
      cwd: process.cwd(),
    })

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'plain',
      setupWrapperApplied: false,
      args: ['-lc', 'printf plain'],
    })
    expect(result.effectiveCommand).toBeUndefined()
  })
})
