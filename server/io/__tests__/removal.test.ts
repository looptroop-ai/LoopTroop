import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeOwnerWritableRecursiveAsync } from '../removal'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

describe.runIf(process.platform !== 'win32')('makeOwnerWritableRecursiveAsync', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) removeTempDir(root)
  })

  it('gives the owner write access through a read-only tree, without following links', async () => {
    const root = makeTempDir('looptroop-removal-')
    roots.push(root)
    const tree = join(root, 'cache')
    mkdirSync(join(tree, 'module', 'pkg'), { recursive: true })
    writeFileSync(join(tree, 'module', 'pkg', 'file.go'), 'package pkg\n')
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'keep')
    chmodSync(outside, 0o444)
    symlinkSync(outside, join(tree, 'module', 'link'))
    chmodSync(join(tree, 'module', 'pkg', 'file.go'), 0o444)
    chmodSync(join(tree, 'module', 'pkg'), 0o555)
    chmodSync(join(tree, 'module'), 0o555)

    await makeOwnerWritableRecursiveAsync(tree)

    expect(statSync(join(tree, 'module')).mode & 0o700).toBe(0o700)
    expect(statSync(join(tree, 'module', 'pkg')).mode & 0o700).toBe(0o700)
    expect(statSync(join(tree, 'module', 'pkg', 'file.go')).mode & 0o600).toBe(0o600)
    // The link's target is not part of the tree.
    expect(statSync(outside).mode & 0o777).toBe(0o444)
  })

  it('does nothing for a path that is already gone', async () => {
    const root = makeTempDir('looptroop-removal-gone-')
    roots.push(root)
    await expect(makeOwnerWritableRecursiveAsync(join(root, 'missing'))).resolves.toBeUndefined()
  })
})
