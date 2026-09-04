import { executeCommand, type CommandExecutionResult } from '../../lib/commandExecutor'
import { detectHostContext } from '../../lib/hostContext'
import { hostContextSchema } from '@shared/hostContext'
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
import { snapshotGitIndex, type GitIndexSnapshot } from '../../git/indexSnapshot'
import { REPO_SCOPE_PATHSPECS } from '../../git/pathspecs'
import { runGitBinarySync, runGitSync } from '../../git/runCommand'
import { getExecutionSetupCommitExcludedRoots, summarizeWorktreeChanges } from '../../git/worktreeChanges'
import { getErrorMessage } from '@shared/typeGuards'

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
  /**
   * The worktree's own index, restored alongside the files.
   *
   * Restoring the worktree alone left a hook that ran `git add` with its paths
   * still staged — the validation was undone on disk and not in the index.
   */
  index: GitIndexSnapshot
}

export interface GitHookValidationFileAudit {
  mutated: boolean
  candidatePaths: string[]
  temporaryPaths: string[]
  internalPaths: string[]
}

function worktreeFingerprint(worktreePath: string): string {
  const status = runGitBinarySync(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const diff = runGitBinarySync(worktreePath, ['diff', 'HEAD', '--binary', '--', ...REPO_SCOPE_PATHSPECS])
  return createHash('sha256')
    .update(status.stdout)
    .update(diff.stdout)
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
  const result = runGitBinarySync(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (!result.ok) return new Set()
  return new Set(result.stdout.toString('utf8').split('\0').filter(Boolean))
}

function snapshotWorktree(worktreePath: string): WorktreeSnapshot | null {
  const gitDirectoryResult = runGitSync(worktreePath, ['rev-parse', '--absolute-git-dir'])
  if (!gitDirectoryResult.ok) return null

  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'looptroop-hook-snapshot-'))
  const temporaryIndex = resolve(temporaryDirectory, 'index')
  const sourceIndex = resolve(gitDirectoryResult.stdout, 'index')
  if (existsSync(sourceIndex)) copyFileSync(sourceIndex, temporaryIndex)
  const env = { GIT_INDEX_FILE: temporaryIndex }
  if (!existsSync(temporaryIndex)) {
    if (!runGitSync(worktreePath, ['read-tree', '--empty'], { env }).ok) {
      rmSync(temporaryDirectory, { recursive: true, force: true })
      return null
    }
  }
  const staged = runGitSync(worktreePath, ['add', '-A', '--', '.'], { env })
  const tree = staged.ok ? runGitSync(worktreePath, ['write-tree'], { env }) : null
  const treeId = tree?.ok ? tree.stdout : ''
  if (!treeId) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
    return null
  }
  // The index half is not optional. Restoring files while leaving a hook's
  // `git add` staged is not a restore, so a snapshot without it is unusable
  // and the caller refuses to run rather than run unprotected.
  const index = snapshotGitIndex(worktreePath)
  if (!index) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
    return null
  }

  return {
    tree: treeId,
    temporaryDirectory,
    untrackedPaths: listUntrackedPaths(worktreePath),
    index,
  }
}

/**
 * Puts the worktree and the index back, and reports whether it managed to.
 *
 * Never throws. It runs in a `finally` over a validation failure or a
 * cancellation, and an exception there would replace the error the operator
 * actually needs to read with one about the cleanup.
 */
