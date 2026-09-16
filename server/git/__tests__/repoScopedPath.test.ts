import { describe, expect, it } from 'vitest'
import { normalizeRepoScopedPath, uniqueRepoScopedPaths } from '../repoScopedPath'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

describe('normalizeRepoScopedPath', () => {
  it('accepts an ordinary relative path unchanged', () => {
    expect(normalizeRepoScopedPath('src/app.ts')).toBe('src/app.ts')
  })

  it('drops a leading ./ and collapses repeated separators', () => {
    expect(normalizeRepoScopedPath('./src//app.ts')).toBe('src/app.ts')
  })

  it('keeps POSIX backslashes opaque and converts them on Windows', () => {
    expect(normalizeRepoScopedPath('src\\components\\App.tsx')).toBe(
      process.platform === 'win32' ? 'src/components/App.tsx' : 'src\\components\\App.tsx',
    )
  })

  it('rejects a path that climbs out at the end, not only at the start', () => {
    // The squash filter tested `includes('/../')`, which accepts this one.
    expect(normalizeRepoScopedPath('foo/bar/..')).toBeNull()
    expect(normalizeRepoScopedPath('../secret')).toBeNull()
    expect(normalizeRepoScopedPath('foo/../bar')).toBeNull()
  })

  it('rejects absolute and drive-qualified paths', () => {
    expect(normalizeRepoScopedPath('/etc/passwd')).toBeNull()
    expect(normalizeRepoScopedPath('C:/Windows/system32')).toBeNull()
    expect(normalizeRepoScopedPath('C:\\Windows\\system32')).toBeNull()
    // Drive-relative, not drive-absolute: `C:notes.txt` resolves against
    // whatever the current directory on drive C happens to be.
    expect(normalizeRepoScopedPath('C:notes.txt')).toBeNull()
    expect(normalizeRepoScopedPath('C:')).toBeNull()
  })

  it('rejects NUL but preserves other legal POSIX filename bytes', () => {
    expect(normalizeRepoScopedPath('src/app\u0000.ts')).toBeNull()
    expect(normalizeRepoScopedPath('src/app\n.ts')).toBe('src/app\n.ts')
    expect(normalizeRepoScopedPath('src/app\r.ts')).toBe('src/app\r.ts')
    expect(normalizeRepoScopedPath('src/with\ttab ')).toBe('src/with\ttab ')
  })

  it('rejects Git and LoopTroop control paths and nothing merely resembling them', () => {
    expect(normalizeRepoScopedPath('.git')).toBeNull()
    expect(normalizeRepoScopedPath('.git/config')).toBeNull()
    expect(normalizeRepoScopedPath('.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml')
    expect(normalizeRepoScopedPath('.ticket')).toBeNull()
    expect(normalizeRepoScopedPath('.ticket/prd.yaml')).toBeNull()
    expect(normalizeRepoScopedPath('.looptroop')).toBeNull()
    expect(normalizeRepoScopedPath('.looptroop/state.json')).toBeNull()
    expect(normalizeRepoScopedPath('.ticketing/notes.md')).toBe('.ticketing/notes.md')
    expect(normalizeRepoScopedPath('src/.ticket/keep.ts')).toBe('src/.ticket/keep.ts')
  })

  it('rejects empty and dot-only input but keeps a space-only filename', () => {
    expect(normalizeRepoScopedPath('')).toBeNull()
    expect(normalizeRepoScopedPath('   ')).toBe('   ')
    expect(normalizeRepoScopedPath('.')).toBeNull()
    expect(normalizeRepoScopedPath('..')).toBeNull()
  })
})

describe('uniqueRepoScopedPaths', () => {
  it('normalises, drops what cannot be normalised, and de-duplicates', () => {
    expect(uniqueRepoScopedPaths([
      './src/app.ts',
      'src/app.ts',
      'src\\app.ts',
      '../escape.ts',
      '.ticket/prd.yaml',
      'lib/util.ts',
    ])).toEqual(process.platform === 'win32'
      ? ['src/app.ts', 'lib/util.ts']
      : ['src/app.ts', 'src\\app.ts', 'lib/util.ts'])
  })

  it.runIf(process.platform !== 'win32')('drops paths that traverse a symlinked ancestor when a repository root is supplied', () => {
    const root = makeTempDir('repo-scoped-path-')
    try {
      mkdirSync(join(root, 'outside'))
      symlinkSync(join(root, 'outside'), join(root, 'link'), 'dir')
      expect(uniqueRepoScopedPaths(['link/file.ts', 'safe/file.ts'], root)).toEqual(['safe/file.ts'])
    } finally {
      removeTempDir(root)
    }
  })
})
