import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { resolve } from 'node:path'
import { clearStaleDaemonState, readDaemonState } from '../lib/daemonPaths'
import { matchProcess } from '../lib/processIdentity'
import { getProjectWorktreesRoot, normalizeFolderPath } from '../storage/paths'
import { markerVouchesFor, readWorktreeOwnerMarker } from '../storage/worktreeOwnership'
import { isProcessAlive, killProcessTree, waitForExit } from './processControl'
import { readRunningDaemon } from './commands'

export interface CleanOptions {
  apply: boolean
  configDir?: string
}

export interface WorktreeCandidate {
  path: string
  projectRoot: string
  worktreesRoot: string
  /** True only when every guard below has cleared it for removal. */
  removable: boolean
  /** Why it may be removed, or why it may not. */
  reason: string
}

/**
 * How recently a worktree may have been touched and still be treated as live.
 *
 * `clean` refuses to run at all while a daemon is up, so this only has to cover
 * the seam: a worktree is created on disk before `git worktree add` registers
 * it, so a directory that is moments old may be one that is being born rather
 * than one that was abandoned.
 */
const LIVE_WINDOW_MS = 10 * 60_000

/** Long enough for OpenCode to close its listeners, short enough to not hang. */
const OPENCODE_GRACEFUL_MS = 5_000

/** Matched against when deciding whether the closing advice is worth printing. */
const NO_MARKER_REASON = 'no LoopTroop ownership marker'

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * The worktrees this repository still knows about, canonicalised.
 *
 * Read once per project rather than once per directory: the answer cannot change
 * while a single run walks one directory, and comparing canonical paths matters
 * because git prints its own realpath — on macOS a stored /var path and git's
 * /private/var answer are the same directory and must not read as two.
 */
function readRegisteredWorktrees(projectRoot: string): Set<string> {
  const listed = git(projectRoot, ['worktree', 'list', '--porcelain'])
  if (listed === null) return new Set()

  const registered = new Set<string>()
  for (const line of listed.split('\n')) {
    if (!line.startsWith('worktree ')) continue
    registered.add(normalizeFolderPath(line.slice('worktree '.length)))
  }
  return registered
}

function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * The most recent sign of life, from whichever of three places is newest: when
 * LoopTroop first created the directory, when its top level last changed, and
 * when the runtime directory a working ticket writes into last changed.
 */
function lastActivityAt(worktreePath: string, createdAt: string): number {
  const created = Date.parse(createdAt)
  return Math.max(
    Number.isNaN(created) ? 0 : created,
    modifiedAt(worktreePath),
    modifiedAt(resolve(worktreePath, '.ticket', 'runtime')),
  )
}

/** True when nothing but LoopTroop's own ticket skeleton is present. */
function holdsOnlyTicketSkeleton(worktreePath: string): boolean {
  try {
    return readdirSync(worktreePath, { withFileTypes: true })
      .every((entry) => entry.name === '.ticket')
  } catch {
    return false
  }
}

/**
 * Refuses to delete work that may not exist anywhere else. Uncommitted changes,
 * unpushed commits, and untracked files are all unrecoverable once a worktree is
 * removed, so any of them blocks automatic cleanup.
 *
 * The first question is which repository the directory belongs to, and it has to
 * be asked explicitly. A directory that is not a working tree at all still sits
 * inside the project's own repository, so git run from inside it answers about
 * the project — a clean project would clear a directory nothing is known about,
 * and a dirty one would block every directory at once.
 *
 * A directory that is nobody's working tree holds no commits and no index, so
 * there is nothing to lose — but only once it is clear it holds nothing beyond
 * the skeleton LoopTroop put there. Anything else in it is somebody's file, and
 * no history exists to check it against.
 */
