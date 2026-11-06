import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { chmod, lstat, readdir } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { resolve } from 'node:path'

/** Remove one already-resolved file entry; callers must perform containment checks first. */
export function removeFile(targetPath: string): void {
  rmSync(targetPath, { force: true })
}

/**
 * Restores the owner permissions required to traverse and remove a tree.
 * Symlinks are deliberately left untouched so their targets are never changed.
 */
export function makeOwnerWritableRecursive(targetPath: string): void {
  let stats: Stats
  try {
    stats = lstatSync(targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  if (stats.isSymbolicLink()) return

  if (stats.isDirectory()) {
    chmodSync(targetPath, stats.mode | 0o700)
    for (const entry of readdirSync(targetPath)) {
      makeOwnerWritableRecursive(resolve(targetPath, entry))
    }
    return
  }

  chmodSync(targetPath, stats.mode | 0o600)
}

/**
 * `makeOwnerWritableRecursive` without blocking the event loop, for trees large
 * enough (package caches) that a synchronous walk would stall the server.
 */
export async function makeOwnerWritableRecursiveAsync(targetPath: string): Promise<void> {
  let stats: Stats
  try {
    stats = await lstat(targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  if (stats.isSymbolicLink()) return

  if (stats.isDirectory()) {
    await chmod(targetPath, stats.mode | 0o700)
    for (const entry of await readdir(targetPath)) {
      await makeOwnerWritableRecursiveAsync(resolve(targetPath, entry))
    }
    return
  }

  await chmod(targetPath, stats.mode | 0o600)
}
