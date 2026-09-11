import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeExecutionSetupRuntimeLauncher } from '../runtimeLauncher'
import type { ExecutionSetupProfile } from '../types'
import { makeTempDir, removeTempDir } from '../../../test/tempDir'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) removeTempDir(root) })

function profile(preferredShell: 'posix' | 'cmd' | 'powershell'): ExecutionSetupProfile {
  return {
    schemaVersion: 1,
    ticketId: 'T-1',
    artifact: 'execution_setup_profile',
    status: 'ready',
    hostContext: {
      platform: preferredShell === 'posix' ? 'linux' : 'windows',
      environment: 'native',
      arch: 'x64',
      availableShells: [preferredShell],
      preferredShell,
    },
    summary: 'ready',
    tempRoots: ['.ticket/runtime/execution-setup'],
    workspaceInputs: [],
    runtimeEnvironment: {
      pathPrepend: ['.ticket/runtime/execution-setup/tool-cache/bin'],
      variables: { TOOL_MODE: 'ticket value' },
    },
    bootstrapCommands: [],
    toolingProbeCommands: [],
    workspaceProbes: [],
    gitHooks: { policy: 'validate_advisory', detected: [], validationCommands: [] },
    reusableArtifacts: [],
    projectCommands: { prepare: [], testFull: [], lintFull: [], typecheckFull: [] },
    qualityGatePolicy: { tests: '', lint: '', typecheck: '', fullProjectFallback: '' },
    cautions: [],
  }
}

