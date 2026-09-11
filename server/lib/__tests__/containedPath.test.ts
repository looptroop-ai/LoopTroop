import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, parse, resolve, sep } from 'node:path'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import { ContainedPathError, escapesRoot, resolveContainedPath } from '../containedPath'

describe('resolveContainedPath', () => {
  let scratch: string
  let root: string

  beforeEach(() => {
    scratch = makeTempDir('looptroop-contained-')
    root = join(scratch, 'root')
    mkdirSync(root)
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'dir', 'file.txt'), 'inside')
  })

  afterEach(() => removeTempDir(scratch))

  it('accepts relative and absolute descendants and the root itself', () => {
    const expected = realpathSync.native(join(root, 'dir', 'file.txt'))
    expect(resolveContainedPath(root, 'dir/file.txt')).toBe(expected)
    expect(resolveContainedPath(root, join(root, 'dir', 'file.txt'))).toBe(expected)
    expect(resolveContainedPath(root, '.')).toBe(realpathSync.native(root))
    expect(resolveContainedPath(root, 'dir/../dir/file.txt')).toBe(expected)
  })

  it('rejects traversal, absolute escapes, and sibling prefix collisions', () => {
    for (const candidate of ['../outside', join(scratch, 'outside'), `${root}-other/file`]) {
      expect(() => resolveContainedPath(root, candidate, { allowMissingParents: true })).toThrow(ContainedPathError)
    }
  })

  it('rejects NUL bytes before touching the filesystem', () => {
    expect(() => resolveContainedPath(root, 'file\0.txt')).toThrow(ContainedPathError)
    expect(() => resolveContainedPath(`${root}\0`, 'file')).toThrow(ContainedPathError)
  })

  it('preserves ENOENT unless the missing leaf is explicitly allowed', () => {
    expect(() => resolveContainedPath(root, 'dir/missing')).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    expect(resolveContainedPath(root, 'dir/missing', { allowMissing: true })).toBe(join(realpathSync.native(root), 'dir', 'missing'))
    expect(() => resolveContainedPath(root, 'missing/file', { allowMissing: true })).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    expect(resolveContainedPath(root, 'missing/nested/file', { allowMissingParents: true })).toBe(join(realpathSync.native(root), 'missing', 'nested', 'file'))
  })

  it('requires the root to exist even when missing parents are allowed', () => {
    expect(() => resolveContainedPath(join(root, 'missing'), 'file', { allowMissingParents: true })).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('does not mistake a non-directory parent for a missing directory', () => {
    expect(() => resolveContainedPath(root, 'dir/file.txt/child', { allowMissingParents: true })).toThrow(expect.objectContaining({ code: 'ENOTDIR' }))
  })

  it('resolves contained directory symlinks and Windows junctions to their canonical destination', () => {
    symlinkSync(join(root, 'dir'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(resolveContainedPath(root, 'link')).toBe(realpathSync.native(join(root, 'dir')))
    expect(resolveContainedPath(root, 'link/file.txt')).toBe(realpathSync.native(join(root, 'dir', 'file.txt')))
    expect(resolveContainedPath(root, 'link/missing/file', { allowMissingParents: true })).toBe(join(realpathSync.native(root), 'dir', 'missing', 'file'))
    expect(() => resolveContainedPath(root, 'link/missing/file', { allowMissing: true })).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('rejects outside directory symlinks and junctions even for missing descendants', () => {
    symlinkSync(scratch, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const path of ['link', 'link/root/dir/file.txt', 'link/missing/file']) {
      expect(() => resolveContainedPath(root, path, { allowMissingParents: true })).toThrow(ContainedPathError)
    }
    // The lexical helper is deliberately advisory: it cannot detect links.
    expect(escapesRoot(root, 'link/file.txt')).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('resolves contained leaf links and rejects outside, dangling and cyclic links', () => {
    symlinkSync(join(root, 'dir', 'file.txt'), join(root, 'leaf'))
    expect(resolveContainedPath(root, 'leaf')).toBe(realpathSync.native(join(root, 'dir', 'file.txt')))
    writeFileSync(join(scratch, 'outside'), 'outside')
    for (const [name, target] of [['outside', join(scratch, 'outside')], ['dangling', join(root, 'absent')], ['cyclic', join(root, 'cyclic')]] as const) {
      symlinkSync(target, join(root, name))
      expect(() => resolveContainedPath(root, name, { allowMissing: true })).toThrow(ContainedPathError)
    }
  })

  it('accepts symlinks at and above the root, returning the canonical path', () => {
    const alias = join(scratch, 'alias')
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const expected = realpathSync.native(join(root, 'dir', 'file.txt'))
    expect(resolveContainedPath(alias, 'dir/file.txt')).toBe(expected)
    expect(resolveContainedPath(alias, join(alias, 'dir', 'file.txt'))).toBe(expected)
    expect(resolveContainedPath(alias, expected)).toBe(expected)
    expect(resolveContainedPath(join(alias, 'dir'), 'file.txt')).toBe(expected)
  })

  it('rejects cross-volume, UNC and device paths outside the root', () => {
    const drive = parse(root).root.toLowerCase().startsWith('z:') ? 'Y:' : 'Z:'
    for (const candidate of [`${drive}\\outside`, `${drive}outside`, '\\\\server\\share\\file', '\\\\?\\Z:\\outside']) {
      expect(() => resolveContainedPath(root, candidate, { allowMissingParents: true })).toThrow(ContainedPathError)
      expect(escapesRoot(root, candidate)).toBe(true)
    }
  })

  it.skipIf(process.platform === 'win32')('preserves backslashes in POSIX filenames', () => {
    writeFileSync(join(root, 'dir\\file.txt'), 'literal separator')
    expect(resolveContainedPath(root, 'dir\\file.txt')).toBe(join(realpathSync.native(root), 'dir\\file.txt'))
    expect(() => resolveContainedPath(root, '..\\outside')).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it.skipIf(process.platform !== 'win32')('accepts Windows separators and drive-letter case differences', () => {
    const absolute = resolve(root, 'dir', 'file.txt')
    const drive = absolute.charAt(0)
    const alternateCase = drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()
    expect(resolveContainedPath(root, 'dir\\file.txt').toLowerCase()).toBe(absolute.toLowerCase())
    expect(resolveContainedPath(root, alternateCase + absolute.slice(1)).toLowerCase()).toBe(absolute.toLowerCase())
    expect(() => resolveContainedPath(root, '..\\outside')).toThrow(ContainedPathError)
  })

  it('checks lexical boundaries without requiring filesystem entries', () => {
    expect(escapesRoot(root, 'missing/file')).toBe(false)
    expect(escapesRoot(root, root)).toBe(false)
    expect(escapesRoot(root, '..')).toBe(true)
    expect(escapesRoot(root, `${root}-other${sep}file`)).toBe(true)
    expect(escapesRoot(root, 'bad\0file')).toBe(true)
  })
})
