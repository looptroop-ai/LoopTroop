import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { safeAtomicWrite } from '../atomicWrite'
import { safeAtomicAppend } from '../atomicAppend'
import { recoverOrphanTmpFiles, fixTrailingLineCorruption } from '../recovery'
import { readJsonl, writeJsonl, appendJsonl } from '../jsonl'
import { removeTempDir } from '../../test/tempDir'

const TEST_DIR = join(tmpdir(), `looptroop-test-${process.pid}-${Date.now()}`)

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  removeTempDir(TEST_DIR)
})

describe('safeAtomicWrite', () => {
  it('writes file correctly', () => {
    const filePath = join(TEST_DIR, 'test.txt')
    safeAtomicWrite(filePath, 'hello world')
    expect(readFileSync(filePath, 'utf-8')).toBe('hello world')
  })

  it('overwrites existing file', () => {
    const filePath = join(TEST_DIR, 'overwrite.txt')
    safeAtomicWrite(filePath, 'first')
    safeAtomicWrite(filePath, 'second')
    expect(readFileSync(filePath, 'utf-8')).toBe('second')
  })

  it('creates nested directories', () => {
    const filePath = join(TEST_DIR, 'nested', 'deep', 'file.txt')
    safeAtomicWrite(filePath, 'nested content')
    expect(readFileSync(filePath, 'utf-8')).toBe('nested content')
  })

  /**
   * Windows refuses to rename over a file another process still has open, and
   * reports it as EPERM, EACCES or EBUSY depending on how the holder opened it.
   * A published-install smoke hit exactly that renaming `daemon.json`.
   *
   * Driven through injected deps rather than a real lock: the behaviour under
   * test only occurs on Windows, and a test that can only run there is a test
   * that runs on a third of the matrix and is debugged on none of it.
   */
  describe('renaming over a file Windows will not release', () => {
    /** Fails the first `failures` attempts with `code`, then succeeds. */
    function flakyRename(failures: number, code: string) {
      const attempts: string[] = []
      let remaining = failures

      return {
        attempts,
        rename: (from: string, to: string) => {
          attempts.push(from)
          if (remaining > 0) {
            remaining -= 1
            throw Object.assign(new Error(`${code}: rename failed`), { code })
          }
          renameSync(from, to)
        },
      }
    }

    function windowsDeps(rename: (from: string, to: string) => void, waits: number[]) {
      return { platform: 'win32' as NodeJS.Platform, rename, wait: (ms: number) => { waits.push(ms) } }
    }

    it('succeeds without waiting when the rename works first time', () => {
      const filePath = join(TEST_DIR, 'first-try.txt')
      const waits: number[] = []
      const flaky = flakyRename(0, 'EPERM')

      safeAtomicWrite(filePath, 'content', windowsDeps(flaky.rename, waits))

      expect(readFileSync(filePath, 'utf-8')).toBe('content')
      expect(waits).toEqual([])
    })

    it('waits out a handle that is released part way through', () => {
      const filePath = join(TEST_DIR, 'transient.txt')
      const waits: number[] = []
      const flaky = flakyRename(3, 'EBUSY')

      safeAtomicWrite(filePath, 'content', windowsDeps(flaky.rename, waits))

      expect(readFileSync(filePath, 'utf-8')).toBe('content')
      expect(waits).toEqual([50, 50, 50])
      // The same temporary file every time: it is already written, mode-matched
      // and fsynced, and only the final step is being repeated.
      expect(new Set(flaky.attempts).size).toBe(1)
    })

    it('gives up after a bounded number of attempts and reports the real error', () => {
      const filePath = join(TEST_DIR, 'never-released.txt')
      const waits: number[] = []
      const flaky = flakyRename(Number.POSITIVE_INFINITY, 'EACCES')

      expect(() => safeAtomicWrite(filePath, 'content', windowsDeps(flaky.rename, waits)))
        .toThrow(/EACCES/)

      expect(flaky.attempts).toHaveLength(10)
      expect(waits).toHaveLength(9)
      // The half-written file must not be left behind for `recoverOrphanTmpFiles`
      // to find, and the target must not have been touched.
      expect(existsSync(filePath)).toBe(false)
      expect(readdirSync(TEST_DIR).filter((name) => name.endsWith('.tmp'))).toEqual([])
    })

    it('does not retry an error that will not resolve itself', () => {
      const filePath = join(TEST_DIR, 'not-transient.txt')
      const waits: number[] = []
      const flaky = flakyRename(Number.POSITIVE_INFINITY, 'ENOSPC')

      expect(() => safeAtomicWrite(filePath, 'content', windowsDeps(flaky.rename, waits)))
        .toThrow(/ENOSPC/)

      // Waiting 500ms to report a full disk helps nobody.
      expect(flaky.attempts).toHaveLength(1)
      expect(waits).toEqual([])
    })

    it('does not retry at all off Windows, where the rename cannot fail this way', () => {
      const filePath = join(TEST_DIR, 'posix.txt')
      const waits: number[] = []
      const flaky = flakyRename(1, 'EPERM')

      expect(() => safeAtomicWrite(filePath, 'content', {
        platform: 'linux',
        rename: flaky.rename,
        wait: (ms: number) => { waits.push(ms) },
      })).toThrow(/EPERM/)

      expect(flaky.attempts).toHaveLength(1)
      expect(waits).toEqual([])
    })
  })
})

