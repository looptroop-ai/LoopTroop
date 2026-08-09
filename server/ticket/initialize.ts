import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { applyIgnoreMode, areLoopTroopPathsIgnored, ensureLocalGitExclude, resolveBaseBranchRef, tryFetchOrigin, type IgnoreMode } from '../git/repository'
import { getProjectIgnoreMode } from '../storage/projects'
import {
  detectGitBaseBranch,
  getTicketDir as resolveTicketDir,
  getTicketRuntimeDir,
  getTicketWorktreePath as resolveTicketWorktreePath,
  normalizeFolderPath,
} from '../storage/paths'
import { getTicketBeadsDir, updateTicketMeta } from './metadata'
import { ensureWorktreeOwnerMarker } from '../storage/worktreeOwnership'
import { safeAtomicWrite } from '../io/atomicWrite'
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

interface InitializeOptions {
  externalId: string
  projectFolder: string
}

export interface InitializeTicketResult {
  worktreePath: string
  ticketDir: string
  branchName: string
  baseBranch: string
  reused: boolean
}

export class TicketInitializationError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'TicketInitializationError'
    this.code = code
  }
}

const RUNTIME_GITIGNORE = [
  'runtime/**',
  'locks/**',
  'streams/**',
  'sessions/**',
  'tmp/**',
].join('\n') + '\n'

export function getTicketWorktreePath(projectRoot: string, externalId: string): string {
  return resolveTicketWorktreePath(projectRoot, externalId)
}

export function getTicketDir(projectRoot: string, externalId: string): string {
  return resolveTicketDir(projectRoot, externalId)
}

function runGit(args: string[], cwd: string, code: string, message: string): string {
  const fullArgs = ['-C', cwd, ...args]
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
    throw new TicketInitializationError(code, `${message}: ${detail}`)
  }
  logCmd('git', fullArgs, { ok: true, stdout: stdout || undefined, stderr: stderr || undefined })
  return stdout
}

function gitCommandSucceeds(args: string[], cwd: string): boolean {
  const fullArgs = ['-C', cwd, ...args]
  const result = spawnSync('git', fullArgs, { encoding: 'utf8' })
  const ok = result.status === 0 && !result.error
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  if (ok) {
    logCmd('git', fullArgs, { ok: true, stdout: stdout || undefined, stderr: stderr || undefined })
  } else {
    logCmd('git', fullArgs, {
      ok: false,
      error: result.error?.message ?? `exit code ${result.status ?? '?'}`,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    })
  }
  return ok
}

function resolveGitPath(basePath: string, gitPath: string): string {
  return isAbsolute(gitPath) ? gitPath : resolve(basePath, gitPath)
}

function ensureGitRepo(projectFolder: string) {
  const inside = runGit(
    ['rev-parse', '--is-inside-work-tree'],
    projectFolder,
    'INIT_NOT_GIT_REPO',
    'Project folder is not a git repository',
  )

  if (inside !== 'true') {
    throw new TicketInitializationError('INIT_NOT_GIT_REPO', `Project folder is not a git repository: ${projectFolder}`)
  }
}

function ensureBaseBranch(projectFolder: string, baseBranch: string): string {
  try {
    return resolveBaseBranchRef(projectFolder, baseBranch)
  } catch {
    throw new TicketInitializationError(
      'INIT_BASE_BRANCH_MISSING',
      `Project repository does not have the detected base branch "${baseBranch}": ${projectFolder}`,
    )
  }
}

/**
 * Re-applies the ignore choice the project was attached with.
 *
 * The choice is honoured rather than assumed: a project attached with "skip"
 * manages its own rules and nothing is written for it, and one attached with
 * "repo" must not quietly acquire a `.git/info/exclude` it never asked for.
 */
function ensureLoopTroopGitExclude(projectFolder: string, mode: IgnoreMode) {
  try {
    applyIgnoreMode(projectFolder, mode)
  } catch (err) {
    throw new TicketInitializationError(
      'INIT_LOOPTROOP_EXCLUDE_FAILED',
      `Failed to install the LoopTroop Git ignore rules: ${getErrorMessage(err)}`,
    )
  }
}

/**
 * Guarantees the ticket worktree ignores LoopTroop's runtime directories.
 *
 * A worktree is a separate checkout that `git add -A` runs in, and a repository
 * .gitignore only reaches it once committed — so between attaching a project
 * and pushing that change, the worktree would stage `.looptroop/` and
 * `.ticket/` into the ticket's own branch.
 *
 * The gap is closed through `.git/info/exclude`, which git resolves to the
 * common directory and therefore shares with every worktree. Writing the
 * worktree's own .gitignore would work too, but it would leave an unexplained
 * file in a checkout whose whole purpose is to contain exactly one ticket's
 * changes. Applied only when git says the paths are not already covered, so a
 * repository that has committed its rules is never written to at all.
 */
