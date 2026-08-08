import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_LOG_BYTES, MAX_LOG_GENERATIONS, rotateDaemonLog } from '../server/lib/daemonLog'
import { getDaemonLogPath } from '../server/lib/daemonPaths'

/**
 * 2.11 contract: a long-lived install must not grow one unbounded log file, and
 * rotation must never discard the newest output or keep more than the agreed
 * number of generations.
 */
describe('daemon log rotation', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-logs-'))
    tempDirs.push(dir)
    return dir
  }

  function writeLog(configDir: string, bytes: number, marker = 'x'): string {
    const logPath = getDaemonLogPath(configDir)
    rotateDaemonLog(configDir)
    writeFileSync(logPath, marker.repeat(bytes))
    return logPath
  }

  it('leaves a small log alone', () => {
    const configDir = makeConfigDir()
    const logPath = writeLog(configDir, 1024)

    rotateDaemonLog(configDir)

    expect(existsSync(logPath)).toBe(true)
    expect(existsSync(`${logPath}.1`)).toBe(false)
  })

  it('rotates once the log passes the limit', () => {
    const configDir = makeConfigDir()
    const logPath = writeLog(configDir, MAX_LOG_BYTES + 1, 'a')

    rotateDaemonLog(configDir)

    // The live file is gone; the next run recreates it by opening for append.
    expect(existsSync(logPath)).toBe(false)
    expect(existsSync(`${logPath}.1`)).toBe(true)
    expect(readFileSync(`${logPath}.1`, 'utf8').startsWith('a')).toBe(true)
  })

  it('shifts older generations up so the newest is always .1', () => {
    const configDir = makeConfigDir()
    const logPath = getDaemonLogPath(configDir)

    writeLog(configDir, MAX_LOG_BYTES + 1, 'a')
    rotateDaemonLog(configDir)

    writeFileSync(logPath, 'b'.repeat(MAX_LOG_BYTES + 1))
    rotateDaemonLog(configDir)

    expect(readFileSync(`${logPath}.1`, 'utf8').startsWith('b')).toBe(true)
    expect(readFileSync(`${logPath}.2`, 'utf8').startsWith('a')).toBe(true)
  })

  it('keeps no more than the configured number of generations', () => {
    const configDir = makeConfigDir()
    const logPath = getDaemonLogPath(configDir)
    // Creates the log directory; there is nothing to rotate yet.
    rotateDaemonLog(configDir)

    for (let round = 0; round < MAX_LOG_GENERATIONS + 3; round += 1) {
      writeFileSync(logPath, String(round).repeat(MAX_LOG_BYTES + 1))
      rotateDaemonLog(configDir)
    }

    expect(existsSync(`${logPath}.${MAX_LOG_GENERATIONS}`)).toBe(true)
    expect(existsSync(`${logPath}.${MAX_LOG_GENERATIONS + 1}`)).toBe(false)
  })

  it('is a no-op when no log exists yet', () => {
    const configDir = makeConfigDir()

    expect(() => rotateDaemonLog(configDir)).not.toThrow()
    expect(existsSync(`${getDaemonLogPath(configDir)}.1`)).toBe(false)
  })
})
