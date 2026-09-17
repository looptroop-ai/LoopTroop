import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, statSync, lstatSync, truncateSync, symlinkSync, unlinkSync, writeSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { atomicProofPath, makeAtomicTmpPath, parseAtomicTmpPath, safeAtomicWrite, safeAtomicWriteWithin } from '../atomicWrite'
import { ContainedPathError } from '../../lib/containedPath'
import * as containedPaths from '../../lib/containedPath'
import { safeAtomicAppend, safeAtomicAppendWithin } from '../atomicAppend'
import { readFileNoFollowSync } from '../readFile'
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

describe('contained reads and appends', () => {
  it('reads regular files and preserves missing-file errors', () => {
    const file = join(TEST_DIR, 'read.txt')
    writeFileSync(file, 'safe')
    expect(readFileNoFollowSync(file)).toBe('safe')
    expect(() => readFileNoFollowSync(join(TEST_DIR, 'missing'))).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    expect(() => readFileNoFollowSync(TEST_DIR)).toThrow(ContainedPathError)
  })

  it('appends through contained directory aliases but refuses escaping aliases', () => {
    const root = join(TEST_DIR, 'root')
    const inside = join(root, 'inside')
    const outside = join(TEST_DIR, 'outside')
    mkdirSync(inside, { recursive: true })
    mkdirSync(outside)
    symlinkSync(inside, join(root, 'alias'), 'junction')
    symlinkSync(outside, join(root, 'escape'), 'junction')
    safeAtomicAppendWithin(root, 'alias/events.jsonl', '{"safe":true}')
    expect(readFileSync(join(inside, 'events.jsonl'), 'utf8')).toBe('{"safe":true}\n')
    expect(() => safeAtomicAppendWithin(root, 'escape/events.jsonl', 'unsafe')).toThrow(ContainedPathError)
    expect(readdirSync(outside)).toEqual([])
    expect(() => readFileNoFollowSync(join(root, 'escape'))).toThrow(ContainedPathError)
  })

  it.skipIf(process.platform === 'win32')('refuses unvalidated final file links before reading or appending', () => {
    const target = join(TEST_DIR, 'target')
    const alias = join(TEST_DIR, 'alias')
    writeFileSync(target, 'keep')
    symlinkSync(target, alias)
    expect(() => readFileNoFollowSync(alias)).toThrow(ContainedPathError)
    expect(() => safeAtomicAppend(alias, 'unsafe')).toThrow(ContainedPathError)
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })
})

