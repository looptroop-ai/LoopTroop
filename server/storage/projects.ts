import { eq, inArray } from 'drizzle-orm'
import { existsSync, rmSync } from 'fs'
import { access, lstat, readdir } from 'fs/promises'
import { resolve as resolvePath } from 'path'
import { spawnSync } from 'child_process'
import { APP_DB_PATH, db as appDb } from '../db/index'
import { closeProjectDatabase, getExistingProjectDatabase, getProjectDatabase } from '../db/project'
import { attachedProjects, profiles, projects, tickets } from '../db/schema'
import { PROFILE_DEFAULTS } from '../db/defaults'
import { TERMINAL_WORKFLOW_STATUSES } from '@shared/workflowMeta'
import { applyIgnoreMode, DEFAULT_IGNORE_MODE, isIgnoreMode, type IgnoreMode } from '../git/repository'
import { isGitHookPolicy } from '../git/hookPolicy'
import type { GitHookPolicy } from '../structuredOutput/types'
import { removeWorktree } from '../git/worktreeRemoval'
import {
  ensureProjectStorageDirs,
  getProjectLoopTroopDir,
  getProjectWorktreesRoot,
  normalizeFolderPath,
  resolveGitRepoRoot,
} from './paths'

type AttachedProjectRow = typeof attachedProjects.$inferSelect
type LocalProjectRow = typeof projects.$inferSelect
type LocalTicketRow = typeof tickets.$inferSelect

export interface PublicProject extends Omit<LocalProjectRow, 'id'> {
  id: number
  latestActivityTicketExternalId?: string
}

export interface ProjectContext {
  attached: AttachedProjectRow
  project: LocalProjectRow
  projectRoot: string
  projectDb: ReturnType<typeof getProjectDatabase>['db']
}

export interface ExistingProjectMetadata {
  name: string
  shortname: string
  icon: string | null
  color: string | null
  gitHookPolicy: LocalProjectRow['gitHookPolicy']
  manualQaOverride: LocalProjectRow['manualQaOverride']
  aiQuestionsOverride: LocalProjectRow['aiQuestionsOverride']
  aiQuestionWindowOverride: LocalProjectRow['aiQuestionWindowOverride']
  ignoreMode: LocalProjectRow['ignoreMode']
  ticketCounter: number
  ticketCount: number
  activeTicketCount: number
}

export type ExistingStateAction = 'restore' | 'clear_tickets' | 'start_fresh'

export type ProjectConflictKind = 'folder' | 'name' | 'shortname'

export interface ProjectIdentityConflict {
  kind: ProjectConflictKind
  projectId: number
  projectName: string | null
  projectShortname: string | null
  folderPath: string
}

export class ProjectIdentityConflictError extends Error {
  readonly conflicts: ProjectIdentityConflict[]

  constructor(conflicts: ProjectIdentityConflict[]) {
    super('Project identity conflicts with an existing attached project')
    this.name = 'ProjectIdentityConflictError'
    this.conflicts = conflicts
  }
}

interface ProjectAttachmentInput {
  folderPath: string
  name: string
  shortname: string
  icon?: string
  color?: string
  profileId?: number
  councilMembers?: string
  manualQaOverride?: boolean
  // No profile fallback at project level: undefined means "inherit", not "default".
  aiQuestionsOverride?: boolean | null
  aiQuestionWindowOverride?: number | null
  gitHookPolicy?: GitHookPolicy
  maxIterations?: number
  perIterationTimeout?: number
  executionSetupTimeout?: number
  councilResponseTimeout?: number
  minCouncilQuorum?: number
  interviewQuestions?: number
  ignoreMode?: IgnoreMode
}

function resolveNewProjectSettings(input: ProjectAttachmentInput): ProjectAttachmentInput & {
  manualQaOverride: boolean
  gitHookPolicy: GitHookPolicy
  ignoreMode: IgnoreMode
} {
  const profile = appDb.select().from(profiles).limit(1).get()
  return {
    ...input,
    manualQaOverride: input.manualQaOverride
      ?? profile?.manualQaEnabled
      ?? PROFILE_DEFAULTS.manualQaEnabled,
    gitHookPolicy: input.gitHookPolicy
      ?? (isGitHookPolicy(profile?.gitHookPolicy) ? profile.gitHookPolicy : PROFILE_DEFAULTS.gitHookPolicy),
    ignoreMode: input.ignoreMode
      ?? (isIgnoreMode(profile?.ignoreMode) ? profile.ignoreMode : DEFAULT_IGNORE_MODE),
  }
}

