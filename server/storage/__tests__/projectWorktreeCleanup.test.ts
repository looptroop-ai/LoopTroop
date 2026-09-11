import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deleteAllProjectWorktrees } from '../projects'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) removeTempDir(root) })

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
})
