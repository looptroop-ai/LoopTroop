import { eq, or } from 'drizzle-orm'
import { rmSync } from 'fs'
import { access, lstat, readdir } from 'fs/promises'
import { resolve as resolvePath } from 'path'
import { spawnSync } from 'child_process'
import { db as appDb } from '../db/index'
import { closeProjectDatabase, getExistingProjectDatabase, getProjectDatabase } from '../db/project'
import { attachedProjects, projects, tickets } from '../db/schema'
import { ensureLocalGitExclude } from '../git/repository'
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
  ticketCounter: number
  ticketCount: number
  activeTicketCount: number
}

export type ExistingStateAction = 'restore' | 'clear_tickets' | 'start_fresh'

interface ProjectAttachmentInput {
  folderPath: string
  name: string
  shortname: string
  icon?: string
  color?: string
  profileId?: number
  councilMembers?: string
  manualQaOverride?: boolean | null
  gitHookPolicy?: 'observe_only' | 'validate_advisory' | 'validate_required' | 'use_native_hooks' | null
  maxIterations?: number
  perIterationTimeout?: number
  executionSetupTimeout?: number
  councilResponseTimeout?: number
  minCouncilQuorum?: number
  interviewQuestions?: number
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
      manualQaOverride: input.manualQaOverride ?? null,
      gitHookPolicy: input.gitHookPolicy ?? null,
      maxIterations: input.maxIterations ?? null,
      perIterationTimeout: input.perIterationTimeout ?? null,
      executionSetupTimeout: input.executionSetupTimeout ?? null,
      councilResponseTimeout: input.councilResponseTimeout ?? null,
      minCouncilQuorum: input.minCouncilQuorum ?? null,
      interviewQuestions: input.interviewQuestions ?? null,
    })
    .returning()
    .get()
}

export function hasLoopTroopState(projectRoot: string): boolean {
  const repoRoot = resolveGitRepoRoot(projectRoot)
  if (!repoRoot) return false
  return !!readLocalProject(repoRoot)
}

export function attachProject(input: ProjectAttachmentInput): PublicProject {
  const projectRoot = resolveGitRepoRoot(input.folderPath)
  if (!projectRoot) {
    throw new Error(`Folder is not a git repository: ${input.folderPath}`)
  }

  ensureLocalGitExclude(projectRoot)
  const localProject = ensureLocalProject(projectRoot, input)
  const attached = ensureAttachedProject(projectRoot)

  return hydrateProject(attached, localProject)
}

export function attachExistingProject(input: Partial<ProjectAttachmentInput> & { folderPath: string } | string): PublicProject {
  const projectRootOrFolder = typeof input === 'string' ? input : input.folderPath
  const projectRoot = resolveGitRepoRoot(projectRootOrFolder)
  if (!projectRoot) {
    throw new Error(`Folder is not a git repository: ${projectRootOrFolder}`)
  }

  ensureLocalGitExclude(projectRoot)
  const localProject = ensureLocalProject(projectRoot)
  const patch = typeof input === 'string'
    ? null
    : {
        name: input.name ?? localProject.name,
        icon: input.icon ?? localProject.icon,
        color: input.color ?? localProject.color,
        folderPath: projectRoot,
        profileId: input.profileId ?? localProject.profileId,
        councilMembers: input.councilMembers ?? localProject.councilMembers,
        manualQaOverride: input.manualQaOverride === undefined
          ? localProject.manualQaOverride
          : input.manualQaOverride,
        gitHookPolicy: input.gitHookPolicy === undefined
          ? localProject.gitHookPolicy
          : input.gitHookPolicy,
        maxIterations: input.maxIterations ?? localProject.maxIterations,
        perIterationTimeout: input.perIterationTimeout ?? localProject.perIterationTimeout,
        executionSetupTimeout: input.executionSetupTimeout ?? localProject.executionSetupTimeout,
        councilResponseTimeout: input.councilResponseTimeout ?? localProject.councilResponseTimeout,
        minCouncilQuorum: input.minCouncilQuorum ?? localProject.minCouncilQuorum,
        interviewQuestions: input.interviewQuestions ?? localProject.interviewQuestions,
        updatedAt: new Date().toISOString(),
      }

  let effectiveProject = localProject
  if (patch) {
    const { db } = getProjectDatabase(projectRoot)
    db.update(projects)
      .set(patch)
      .where(eq(projects.id, localProject.id))
      .run()
    effectiveProject = db.select().from(projects).where(eq(projects.id, localProject.id)).get() ?? localProject
  }

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

export function updateProject(id: number, patch: Partial<Pick<LocalProjectRow, 'name' | 'icon' | 'color' | 'councilMembers' | 'manualQaOverride' | 'gitHookPolicy' | 'maxIterations' | 'perIterationTimeout' | 'executionSetupTimeout' | 'councilResponseTimeout' | 'minCouncilQuorum' | 'interviewQuestions'>>): PublicProject | undefined {
  const context = getProjectContextById(id)
  if (!context) return undefined
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
    .where(or(eq(tickets.status, 'COMPLETED'), eq(tickets.status, 'CANCELED')))
    .all()
  return rows.map(r => r.externalId)
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
  const manualQaOverride = input.manualQaOverride === undefined
    ? project.manualQaOverride
    : input.manualQaOverride

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
          manual_qa_override = ?, git_hook_policy = ?, ticket_counter = 0,
          updated_at = ?
      WHERE id = ?
    `).run(
      input.name,
      input.icon ?? project.icon,
      input.color ?? project.color,
      projectRoot,
      manualQaOverride === null ? null : Number(manualQaOverride),
      input.gitHookPolicy === undefined ? project.gitHookPolicy : input.gitHookPolicy,
      new Date().toISOString(),
      project.id,
    )
  })()

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
