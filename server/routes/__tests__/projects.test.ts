import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Hono } from 'hono'
import { resolve } from 'node:path'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import {
  beadExecutionMetrics,
  manualQaImprovementTickets,
  manualQaOperations,
  opencodeSessions,
  phaseArtifacts,
  projects,
  ticketErrorOccurrences,
  ticketAiTurnMetrics,
  ticketPhaseAttempts,
  ticketStatusHistory,
  tickets,
} from '../../db/schema'
import { getProjectLoopTroopDir, normalizeFolderPath } from '../../storage/paths'
import {
  attachExistingProject,
  attachProject,
  deleteProject,
  getProjectContextById,
  listProjects,
  resolveProjectState,
  updateProject,
} from '../../storage/projects'
import { createTicket, patchTicket } from '../../storage/ticketMutations'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { projectRouter } from '../projects'

const getGitHubRepoWriteAccessMock = vi.hoisted(() => vi.fn())

vi.mock('../../git/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git/github')>()
  return {
    ...actual,
    getGitHubRepoWriteAccess: getGitHubRepoWriteAccessMock,
  }
})

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-project-route-',
  files: {
    'README.md': '# LoopTroop Project Route Test\n',
  },
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function getLocalExcludePath(repoDir: string): string {
  return resolve(repoDir, git(repoDir, ['rev-parse', '--git-path', 'info/exclude']))
}

