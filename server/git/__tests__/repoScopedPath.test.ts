import { describe, expect, it } from 'vitest'
import { normalizeRepoScopedPath, uniqueRepoScopedPaths } from '../repoScopedPath'

describe('normalizeRepoScopedPath', () => {
  it('accepts an ordinary relative path unchanged', () => {
    expect(normalizeRepoScopedPath('src/app.ts')).toBe('src/app.ts')
  })

  it('drops a leading ./ and collapses repeated separators', () => {
    expect(normalizeRepoScopedPath('./src//app.ts')).toBe('src/app.ts')
  })

  it('accepts a Windows-style relative path by converting the separators', () => {
    expect(normalizeRepoScopedPath('src\\components\\App.tsx')).toBe('src/components/App.tsx')
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
  })

  it('rejects control characters that would confuse a pathspec', () => {
    expect(normalizeRepoScopedPath('src/app\u0000.ts')).toBeNull()
    expect(normalizeRepoScopedPath('src/app\n.ts')).toBeNull()
    expect(normalizeRepoScopedPath('src/app\r.ts')).toBeNull()
  })

  it('rejects LoopTroop control directories and nothing merely resembling them', () => {
    expect(normalizeRepoScopedPath('.ticket')).toBeNull()
    expect(normalizeRepoScopedPath('.ticket/prd.yaml')).toBeNull()
    expect(normalizeRepoScopedPath('.looptroop')).toBeNull()
    expect(normalizeRepoScopedPath('.looptroop/state.json')).toBeNull()
    expect(normalizeRepoScopedPath('.ticketing/notes.md')).toBe('.ticketing/notes.md')
    expect(normalizeRepoScopedPath('src/.ticket/keep.ts')).toBe('src/.ticket/keep.ts')
  })

  it('rejects empty and dot-only input', () => {
    expect(normalizeRepoScopedPath('')).toBeNull()
    expect(normalizeRepoScopedPath('   ')).toBeNull()
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
    ])).toEqual(['src/app.ts', 'lib/util.ts'])
  })
})
