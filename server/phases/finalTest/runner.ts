import type { StructuredOutputMetadata } from '../../structuredOutput/types'
import type { RawAttempt } from '../../council/types'
import type { FinalTestFileEffect } from './fileEffectsAudit'
import { executeCommand, type CommandExecutionResult } from '../../lib/commandExecutor'
import { detectHostContext } from '../../lib/hostContext'
import {
  renderCommandSpec,
  type CommandSpec,
  type RuntimeEnvironment,
} from '@shared/commandSpec'

import * as commandLogger from '../../log/commandLogger'

// Tolerates partial vi.mock() factories that omit logCommand.
function logCmd(
  bin: string,
  args: string[],
  result:
    | { ok: true; stdin?: string; stdout?: string; stderr?: string }
    | { ok: false; error: string; stdin?: string; stdout?: string; stderr?: string },
) {
  commandLogger.logCommand?.(bin, args, result)
}

export interface FinalTestCommandResult {
  command: CommandSpec
  displayCommand: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export interface FinalTestAttemptHistoryEntry {
  attempt: number
  status: 'passed' | 'failed'
  checkedAt: string
  summary?: string
  commands: CommandSpec[]
  testFiles: string[]
  modifiedFiles: string[]
  fileEffects: FinalTestFileEffect[]
  errors: string[]
  failureReason?: string
  noteAppended?: string
}

export interface FinalTestExecutionReport {
  status: 'passed' | 'failed'
  passed: boolean
  checkedAt: string
  plannedBy: string
  summary?: string
  testFiles: string[]
  modifiedFiles: string[]
  fileEffects: FinalTestFileEffect[]
  testsCount: number | null
  modelOutput: string
  commands: FinalTestCommandResult[]
  errors: string[]
  planStructuredOutput?: StructuredOutputMetadata
  rawAttempts?: RawAttempt[]
  attempt?: number
  maxIterations?: number | null
  attemptHistory?: FinalTestAttemptHistoryEntry[]
  retryNotes?: string[]
}

function toFinalTestCommandResult(result: CommandExecutionResult): FinalTestCommandResult {
  const processShell = detectHostContext().platform === 'windows' ? 'cmd' : 'posix'
  return {
    command: result.command,
    displayCommand: renderCommandSpec(result.command, processShell),
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  }
}

export async function executeFinalTestCommands(input: {
  commands: CommandSpec[]
  cwd: string
  timeoutMs?: number
  plannedBy: string
  summary?: string
  testFiles?: string[]
  modifiedFiles?: string[]
  fileEffects?: FinalTestFileEffect[]
  testsCount?: number | null
  modelOutput: string
  planStructuredOutput?: StructuredOutputMetadata
  rawAttempts?: RawAttempt[]
  runtimeEnvironment?: RuntimeEnvironment
}): Promise<FinalTestExecutionReport> {
  const commandResults: FinalTestCommandResult[] = []
  const errors: string[] = []

  for (const command of input.commands) {
    const commandWithTimeout = command.timeoutMs || !input.timeoutMs
      ? command
      : { ...command, timeoutMs: input.timeoutMs }
    const execution = await executeCommand(commandWithTimeout, {
      repoRoot: input.cwd,
      runtimeEnvironment: input.runtimeEnvironment,
    })
    const result = toFinalTestCommandResult(execution)
    commandResults.push(result)

    // Log the command execution to SYS
    if (result.exitCode === 0 && !result.timedOut) {
      logCmd(execution.bin, execution.args, {
        ok: true,
        stdout: result.stdout.trim() || undefined,
        stderr: result.stderr.trim() || undefined,
      })
    } else {
      const errDetail = result.timedOut
        ? `timed out after ${result.durationMs}ms`
        : `exit code ${result.exitCode ?? 'unknown'}`
      logCmd(execution.bin, execution.args, {
        ok: false,
        error: errDetail,
        stdout: result.stdout.trim() || undefined,
        stderr: result.stderr.trim() || undefined,
      })
    }

    if (result.exitCode !== 0 || result.timedOut) {
      errors.push(result.timedOut
        ? `Command timed out: ${result.displayCommand}`
        : `Command failed (${result.exitCode ?? 'no exit code'}): ${result.displayCommand}`)
      break
    }
  }

  const passed = errors.length === 0 && input.commands.length > 0
  return {
    status: passed ? 'passed' : 'failed',
    passed,
    checkedAt: new Date().toISOString(),
    plannedBy: input.plannedBy,
    summary: input.summary,
    testFiles: input.testFiles ?? [],
    modifiedFiles: input.modifiedFiles ?? input.testFiles ?? [],
    fileEffects: input.fileEffects ?? [],
    testsCount: input.testsCount ?? null,
    modelOutput: input.modelOutput,
    commands: commandResults,
    errors,
    ...(input.planStructuredOutput ? { planStructuredOutput: input.planStructuredOutput } : {}),
    ...(input.rawAttempts ? { rawAttempts: input.rawAttempts } : {}),
  }
}