function readLocalExcludeRules(repoDir: string): string[] {
  return readFileSync(getLocalExcludePath(repoDir), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
}

function addGithubOrigin(repoDir: string) {
  git(repoDir, ['remote', 'add', 'origin', 'git@github.com:test/looptroop.git'])
}

describe('projectRouter project cleanup', () => {
  it('persists all three project Manual QA override states', () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({ folderPath: repoDir, name: 'QA project', shortname: 'MQA' })
    expect(project.manualQaOverride).toBeNull()
    expect(updateProject(project.id, { manualQaOverride: true })?.manualQaOverride).toBe(true)
    expect(updateProject(project.id, { manualQaOverride: false })?.manualQaOverride).toBe(false)
    expect(updateProject(project.id, { manualQaOverride: null })?.manualQaOverride).toBeNull()
  })

  it('persists nullable project Git hook policy overrides', () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({ folderPath: repoDir, name: 'Hooks project', shortname: 'HKS' })
    expect(project.gitHookPolicy).toBeNull()
    expect(updateProject(project.id, { gitHookPolicy: 'observe_only' })?.gitHookPolicy).toBe('observe_only')
    expect(updateProject(project.id, { gitHookPolicy: 'validate_advisory' })?.gitHookPolicy).toBe('validate_advisory')
    expect(updateProject(project.id, { gitHookPolicy: 'validate_required' })?.gitHookPolicy).toBe('validate_required')
    expect(updateProject(project.id, { gitHookPolicy: 'use_native_hooks' })?.gitHookPolicy).toBe('use_native_hooks')
    expect(updateProject(project.id, { gitHookPolicy: null })?.gitHookPolicy).toBeNull()
  })

  it.each([
    ['validate_explicitly', 'validate_advisory'],
    ['ignore_internal_only', 'observe_only'],
    ['use_on_internal_commits', 'use_native_hooks'],
  ] as const)('migrates persisted project policy %s to %s when project state opens', (legacyPolicy, expected) => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({ folderPath: repoDir, name: 'Legacy hooks project', shortname: 'LHP' })
    const context = getProjectContextById(project.id)
    expect(context).toBeDefined()
    context!.projectDb.update(projects).set({ gitHookPolicy: legacyPolicy }).run()
    clearProjectDatabaseCache()

    expect(attachExistingProject(repoDir).gitHookPolicy).toBe(expected)
  })

  beforeEach(() => {
    getGitHubRepoWriteAccessMock.mockReset()
    getGitHubRepoWriteAccessMock.mockReturnValue({ status: 'unknown', permission: null })
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  afterEach(() => {
    delete process.env.WSL_DISTRO_NAME
  })

  it('installs repo-local LoopTroop excludes and keeps git status clean', () => {
    const repoDir = repoManager.createRepo()

    attachProject({
      folderPath: repoDir,
      name: 'Original Project',
      shortname: 'OLD',
    })

    writeFileSync(resolve(getProjectLoopTroopDir(repoDir), 'runtime-marker.txt'), 'runtime\n')
    mkdirSync(resolve(repoDir, '.ticket'), { recursive: true })
    writeFileSync(resolve(repoDir, '.ticket', 'runtime-marker.txt'), 'ticket runtime\n')

    expect(readLocalExcludeRules(repoDir)).toContain('/.looptroop/')
    expect(readLocalExcludeRules(repoDir)).toContain('/.ticket/')
    expect(git(repoDir, ['status', '--porcelain'])).toBe('')
  })

  it('does not duplicate repo-local LoopTroop exclude rules on reattach', () => {
    const repoDir = repoManager.createRepo()

    attachProject({
      folderPath: repoDir,
      name: 'Original Project',
      shortname: 'OLD',
    })
    attachExistingProject(repoDir)

    const loopTroopRules = readLocalExcludeRules(repoDir)
      .filter((rule) => rule === '/.looptroop/')
    const ticketRules = readLocalExcludeRules(repoDir)
      .filter((rule) => rule === '/.ticket/')

    expect(loopTroopRules).toHaveLength(1)
    expect(ticketRules).toHaveLength(1)
  })

  it('deletes project-local LoopTroop state and allows a clean re-attach', async () => {
    const repoDir = repoManager.createRepo()
    addGithubOrigin(repoDir)
    const app = new Hono()
    app.route('/api', projectRouter)

    const createResponse = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Original Project',
        shortname: 'TST',
        folderPath: repoDir,
      }),
    })

    expect(createResponse.status).toBe(201)
    const created = await createResponse.json() as { id: number }
    const projectStateDir = getProjectLoopTroopDir(repoDir)

    expect(existsSync(projectStateDir)).toBe(true)
    expect(resolveProjectState(repoDir).exists).toBe(true)

    const deleteResponse = await app.request(`/api/projects/${created.id}`, {
      method: 'DELETE',
    })

    expect(deleteResponse.status).toBe(200)
    expect(existsSync(projectStateDir)).toBe(false)

    const checkResponse = await app.request(`/api/projects/check-git?path=${encodeURIComponent(repoDir)}`)
    expect(checkResponse.status).toBe(200)
    const checkPayload = await checkResponse.json() as {
      hasLoopTroopState?: boolean
      existingProject?: unknown
    }
    expect(checkPayload.hasLoopTroopState).toBe(false)
    expect(checkPayload.existingProject).toBeNull()

    const recreateResponse = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Fresh Project',
        shortname: 'NEW',
        folderPath: repoDir,
      }),
    })

    expect(recreateResponse.status).toBe(201)
    const recreated = await recreateResponse.json() as {
      name: string
      shortname: string
    }
    expect(recreated.name).toBe('Fresh Project')
    expect(recreated.shortname).toBe('NEW')
  })

  it('previews active tickets and saved editable settings', async () => {
    const repoDir = repoManager.createRepo()
    addGithubOrigin(repoDir)
    const project = attachProject({
      folderPath: repoDir,
      name: 'Saved Project',
      shortname: 'SVD',
      icon: '🔎',
      color: '#a855f7',
      gitHookPolicy: 'observe_only',
      manualQaOverride: false,
    })
    createTicket({ projectId: project.id, title: 'Draft ticket' })
    const activeTicket = createTicket({ projectId: project.id, title: 'Active ticket' })
    patchTicket(activeTicket.id, { status: 'CODING' })
    const completedTicket = createTicket({ projectId: project.id, title: 'Completed ticket' })
    patchTicket(completedTicket.id, { status: 'COMPLETED' })

    const app = new Hono()
    app.route('/api', projectRouter)
    const response = await app.request(`/api/projects/check-git?path=${encodeURIComponent(repoDir)}`)
    expect(response.status).toBe(200)
    const payload = await response.json() as {
      existingProject: {
        name: string
        shortname: string
        icon: string | null
        color: string | null
        gitHookPolicy: string | null
        manualQaOverride: boolean | null
        ticketCount: number
        activeTicketCount: number
      }
    }

    expect(payload.existingProject).toMatchObject({
      name: 'Saved Project',
      shortname: 'SVD',
      icon: '🔎',
      color: '#a855f7',
      gitHookPolicy: 'observe_only',
      manualQaOverride: false,
      ticketCount: 3,
      activeTicketCount: 1,
    })
  })

  it('warns without invalidating project attachment when the GitHub CLI account cannot write to origin', async () => {
    const repoDir = repoManager.createRepo()
    addGithubOrigin(repoDir)
    getGitHubRepoWriteAccessMock.mockReturnValue({ status: 'read_only', permission: 'READ' })

    const app = new Hono()
    app.route('/api', projectRouter)
    const response = await app.request(`/api/projects/check-git?path=${encodeURIComponent(repoDir)}`)
    const payload = await response.json() as {
      status: string
      githubRepoSlug: string
      githubOriginWriteAccess: string
      githubViewerPermission: string
      githubWriteWarning: string
    }

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      status: 'valid',
      githubRepoSlug: 'test/looptroop',
      githubOriginWriteAccess: 'read_only',
      githubViewerPermission: 'READ',
    })
    expect(payload.githubWriteWarning).toContain('does not include branch write access')
    expect(payload.githubWriteWarning).toContain('You can attach this project')
  })

  it('restores existing state by default and updates its current repository path', async () => {
    const repoDir = repoManager.createRepo()
    addGithubOrigin(repoDir)
    const project = attachProject({
      folderPath: repoDir,
      name: 'Saved Project',
      shortname: 'SVD',
    })
    const ticket = createTicket({ projectId: project.id, title: 'Keep me' })
    const context = getProjectContextById(project.id)!
    context.projectDb.update(projects)
      .set({ folderPath: '/old-machine/saved-project' })
      .run()

    const app = new Hono()
    app.route('/api', projectRouter)
    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Renamed Project',
        shortname: 'IGN',
        folderPath: repoDir,
        icon: '✨',
        color: '#123456',
      }),
    })
    expect(response.status).toBe(201)
    const restored = await response.json() as {
      name: string
      shortname: string
      icon: string | null
      color: string | null
      folderPath: string
    }
    expect(restored).toMatchObject({
      name: 'Renamed Project',
      shortname: 'SVD',
      icon: '✨',
      color: '#123456',
      folderPath: normalizeFolderPath(repoDir),
    })
    expect(getProjectContextById(project.id)?.projectDb.select().from(tickets).all())
      .toContainEqual(expect.objectContaining({ externalId: ticket.externalId }))

    const explicitRestoreResponse = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Explicit Restore',
        shortname: 'SVD',
        folderPath: repoDir,
        existingStateAction: 'restore',
      }),
    })
    expect(explicitRestoreResponse.status).toBe(201)
    expect(await explicitRestoreResponse.json()).toMatchObject({
      name: 'Explicit Restore',
      shortname: 'SVD',
      folderPath: normalizeFolderPath(repoDir),
    })
  })

  it('clears every ticket-owned row and managed worktree while retaining project settings', async () => {
    const repoDir = repoManager.createRepo()
    addGithubOrigin(repoDir)
    const project = attachProject({
      folderPath: repoDir,
      name: 'Saved Project',
      shortname: 'SVD',
      icon: '🔎',
      color: '#a855f7',
      councilMembers: '["provider/model"]',
      maxIterations: 9,
      gitHookPolicy: 'validate_advisory',
      manualQaOverride: true,
    })
    const ticket = createTicket({ projectId: project.id, title: 'Active ticket' })
    patchTicket(ticket.id, { status: 'CODING' })
    const context = getProjectContextById(project.id)!
    const localTicket = context.projectDb.select().from(tickets).get()!
    context.projectDb.update(projects)
      .set({ updatedAt: '2000-01-01T00:00:00.000Z' })
      .run()
    const originalCreatedAt = context.project.createdAt
    const worktreePath = resolve(repoDir, '.looptroop', 'worktrees', ticket.externalId)
    rmSync(worktreePath, { recursive: true, force: true })
    git(repoDir, ['worktree', 'add', '-b', 'looptroop-clear-test', worktreePath])
    writeFileSync(resolve(worktreePath, 'worktree-marker.txt'), 'remove me\n')

    context.projectDb.insert(phaseArtifacts).values({
      ticketId: localTicket.id, phase: 'CODING', content: '{}',
    }).run()
    context.projectDb.insert(ticketPhaseAttempts).values({
      ticketId: localTicket.id, phase: 'CODING', attemptNumber: 1,
    }).run()
    context.projectDb.insert(manualQaOperations).values({
      ticketId: localTicket.id,
      actionId: 'action',
      version: 1,
      checklistHash: 'hash',
      draftRevision: 1,
      payload: '{}',
    }).run()
    context.projectDb.insert(manualQaImprovementTickets).values({
      originId: 'origin',
      destinationTicketId: localTicket.id,
      actionId: 'action',
    }).run()
    context.projectDb.insert(opencodeSessions).values({
      sessionId: 'session',
      ticketId: localTicket.id,
      phase: 'CODING',
    }).run()
    context.projectDb.insert(ticketStatusHistory).values({
      ticketId: localTicket.id,
      newStatus: 'CODING',
    }).run()
    context.projectDb.insert(ticketErrorOccurrences).values({
      ticketId: localTicket.id,
      occurrenceNumber: 1,
      blockedFromStatus: 'CODING',
    }).run()
    context.projectDb.insert(beadExecutionMetrics).values({
      ticketId: localTicket.id,
      beadId: 'bead-1',
      sizeBucket: 'S',
      effortTier: 'medium',
      activeDurationMs: 100,
      completedAt: new Date().toISOString(),
    }).run()
    context.projectDb.insert(ticketAiTurnMetrics).values({
      ticketId: localTicket.id,
      phase: 'CODING',
      phaseAttempt: 1,
      sessionId: 'session',
      assistantMessageId: 'assistant-message',
      modelId: 'provider/model',
    }).run()

    const app = new Hono()
    app.route('/api', projectRouter)
    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Updated Name',
        shortname: 'SVD',
        folderPath: repoDir,
        icon: '✨',
        color: '#123456',
        gitHookPolicy: 'observe_only',
        manualQaOverride: false,
        existingStateAction: 'clear_tickets',
      }),
    })
    expect(response.status, await response.clone().text()).toBe(201)

    const cleared = getProjectContextById(project.id)!
    expect(cleared.project).toMatchObject({
      name: 'Updated Name',
      shortname: 'SVD',
      icon: '✨',
      color: '#123456',
      councilMembers: '["provider/model"]',
      maxIterations: 9,
      gitHookPolicy: 'observe_only',
      manualQaOverride: false,
      ticketCounter: 0,
      folderPath: repoDir,
      createdAt: originalCreatedAt,
    })
    expect(cleared.project.updatedAt).not.toBe('2000-01-01T00:00:00.000Z')
    for (const table of [
      manualQaImprovementTickets,
      manualQaOperations,
      phaseArtifacts,
      ticketPhaseAttempts,
      opencodeSessions,
      ticketStatusHistory,
      ticketErrorOccurrences,
      beadExecutionMetrics,
      ticketAiTurnMetrics,
      tickets,
    ]) {
      expect(cleared.projectDb.select().from(table).all()).toHaveLength(0)
    }
    expect(existsSync(worktreePath)).toBe(false)
    expect(git(repoDir, ['worktree', 'list', '--porcelain'])).not.toContain(worktreePath)
    expect(git(repoDir, ['show-ref', '--verify', 'refs/heads/looptroop-clear-test'])).toContain('looptroop-clear-test')
  })

  it('starts fresh with form metadata after removing existing state and tickets', async () => {
    const repoDir = repoManager.createRepo()
    addGithubOrigin(repoDir)
    const original = attachProject({
      folderPath: repoDir,
      name: 'Saved Project',
      shortname: 'SVD',
      councilMembers: '["old/model"]',
    })
    createTicket({ projectId: original.id, title: 'Remove me' })

    const app = new Hono()
    app.route('/api', projectRouter)
    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Fresh Project',
        shortname: 'NEW',
        folderPath: repoDir,
        icon: '🌱',
        color: '#654321',
        councilMembers: '["new/model"]',
        existingStateAction: 'start_fresh',
      }),
    })
    expect(response.status).toBe(201)
    const fresh = await response.json() as {
      id: number
      name: string
      shortname: string
      ticketCounter: number
      councilMembers: string | null
    }
    expect(fresh).toMatchObject({
      name: 'Fresh Project',
      shortname: 'NEW',
      ticketCounter: 0,
      councilMembers: '["new/model"]',
    })
    expect(getProjectContextById(fresh.id)?.projectDb.select().from(tickets).all()).toHaveLength(0)
  })

  it('drops stale cached state after .looptroop is removed outside the app', () => {
    const repoDir = repoManager.createRepo()
    attachProject({
      folderPath: repoDir,
      name: 'Original Project',
      shortname: 'OLD',
    })

    expect(resolveProjectState(repoDir).exists).toBe(true)

    // Windows refuses to unlink an open file, and attaching leaves a cached
    // handle on <repo>/.looptroop/db.sqlite.
    clearProjectDatabaseCache()
    rmSync(getProjectLoopTroopDir(repoDir), { recursive: true, force: true })

    const stateAfterDelete = resolveProjectState(repoDir)
    expect(stateAfterDelete.exists).toBe(false)
    expect(stateAfterDelete.existingProject).toBeNull()
    expect(listProjects()).toEqual([])
    expect(existsSync(getProjectLoopTroopDir(repoDir))).toBe(false)

    const reattached = attachProject({
      folderPath: repoDir,
      name: 'Fresh Project',
      shortname: 'NEW',
    })

    expect(reattached.name).toBe('Fresh Project')
    expect(reattached.shortname).toBe('NEW')
  })

  // WSL detection requires platform === 'linux', so this behaviour is
  // unreachable on macOS and Windows regardless of the env var.
  it.runIf(process.platform === 'linux')('returns a WSL mounted-drive performance warning for Windows-backed paths', async () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
    const app = new Hono()
    app.route('/api', projectRouter)

    const response = await app.request('/api/projects/check-git?path=/mnt/c/Users/example/repo')
    expect(response.status).toBe(200)

    const payload = await response.json() as {
      performanceWarning?: string
      message: string
      status: string
    }

    expect(payload.status).toBe('invalid')
    expect(payload.message).toContain('/mnt/c/Users/example/repo')
    expect(payload.performanceWarning).toContain('/mnt/c/Users/example/repo')
  })

  it('allows deleting worktrees even when tickets are in active/working statuses', async () => {
    const repoDir = repoManager.createRepo()
    addGithubOrigin(repoDir)
    const app = new Hono()
    app.route('/api', projectRouter)

    const createResponse = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Worktrees Test', shortname: 'WKT', folderPath: repoDir }),
    })
    expect(createResponse.status).toBe(201)
    const { id: projectId } = await createResponse.json() as { id: number }

    // Create a ticket and move it to an active (non-terminal) status
    const ticket = createTicket({ projectId, title: 'Active ticket' })
    patchTicket(ticket.id, { status: 'CODING' })

    // Delete-worktrees must succeed regardless of active tickets
    const deleteResponse = await app.request(`/api/projects/${projectId}/worktrees`, {
      method: 'DELETE',
    })

    expect(deleteResponse.status).toBe(200)
    const payload = await deleteResponse.json() as { success: boolean; freedBytes: number }
    expect(payload.success).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('deletes terminal worktrees containing read-only cache directories', async () => {
    const repoDir = repoManager.createRepo()
    addGithubOrigin(repoDir)
    const app = new Hono()
    app.route('/api', projectRouter)

    const project = attachProject({
      folderPath: repoDir,
      name: 'Read-only Cache Project',
      shortname: 'ROC',
    })
    const ticket = createTicket({ projectId: project.id, title: 'Read-only cache ticket' })
    patchTicket(ticket.id, { status: 'COMPLETED' })

    const worktreePath = resolve(repoDir, '.looptroop', 'worktrees', ticket.externalId)
    const cacheRoot = resolve(
      worktreePath,
      '.ticket/runtime/execution-setup/tool-cache/gomodcache/example.test/module@v1.0.0',
    )
    const readOnlyDir = resolve(cacheRoot, '.github')
    mkdirSync(readOnlyDir, { recursive: true })
    writeFileSync(resolve(readOnlyDir, 'dependabot.yml'), 'version: 2\n')
    chmodSync(readOnlyDir, 0o555)
    chmodSync(cacheRoot, 0o555)

    const response = await app.request(`/api/projects/${project.id}/worktrees`, {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)
    expect(existsSync(worktreePath)).toBe(false)
  })

  it('refuses direct project deletion while active tickets exist', () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: 'Active Guard Project',
      shortname: 'AGP',
    })
    const ticket = createTicket({ projectId: project.id, title: 'Active ticket' })
    patchTicket(ticket.id, { status: 'CODING' })

    expect(() => deleteProject(project.id)).toThrow('Cannot delete project while tickets are still active')
    expect(existsSync(getProjectLoopTroopDir(repoDir))).toBe(true)
  })
})
