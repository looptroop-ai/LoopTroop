import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import {
  acquireDaemonLock,
  DaemonLockedError,
  STALE_LOCK_MS,
  type LockOwner,
} from '../server/lib/daemonLock'
import { getDaemonLockPath } from '../server/lib/daemonPaths'

/**
 * 2.6 contract: exclusive single-instance ownership. Two concurrent starts must
 * not both succeed, a lock left by a crashed run must be reclaimable, and a lock
 * must only be released by the run that took it.
 */
describe('daemon lock', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-lock-'))
    tempDirs.push(dir)
    return dir
  }

  function writeLock(configDir: string, owner: Partial<LockOwner>): void {
    writeFileSync(getDaemonLockPath(configDir), JSON.stringify({
      nonce: 'existing-nonce',
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ...owner,
    }))
  }

  it('creates the lock file and records the owner', () => {
    const configDir = makeConfigDir()
    const lock = acquireDaemonLock(configDir)

    try {
      expect(existsSync(lock.path)).toBe(true)
      expect(lock.owner.pid).toBe(process.pid)
      expect(lock.owner.host).toBe(hostname())
      expect(lock.owner.nonce).toMatch(/[0-9a-f-]{36}/)
    } finally {
      lock.release()
    }
  })

  it('refuses a second acquisition while the first is held', () => {
    const configDir = makeConfigDir()
    const first = acquireDaemonLock(configDir)

    try {
      expect(() => acquireDaemonLock(configDir)).toThrow(DaemonLockedError)
      expect(() => acquireDaemonLock(configDir)).toThrow(/already running/)
    } finally {
      first.release()
    }
  })

  it('allows acquisition again after release', () => {
    const configDir = makeConfigDir()
    acquireDaemonLock(configDir).release()

    const second = acquireDaemonLock(configDir)
    expect(second.owner.pid).toBe(process.pid)
    second.release()
  })

  it('removes the lock file on release', () => {
    const configDir = makeConfigDir()
    const lock = acquireDaemonLock(configDir)
    lock.release()

    expect(existsSync(lock.path)).toBe(false)
  })

  it('reclaims a lock whose owning process is gone', () => {
    const configDir = makeConfigDir()
    // Pid 0 is never a real user process, so liveness detection must reject it.
    writeLock(configDir, { pid: 0, nonce: 'dead-owner' })

    const lock = acquireDaemonLock(configDir)
    expect(lock.owner.nonce).not.toBe('dead-owner')
    lock.release()
  })

  it('reclaims a lock whose heartbeat has expired', () => {
    const configDir = makeConfigDir()
    writeLock(configDir, {
      nonce: 'expired-owner',
      heartbeatAt: new Date(Date.now() - STALE_LOCK_MS - 5_000).toISOString(),
      pid: 0,
    })

    const lock = acquireDaemonLock(configDir)
    expect(lock.owner.nonce).not.toBe('expired-owner')
    lock.release()
  })

  it('reclaims a lock from another host once its heartbeat expires', () => {
    const configDir = makeConfigDir()
    // A remote pid says nothing about liveness here, so only the heartbeat can.
    writeLock(configDir, {
      nonce: 'remote-owner',
      host: 'some-other-machine',
      pid: process.pid,
      heartbeatAt: new Date(Date.now() - STALE_LOCK_MS - 5_000).toISOString(),
    })

    const lock = acquireDaemonLock(configDir)
    expect(lock.owner.host).toBe(hostname())
    lock.release()
  })

  it('respects a fresh lock from another host', () => {
    const configDir = makeConfigDir()
    writeLock(configDir, {
      nonce: 'remote-owner',
      host: 'some-other-machine',
      heartbeatAt: new Date().toISOString(),
    })

    expect(() => acquireDaemonLock(configDir)).toThrow(DaemonLockedError)
  })

  it('treats an unparseable lock as debris', () => {
    const configDir = makeConfigDir()
    writeFileSync(getDaemonLockPath(configDir), 'not json at all')

    const lock = acquireDaemonLock(configDir)
    expect(lock.owner.pid).toBe(process.pid)
    lock.release()
  })

  it('advances the heartbeat without changing the owner', () => {
    const configDir = makeConfigDir()
    const lock = acquireDaemonLock(configDir)

    try {
      const before = JSON.parse(readFileSync(lock.path, 'utf8')) as LockOwner
      lock.heartbeat()
      const after = JSON.parse(readFileSync(lock.path, 'utf8')) as LockOwner

      expect(after.nonce).toBe(before.nonce)
      expect(Date.parse(after.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(before.heartbeatAt))
    } finally {
      lock.release()
    }
  })

  it('does not delete a lock that a later owner took over', () => {
    const configDir = makeConfigDir()
    const lock = acquireDaemonLock(configDir)

    // Simulate a stale reclaim handing the lock to a different run.
    writeLock(configDir, { nonce: 'someone-else' })
    lock.release()

    expect(existsSync(lock.path)).toBe(true)
    const survivor = JSON.parse(readFileSync(lock.path, 'utf8')) as LockOwner
    expect(survivor.nonce).toBe('someone-else')
  })

  it('is exclusive under repeated contention', () => {
    const configDir = makeConfigDir()
    const held = acquireDaemonLock(configDir)

    try {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        expect(() => acquireDaemonLock(configDir)).toThrow(DaemonLockedError)
      }
    } finally {
      held.release()
    }
  })
})
