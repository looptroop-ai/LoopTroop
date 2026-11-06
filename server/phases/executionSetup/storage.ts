import { runGitSync } from '../../git/runCommand'
import { parseGitPathListZ } from '../../git/statusPorcelain'
import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { lstat, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { phaseArtifacts } from '../../db/schema'
import { getTicketContext, getTicketPaths, getTicketStorageContext, resolveTicketContainedPath, writeTicketFile } from '../../storage/tickets'
import { getProjectWorktreesRoot } from '../../storage/paths'
import { makeOwnerWritableRecursiveAsync } from '../../io/removal'
import {
  EXECUTION_SETUP_PLAN_ARTIFACT_TYPE,
  EXECUTION_SETUP_PLAN_NOTES_ARTIFACT_TYPE,
  EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE,
} from '../executionSetupPlan/types'
import {
  EXECUTION_LOG_RUNTIME_PATH,
  EXECUTION_SETUP_PROFILE_ARTIFACT_TYPE,
  serializeExecutionSetupProfile,
  type ExecutionSetupProfile,
} from './types'

const EXECUTION_SETUP_PROFILE_UI_COMPANION_ARTIFACT_TYPE = `ui_artifact_companion:${EXECUTION_SETUP_PROFILE_ARTIFACT_TYPE}`
const EXECUTION_SETUP_PLAN_UI_COMPANION_ARTIFACT_TYPE = `ui_artifact_companion:${EXECUTION_SETUP_PLAN_ARTIFACT_TYPE}`
const EXECUTION_SETUP_UI_STATE_ARTIFACT_TYPES = new Set([
  'ui_state:approval_execution_setup',
])
const EXECUTION_SETUP_TOOL_CACHE_DIR = 'tool-cache'

export interface ExecutionSetupPathSnapshot {
  untrackedPaths: string[]
}

function listGitPaths(worktreePath: string, args: string[]): string[] {
  const result = runGitSync(worktreePath, [...args, '-z'], { trimOutput: false })
  if (!result.ok) return []
  return parseGitPathListZ(result.stdout)
}

export function createExecutionSetupPathSnapshot(worktreePath: string): ExecutionSetupPathSnapshot {
  return {
    untrackedPaths: [...new Set(listGitPaths(worktreePath, ['ls-files', '--others', '--exclude-standard']))],
  }
}

export function validateExecutionSetupPaths(
  worktreePath: string,
  baseline?: ExecutionSetupPathSnapshot,
): {
  ok: boolean
  violations: string[]
  changedPaths: string[]
} {
  // Execution setup is allowed to prepare repository-local dependency and cache output.
  // Keep returning changed paths for diagnostics, but do not fail the phase on path scope.
  const baselineUntracked = new Set(baseline?.untrackedPaths ?? [])
  const changedPaths = [
    ...listGitPaths(worktreePath, ['diff', '--name-only', 'HEAD']),
    ...listGitPaths(worktreePath, ['ls-files', '--others', '--exclude-standard'])
      .filter((path) => !baselineUntracked.has(path)),
  ]
  const uniqueChangedPaths = [...new Set(changedPaths)]
  return {
    ok: true,
    violations: [],
    changedPaths: uniqueChangedPaths,
  }
}

export function writeExecutionSetupProfileMirror(ticketId: string, profile: ExecutionSetupProfile): string | null {
  const path = resolveTicketContainedPath(ticketId, 'runtime/execution-setup-profile.json')
  if (!path) return null
  writeTicketFile(ticketId, 'runtime/execution-setup-profile.json', serializeExecutionSetupProfile(profile))
  return path
}

export function clearExecutionSetupRuntimeArtifacts(ticketId: string, options: { preserveToolCache?: boolean } = {}): string[] {
  const executionSetupProfilePath = resolveTicketContainedPath(ticketId, 'runtime/execution-setup-profile.json', 'remove')
  const executionSetupDir = resolveTicketContainedPath(ticketId, 'runtime/execution-setup', 'remove')
  if (!executionSetupProfilePath || !executionSetupDir) return []
  const paths = { executionSetupProfilePath, executionSetupDir }

  const removed: string[] = []
  try {
    lstatSync(paths.executionSetupProfilePath)
    rmSync(paths.executionSetupProfilePath, { recursive: true, force: true })
    removed.push(paths.executionSetupProfilePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  let setupStat
  try {
    setupStat = lstatSync(paths.executionSetupDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return removed
    throw error
  }

  if (!options.preserveToolCache || setupStat.isSymbolicLink()) {
    rmSync(paths.executionSetupDir, { recursive: true, force: true })
    removed.push(paths.executionSetupDir)
    return removed
  }

  for (const entry of readdirSync(paths.executionSetupDir, { withFileTypes: true })) {
    if (entry.name === EXECUTION_SETUP_TOOL_CACHE_DIR) continue
    const targetPath = join(paths.executionSetupDir, entry.name)
    rmSync(targetPath, { recursive: true, force: true })
    removed.push(targetPath)
  }
  return removed
}

/**
 * A canceled ticket never runs again, so its setup folder (package caches that can
 * reach gigabytes, plus the launcher) only costs disk space and startup scans. The
 * small setup profile stays as the record of what ran. Completed tickets lose this
 * folder in Cleaning Up; blocked tickets keep it, because a retry reuses the cache.
 *
 * Asynchronous: deleting thousands of cache files synchronously would stall every
 * request and live update until it finished.
 */
export async function removeCanceledExecutionSetupFolder(ticketId: string): Promise<boolean> {
  const executionSetupDir = resolveTicketContainedPath(ticketId, 'runtime/execution-setup', 'remove')
  if (!executionSetupDir) return false
  try {
    await lstat(executionSetupDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  // Retries cover a just-stopped Windows child still holding a handle.
  try {
    await rm(executionSetupDir, { recursive: true, force: true, maxRetries: 3 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'EPERM') throw error
    // Some package caches (Go's module cache) are read-only by design. Cleaning
    // Up makes the tree writable first; here only after a refusal, and without
    // blocking the server.
    await makeOwnerWritableRecursiveAsync(executionSetupDir)
    await rm(executionSetupDir, { recursive: true, force: true, maxRetries: 3 })
  }
  return true
}

/** The folder's plain path, for a check that must not cost synchronous work. */
function plainExecutionSetupPath(ticketRef: string): string | null {
  const storage = getTicketStorageContext(ticketRef)
  return storage
    ? join(getProjectWorktreesRoot(storage.projectRoot), storage.externalId, '.ticket', 'runtime', 'execution-setup')
    : null
}

/**
 * Retries the removal for canceled tickets, one at a time. A cancel whose delete
 * failed, or a crash in the middle of one, leaves a folder nothing else removes.
 *
 * Runs on every start, so a ticket without a leftover folder costs one async
 * lstat. `shouldRemove` is asked right before deleting (still canceled, cancel
 * confirmed), because the ref can meanwhile belong to another ticket.
 */
export async function sweepCanceledExecutionSetupFolders(
  ticketRefs: readonly string[],
  shouldRemove: (ticketRef: string) => boolean,
): Promise<number> {
  let removed = 0
  for (const ticketRef of ticketRefs) {
    try {
      const plainPath = plainExecutionSetupPath(ticketRef)
      if (!plainPath) continue
      try {
        await lstat(plainPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (!shouldRemove(ticketRef)) continue
      if (await removeCanceledExecutionSetupFolder(ticketRef)) removed += 1
    } catch (error) {
      console.warn(`[startup] Could not remove the execution setup folder of canceled ticket ${ticketRef}:`, error)
    }
  }
  return removed
}

export function clearExecutionSetupState(ticketId: string): {
  removedArtifacts: number
  removedFiles: string[]
} {
  const ticketContext = getTicketContext(ticketId)
  if (!ticketContext) {
    return {
      removedArtifacts: 0,
      removedFiles: clearExecutionSetupRuntimeArtifacts(ticketId),
    }
  }

  const removedFiles = clearExecutionSetupRuntimeArtifacts(ticketId)
  const artifacts = ticketContext.projectDb
    .select()
    .from(phaseArtifacts)
    .where(eq(phaseArtifacts.ticketId, ticketContext.localTicketId))
    .all()

  let removedArtifacts = 0
  for (const artifact of artifacts) {
    const artifactType = artifact.artifactType ?? ''
    if (
      artifact.phase !== 'PREPARING_EXECUTION_ENV'
      && artifact.phase !== 'WAITING_EXECUTION_SETUP_APPROVAL'
      && artifact.phase !== 'GENERATING_EXECUTION_SETUP_PLAN'
      && artifactType !== EXECUTION_SETUP_PROFILE_UI_COMPANION_ARTIFACT_TYPE
      && artifactType !== EXECUTION_SETUP_PLAN_UI_COMPANION_ARTIFACT_TYPE
      && artifactType !== EXECUTION_SETUP_PLAN_ARTIFACT_TYPE
      && artifactType !== EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE
      && artifactType !== EXECUTION_SETUP_PLAN_NOTES_ARTIFACT_TYPE
      && !EXECUTION_SETUP_UI_STATE_ARTIFACT_TYPES.has(artifactType)
    ) {
      continue
    }
    ticketContext.projectDb
      .delete(phaseArtifacts)
      .where(eq(phaseArtifacts.id, artifact.id))
      .run()
    removedArtifacts += 1
  }

  return { removedArtifacts, removedFiles }
}

export function describeExecutionSetupPaths(ticketId: string): {
  setupDir: string
  profilePath: string
  logPath: string
} | null {
  const paths = getTicketPaths(ticketId)
  if (!paths) return null
  return {
    setupDir: paths.executionSetupDir,
    profilePath: paths.executionSetupProfilePath,
    logPath: resolve(paths.worktreePath, EXECUTION_LOG_RUNTIME_PATH),
  }
}
