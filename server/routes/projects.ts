import { Hono } from 'hono'
import { z } from 'zod'
import { execFile } from 'child_process'
import { access, constants, readdir, stat } from 'fs/promises'
import { dirname, resolve as resolvePath } from 'path'
import { homedir } from 'os'
import { promisify } from 'util'

import {
  attachExistingProject,
  attachProject,
  clearExistingProjectTickets,
  deleteProject,
  deleteProjectWorktrees,
  getProjectWorktreesSize,
  type ExistingProjectMetadata,
  getProjectById,
  getProjectRootById,
  listProjectTickets,
  listProjects,
  resolveProjectState,
  replaceExistingProjectState,
  updateProject,
} from '../storage/projects'
import { getGitHubRepoWriteAccess, parseGitHubRemoteUrl, type GitHubRepoWriteAccess } from '../git/github'
import { buildRuntimeStatus } from '../runtime'
import { normalizeFolderPath } from '../storage/paths'
import { buildWslProjectMountedDriveWarning, isWslWindowsMountPath } from '../../shared/wslPerformance'

const projectRouter = new Hono()
const execFileAsync = promisify(execFile)
const GIT_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024

const perProjectOverrides = {
  gitHookPolicy: z.enum(['observe_only', 'validate_advisory', 'validate_required', 'use_native_hooks']).nullable().optional(),
  manualQaOverride: z.boolean().nullable().optional(),
  councilMembers: z.string().optional(),
  maxIterations: z.number().int().min(0).max(20).optional(),
  perIterationTimeout: z.number().int().nonnegative().optional(),
  executionSetupTimeout: z.number().int().nonnegative().optional(),
  councilResponseTimeout: z.number().int().positive().optional(),
  minCouncilQuorum: z.number().int().min(1).max(6).optional(),
  interviewQuestions: z.number().int().min(0).max(50).optional(),
}

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  shortname: z.string().min(3).max(5).regex(/^[A-Z0-9]+$/, 'Shortname must be 3-5 uppercase letters or numbers'),
  icon: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  folderPath: z.string().min(1),
  profileId: z.number().int().positive().optional(),
  existingStateAction: z.enum(['restore', 'clear_tickets', 'start_fresh']).optional(),
  ...perProjectOverrides,
})

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  icon: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  ...perProjectOverrides,
})

interface GitRepoInfo {
  isGit: boolean
  repoRoot?: string
  isRepoRoot?: boolean
  hasGitHubOrigin?: boolean
  githubRepoSlug?: string | null
  githubOriginWriteAccess?: GitHubRepoWriteAccess['status']
  githubViewerPermission?: string | null
  githubWriteWarning?: string
  hasLoopTroopState?: boolean
  existingProject?: ExistingProjectMetadata | null
}