function ensureWorktreePathsIgnored(worktreePath: string, mode: IgnoreMode) {
  if (mode === 'skip') return
  if (areLoopTroopPathsIgnored(worktreePath)) return

  try {
    ensureLocalGitExclude(worktreePath)
  } catch (err) {
    throw new TicketInitializationError(
      'INIT_LOOPTROOP_EXCLUDE_FAILED',
      `Failed to ignore LoopTroop runtime paths in the ticket worktree: ${getErrorMessage(err)}`,
    )
  }
}

function getTrackedLoopTroopPaths(projectFolder: string): string[] {
  const output = runGit(
    ['ls-files', '-z', '--', '.looptroop'],
    projectFolder,
    'INIT_LOOPTROOP_TRACKED_CHECK_FAILED',
    'Failed to inspect tracked LoopTroop runtime paths',
  )

  return output
    .split('\0')
    .map(path => path.trim())
    .filter(Boolean)
}

function ensureLoopTroopRuntimeUntracked(projectFolder: string) {
  const trackedPaths = getTrackedLoopTroopPaths(projectFolder)
  if (trackedPaths.length === 0) return

  const preview = trackedPaths.slice(0, 5).join(', ')
  const remaining = trackedPaths.length > 5 ? `, and ${trackedPaths.length - 5} more` : ''
  throw new TicketInitializationError(
    'INIT_LOOPTROOP_TRACKED',
    [
      'LoopTroop runtime path ".looptroop" is tracked by Git, so new ticket worktrees would inherit stale LoopTroop data.',
      'Remove it from the index before starting tickets: git rm --cached -r .looptroop && git commit -m "Stop tracking LoopTroop runtime data".',
      `Tracked paths: ${preview}${remaining}`,
    ].join(' '),
  )
}

function branchExists(projectFolder: string, branchName: string): boolean {
  return gitCommandSucceeds(
    ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
    projectFolder,
  )
}

function isValidTicketWorktree(
  projectFolder: string,
  worktreePath: string,
  branchName: string,
): boolean {
  if (!existsSync(worktreePath)) return false
  if (!gitCommandSucceeds(['rev-parse', '--is-inside-work-tree'], worktreePath)) return false

  try {
    const currentBranch = runGit(
      ['branch', '--show-current'],
      worktreePath,
      'INIT_WORKTREE_INVALID',
      'Failed to inspect ticket worktree branch',
    )
    if (currentBranch !== branchName) return false

    const repoCommonDir = runGit(
      ['rev-parse', '--absolute-git-dir'],
      projectFolder,
      'INIT_WORKTREE_INVALID',
      'Failed to inspect project repository git dir',
    )
    const worktreeCommonDir = resolveGitPath(
      worktreePath,
      runGit(
        ['rev-parse', '--git-common-dir'],
        worktreePath,
        'INIT_WORKTREE_INVALID',
        'Failed to inspect ticket worktree common git dir',
      ),
    )

    return realpathSync(repoCommonDir) === realpathSync(worktreeCommonDir)
  } catch {
    return false
  }
}

function isPreStartTicketSkeleton(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false

  const rootEntries = readdirSync(worktreePath, { withFileTypes: true })
  if (rootEntries.length === 0) return true
  if (rootEntries.some(entry => entry.name !== '.ticket')) return false

  return true
}

function preserveTicketSkeleton(worktreePath: string): {
  restore: () => void
  restoreForFailure: () => void
} {
  const ticketPath = resolve(worktreePath, '.ticket')
  if (!existsSync(ticketPath)) {
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true })
    }
    return {
      restore: () => {},
      restoreForFailure: () => {},
    }
  }

  const tempRoot = mkdtempSync(resolve(tmpdir(), 'looptroop-ticket-skeleton-'))
  const preservedTicketPathLocal = resolve(tempRoot, '.ticket')
  cpSync(ticketPath, preservedTicketPathLocal, { recursive: true })
  rmSync(worktreePath, { recursive: true, force: true })

  const restoreTicket = () => {
    if (existsSync(ticketPath)) {
      rmSync(ticketPath, { recursive: true, force: true })
    }
    cpSync(preservedTicketPathLocal, ticketPath, { recursive: true })
    rmSync(tempRoot, { recursive: true, force: true })
  }

  return {
    restore: restoreTicket,
    restoreForFailure: restoreTicket,
  }
}

