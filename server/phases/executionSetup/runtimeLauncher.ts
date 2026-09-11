import { safeAtomicWriteWithin } from '../../io/atomicWrite'
import type { ExecutionSetupProfile } from './types'

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function quotePowerShell(value: string): string {
  // Encode data separately: smart quotes are also PowerShell string delimiters.
  return `([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf16le').toString('base64')}')))`
}

function privateVariableName(profile: ExecutionSetupProfile, prefix: string): string {
  const names = new Set(Object.keys(profile.runtimeEnvironment.variables).map((key) => key.toLowerCase()))
  while (names.has(prefix)) prefix += '_'
  return prefix
}

function buildPosixLauncher(profile: ExecutionSetupProfile): string {
  const rootVariable = privateVariableName(profile, 'looptroop_repo_root')
  const variables = Object.entries(profile.runtimeEnvironment.variables)
    .map(([key, value]) => `export ${key}=${quotePosix(value)}`)
  const pathEntries = profile.runtimeEnvironment.pathPrepend
    .map((path) => `"$${rootVariable}/"${quotePosix(path)}`)
    .join(':')
  return [
    '#!/bin/sh',
    'set -eu',
    `${rootVariable}=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)`,
    ...variables,
    ...(pathEntries ? [`export PATH=${pathEntries}:"${'$'}PATH"`] : []),
    'exec "$@"',
    '',
  ].join('\n')
}

function buildPowerShellLauncher(profile: ExecutionSetupProfile): string {
  const variables = Object.entries(profile.runtimeEnvironment.variables)
    .map(([key, value]) => `$env:${key} = ${quotePowerShell(value)}`)
  const pathEntries = profile.runtimeEnvironment.pathPrepend
    .map((path) => `(Join-Path $repoRoot ${quotePowerShell(path)})`)
    .join(', ')
  return [
    '$ErrorActionPreference = "Stop"',
    '$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\\..\\..")).Path',
    ...variables,
    ...(pathEntries ? [`$env:PATH = (@(${pathEntries}) -join [IO.Path]::PathSeparator) + [IO.Path]::PathSeparator + $env:PATH`] : []),
    'if ($args.Count -eq 0) { throw "A program is required." }',
    '$program = $args[0]',
    '$programArgs = @(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] })',
    '& $program @programArgs',
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n')
}

function buildCmdLauncher(profile: ExecutionSetupProfile): string {
  const rootVariable = privateVariableName(profile, 'looptroop_repo_root')
  const prependVariable = privateVariableName(profile, 'looptroop_path_prepend')
  // SET receives literal quotes too: escape metacharacters without entering a quoted section.
  const escapeAssignment = (value: string) => value.replace(/%/g, '%%').replace(/["^&|<>()]/g, '^$&')
  const variables = Object.entries(profile.runtimeEnvironment.variables)
    .map(([key, value]) => `set ${key}=${escapeAssignment(value)}`)
  const pathEntries = profile.runtimeEnvironment.pathPrepend
    .map((path) => `%${rootVariable}%\\${path.replace(/\//g, '\\').replace(/%/g, '%%')}`)
    .join(';')
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    ...variables,
    `for %%I in ("%~dp0..\\..\\..") do set "${rootVariable}=%%~fI"`,
    ...(pathEntries ? [
      `set "${prependVariable}=${pathEntries}"`,
      // Delayed substitution does not parse metacharacters inside an existing PATH again.
      'setlocal EnableDelayedExpansion',
      `set "PATH=!${prependVariable}!;!PATH!"`,
      'setlocal DisableDelayedExpansion',
    ] : []),
    '%*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n')
}

export function writeExecutionSetupRuntimeLauncher(input: {
  worktreePath: string
  profile: ExecutionSetupProfile
}): { path: string; kind: 'command-launcher'; purpose: string } {
  const shell = input.profile.hostContext.preferredShell
  for (const [key, value] of Object.entries(input.profile.runtimeEnvironment.variables)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Runtime launcher environment names must be shell identifiers')
    if (value.includes('\0') || (shell === 'cmd' && /[\r\n]/.test(value))) {
      throw new Error('Runtime launcher environment value cannot be represented by the selected shell')
    }
  }
  for (const path of input.profile.runtimeEnvironment.pathPrepend) {
    if (path.includes('\0') || (shell === 'cmd' && /["\r\n]/.test(path))) {
      throw new Error('Runtime launcher PATH entry cannot be represented by the selected shell')
    }
  }
  const relativePath = shell === 'powershell'
    ? '.ticket/runtime/execution-setup/launcher.ps1'
    : shell === 'cmd'
      ? '.ticket/runtime/execution-setup/launcher.cmd'
      : '.ticket/runtime/execution-setup/launcher.sh'
  const content = shell === 'powershell'
    ? buildPowerShellLauncher(input.profile)
    : shell === 'cmd'
      ? buildCmdLauncher(input.profile)
      : buildPosixLauncher(input.profile)
  safeAtomicWriteWithin(input.worktreePath, relativePath, content, shell === 'posix' ? { mode: 0o700 } : undefined)
  return {
    path: relativePath,
    kind: 'command-launcher',
    purpose: 'Applies the approved runtime environment to coding-agent tool commands on this host.',
  }
}
