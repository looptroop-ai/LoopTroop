import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { safeAtomicWrite } from '../io/atomicWrite'
import { normalizeFolderPath } from './paths'

/**
 * Proof that LoopTroop created a worktree, so cleanup can only ever delete
 * directories it made itself.
 *
 * `clean` walks a directory whose layout LoopTroop chose, but the filesystem is
 * shared: a path can be reused, restored from a backup, or simply be somewhere
 * a person put their own work. Deleting by position alone would make the choice
 * of directory name the only thing standing between a user and their files.
 *
 * The marker lives under `.ticket/runtime/`, which the ticket's own .gitignore
 * excludes, so it never appears in the working tree of the branch the worktree
 * is checked out on.
 */
export interface WorktreeOwnerMarker {
  /** Fixed, so an unrelated JSON file can never be read as a marker. */
  kind: 'looptroop-worktree'
  /** The project this worktree was created for, canonicalised. */
  projectRoot: string
  /** The ticket it was created for, which is also its directory name. */
  externalId: string
  createdAt: string
}

export function getWorktreeOwnerMarkerPath(worktreePath: string): string {
  return resolve(worktreePath, '.ticket', 'runtime', 'owner.json')
}

export function readWorktreeOwnerMarker(worktreePath: string): WorktreeOwnerMarker | null {
  const markerPath = getWorktreeOwnerMarkerPath(worktreePath)
  if (!existsSync(markerPath)) return null

  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null

    const candidate = parsed as Partial<WorktreeOwnerMarker>
    if (candidate.kind !== 'looptroop-worktree') return null
    if (typeof candidate.projectRoot !== 'string' || candidate.projectRoot === '') return null
    if (typeof candidate.externalId !== 'string' || candidate.externalId === '') return null
    if (typeof candidate.createdAt !== 'string') return null

    return candidate as WorktreeOwnerMarker
  } catch {
    return null
  }
}

/**
 * Writes the marker once and then leaves it alone, so `createdAt` keeps naming
 * the moment the worktree first appeared. A ticket that is resumed reuses its
 * worktree, and refreshing the timestamp would make an old directory look new
 * to every check that asks how long it has been there.
 */
export function ensureWorktreeOwnerMarker(
  worktreePath: string,
  details: { projectRoot: string, externalId: string },
): WorktreeOwnerMarker {
  const existing = readWorktreeOwnerMarker(worktreePath)
  if (existing !== null) return existing

  const marker: WorktreeOwnerMarker = {
    kind: 'looptroop-worktree',
    projectRoot: normalizeFolderPath(details.projectRoot),
    externalId: details.externalId,
    createdAt: new Date().toISOString(),
  }
  safeAtomicWrite(getWorktreeOwnerMarkerPath(worktreePath), `${JSON.stringify(marker, null, 2)}\n`)
  return marker
}

/**
 * True when the marker vouches for this exact directory in this exact project.
 *
 * Both halves matter. Without the project check, a marker copied from another
 * checkout would authorise a deletion in a repository it says nothing about;
 * without the id check, a marker moved between sibling directories would
 * authorise the removal of whichever one it landed in.
 *
 * Takes the marker rather than the path, so a caller that already had to read it
 * to tell "unmarked" from "marked for something else" does not read it twice.
 */
export function markerVouchesFor(
  marker: WorktreeOwnerMarker,
  details: { projectRoot: string, externalId: string },
): boolean {
  return marker.externalId === details.externalId
    && marker.projectRoot === normalizeFolderPath(details.projectRoot)
}
