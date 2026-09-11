import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { makeTempDir, pinGitLineEndings, removeTempDir } from '../../test/tempDir'
import { afterEach, describe, expect, it } from 'vitest'
import { removeWorktree } from '../worktreeRemoval'
import { getTicketWorktreePath } from '../../storage/paths'

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function createRepoWithWorktree() {
  const root = makeTempDir('looptroop-worktree-removal-')
  roots.push(root)
  const projectRoot = resolve(root, 'project')
  const worktreesRoot = resolve(projectRoot, '.looptroop', 'worktrees')
  const worktreePath = resolve(worktreesRoot, 'TEST-1')

  mkdirSync(projectRoot, { recursive: true })
  git(projectRoot, ['init', '--initial-branch=main'])
  pinGitLineEndings(projectRoot)
  git(projectRoot, ['config', 'user.email', 'test@example.com'])
  git(projectRoot, ['config', 'user.name', 'LoopTroop Test'])
  writeFileSync(resolve(projectRoot, 'README.md'), 'fixture\n')
  git(projectRoot, ['add', 'README.md'])
  git(projectRoot, ['commit', '-m', 'Initial commit'])
  mkdirSync(worktreesRoot, { recursive: true })
  git(projectRoot, ['worktree', 'add', '-b', 'TEST-1', worktreePath])

  return { root, projectRoot, worktreesRoot, worktreePath }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    removeTempDir(root)
  }
})

