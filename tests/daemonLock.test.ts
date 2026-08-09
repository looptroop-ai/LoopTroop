import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import {
  acquireDaemonLock,
  clearLockOwnedBy,
  DaemonLockedError,
  STALE_LOCK_MS,
  type LockOwner,
} from '../server/lib/daemonLock'
import { getDaemonLockPath } from '../server/lib/daemonPaths'
import { readProcessStartToken } from '../server/lib/processIdentity'

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

  /**
   * A pid is not an identity, and a quiet heartbeat is not a death. These cover
   * the two ways the heartbeat alone gets the answer wrong: a live daemon whose
   * timers fell behind, and a dead one whose pid was handed to someone else.
   */
  describe('owner identity', () => {
    // How this process would be recorded. Null on a platform that cannot report
    // process start times, where the heartbeat fallback is the documented
    // behaviour rather than a failure — so each test states both outcomes.
    const localToken = readProcessStartToken(process.pid)
    const tokenFields = localToken === null ? {} : { startToken: localToken }

    it('records the identity of the process that took the lock', () => {
      const configDir = makeConfigDir()
      const lock = acquireDaemonLock(configDir)

      try {
        expect(lock.owner.startToken).toBe(localToken ?? undefined)
        const onDisk = JSON.parse(readFileSync(lock.path, 'utf8')) as LockOwner
        expect(onDisk.startToken).toBe(localToken ?? undefined)
      } finally {
        lock.release()
      }
    })

    it('keeps the lock of a live owner whose heartbeat fell behind', () => {
      const configDir = makeConfigDir()
      // A laptop that slept for an hour resumes with every timer behind, so a
      // perfectly alive daemon looks quiet. Reclaiming on that basis hands a
      // second daemon the same databases and worktrees.
      writeLock(configDir, {
        nonce: 'sleeping-owner',
        pid: process.pid,
        ...tokenFields,
        heartbeatAt: new Date(Date.now() - STALE_LOCK_MS - 3_600_000).toISOString(),
      })

      if (localToken === null) {
        // Nothing can confirm the owner here, so the heartbeat still decides.
        acquireDaemonLock(configDir).release()
        return
      }
      expect(() => acquireDaemonLock(configDir)).toThrow(DaemonLockedError)
    })

    it('reclaims a recycled pid without waiting out the heartbeat window', () => {
      const configDir = makeConfigDir()
      // Fresh heartbeat, live pid, wrong process. The original owner is gone,
      // so waiting the full stale window would strand the lock for no reason.
      writeLock(configDir, {
        nonce: 'recycled-pid',
        pid: process.pid,
        startToken: 'f'.repeat(32),
        heartbeatAt: new Date().toISOString(),
      })

      if (localToken === null) {
        // The token cannot be compared, so this is indistinguishable from a
        // live owner and the fresh heartbeat protects it.
        expect(() => acquireDaemonLock(configDir)).toThrow(DaemonLockedError)
        return
      }
      const lock = acquireDaemonLock(configDir)
      expect(lock.owner.nonce).not.toBe('recycled-pid')
      lock.release()
    })

    it('falls back to the heartbeat for a lock that records no identity', () => {
      const configDir = makeConfigDir()
      // Written by a build from before start tokens existed: neither confirmed
      // nor refuted, so it is judged the way it was when it was written.
      writeLock(configDir, { nonce: 'legacy-owner', pid: process.pid })
      expect(() => acquireDaemonLock(configDir)).toThrow(DaemonLockedError)

      writeLock(configDir, {
        nonce: 'legacy-owner',
        pid: process.pid,
        heartbeatAt: new Date(Date.now() - STALE_LOCK_MS - 5_000).toISOString(),
      })
      const lock = acquireDaemonLock(configDir)
      expect(lock.owner.nonce).not.toBe('legacy-owner')
      lock.release()
    })
  })

  /**
   * Everything a suspended daemon does after its lock was reclaimed. It has no
   * way to know, so each write it attempts has to be inert.
   */
  describe('after a reclaim', () => {
    it('ignores a heartbeat from an owner whose lock was taken over', () => {
      const configDir = makeConfigDir()
      const lock = acquireDaemonLock(configDir)
      writeLock(configDir, { nonce: 'new-owner', pid: 4242 })

      lock.heartbeat()

      const current = JSON.parse(readFileSync(lock.path, 'utf8')) as LockOwner
      expect(current.nonce).toBe('new-owner')
      expect(current.pid).toBe(4242)
    })

    it('leaves the record parseable when a heartbeat shortens the file', () => {
      const configDir = makeConfigDir()
      const lock = acquireDaemonLock(configDir)

      try {
        // Trailing bytes from a longer previous write. Without truncation the
        // rewrite keeps the tail and every later read fails to parse.
        writeFileSync(lock.path, `${readFileSync(lock.path, 'utf8')}${' '.repeat(512)}`)
        lock.heartbeat()

        const encoded = readFileSync(lock.path, 'utf8')
        expect(encoded).toBe(encoded.trimEnd() + '\n')
        expect((JSON.parse(encoded) as LockOwner).nonce).toBe(lock.owner.nonce)
      } finally {
        lock.release()
      }
    })

    it('leaves no quarantine files behind when it reclaims', () => {
      const configDir = makeConfigDir()
      writeLock(configDir, { pid: 0, nonce: 'dead-owner' })

      const lock = acquireDaemonLock(configDir)
      try {
        const strays = readdirSync(dirname(lock.path)).filter((entry) => entry.includes('.reclaim-'))
        expect(strays).toEqual([])
      } finally {
        lock.release()
      }
    })
  })

  /**
   * `stop` clears the lock of a daemon it had to kill. Scoped to that one daemon
   * so it cannot remove the lock of a different one that started meanwhile.
   */
  describe('clearLockOwnedBy', () => {
    it('removes a lock whose owner is gone', () => {
      const configDir = makeConfigDir()
      writeLock(configDir, { nonce: 'killed-owner', pid: 0 })

      clearLockOwnedBy(0, configDir)
      expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
    })

    it('keeps the lock of a daemon that is still running', () => {
      const configDir = makeConfigDir()
      const lock = acquireDaemonLock(configDir)

      try {
        clearLockOwnedBy(process.pid, configDir)
        // Either the identity matched or it could not be checked; a live pid
        // under its own lock is never debris.
        expect(existsSync(lock.path)).toBe(true)
      } finally {
        lock.release()
      }
    })

    it('keeps a lock belonging to a different pid', () => {
      const configDir = makeConfigDir()
      writeLock(configDir, { nonce: 'other-daemon', pid: 4242 })

      clearLockOwnedBy(process.pid, configDir)
      expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
    })

    it('keeps a lock belonging to another host', () => {
      const configDir = makeConfigDir()
      writeLock(configDir, { nonce: 'remote-owner', pid: 0, host: 'some-other-machine' })

      clearLockOwnedBy(0, configDir)
      expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
    })
  })
})