function classifyGitState(worktreePath: string): { blocker: string | null } {
  const toplevel = git(worktreePath, ['rev-parse', '--show-toplevel'])
  const isOwnWorkTree = toplevel !== null
    && normalizeFolderPath(toplevel) === normalizeFolderPath(worktreePath)

  if (!isOwnWorkTree) {
    return holdsOnlyTicketSkeleton(worktreePath)
      ? { blocker: null }
      : { blocker: 'not a git worktree, and it holds files of its own' }
  }

  const status = git(worktreePath, ['status', '--porcelain'])
  if (status === null) return { blocker: 'cannot read its git status' }
  if (status !== '') return { blocker: 'has uncommitted or untracked changes' }

  const upstream = git(worktreePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (upstream === null) return { blocker: 'branch has no upstream, so commits exist only here' }

  const unpushed = git(worktreePath, ['rev-list', '--count', '@{upstream}..HEAD'])
  if (unpushed === null) return { blocker: 'cannot compare against upstream' }
  if (unpushed !== '0') return { blocker: `has ${unpushed} unpushed commit(s)` }

  return { blocker: null }
}

export interface CleanupTarget {
  projectRoot: string
  /**
   * External ids of tickets that are finished. Their worktrees are debris even
   * though git still lists them: a daemon that died mid-run never got to remove
   * them, and nothing will ever open them again.
   */
  closedTicketIds?: readonly string[]
}

/**
 * Decides what `clean` would do to each directory under a project's worktrees
 * root, without touching any of it.
 *
 * Takes its targets rather than reading them itself, so the decisions can be
 * exercised against real repositories without an app database behind them.
 */
export function planWorktreeCleanup(
  targets: readonly CleanupTarget[],
  options: { now?: number } = {},
): WorktreeCandidate[] {
  const now = options.now ?? Date.now()
  const candidates: WorktreeCandidate[] = []

  for (const target of targets) {
    const projectRoot = normalizeFolderPath(target.projectRoot)
    const worktreesRoot = getProjectWorktreesRoot(projectRoot)
    if (!existsSync(worktreesRoot)) continue

    let entries: Dirent[]
    try {
      entries = readdirSync(worktreesRoot, { withFileTypes: true })
    } catch {
      continue
    }

    const registered = readRegisteredWorktrees(projectRoot)
    const closed = new Set(target.closedTicketIds ?? [])

    for (const entry of entries) {
      // A symlink reports itself, not its target, so this never walks out of the
      // managed root by following one.
      if (!entry.isDirectory()) continue

      const worktreePath = resolve(worktreesRoot, entry.name)
      const isRegistered = registered.has(normalizeFolderPath(worktreePath))
      const isClosed = closed.has(entry.name)
      // Registered and not finished: git still knows it and so might a ticket.
      if (isRegistered && !isClosed) continue

      const base = { path: worktreePath, projectRoot, worktreesRoot }
      const found = isRegistered ? 'its ticket is finished' : 'not registered with git'

      // Ownership first: without proof LoopTroop made this directory, no later
      // check is worth running, because none of them establish whose it is.
      const marker = readWorktreeOwnerMarker(worktreePath)
      if (marker === null) {
        candidates.push({ ...base, removable: false, reason: NO_MARKER_REASON })
        continue
      }
      if (!markerVouchesFor(marker, { projectRoot, externalId: entry.name })) {
        candidates.push({
          ...base,
          removable: false,
          reason: 'its ownership marker describes a different worktree',
        })
        continue
      }

      const idleMs = now - lastActivityAt(worktreePath, marker.createdAt)
      if (idleMs < LIVE_WINDOW_MS) {
        candidates.push({
          ...base,
          removable: false,
          reason: `changed ${Math.max(0, Math.round(idleMs / 1_000))}s ago, so it may still be in use`,
        })
        continue
      }

      const { blocker } = classifyGitState(worktreePath)
      candidates.push(blocker === null
        ? { ...base, removable: true, reason: found }
        : { ...base, removable: false, reason: blocker })
    }
  }

  return candidates
}


export type OpenCodeVerdict =
  | { kind: 'nothing', detail: string }
  | { kind: 'stoppable', pid: number }
  | { kind: 'kept', pid: number, reason: string }

/**
 * Whether the daemon record names an OpenCode server that outlived it.
 *
 * A killed daemon runs no cleanup, and OpenCode is spawned into its own process
 * group precisely so that killing the daemon's group does not take it down — so
 * the server keeps running and keeps the port. That makes it debris worth
 * reaping, and also the most dangerous thing in this file: the pid comes from a
 * JSON file that may be days old, and by now it may name anything at all.
 * Nothing is signalled unless the recorded start identity still matches.
 */
export function inspectOrphanedOpenCode(configDir?: string): OpenCodeVerdict {
  const state = readDaemonState(configDir)
  if (state === null) return { kind: 'nothing', detail: 'no daemon record' }

  const opencode = state.opencode
  if (opencode === undefined) return { kind: 'nothing', detail: 'no OpenCode server recorded' }
  if (!opencode.owned) {
    return { kind: 'nothing', detail: 'the recorded OpenCode server was already running, so it is not ours to stop' }
  }

  const pid = opencode.pid
  if (pid === undefined) return { kind: 'nothing', detail: 'the recorded OpenCode server has no pid' }
  if (!isProcessAlive(pid)) return { kind: 'nothing', detail: 'the recorded OpenCode server has already exited' }

  const match = matchProcess(pid, opencode.startToken)
  switch (match.kind) {
    case 'same':
      return { kind: 'stoppable', pid }
    case 'different':
      return { kind: 'kept', pid, reason: 'that pid now belongs to a different process' }
    default:
      return { kind: 'kept', pid, reason: match.reason }
  }
}

/**
 * SIGTERM to the group first, as the supervisor's own stop does: OpenCode leads
 * the group, so this reaches anything it started. Escalation is bounded, and the
 * identity is re-checked before each signal because the process may exit between
 * the decision and the delivery — and the pid could then be reused.
 */
async function stopOpenCode(pid: number, startToken: string | undefined): Promise<boolean> {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Exited between the check and the signal.
      }
    }
    if (await waitForExit(pid, OPENCODE_GRACEFUL_MS)) return true
  }

  if (matchProcess(pid, startToken).kind !== 'same') return !isProcessAlive(pid)
  await killProcessTree(pid)
  return await waitForExit(pid, OPENCODE_GRACEFUL_MS)
}

