import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ExecutionSetupProfile } from './types'

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function buildPosixLauncher(profile: ExecutionSetupProfile): string {
  const variables = Object.entries(profile.runtimeEnvironment.variables)
    .map(([key, value]) => `export ${key}=${quotePosix(value)}`)
  const pathEntries = profile.runtimeEnvironment.pathPrepend
    .map((path) => `"${'$'}repo_root/${path}"`)
    .join(':')
  return [
    '#!/bin/sh',
    'set -eu',
    'launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'repo_root=$(CDPATH= cd -- "$launcher_dir/../../.." && pwd)',
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
    '$programArgs = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }',
    '& $program @programArgs',
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n')
}

function buildCmdLauncher(profile: ExecutionSetupProfile): string {
  const variables = Object.entries(profile.runtimeEnvironment.variables)
    .map(([key, value]) => `set "${key}=${value.replace(/%/g, '%%').replace(/"/g, '""')}"`)
  const pathEntries = profile.runtimeEnvironment.pathPrepend
    .map((path) => `%repo_root%\\${path.replace(/\//g, '\\')}`)
    .join(';')
  return [
    '@echo off',
    'setlocal',
    'for %%I in ("%~dp0..\\..\\..") do set "repo_root=%%~fI"',
    ...variables,
    ...(pathEntries ? [`set "PATH=${pathEntries};%PATH%"`] : []),
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
  const relativePath = shell === 'powershell'
    ? '.ticket/runtime/execution-setup/launcher.ps1'
    : shell === 'cmd'
      ? '.ticket/runtime/execution-setup/launcher.cmd'
      : '.ticket/runtime/execution-setup/launcher.sh'
  const absolutePath = resolve(input.worktreePath, relativePath)
  mkdirSync(dirname(absolutePath), { recursive: true })
  const content = shell === 'powershell'
    ? buildPowerShellLauncher(input.profile)
    : shell === 'cmd'
      ? buildCmdLauncher(input.profile)
      : buildPosixLauncher(input.profile)
  writeFileSync(absolutePath, content, 'utf8')
  if (shell === 'posix') chmodSync(absolutePath, 0o700)
  return {
    path: relativePath,
    kind: 'command-launcher',
    purpose: 'Applies the approved runtime environment to coding-agent tool commands on this host.',
  }
}
