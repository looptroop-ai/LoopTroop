import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeFolderPath } from '../paths'
import { makeTempDir } from '../../test/tempDir'

let scratchDir: string

beforeEach(() => {
  scratchDir = makeTempDir('looptroop-paths-')
})

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true })
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
    expect(normalizeFolderPath('/tmp\\example\\path')).toBe('/tmp/example/path')
  })

  // The macOS case that made CI fail: /var is a symlink to /private/var, so a
  // stored path and `git rev-parse --show-toplevel` disagreed about one repo.
  it('canonicalises symlinks so both forms compare equal', () => {
    const realDir = join(scratchDir, 'real')
    const linkDir = join(scratchDir, 'link')
    mkdirSync(realDir)
    symlinkSync(realDir, linkDir, 'dir')

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