function ensureTicketDirectories(
  projectRoot: string,
  externalId: string,
  ticketDir: string,
  baseBranch: string,
) {
  const runtimeDir = resolve(ticketDir, 'runtime')
  const dirs = [
    ticketDir,
    resolve(ticketDir, 'meta'),
    resolve(ticketDir, 'approvals'),
    runtimeDir,
    resolve(runtimeDir, 'streams'),
    resolve(runtimeDir, 'sessions'),
    resolve(runtimeDir, 'locks'),
    resolve(runtimeDir, 'tmp'),
    getTicketBeadsDir(projectRoot, externalId, baseBranch),
  ]

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
  }
}

function writeRuntimeGitignore(ticketDir: string) {
  safeAtomicWrite(resolve(ticketDir, '.gitignore'), RUNTIME_GITIGNORE)
}

function buildWorktreeAddArgs(
  projectFolder: string,
  worktreePath: string,
  branchName: string,
  baseBranchRef: string,
): string[] {
  return branchExists(projectFolder, branchName)
    ? ['worktree', 'add', worktreePath, branchName]
    : ['worktree', 'add', '-b', branchName, worktreePath, baseBranchRef]
}

function materializeWorktree(
  projectFolder: string,
  worktreePath: string,
  branchName: string,
  baseBranchRef: string,
) {
  if (!existsSync(worktreePath)) {
    const args = buildWorktreeAddArgs(projectFolder, worktreePath, branchName, baseBranchRef)
    runGit(args, projectFolder, 'INIT_WORKTREE_CREATE_FAILED', 'Failed to create ticket worktree')
    return
  }

  if (isValidTicketWorktree(projectFolder, worktreePath, branchName)) {
    return
  }

  if (!isPreStartTicketSkeleton(worktreePath)) {
    throw new TicketInitializationError(
      'INIT_WORKTREE_PATH_INVALID',
      `Reserved ticket path is not reusable for worktree creation: ${worktreePath}`,
    )
  }

  // Resolve all logged git probes before the reserved skeleton is removed.
  const args = buildWorktreeAddArgs(projectFolder, worktreePath, branchName, baseBranchRef)
  const preserved = preserveTicketSkeleton(worktreePath)
  try {
    runGit(args, projectFolder, 'INIT_WORKTREE_CREATE_FAILED', 'Failed to create ticket worktree')
    preserved.restore()
  } catch (err) {
    preserved.restoreForFailure()
    throw err
  }
}

export function initializeTicket(options: InitializeOptions): InitializeTicketResult {
  const branchName = options.externalId
  // Callers may pass an uncanonicalised folder; normalising here keeps every
  // derived path byte-identical to the project root stored at attach time.
  const projectFolder = normalizeFolderPath(options.projectFolder)
  ensureGitRepo(projectFolder)
  tryFetchOrigin(projectFolder)
  const baseBranch = detectGitBaseBranch(projectFolder)
  const baseBranchRef = ensureBaseBranch(projectFolder, baseBranch)
  const worktreePath = getTicketWorktreePath(projectFolder, options.externalId)
  const ticketDir = getTicketDir(projectFolder, options.externalId)

  const ignoreMode = getProjectIgnoreMode(projectFolder)
  ensureLoopTroopGitExclude(projectFolder, ignoreMode)
  ensureLoopTroopRuntimeUntracked(projectFolder)
  const reused = isValidTicketWorktree(projectFolder, worktreePath, branchName)
  if (!reused) {
    materializeWorktree(projectFolder, worktreePath, branchName, baseBranchRef)
  }

  if (!isValidTicketWorktree(projectFolder, worktreePath, branchName)) {
    throw new TicketInitializationError(
      'INIT_WORKTREE_INVALID',
      `Ticket worktree is invalid after initialization: ${worktreePath}`,
    )
  }

  // The worktree gets the same guarantee as the project it came from, by
  // whichever mechanism reaches it without leaving a file behind.
  ensureWorktreePathsIgnored(worktreePath, ignoreMode)

  ensureTicketDirectories(projectFolder, options.externalId, ticketDir, baseBranch)
  mkdirSync(getTicketRuntimeDir(projectFolder, options.externalId), { recursive: true })
  writeRuntimeGitignore(ticketDir)
  // Written after the ignore rules, so the marker is already excluded by the
  // time it exists and never shows up as an untracked file on the branch.
  ensureWorktreeOwnerMarker(worktreePath, {
    projectRoot: projectFolder,
    externalId: options.externalId,
  })
  updateTicketMeta(projectFolder, options.externalId, { baseBranch })

  return {
    worktreePath,
    ticketDir,
    branchName,
    baseBranch,
    reused,
  }
}
