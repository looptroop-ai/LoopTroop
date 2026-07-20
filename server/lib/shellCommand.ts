import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { FORCE_KILL_DELAY_MS } from './constants'

export interface CommandShell {
  bin: string
  args: string[]
}

export interface ShellCommandResult {
  command: string
  effectiveCommand?: string
  setupWrapperApplied: boolean
  bin: string
  args: string[]
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

const MAX_COMMAND_OUTPUT_BYTES = 1_000_000

export function getCommandShell(): CommandShell {
  if (process.platform === 'win32') {
    return {
      bin: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c'],
    }
  }

  return {
    bin: existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh',
    args: [existsSync('/bin/bash') ? '-lc' : '-c'],
  }
}

function getWrappedCommandShell(shell: CommandShell): CommandShell {
  if (process.platform === 'win32') return shell
  return {
    ...shell,
    args: ['-c'],
  }
}

export function quoteShellArg(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '""')}"`
  }
  return `'${value.replace(/'/g, "'\\''")}'`
}

function appendBoundedOutput(current: string, chunk: Buffer | string): string {
  if (Buffer.byteLength(current, 'utf8') >= MAX_COMMAND_OUTPUT_BYTES) return current
  const text = chunk.toString()
  const remaining = MAX_COMMAND_OUTPUT_BYTES - Buffer.byteLength(current, 'utf8')
  const next = `${current}${text.slice(0, remaining)}`
  if (Buffer.byteLength(next, 'utf8') >= MAX_COMMAND_OUTPUT_BYTES) {
    return `${next}\n[LoopTroop truncated command output at ${MAX_COMMAND_OUTPUT_BYTES} bytes]`
  }
  return next
}

function terminateProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => undefined)
    return
  }

  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

function normalizeCommandPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function commandIncludesWrapper(command: string, wrapperPath: string): boolean {
  const normalizedCommand = normalizeCommandPath(command)
  const normalizedWrapper = normalizeCommandPath(wrapperPath)
  return normalizedCommand.includes(normalizedWrapper)
}

function resolveWrapperPath(cwd: string, wrapperPath: string): string {
  return isAbsolute(wrapperPath) ? wrapperPath : resolve(cwd, wrapperPath)
}

function buildMissingWrapperResult(input: {
  command: string
  cwd: string
  commandWrapper: string
  startedAt: number
  message: string
  setupWrapperApplied: boolean
  effectiveCommand?: string
}): ShellCommandResult {
  const shell = getCommandShell()
  const wrappedShell = getWrappedCommandShell(shell)
  return {
    command: input.command,
    ...(input.effectiveCommand ? { effectiveCommand: input.effectiveCommand } : {}),
    setupWrapperApplied: input.setupWrapperApplied,
    bin: input.setupWrapperApplied ? resolveWrapperPath(input.cwd, input.commandWrapper) : shell.bin,
    args: input.setupWrapperApplied
      ? [wrappedShell.bin, ...wrappedShell.args, input.command]
      : [...shell.args, input.command],
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: input.message,
    durationMs: Date.now() - input.startedAt,
    timedOut: false,
  }
}

export async function runShellCommand(input: {
  command: string
  cwd: string
  timeoutMs?: number
  commandWrapper?: string
  forceWrapper?: boolean
}): Promise<ShellCommandResult> {
  const startedAt = Date.now()
  const shell = getCommandShell()
  const wrappedShell = getWrappedCommandShell(shell)
  const commandAlreadyUsesWrapper = Boolean(
    input.commandWrapper && commandIncludesWrapper(input.command, input.commandWrapper),
  )
  const shouldApplyWrapper = Boolean(
    input.commandWrapper
    && (input.forceWrapper || !commandAlreadyUsesWrapper),
  )
  const resolvedWrapperPath = input.commandWrapper ? resolveWrapperPath(input.cwd, input.commandWrapper) : null
  const wrapperEffectiveCommand = shouldApplyWrapper && input.commandWrapper
    ? `${input.commandWrapper} ${wrappedShell.bin} ${wrappedShell.args.map(quoteShellArg).join(' ')} ${quoteShellArg(input.command)}`
    : undefined

  if (input.commandWrapper && resolvedWrapperPath) {
    if (!existsSync(resolvedWrapperPath)) {
      return buildMissingWrapperResult({
        command: input.command,
        cwd: input.cwd,
        commandWrapper: input.commandWrapper,
        startedAt,
        message: `Execution setup wrapper ${input.commandWrapper} was declared but does not exist.`,
        setupWrapperApplied: shouldApplyWrapper,
        effectiveCommand: wrapperEffectiveCommand,
      })
    }
    try {
      const stat = statSync(resolvedWrapperPath)
      if (!stat.isFile()) {
        return buildMissingWrapperResult({
          command: input.command,
          cwd: input.cwd,
          commandWrapper: input.commandWrapper,
          startedAt,
          message: `Execution setup wrapper ${input.commandWrapper} was declared but is not a file.`,
          setupWrapperApplied: shouldApplyWrapper,
          effectiveCommand: wrapperEffectiveCommand,
        })
      }
      if (process.platform !== 'win32') {
        accessSync(resolvedWrapperPath, constants.X_OK)
      }
    } catch (err) {
      return buildMissingWrapperResult({
        command: input.command,
        cwd: input.cwd,
        commandWrapper: input.commandWrapper,
        startedAt,
        message: `Execution setup wrapper ${input.commandWrapper} could not be used: ${err instanceof Error ? err.message : 'Unknown error'}.`,
        setupWrapperApplied: shouldApplyWrapper,
        effectiveCommand: wrapperEffectiveCommand,
      })
    }
  }

  const bin = shouldApplyWrapper && resolvedWrapperPath ? resolvedWrapperPath : shell.bin
  const args = shouldApplyWrapper
    ? [wrappedShell.bin, ...wrappedShell.args, input.command]
    : [...shell.args, input.command]
  const effectiveCommand = wrapperEffectiveCommand

  return await new Promise<ShellCommandResult>((resolveCommand) => {
    const child = spawn(bin, args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      resolveCommand({
        command: input.command,
        ...(effectiveCommand ? { effectiveCommand } : {}),
        setupWrapperApplied: shouldApplyWrapper,
        bin,
        args,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      })
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout = appendBoundedOutput(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = appendBoundedOutput(stderr, chunk)
    })
    child.on('error', (error) => {
      stderr += shouldApplyWrapper && input.commandWrapper
        ? `Execution setup wrapper ${input.commandWrapper} could not be launched: ${error.message}`
        : error.message
      finish(null, null)
    })
    child.on('close', (exitCode, signal) => {
      finish(exitCode, signal)
    })

    if (input.timeoutMs && input.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        terminateProcessTree(child, 'SIGTERM')
        setTimeout(() => terminateProcessTree(child, 'SIGKILL'), FORCE_KILL_DELAY_MS).unref()
      }, input.timeoutMs)
    }
  })
}