function hydrateProject(attached: AttachedProjectRow, project: LocalProjectRow): PublicProject {
  return {
    ...project,
    id: attached.id,
  }
}

function getAttachedByPath(projectRoot: string): AttachedProjectRow | undefined {
  return appDb.select().from(attachedProjects).where(eq(attachedProjects.folderPath, projectRoot)).get()
}

function getAttachedRow(id: number): AttachedProjectRow | undefined {
  return appDb.select().from(attachedProjects).where(eq(attachedProjects.id, id)).get()
}

function readLocalProject(projectRoot: string): LocalProjectRow | undefined {
  const projectDb = getExistingProjectDatabase(projectRoot)
  if (!projectDb) return undefined
  const { db } = projectDb
  return db.select().from(projects).limit(1).get()
}

function normalizeProjectName(name: string): string {
  return name.trim().toLowerCase()
}

function normalizeProjectShortname(shortname: string): string {
  return shortname.trim().toUpperCase()
}

interface ProjectIdentityConflictInput {
  folderPath?: string
  name?: string
  shortname?: string
  excludeProjectId?: number
}

/**
 * Finds conflicts against the app-level attached-project registry. Local
 * project state without an attached row is intentionally ignored: that is the
 * state the attachment flow exists to recover.
 */
export function findProjectIdentityConflicts(input: ProjectIdentityConflictInput): ProjectIdentityConflict[] {
  const normalizedFolder = input.folderPath ? normalizeFolderPath(input.folderPath) : null
  const normalizedName = input.name?.trim() ? normalizeProjectName(input.name) : null
  const normalizedShortname = input.shortname?.trim() ? normalizeProjectShortname(input.shortname) : null
  const conflicts: ProjectIdentityConflict[] = []

  for (const attached of appDb.select().from(attachedProjects).all()) {
    const project = readLocalProject(attached.folderPath)
    if (attached.id === input.excludeProjectId) continue

    const base = {
      projectId: attached.id,
      projectName: project?.name ?? null,
      projectShortname: project?.shortname ?? null,
      folderPath: attached.folderPath,
    }

    if (normalizedFolder && normalizeFolderPath(attached.folderPath) === normalizedFolder) {
      conflicts.push({ kind: 'folder', ...base })
    }
    if (project && normalizedName && normalizeProjectName(project.name) === normalizedName) {
      conflicts.push({ kind: 'name', ...base })
    }
    if (project && normalizedShortname && normalizeProjectShortname(project.shortname) === normalizedShortname) {
      conflicts.push({ kind: 'shortname', ...base })
    }
  }

  return conflicts
}

export function getAttachedProjectByRoot(projectRoot: string): PublicProject | undefined {
  const normalizedRoot = normalizeFolderPath(projectRoot)
  const attached = appDb.select().from(attachedProjects).all()
    .find((candidate) => normalizeFolderPath(candidate.folderPath) === normalizedRoot)
  if (!attached) return undefined
  const project = readLocalProject(attached.folderPath)
  return project ? hydrateProject(attached, project) : undefined
}

function ensureAttachedProject(projectRoot: string): AttachedProjectRow {
  let attached = getAttachedByPath(projectRoot)
  if (!attached) {
    attached = appDb.insert(attachedProjects)
      .values({ folderPath: projectRoot })
      .returning()
      .get()
  } else {
    appDb.update(attachedProjects)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(attachedProjects.id, attached.id))
      .run()
    attached = getAttachedByPath(projectRoot)
  }

  if (!attached) {
    throw new Error(`Failed to attach project at ${projectRoot}`)
  }

  return attached
}

