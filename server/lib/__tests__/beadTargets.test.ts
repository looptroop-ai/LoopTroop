import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import { getExternalTargetFiles } from '../beadTargets'

describe('resolved bead target warnings', () => {
  let scratch: string
  let root: string
  beforeEach(() => {
    scratch = makeTempDir('looptroop-targets-')
    root = join(scratch, 'repo')
    mkdirSync(root)
    mkdirSync(join(root, 'local'))
    mkdirSync(join(scratch, 'outside'))
    writeFileSync(join(scratch, 'outside', 'existing.txt'), 'outside')
    symlinkSync(join(scratch, 'outside'), join(root, 'linked'), 'junction')
    symlinkSync(join(root, 'local'), join(root, 'internal'), 'junction')
  })
  afterEach(() => removeTempDir(scratch))

  it('warns for existing external symlink targets and new descendants', () => {
    expect(getExternalTargetFiles([
      'linked/existing.txt', 'linked/new/nested.txt', 'local/new.txt', 'internal/new.txt', 'new/file.txt',
    ], root)).toEqual(['linked/existing.txt', 'linked/new/nested.txt'])
  })

  it('keeps explicit external spellings and ignores malformed values', () => {
    expect(getExternalTargetFiles([null, 42, 'bad\npath', '/outside/file', '~other/file', 'file:///tmp/file'], root))
      .toEqual(['/outside/file', '~other/file', 'file:///tmp/file'])
    expect(getExternalTargetFiles(null, root)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('resolves literal POSIX backslashes without turning them into separators', () => {
    symlinkSync(join(scratch, 'outside'), join(root, 'literal\\link'), 'junction')
    symlinkSync(join(scratch, 'outside'), join(root, ' spaced link '), 'junction')
    expect(getExternalTargetFiles(['literal\\link/new.txt', ' spaced link /new.txt'], root))
      .toEqual(['literal\\link/new.txt', ' spaced link /new.txt'])
  })

  it('warns conservatively when the worktree or symlink cannot be resolved', () => {
    symlinkSync(join(scratch, 'absent'), join(root, 'broken'), 'junction')
    expect(getExternalTargetFiles(['local.txt'], join(scratch, 'missing'))).toEqual(['local.txt'])
    expect(getExternalTargetFiles(['broken/file.txt'], root)).toEqual(['broken/file.txt'])
  })
})
