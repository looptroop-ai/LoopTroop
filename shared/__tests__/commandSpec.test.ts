import { describe, expect, it } from 'vitest'
import {
  commandSpecSchema,
  isRepoRelativePath,
  normalizeCommandSpec,
  renderCommandSpec,
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
