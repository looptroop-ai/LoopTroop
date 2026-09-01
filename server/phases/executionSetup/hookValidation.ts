import { executeCommand } from '../../lib/commandExecutor'
import { detectHostContext } from '../../lib/hostContext'
import type { ExecutionSetupCommandReceiptPayload, GitHookPolicy } from '../../structuredOutput/types'
import { DEFAULT_GIT_HOOK_POLICY, isGitHookPolicy } from '@shared/gitHookPolicy'
import {
  normalizeCommandSpec,
  renderCommandSpec,
  runtimeEnvironmentSchema,
  type CommandSpec,
  type RuntimeEnvironment,
} from '@shared/commandSpec'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { getExecutionSetupCommitExcludedRoots, summarizeWorktreeChanges } from '../../git/worktreeChanges'

const HOOK_VALIDATION_TIMEOUT_MS = 30_000

interface ValidationCommand {
  id: string
  hook: string
  command: CommandSpec
}

interface WorktreeSnapshot {
  tree: string
  temporaryDirectory: string
  untrackedPaths: Set<string>
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

function listUntrackedPaths(worktreePath: string): Set<string> {
  const result = spawnSync(
    'git',
    ['-C', worktreePath, 'ls-files', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer' },
  )
  if (result.status !== 0 || result.error) return new Set()
  return new Set((result.stdout ?? Buffer.alloc(0)).toString('utf8').split('\0').filter(Boolean))
}

function snapshotWorktree(worktreePath: string): WorktreeSnapshot | null {
  const gitDirectoryResult = spawnSync(
    'git',
    ['-C', worktreePath, 'rev-parse', '--absolute-git-dir'],
    { encoding: 'utf8' },
  )
  if (gitDirectoryResult.status !== 0 || gitDirectoryResult.error) return null

  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'looptroop-hook-snapshot-'))
  const temporaryIndex = resolve(temporaryDirectory, 'index')
  const gitDirectory = (gitDirectoryResult.stdout ?? '').trim()
  const sourceIndex = resolve(gitDirectory, 'index')
  if (existsSync(sourceIndex)) copyFileSync(sourceIndex, temporaryIndex)
  const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex }
  if (!existsSync(temporaryIndex)) {
    const empty = spawnSync('git', ['-C', worktreePath, 'read-tree', '--empty'], { env })
    if (empty.status !== 0 || empty.error) {
      rmSync(temporaryDirectory, { recursive: true, force: true })
      return null
    }
  }
  const staged = spawnSync('git', ['-C', worktreePath, 'add', '-A', '--', '.'], { env })
  const tree = staged.status === 0 && !staged.error
    ? spawnSync('git', ['-C', worktreePath, 'write-tree'], { env, encoding: 'utf8' })
    : null
  const treeId = tree?.status === 0 && !tree.error ? (tree.stdout ?? '').trim() : ''
  if (!treeId) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
    return null
  }
  return { tree: treeId, temporaryDirectory, untrackedPaths: listUntrackedPaths(worktreePath) }
}

function restoreWorktreeSnapshot(worktreePath: string, snapshot: WorktreeSnapshot): void {
  try {
    spawnSync('git', ['-C', worktreePath, 'restore', '--source', snapshot.tree, '--worktree', '--', '.'])
    for (const path of listUntrackedPaths(worktreePath)) {
      if (snapshot.untrackedPaths.has(path)) continue
      const absolutePath = resolve(worktreePath, path)
      const relativePath = relative(resolve(worktreePath), absolutePath)
      if (
        isAbsolute(path)
        || relativePath === '..'
        || relativePath.startsWith('../')
        || relativePath.startsWith('..\\')
      ) continue
      rmSync(absolutePath, { recursive: true, force: true })
    }
  } finally {
    rmSync(snapshot.temporaryDirectory, { recursive: true, force: true })
  }
}

function readProfileValidation(content: string): {
  policy: GitHookPolicy
  commands: ValidationCommand[]
  runtimeEnvironment?: RuntimeEnvironment
} | null {
  try {
    const value = JSON.parse(content) as Record<string, unknown>
    const hooks = (value.git_hooks ?? value.gitHooks) as Record<string, unknown> | undefined
    const policy = hooks?.policy
    if (!isGitHookPolicy(policy)) return null
    const rawCommands = hooks?.validation_commands ?? hooks?.validationCommands
    const commands = Array.isArray(rawCommands) ? rawCommands.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const command = entry as Record<string, unknown>
      if (typeof command.id !== 'string' || typeof command.hook !== 'string') return []
      try {
        return [{
          id: command.id,
          hook: command.hook,
          command: normalizeCommandSpec(command.command, detectHostContext()).command,
        }]
      } catch {
        return []
      }
    }) : []
    const runtimeEnvironment = runtimeEnvironmentSchema.safeParse(
      value.runtime_environment ?? value.runtimeEnvironment,
    )
    return {
      policy,
      commands,
      ...(runtimeEnvironment.success ? { runtimeEnvironment: runtimeEnvironment.data } : {}),
    }
  } catch {
    return null
  }
}

export async function runExplicitGitHookValidation(input: {
  profileContent: string
  worktreePath: string
  signal?: AbortSignal
}): Promise<{
  policy: GitHookPolicy
  receipts: ExecutionSetupCommandReceiptPayload[]
  errors: string[]
  warnings: string[]
  fileAudit: GitHookValidationFileAudit
}> {
  const config = readProfileValidation(input.profileContent)
  const policy = config?.policy ?? DEFAULT_GIT_HOOK_POLICY
  const noMutation = { mutated: false, candidatePaths: [], temporaryPaths: [], internalPaths: [] }
  if (!config || (policy !== 'validate_advisory' && policy !== 'validate_required')) {
    return {
      policy,
      receipts: [{
        id: 'git-hook-policy',
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        outputExcerpt: `Explicit validation is disabled by policy ${policy}.`,
      }],
      errors: [],
      warnings: [],
      fileAudit: noMutation,
    }
  }
  const receipts: ExecutionSetupCommandReceiptPayload[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const beforeFingerprint = worktreeFingerprint(input.worktreePath)
  const snapshot = snapshotWorktree(input.worktreePath)
  for (const validation of config.commands) {
    if (input.signal?.aborted) throw input.signal.reason
    const command = validation.command.timeoutMs
      ? validation.command
      : { ...validation.command, timeoutMs: HOOK_VALIDATION_TIMEOUT_MS }
    const result = await executeCommand(command, {
      repoRoot: input.worktreePath,
      runtimeEnvironment: config.runtimeEnvironment,
    })
    const outputExcerpt = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n').slice(0, 2000)
    const status = result.timedOut ? 'timed_out' as const : result.exitCode === 0 ? 'passed' as const : 'failed' as const
    receipts.push({
      id: validation.id,
      command: validation.command,
      status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputExcerpt,
    })
    if (status !== 'passed') {
      const message = `${validation.hook} validation ${status}: ${renderCommandSpec(validation.command)}${outputExcerpt ? `\n${outputExcerpt}` : ''}`
      if (policy === 'validate_required') errors.push(message)
      else warnings.push(message)
      break
    }
  }
  if (receipts.length === 0) {
    receipts.push({
      id: 'git-hook-policy',
      status: 'skipped',
      exitCode: null,
      durationMs: 0,
      outputExcerpt: 'No explicit Git hook validation commands were approved.',
    })
  }
  const fileAudit = buildFileAudit(input.worktreePath, beforeFingerprint)
  if (snapshot) restoreWorktreeSnapshot(input.worktreePath, snapshot)
  return { policy, receipts, errors, warnings, fileAudit }
}