function ensureLocalProject(projectRoot: string, input?: ProjectAttachmentInput): LocalProjectRow {
  const existing = readLocalProject(projectRoot)
  if (existing) return existing
  if (!input) {
    throw new Error(`No LoopTroop project state found in ${projectRoot}`)
  }

  ensureProjectStorageDirs(projectRoot)
  const { db } = getProjectDatabase(projectRoot)
  const existingAfterOpen = db.select().from(projects).limit(1).get()
  if (existingAfterOpen) return existingAfterOpen

  // Project metadata lives in the per-project SQLite file while attachment state
  // lives in the app database. Retrying attachProject() after a partial failure is
  // safe because each step re-checks for an existing row before inserting.
  return db.insert(projects)
    .values({
      name: input.name,
      shortname: input.shortname,
      icon: input.icon ?? '📁',
      color: input.color ?? '#3b82f6',
      folderPath: projectRoot,
      profileId: input.profileId ?? null,
      councilMembers: input.councilMembers ?? null,
      manualQaOverride: input.manualQaOverride,
      aiQuestionsOverride: input.aiQuestionsOverride ?? null,
      aiQuestionWindowOverride: input.aiQuestionWindowOverride ?? null,
      gitHookPolicy: input.gitHookPolicy,
      maxIterations: input.maxIterations ?? null,
      perIterationTimeout: input.perIterationTimeout ?? null,
      executionSetupTimeout: input.executionSetupTimeout ?? null,
      councilResponseTimeout: input.councilResponseTimeout ?? null,
      minCouncilQuorum: input.minCouncilQuorum ?? null,
      interviewQuestions: input.interviewQuestions ?? null,
      ignoreMode: input.ignoreMode,
    })
    .returning()
    .get()
}

export function hasLoopTroopState(projectRoot: string): boolean {
  const repoRoot = resolveGitRepoRoot(projectRoot)
  if (!repoRoot) return false
  return !!readLocalProject(repoRoot)
}

/**
 * The ignore choice made when the project was attached.
 *
 * Falls back to the default for projects attached before the choice existed, so
 * their rules keep being maintained the way they always were.
 */
export function getProjectIgnoreMode(projectRoot: string): IgnoreMode {
  const repoRoot = resolveGitRepoRoot(projectRoot) ?? projectRoot
  const stored = readLocalProject(repoRoot)?.ignoreMode
  return isIgnoreMode(stored) ? stored : DEFAULT_IGNORE_MODE
}

export function attachProject(input: ProjectAttachmentInput): PublicProject {
  const projectRoot = resolveGitRepoRoot(input.folderPath)
  if (!projectRoot) {
    throw new Error(`Folder is not a git repository: ${input.folderPath}`)
  }

  const resolvedInput = resolveNewProjectSettings({ ...input, folderPath: projectRoot })
  applyIgnoreMode(projectRoot, resolvedInput.ignoreMode)
  const localProject = ensureLocalProject(projectRoot, resolvedInput)
  const attached = ensureAttachedProject(projectRoot)

  return hydrateProject(attached, localProject)
}