async function existsAsync(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function resolveGitRepoRootAsync(folderPath: string): Promise<string | null> {
  const normalized = normalizeFolderPath(folderPath)
  if (!(await existsAsync(normalized))) return null

  try {
    const { stdout } = await execFileAsync('git', ['-C', normalized, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
    })
    const repoRoot = stdout.trim()
    return repoRoot ? normalizeFolderPath(repoRoot) : null
  } catch {
    return null
  }
}

async function readOriginRemoteUrlAsync(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function getGitRepoInfo(folderPath: string): Promise<GitRepoInfo> {
  const resolved = normalizeFolderPath(folderPath)
  if (!(await existsAsync(resolved))) {
    console.warn(`[getGitRepoInfo] Path does not exist: ${resolved} (original: ${folderPath})`)
    return { isGit: false }
  }

  const repoRoot = await resolveGitRepoRootAsync(resolved)
  if (!repoRoot) return { isGit: false }
  const githubRepo = parseGitHubRemoteUrl(await readOriginRemoteUrlAsync(repoRoot))
  const writeAccess = githubRepo ? getGitHubRepoWriteAccess(repoRoot) : null

  const state = resolveProjectState(repoRoot)
  return {
    isGit: true,
    repoRoot,
    isRepoRoot: repoRoot === resolved,
    hasGitHubOrigin: githubRepo !== null,
    githubRepoSlug: githubRepo?.slug ?? null,
    githubOriginWriteAccess: writeAccess?.status,
    githubViewerPermission: writeAccess?.permission ?? null,
    ...(githubRepo && writeAccess?.status === 'read_only'
      ? {
          githubWriteWarning: `The active GitHub CLI account has ${writeAccess.permission} access to ${githubRepo.slug}, which does not include branch write access. You can attach this project, but LoopTroop's bead pushes may fail unless origin uses writable credentials. Configure a writable fork or repository as origin before starting tickets.`,
        }
      : {}),
    hasLoopTroopState: state.exists,
    existingProject: state.existingProject,
  }
}

function getProjectPerformanceWarning(folderPath: string): string | null {
  const runtime = buildRuntimeStatus()
  const resolved = normalizeFolderPath(folderPath)
  if (!runtime.isWsl || !isWslWindowsMountPath(resolved)) return null
  return buildWslProjectMountedDriveWarning(resolved)
}

projectRouter.get('/projects/check-git', async (c) => {
  const rawPath = c.req.query('path')
  if (!rawPath) return c.json({ isGit: false, status: 'none', message: 'No path provided' })

  const folderPath = normalizeFolderPath(rawPath)
  const performanceWarning = getProjectPerformanceWarning(folderPath)
  const warningPayload = performanceWarning ? { performanceWarning } : {}
  if (!(await existsAsync(folderPath))) {
    return c.json({
      isGit: false,
      status: 'invalid',
      message: `Folder does not exist: ${folderPath}`,
      ...warningPayload,
    })
  }

  const gitInfo = await getGitRepoInfo(folderPath)
  if (gitInfo.isGit) {
    if (!gitInfo.hasGitHubOrigin) {
      return c.json({
        isGit: true,
        status: 'invalid',
        scope: gitInfo.isRepoRoot ? 'root' : 'subfolder',
        repoRoot: gitInfo.repoRoot,
        hasLoopTroopState: gitInfo.hasLoopTroopState ?? false,
        existingProject: gitInfo.existingProject ?? null,
        message: 'Git repository found, but origin must resolve to github.com.',
        ...warningPayload,
      })
    }

    return c.json({
      isGit: true,
      status: 'valid',
      scope: gitInfo.isRepoRoot ? 'root' : 'subfolder',
      repoRoot: gitInfo.repoRoot,
      githubRepoSlug: gitInfo.githubRepoSlug ?? null,
      githubOriginWriteAccess: gitInfo.githubOriginWriteAccess ?? 'unknown',
      githubViewerPermission: gitInfo.githubViewerPermission ?? null,
      ...(gitInfo.githubWriteWarning ? { githubWriteWarning: gitInfo.githubWriteWarning } : {}),
      hasLoopTroopState: gitInfo.hasLoopTroopState ?? false,
      existingProject: gitInfo.existingProject ?? null,
      message: gitInfo.isRepoRoot
        ? (gitInfo.hasLoopTroopState ? 'Existing LoopTroop project found at repository root' : 'Git repository root selected')
        : `Subfolder inside Git repository (root: ${gitInfo.repoRoot})`,
      ...warningPayload,
    })
  }

  return c.json({
    isGit: false,
    status: 'invalid',
    message: 'Folder is not a git repository',
    ...warningPayload,
  })
})

projectRouter.get('/projects/ls', async (c) => {
  const rawPath = c.req.query('path')
  const targetPath = normalizeFolderPath(rawPath || homedir())

  if (!(await existsAsync(targetPath))) {
    return c.json({ error: `Path does not exist: ${targetPath}` }, 400)
  }

  try {
    const entries = await readdir(targetPath)
    const dirsWithNull = await Promise.all(
      entries.map(async (name) => {
        try {
          const full = resolvePath(targetPath, name)
          const s = await stat(full)
          return s.isDirectory() ? { name, path: full } : null
        } catch {
          return null
        }
      })
    )
    const dirs = dirsWithNull
      .filter((d): d is { name: string; path: string } => d !== null)
      .sort((a, b) => a.name.localeCompare(b.name))

    const parent = dirname(targetPath)
    return c.json({
      currentPath: targetPath,
      parentPath: parent === targetPath ? null : parent,
      dirs,
    })
  } catch {
    return c.json({ error: `Cannot read directory: ${targetPath}` }, 400)
  }
})

projectRouter.get('/projects', (c) => {
  return c.json(listProjects())
})

projectRouter.get('/projects/:id', (c) => {
  const id = Number(c.req.param('id'))
  if (Number.isNaN(id)) return c.json({ error: 'Invalid project ID' }, 400)
  const project = getProjectById(id)
  if (!project) return c.json({ error: 'Project not found' }, 404)
  return c.json(project)
})

projectRouter.post('/projects', async (c) => {
  const body = await c.req.json()
  const parsed = createProjectSchema.safeParse(body)
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors
    const message = Object.entries(fieldErrors)
      .map(([field, errors]) => `${field}: ${(errors as string[]).join(', ')}`)
      .join('; ')
    return c.json({ error: 'Invalid input', details: parsed.error.flatten(), message }, 400)
  }

  const repoRoot = await resolveGitRepoRootAsync(parsed.data.folderPath)
  if (process.env.NODE_ENV !== 'test' && !repoRoot) {
    return c.json({
      error: 'Folder is not a git repository',
      details: `No git repository found at: ${parsed.data.folderPath}. Please initialize the repository with 'git init' first.`,
    }, 400)
  }

  const githubRepo = repoRoot ? parseGitHubRemoteUrl(await readOriginRemoteUrlAsync(repoRoot)) : null
  if (!githubRepo) {
    return c.json({
      error: 'GitHub origin remote is required',
      details: 'LoopTroop requires an origin remote that resolves to github.com before attaching a project.',
    }, 400)
  }

  const projectRootPath = repoRoot ?? parsed.data.folderPath
  const projectState = resolveProjectState(projectRootPath)
  try {
    const action = parsed.data.existingStateAction ?? 'restore'
    const input = { ...parsed.data, folderPath: projectRootPath }
    const result = projectState.exists
      ? action === 'clear_tickets'
        ? await clearExistingProjectTickets(input)
        : action === 'start_fresh'
          ? await replaceExistingProjectState(input)
          : attachExistingProject(input)
      : attachProject(input)
    return c.json(result, 201)
  } catch (err) {
    return c.json({ error: 'Failed to attach project', details: String(err) }, 500)
  }
})

projectRouter.patch('/projects/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (Number.isNaN(id)) return c.json({ error: 'Invalid project ID' }, 400)
  const body = await c.req.json()
  const parsed = updateProjectSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.flatten() }, 400)
  }

  const result = updateProject(id, parsed.data)
  if (!result) return c.json({ error: 'Project not found' }, 404)
  return c.json(result)
})

