import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { phaseArtifacts } from '../../db/schema'
import { safeAtomicWrite } from '../../io/atomicWrite'
import { getTicketContext, getTicketPaths } from '../../storage/tickets'
import {
  EXECUTION_SETUP_PLAN_ARTIFACT_TYPE,
  EXECUTION_SETUP_PLAN_NOTES_ARTIFACT_TYPE,
  EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE,
} from '../executionSetupPlan/types'
import {
  EXECUTION_LOG_RUNTIME_PATH,
  EXECUTION_SETUP_PROFILE_ARTIFACT_TYPE,
  EXECUTION_SETUP_PROFILE_MIRROR,
  EXECUTION_SETUP_REPORT_ARTIFACT_TYPE,
  EXECUTION_SETUP_RETRY_NOTES_ARTIFACT_TYPE,
  EXECUTION_SETUP_RUNTIME_DIR,
  serializeExecutionSetupProfile,
  type ExecutionSetupProfile,
} from './types'

const EXECUTION_SETUP_PROFILE_UI_COMPANION_ARTIFACT_TYPE = `ui_artifact_companion:${EXECUTION_SETUP_PROFILE_ARTIFACT_TYPE}`
const EXECUTION_SETUP_PLAN_UI_COMPANION_ARTIFACT_TYPE = `ui_artifact_companion:${EXECUTION_SETUP_PLAN_ARTIFACT_TYPE}`
const EXECUTION_SETUP_UI_STATE_ARTIFACT_TYPES = new Set([
  'ui_state:approval_execution_setup',
])
const EXECUTION_SETUP_TOOL_CACHE_DIR = 'tool-cache'

export const EXECUTION_SETUP_ALLOWED_RUNTIME_PATHS = [
  EXECUTION_SETUP_RUNTIME_DIR,
  EXECUTION_SETUP_PROFILE_MIRROR,
] as const

export interface ExecutionSetupPathSnapshot {
  untrackedPaths: string[]
}

function normalizeRepoRelativePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

export function isAllowedExecutionSetupRuntimePath(path: string): boolean {
  const normalized = normalizeRepoRelativePath(path)
  return normalized === EXECUTION_SETUP_PROFILE_MIRROR
    || normalized === EXECUTION_LOG_RUNTIME_PATH
    || normalized === EXECUTION_SETUP_RUNTIME_DIR
    || normalized.startsWith(`${EXECUTION_SETUP_RUNTIME_DIR}/`)
}

function listGitPaths(worktreePath: string, args: string[]): string[] {
  const result = spawnSync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf8',
  })
  if (result.status !== 0 || result.error) {
    return []
  }
  return (result.stdout ?? '')
    .split('\n')
    .map((entry) => normalizeRepoRelativePath(entry))
    .filter(Boolean)
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

export function removeExecutionSetupPathViolations(
  _worktreePath: string,
  _baseline?: ExecutionSetupPathSnapshot,
): string[] {
  // Compatibility no-op: repository-local setup outputs are no longer policy violations.
  return []
}

export function writeExecutionSetupProfileMirror(ticketId: string, profile: ExecutionSetupProfile): string | null {
  const paths = getTicketPaths(ticketId)
  if (!paths) return null
  safeAtomicWrite(paths.executionSetupProfilePath, serializeExecutionSetupProfile(profile))
  return paths.executionSetupProfilePath
}

export function clearExecutionSetupRuntimeArtifacts(ticketId: string, options: { preserveToolCache?: boolean } = {}): string[] {
  const paths = getTicketPaths(ticketId)
  if (!paths) return []

  const removed: string[] = []
  if (existsSync(paths.executionSetupProfilePath)) {
    rmSync(paths.executionSetupProfilePath, { recursive: true, force: true })
    removed.push(paths.executionSetupProfilePath)
  }

  if (!existsSync(paths.executionSetupDir)) {
    return removed
  }

  if (!options.preserveToolCache) {
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

export {
  EXECUTION_SETUP_PROFILE_ARTIFACT_TYPE,
  EXECUTION_SETUP_REPORT_ARTIFACT_TYPE,
  EXECUTION_SETUP_RETRY_NOTES_ARTIFACT_TYPE,
}