describe('execution setup runtime launcher', () => {
  it.each(['posix', 'powershell', 'cmd'] as const)('rejects executable environment names before writing a %s launcher', (shell) => {
    const worktreePath = makeTempDir('looptroop-launcher-key-')
    roots.push(worktreePath)
    const setup = profile(shell)
    setup.runtimeEnvironment.variables = { 'FOO; printf injected; #': 'value' }
    expect(() => writeExecutionSetupRuntimeLauncher({ worktreePath, profile: setup })).toThrow('shell identifiers')
    expect(readdirSync(worktreePath)).toEqual([])
  })

  it.each(['\n', '\r', '\0'])('rejects unrepresentable cmd environment values (%j)', (character) => {
    const worktreePath = makeTempDir('looptroop-launcher-value-')
    roots.push(worktreePath)
    const setup = profile('cmd')
    setup.runtimeEnvironment.variables.TOOL_MODE = `value${character}echo injected`
    expect(() => writeExecutionSetupRuntimeLauncher({ worktreePath, profile: setup })).toThrow('cannot be represented')
    expect(readdirSync(worktreePath)).toEqual([])
  })

  it.each(['"', '\n', '\r', '\0'])('rejects unrepresentable cmd PATH entries (%j)', (character) => {
    const worktreePath = makeTempDir('looptroop-launcher-path-')
    roots.push(worktreePath)
    const setup = profile('cmd')
    setup.runtimeEnvironment.pathPrepend = [`tools/${character}& echo injected`]
    expect(() => writeExecutionSetupRuntimeLauncher({ worktreePath, profile: setup })).toThrow('cannot be represented')
    expect(readdirSync(worktreePath)).toEqual([])
  })

  it.each(process.platform === 'win32' ? ['cmd', 'powershell'] as const : ['posix'] as const)(
    'passes shell-sensitive environment values and PATH entries literally through native %s', (shell) => {
      const worktreePath = makeTempDir('looptroop-launcher-literals-')
      roots.push(worktreePath)
      const setup = profile(shell)
      const value = shell === 'powershell'
        ? "value’; New-Item injected; #‘ “literal”"
        : `literal ' " & | < > ^ %PATH% !PATH! $(touch injected) \`touch injected\``
      const pathEntry = shell === 'posix'
        ? `tools/$(touch injected)-'"!%PATH%`
        : shell === 'powershell' ? "tools/’); New-Item injected; #‘" : 'tools/%PATH% !PATH! & (literal)'
      setup.runtimeEnvironment.variables = {
        TOOL_MODE: value,
        repo_root: 'custom root',
        looptroop_repo_root: 'custom private root',
        looptroop_path_prepend: 'custom private path',
      }
      setup.runtimeEnvironment.pathPrepend = [pathEntry]
      const artifact = writeExecutionSetupRuntimeLauncher({ worktreePath, profile: setup })
      const launcherPath = join(worktreePath, artifact.path)
      const readerPath = join(worktreePath, 'read-env.cjs')
      const environmentKeys = JSON.stringify([...Object.keys(setup.runtimeEnvironment.variables), 'PATH'])
      writeFileSync(readerPath, `process.stdout.write(Buffer.from(JSON.stringify(Object.fromEntries(${environmentKeys}.map(key => [key, process.env[key]])))).toString('base64'))`)
      const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
      const inheritedPath = `${process.env[pathKey] ?? ''}${shell === 'cmd' ? ';" & echo injected>injected & rem "!PATH!' : ''}`
      // Node deduplicates Windows environment keys case-insensitively; keep only our PATH.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
      const options = {
        cwd: worktreePath,
        env: {
          ...env,
          PATH: inheritedPath,
          LOOPTROOP_TEST_LAUNCHER: launcherPath,
          LOOPTROOP_TEST_NODE: process.execPath,
        },
        encoding: 'utf8' as const,
        timeout: 30_000,
      }
      // Shell source stays fixed; paths are data, even if Node or the temp root has spaces.
      const result = shell === 'cmd'
        ? spawnSync('cmd.exe', ['/d', '/v:on', '/s', '/c', '""%LOOPTROOP_TEST_LAUNCHER%" "%LOOPTROOP_TEST_NODE%" read-env.cjs"'], { ...options, windowsVerbatimArguments: true })
        : shell === 'powershell'
          ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '& $env:LOOPTROOP_TEST_LAUNCHER $env:LOOPTROOP_TEST_NODE read-env.cjs'], options)
          : spawnSync('sh', ['-c', 'exec "$LOOPTROOP_TEST_LAUNCHER" "$LOOPTROOP_TEST_NODE" read-env.cjs'], options)
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      const actual = JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8'))
      expect(actual).toMatchObject(setup.runtimeEnvironment.variables)
      expect(actual.PATH).toBe(`${join(worktreePath, pathEntry)}${delimiter}${inheritedPath}`)
      expect(existsSync(join(worktreePath, 'injected'))).toBe(false)
    },
  )

  it('does not write a launcher through an escaping ticket directory', () => {
    const root = makeTempDir('looptroop-launcher-link-')
    roots.push(root)
    const worktreePath = join(root, 'worktree')
    const outside = join(root, 'outside')
    mkdirSync(worktreePath)
    mkdirSync(outside)
    symlinkSync(outside, join(worktreePath, '.ticket'), 'junction')
    expect(() => writeExecutionSetupRuntimeLauncher({ worktreePath, profile: profile('posix') })).toThrow()
    expect(readdirSync(outside)).toEqual([])
  })
  it.each([
    ['posix', 'launcher.sh', 'exec "$@"'],
    ['powershell', 'launcher.ps1', '& $program @programArgs'],
    ['cmd', 'launcher.cmd', '%*'],
  ] as const)('writes a host-specific %s launcher', (shell, filename, invocation) => {
    const worktreePath = makeTempDir('looptroop-launcher-')
    roots.push(worktreePath)
    const artifact = writeExecutionSetupRuntimeLauncher({ worktreePath, profile: profile(shell) })

    expect(artifact.path).toBe(`.ticket/runtime/execution-setup/${filename}`)
    const content = readFileSync(join(worktreePath, artifact.path), 'utf8')
    expect(content).toContain(invocation)
    expect(content).toContain('TOOL_MODE')
    expect(content).toContain(shell === 'powershell'
      ? Buffer.from('.ticket/runtime/execution-setup/tool-cache/bin', 'utf16le').toString('base64')
      : 'tool-cache')
  })
})
