import { afterEach, describe, expect, it, vi } from 'vitest'
import { fstatSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

const race = vi.hoisted(() => {
  return { beforeOpen: undefined as (() => void) | undefined, afterMkdir: undefined as (() => void) | undefined, fd: -1, reads: 0 }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    // Exercise the Windows fallback even when this test runs on POSIX.
    constants: { ...actual.constants, O_NOFOLLOW: 0 },
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      const result = actual.mkdirSync(...args)
      race.afterMkdir?.()
      race.afterMkdir = undefined
      return result
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      race.beforeOpen?.()
      race.beforeOpen = undefined
      race.fd = actual.openSync(...args)
      return race.fd
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      race.reads += 1
      return actual.readFileSync(...args)
    },
  }
})

import { readFileNoFollowSync } from '../readFile'
import { safeAtomicAppendWithin } from '../atomicAppend'

const roots: string[] = []
afterEach(() => {
  race.beforeOpen = undefined
  race.afterMkdir = undefined
  race.reads = 0
  for (const root of roots.splice(0)) removeTempDir(root)
})

describe('no-follow fallback without O_NOFOLLOW', () => {
  it('rechecks append parents after directory creation before opening a file', () => {
    const fixture = makeTempDir('append-mkdir-race-')
    roots.push(fixture)
    const root = join(fixture, 'root')
    const outside = join(fixture, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    race.afterMkdir = () => {
      renameSync(join(root, 'nested'), join(root, 'moved'))
      symlinkSync(outside, join(root, 'nested'), 'junction')
    }
    expect(() => safeAtomicAppendWithin(root, 'nested/events.jsonl', 'unsafe')).toThrow()
    expect(readdirSync(outside)).toEqual([])
  })

  it('checks identity before reading and closes a replaced file descriptor', () => {
    const root = makeTempDir('read-file-race-')
    roots.push(root)
    const file = join(root, 'file')
    writeFileSync(file, 'original')
    race.beforeOpen = () => {
      renameSync(file, join(root, 'moved'))
      writeFileSync(file, 'replacement must not be consumed')
    }
    expect(() => readFileNoFollowSync(file)).toThrow('File changed')
    expect(race.reads).toBe(0)
    expect(() => fstatSync(race.fd)).toThrow(expect.objectContaining({ code: 'EBADF' }))
  })
})
