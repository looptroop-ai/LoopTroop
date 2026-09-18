import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { attachProject, deleteAllProjectWorktrees, deleteProjectWorktrees, getProjectWorktreesSize } from '../projects'
import { getTicketWorktreeEntryPath } from '../paths'
import { createTicket, patchTicket } from '../tickets'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

const roots: string[] = []
const repositories = createFixtureRepoManager({ templatePrefix: 'project-cleanup-size-', files: { 'README.md': 'test\n' } })
beforeEach(() => {
  clearProjectDatabaseCache()
  initializeDatabase()
  sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
})
afterEach(() => { for (const root of roots.splice(0)) removeTempDir(root) })
afterAll(() => {
  clearProjectDatabaseCache()
  repositories.cleanup()
})

describe('project worktree cleanup containment', () => {
  it('refuses a contained managed-root alias without deleting its source files', async () => {
    const projectRoot = makeTempDir('project-cleanup-alias-')
    roots.push(projectRoot)
    const source = resolve(projectRoot, 'source')
    mkdirSync(source)
    writeFileSync(resolve(source, 'keep.txt'), 'preserve me')
    mkdirSync(resolve(projectRoot, '.looptroop'))
    symlinkSync(source, resolve(projectRoot, '.looptroop/worktrees'), 'junction')
    await expect(deleteAllProjectWorktrees(projectRoot)).rejects.toThrow('must not be a symbolic link')
    await expect(getProjectWorktreesSize(projectRoot)).rejects.toThrow('must not be a symbolic link')
    expect(readFileSync(resolve(source, 'keep.txt'), 'utf8')).toBe('preserve me')
  })

  it('unlinks individual outside aliases without enumerating their destinations', async () => {
    const projectRoot = makeTempDir('project-cleanup-final-alias-')
    const outside = makeTempDir('project-cleanup-outside-')
    roots.push(projectRoot, outside)
    writeFileSync(resolve(outside, 'keep.txt'), 'preserve me')
    const worktrees = resolve(projectRoot, '.looptroop/worktrees')
    mkdirSync(worktrees, { recursive: true })
    const alias = resolve(worktrees, 'TEST-1')
    symlinkSync(outside, alias, 'junction')
    await expect(deleteAllProjectWorktrees(projectRoot)).resolves.toEqual({ freedBytes: 0 })
    expect(existsSync(alias)).toBe(false)
    expect(readFileSync(resolve(outside, 'keep.txt'), 'utf8')).toBe('preserve me')
  })

  it('does not count outside or dangling terminal worktree aliases', async () => {
    const project = attachProject({ folderPath: repositories.createRepo(), name: 'Size test', shortname: 'SIZE' })
    const outside = makeTempDir('project-size-outside-')
    roots.push(outside)
    writeFileSync(resolve(outside, 'keep.txt'), 'not managed bytes')
    for (const target of [outside, resolve(outside, 'missing')]) {
      const ticket = createTicket({ projectId: project.id, title: 'Closed ticket', description: 'Count managed entries only.' })
      patchTicket(ticket.id, { status: 'COMPLETED' })
      const entry = getTicketWorktreeEntryPath(project.folderPath, ticket.externalId)
      // Draft creation makes metadata directories, not a Git worktree.
      rmSync(entry, { recursive: true, force: true })
      symlinkSync(target, entry, 'junction')
    }
    await expect(getProjectWorktreesSize(project.folderPath)).resolves.toBe(0)
    expect(readFileSync(resolve(outside, 'keep.txt'), 'utf8')).toBe('not managed bytes')
  })

  it('preserves ignored terminal-worktree files while allowing LoopTroop runtime data', async () => {
    const project = attachProject({
      folderPath: repositories.createRepo(),
      name: 'Conservative cleanup',
      shortname: 'CON',
    })
    const ticket = createTicket({ projectId: project.id, title: 'Terminal cleanup ticket' })
    patchTicket(ticket.id, { status: 'COMPLETED' })
    const worktreePath = getTicketWorktreeEntryPath(project.folderPath, ticket.externalId)
    rmSync(worktreePath, { recursive: true, force: true })
    execFileSync('git', ['-C', project.folderPath, 'worktree', 'add', '-b', ticket.externalId, worktreePath], { stdio: 'ignore' })
    appendFileSync(resolve(project.folderPath, '.git', 'info', 'exclude'), '*.env\n.ticket/\n')
    writeFileSync(resolve(worktreePath, 'blocked.env'), 'keep me\n')
    mkdirSync(resolve(worktreePath, '.ticket/runtime'), { recursive: true })
    writeFileSync(resolve(worktreePath, '.ticket/runtime/state.json'), '{}\n')

    const skipped = [{
      externalId: ticket.externalId,
      reason: expect.stringContaining('ignored files outside LoopTroop roots'),
    }]
    await expect(deleteProjectWorktrees(project.folderPath)).resolves.toEqual({ freedBytes: 0, skipped })
    expect(readFileSync(resolve(worktreePath, 'blocked.env'), 'utf8')).toBe('keep me\n')

    const eligible = createTicket({ projectId: project.id, title: 'Eligible terminal ticket' })
    patchTicket(eligible.id, { status: 'CANCELED' })
    const eligiblePath = getTicketWorktreeEntryPath(project.folderPath, eligible.externalId)
    const partial = await deleteProjectWorktrees(project.folderPath)
    expect(partial.skipped).toEqual(skipped)
    expect(partial.freedBytes).toBeGreaterThan(0)
    expect(existsSync(eligiblePath)).toBe(false)
    expect(readFileSync(resolve(worktreePath, 'blocked.env'), 'utf8')).toBe('keep me\n')

    rmSync(resolve(worktreePath, 'blocked.env'))
    await expect(deleteProjectWorktrees(project.folderPath)).resolves.toEqual({ freedBytes: expect.any(Number), skipped: [] })
    expect(existsSync(worktreePath)).toBe(false)
  })
})
