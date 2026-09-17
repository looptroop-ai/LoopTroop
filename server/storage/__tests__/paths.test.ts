import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getTicketDir, getTicketExecutionLogPath, getTicketWorktreePath, normalizeFolderPath, resolveGitRepoRoot } from '../paths'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

let scratchDir: string

beforeEach(() => {
  scratchDir = makeTempDir('looptroop-paths-')
})

afterEach(() => {
  removeTempDir(scratchDir)
})

describe('normalizeFolderPath', () => {
  it('strips trailing separators', () => {
    const target = join(scratchDir, 'project')
    mkdirSync(target)
    expect(normalizeFolderPath(`${target}/`)).toBe(normalizeFolderPath(target))
    expect(normalizeFolderPath(`${target}///`)).toBe(normalizeFolderPath(target))
  })

  it('preserves legal surrounding whitespace at the filesystem boundary', () => {
    // Trailing spaces are legal POSIX filename bytes but are stripped by the
    // Windows filesystem. Keep the boundary assertion portable while still
    // exercising whitespace in the native path on both platforms.
    const target = join(scratchDir, process.platform === 'win32' ? 'project name' : 'project ')
    mkdirSync(target)
    const expected = process.platform === 'win32' ? target.replace(/\\/g, '/') : target
    expect(normalizeFolderPath(target)).toBe(expected)
    expect(() => normalizeFolderPath(`  ${target}`)).toThrow('absolute')
  })

  it('rejects relative and empty paths', () => {
    expect(() => normalizeFolderPath('relative/path')).toThrow('absolute')
    expect(() => normalizeFolderPath('')).toThrow('absolute')
  })

  it.runIf(process.platform !== 'win32')('preserves POSIX backslashes as legal filename characters', () => {
    expect(normalizeFolderPath('/tmp\\example\\path')).toBe('/tmp\\example\\path')
  })

  it.runIf(process.platform !== 'win32')('preserves a literal trailing POSIX backslash', () => {
    const target = join(scratchDir, 'project')
    expect(normalizeFolderPath(`${target}\\`)).toBe(`${target}\\`)
  })

  it.runIf(process.platform !== 'win32')('preserves a POSIX repository root ending in carriage return', () => {
    const target = join(scratchDir, 'project\r')
    mkdirSync(target)
    execFileSync('git', ['init', '--initial-branch=main', target], { stdio: 'ignore' })
    expect(resolveGitRepoRoot(target)).toBe(normalizeFolderPath(target))
  })

  it.runIf(process.platform === 'win32')('normalizes native Windows backslashes to separators', () => {
    expect(normalizeFolderPath('C:\\tmp\\example\\path')).toBe('C:/tmp/example/path')
  })

  it.runIf(process.platform !== 'win32')('preserves the POSIX filesystem root', () => {
    expect(normalizeFolderPath('/')).toBe('/')
  })

  // The macOS case that made CI fail: /var is a symlink to /private/var, so a
  // stored path and `git rev-parse --show-toplevel` disagreed about one repo.
  it('canonicalises symlinks so both forms compare equal', () => {
    const realDir = join(scratchDir, 'real')
    const linkDir = join(scratchDir, 'link')
    mkdirSync(realDir)
    symlinkSync(realDir, linkDir, 'junction')

    expect(normalizeFolderPath(linkDir)).toBe(normalizeFolderPath(realDir))
  })

  it('is idempotent', () => {
    const target = join(scratchDir, 'project')
    mkdirSync(target)
    const once = normalizeFolderPath(target)
    expect(normalizeFolderPath(once)).toBe(once)
  })

  it('returns the lexical form for paths that do not exist yet', () => {
    const missing = join(scratchDir, 'not-created')
    expect(normalizeFolderPath(missing)).toBe(missing.replace(/\\/g, '/'))
  })

  describe.runIf(process.platform !== 'win32')('WSL drive-letter mapping', () => {
    it('only maps an existing WSL mount and rejects it elsewhere', () => {
      if (existsSync('/mnt/d')) {
        expect(normalizeFolderPath('D:/code/project')).toBe('/mnt/d/code/project')
      } else {
        expect(() => normalizeFolderPath('D:/code/project')).toThrow('absolute')
      }
    })
  })

  describe.runIf(process.platform === 'win32')('native Windows paths', () => {
    it('preserves drive letters instead of rewriting them to /mnt', () => {
      const normalized = normalizeFolderPath('C:\\Users\\dev')
      expect(normalized).toMatch(/^C:\/Users\/dev$/i)
      expect(normalized).not.toContain('/mnt/')
    })

    it('preserves a Windows drive root while removing only redundant separators', () => {
      expect(normalizeFolderPath('C:\\')).toMatch(/^C:\/$/i)
    })
  })
})

describe('getTicketWorktreePath', () => {
  it('checks ticket roots and runtime descendants independently against the project', () => {
    const worktree = join(scratchDir, '.looptroop', 'worktrees', 'LT-1')
    const outside = join(scratchDir, 'outside-ticket')
    mkdirSync(worktree, { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, join(worktree, '.ticket'), 'junction')
    expect(() => getTicketDir(scratchDir, 'LT-1')).toThrow('Ticket directory must stay within its worktree')

    const secondTicket = join(scratchDir, '.looptroop', 'worktrees', 'LT-2', '.ticket')
    mkdirSync(secondTicket, { recursive: true })
    symlinkSync(outside, join(secondTicket, 'runtime'), 'junction')
    expect(() => getTicketExecutionLogPath(scratchDir, 'LT-2')).toThrow('File path must stay within the ticket directory')
  })

  it('allows a new ticket beneath its existing project', () => {
    expect(getTicketWorktreePath(scratchDir, 'LT-1')).toBe(join(scratchDir, '.looptroop', 'worktrees', 'LT-1'))
    expect(() => getTicketWorktreePath(join(scratchDir, 'missing-project'), 'LT-1')).toThrow()
  })

  it('rejects identifiers that can select a different directory', () => {
    for (const externalId of ['', '.', '..', '../other', 'nested/ticket', 'nested\\ticket', 'C:ticket', 'bad\0id']) {
      expect(() => getTicketWorktreePath(scratchDir, externalId)).toThrow('Invalid ticket path')
    }
  })

  it('rejects a replaced worktrees parent before a ticket directory exists', () => {
    const project = join(scratchDir, 'project')
    const outside = join(scratchDir, 'outside')
    mkdirSync(join(project, '.looptroop'), { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, join(project, '.looptroop', 'worktrees'), 'junction')
    expect(() => getTicketWorktreePath(project, 'LT-1')).toThrow('escapes root')
  })

  it('accepts worktree links only when they stay inside the project', () => {
    const project = join(scratchDir, 'project')
    const worktrees = join(project, '.looptroop', 'worktrees')
    const actual = join(project, 'actual-worktree')
    const outside = join(scratchDir, 'outside')
    mkdirSync(worktrees, { recursive: true })
    mkdirSync(actual)
    mkdirSync(outside)
    symlinkSync(actual, join(worktrees, 'LT-1'), 'junction')
    symlinkSync(outside, join(worktrees, 'LT-2'), 'junction')
    expect(getTicketWorktreePath(project, 'LT-1')).toBe(join(worktrees, 'LT-1'))
    expect(() => getTicketWorktreePath(project, 'LT-2')).toThrow('escapes root')
  })
})
