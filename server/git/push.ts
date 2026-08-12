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

/**
 * Lets `git push` use the token `gh` was given, when there is nothing else.
 *
 * `gh` reads `GH_TOKEN` from the environment; git does not. Prompting is off
 * here by design, so on a machine whose only credential is that variable — a
 * container being the obvious one — every `gh` call works and the push that
 * follows fails asking for a password it cannot request. Pointing git at `gh`'s
 * own credential helper closes that gap without writing anything to disk.
 *
 * Appended after whatever the machine already configures, never replacing it:
 * git tries helpers in order and stops at the first that answers, so an existing
 * working setup still wins and this is only reached when nothing else replies.
 * Silent when there is no token, and silent when `gh` is not installed — adding
 * a helper that cannot run would turn a clear "no credentials" into a confusing
 * helper failure.
 */
function ghCredentialEnv(): NodeJS.ProcessEnv {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return {}
  if (!ghIsInstalled()) return {}

  // Placed after any GIT_CONFIG_* pairs the environment already carries, rather
  // than at index 0, so this adds a helper instead of overwriting one.
  const existing = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10)
  const index = Number.isInteger(existing) && existing > 0 ? existing : 0
  return {
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${index}`]: '!gh auth git-credential',
  }
}

// Only the subprocess is remembered. Whether `gh` is installed cannot change
// while the daemon runs, but which token is in the environment can, so the
// decision itself is made fresh on every push.
let ghInstalled: boolean | null = null

function ghIsInstalled(): boolean {
  if (ghInstalled === null) {
    const probe = spawnSync('gh', ['--version'], { encoding: 'utf8', timeout: 10_000 })
    ghInstalled = !probe.error && probe.status === 0
  }
  return ghInstalled
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    ...ghCredentialEnv(),
  }
}

function runGit(projectPath: string, args: string[]): string {
  const fullArgs = ['-C', projectPath, ...args]
  const result = spawnSync('git', fullArgs, { encoding: 'utf8', timeout: GIT_PUSH_TIMEOUT_MS, env: gitEnv() })
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
