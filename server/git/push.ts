import { getErrorMessage } from '@shared/typeGuards'
import { runCommandSync, runGitOrThrow } from './runCommand'

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
    // Local and memoised, so this one stays synchronous: it answers from the
    // machine, never the network, and only ever runs once per daemon.
    ghInstalled = runCommandSync('gh', ['--version'], { timeoutMs: 10_000, log: false }).ok
  }
  return ghInstalled
}

function gitEnv(): NodeJS.ProcessEnv {
  return { ...ghCredentialEnv() }
}

/**
 * Every command in this module reaches the remote, so all of them are async:
 * a stalled push or `ls-remote` would otherwise hold the daemon thread for the
 * full two minutes.
 */
function runGit(projectPath: string, args: string[]): Promise<string> {
  return runGitOrThrow(projectPath, args, { timeoutMs: GIT_PUSH_TIMEOUT_MS, env: gitEnv() })
}

export interface PushBranchRefResult {
  pushed: boolean
  error?: string
}

/**
 * How many times a `git push` is attempted before the failure is reported.
 *
 * A push is the one git operation that reaches a network, and the reason it
 * fails is usually transient. Shared with `pushSquashedCandidate`, which runs
 * its own loop against the same remote: two retry counts for the same operation
 * is one of them being wrong.
 */
export const GIT_PUSH_MAX_RETRIES = 3

interface PushBranchRefParams {
  projectPath: string
  destinationBranch: string
  sourceRef?: string
  remote?: string
  forceWithLease?: boolean
  maxRetries?: number
  bypassHooks?: boolean
}

async function readRemoteBranchSha(projectPath: string, remote: string, branch: string): Promise<string | null> {
  const stdout = await runGit(projectPath, ['ls-remote', '--heads', remote, `refs/heads/${branch}`])
  const [line] = stdout.split('\n').filter(Boolean)
  if (!line) return null

  const [sha] = line.split(/\s+/)
  return sha?.trim() || null
}

export async function pushBranchRef({
  projectPath,
  destinationBranch,
  sourceRef = 'HEAD',
  remote = 'origin',
  forceWithLease = false,
  maxRetries = GIT_PUSH_MAX_RETRIES,
  bypassHooks = false,
}: PushBranchRefParams): Promise<PushBranchRefResult> {
  const refspec = `${sourceRef}:refs/heads/${destinationBranch}`
  let leaseArg: string[] = []

  try {
    if (forceWithLease) {
      const expectedRemoteSha = await readRemoteBranchSha(projectPath, remote, destinationBranch)
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
      await runGit(projectPath, ['push', ...(bypassHooks ? ['--no-verify'] : []), ...leaseArg, remote, refspec])
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