projectRouter.get('/projects/:id/worktrees/size', async (c) => {
  const id = Number(c.req.param('id'))
  if (Number.isNaN(id)) return c.json({ error: 'Invalid project ID' }, 400)
  const projectRoot = getProjectRootById(id)
  if (!projectRoot) return c.json({ error: 'Project not found' }, 404)

  const bytes = await getProjectWorktreesSize(projectRoot)
  return c.json({ bytes })
})

projectRouter.delete('/projects/:id/worktrees', async (c) => {
  const id = Number(c.req.param('id'))
  if (Number.isNaN(id)) return c.json({ error: 'Invalid project ID' }, 400)
  const projectRoot = getProjectRootById(id)
  if (!projectRoot) return c.json({ error: 'Project not found' }, 404)

  try {
    const result = await deleteProjectWorktrees(projectRoot)
    return c.json({ success: true, freedBytes: result.freedBytes })
  } catch (err) {
    return c.json({ error: 'Failed to delete worktrees', details: String(err) }, 500)
  }
})

projectRouter.delete('/projects/:id', (c) => {
  const id = Number(c.req.param('id'))
  if (Number.isNaN(id)) return c.json({ error: 'Invalid project ID' }, 400)
  const projectRoot = getProjectRootById(id)
  if (!projectRoot) return c.json({ error: 'Project not found' }, 404)

  const projectTickets = listProjectTickets(id)
  const allowedStatuses = ['DRAFT', 'COMPLETED', 'CANCELED']
  const hasInProgress = projectTickets.some(ticket => !allowedStatuses.includes(ticket.status))
  if (hasInProgress) {
    return c.json({ error: 'Cannot delete project. Some tickets are still in progress. Move all tickets to Done or cancel them first.' }, 409)
  }

  try {
    deleteProject(id)
    return c.json({ success: true, projectRoot })
  } catch (err) {
    return c.json({ error: 'Failed to delete project', details: String(err) }, 500)
  }
})

export { projectRouter }