export function attachExistingProject(input: Partial<ProjectAttachmentInput> & { folderPath: string } | string): PublicProject {
  const projectRootOrFolder = typeof input === 'string' ? input : input.folderPath
  const projectRoot = resolveGitRepoRoot(projectRootOrFolder)
  if (!projectRoot) {
    throw new Error(`Folder is not a git repository: ${projectRootOrFolder}`)
  }

  const localProject = ensureLocalProject(projectRoot)
  const configuredDefaults = resolveNewProjectSettings({
    folderPath: projectRoot,
    name: localProject.name,
    shortname: localProject.shortname,
  })
  const requestedIgnoreMode = typeof input === 'string' ? undefined : input.ignoreMode
  const effectiveIgnoreMode = requestedIgnoreMode
    ?? (isIgnoreMode(localProject.ignoreMode) ? localProject.ignoreMode : configuredDefaults.ignoreMode)
  applyIgnoreMode(projectRoot, effectiveIgnoreMode)

  const requested: Partial<ProjectAttachmentInput> = typeof input === 'string' ? {} : input
  const patch = {
    name: requested.name ?? localProject.name,
    icon: requested.icon ?? localProject.icon,
    color: requested.color ?? localProject.color,
    folderPath: projectRoot,
    profileId: requested.profileId ?? localProject.profileId,
    councilMembers: requested.councilMembers ?? localProject.councilMembers,
    manualQaOverride: requested.manualQaOverride === undefined
      ? (localProject.manualQaOverride ?? configuredDefaults.manualQaOverride)
      : requested.manualQaOverride,
    aiQuestionsOverride: requested.aiQuestionsOverride === undefined
      ? localProject.aiQuestionsOverride
      : requested.aiQuestionsOverride,
    aiQuestionWindowOverride: requested.aiQuestionWindowOverride === undefined
      ? localProject.aiQuestionWindowOverride
      : requested.aiQuestionWindowOverride,
    gitHookPolicy: requested.gitHookPolicy === undefined
      ? (isGitHookPolicy(localProject.gitHookPolicy) ? localProject.gitHookPolicy : configuredDefaults.gitHookPolicy)
      : requested.gitHookPolicy,
    maxIterations: requested.maxIterations ?? localProject.maxIterations,
    perIterationTimeout: requested.perIterationTimeout ?? localProject.perIterationTimeout,
    executionSetupTimeout: requested.executionSetupTimeout ?? localProject.executionSetupTimeout,
    councilResponseTimeout: requested.councilResponseTimeout ?? localProject.councilResponseTimeout,
    minCouncilQuorum: requested.minCouncilQuorum ?? localProject.minCouncilQuorum,
    interviewQuestions: requested.interviewQuestions ?? localProject.interviewQuestions,
    ignoreMode: effectiveIgnoreMode,
    updatedAt: new Date().toISOString(),
  }

  let effectiveProject = localProject
  const { db } = getProjectDatabase(projectRoot)
  db.update(projects)
    .set(patch)
    .where(eq(projects.id, localProject.id))
    .run()
  effectiveProject = db.select().from(projects).where(eq(projects.id, localProject.id)).get() ?? localProject

  const attached = ensureAttachedProject(projectRoot)
  return hydrateProject(attached, effectiveProject)
}

export function listProjects(): PublicProject[] {
  const attachedRows = appDb.select().from(attachedProjects).all()
  const aggregated: PublicProject[] = []
  for (const attached of attachedRows) {
    const localProject = readLocalProject(attached.folderPath)
    if (!localProject) continue

    let lastUpdate = new Date(localProject.updatedAt).getTime()
    let latestActivityTicketExternalId: string | undefined = undefined
    const projectDb = getExistingProjectDatabase(attached.folderPath)
    if (projectDb) {
      const { db } = projectDb
      const allTickets = db.select({ updatedAt: tickets.updatedAt, externalId: tickets.externalId }).from(tickets).all()
      for (const t of allTickets) {
        const tTime = new Date(t.updatedAt).getTime()
        if (tTime > lastUpdate) {
          lastUpdate = tTime
          latestActivityTicketExternalId = t.externalId
        }
      }
    }

    const hydrated = hydrateProject(attached, localProject)
    hydrated.updatedAt = new Date(lastUpdate).toISOString()
    if (latestActivityTicketExternalId) {
      hydrated.latestActivityTicketExternalId = latestActivityTicketExternalId
    }
    aggregated.push(hydrated)
  }
  return aggregated.sort((a, b) => a.name.localeCompare(b.name))
}

export function getProjectById(id: number): PublicProject | undefined {
  const attached = getAttachedRow(id)
  if (!attached) return undefined
  const localProject = readLocalProject(attached.folderPath)
  if (!localProject) return undefined
  return hydrateProject(attached, localProject)
}

export function getProjectContextById(id: number): ProjectContext | undefined {
  const attached = getAttachedRow(id)
  if (!attached) return undefined
  const projectRoot = attached.folderPath
  const projectDb = getExistingProjectDatabase(projectRoot)
  if (!projectDb) return undefined
  const { db } = projectDb
  const project = db.select().from(projects).limit(1).get()
  if (!project) return undefined
  return { attached, projectRoot, projectDb: db, project }
}

