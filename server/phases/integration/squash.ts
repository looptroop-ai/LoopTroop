import { spawnSync } from 'node:child_process'
import { resolveBaseBranchRef } from '../../git/repository'
import { readWorktreeGitHookPolicy, shouldBypassGitHooks } from '../../git/hookPolicy'
import { getErrorMessage } from '@shared/typeGuards'
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

export interface SquashResult {
  success: boolean
  message: string
  commitHash?: string
  mergeBase?: string
  preSquashHead?: string
  commitCount?: number
}

const GIT_ADD_BATCH_SIZE = 100

function normalizeCandidatePath(filePath: string): string | null {
  const trimmed = filePath.trim()
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\n')) return null

  const normalized = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('/')
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized === '.ticket'
    || normalized.startsWith('.ticket/')
    || normalized === '.looptroop'
    || normalized.startsWith('.looptroop/')
  ) {
    return null
  }

  return normalized
}

function uniqueCandidatePaths(files: string[]): string[] {
  return [...new Set(files.map(normalizeCandidatePath).filter((file): file is string => file !== null))]
}

function parsePathList(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function toLiteralPathspec(filePath: string): string {
  return `:(literal)${filePath}`
}

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\t+/).map((part) => part.trim()).filter(Boolean)
      return {
        status: parts[0] ?? '',
        path: parts.at(-1) ?? '',
      }
    })
    .filter((entry) => entry.status && entry.path)
}

export function prepareSquashCandidate(
  worktreePath: string,
  baseBranch: string,
  ticketTitle: string,
  ticketId: string,
  extraFilesToStage: string[] = [],
): SquashResult {
  let preSquashHead: string | undefined
  let resetForSquash = false
  const runGit = (args: string[]) => {
    const fullArgs = ['-C', worktreePath, ...args]
    const result = spawnSync('git', fullArgs, { encoding: 'utf8' })
    const stdout = (result.stdout ?? '').trim()
    const stderr = (result.stderr ?? '').trim()
    if (result.status !== 0 || result.error) {
      const detail = result.error?.message ?? ([stdout, stderr].filter(Boolean).join(' | ') || `exit code ${result.status ?? '?'}`)
      logCmd('git', fullArgs, {
        ok: false,
        error: result.error?.message ?? `exit code ${result.status ?? '?'}`,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      })
      throw new Error(detail)
    }
    logCmd('git', fullArgs, { ok: true, stdout: stdout || undefined, stderr: stderr || undefined })
    return stdout
  }

  try {
    const baseBranchRef = resolveBaseBranchRef(worktreePath, baseBranch)
    preSquashHead = runGit(['rev-parse', 'HEAD'])
    const mergeBase = runGit(['merge-base', 'HEAD', baseBranchRef])
    const commitCount = Number(runGit(['rev-list', '--count', `${mergeBase}..HEAD`]))
    const committedCandidateFiles = uniqueCandidatePaths(parsePathList(runGit([
      'diff',
      '--name-only',
      '--no-renames',
      `${mergeBase}..${preSquashHead}`,
      '--',
      '.',
      ':(top,exclude).ticket',
      ':(top,exclude).looptroop',
    ])))
    const explicitFiles = uniqueCandidatePaths(extraFilesToStage)
    const candidateFiles = uniqueCandidatePaths([
      ...committedCandidateFiles,
      ...explicitFiles,
    ])

    if (candidateFiles.length === 0) {
      return {
        success: false,
        message: 'No candidate changes were available to squash',
        mergeBase,
        preSquashHead,
        commitCount,
      }
    }

    runGit(['reset', '--mixed', mergeBase])
    resetForSquash = true

    for (let index = 0; index < candidateFiles.length; index += GIT_ADD_BATCH_SIZE) {
      const batch = candidateFiles.slice(index, index + GIT_ADD_BATCH_SIZE)
      // Candidate paths are explicit, validated delivery decisions. `-f`
      // lets an explicitly declared permanent artifact override a repository
      // ignore rule without sweeping any other ignored/local files.
      runGit(['add', '-v', '-f', '-A', '--', ...batch.map(toLiteralPathspec)])
    }

    const stagedChanges = runGit(['diff', '--cached', '--name-only', '--', '.', ':(top,exclude).ticket', ':(top,exclude).looptroop'])
    if (!stagedChanges) {
      runGit(['reset', '--mixed', preSquashHead])
      return {
        success: false,
        message: 'No candidate changes were available to squash',
        mergeBase,
        preSquashHead,
        commitCount,
      }
    }

    runGit([
      '-c',
      'user.name=LoopTroop',
      '-c',
      'user.email=looptroop@local',
      'commit',
      ...(shouldBypassGitHooks(readWorktreeGitHookPolicy(worktreePath)) ? ['--no-verify'] : []),
      '-m',
      `${ticketId}: ${ticketTitle}`,
    ])
    const commitHash = runGit(['rev-parse', 'HEAD'])
    resetForSquash = false
    return {
      success: true,
      message: `Prepared candidate commit ${commitHash} from ${commitCount} commit(s) on ${ticketId}`,
      commitHash,
      mergeBase,
      preSquashHead,
      commitCount,
    }
  } catch (error) {
    if (resetForSquash && preSquashHead) {
      try {
        runGit(['reset', '--mixed', preSquashHead])
      } catch {
        // Preserve the original error; caller-level recovery records the failure context.
      }
    }
    return {
      success: false,
      message: getErrorMessage(error),
    }
  }
}

