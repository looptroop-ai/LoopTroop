import { spawnSync } from 'node:child_process'
import { getErrorMessage } from '@shared/typeGuards'
import * as commandLogger from '../log/commandLogger'

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

const GIT_PUSH_TIMEOUT_MS = 120_000

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
}

function runGit(projectPath: string, args: string[]): string {
  const fullArgs = ['-C', projectPath, ...args]
  const result = spawnSync('git', fullArgs, { encoding: 'utf8', timeout: GIT_PUSH_TIMEOUT_MS, env: GIT_ENV })
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()

  if (result.signal === 'SIGTERM') {
    const detail = `git command timed out after ${GIT_PUSH_TIMEOUT_MS / 1000}s: git ${args.join(' ')}`
    logCmd('git', fullArgs, { ok: false, error: detail })
    throw new Error(detail)
  }

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

export interface PushBranchRefResult {
  pushed: boolean
  error?: string
}

interface PushBranchRefParams {
  projectPath: string
  destinationBranch: string
  sourceRef?: string
  remote?: string
  forceWithLease?: boolean
  maxRetries?: number
  bypassHooks?: boolean
}

function readRemoteBranchSha(projectPath: string, remote: string, branch: string): string | null {
  const stdout = runGit(projectPath, ['ls-remote', '--heads', remote, `refs/heads/${branch}`])
  const [line] = stdout.split('\n').filter(Boolean)
  if (!line) return null

  const [sha] = line.split(/\s+/)
  return sha?.trim() || null
}

export function pushBranchRef({
  projectPath,
  destinationBranch,
  sourceRef = 'HEAD',
  remote = 'origin',
  forceWithLease = false,
  maxRetries = 3,
  bypassHooks = false,
}: PushBranchRefParams): PushBranchRefResult {
  const refspec = `${sourceRef}:refs/heads/${destinationBranch}`
  let leaseArg: string[] = []

  try {
    if (forceWithLease) {
      const expectedRemoteSha = readRemoteBranchSha(projectPath, remote, destinationBranch)
      leaseArg = [`--force-with-lease=refs/heads/${destinationBranch}:${expectedRemoteSha ?? ''}`]
    }
  } catch (error) {
    return {
      pushed: false,
      error: getErrorMessage(error),
    }
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      runGit(projectPath, ['push', ...(bypassHooks ? ['--no-verify'] : []), ...leaseArg, remote, refspec])
      return { pushed: true }
    } catch (error) {
      const detail = getErrorMessage(error)
      if (attempt === maxRetries) {
        return {
          pushed: false,
          error: `git push failed after ${maxRetries} attempts: ${detail}`,
        }
      }
    }
  }

  return { pushed: false, error: 'push failed' }
}
