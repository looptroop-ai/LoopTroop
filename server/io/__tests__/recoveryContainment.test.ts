import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixTrailingLineCorruption, recoverOrphanTmpFiles } from '../recovery'
import { makeAtomicTmpPath } from '../atomicWrite'
import * as fileReader from '../readFile'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }))

let directory: string

beforeEach(() => { directory = makeTempDir('looptroop-recovery-containment-') })
afterEach(() => {
  vi.restoreAllMocks()
  removeTempDir(directory)
})

describe('recovery descriptor containment', () => {
  it.each([
    ['file', false], ['alias', false], ['file', true], ['alias', true],
  ] as const)('never promotes a replacement %s (copy fallback: %s)', (replacementKind, copyFallback) => {
    const target = join(directory, 'data.json')
    const tmp = makeAtomicTmpPath(target)
    const original = '{"validated":true}'
    writeFileSync(tmp, original, { mode: 0o600 })
    const outside = join(directory, 'outside')
    mkdirSync(outside)
    const open = fileReader.openFileNoFollowSync
    if (copyFallback) vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('unsupported'), { code: 'ENOSYS' }) })
    else if (replacementKind === 'alias') {
      // Windows cannot hardlink a junction; reproduce the linked alias at the
      // publication boundary without requiring file-symlink privileges.
      vi.spyOn(fs, 'linkSync').mockImplementation(() => { symlinkSync(outside, target, 'junction') })
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fileReader, 'openFileNoFollowSync').mockImplementation((path, flags) => {
      const fd = open(path, flags)
      if (path === tmp) {
        renameSync(tmp, join(directory, 'held-original'))
        if (replacementKind === 'file') writeFileSync(tmp, '{"notValidated":true}')
        else symlinkSync(outside, tmp, 'junction')
      }
      return fd
    })
    expect(recoverOrphanTmpFiles(directory)).toEqual(copyFallback ? [target] : [])
    if (copyFallback) {
      expect(readFileSync(target, 'utf8')).toBe(original)
      if (process.platform !== 'win32') expect(lstatSync(target).mode & 0o777).toBe(0o600)
    } else expect(existsSync(target)).toBe(false)
    if (replacementKind === 'file') expect(readFileSync(tmp, 'utf8')).toBe('{"notValidated":true}')
    else expect(lstatSync(tmp).isSymbolicLink()).toBe(true)
  })

  it('keeps a target created after inspection and preserves the temp for a later attempt', () => {
    const target = join(directory, 'data.json')
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
    const target = join(directory, 'notes.txt')
    const tmp = makeAtomicTmpPath(target)
    writeFileSync(tmp, 'validated content')
    vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('unsupported'), { code: 'ENOSYS' }) })
    vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      if (replaceTarget) {
        renameSync(target, join(directory, 'held-target'))
        writeFileSync(target, 'replacement target')
      }
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(recoverOrphanTmpFiles(directory)).toEqual([])
    expect(readFileSync(tmp, 'utf8')).toBe('validated content')
    if (replaceTarget) expect(readFileSync(target, 'utf8')).toBe('replacement target')
    else expect(existsSync(target)).toBe(false)
  })

  it('copies large temp content in bounded chunks without dropping bytes', () => {
    const target = join(directory, 'notes.txt')
    const content = 'café'.repeat(40_000)
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
