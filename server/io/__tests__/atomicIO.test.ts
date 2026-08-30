import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, statSync, lstatSync, truncateSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { makeAtomicTmpPath, parseAtomicTmpPath, safeAtomicWrite } from '../atomicWrite'
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
   * The temp name is a contract with `recoverOrphanTmpFiles`, which has to
   * reverse it to know what an orphan was on its way to becoming. They drifted
   * apart once already.
   */
  it('names temp files so recovery can derive the target back', () => {
    const filePath = join(TEST_DIR, 'ticket.meta.json')
    expect(parseAtomicTmpPath(makeAtomicTmpPath(filePath))).toBe(filePath)
  })

  it('does not claim a name it did not write', () => {
    expect(parseAtomicTmpPath(join(TEST_DIR, 'ticket.meta.json.tmp'))).toBeNull()
    expect(parseAtomicTmpPath(join(TEST_DIR, 'ticket.meta.json'))).toBeNull()
  })

  describe.skipIf(process.platform === 'win32')('a requested POSIX mode', () => {
    it('is in place before the file appears, not chmodded afterwards', () => {
      const filePath = join(TEST_DIR, 'receipt.json')
      safeAtomicWrite(filePath, '{}\n', { mode: 0o600 })
      expect(statSync(filePath).mode & 0o777).toBe(0o600)
    })

    it('overrides the mode an existing file carries', () => {
      const filePath = join(TEST_DIR, 'widened.json')
      writeFileSync(filePath, '{}\n', { encoding: 'utf-8', mode: 0o644 })
      safeAtomicWrite(filePath, '{"v":2}\n', { mode: 0o600 })
      expect(statSync(filePath).mode & 0o777).toBe(0o600)
    })

    /**
     * A silently umask-moded checkpoint defeats the point of asking for a mode,
     * so the failure is the write's failure — and the target keeps what it had.
     */
    it('fails the write and leaves nothing behind when it cannot be applied', () => {
      const filePath = join(TEST_DIR, 'unmodeable.json')
      writeFileSync(filePath, 'original', 'utf-8')

      expect(() => safeAtomicWrite(filePath, 'replacement', { mode: -1 })).toThrow()

      expect(readFileSync(filePath, 'utf-8')).toBe('original')
      expect(readdirSync(TEST_DIR).filter((name) => name.toLowerCase().endsWith('.tmp'))).toEqual([])
    })
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

    function windowsOptions(rename: (from: string, to: string) => void, waits: number[]) {
      return { deps: { platform: 'win32' as NodeJS.Platform, rename, wait: (ms: number) => { waits.push(ms) } } }
    }

    it('succeeds without waiting when the rename works first time', () => {
      const filePath = join(TEST_DIR, 'first-try.txt')
      const waits: number[] = []
      const flaky = flakyRename(0, 'EPERM')

      safeAtomicWrite(filePath, 'content', windowsOptions(flaky.rename, waits))

      expect(readFileSync(filePath, 'utf-8')).toBe('content')
      expect(waits).toEqual([])
    })

    it('waits out a handle that is released part way through', () => {
      const filePath = join(TEST_DIR, 'transient.txt')
      const waits: number[] = []
      const flaky = flakyRename(3, 'EBUSY')

      safeAtomicWrite(filePath, 'content', windowsOptions(flaky.rename, waits))

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

      expect(() => safeAtomicWrite(filePath, 'content', windowsOptions(flaky.rename, waits)))
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

      expect(() => safeAtomicWrite(filePath, 'content', windowsOptions(flaky.rename, waits)))
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
        deps: {
          platform: 'linux',
          rename: flaky.rename,
          wait: (ms: number) => { waits.push(ms) },
        },
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
  /** A leftover from `safeAtomicWrite`, named the way it names them. */
  function orphan(targetPath: string, content: string): string {
    const tmpPath = makeAtomicTmpPath(targetPath)
    mkdirSync(dirname(tmpPath), { recursive: true })
    writeFileSync(tmpPath, content, 'utf-8')
    return tmpPath
  }

  it('promotes an interrupted write under its real name', () => {
    const target = join(TEST_DIR, 'data.json')
    const tmpFile = orphan(target, '{"key": "value"}')

    const recovered = recoverOrphanTmpFiles(TEST_DIR)

    expect(recovered).toContain(target)
    expect(readFileSync(target, 'utf-8')).toBe('{"key": "value"}')
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('handles nested .tmp files', () => {
    const target = join(TEST_DIR, 'sub', 'file.txt')
    orphan(target, 'content')

    const recovered = recoverOrphanTmpFiles(TEST_DIR)

    expect(recovered).toContain(target)
    expect(readFileSync(target, 'utf-8')).toBe('content')
  })

  /**
   * The pre-upgrade writer used a plain `${target}.tmp`, whose target cannot be
   * derived from the name: `report.json.tmp` is as consistent with a crashed
   * write of `report.json` as with a file someone named that on purpose. The
   * old recovery guessed, and stripping four characters from the current suffix
   * is what produced `ticket.meta.json.4821.a1b2c3` — never anything's target.
   */
  it('leaves a legacy-suffix temp file alone rather than guessing its target', () => {
    const legacy = join(TEST_DIR, 'data.json.tmp')
    writeFileSync(legacy, '{"key": "value"}', 'utf-8')

    const recovered = recoverOrphanTmpFiles(TEST_DIR)

    expect(recovered).toEqual([])
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(join(TEST_DIR, 'data.json'))).toBe(false)
  })

  it('never replaces a target that already exists', () => {
    const target = join(TEST_DIR, 'data.json')
    writeFileSync(target, '{"complete": true}', 'utf-8')
    const tmpFile = orphan(target, '{"partial": true}')

    const recovered = recoverOrphanTmpFiles(TEST_DIR)

    expect(recovered).toEqual([])
    expect(readFileSync(target, 'utf-8')).toBe('{"complete": true}')
    // Cleared away, or `.ticket/**/*.tmp` accumulates for the life of the ticket.
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('discards a temp file whose JSON never finished being written', () => {
    const target = join(TEST_DIR, 'ticket.meta.json')
    const tmpFile = orphan(target, '{"id": "abc", "titl')

    const recovered = recoverOrphanTmpFiles(TEST_DIR)

    expect(recovered).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('discards a temp file that is not a readable YAML document', () => {
    const target = join(TEST_DIR, 'prd.yaml')
    const tmpFile = orphan(target, 'artifact: prd\n  broken: [unclosed\n')

    const recovered = recoverOrphanTmpFiles(TEST_DIR)

    expect(recovered).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('promotes a YAML temp file that reads back as a document', () => {
    const target = join(TEST_DIR, 'interview.yaml')
    orphan(target, 'artifact: interview\nquestions: []\n')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toContain(target)
  })

  it('discards a YAML temp file that got no further than its header comment', () => {
    const target = join(TEST_DIR, 'prd.yaml')
    const tmpFile = orphan(target, '# Generated by LoopTroop\n# ticket: PRJ-1\n')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('discards an empty temp file', () => {
    const target = join(TEST_DIR, 'notes.txt')
    const tmpFile = orphan(target, '')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(false)
  })

  /**
   * A half-written final line is the expected shape of an interrupted append,
   * and repairing it is `fixTrailingLineCorruption`'s job — which
   * `recoverTicketRuntimeArtifacts` runs immediately after this, on these files.
   */
  it('promotes a JSONL temp file with a truncated last line', () => {
    const target = join(TEST_DIR, 'execution.jsonl')
    orphan(target, '{"a":1}\n{"b":2}\n{"c":')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toContain(target)
  })

  /**
   * The Manual QA checkpoint writer that `safeAtomicWrite` replaced produced
   * these. They do not end in `.tmp`, so nothing has ever swept them.
   */
  it('reports the Manual QA writer\'s old temp names instead of ignoring them', () => {
    const legacy = join(TEST_DIR, 'workspace-baseline-v1.json.tmp-4821-1700000000000')
    writeFileSync(legacy, '{"schemaVersion": 1}', 'utf-8')
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }

    try {
      expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    } finally {
      console.warn = warn
    }

    expect(existsSync(legacy)).toBe(true)
    expect(warnings.join(' ')).toContain(legacy)
  })

  /**
   * The interrupted append and the repair that finishes it are two halves of
   * one story, and they run one after the other on the same files at boot.
   */
  it('promotes a torn JSONL log that fixTrailingLineCorruption then trims', () => {
    const target = join(TEST_DIR, 'execution.jsonl')
    orphan(target, '{"a":1}\n{"b":2}\n{"c":')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toContain(target)
    expect(fixTrailingLineCorruption(target)).toBe(true)
    expect(readFileSync(target, 'utf-8')).toBe('{"a":1}\n{"b":2}\n')
  })

  /**
   * `existsSync` follows the link and reports `false` for a broken one, which
   * would make an occupied name look free.
   */
  it.skipIf(process.platform === 'win32')('treats a symlink pointing nowhere as an occupied name', () => {
    const target = join(TEST_DIR, 'data.json')
    symlinkSync(join(TEST_DIR, 'missing.json'), target)
    const tmpFile = orphan(target, '{"key": "value"}')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(existsSync(tmpFile)).toBe(false)
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
  })

  it('leaves a temp file it cannot read rather than deleting it unseen', () => {
    const target = join(TEST_DIR, 'huge.json')
    const tmpFile = orphan(target, '{"partial":')
    // Stands in for a file past the size this can hold in memory to check.
    truncateSync(tmpFile, 300 * 1024 * 1024)

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(true)
  })

  it('recognises the suffix case-insensitively, for Windows', () => {
    const target = join(TEST_DIR, 'data.json')
    const tmpFile = orphan(target, '{"key": "value"}')
    const upperCased = `${tmpFile.slice(0, -4)}.TMP`
    renameSync(tmpFile, upperCased)

    expect(recoverOrphanTmpFiles(TEST_DIR)).toContain(target)
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