describe('safeAtomicWriteWithin', () => {
  it('does not swallow a containment failure after rename as a directory-fsync failure', () => {
    const root = join(TEST_DIR, 'root')
    const outside = join(TEST_DIR, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    expect(() => safeAtomicWriteWithin(root, 'nested/file.txt', 'safe', {
      deps: {
        platform: process.platform,
        wait: () => {},
        rename: (from, to) => {
          renameSync(from, to)
          renameSync(join(root, 'nested'), join(root, 'moved'))
          symlinkSync(outside, join(root, 'nested'), 'junction')
        },
      },
    })).toThrow(ContainedPathError)
    expect(readdirSync(outside)).toEqual([])
    expect(readFileSync(join(root, 'moved/file.txt'), 'utf8')).toBe('safe')
  })
  it('creates missing parents and replaces a contained file', () => {
    safeAtomicWriteWithin(TEST_DIR, 'nested/deep/file.txt', 'first', { mode: 0o600 })
    safeAtomicWriteWithin(TEST_DIR, 'nested/deep/file.txt', 'second')
    const filePath = join(TEST_DIR, 'nested/deep/file.txt')
    expect(readFileSync(filePath, 'utf8')).toBe('second')
    if (process.platform !== 'win32') expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it('rejects traversal and absolute paths before creating parents', () => {
    const root = join(TEST_DIR, 'root')
    mkdirSync(root)
    const candidates = ['../outside/file', join(TEST_DIR, 'outside/file'), 'C:\\outside\\file']
    if (process.platform === 'win32') candidates.push('..\\outside\\file')
    for (const candidate of candidates) {
      expect(() => safeAtomicWriteWithin(root, candidate, 'unsafe')).toThrow(ContainedPathError)
    }
    expect(readdirSync(TEST_DIR)).toEqual(['root'])
    expect(readdirSync(root)).toEqual([])
  })

  it('rejects an ancestor junction before creating directories outside the root', () => {
    const root = join(TEST_DIR, 'root')
    const outside = join(TEST_DIR, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => safeAtomicWriteWithin(root, 'linked/new/file.txt', 'unsafe')).toThrow(ContainedPathError)
    expect(readdirSync(outside)).toEqual([])
  })

  it('accepts a symlink above the trusted root', () => {
    const root = join(TEST_DIR, 'root')
    const alias = join(TEST_DIR, 'alias')
    mkdirSync(root)
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    safeAtomicWriteWithin(alias, 'file.txt', 'allowed')
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('allowed')
  })

  it('writes through a contained directory link to its canonical destination', () => {
    const target = join(TEST_DIR, 'target')
    mkdirSync(target)
    symlinkSync(target, join(TEST_DIR, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    safeAtomicWriteWithin(TEST_DIR, 'alias/nested/file.txt', 'allowed')
    expect(readFileSync(join(target, 'nested/file.txt'), 'utf8')).toBe('allowed')
    expect(lstatSync(join(TEST_DIR, 'alias')).isSymbolicLink()).toBe(true)
  })

  it('rejects an ancestor swap during retries without cleaning up outside the root', () => {
    const root = join(TEST_DIR, 'root')
    const outside = join(TEST_DIR, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    let outsideTemp = ''
    let attempts = 0
    expect(() => safeAtomicWriteWithin(root, 'nested/file.txt', 'unsafe', {
      deps: {
        platform: 'win32',
        rename: (from) => {
          attempts += 1
          outsideTemp = join(outside, basename(from))
          writeFileSync(outsideTemp, 'keep')
          renameSync(join(root, 'nested'), join(root, 'moved'))
          symlinkSync(outside, join(root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir')
          throw Object.assign(new Error('Locked'), { code: 'EBUSY' })
        },
        wait: () => {},
      },
    })).toThrow(ContainedPathError)
    expect(attempts).toBe(1)
    expect(readFileSync(outsideTemp, 'utf8')).toBe('keep')
    expect(existsSync(join(outside, 'file.txt'))).toBe(false)
  })

  describe.skipIf(process.platform === 'win32')('file symlinks', () => {
    it('rejects a final link introduced when canonical destination resolution begins', () => {
      const target = join(TEST_DIR, 'target.txt')
      const alias = join(TEST_DIR, 'alias.txt')
      writeFileSync(target, 'keep')
      const resolvePath = containedPaths.resolveContainedPath
      const spy = vi.spyOn(containedPaths, 'resolveContainedPath').mockImplementationOnce((...args) => {
        symlinkSync(target, alias)
        return resolvePath(...args)
      })
      try {
        expect(() => safeAtomicWriteWithin(TEST_DIR, 'alias.txt', 'replacement')).toThrow(ContainedPathError)
        expect(readFileSync(target, 'utf8')).toBe('keep')
      } finally {
        spy.mockRestore()
      }
    })

    it('rejects a contained final file link instead of replacing its destination', () => {
      const target = join(TEST_DIR, 'target.txt')
      const alias = join(TEST_DIR, 'alias.txt')
      writeFileSync(target, 'original', { mode: 0o600 })
      symlinkSync(target, alias)
      expect(() => safeAtomicWriteWithin(TEST_DIR, 'alias.txt', 'replacement')).toThrow(ContainedPathError)
      expect(readFileSync(target, 'utf8')).toBe('original')
      expect(lstatSync(alias).isSymbolicLink()).toBe(true)
    })

    it('rejects target symlinks without touching the destination or its mode', () => {
      const root = join(TEST_DIR, 'root')
      const outside = join(TEST_DIR, 'outside.txt')
      mkdirSync(root)
      writeFileSync(outside, 'original', { mode: 0o600 })
      const mode = statSync(outside).mode
      symlinkSync(outside, join(root, 'file.txt'))
      expect(() => safeAtomicWriteWithin(root, 'file.txt', 'unsafe', { mode: 0o666 })).toThrow(ContainedPathError)
      expect(readFileSync(outside, 'utf8')).toBe('original')
      expect(statSync(outside).mode).toBe(mode)
      expect(readdirSync(root)).toEqual(['file.txt'])
    })

    it.each([
      ['target', false], ['temporary', false], ['target', true], ['temporary', true],
    ] as const)('rechecks the %s path on every rename retry (internal link: %s)', (swapped, internal) => {
      const root = join(TEST_DIR, 'root')
      const outside = join(internal ? root : TEST_DIR, 'other.txt')
      mkdirSync(root)
      writeFileSync(outside, 'original')
      let attempts = 0
      expect(() => safeAtomicWriteWithin(root, 'file.txt', 'unsafe', {
        deps: {
          platform: 'win32',
          rename: (from, to) => {
            attempts += 1
            const attacked = swapped === 'target' ? to : from
            if (swapped === 'temporary') unlinkSync(attacked)
            symlinkSync(outside, attacked)
            throw Object.assign(new Error('Locked'), { code: 'EBUSY' })
          },
          wait: () => {},
        },
      })).toThrow(ContainedPathError)
      expect(attempts).toBe(1)
      expect(readFileSync(outside, 'utf8')).toBe('original')
    })
  })
})

describe('safeAtomicAppend', () => {
  it('loops through short writes before reporting the byte range', () => {
    const filePath = join(TEST_DIR, 'short-write.jsonl')
    const original = (fd: number, buffer: Uint8Array, offset: number, length: number) => writeSync(fd, buffer, offset, length)
    let first = true
    const write = (fd: number, buffer: Uint8Array, offset: number, length: number) => {
      if (first && length > 1) {
        first = false
        return original(fd, buffer, offset, 1)
      }
      return original(fd, buffer, offset, length)
    }

    const range = safeAtomicAppend(filePath, 'café', { write })

    expect(range).toEqual({ offset: 0, length: Buffer.byteLength('café\n') })
    expect(readFileSync(filePath, 'utf8')).toBe('café\n')
  })

  it('throws on a zero-progress write without projecting a range', () => {
    const filePath = join(TEST_DIR, 'zero-write.jsonl')

    expect(() => safeAtomicAppend(filePath, 'never complete', { write: () => 0 })).toThrow('made no progress')
    expect(readFileSync(filePath, 'utf8')).toBe('')
  })

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

  function orphanYaml(targetPath: string, content: string): string {
    const tmpPath = orphan(targetPath, content)
    writeFileSync(atomicProofPath(tmpPath), JSON.stringify({
      byteLength: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    }))
    return tmpPath
  }

  function orphanJsonl(targetPath: string, content: string): string {
    const tmpPath = orphan(targetPath, content)
    writeFileSync(atomicProofPath(tmpPath), JSON.stringify({
      byteLength: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    }))
    return tmpPath
  }

  it.each([
    ['execution-setup-profile.json', '{"key":"value"}'],
    ['cancellation-pending.json', '{"state":"pending","requestedAt":"2026-09-17T00:00:00Z"}'],
    ['opencode-pending-sessions.json', '[{"sessionId":"session-1","phase":"CODING"}]'],
  ])('promotes an interrupted runtime write under its real name: %s', (filename, content) => {
    const target = join(TEST_DIR, 'runtime', filename)
    const tmpFile = orphan(target, content)

    const recovered = recoverOrphanTmpFiles(TEST_DIR)

    expect(recovered).toContain(target)
    expect(readFileSync(target, 'utf-8')).toBe(content)
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('handles nested .tmp files', () => {
    const target = join(TEST_DIR, 'runtime', 'owner.json')
    orphan(target, '"content"')

    const recovered = recoverOrphanTmpFiles(TEST_DIR)

    expect(recovered).toContain(target)
    expect(readFileSync(target, 'utf-8')).toBe('"content"')
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
    const target = join(TEST_DIR, 'runtime', 'execution-setup-profile.json')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '{"complete": true}', 'utf-8')
    const tmpFile = orphan(target, '{"partial": true}')

    const recovered = recoverOrphanTmpFiles(TEST_DIR)

    expect(recovered).toEqual([])
    expect(readFileSync(target, 'utf-8')).toBe('{"complete": true}')
    // Cleared away, or `.ticket/**/*.tmp` accumulates for the life of the ticket.
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('discards a temp file whose JSON never finished being written', () => {
    const target = join(TEST_DIR, 'meta', 'ticket.meta.json')
    const tmpFile = orphan(target, '{"id": "abc", "titl')

    const recovered = recoverOrphanTmpFiles(TEST_DIR)

    expect(recovered).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('discards a temp file that is not a readable YAML document', () => {
    const target = join(TEST_DIR, 'prd.yaml')
    const tmpFile = orphanYaml(target, 'artifact: prd\n  broken: [unclosed\n')

    const recovered = recoverOrphanTmpFiles(TEST_DIR)

    expect(recovered).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('promotes a YAML temp file that reads back as a document', () => {
    const target = join(TEST_DIR, 'interview.yaml')
    orphanYaml(target, 'artifact: interview\nquestions: []\n')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toContain(target)
  })

  it('discards a YAML temp file that got no further than its header comment', () => {
    const target = join(TEST_DIR, 'prd.yaml')
    const tmpFile = orphanYaml(target, '# Generated by LoopTroop\n# ticket: PRJ-1\n')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('leaves a YAML mapping without complete-write proof unpromoted', () => {
    const target = join(TEST_DIR, 'prd.yaml')
    const tmpFile = orphan(target, 'artifact: prd\nquestions: []\n')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(true)
  })

  it('discards an empty temp file', () => {
    const target = join(TEST_DIR, 'runtime', 'execution-setup-profile.json')
    const tmpFile = orphan(target, '')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(false)
  })

  /**
   * A half-written final line is the expected shape of an interrupted append,
   * and repairing it is `fixTrailingLineCorruption`'s job on the actual append
   * file, not on this whole-file atomic temp.
   */
  it('leaves a JSONL temp file with a truncated last line for inspection', () => {
    const target = join(TEST_DIR, 'runtime', 'execution-log.jsonl')
    const tmpFile = orphan(target, '{"a":1}\n{"b":2}\n{"c":')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(true)
  })

  it('recovers an empty JSONL whole-file artifact as an empty collection', () => {
    const target = join(TEST_DIR, 'beads', 'feature', '.beads', 'issues.jsonl')
    const tmpFile = orphanJsonl(target, '')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([target])
    expect(readFileSync(target, 'utf8')).toBe('')
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('leaves an empty JSONL temp without a complete-write proof', () => {
    const target = join(TEST_DIR, 'beads', 'feature', '.beads', 'issues.jsonl')
    const tmpFile = orphan(target, '')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(true)
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
  it('does not trim a torn atomic JSONL temp', () => {
    const target = join(TEST_DIR, 'runtime', 'execution-log.jsonl')
    const tmpFile = orphan(target, '{"a":1}\n{"b":2}\n{"c":')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(fixTrailingLineCorruption(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(true)
  })

  /**
   * `existsSync` follows the link and reports `false` for a broken one, which
   * would make an occupied name look free.
   */
  it.skipIf(process.platform === 'win32')('treats a symlink pointing nowhere as an occupied name', () => {
    const target = join(TEST_DIR, 'runtime', 'execution-setup-profile.json')
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(join(TEST_DIR, 'missing.json'), target)
    const tmpFile = orphan(target, '{"key": "value"}')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(existsSync(tmpFile)).toBe(true)
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('warns and leaves a symbolic-link temp without touching its target', () => {
    const target = join(TEST_DIR, 'runtime', 'execution-setup-profile.json')
    const tmpFile = makeAtomicTmpPath(target)
    const outside = join(TEST_DIR, 'outside.json')
    mkdirSync(dirname(tmpFile), { recursive: true })
    mkdirSync(dirname(outside), { recursive: true })
    writeFileSync(outside, '{"outside":true}')
    symlinkSync(outside, tmpFile)

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(lstatSync(tmpFile).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('{"outside":true}')
  })

  it('leaves a temp whose target is not a known LoopTroop artifact', () => {
    const target = join(TEST_DIR, 'notes.txt')
    const tmpFile = orphan(target, 'user content')

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(existsSync(tmpFile)).toBe(true)
    expect(existsSync(target)).toBe(false)
  })

  it('leaves a temp file it cannot read rather than deleting it unseen', () => {
    const target = join(TEST_DIR, 'runtime', 'execution-setup-profile.json')
    const tmpFile = orphan(target, '{"partial":')
    // Stands in for a file past the size this can hold in memory to check.
    truncateSync(tmpFile, 300 * 1024 * 1024)

    expect(recoverOrphanTmpFiles(TEST_DIR)).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(existsSync(tmpFile)).toBe(true)
  })

  it('recognises the suffix case-insensitively, for Windows', () => {
    const target = join(TEST_DIR, 'runtime', 'execution-setup-profile.json')
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