export function updateProject(id: number, patch: Partial<Pick<LocalProjectRow, 'name' | 'icon' | 'color' | 'councilMembers' | 'manualQaOverride' | 'aiQuestionsOverride' | 'aiQuestionWindowOverride' | 'gitHookPolicy' | 'maxIterations' | 'perIterationTimeout' | 'executionSetupTimeout' | 'councilResponseTimeout' | 'minCouncilQuorum' | 'interviewQuestions'>>): PublicProject | undefined {
  const context = getProjectContextById(id)
  if (!context) return undefined
  if (patch.name !== undefined) {
    const conflicts = findProjectIdentityConflicts({ name: patch.name, excludeProjectId: id })
    if (conflicts.length > 0) {
      throw new ProjectIdentityConflictError(conflicts)
    }
  }
  context.projectDb.update(projects)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, context.project.id))
    .run()
  const updated = context.projectDb.select().from(projects).where(eq(projects.id, context.project.id)).get()
  if (!updated) return undefined
  appDb.update(attachedProjects)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(attachedProjects.id, id))
    .run()
  return hydrateProject(context.attached, updated)
}

const DETACHABLE_TICKET_STATUSES = new Set(['DRAFT', 'COMPLETED', 'CANCELED'])

function hasActiveProjectTickets(projectRoot: string): boolean {
  const projectDb = getExistingProjectDatabase(projectRoot)
  if (!projectDb) return false

  const rows = projectDb.db.select({ status: tickets.status }).from(tickets).all()
  return rows.some(ticket => !DETACHABLE_TICKET_STATUSES.has(ticket.status))
}

/**
 * Detaching a project is intentionally non-destructive: it only removes the
 * app-level attachment row so the existing on-disk LoopTroop state can be
 * re-attached later. Refuse to detach while tickets are still active.
 */
export function detachProject(id: number): boolean {
  const attached = getAttachedRow(id)
  if (!attached) return false
  if (hasActiveProjectTickets(attached.folderPath)) {
    throw new Error('Cannot detach project while tickets are still active. Complete or cancel them first.')
  }
  closeProjectDatabase(attached.folderPath)
  appDb.delete(attachedProjects).where(eq(attachedProjects.id, id)).run()
  return true
}

export function deleteProject(id: number): boolean {
  const attached = getAttachedRow(id)
  if (!attached) return false
  if (hasActiveProjectTickets(attached.folderPath)) {
    throw new Error('Cannot delete project while tickets are still active. Complete or cancel them first.')
  }

  closeProjectDatabase(attached.folderPath)
  rmSync(getProjectLoopTroopDir(attached.folderPath), { recursive: true, force: true })
  appDb.delete(attachedProjects).where(eq(attachedProjects.id, id)).run()
  return true
}

export function listProjectTickets(id: number): LocalTicketRow[] {
  const context = getProjectContextById(id)
  if (!context) return []
  return context.projectDb.select().from(tickets).all()
}

export function getProjectRootById(id: number): string | undefined {
  return getAttachedRow(id)?.folderPath
}

export function getExistingProjectMetadata(projectRootOrFolder: string): ExistingProjectMetadata | null {
  const projectRoot = resolveGitRepoRoot(projectRootOrFolder)
  if (!projectRoot) return null

  const projectDb = getExistingProjectDatabase(projectRoot)
  if (!projectDb) return null
  const { db } = projectDb
  const project = db.select().from(projects).limit(1).get()
  if (!project) return null

  const ticketCount = db.select().from(tickets).all().length
  const activeTicketCount = db.select({ status: tickets.status }).from(tickets).all()
    .filter(ticket => !DETACHABLE_TICKET_STATUSES.has(ticket.status))
    .length
  return {
    name: project.name,
    shortname: project.shortname,
    icon: project.icon ?? null,
    color: project.color ?? null,
    gitHookPolicy: project.gitHookPolicy,
    manualQaOverride: project.manualQaOverride,
    aiQuestionsOverride: project.aiQuestionsOverride,
    aiQuestionWindowOverride: project.aiQuestionWindowOverride,
    ignoreMode: project.ignoreMode,
    ticketCounter: project.ticketCounter ?? 0,
    ticketCount,
    activeTicketCount,
  }
}

export function resolveProjectState(projectRootOrFolder: string): { projectRoot: string; exists: boolean; existingProject: ExistingProjectMetadata | null } {
  const projectRoot = resolveGitRepoRoot(projectRootOrFolder)
  if (!projectRoot) {
    return { projectRoot: normalizeFolderPath(projectRootOrFolder), exists: false, existingProject: null }
  }

  const existingProject = getExistingProjectMetadata(projectRoot)
  return { projectRoot, exists: existingProject !== null, existingProject }
}

