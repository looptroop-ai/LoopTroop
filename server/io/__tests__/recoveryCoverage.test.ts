import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeAtomicTmpPath } from '../atomicWrite'
import { RecoveryBlockedError, recoverOrphanTmpFiles } from '../recovery'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

let rootDir: string

beforeEach(() => {
  rootDir = makeTempDir('looptroop-recovery-coverage-')
})

afterEach(() => {
  removeTempDir(rootDir)
})

describe('recovery fallback markers', () => {
  function fileIdentity(path: string) {
    const stats = lstatSync(path)
    return {
      dev: Number(stats.dev),
      ino: Number(stats.ino),
      size: Number(stats.size),
      mtimeMs: Number(stats.mtimeMs),
      birthtimeMs: Number(stats.birthtimeMs),
    }
  }

  it('cleans a complete source-only fallback after a crash before marker finalization', () => {
    const targetPath = join(rootDir, 'runtime', 'owner.json')
    mkdirSync(dirname(targetPath), { recursive: true })
    const tmpPath = makeAtomicTmpPath(targetPath)
    const content = '{"owner":"complete"}'
    writeFileSync(tmpPath, content)
    writeFileSync(targetPath, content)
    writeFileSync(`${tmpPath}.recovery`, JSON.stringify({
      version: 1,
      targetPath,
      source: fileIdentity(tmpPath),
    }))

    expect(recoverOrphanTmpFiles(rootDir)).toEqual([targetPath])

    expect(readFileSync(targetPath, 'utf8')).toBe(content)
    expect(existsSync(tmpPath)).toBe(false)
    expect(existsSync(`${tmpPath}.recovery`)).toBe(false)
  })

  it.each(['target', 'source'] as const)('blocks a fallback marker with a mismatched %s identity', (mismatch) => {
    const targetPath = join(rootDir, 'runtime', 'owner.json')
    mkdirSync(dirname(targetPath), { recursive: true })
    const tmpPath = makeAtomicTmpPath(targetPath)
    const content = '{"owner":"validated"}'
    writeFileSync(tmpPath, content)
    writeFileSync(targetPath, '{"owner":"newer"}')
    const source = fileIdentity(tmpPath)
    if (mismatch === 'source') source.ino += 1
    writeFileSync(`${tmpPath}.recovery`, JSON.stringify({
      version: 1,
      targetPath: mismatch === 'target' ? join(rootDir, 'runtime', 'other.json') : targetPath,
      source,
    }))

    expect(() => recoverOrphanTmpFiles(rootDir)).toThrow(RecoveryBlockedError)
    expect(readFileSync(targetPath, 'utf8')).toBe('{"owner":"newer"}')
    expect(readFileSync(tmpPath, 'utf8')).toBe(content)
    expect(existsSync(`${tmpPath}.recovery`)).toBe(true)
  })

  it('preserves a concurrent temp replacement when cleanup must copy across filesystems', () => {
    const targetPath = join(rootDir, 'runtime', 'owner.json')
    mkdirSync(dirname(targetPath), { recursive: true })
    const tmpPath = makeAtomicTmpPath(targetPath)
    const original = '{"owner":'
    const replacement = '{"owner":"concurrent generation"}'
    const heldOriginal = join(rootDir, 'held-original-temp')
    writeFileSync(tmpPath, original)
    let injected = false
    const deps = {
      link: () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }) },
      rename: (from: string, to: string) => {
        renameSync(from, to)
        if (!injected) {
          injected = true
          renameSync(to, heldOriginal)
          writeFileSync(to, replacement)
        }
      },
    }

    expect(recoverOrphanTmpFiles(rootDir, 'ticket', deps)).toEqual([])

    expect(injected).toBe(true)
    expect(readFileSync(heldOriginal, 'utf8')).toBe(original)
    expect(readFileSync(tmpPath, 'utf8')).toBe(replacement)
    expect(existsSync(targetPath)).toBe(false)
  })

  it('blocks an incomplete fallback target that grew beyond its source', () => {
    const targetPath = join(rootDir, 'runtime', 'owner.json')
    mkdirSync(dirname(targetPath), { recursive: true })
    const tmpPath = makeAtomicTmpPath(targetPath)
    const sourceContent = '{"owner":"source"}'
    const targetContent = `${sourceContent} newer data`
    writeFileSync(tmpPath, sourceContent)
    writeFileSync(targetPath, targetContent)
    writeFileSync(`${tmpPath}.recovery`, JSON.stringify({
      version: 1,
      targetPath,
      source: fileIdentity(tmpPath),
      target: fileIdentity(targetPath),
      complete: false,
    }))

    expect(() => recoverOrphanTmpFiles(rootDir)).toThrow(RecoveryBlockedError)

    expect(readFileSync(targetPath, 'utf8')).toBe(targetContent)
    expect(readFileSync(tmpPath, 'utf8')).toBe(sourceContent)
    expect(existsSync(`${tmpPath}.recovery`)).toBe(true)
  })
})
