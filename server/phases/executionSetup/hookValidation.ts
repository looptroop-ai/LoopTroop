import { getExecutionSetupCommandWrapperFromContent } from './runtimeProfile'
import { runShellCommand } from '../../lib/shellCommand'
import type { ExecutionSetupCommandReceiptPayload, GitHookPolicy } from '../../structuredOutput/types'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { getExecutionSetupCommitExcludedRoots, summarizeWorktreeChanges } from '../../git/worktreeChanges'

const HOOK_VALIDATION_TIMEOUT_MS = 30_000

interface ValidationCommand {
  id: string
  hook: string
  command: string
}

export interface GitHookValidationFileAudit {
  mutated: boolean
  candidatePaths: string[]
  temporaryPaths: string[]
  internalPaths: string[]
}

function worktreeFingerprint(worktreePath: string): string {
  const status = spawnSync('git', ['-C', worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'buffer' })
  const diff = spawnSync('git', ['-C', worktreePath, 'diff', 'HEAD', '--binary', '--', '.', ':(top,exclude).ticket', ':(top,exclude).looptroop'], { encoding: 'buffer' })
  return createHash('sha256')
    .update(status.stdout ?? Buffer.alloc(0))
    .update(diff.stdout ?? Buffer.alloc(0))
    .digest('hex')
}

function buildFileAudit(worktreePath: string, beforeFingerprint: string): GitHookValidationFileAudit {
  const afterFingerprint = worktreeFingerprint(worktreePath)
  if (beforeFingerprint === afterFingerprint) {
    return { mutated: false, candidatePaths: [], temporaryPaths: [], internalPaths: [] }
  }
  const summary = summarizeWorktreeChanges(worktreePath, {
    setupExcludedRoots: getExecutionSetupCommitExcludedRoots(worktreePath),
  })
  return {
    mutated: true,
    candidatePaths: summary.committable.map((entry) => entry.path),
    temporaryPaths: [...summary.setupExcluded, ...summary.generatedNoise].map((entry) => entry.path),
    internalPaths: summary.looptroopExcluded.map((entry) => entry.path),
  }
}

function readProfileValidation(content: string): { policy: GitHookPolicy; commands: ValidationCommand[] } | null {
  try {
    const value = JSON.parse(content) as Record<string, unknown>
    const hooks = (value.git_hooks ?? value.gitHooks) as Record<string, unknown> | undefined
    const policy = hooks?.policy
    if (policy !== 'validate_explicitly' && policy !== 'use_on_internal_commits' && policy !== 'ignore_internal_only') return null
    const rawCommands = hooks?.validation_commands ?? hooks?.validationCommands
    const commands = Array.isArray(rawCommands) ? rawCommands.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const command = entry as Record<string, unknown>
      return typeof command.id === 'string' && typeof command.hook === 'string' && typeof command.command === 'string'
        ? [{ id: command.id, hook: command.hook, command: command.command }]
        : []
    }) : []
    return { policy, commands }
  } catch {
    return null
  }
}

export async function runExplicitGitHookValidation(input: {
  profileContent: string
  worktreePath: string
  signal?: AbortSignal
}): Promise<{ policy: GitHookPolicy; receipts: ExecutionSetupCommandReceiptPayload[]; errors: string[]; fileAudit: GitHookValidationFileAudit }> {
  const config = readProfileValidation(input.profileContent)
  const policy = config?.policy ?? 'validate_explicitly'
  const noMutation = { mutated: false, candidatePaths: [], temporaryPaths: [], internalPaths: [] }
  if (!config || policy !== 'validate_explicitly') {
    return {
      policy,
      receipts: [{
        id: 'git-hook-policy',
        command: '',
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        outputExcerpt: `Explicit validation is disabled by policy ${policy}.`,
      }],
      errors: [],
      fileAudit: noMutation,
    }
  }
  const wrapper = getExecutionSetupCommandWrapperFromContent(input.profileContent, input.worktreePath)
  const receipts: ExecutionSetupCommandReceiptPayload[] = []
  const errors: string[] = []
  const beforeFingerprint = worktreeFingerprint(input.worktreePath)
  for (const validation of config.commands) {
    if (input.signal?.aborted) throw input.signal.reason
    const result = await runShellCommand({
      command: validation.command,
      cwd: input.worktreePath,
      timeoutMs: HOOK_VALIDATION_TIMEOUT_MS,
      ...(wrapper ? { commandWrapper: wrapper } : {}),
    })
    const outputExcerpt = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n').slice(0, 2000)
    const status = result.timedOut ? 'timed_out' as const : result.exitCode === 0 ? 'passed' as const : 'failed' as const
    receipts.push({
      id: validation.id,
      command: validation.command,
      ...(result.effectiveCommand ? { effectiveCommand: result.effectiveCommand } : {}),
      setupWrapperApplied: result.setupWrapperApplied,
      status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputExcerpt,
    })
    if (status !== 'passed') {
      errors.push(`${validation.hook} validation ${status}: ${validation.command}${outputExcerpt ? `\n${outputExcerpt}` : ''}`)
      break
    }
  }
  if (receipts.length === 0) {
    receipts.push({
      id: 'git-hook-policy',
      command: '',
      status: 'skipped',
      exitCode: null,
      durationMs: 0,
      outputExcerpt: 'No explicit Git hook validation commands were approved.',
    })
  }
  return { policy, receipts, errors, fileAudit: buildFileAudit(input.worktreePath, beforeFingerprint) }
}