async function removeCandidates(candidates: WorktreeCandidate[]): Promise<number> {
  const { removeWorktree } = await import('../git/worktreeRemoval')
  let removed = 0

  for (const candidate of candidates) {
    try {
      removeWorktree({
        projectRoot: candidate.projectRoot,
        worktreesRoot: candidate.worktreesRoot,
        worktreePath: candidate.path,
      })
      removed += 1
    } catch (error) {
      process.stderr.write(
        `Failed to remove ${candidate.path}: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }

  return removed
}

export async function cleanCommand(options: CleanOptions): Promise<number> {
  // A running daemon may be mid-ticket in one of these worktrees.
  const daemon = await readRunningDaemon(options.configDir)
  if (daemon) {
    process.stderr.write(
      `LoopTroop is running (pid ${daemon.pid}). Stop it first with \`looptroop stop\`, ` +
      'so cleanup cannot remove a worktree that is in use.\n',
    )
    return 1
  }

  // A daemon that is alive but not answering is still a daemon holding
  // worktrees, and `readRunningDaemon` reports only the ones that answer.
  const recorded = readDaemonState(options.configDir)
  if (recorded !== null && isProcessAlive(recorded.pid)) {
    process.stderr.write(
      `A LoopTroop process (pid ${recorded.pid}) is still alive but not answering. ` +
      'Stop it with `looptroop stop` before cleaning up.\n',
    )
    return 1
  }

  const { listProjects, listClosedTicketIds } = await import('../storage/projects')
  const candidates = planWorktreeCleanup(listProjects().map((project) => ({
    projectRoot: project.folderPath,
    closedTicketIds: listClosedTicketIds(project.folderPath),
  })))
  const orphan = inspectOrphanedOpenCode(options.configDir)

  if (candidates.length === 0 && orphan.kind === 'nothing') {
    process.stdout.write('Nothing to clean.\n')
    return 0
  }

  const removable = candidates.filter((candidate) => candidate.removable)
  const kept = candidates.filter((candidate) => !candidate.removable)

  for (const candidate of removable) {
    process.stdout.write(`  ${options.apply ? 'removing' : 'would remove'}  ${candidate.path}  (${candidate.reason})\n`)
  }
  for (const candidate of kept) {
    process.stdout.write(`  keeping   ${candidate.path}  (${candidate.reason})\n`)
  }
  if (orphan.kind === 'stoppable') {
    process.stdout.write(`  ${options.apply ? 'stopping' : 'would stop'}  OpenCode server (pid ${orphan.pid}), orphaned by a daemon that did not shut down\n`)
  }
  if (orphan.kind === 'kept') {
    process.stdout.write(`  keeping   OpenCode server (pid ${orphan.pid})  (${orphan.reason})\n`)
  }

  if (!options.apply) {
    process.stdout.write(
      `\n${removable.length} worktree(s) would be removed. Re-run with --apply to act.\n`,
    )
    if (kept.some((candidate) => candidate.reason === NO_MARKER_REASON)) {
      process.stdout.write(
        'Worktrees without an ownership marker predate this check or were not created by LoopTroop. ' +
        'Remove them by hand if you are sure they are yours to delete.\n',
      )
    }
    return 0
  }

  const removed = await removeCandidates(removable)
  process.stdout.write(`\nRemoved ${removed} worktree(s).\n`)

  if (orphan.kind === 'stoppable') {
    const stopped = await stopOpenCode(orphan.pid, recorded?.opencode?.startToken)
    process.stdout.write(stopped
      ? `Stopped the orphaned OpenCode server (pid ${orphan.pid}).\n`
      : `Could not stop the orphaned OpenCode server (pid ${orphan.pid}).\n`)
    // The record described a daemon that is gone and a server that is now gone
    // with it, so leaving it would point the next run at a recycled pid.
    if (stopped) clearStaleDaemonState(options.configDir)
  }

  return removed === removable.length ? 0 : 1
}