function restoreWorktreeSnapshot(worktreePath: string, snapshot: WorktreeSnapshot): string | null {
  const failures: string[] = []
  try {
    try {
      snapshot.index.restore()
    } catch (error) {
      failures.push(`index restore failed: ${getErrorMessage(error)}`)
    }
    // Attempted even when the index restore failed: half a restore is better
    // than none, and both failures are reported.
    const restored = runGitSync(worktreePath, ['restore', '--source', snapshot.tree, '--worktree', '--', '.'])
    if (!restored.ok) failures.push(`worktree restore failed: ${restored.errorDetail}`)
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
  } catch (error) {
    failures.push(`worktree cleanup failed: ${getErrorMessage(error)}`)
  } finally {
    snapshot.index.dispose()
    rmSync(snapshot.temporaryDirectory, { recursive: true, force: true })
  }
  return failures.length > 0 ? failures.join('; ') : null
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
    // The host the profile was written and approved on, not whatever is running
    // now. Re-detecting rewrote an approved hook command's quoting for the
    // current platform, so a command approved on one host ran as something else
    // on another.
    const parsedHost = hostContextSchema.safeParse(value.host_context ?? value.hostContext)
    const hostContext = parsedHost.success ? parsedHost.data : detectHostContext()
    const rawCommands = hooks?.validation_commands ?? hooks?.validationCommands
    const commands = Array.isArray(rawCommands) ? rawCommands.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const command = entry as Record<string, unknown>
      if (typeof command.id !== 'string' || typeof command.hook !== 'string') return []
      try {
        return [{
          id: command.id,
          hook: command.hook,
          command: normalizeCommandSpec(command.command, hostContext).command,
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

/**
 * Runs one approved Git-hook validation command and scores it.
 *
 * Both hook-validation paths — this module's explicit validator and the
 * execution-setup profile validator — ran their own copy of this, deriving the
 * status and building the receipt slightly differently. What they legitimately
 * differ on stays with them: whether to stop at the first failure, whether the
 * worktree is snapshotted and restored, how the timeout is derived, and how a
 * failure is worded. What they should never differ on is what "passed",
 * "failed" and "timed out" mean for the same command.
 */
export interface GitHookValidationCommandOutcome {
  status: 'passed' | 'failed' | 'timed_out'
  outputExcerpt: string
  receipt: ExecutionSetupCommandReceiptPayload
  result: CommandExecutionResult
}

export async function runGitHookValidationCommand(input: {
  id: string
  command: CommandSpec
  worktreePath: string
  runtimeEnvironment?: RuntimeEnvironment | undefined
  /** Applied only when the command does not carry one of its own. */
  timeoutMs: number
}): Promise<GitHookValidationCommandOutcome> {
  const command = input.command.timeoutMs
    ? input.command
    : { ...input.command, timeoutMs: input.timeoutMs }
  const result = await executeCommand(command, {
    repoRoot: input.worktreePath,
    ...(input.runtimeEnvironment ? { runtimeEnvironment: input.runtimeEnvironment } : {}),
  })
  const outputExcerpt = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n').slice(0, 2000)
  const status = result.timedOut ? 'timed_out' as const : result.exitCode === 0 ? 'passed' as const : 'failed' as const
  return {
    status,
    outputExcerpt,
    result,
    receipt: {
      id: input.id,
      command: input.command,
      status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputExcerpt,
    },
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
    // Two different reasons land here and they are not the same news. A policy
    // that disables validation is a choice; a profile whose policy could not be
    // read is a problem, and reporting it as `Explicit validation is disabled by
    // policy validate_advisory` claims a decision nobody made.
    const unreadableProfile = !config
    return {
      policy,
      receipts: [{
        id: 'git-hook-policy',
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        outputExcerpt: unreadableProfile
          ? 'Explicit validation was skipped: the workspace profile declares no readable git hook policy.'
          : `Explicit validation is disabled by policy ${policy}.`,
      }],
      errors: [],
      warnings: unreadableProfile
        ? ['The workspace profile declares no readable git hook policy, so explicit hook validation was skipped.']
        : [],
      fileAudit: noMutation,
    }
  }
  const receipts: ExecutionSetupCommandReceiptPayload[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const beforeFingerprint = worktreeFingerprint(input.worktreePath)
  const snapshot = snapshotWorktree(input.worktreePath)
  if (!snapshot) {
    // Validation runs arbitrary approved commands and is only safe because
    // whatever they touch is put back. Without a snapshot it used to run
    // anyway, so a hook that writes files left them in the worktree with
    // nothing able to undo it.
    return {
      policy,
      receipts: [{
        id: 'git-hook-policy',
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        outputExcerpt: 'Explicit validation was skipped: the worktree could not be snapshotted, so hook side effects could not be undone.',
      }],
      errors: policy === 'validate_required'
        ? ['Explicit Git hook validation could not run: the worktree could not be snapshotted.']
        : [],
      warnings: policy === 'validate_required'
        ? []
        : ['Explicit Git hook validation was skipped because the worktree could not be snapshotted.'],
      fileAudit: noMutation,
    }
  }

  // The audit is captured before restoration — it is a record of what the hooks
  // did, which restoring erases — and the restore itself runs in `finally`, so
  // an abort or a rejected command cannot leave hook output behind. The original
  // failure is rethrown; a failure to restore is reported beside it rather than
  // replacing it.
  let fileAudit: GitHookValidationFileAudit = noMutation
  let restoreFailure: string | null = null
  try {
    for (const validation of config.commands) {
      if (input.signal?.aborted) throw input.signal.reason
      // Stops at the first failure, unlike the profile validator, which runs
      // every command and collects them. Both score a command the same way.
      const { status, outputExcerpt, receipt } = await runGitHookValidationCommand({
        id: validation.id,
        command: validation.command,
        worktreePath: input.worktreePath,
        runtimeEnvironment: config.runtimeEnvironment,
        timeoutMs: HOOK_VALIDATION_TIMEOUT_MS,
      })
      receipts.push(receipt)
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
  } finally {
    try {
      fileAudit = buildFileAudit(input.worktreePath, beforeFingerprint)
    } catch {
      // A failed audit must not stop the restore, which is the part that
      // leaves the worktree usable.
    }
    restoreFailure = restoreWorktreeSnapshot(input.worktreePath, snapshot)
  }

  // Reported beside whatever the validation itself found, never instead of it.
  // A worktree that could not be put back is a blocking problem under either
  // policy: the next phase would start from hook output nobody asked for.
  if (restoreFailure) {
    errors.push(`Explicit Git hook validation could not restore the worktree: ${restoreFailure}`)
  }
  return { policy, receipts, errors, warnings, fileAudit }
}