async function existsAsync(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function calcDirSize(dirPath: string): Promise<number> {
  if (!(await existsAsync(dirPath))) return 0
  let total = 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = resolvePath(dirPath, entry.name)
      const stat = await lstat(full)
      if (stat.isDirectory()) {
        total += await calcDirSize(full)
      } else {
        total += stat.size
      }
    }
  } catch {
    // Best-effort
  }
  return total
}

function getTerminalTicketExternalIds(projectRoot: string): string[] {
  const projectDb = getExistingProjectDatabase(projectRoot)
  if (!projectDb) return []
  const { db } = projectDb
  const rows = db
    .select({ externalId: tickets.externalId })
    .from(tickets)
    .where(inArray(tickets.status, TERMINAL_WORKFLOW_STATUSES))
    .all()
  return rows.map(r => r.externalId)
}

/**
 * The tickets that have reached a terminal state, for callers deciding whether
 * a worktree still has work behind it. Returns nothing rather than throwing when
 * the project database is missing or unreadable: `clean` runs on machines whose
 * state is already damaged, and an unreadable database means "nothing is known
 * to be finished", never "delete on the basis of a guess".
 */
export function listClosedTicketIds(projectRoot: string): string[] {
  try {
    return getTerminalTicketExternalIds(projectRoot)
  } catch {
    return []
  }
}

/**
 * The folder of every attached project, for a caller that needs the list before
 * the application has ever booted.
 *
 * `listProjects` is the wrong tool for that: it reaches the database through the
 * shared handle, which creates the file on first touch and then queries tables
 * that only exist once the boot sequence has run. `clean` has to work on a
 * machine where LoopTroop has never started successfully — and must not leave a
 * database behind on one where it never started at all — so a missing file, a
 * database with no tables yet, and one that cannot be read all report the same
 * thing: nothing is known to be attached, which is never grounds to delete.
 *
 * Unlike `listProjects` this keeps projects whose local data has gone missing.
 * Their worktrees are exactly the debris `clean` exists to find.
 */
export function listAttachedProjectRoots(): string[] {
  if (!existsSync(APP_DB_PATH)) return []

  try {
    return appDb
      .select({ folderPath: attachedProjects.folderPath })
      .from(attachedProjects)
      .all()
      .map((row) => row.folderPath)
  } catch {
    return []
  }
}

export async function getProjectWorktreesSize(projectRoot: string): Promise<number> {
  const worktreesRoot = getProjectWorktreesRoot(projectRoot)
  const externalIds = getTerminalTicketExternalIds(projectRoot)
  let sum = 0
  for (const id of externalIds) {
    sum += await calcDirSize(resolvePath(worktreesRoot, id))
  }
  return sum
}

export async function deleteProjectWorktrees(projectRoot: string): Promise<{ freedBytes: number }> {
  const worktreesRoot = getProjectWorktreesRoot(projectRoot)
  if (!(await existsAsync(worktreesRoot))) return { freedBytes: 0 }

  const externalIds = getTerminalTicketExternalIds(projectRoot)
  if (externalIds.length === 0) return { freedBytes: 0 }

  let freedBytes = 0
  for (const externalId of externalIds) {
    const worktreePath = resolvePath(worktreesRoot, externalId)
    if (!(await existsAsync(worktreePath))) continue
    freedBytes += await calcDirSize(worktreePath)
    removeWorktree({ projectRoot, worktreesRoot, worktreePath })
  }

  spawnSync('git', ['-C', projectRoot, 'worktree', 'prune'], { encoding: 'utf8' })

  return { freedBytes }
}

/**
 * Removes every filesystem entry under LoopTroop's managed worktree root,
 * including worktrees owned by active tickets. Repository branches and source
 * files outside that root are intentionally left untouched.
 */
export async function deleteAllProjectWorktrees(projectRoot: string): Promise<{ freedBytes: number }> {
  const worktreesRoot = getProjectWorktreesRoot(projectRoot)
  if (!(await existsAsync(worktreesRoot))) {
    spawnSync('git', ['-C', projectRoot, 'worktree', 'prune'], { encoding: 'utf8' })
    return { freedBytes: 0 }
  }

  let freedBytes = 0
  const entries = await readdir(worktreesRoot, { withFileTypes: true })
  for (const entry of entries) {
    const worktreePath = resolvePath(worktreesRoot, entry.name)
    freedBytes += await calcDirSize(worktreePath)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removeWorktree({ projectRoot, worktreesRoot, worktreePath })
    } else {
      rmSync(worktreePath, { recursive: true, force: true })
    }
  }

  spawnSync('git', ['-C', projectRoot, 'worktree', 'prune'], { encoding: 'utf8' })
  return { freedBytes }
}

