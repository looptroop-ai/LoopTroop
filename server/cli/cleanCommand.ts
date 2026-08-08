import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { readRunningDaemon } from './commands'

export interface CleanOptions {
  apply: boolean
}

interface Candidate {
  path: string
  reason: string
  /** Populated when the worktree must not be removed automatically. */
  blocker?: string
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * Refuses to delete work that may not exist anywhere else. Uncommitted changes,
 * unpushed commits, and untracked files are all unrecoverable once a worktree
 * is removed, so any of them blocks automatic cleanup.
 */
function findBlocker(worktree: string): string | null {
  const status = git(worktree, ['status', '--porcelain'])
  if (status === null) return 'not a readable git worktree'
  if (status !== '') return 'has uncommitted or untracked changes'

  const upstream = git(worktree, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (upstream === null) return 'branch has no upstream, so commits exist only here'

  const unpushed = git(worktree, ['rev-list', '--count', '@{upstream}..HEAD'])
  if (unpushed === null) return 'cannot compare against upstream'
  if (unpushed !== '0') return `has ${unpushed} unpushed commit(s)`

  return null
}

async function collectCandidates(): Promise<Candidate[]> {
  const { listProjects } = await import('../storage/projects')
  const { getProjectWorktreesRoot } = await import('../storage/paths')
  const { readdirSync } = await import('node:fs')

  const candidates: Candidate[] = []

  for (const project of listProjects()) {
    const worktreesRoot = getProjectWorktreesRoot(project.folderPath)
    if (!existsSync(worktreesRoot)) continue

    let entries: string[]
    try {
      entries = readdirSync(worktreesRoot)
    } catch {
      continue
    }

    for (const entry of entries) {
      const worktreePath = resolve(worktreesRoot, entry)
      if (!statSync(worktreePath).isDirectory()) continue

      // A worktree git no longer lists has been pruned or abandoned.
      const registered = git(project.folderPath, ['worktree', 'list', '--porcelain'])
      if (registered?.includes(worktreePath)) continue

      const blocker = findBlocker(worktreePath)
      candidates.push({
        path: worktreePath,
        reason: 'not registered with git',
        ...(blocker ? { blocker } : {}),
      })
    }
  }

  return candidates
}

export async function cleanCommand(options: CleanOptions): Promise<number> {
  // A running daemon may be mid-ticket in one of these worktrees.
  const daemon = await readRunningDaemon()
  if (daemon) {
    process.stderr.write(
      `LoopTroop is running (pid ${daemon.pid}). Stop it first with \`looptroop stop\`, ` +
      'so cleanup cannot remove a worktree that is in use.\n',
    )
    return 1
  }

  const candidates = await collectCandidates()

  if (candidates.length === 0) {
    process.stdout.write('Nothing to clean.\n')
    return 0
  }

  const removable = candidates.filter((candidate) => !candidate.blocker)
  const blocked = candidates.filter((candidate) => candidate.blocker)

  for (const candidate of removable) {
    process.stdout.write(`  ${options.apply ? 'removing' : 'would remove'}  ${candidate.path}  (${candidate.reason})\n`)
  }
  for (const candidate of blocked) {
    process.stdout.write(`  keeping   ${candidate.path}  (${candidate.blocker})\n`)
  }

  if (!options.apply) {
    process.stdout.write(
      `\n${removable.length} worktree(s) would be removed. Re-run with --apply to remove them.\n`,
    )
    return 0
  }

  const { rmSync } = await import('node:fs')
  let removed = 0
  for (const candidate of removable) {
    try {
      rmSync(candidate.path, { recursive: true, force: true })
      removed += 1
    } catch (error) {
      process.stderr.write(`Failed to remove ${candidate.path}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  process.stdout.write(`\nRemoved ${removed} worktree(s).\n`)
  return 0
}
