import { readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixTrailingLineCorruption } from '../recovery'
import * as fileReader from '../readFile'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

let directory: string

beforeEach(() => { directory = makeTempDir('looptroop-recovery-containment-') })
afterEach(() => {
  vi.restoreAllMocks()
  removeTempDir(directory)
})

describe('recovery descriptor containment', () => {
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
