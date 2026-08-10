import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  acquireDaemonLock,
  clearLockOwnedBy,
  DaemonLockedError,
  STALE_LOCK_MS,
  type LockOwner,
} from '../server/lib/daemonLock'
import { getDaemonLockPath } from '../server/lib/daemonPaths'
import { readProcessStartToken } from '../server/lib/processIdentity'

/** A URL because a Windows drive letter reads as a scheme to `import()`. */
const lockModule = pathToFileURL(resolve(import.meta.dirname, '../server/lib/daemonLock.ts')).href

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
        // Anything beside the lock itself: a claim, a staging file, a rename
        // waiting to be discarded. Each one is a marker for a step that did not
        // finish, and a stranded claim blocks the next reclaim for its full TTL.
        const strays = readdirSync(dirname(lock.path))
          .filter((entry) => entry.startsWith('daemon.lock.'))
        expect(strays).toEqual([])
      } finally {
        lock.release()
      }
    })
  })

  /**
   * The exclusion contract, tested the only way it can be: from several real
   * processes at once.
   *
   * Everything above runs in one process, where the interleavings that matter
   * cannot occur — the dangerous window is between two file operations, and a
   * single-threaded test never has anyone else running inside it. Three
   * contenders is the floor rather than an arbitrary number: the race this
   * covers needs one process to displace a lock, a second to take the path
   * while it is unoccupied, and a third whose write then lands on top.
   */
  describe('under real concurrency', () => {
    const CONTENDERS = 5

    /**
     * Starts every contender, waits for all of them to say they are ready, then
     * releases them at once by creating the barrier file they are spinning on.
     * Timing the collision by sleeping instead would race the process starts:
     * on a loaded runner the first child can finish before the last one has
     * loaded its modules, and the test then passes without ever colliding.
     *
     * A winner holds until every loser has reported, rather than for a fixed
     * moment. Five processes spinning on two cores can be descheduled for
     * longer than any interval worth hard-coding, and a contender that wakes
     * after the winner released finds the lock genuinely free and takes it —
     * two `held` lines from a lock that never failed to exclude anyone. Waiting
     * on the losers removes the clock from the assertion entirely.
     */
    async function race(configDir: string): Promise<string[]> {
      const barrier = join(configDir, 'go')
      const ready = join(configDir, 'ready')
      const done = join(configDir, 'done')

      const source = (index: number) => [
        `import { existsSync, readdirSync, writeFileSync } from 'node:fs'`,
        `import { acquireDaemonLock } from ${JSON.stringify(lockModule)}`,
        `const settled = () => readdirSync(${JSON.stringify(configDir)}).filter((e) => e.startsWith('done.')).length`,
        `writeFileSync(${JSON.stringify(ready)} + '.' + ${index}, '')`,
        `while (!existsSync(${JSON.stringify(barrier)})) {}`,
        `try {`,
        `  const lock = acquireDaemonLock(${JSON.stringify(configDir)})`,
        `  const from = Date.now()`,
        // Hold until every other contender has had its answer, so releasing can
        // never be what lets a second one through. Bounded, because a genuine
        // exclusion failure means the losers this waits for do not exist, and
        // that must surface as a failed assertion rather than a hung suite.
        `  const deadline = Date.now() + 20000`,
        `  while (settled() < ${CONTENDERS - 1} && Date.now() < deadline) {`,
        `    await new Promise((resolve) => setTimeout(resolve, 10))`,
        `  }`,
        // Whether every loser reported, or the clock ran out first. On the
        // deadline path the hold no longer proves anything: a contender still
        // descheduled when the lock came free finds it genuinely free, and its
        // `held` line is the harness starving rather than the lock failing.
        `  const waited = settled() < ${CONTENDERS - 1} ? 'deadline' : 'all-settled'`,
        `  lock.release()`,
        `  console.log('held ' + lock.owner.nonce + ' ' + from + ' ' + Date.now() + ' ' + waited)`,
        `} catch (error) {`,
        `  writeFileSync(${JSON.stringify(done)} + '.' + ${index}, '')`,
        `  console.log(error instanceof Error ? error.name : 'unknown')`,
        `}`,
      ].join('\n')

      const children = Array.from({ length: CONTENDERS }, (_, index) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--eval', source(index)], {
          cwd: resolve(import.meta.dirname, '..'),
        })
        let output = ''
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
        child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
        return new Promise<string>((done) => { child.on('close', () => { done(output.trim()) }) })
      })

      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const arrived = readdirSync(configDir).filter((entry) => entry.startsWith('ready.')).length
        if (arrived === CONTENDERS) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }

      writeFileSync(barrier, '')
      return Promise.all(children)
    }

    /**
     * The contract itself: never two holders at one moment.
     *
     * Counting `held` lines is a proxy for that, and only a sound one while
     * every loser is guaranteed to have tried before the winner let go — which
     * is what the hold above buys. Overlap is checked directly as well, so a
     * future change to the timing cannot quietly turn this into a test that
     * passes because the contenders never met.
     */
    function assertExclusive(results: string[]): void {
      // Every assertion here carries the children's own output. A count that
      // comes out wrong once in dozens of constrained runs is not something the
      // next reader can reproduce on demand, and `expected length 1` on its own
      // says nothing about which contender misbehaved or how — whether two
      // processes really overlapped, or one died before it could report and the
      // winner simply waited out its deadline.
      const transcript = `\ncontenders:\n${results.map((line) => `  ${line || '(no output)'}`).join('\n')}`

      const holds = results
        .filter((line) => line.startsWith('held'))
        .map((line) => {
          const [, , from, until] = line.split(' ')
          return { from: Number(from), until: Number(until) }
        })

      for (const a of holds) {
        for (const b of holds) {
          if (a === b) continue
          expect(a.from > b.until || a.until < b.from,
            `two processes held the lock at the same time${transcript}`).toBe(true)
        }
      }

      expect(holds, `expected exactly one holder${transcript}`).toHaveLength(1)
    }

    it('hands a free lock to exactly one of several simultaneous starts', async () => {
      const results = await race(makeConfigDir())

      assertExclusive(results)
      expect(results.filter((line) => line === 'DaemonLockedError')).toHaveLength(CONTENDERS - 1)
    }, 60_000)

    it('hands a crashed run\'s lock to exactly one of several simultaneous starts', async () => {
      const configDir = makeConfigDir()
      // The case the single-process tests cannot reach. Every contender judges
      // this lock abandoned at the same moment, so every one of them enters
      // stale recovery together — and recovery that ever leaves the canonical
      // path unoccupied lets a second contender take it and a third overwrite
      // what it wrote. Two daemons on one set of databases and worktrees.
      writeLock(configDir, {
        nonce: 'crashed-run',
        pid: 0,
        heartbeatAt: new Date(Date.now() - STALE_LOCK_MS - 600_000).toISOString(),
      })

      const results = await race(configDir)

      assertExclusive(results)
    }, 60_000)

    it('leaves no recovery debris behind after a contested reclaim', async () => {
      const configDir = makeConfigDir()
      writeLock(configDir, {
        nonce: 'crashed-run',
        pid: 0,
        heartbeatAt: new Date(Date.now() - STALE_LOCK_MS - 600_000).toISOString(),
      })

      await race(configDir)

      // A claim outliving the recovery it guarded is not cosmetic: the next
      // reclaim has to wait out its whole TTL before it may take it over.
      const strays = readdirSync(configDir).filter((entry) => entry.startsWith('daemon.lock.'))
      expect(strays).toEqual([])
    }, 60_000)
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