describe('removeWorktree', () => {
  it('accepts a project reached through a symlinked ancestor', () => {
    const { root, projectRoot, worktreePath } = createRepoWithWorktree()
    const alias = resolve(root, 'project-alias')
    symlinkSync(projectRoot, alias, 'junction')
    const worktreesRoot = resolve(alias, '.looptroop/worktrees')
    removeWorktree({ projectRoot: alias, worktreesRoot, worktreePath: resolve(worktreesRoot, 'TEST-1') })
    expect(existsSync(worktreePath)).toBe(false)
  })
  it('unlinks an alias to a registered worktree without asking Git to remove its destination', () => {
    const { projectRoot, worktreesRoot, worktreePath } = createRepoWithWorktree()
    const alias = resolve(worktreesRoot, 'TEST-2')
    symlinkSync(worktreePath, alias, 'junction')
    removeWorktree({ projectRoot, worktreesRoot, worktreePath: alias })
    expect(existsSync(alias)).toBe(false)
    expect(readFileSync(resolve(worktreePath, 'README.md'), 'utf8')).toBe('fixture\n')
    expect(git(projectRoot, ['worktree', 'list', '--porcelain'])).toContain(worktreePath)
  })

  it('unlinks dangling worktree aliases', () => {
    const { projectRoot, worktreesRoot } = createRepoWithWorktree()
    const alias = resolve(worktreesRoot, 'TEST-2')
    symlinkSync(resolve(projectRoot, 'missing'), alias, 'junction')
    removeWorktree({ projectRoot, worktreesRoot, worktreePath: alias })
    expect(() => lstatSync(alias)).toThrow()
  })

  it.each(['worktrees', '.looptroop'])('rejects an internal alias at %s before deleting source files', (component) => {
    const root = makeTempDir('looptroop-worktree-root-alias-')
    roots.push(root)
    const source = resolve(root, 'source')
    const worktreesRoot = resolve(root, '.looptroop', 'worktrees')
    const destination = component === 'worktrees' ? source : resolve(source, 'worktrees')
    mkdirSync(resolve(destination, 'TEST-1'), { recursive: true })
    if (component === 'worktrees') mkdirSync(resolve(root, '.looptroop'))
    symlinkSync(source, component === 'worktrees' ? worktreesRoot : resolve(root, '.looptroop'), 'junction')
    expect(() => removeWorktree({ projectRoot: root, worktreesRoot, worktreePath: resolve(worktreesRoot, 'TEST-1') })).toThrow('must not be a symbolic link')
    expect(existsSync(resolve(destination, 'TEST-1'))).toBe(true)
  })
  it.runIf(process.platform !== 'win32')('removes read-only cache trees without following symlinks', () => {
    const { root, projectRoot, worktreesRoot, worktreePath } = createRepoWithWorktree()
    const externalTarget = resolve(root, 'external-target.txt')
    const moduleRoot = resolve(
      worktreePath,
      '.ticket/runtime/execution-setup/tool-cache/gomodcache/gopkg.in/yaml.v3@v3.0.1',
    )
    const readOnlyDir = resolve(moduleRoot, '.github')
    const readOnlyFile = resolve(readOnlyDir, 'dependabot.yml')
    const externalLink = resolve(readOnlyDir, 'external-link')

    mkdirSync(readOnlyDir, { recursive: true })
    writeFileSync(readOnlyFile, 'version: 2\n')
    writeFileSync(externalTarget, 'preserve me\n')
    chmodSync(externalTarget, 0o444)
    symlinkSync(externalTarget, externalLink)
    chmodSync(readOnlyFile, 0o444)
    chmodSync(readOnlyDir, 0o555)
    chmodSync(moduleRoot, 0o555)

    removeWorktree({ projectRoot, worktreesRoot, worktreePath })

    expect(existsSync(worktreePath)).toBe(false)
    expect(readFileSync(externalTarget, 'utf8')).toBe('preserve me\n')
    expect(git(projectRoot, ['worktree', 'list', '--porcelain'])).not.toContain(worktreePath)
  })

  it('falls back to filesystem removal and prunes after Git removal fails', () => {
    const { projectRoot, worktreesRoot, worktreePath } = createRepoWithWorktree()
    const commands: string[][] = []

    removeWorktree({
      projectRoot,
      worktreesRoot,
      worktreePath,
      runGit: (args) => {
        commands.push(args)
        if (args[1] === 'remove') throw new Error('simulated Git failure')
      },
    })

    expect(existsSync(worktreePath)).toBe(false)
    expect(commands).toEqual([
      ['worktree', 'remove', '--force', worktreePath],
      ['worktree', 'prune'],
    ])
  })

  it('rejects targets outside the managed worktrees root', () => {
    const root = makeTempDir('looptroop-worktree-containment-')
    roots.push(root)
    const projectRoot = resolve(root, 'project')
    const worktreesRoot = resolve(projectRoot, '.looptroop', 'worktrees')
    const outsidePath = resolve(projectRoot, 'source')
    mkdirSync(outsidePath, { recursive: true })

    expect(() => removeWorktree({
      projectRoot,
      worktreesRoot,
      worktreePath: outsidePath,
    })).toThrow('outside the managed worktrees root')
    expect(existsSync(outsidePath)).toBe(true)
  })

  it('rejects an external destination behind a replaced worktrees parent', () => {
    const root = makeTempDir('looptroop-worktree-link-')
    roots.push(root)
    const projectRoot = resolve(root, 'project')
    const worktreesRoot = resolve(projectRoot, '.looptroop', 'worktrees')
    const outside = resolve(root, 'outside')
    mkdirSync(resolve(projectRoot, '.looptroop'), { recursive: true })
    mkdirSync(resolve(outside, 'TEST-1'), { recursive: true })
    writeFileSync(resolve(outside, 'TEST-1', 'keep.txt'), 'preserve me')
    symlinkSync(outside, worktreesRoot, 'junction')
    const commands: string[][] = []

    expect(() => removeWorktree({
      projectRoot,
      worktreesRoot,
      worktreePath: resolve(worktreesRoot, 'TEST-1'),
      runGit: (args) => { commands.push(args) },
    })).toThrow('escapes root')
    expect(commands).toEqual([])
    expect(readFileSync(resolve(outside, 'TEST-1', 'keep.txt'), 'utf8')).toBe('preserve me')
  })

  it('removes a contained worktree alias without deleting its destination', () => {
    const root = makeTempDir('looptroop-worktree-alias-')
    roots.push(root)
    const worktreesRoot = resolve(root, '.looptroop', 'worktrees')
    const destination = resolve(worktreesRoot, 'TEST-2')
    mkdirSync(destination, { recursive: true })
    writeFileSync(resolve(destination, 'keep.txt'), 'preserve me')
    symlinkSync(destination, resolve(worktreesRoot, 'TEST-1'), 'junction')

    removeWorktree({
      projectRoot: root,
      worktreesRoot,
      worktreePath: getTicketWorktreePath(root, 'TEST-1'),
      runGit: () => { throw new Error('Not a registered worktree') },
    })

    expect(existsSync(resolve(worktreesRoot, 'TEST-1'))).toBe(false)
    expect(readFileSync(resolve(destination, 'keep.txt'), 'utf8')).toBe('preserve me')
  })
})
