import { mkdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getTicketDir, getTicketExecutionLogPath, getTicketWorktreePath, normalizeFolderPath } from '../paths'
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

  it('trims surrounding whitespace', () => {
    const target = join(scratchDir, 'project')
    mkdirSync(target)
    expect(normalizeFolderPath(`  ${target}  `)).toBe(normalizeFolderPath(target))
  })

  it('resolves relative paths against the working directory', () => {
    expect(normalizeFolderPath('relative/path')).toBe(
      normalizeFolderPath(resolve(process.cwd(), 'relative/path')),
    )
  })

  it('converts backslashes to forward slashes', () => {
    // Drive-relative on Windows, absolute on POSIX; either way the contract is
    // that the output contains no backslashes.
    expect(normalizeFolderPath('/tmp\\example\\path')).not.toContain('\\')
    expect(normalizeFolderPath('/tmp\\example\\path')).toContain('/tmp/example/path')
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
    it('maps drive letters to /mnt on non-Windows platforms', () => {
      expect(normalizeFolderPath('D:/code/project')).toBe('/mnt/d/code/project')
      expect(normalizeFolderPath('C:\\Users\\dev')).toBe('/mnt/c/Users/dev')
    })
  })

  describe.runIf(process.platform === 'win32')('native Windows paths', () => {
    it('preserves drive letters instead of rewriting them to /mnt', () => {
      const normalized = normalizeFolderPath('C:\\Users\\dev')
      expect(normalized).toMatch(/^C:\/Users\/dev$/i)
      expect(normalized).not.toContain('/mnt/')
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
