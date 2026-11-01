import { describe, expect, it } from 'vitest'
import {
  commandSpecSchema,
  isRepoRelativePath,
  normalizeCommandSpec,
  renderCommandSpec,
  repairCommandSpecShape,
  runtimeEnvironmentSchema,
} from '../commandSpec'
import type { HostContext } from '../hostContext'

describe('commandSpecSchema', () => {
  it('applies safe defaults to direct process commands', () => {
    expect(commandSpecSchema.parse({
      mode: 'process',
      program: 'tool',
      args: ['path with spaces', '✓'],
    })).toEqual({
      mode: 'process',
      program: 'tool',
      args: ['path with spaces', '✓'],
      cwd: '.',
      env: {},
    })
  })

  it.each(['/tmp/project', '../other', 'C:\\project', '\\\\server\\share'])(
    'rejects working directories outside the repository: %s',
    (cwd) => {
      expect(commandSpecSchema.safeParse({
        mode: 'process',
        program: 'tool',
        cwd,
      }).success).toBe(false)
    },
  )

  it('accepts nested repository-relative paths in either separator style', () => {
    expect(isRepoRelativePath('packages/app')).toBe(true)
    expect(isRepoRelativePath('packages\\app')).toBe(true)
  })
})

describe('normalizeCommandSpec', () => {
  const host: HostContext = {
    platform: 'windows',
    environment: 'native',
    arch: 'x64',
    availableShells: ['cmd', 'powershell'],
    preferredShell: 'powershell',
  }

  it('preserves valid structured commands', () => {
    const command = commandSpecSchema.parse({ mode: 'process', program: 'tool' })
    expect(normalizeCommandSpec(command, host)).toEqual({ command, repaired: false })
  })

  it('repairs legacy text without changing it', () => {
    const script = 'tool test && echo "same text"'
    const result = normalizeCommandSpec(script, host)
    expect(result.command).toEqual({
      mode: 'shell',
      shell: 'powershell',
      script,
      cwd: '.',
      env: {},
    })
    expect(result.repaired).toBe(true)
    expect(result.warning).toContain('current host')
  })

  it('rejects empty legacy command text', () => {
    expect(() => normalizeCommandSpec('  ', host)).toThrow()
  })

  it('relabels a shell-mode command written with program and args as a process command', () => {
    const result = normalizeCommandSpec({ mode: 'shell', program: 'bash', args: ['-lc', 'npm test'] }, host)
    expect(result.command).toEqual({ mode: 'process', program: 'bash', args: ['-lc', 'npm test'], cwd: '.', env: {} })
    expect(result.repaired).toBe(true)
    expect(result.warning).toContain('mode "process"')
  })

  it.each([
    ['it also has a script', { mode: 'shell', program: 'bash', script: 'npm test' }],
    ['it also has a shell', { mode: 'shell', shell: 'posix', program: 'bash' }],
    ['the program is blank', { mode: 'shell', program: '  ', args: [] }],
    ['an argument is not text', { mode: 'shell', program: 'bash', args: ['-c', 1] }],
    ['the program is a whole command line', { mode: 'shell', program: 'npm run test', args: [] }],
  ])('does not relabel a shell-mode command when %s', (_label, command) => {
    expect(() => normalizeCommandSpec(command, host)).toThrow()
  })

  describe('absolute working directories', () => {
    const repoRoot = '/root/repo/.looptroop/worktrees/T-1'
    const command = (cwd: string) => ({ mode: 'process', program: 'npm', args: ['test'], cwd })

    it.each([
      [repoRoot, '.'],
      [`${repoRoot}/`, '.'],
      [`${repoRoot}/packages/app`, 'packages/app'],
      [`${repoRoot}//packages//app/`, 'packages/app'],
      [`${repoRoot}/./packages/./app`, 'packages/app'],
    ])('rewrites %s inside the repository root as %s', (cwd, expected) => {
      const result = normalizeCommandSpec(command(cwd), host, { repoRoot })
      expect(result.command.cwd).toBe(expected)
      expect(result.repaired).toBe(true)
      expect(result.warning).toContain(JSON.stringify(cwd))
    })

    it.each([
      '/root/repo',
      `${repoRoot}-other`,
      `${repoRoot}/../T-2`,
      `${repoRoot}/src/../../T-2`,
      '/../../root/repo',
      '/tmp/elsewhere',
    ])('still rejects %s, which is outside the repository root', (cwd) => {
      expect(() => normalizeCommandSpec(command(cwd), host, { repoRoot })).toThrow()
    })

    // After a symbolic link, `..` names the link target's parent, so text
    // cannot tell where these point; they stay rejected as before.
    it.each([
      `${repoRoot}/packages/../app`,
      '/root/repo/.looptroop/worktrees/T-2/../T-1/src',
      '\\\\server\\share\\repo\\..\\..\\share\\repo\\src',
    ])('does not rewrite %s, which contains a ".." segment', (cwd) => {
      const root = cwd.startsWith('\\') ? '\\\\server\\share\\repo' : repoRoot
      // Checked at the repair itself: validation would also catch a leftover `..`.
      expect(repairCommandSpecShape(command(cwd), { repoRoot: root })).toEqual({ value: command(cwd), warnings: [] })
      expect(() => normalizeCommandSpec(command(cwd), host, { repoRoot: root })).toThrow()
    })

    it('still rejects an absolute directory when no repository root is known', () => {
      expect(() => normalizeCommandSpec(command(repoRoot), host)).toThrow()
    })

    it('matches Windows roots without regard to case or separator', () => {
      const result = normalizeCommandSpec(command('c:/Work/Repo/src'), host, { repoRoot: 'C:\\work\\repo' })
      expect(result.command.cwd).toBe('src')
    })

    it('keeps case on POSIX roots', () => {
      expect(() => normalizeCommandSpec(command('/Root/Repo/.looptroop/worktrees/T-1'), host, { repoRoot })).toThrow()
    })

    it('matches UNC roots without regard to case or separator', () => {
      const result = normalizeCommandSpec(command('//SERVER/share/repo/src'), host, { repoRoot: '\\\\server\\share\\repo' })
      expect(result.command.cwd).toBe('src')
    })

    it('keeps a backslash inside a POSIX directory name', () => {
      const result = normalizeCommandSpec(command(`${repoRoot}/pkg\\one`), host, { repoRoot })
      expect(result.command.cwd).toBe('pkg\\one')
    })
  })
})

describe('runtimeEnvironmentSchema', () => {
  it('uses structured PATH additions and variables', () => {
    expect(runtimeEnvironmentSchema.parse({
      pathPrepend: ['.ticket/runtime/tools'],
      variables: { TOOL_HOME: '.ticket/runtime/tool-home' },
    })).toEqual({
      pathPrepend: ['.ticket/runtime/tools'],
      variables: { TOOL_HOME: '.ticket/runtime/tool-home' },
    })
  })
})

describe('renderCommandSpec', () => {
  const command = commandSpecSchema.parse({
    mode: 'process',
    program: 'test tool',
    args: ['plain', 'two words', "it's"],
  })

  it('renders direct commands for POSIX display', () => {
    expect(renderCommandSpec(command, 'posix')).toBe("'test tool' plain 'two words' 'it'\\''s'")
  })

  it('renders direct commands for PowerShell display', () => {
    expect(renderCommandSpec(command, 'powershell')).toBe("'test tool' plain 'two words' 'it''s'")
  })

  it('does not reinterpret an explicit shell script', () => {
    expect(renderCommandSpec(commandSpecSchema.parse({
      mode: 'shell',
      shell: 'cmd',
      script: 'echo one && echo two',
    }))).toBe('echo one && echo two')
  })
})
