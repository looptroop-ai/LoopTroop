import { existsSync, mkdirSync, realpathSync } from 'fs'
import { isAbsolute, join, resolve, win32 } from 'path'
import { resolveBaseBranch } from '../git/repository'
import { runGitSync } from '../git/runCommand'
import { ContainedPathError, resolveContainedPath } from '../lib/containedPath'
import { resolveProjectTicketContainedPath } from '../ticket/containedPath'
export function normalizeFolderPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new ContainedPathError('Project path must be absolute')
  }

  let output = input
  if (process.platform === 'win32') {
    if (!win32.isAbsolute(output)) throw new ContainedPathError('Project path must be absolute')
    const root = win32.parse(output).root
    const stripped = output.replace(/[\\/]+$/, '')
    output = !stripped || stripped === root.replace(/[\\/]+$/, '') ? root : stripped
    output = output.replace(/\\/g, '/')
  } else {
    const driveMatch = output.match(/^([A-Za-z]):[\\/]/)
    if (driveMatch) {
      // WSL drive mounts are supported only when the mount exists; a POSIX
      // host must not silently reinterpret a relative-looking Windows path.
      const mount = `/mnt/${driveMatch[1]!.toLowerCase()}`
      if (!existsSync(mount)) throw new ContainedPathError('Project path must be absolute')
      output = join(mount, output.slice(3).replace(/\\/g, '/'))
    } else {
      if (!isAbsolute(output)) throw new ContainedPathError('Project path must be absolute')
      output = output.replace(/\/+$/, '') || '/'
    }
  }
  // Canonicalise symlinks so one directory always compares equal to itself:
  // macOS maps /var to /private/var and Windows keeps 8.3 short names such as
  // RUNNER~1, so a stored path and the output of `git rev-parse --show-toplevel`
  // otherwise disagree. `.native` is required for the 8.3 expansion.
  try {
    output = realpathSync.native(output)
  } catch {
    // Not created yet, so the lexical form is the best available answer.
  }
  // Last: resolve() and realpathSync() both emit backslashes on Windows, and
  // this function's contract is forward slashes throughout.
  return process.platform === 'win32' ? output.replace(/\\/g, '/') : output
}

export function resolveGitRepoRoot(folderPath: string): string | null {
  const normalized = normalizeFolderPath(folderPath)
  if (!existsSync(normalized)) return null
  const result = runGitSync(normalized, ['rev-parse', '--show-toplevel'])
  if (!result.ok) return null
  return normalizeFolderPath(result.stdout)
}

export function detectGitBaseBranch(projectRoot: string): string {
  return resolveBaseBranch(projectRoot)
}

export function getProjectLoopTroopDir(projectRoot: string): string {
  return resolve(projectRoot, '.looptroop')
}

export function getProjectDbPath(projectRoot: string): string {
  return resolve(getProjectLoopTroopDir(projectRoot), 'db.sqlite')
}

export function getProjectWorktreesRoot(projectRoot: string): string {
  return resolve(getProjectLoopTroopDir(projectRoot), 'worktrees')
}

/** Validate an entry name without following the final worktree alias. */
export function getTicketWorktreeEntryPath(projectRoot: string, externalId: string): string {
  if (!externalId || externalId === '.' || externalId === '..' || /[\\/\0:]/.test(externalId)) {
    throw new ContainedPathError('Invalid ticket path')
  }
  return resolve(getProjectWorktreesRoot(projectRoot), externalId)
}

export function getTicketWorktreePath(projectRoot: string, externalId: string): string {
  // Trust the project, never a worktrees directory that may have been replaced by a link.
  const worktreePath = getTicketWorktreeEntryPath(projectRoot, externalId)
  resolveContainedPath(projectRoot, worktreePath, {
    allowMissingParents: true,
  })
  // Preserve the entry's identity: cleanup must unlink a worktree alias, not delete its destination.
  return worktreePath
}

export function getTicketDir(projectRoot: string, externalId: string): string {
  return resolveProjectTicketContainedPath(projectRoot, externalId, '.')
}

export function getTicketRuntimeDir(projectRoot: string, externalId: string): string {
  return resolveProjectTicketContainedPath(projectRoot, externalId, 'runtime')
}

export function getTicketExecutionLogPath(projectRoot: string, externalId: string): string {
  return resolveProjectTicketContainedPath(projectRoot, externalId, 'runtime/execution-log.jsonl')
}

export function getTicketDebugLogPath(projectRoot: string, externalId: string): string {
  return resolveProjectTicketContainedPath(projectRoot, externalId, 'runtime/execution-log.debug.jsonl')
}

export function getTicketAiLogPath(projectRoot: string, externalId: string): string {
  return resolveProjectTicketContainedPath(projectRoot, externalId, 'runtime/execution-log.ai.jsonl')
}

export function getTicketExecutionSetupDir(projectRoot: string, externalId: string): string {
  return resolveProjectTicketContainedPath(projectRoot, externalId, 'runtime/execution-setup')
}

export function getTicketExecutionSetupProfilePath(projectRoot: string, externalId: string): string {
  return resolveProjectTicketContainedPath(projectRoot, externalId, 'runtime/execution-setup-profile.json')
}

export function ensureProjectStorageDirs(projectRoot: string) {
  mkdirSync(getProjectLoopTroopDir(projectRoot), { recursive: true })
  mkdirSync(getProjectWorktreesRoot(projectRoot), { recursive: true })
}
