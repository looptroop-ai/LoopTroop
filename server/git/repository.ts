import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
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

const GIT_TIMEOUT_MS = 30_000

const GIT_ENV = {
  ...process.env,
  // Prevent git from blocking on credential prompts or interactive input
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
}

function runGit(
  projectPath: string,
  args: string[],
): string {
  const fullArgs = ['-C', projectPath, ...args]
  const result = spawnSync('git', fullArgs, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: GIT_ENV })
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  if (result.signal === 'SIGTERM') {
    const detail = `git command timed out after ${GIT_TIMEOUT_MS / 1000}s: git ${args.join(' ')}`
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

function gitCommandSucceeds(projectPath: string, args: string[]) {
  const fullArgs = ['-C', projectPath, ...args]
  const result = spawnSync('git', fullArgs, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: GIT_ENV })
  const ok = result.status === 0 && !result.error && result.signal !== 'SIGTERM'
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  if (ok) {
    logCmd('git', fullArgs, { ok: true, stdout: stdout || undefined, stderr: stderr || undefined })
  } else {
    const error = result.signal === 'SIGTERM'
      ? `git command timed out after ${GIT_TIMEOUT_MS / 1000}s`
      : result.error?.message ?? `exit code ${result.status ?? '?'}`
    logCmd('git', fullArgs, {
      ok: false,
      error,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    })
  }
  return ok
}

const LOOP_TROOP_EXCLUDE_RULES = [
  '/.looptroop/',
  '/.ticket/',
] as const

export function getCurrentBranch(projectPath: string): string | null {
  try {
    const branch = runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!branch || branch === 'HEAD') return null
    return branch
  } catch {
    return null
  }
}

export function resolveBaseBranch(projectPath: string): string {
  try {
    const remoteHead = runGit(projectPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    if (remoteHead.startsWith('origin/')) {
      return remoteHead.slice('origin/'.length)
    }
  } catch {
    // Fall back to local inspection below.
  }

  const currentBranch = getCurrentBranch(projectPath)
  if (currentBranch) return currentBranch

  for (const fallback of ['main', 'master']) {
    if (gitCommandSucceeds(projectPath, ['show-ref', '--verify', '--quiet', `refs/heads/${fallback}`])) {
      return fallback
    }
  }

  throw new Error(`Unable to detect the repository base branch for ${projectPath}`)
}

export function resolveBaseBranchRef(projectPath: string, baseBranch: string): string {
  const remoteRef = `origin/${baseBranch}`
  if (gitCommandSucceeds(projectPath, ['show-ref', '--verify', '--quiet', `refs/remotes/${remoteRef}`])) {
    return remoteRef
  }

  if (gitCommandSucceeds(projectPath, ['show-ref', '--verify', '--quiet', `refs/heads/${baseBranch}`])) {
    return baseBranch
  }

  throw new Error(`Base branch ${baseBranch} does not exist in ${projectPath}`)
}

export function tryFetchOrigin(projectPath: string): boolean {
  return gitCommandSucceeds(projectPath, ['fetch', '--no-progress', '--prune', 'origin'])
}

export function ensureLocalGitExclude(projectPath: string, rules: string | readonly string[] = LOOP_TROOP_EXCLUDE_RULES) {
  const excludeGitPath = runGit(projectPath, ['rev-parse', '--git-path', 'info/exclude'])
  const excludePath = resolve(projectPath, excludeGitPath)
  const raw = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  const normalized = raw.replace(/\r\n/g, '\n')
  const existingRules = new Set(normalized.split('\n'))
  const desiredRules = Array.isArray(rules) ? rules : [rules]
  const newline = raw.includes('\r\n') ? '\r\n' : '\n'

  let next = raw
  for (const rule of desiredRules) {
    if (existingRules.has(rule)) continue
    const separator = next.length === 0 || next.endsWith('\n') ? '' : newline
    next = `${next}${separator}${rule}${newline}`
    existingRules.add(rule)
  }
  if (next === raw && raw.length > 0 && !raw.endsWith('\n')) {
    next = `${raw}${newline}`
  }

  if (next !== raw) {
    mkdirSync(dirname(excludePath), { recursive: true })
    writeFileSync(excludePath, next, 'utf8')
  }
}
