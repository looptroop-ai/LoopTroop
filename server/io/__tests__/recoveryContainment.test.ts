import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecoveryBlockedError, fixTrailingLineCorruption, recoverOrphanTmpFiles } from '../recovery'
import { makeAtomicTmpPath } from '../atomicWrite'
import * as fileReader from '../readFile'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }))

let directory: string

beforeEach(() => {
  directory = makeTempDir('looptroop-recovery-containment-')
  mkdirSync(join(directory, 'runtime'), { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  removeTempDir(directory)
})

describe('recovery descriptor containment', () => {
  it.each([
    ['file', false], ['alias', false], ['file', true], ['alias', true],
  ] as const)('rejects a replaced %s before linking and pins unsupported-link copies (copy fallback: %s)', (replacementKind, copyFallback) => {
    const target = join(directory, 'runtime', 'execution-setup-profile.json')
    const tmp = makeAtomicTmpPath(target)
    const original = '{"validated":true}'
    writeFileSync(tmp, original, { mode: 0o600 })
    const outside = join(directory, 'outside')
    mkdirSync(outside)
    const open = fileReader.openFileNoFollowSync
    const replaceSource = () => {
      renameSync(tmp, join(directory, 'held-original'))
      if (replacementKind === 'file') writeFileSync(tmp, '{"notValidated":true}')
      else symlinkSync(outside, tmp, 'junction')
    }
    const linker = vi.spyOn(fs, 'linkSync')
    if (copyFallback) {
      linker.mockImplementation(() => {
        replaceSource()
        throw Object.assign(new Error('unsupported'), { code: 'ENOSYS' })
      })
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fileReader, 'openFileNoFollowSync').mockImplementation((path, flags) => {
      const fd = open(path, flags)
      if (path === tmp && !copyFallback) replaceSource()
      return fd
    })
    expect(recoverOrphanTmpFiles(directory)).toEqual(copyFallback ? [target] : [])
    if (copyFallback) {
      expect(readFileSync(target, 'utf8')).toBe(original)
      if (process.platform !== 'win32') expect(lstatSync(target).mode & 0o777).toBe(0o600)
    } else {
      expect(existsSync(target)).toBe(false)
      expect(linker).not.toHaveBeenCalled()
    }
    if (replacementKind === 'file') expect(readFileSync(tmp, 'utf8')).toBe('{"notValidated":true}')
    else expect(lstatSync(tmp).isSymbolicLink()).toBe(true)
  })

  it('preserves a legitimate target installed after the recovery hardlink was created', () => {
    const target = join(directory, 'runtime', 'execution-setup-profile.json')
    const tmp = makeAtomicTmpPath(target)
    const heldTarget = join(directory, 'held-recovery-target')
    writeFileSync(tmp, '{"validated":true}')
    const link = fs.linkSync
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      link(source, destination)
      renameSync(target, heldTarget)
      writeFileSync(target, '{"newerWriter":true}')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(recoverOrphanTmpFiles(directory)).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe('{"newerWriter":true}')
    expect(readFileSync(tmp, 'utf8')).toBe('{"validated":true}')
    expect(readFileSync(heldTarget, 'utf8')).toBe('{"validated":true}')
  })

  it('preserves a replacement that arrives while removing the published temp', () => {
    const target = join(directory, 'runtime', 'execution-setup-profile.json')
    const tmp = makeAtomicTmpPath(target)
    const heldTemp = join(directory, 'held-temp')
    const replacement = join(directory, 'replacement-temp')
    writeFileSync(tmp, '{"validated":true}')
    writeFileSync(replacement, '{"newerWriter":true}')
    let injected = false
    const deps = {
      link: fs.linkSync,
      rename: (from: string, to: string) => {
        if (!injected && from === tmp) {
          injected = true
          renameSync(tmp, heldTemp)
          renameSync(replacement, tmp)
        }
        renameSync(from, to)
      },
    }

    expect(recoverOrphanTmpFiles(directory, 'ticket', deps)).toEqual([target])
    expect(injected).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('{"validated":true}')
    expect(readFileSync(tmp, 'utf8')).toBe('{"newerWriter":true}')
    expect(readFileSync(heldTemp, 'utf8')).toBe('{"validated":true}')
  })

  it('retains a moved generation when a replacement wins restoration', () => {
    const target = join(directory, 'runtime', 'owner.json')
    const tmp = makeAtomicTmpPath(target)
    writeFileSync(tmp, '{"owner":"original"}')
    writeFileSync(target, '{"owner":"existing"}')
    let injected = false
    const deps = {
      link: fs.linkSync,
      rename: (from: string, to: string) => {
        renameSync(from, to)
        if (!injected && from === tmp) {
          injected = true
          // The moved inode is a complete replacement generation, while C
          // wins the temp's canonical name before recovery can restore B.
          writeFileSync(to, '{"owner":"moved"}')
          writeFileSync(from, '{"owner":"canonical"}')
        }
      },
    }

    expect(recoverOrphanTmpFiles(directory, 'ticket', deps)).toEqual([])
    expect(injected).toBe(true)
    expect(readFileSync(tmp, 'utf8')).toBe('{"owner":"canonical"}')
    const moved = readdirSync(join(directory, 'runtime'))
      .filter((name) => name.startsWith('owner.json.') && name.includes('.remove-'))
    expect(moved).toHaveLength(1)
    expect(readFileSync(join(directory, 'runtime', moved[0]!), 'utf8')).toBe('{"owner":"moved"}')
  })

  it('rejects a replaced published target even if the later path stats reuse dev and ino', () => {
    const target = join(directory, 'runtime', 'execution-setup-profile.json')
    const tmp = makeAtomicTmpPath(target)
    const heldTarget = join(directory, 'held-recovery-target')
    writeFileSync(tmp, '{"validated":true}')
    const link = fs.linkSync
    const lstat = fs.lstatSync
    let replacementInstalled = false

    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      link(source, destination)
      renameSync(target, heldTarget)
      writeFileSync(target, '{"newerWriter":true}')
      replacementInstalled = true
    })
    vi.spyOn(fs, 'lstatSync').mockImplementation((path) => {
      const stats = lstat(path)
      if (replacementInstalled && path === target) {
        const sourceStats = lstat(tmp)
        return Object.assign(
          Object.create(Object.getPrototypeOf(stats)),
          stats,
          { dev: sourceStats.dev, ino: sourceStats.ino },
        )
      }
      return stats
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(recoverOrphanTmpFiles(directory)).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe('{"newerWriter":true}')
    expect(readFileSync(tmp, 'utf8')).toBe('{"validated":true}')
    expect(readFileSync(heldTarget, 'utf8')).toBe('{"validated":true}')
  })

  it('keeps a target created after inspection and preserves the temp for a later attempt', () => {
    const target = join(directory, 'runtime', 'execution-setup-profile.json')
    const tmp = makeAtomicTmpPath(target)
    writeFileSync(tmp, '{"validated":true}')
    const open = fileReader.openFileNoFollowSync
    vi.spyOn(fileReader, 'openFileNoFollowSync').mockImplementation((path, flags) => {
      const fd = open(path, flags)
      if (path === tmp) writeFileSync(target, 'already occupied')
      return fd
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(recoverOrphanTmpFiles(directory)).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe('already occupied')
    expect(readFileSync(tmp, 'utf8')).toBe('{"validated":true}')
  })

  it.each([false, true])('keeps the temp after a failed copy and only cleans its own target (replaced: %s)', (replaceTarget) => {
    const target = join(directory, 'runtime', 'execution-setup-profile.json')
    const tmp = makeAtomicTmpPath(target)
    writeFileSync(tmp, JSON.stringify('validated content'))
    const replacement = join(directory, 'replacement-target')
    writeFileSync(replacement, 'replacement target')
    vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('unsupported'), { code: 'ENOSYS' }) })
    const originalWrite = fs.writeSync as (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position?: number,
    ) => number
    let writes = 0
    vi.spyOn(fs, 'writeSync').mockImplementation(( (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position?: number,
    ) => {
      if (writes++ < 2) return originalWrite(fd, buffer, offset, length, position)
      if (replaceTarget && existsSync(target)) {
          renameSync(target, join(directory, 'held-target'))
          renameSync(replacement, target)
      }
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    }) as typeof fs.writeSync)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => recoverOrphanTmpFiles(directory, 'ticket', {
      link: () => { throw Object.assign(new Error('unsupported'), { code: 'ENOSYS' }) },
      rename: renameSync,
    })).toThrow(RecoveryBlockedError)
    expect(readFileSync(tmp, 'utf8')).toBe(JSON.stringify('validated content'))
    if (replaceTarget) expect(readFileSync(target, 'utf8')).toBe('replacement target')
    else expect(existsSync(target)).toBe(true)
  })

  it('resumes a marked fallback copy after an interrupted write and proves exact bytes', () => {
    const target = join(directory, 'runtime', 'execution-setup-profile.json')
    const content = JSON.stringify({ payload: 'café'.repeat(20_000) })
    const tmp = makeAtomicTmpPath(target)
    writeFileSync(tmp, content)
    writeFileSync(target, content.slice(0, Math.floor(content.length / 3)))
    const identity = (stats: NonNullable<ReturnType<typeof lstatSync>>) => ({
      dev: Number(stats.dev),
      ino: Number(stats.ino),
      size: Number(stats.size),
      mtimeMs: Number(stats.mtimeMs),
      birthtimeMs: Number(stats.birthtimeMs),
    })
    writeFileSync(`${tmp}.recovery`, JSON.stringify({
      version: 1,
      targetPath: target,
      source: identity(lstatSync(tmp)),
      target: identity(lstatSync(target)),
    }))

    expect(recoverOrphanTmpFiles(directory)).toEqual([target])
    expect(readFileSync(target, 'utf8')).toBe(content)
    expect(existsSync(tmp)).toBe(false)
    expect(existsSync(`${tmp}.recovery`)).toBe(false)
  })

  it('preserves an edited incomplete fallback target instead of overwriting it', () => {
    const target = join(directory, 'runtime', 'owner.json')
    const tmp = makeAtomicTmpPath(target)
    writeFileSync(tmp, '{"generation":"old-copy"}')
    writeFileSync(target, '{"generation":"new"}')
    const identity = (stats: NonNullable<ReturnType<typeof lstatSync>>) => ({
      dev: Number(stats.dev),
      ino: Number(stats.ino),
      size: Number(stats.size),
      mtimeMs: Number(stats.mtimeMs),
      birthtimeMs: Number(stats.birthtimeMs),
    })
    writeFileSync(`${tmp}.recovery`, JSON.stringify({
      version: 1,
      targetPath: target,
      source: identity(lstatSync(tmp)),
      target: identity(lstatSync(target)),
      complete: false,
    }))

    expect(() => recoverOrphanTmpFiles(directory)).toThrow(RecoveryBlockedError)
    expect(readFileSync(target, 'utf8')).toBe('{"generation":"new"}')
    expect(existsSync(tmp)).toBe(true)
    expect(existsSync(`${tmp}.recovery`)).toBe(true)
  })

  it('recovers a complete fallback when final marker publication is interrupted after copying', () => {
    const target = join(directory, 'runtime', 'execution-setup-profile.json')
    const content = JSON.stringify({ payload: 'marker boundary' })
    const tmp = makeAtomicTmpPath(target)
    writeFileSync(tmp, content)
    let publications = 0
    const originalRename = renameSync
    const deps = {
      link: () => { throw Object.assign(new Error('unsupported'), { code: 'ENOSYS' }) },
      rename: (from: string, to: string) => {
        if (to === `${tmp}.recovery` && ++publications === 2) {
          throw new Error('simulated marker publication interruption')
        }
        originalRename(from, to)
      },
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(recoverOrphanTmpFiles(directory, 'ticket', deps)).toEqual([])
    expect(publications).toBe(2)
    expect(readFileSync(target, 'utf8')).toBe(content)
    expect(readFileSync(tmp, 'utf8')).toBe(content)
    expect(JSON.parse(readFileSync(`${tmp}.recovery`, 'utf8'))).toMatchObject({
      targetPath: target,
      source: expect.any(Object),
      target: expect.any(Object),
    })

    expect(recoverOrphanTmpFiles(directory)).toEqual([target])
    expect(existsSync(tmp)).toBe(false)
    expect(existsSync(`${tmp}.recovery`)).toBe(false)
  })

  it('blocks a completed fallback after a newer append', () => {
    const target = join(directory, 'runtime', 'owner.json')
    const tmp = makeAtomicTmpPath(target)
    writeFileSync(tmp, '{"generation":"old"}')
    const deps = {
      link: () => { throw Object.assign(new Error('unsupported'), { code: 'ENOSYS' }) },
      rename: (from: string, to: string) => {
        if (from === tmp) throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' })
        renameSync(from, to)
      },
    }

    expect(recoverOrphanTmpFiles(directory, 'ticket', deps)).toEqual([target])
    expect(JSON.parse(readFileSync(`${tmp}.recovery`, 'utf8'))).toMatchObject({ complete: true })
    appendFileSync(target, '\n{"generation":"new"}')
    const newer = readFileSync(target, 'utf8')

    expect(() => recoverOrphanTmpFiles(directory)).toThrow(RecoveryBlockedError)
    expect(readFileSync(target, 'utf8')).toBe(newer)
    expect(existsSync(tmp)).toBe(true)
    expect(existsSync(`${tmp}.recovery`)).toBe(true)
  })

  it('fails closed across boots when a torn marker sits beside a newer target', () => {
    const target = join(directory, 'runtime', 'owner.json')
    const tmp = makeAtomicTmpPath(target)
    writeFileSync(tmp, '{"owner":"old"}')
    writeFileSync(target, '{"owner":"new"}')
    writeFileSync(`${tmp}.recovery`, '')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => recoverOrphanTmpFiles(directory)).toThrow(RecoveryBlockedError)
    expect(existsSync(tmp)).toBe(true)
    expect(existsSync(`${tmp}.recovery`)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('{"owner":"new"}')
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('invalid'))

    // An invalid marker is a durable blocked-artifact diagnostic, not a hint
    // to publish an older temp on the next boot.
    expect(() => recoverOrphanTmpFiles(directory)).toThrow(RecoveryBlockedError)
    expect(readFileSync(target, 'utf8')).toBe('{"owner":"new"}')
    expect(existsSync(tmp)).toBe(true)
    expect(existsSync(`${tmp}.recovery`)).toBe(true)
  })

  it('does not expose an empty target when its marker is torn', () => {
    const target = join(directory, 'runtime', 'owner.json')
    const tmp = makeAtomicTmpPath(target)
    writeFileSync(tmp, '{"owner":"complete"}')
    writeFileSync(target, '')
    writeFileSync(`${tmp}.recovery`, '{')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => recoverOrphanTmpFiles(directory)).toThrow(RecoveryBlockedError)
    expect(readFileSync(target, 'utf8')).toBe('')
    expect(existsSync(tmp)).toBe(true)
    expect(existsSync(`${tmp}.recovery`)).toBe(true)

    expect(() => recoverOrphanTmpFiles(directory)).toThrow(RecoveryBlockedError)
    expect(readFileSync(target, 'utf8')).toBe('')
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('invalid'))
  })

  it('keeps a newer target when a valid source-only marker cannot prove its bytes', () => {
    const target = join(directory, 'runtime', 'owner.json')
    const tmp = makeAtomicTmpPath(target)
    writeFileSync(tmp, '{"owner":"old"}')
    writeFileSync(target, '{"owner":"new"}')
    const source = lstatSync(tmp)
    writeFileSync(`${tmp}.recovery`, JSON.stringify({
      version: 1,
      targetPath: target,
      source: {
        dev: Number(source.dev),
        ino: Number(source.ino),
        size: Number(source.size),
        mtimeMs: Number(source.mtimeMs),
        birthtimeMs: Number(source.birthtimeMs),
      },
    }))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => recoverOrphanTmpFiles(directory)).toThrow(RecoveryBlockedError)
    expect(readFileSync(target, 'utf8')).toBe('{"owner":"new"}')
    expect(existsSync(tmp)).toBe(true)
    expect(existsSync(`${tmp}.recovery`)).toBe(true)

    expect(() => recoverOrphanTmpFiles(directory)).toThrow(RecoveryBlockedError)
    expect(readFileSync(target, 'utf8')).toBe('{"owner":"new"}')
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('incomplete or changed'))
  })

  it('copies large temp content in bounded chunks without dropping bytes', () => {
    const target = join(directory, 'runtime', 'execution-setup-profile.json')
    const content = JSON.stringify('café'.repeat(40_000))
    const tmp = makeAtomicTmpPath(target)
    writeFileSync(tmp, content)
    vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('unsupported'), { code: 'ENOSYS' }) })
    expect(recoverOrphanTmpFiles(directory)).toEqual([target])
    expect(readFileSync(target, 'utf8')).toBe(content)
    expect(existsSync(tmp)).toBe(false)
  })

  it('truncates the opened file even if its pathname is replaced before reading', () => {
    const path = join(directory, 'log.jsonl')
    const heldPath = join(directory, 'original.jsonl')
    const replacement = join(directory, 'replacement.jsonl')
    writeFileSync(path, '{"message":"café"}\n{broken\n')
    writeFileSync(replacement, '{"private":true}\n{untouched\n')
    const open = fileReader.openFileNoFollowSync
    vi.spyOn(fileReader, 'openFileNoFollowSync').mockImplementation((candidate, flags) => {
      const fd = open(candidate, flags)
      renameSync(path, heldPath)
      renameSync(replacement, path)
      return fd
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(fixTrailingLineCorruption(path)).toBe(true)
    expect(readFileSync(heldPath, 'utf8')).toBe('{"message":"café"}\n')
    expect(readFileSync(path, 'utf8')).toBe('{"private":true}\n{untouched\n')
  })

  it.runIf(process.platform !== 'win32')('refuses an existing final symlink without truncating its destination', () => {
    const outside = join(directory, 'outside.jsonl')
    const path = join(directory, 'log.jsonl')
    writeFileSync(outside, '{"private":true}\n{untouched\n')
    symlinkSync(outside, path)
    expect(() => fixTrailingLineCorruption(path)).toThrow()
    expect(readFileSync(outside, 'utf8')).toBe('{"private":true}\n{untouched\n')
  })

  it('keeps missing logs absent', () => {
    expect(fixTrailingLineCorruption(join(directory, 'missing.jsonl'))).toBe(false)
  })
})