export async function clearExistingProjectTickets(input: ProjectAttachmentInput): Promise<PublicProject> {
  const projectRoot = resolveGitRepoRoot(input.folderPath)
  if (!projectRoot) {
    throw new Error(`Folder is not a git repository: ${input.folderPath}`)
  }

  await deleteAllProjectWorktrees(projectRoot)
  const projectDb = getExistingProjectDatabase(projectRoot)
  if (!projectDb) {
    throw new Error(`No LoopTroop project state found in ${projectRoot}`)
  }
  const project = projectDb.db.select().from(projects).limit(1).get()
  if (!project) {
    throw new Error(`No LoopTroop project state found in ${projectRoot}`)
  }
  const configuredDefaults = resolveNewProjectSettings({
    folderPath: projectRoot,
    name: project.name,
    shortname: project.shortname,
  })
  const manualQaOverride = input.manualQaOverride === undefined
    ? (project.manualQaOverride ?? configuredDefaults.manualQaOverride)
    : input.manualQaOverride
  const aiQuestionsOverride = input.aiQuestionsOverride === undefined
    ? project.aiQuestionsOverride
    : input.aiQuestionsOverride
  const aiQuestionWindowOverride = input.aiQuestionWindowOverride === undefined
    ? project.aiQuestionWindowOverride
    : input.aiQuestionWindowOverride
  const gitHookPolicy = input.gitHookPolicy === undefined
    ? (isGitHookPolicy(project.gitHookPolicy) ? project.gitHookPolicy : configuredDefaults.gitHookPolicy)
    : input.gitHookPolicy
  const ignoreMode = input.ignoreMode === undefined
    ? (isIgnoreMode(project.ignoreMode) ? project.ignoreMode : configuredDefaults.ignoreMode)
    : input.ignoreMode

  projectDb.sqlite.transaction(() => {
    projectDb.sqlite.exec(`
      DELETE FROM manual_qa_improvement_tickets;
      DELETE FROM manual_qa_operations;
      DELETE FROM phase_artifacts;
      DELETE FROM ticket_phase_attempts;
      DELETE FROM opencode_sessions;
      DELETE FROM ticket_status_history;
      DELETE FROM ticket_error_occurrences;
      DELETE FROM bead_execution_metrics;
      DELETE FROM ticket_ai_turn_metrics;
      DELETE FROM tickets;
    `)
    projectDb.sqlite.prepare(`
      UPDATE projects
      SET name = ?, icon = ?, color = ?, folder_path = ?,
          manual_qa_override = ?, ai_questions_override = ?, ai_question_window_override = ?,
          git_hook_policy = ?, ignore_mode = ?, ticket_counter = 0,
          updated_at = ?
      WHERE id = ?
    `).run(
      input.name,
      input.icon ?? project.icon,
      input.color ?? project.color,
      projectRoot,
      Number(manualQaOverride),
      aiQuestionsOverride === null || aiQuestionsOverride === undefined ? null : Number(aiQuestionsOverride),
      aiQuestionWindowOverride ?? null,
      gitHookPolicy,
      ignoreMode,
      new Date().toISOString(),
      project.id,
    )
  })()

  applyIgnoreMode(projectRoot, ignoreMode)
  ensureProjectStorageDirs(projectRoot)
  return attachExistingProject(projectRoot)
}

export async function replaceExistingProjectState(input: ProjectAttachmentInput): Promise<PublicProject> {
  const projectRoot = resolveGitRepoRoot(input.folderPath)
  if (!projectRoot) {
    throw new Error(`Folder is not a git repository: ${input.folderPath}`)
  }

  await deleteAllProjectWorktrees(projectRoot)
  closeProjectDatabase(projectRoot)
  rmSync(getProjectLoopTroopDir(projectRoot), { recursive: true, force: true })
  return attachProject({ ...input, folderPath: projectRoot })
}
