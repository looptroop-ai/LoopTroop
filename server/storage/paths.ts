import { existsSync, mkdirSync, realpathSync } from 'fs'
import { isAbsolute, resolve, win32 } from 'path'
import { resolveBaseBranch } from '../git/repository'
import { runGitSync } from '../git/runCommand'
import { ContainedPathError, resolveContainedPath } from '../lib/containedPath'
import { resolveProjectTicketContainedPath } from '../ticket/containedPath'

function trimTrailingSeparators(input: string, windows = process.platform === 'win32'): string {
  let end = input.length
  while (end > 0 && (input[end - 1] === '/' || (windows && input[end - 1] === '\\'))) end -= 1
  return input.slice(0, end)
}

export function normalizeFolderPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new ContainedPathError('Project path must be absolute')
  }

  let output = input
  if (process.platform === 'win32') {
    if (!win32.isAbsolute(output)) throw new ContainedPathError('Project path must be absolute')
    const root = win32.parse(output).root
    const stripped = trimTrailingSeparators(output)
    const rootWithoutSeparators = trimTrailingSeparators(root, true)
    output = !stripped || stripped === rootWithoutSeparators ? root : stripped
    output = output.split('\\').join('/')
  } else {
    const driveMatch = output.match(/^([A-Za-z]):[\\/]/)
    if (driveMatch) {
      // WSL drive mounts are supported only when the mount exists; a POSIX
      // host must not silently reinterpret a relative-looking Windows path.
      const mount = `/mnt/${driveMatch[1]!.toLowerCase()}`
      if (!existsSync(mount)) throw new ContainedPathError('Project path must be absolute')
      const mapped = resolve(mount, output.slice(3).split('\\').join('/'))
      const mountRoot = resolve(mount)
      if (mapped !== mountRoot && !mapped.startsWith(`${mountRoot}/`)) {
        throw new ContainedPathError('Project path must stay within its drive mount')
      }
      output = mapped
    } else {
      if (!isAbsolute(output)) throw new ContainedPathError('Project path must be absolute')
      output = trimTrailingSeparators(output) || '/'
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
  return process.platform === 'win32' ? output.split('\\').join('/') : output
}

export function resolveGitRepoRoot(folderPath: string): string | null {
  const normalized = normalizeFolderPath(folderPath)
  if (!existsSync(normalized)) return null
  const result = runGitSync(normalized, ['rev-parse', '--show-toplevel'], { trimOutput: false })
  if (!result.ok) return null
  let output = result.stdout
  // Git terminates POSIX output with LF; a preceding CR is a legal POSIX
  // filename byte and must remain part of the repository path. Windows Git
  // emits CRLF, but Windows itself cannot represent a trailing CR in a name.
  if (output.endsWith('\n')) output = output.slice(0, -1)
  if (process.platform === 'win32' && output.endsWith('\r')) output = output.slice(0, -1)
  return normalizeFolderPath(output)
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
