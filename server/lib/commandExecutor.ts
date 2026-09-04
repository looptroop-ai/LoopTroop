import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { CommandSpec, RuntimeEnvironment } from '../../shared/commandSpec'
import type { CommandShellKind, HostPlatform } from '../../shared/hostContext'
import { createBoundedOutputCollector } from './commandOutput'
import { FORCE_KILL_DELAY_MS, PROCESS_ABANDON_GRACE_MS } from './constants'
import { terminateProcessTreeWithEscalation } from './processTree'

// Guarded with Test-Path so an unset $LASTEXITCODE cannot turn a clean cmdlet
// run into a strict-mode failure. Matches the launcher script in
// phases/executionSetup/runtimeLauncher.ts.
const POWERSHELL_EXIT_CODE_SUFFIX =
  '\nif (Test-Path -LiteralPath variable:\\LASTEXITCODE) { exit $LASTEXITCODE }'

export interface CommandInvocation {
  bin: string
  args: string[]
}

export interface CommandExecutionResult extends CommandInvocation {
  command: CommandSpec
  cwd: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export interface CommandExecutorOptions {
  platform?: HostPlatform
  env?: NodeJS.ProcessEnv
  shellBinaries?: Partial<Record<CommandShellKind, string>>
  pathExists?: (path: string) => boolean
  spawnProcess?: typeof spawn
  runtimeEnvironment?: RuntimeEnvironment
}

export function resolveCommandCwd(repoRoot: string, cwd: string): string {
  if (isAbsolute(cwd) || /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.replace(/\\/g, '/').split('/').includes('..')) {
    throw new Error('Command working directory must stay within the repository root')
  }
  const root = resolve(repoRoot)
  const resolved = resolve(root, cwd)
  const relativePath = relative(root, resolved)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Command working directory must stay within the repository root')
  }
  return resolved
}

function resolvePowerShell(
  pathExists: (path: string) => boolean,
  configured?: string,
): string {
  if (configured) return configured
  return pathExists('/usr/bin/pwsh') ? '/usr/bin/pwsh' : 'powershell.exe'
}

export function buildCommandInvocation(
  command: CommandSpec,
  options: CommandExecutorOptions = {},
): CommandInvocation {
  if (command.mode === 'process') {
    return { bin: command.program, args: command.args }
  }

  const pathExists = options.pathExists ?? existsSync
  if (command.shell === 'cmd') {
    return {
      bin: options.shellBinaries?.cmd ?? options.env?.ComSpec ?? process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', command.script],
    }
  }
  if (command.shell === 'powershell') {
    return {
      bin: resolvePowerShell(pathExists, options.shellBinaries?.powershell),
      // Windows PowerShell 5.1 reports its own status from -Command, not the
      // status of the last native program, so `node -e "process.exit(4)"`
      // arrives as 1. Re-exporting $LASTEXITCODE restores the real code. It is
      // $null when no native program ran, and `exit $null` is exit 0, so
      // pure-cmdlet scripts keep their previous behaviour.
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${command.script}${POWERSHELL_EXIT_CODE_SUFFIX}`,
      ],
    }
  }
  return {
    bin: options.shellBinaries?.posix ?? (pathExists('/bin/sh') ? '/bin/sh' : 'sh'),
    args: ['-c', command.script],
  }
}

export async function executeCommand(
  command: CommandSpec,
  input: CommandExecutorOptions & { repoRoot: string },
): Promise<CommandExecutionResult> {
  const startedAt = Date.now()
  const cwd = resolveCommandCwd(input.repoRoot, command.cwd)
  const invocation = buildCommandInvocation(command, input)
  const platform = input.platform ?? (
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  )
  const spawnProcess = input.spawnProcess ?? spawn
  const baseEnvironment = input.env ?? process.env
  const pathSeparator = platform === 'windows' ? ';' : ':'
  const pathPrepend = input.runtimeEnvironment?.pathPrepend.map((path) =>
    resolveCommandCwd(input.repoRoot, path),
  ) ?? []
  const environment = {
    ...baseEnvironment,
    ...input.runtimeEnvironment?.variables,
    ...command.env,
  }
  if (pathPrepend.length > 0) {
    environment.PATH = [
      ...pathPrepend,
      baseEnvironment.PATH ?? baseEnvironment.Path ?? '',
    ].filter(Boolean).join(pathSeparator)
  }

  return await new Promise<CommandExecutionResult>((resolveExecution) => {
    const child = spawnProcess(invocation.bin, invocation.args, {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: platform !== 'windows',
    })
    const stdoutCollector = createBoundedOutputCollector()
    const stderrCollector = createBoundedOutputCollector()
    let settled = false
    let timedOut = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let abandonHandle: ReturnType<typeof setTimeout> | undefined

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (abandonHandle) clearTimeout(abandonHandle)
      resolveExecution({
        command,
        cwd,
        ...invocation,
        exitCode,
        signal,
        stdout: stdoutCollector.end(),
        stderr: stderrCollector.end(),
        durationMs: Date.now() - startedAt,
        timedOut,
      })
    }

    child.stdout?.on('data', (chunk: Buffer | string) => stdoutCollector.append(chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => stderrCollector.append(chunk))
    child.on('error', (error) => {
      // Through the collector so a spawn failure cannot push stderr past the cap.
      stderrCollector.appendText(error.message)
      finish(null, null)
    })
    child.on('close', finish)

    if (command.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        terminateProcessTreeWithEscalation(child, platform)
        // Killing the tree is a request, not a guarantee, so the timeout has to
        // be able to end without one. `close` fires only once every pipe is
        // closed, and a grandchild that outlives `taskkill` keeps them open —
        // which is how a 200 ms command sat unresolved until the caller's own
        // deadline. Reported as the timeout it is, with whatever output arrived.
        abandonHandle = setTimeout(() => {
          child.unref()
          finish(null, 'SIGKILL')
        }, FORCE_KILL_DELAY_MS + PROCESS_ABANDON_GRACE_MS)
        abandonHandle.unref?.()
      }, command.timeoutMs)
    }
  })
}