export function rewriteCandidateCommitWithFiles(
  worktreePath: string,
  mergeBase: string,
  candidateCommitSha: string,
  ticketTitle: string,
  ticketId: string,
  includedFiles: string[],
): SquashResult {
  let preRewriteHead: string | undefined
  let resetForRewrite = false
  const runGit = (args: string[]) => {
    const fullArgs = ['-C', worktreePath, ...args]
    const result = spawnSync('git', fullArgs, { encoding: 'utf8' })
    const stdout = (result.stdout ?? '').trim()
    const stderr = (result.stderr ?? '').trim()
    if (result.status !== 0 || result.error) {
      const detail = result.error?.message ?? ([stdout, stderr].filter(Boolean).join(' | ') || `exit code ${result.status ?? '?'}`)
      logCmd('git', fullArgs, {
        ok: false,
        error: result.error?.message ?? `exit code ${result.status ?? '?'}`,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      })
      throw new Error(detail)
    }
    logCmd('git', fullArgs, { ok: true, stdout: stdout || undefined, stderr: stderr || undefined })
    return stdout
  }

  try {
    preRewriteHead = runGit(['rev-parse', 'HEAD'])
    const candidateFiles = uniqueCandidatePaths(includedFiles)

    if (candidateFiles.length === 0) {
      return {
        success: false,
        message: 'Candidate file audit did not leave any files to include',
        mergeBase,
        preSquashHead: preRewriteHead,
      }
    }

    const changedFiles = new Set(parsePathList(runGit([
      'diff',
      '--name-only',
      '--no-renames',
      `${mergeBase}..${candidateCommitSha}`,
      '--',
      '.',
      ':(top,exclude).ticket',
      ':(top,exclude).looptroop',
    ])))
    const includedChangedFiles = candidateFiles.filter((file) => changedFiles.has(file))

    if (includedChangedFiles.length === 0) {
      return {
        success: false,
        message: 'Candidate file audit did not include any changed files',
        mergeBase,
        preSquashHead: preRewriteHead,
      }
    }

    const nameStatus = parseNameStatus(runGit([
      'diff',
      '--name-status',
      '--no-renames',
      `${mergeBase}..${candidateCommitSha}`,
      '--',
      ...includedChangedFiles.map(toLiteralPathspec),
    ]))
    const deletedFiles = nameStatus
      .filter((entry) => entry.status.startsWith('D'))
      .map((entry) => entry.path)
    const presentFiles = includedChangedFiles.filter((file) => !deletedFiles.includes(file))

    runGit(['reset', '--hard', mergeBase])
    resetForRewrite = true

    for (let index = 0; index < presentFiles.length; index += GIT_ADD_BATCH_SIZE) {
      const batch = presentFiles.slice(index, index + GIT_ADD_BATCH_SIZE)
      runGit(['checkout', candidateCommitSha, '--', ...batch.map(toLiteralPathspec)])
    }
    for (let index = 0; index < deletedFiles.length; index += GIT_ADD_BATCH_SIZE) {
      const batch = deletedFiles.slice(index, index + GIT_ADD_BATCH_SIZE)
      runGit(['rm', '-f', '--ignore-unmatch', '--', ...batch.map(toLiteralPathspec)])
    }

    const stagedChanges = runGit(['diff', '--cached', '--name-only', '--', '.', ':(top,exclude).ticket', ':(top,exclude).looptroop'])
    if (!stagedChanges) {
      runGit(['reset', '--hard', preRewriteHead])
      return {
        success: false,
        message: 'No candidate changes were available after file audit filtering',
        mergeBase,
        preSquashHead: preRewriteHead,
      }
    }

    runGit([
      '-c',
      'user.name=LoopTroop',
      '-c',
      'user.email=looptroop@local',
      'commit',
      ...(shouldBypassGitHooks(readWorktreeGitHookPolicy(worktreePath)) ? ['--no-verify'] : []),
      '-m',
      `${ticketId}: ${ticketTitle}`,
    ])
    const commitHash = runGit(['rev-parse', 'HEAD'])
    resetForRewrite = false
    return {
      success: true,
      message: `Prepared filtered candidate commit ${commitHash} from ${candidateCommitSha}`,
      commitHash,
      mergeBase,
      preSquashHead: preRewriteHead,
      commitCount: 1,
    }
  } catch (error) {
    if (resetForRewrite && preRewriteHead) {
      try {
        runGit(['reset', '--hard', preRewriteHead])
      } catch {
        // Preserve the original error; caller-level recovery records the failure context.
      }
    }
    return {
      success: false,
      message: getErrorMessage(error),
      mergeBase,
      preSquashHead: preRewriteHead,
    }
  }
}

export interface PushResult {
  pushed: boolean
  error?: string
}

const MAX_PUSH_RETRIES = 3

export function pushSquashedCandidate(worktreePath: string): PushResult {
  const bypassHooks = shouldBypassGitHooks(readWorktreeGitHookPolicy(worktreePath))
  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
    const fullArgs = ['-C', worktreePath, 'push', ...(bypassHooks ? ['--no-verify'] : [])]
    const result = spawnSync('git', fullArgs, { encoding: 'utf8' })
    const stdout = (result.stdout ?? '').trim()
    const stderr = (result.stderr ?? '').trim()
    if (result.status === 0 && !result.error) {
      logCmd('git', fullArgs, { ok: true, stdout: stdout || undefined, stderr: stderr || undefined })
      return { pushed: true }
    }
    const detail = result.error?.message ?? ([stdout, stderr].filter(Boolean).join(' | ') || `exit code ${result.status ?? '?'}`)
    logCmd('git', fullArgs, {
      ok: false,
      error: result.error?.message ?? `exit code ${result.status ?? '?'}`,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    })
    if (attempt === MAX_PUSH_RETRIES) {
      return { pushed: false, error: `git push failed after ${MAX_PUSH_RETRIES} attempts: ${detail}` }
    }
  }
  return { pushed: false, error: 'push failed' }
}
