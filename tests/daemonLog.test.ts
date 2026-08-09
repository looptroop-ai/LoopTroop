import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_LOG_BYTES,
  MAX_LOG_GENERATIONS,
  rotateDaemonLog,
  rotateRunningDaemonLog,
  startDaemonLogRotation,
} from '../server/lib/daemonLog'
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

  /**
   * Rotation at startup bounds the log only for daemons that get restarted, and
   * this one is built not to be: detached, surviving logout, started once and
   * forgotten. A daemon whose OpenCode is in a crash loop writes continuously,
   * so the file grew for as long as the machine was up.
   */
  describe('while the daemon is running', () => {
    const openHandles: number[] = []

    afterEach(() => {
      for (const fd of openHandles.splice(0)) {
        try { closeSync(fd) } catch { /* already closed */ }
      }
    })

    /** stdout of the detached daemon: opened for append, held for its lifetime. */
    function openAsDaemon(logPath: string): number {
      const fd = openSync(logPath, 'a')
      openHandles.push(fd)
      return fd
    }

    it('keeps the log the running daemon writes into', () => {
      const configDir = makeConfigDir()
      const logPath = writeLog(configDir, MAX_LOG_BYTES + 1, 'a')
      const fd = openAsDaemon(logPath)

      expect(rotateRunningDaemonLog(configDir)).toBe(true)
      writeSync(fd, 'after rotation\n')

      // A rename would have left this descriptor writing into the rotated file
      // on POSIX, and would have failed outright on Windows. The daemon has no
      // idea any of this happened and must not need one.
      expect(readFileSync(logPath, 'utf8')).toBe('after rotation\n')
      expect(readFileSync(`${logPath}.1`, 'utf8').startsWith('a')).toBe(true)
    })

    it('starts the live log again from zero rather than from where it was', () => {
      const configDir = makeConfigDir()
      const logPath = writeLog(configDir, MAX_LOG_BYTES + 1, 'a')
      openAsDaemon(logPath)

      rotateRunningDaemonLog(configDir)

      // Truncation alone leaves an append handle writing at its old offset on
      // some platforms, which would recreate the size it was meant to reclaim
      // as a sparse file.
      expect(statSync(logPath).size).toBe(0)
    })

    it('leaves a log that is still under the limit alone', () => {
      const configDir = makeConfigDir()
      const logPath = writeLog(configDir, 1024, 'a')

      expect(rotateRunningDaemonLog(configDir)).toBe(false)
      expect(statSync(logPath).size).toBe(1024)
      expect(existsSync(`${logPath}.1`)).toBe(false)
    })

    it('keeps no more generations than rotation at startup does', () => {
      const configDir = makeConfigDir()
      const logPath = getDaemonLogPath(configDir)
      rotateDaemonLog(configDir)
      openAsDaemon(logPath)

      for (let round = 0; round < MAX_LOG_GENERATIONS + 3; round += 1) {
        writeFileSync(logPath, String(round).repeat(MAX_LOG_BYTES + 1))
        rotateRunningDaemonLog(configDir)
      }

      expect(existsSync(`${logPath}.${MAX_LOG_GENERATIONS}`)).toBe(true)
      expect(existsSync(`${logPath}.${MAX_LOG_GENERATIONS + 1}`)).toBe(false)
    })

    it('says nothing happened when there is no log yet', () => {
      const configDir = makeConfigDir()

      expect(rotateRunningDaemonLog(configDir)).toBe(false)
    })

    it('rotates on its own once the daemon has written enough', () => {
      const configDir = makeConfigDir()
      const logPath = writeLog(configDir, MAX_LOG_BYTES + 1, 'a')
      openAsDaemon(logPath)
      vi.useFakeTimers()

      const stop = startDaemonLogRotation({ configDir, intervalMs: 1_000 })
      try {
        // Nothing asks the daemon to rotate; the whole point is that it needs no
        // restart and no cron entry to stay bounded.
        vi.advanceTimersByTime(1_000)
      } finally {
        stop()
        vi.useRealTimers()
      }

      expect(statSync(logPath).size).toBe(0)
      expect(existsSync(`${logPath}.1`)).toBe(true)
    })

    it('stops checking once the daemon is shutting down', () => {
      const configDir = makeConfigDir()
      const logPath = writeLog(configDir, 1024, 'a')
      openAsDaemon(logPath)
      vi.useFakeTimers()

      const stop = startDaemonLogRotation({ configDir, intervalMs: 1_000 })
      stop()
      writeFileSync(logPath, 'a'.repeat(MAX_LOG_BYTES + 1))
      vi.advanceTimersByTime(10_000)
      vi.useRealTimers()

      expect(existsSync(`${logPath}.1`)).toBe(false)
    })
  })
})