describe('safeAtomicAppend', () => {
  it('appends to a new file', () => {
    const filePath = join(TEST_DIR, 'append.txt')
    safeAtomicAppend(filePath, 'line 1')
    expect(readFileSync(filePath, 'utf-8')).toBe('line 1\n')
  })

  it('appends to an existing file', () => {
    const filePath = join(TEST_DIR, 'append2.txt')
    safeAtomicAppend(filePath, 'line 1')
    safeAtomicAppend(filePath, 'line 2')
    expect(readFileSync(filePath, 'utf-8')).toBe('line 1\nline 2\n')
  })

  it('handles files without trailing newline', () => {
    const filePath = join(TEST_DIR, 'no-newline.txt')
    writeFileSync(filePath, 'existing', 'utf-8')
    safeAtomicAppend(filePath, 'appended')
    expect(readFileSync(filePath, 'utf-8')).toBe('existing\nappended\n')
  })

  it('creates parent directories before appending', () => {
    const filePath = join(TEST_DIR, 'nested', 'logs', 'append.txt')
    safeAtomicAppend(filePath, 'line 1')
    safeAtomicAppend(filePath, 'line 2')
    expect(readFileSync(filePath, 'utf-8')).toBe('line 1\nline 2\n')
  })
})

describe('recoverOrphanTmpFiles', () => {
  it('promotes orphan .tmp files', () => {
    const tmpFile = join(TEST_DIR, 'data.json.tmp')
    writeFileSync(tmpFile, '{"key": "value"}', 'utf-8')

    const recovered = recoverOrphanTmpFiles(TEST_DIR)
    expect(recovered).toContain(join(TEST_DIR, 'data.json'))
    expect(existsSync(join(TEST_DIR, 'data.json'))).toBe(true)
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('handles nested .tmp files', () => {
    const nestedDir = join(TEST_DIR, 'sub')
    mkdirSync(nestedDir, { recursive: true })
    writeFileSync(join(nestedDir, 'file.txt.tmp'), 'content', 'utf-8')

    const recovered = recoverOrphanTmpFiles(TEST_DIR)
    expect(recovered).toContain(join(nestedDir, 'file.txt'))
  })

})

describe('fixTrailingLineCorruption', () => {
  it('fixes corrupt last line in JSONL', () => {
    const filePath = join(TEST_DIR, 'corrupt.jsonl')
    writeFileSync(filePath, '{"a":1}\n{"b":2}\n{corrupt\n', 'utf-8')

    const fixed = fixTrailingLineCorruption(filePath)
    expect(fixed).toBe(true)

    const content = readFileSync(filePath, 'utf-8')
    expect(content).toBe('{"a":1}\n{"b":2}\n')
  })

  it('leaves valid JSONL untouched', () => {
    const filePath = join(TEST_DIR, 'valid.jsonl')
    writeFileSync(filePath, '{"a":1}\n{"b":2}\n', 'utf-8')

    const fixed = fixTrailingLineCorruption(filePath)
    expect(fixed).toBe(false)
  })

})

describe('JSONL read/write/append', () => {
  it('writes and reads JSONL', () => {
    const filePath = join(TEST_DIR, 'data.jsonl')
    const items = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]

    writeJsonl(filePath, items)
    const result = readJsonl<{ name: string }>(filePath)
    expect(result).toEqual(items)
  })

  it('appends to JSONL', () => {
    const filePath = join(TEST_DIR, 'append.jsonl')
    appendJsonl(filePath, { id: 1 })
    appendJsonl(filePath, { id: 2 })

    const result = readJsonl<{ id: number }>(filePath)
    expect(result).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('skips malformed lines', () => {
    const filePath = join(TEST_DIR, 'mixed.jsonl')
    writeFileSync(filePath, '{"a":1}\nnot-json\n{"b":2}\n', 'utf-8')

    const result = readJsonl<{ a?: number; b?: number }>(filePath)
    expect(result).toEqual([{ a: 1 }, { b: 2 }])
  })

})
