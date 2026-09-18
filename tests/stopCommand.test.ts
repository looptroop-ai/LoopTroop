import { describe, it, expect, afterEach } from 'vitest'
import { readProcessStartToken } from '../server/lib/processIdentity'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { readRunningDaemon, stopRunningDaemon, type StopBudgets } from '../server/cli/commands'
import { getDaemonLockPath, getDaemonStatePath, readDaemonState, readDaemonStartFailure, writeDaemonStartFailure, writeDaemonState, type DaemonState } from '../server/lib/daemonPaths'
import { removeTempDir } from '../server/test/tempDir'

/**
 * 2.7 contract: `stop` asks the daemon over HTTP, escalates only when that
 * request was not accepted, and every fallback rung is bounded. An accepted
 * request that cannot prove owned cleanup retains the retry boundary.
 */
describe('stopping a running daemon', () => {
  const tempDirs: string[] = []
  const servers: Server[] = []
  const children: ChildProcess[] = []

  afterEach(async () => {
    for (const child of children.splice(0)) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    for (const server of servers.splice(0)) {
      await new Promise<void>((done) => server.close(() => done()))
    }
    for (const dir of tempDirs.splice(0)) {
      removeTempDir(dir)
    }
  })

  /** Short enough that the escalation ladder is exercised in milliseconds. */
  const FAST_BUDGETS: StopBudgets = { gracefulMs: 400, signalMs: 400, forceMs: 5_000 }

  function makeConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-stop-'))
    tempDirs.push(dir)
    return dir
  }

  /**
   * A process that outlives the call, standing in for the daemon. Detached so it
   * leads its own process group, exactly as the real one does.
   */
  function spawnStandIn(ignoresSigterm: boolean): number {
    const script = ignoresSigterm
      ? 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'
      : 'setInterval(() => {}, 1000)'
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' })
    child.unref()
    children.push(child)
    return child.pid ?? 0
  }

  interface FakeDaemon {
    port: number
    /** Counts accepted shutdown requests, so the HTTP rung can be proven first. */
    shutdownRequests: number
  }

  async function startFakeDaemon(options: {
    instanceId: string
    apiToken: string
    includeInstanceId?: boolean
    onShutdown?: () => void
  }): Promise<FakeDaemon> {
    const fake: FakeDaemon = { port: 0, shutdownRequests: 0 }

    const server = createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          status: 'ok',
          ...(options.includeInstanceId === false ? {} : { instanceId: options.instanceId }),
        }))
        return
      }

      if (req.url === '/api/daemon/shutdown' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${options.apiToken}`) {
          res.writeHead(401).end('{}')
          return
        }
        fake.shutdownRequests += 1
        res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"ok":true}')
        options.onShutdown?.()
        return
      }

      res.writeHead(404).end()
    })
    servers.push(server)

    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    fake.port = (server.address() as { port: number }).port
    return fake
  }

  function makeState(overrides: Partial<DaemonState> & { pid: number; port: number }): DaemonState {
    return {
      instanceId: 'instance-under-test',
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
      version: '0.0.0-test',
      apiToken: 'test-api-token',
      ...overrides,
    }
  }

  it('stops a cooperative daemon over HTTP without signalling it', async () => {
    const pid = spawnStandIn(false)
    const fake = await startFakeDaemon({
      instanceId: 'instance-under-test',
      apiToken: 'test-api-token',
      // What the real daemon does with the request: shut itself down.
      onShutdown: () => { process.kill(pid, 'SIGKILL') },
    })

    const outcome = await stopRunningDaemon(makeState({ pid, port: fake.port }), { budgets: FAST_BUDGETS })

    expect(outcome).toEqual({ kind: 'stopped', forced: false })
    expect(fake.shutdownRequests).toBe(1)
  })

  it('retains ownership when a daemon accepts shutdown but does not finish', async () => {
    const configDir = makeConfigDir()
    const pid = spawnStandIn(true)
    const startToken = readProcessStartToken(pid)
    expect(startToken).not.toBeNull()
    const fake = await startFakeDaemon({ instanceId: 'instance-under-test', apiToken: 'test-api-token' })
    writeLock(configDir, pid)
    writeFileSync(getDaemonStatePath(configDir), JSON.stringify(makeState({
      pid,
      port: fake.port,
      startToken: startToken ?? undefined,
    })))

    const outcome = await stopRunningDaemon(
      makeState({ pid, port: fake.port, startToken: startToken ?? undefined }),
      { configDir, budgets: FAST_BUDGETS },
    )

    expect(outcome).toEqual({ kind: 'incomplete', pid })
    expect(isAlive(pid)).toBe(true)
    // The daemon may still be draining an owned OpenCode tree. Its lock and
    // state remain the authenticated retry boundary rather than being cleared
    // under a surviving process.
    expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
    expect(existsSync(getDaemonStatePath(configDir))).toBe(true)
  })

  it('never force-kills a generation whose runtime close is already pending', async () => {
    const configDir = makeConfigDir()
    const pid = spawnStandIn(true)
    const startToken = readProcessStartToken(pid)
    expect(startToken).not.toBeNull()
    const fake = await startFakeDaemon({ instanceId: 'instance-under-test', apiToken: 'test-api-token' })
    writeLock(configDir, pid)
    writeFileSync(getDaemonStatePath(configDir), JSON.stringify(makeState({
      pid,
      port: fake.port,
      startToken: startToken ?? undefined,
      shutdownPending: true,
    })))

    const outcome = await stopRunningDaemon(
      makeState({ pid, port: fake.port, startToken: startToken ?? undefined, shutdownPending: true }),
      { configDir, budgets: FAST_BUDGETS },
    )

    expect(outcome).toEqual({ kind: 'incomplete', pid, context: 'shutdown-pending' })
    expect(isAlive(pid)).toBe(true)
    expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
    expect(existsSync(getDaemonStatePath(configDir))).toBe(true)
  })

  it('refreshes shutdown-pending state before any force escalation', async () => {
    const configDir = makeConfigDir()
    const pid = spawnStandIn(true)
    const startToken = readProcessStartToken(pid)
    expect(startToken).not.toBeNull()
    const fake = await startFakeDaemon({
      instanceId: 'instance-under-test',
      apiToken: 'test-api-token',
      onShutdown: () => {
        writeDaemonState(makeState({
          pid,
          port: fake.port,
          startToken: startToken ?? undefined,
          shutdownPending: true,
        }), configDir)
      },
    })
    writeLock(configDir, pid)
    const state = makeState({ pid, port: fake.port, startToken: startToken ?? undefined })
    writeDaemonState(state, configDir)

    const outcome = await stopRunningDaemon(state, { configDir, budgets: FAST_BUDGETS })

    expect(outcome).toEqual({ kind: 'incomplete', pid, context: 'shutdown-pending' })
    // Windows force escalation may race the leader's exit; the retained
    // lock/state, not a momentary liveness observation, is the retry boundary.
    if (process.platform !== 'win32') expect(isAlive(pid)).toBe(true)
    expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
    expect(existsSync(getDaemonStatePath(configDir))).toBe(true)
  })

  it('refreshes shutdown-pending state immediately before force escalation', async () => {
    const configDir = makeConfigDir()
    const pid = spawnStandIn(true)
    const startToken = readProcessStartToken(pid)
    expect(startToken).not.toBeNull()
    writeLock(configDir, pid)
    const state = makeState({ pid, port: 1, startToken: startToken ?? undefined })
    writeDaemonState(state, configDir)
    // Let the stand-in install its SIGTERM handler before the escalation
    // begins; otherwise the test could observe ordinary startup timing rather
    // than the final pending-state refresh.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const pendingState = makeState({ pid, port: 1, shutdownPending: true })
    const pendingTimer = setTimeout(() => writeDaemonState(pendingState, configDir), 50)
    pendingTimer.unref()

    const outcome = await stopRunningDaemon(state, { configDir, budgets: FAST_BUDGETS })

    expect(outcome).toEqual({ kind: 'incomplete', pid, context: 'shutdown-pending' })
    // The Windows taskkill tree may finish before this assertion or just after
    // it. POSIX keeps the stronger leader-liveness check.
    if (process.platform !== 'win32') expect(isAlive(pid)).toBe(true)
    expect(readDaemonState(configDir)?.shutdownPending).toBe(true)
    expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
  })

  it('retries a retained startup owner using its recorded identity', async () => {
    const configDir = makeConfigDir()
    const previous = process.env.LOOPTROOP_CONFIG_DIR
    process.env.LOOPTROOP_CONFIG_DIR = configDir
    const pid = spawnStandIn(false)
    const startToken = readProcessStartToken(pid)
    expect(startToken).not.toBeNull()
    writeDaemonStartFailure({
      reason: 'startup-cleanup-incomplete',
      at: '2026-01-02T03:04:05.000Z',
      version: '0.0.0-test',
      message: 'OpenCode did not stop during startup cleanup.',
      openCode: {
        baseUrl: 'http://127.0.0.1:4096',
        pid,
        startToken: startToken ?? undefined,
      },
    }, configDir)

    try {
      const { stopCommand } = await import('../server/cli/commands')
      expect(await stopCommand()).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
      else process.env.LOOPTROOP_CONFIG_DIR = previous
    }

    expect(isAlive(pid)).toBe(false)
    expect(readDaemonStartFailure(configDir)).toBeNull()
    expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
  })

  it('does not stop an unreachable daemon whose identity was not recorded', async () => {
    const pid = spawnStandIn(false)
    // Port 1 is reserved and nothing answers there. Without a start token the
    // live pid is unverifiable, so every destructive rung must refuse it.
    const outcome = await stopRunningDaemon(makeState({ pid, port: 1 }), { budgets: FAST_BUDGETS })

    expect(outcome.kind).toBe('not-ours')
    expect(isAlive(pid)).toBe(true)
  })

  it('leaves a lock belonging to another daemon alone', async () => {
    const configDir = makeConfigDir()
    const pid = spawnStandIn(true)
    const fake = await startFakeDaemon({ instanceId: 'instance-under-test', apiToken: 'test-api-token' })
    // A daemon that started while this one was being killed.
    writeLock(configDir, process.pid)
    writeFileSync(getDaemonStatePath(configDir), JSON.stringify(makeState({
      pid: process.pid,
      port: fake.port,
      instanceId: 'a-different-instance',
    })))

    await stopRunningDaemon(makeState({ pid, port: fake.port }), { configDir, budgets: FAST_BUDGETS })

    expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
    expect(existsSync(getDaemonStatePath(configDir))).toBe(true)
  })

  it('refuses to act on a state file the running daemon does not confirm', async () => {
    const configDir = makeConfigDir()
    const pid = spawnStandIn(false)
    // A recycled pid: something is alive and answering, but it is not the
    // daemon this state file describes.
    const fake = await startFakeDaemon({ instanceId: 'some-other-daemon', apiToken: 'test-api-token' })
    writeFileSync(getDaemonStatePath(configDir), JSON.stringify(makeState({ pid, port: fake.port })))

    expect(await readRunningDaemon(configDir)).toBeNull()
    expect(isAlive(pid)).toBe(true)
  })

  it('accepts a state file the running daemon confirms', async () => {
    const configDir = makeConfigDir()
    const pid = spawnStandIn(false)
    const fake = await startFakeDaemon({ instanceId: 'instance-under-test', apiToken: 'test-api-token' })
    writeFileSync(getDaemonStatePath(configDir), JSON.stringify(makeState({ pid, port: fake.port })))

    expect(await readRunningDaemon(configDir)).toMatchObject({ pid, instanceId: 'instance-under-test' })
  })

  it('does not adopt a successful health response without the recorded instance id', async () => {
    const configDir = makeConfigDir()
    const pid = spawnStandIn(false)
    const fake = await startFakeDaemon({
      instanceId: 'instance-under-test',
      apiToken: 'test-api-token',
      includeInstanceId: false,
    })
    writeFileSync(getDaemonStatePath(configDir), JSON.stringify(makeState({ pid, port: fake.port })))

    expect(await readRunningDaemon(configDir)).toBeNull()
    expect(isAlive(pid)).toBe(true)
  })

  /**
   * 2.16 contract: `stop` clears debris so the next start is not blocked, but
   * `stop` is also what someone runs right after a start that did not take.
   * Clearing the recorded reason at that moment would leave them nothing to read.
   */
  it('keeps a recorded start failure while clearing the rest', async () => {
    const configDir = makeConfigDir()
    const previous = process.env.LOOPTROOP_CONFIG_DIR
    process.env.LOOPTROOP_CONFIG_DIR = configDir
    // Debris from a daemon that died without cleaning up after itself. Pid 0 is
    // never a real process, so nothing can be holding this.
    writeLock(configDir, 0)
    const { writeDaemonStartFailure, readDaemonStartFailure } = await import('../server/lib/daemonPaths')
    writeDaemonStartFailure({
      reason: 'schema-incompatible',
      at: '2026-01-02T03:04:05.000Z',
      version: '0.0.0-test',
      message: 'The app database was created by a newer version of LoopTroop.',
      schema: {
        databaseLabel: 'app database',
        databasePath: join(configDir, 'app.sqlite'),
        found: 99,
        expected: 1,
        migratableFrom: 1,
      },
    }, configDir)

    const { stopCommand } = await import('../server/cli/commands')
    const written: string[] = []
    const restore = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true }) as typeof process.stdout.write

    try {
      expect(await stopCommand()).toBe(0)
    } finally {
      process.stdout.write = restore
      if (previous === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
      else process.env.LOOPTROOP_CONFIG_DIR = previous
    }

    expect(written.join('')).toContain('not running')
    // The lock still blocks the next start; the diagnosis does not.
    expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
    const failure = readDaemonStartFailure(configDir)
    expect(failure?.reason).toBe('schema-incompatible')
    if (failure?.reason === 'schema-incompatible') expect(failure.schema.found).toBe(99)
  })

  /**
   * The escalation spans tens of seconds, and the daemon stops answering
   * partway through by design. A pid released in that window can be reissued
   * before the next rung runs, so identity is rechecked rather than assumed.
   */
  it('does not signal a pid that is no longer the daemon', async () => {
    const pid = spawnStandIn(true)
    // Nothing answers on port 1, so the graceful rung fails and the escalation
    // reaches the identity check with a live pid and a token that cannot match.
    const outcome = await stopRunningDaemon(
      makeState({ pid, port: 1, startToken: 'f'.repeat(32) }),
      { budgets: FAST_BUDGETS },
    )

    expect(outcome.kind).toBe('not-ours')
    expect(isAlive(pid)).toBe(true)
  })

  /**
   * "Not answering" is not "not running". A daemon still opening its database,
   * or wedged, or listening somewhere its state file no longer describes, holds
   * the lock and is alive — and removing it would let the next start run a
   * second daemon on the same databases.
   */
  it('leaves the lock of a live process that is not answering', async () => {
    const configDir = makeConfigDir()
    const previous = process.env.LOOPTROOP_CONFIG_DIR
    process.env.LOOPTROOP_CONFIG_DIR = configDir
    const pid = spawnStandIn(false)
    writeLock(configDir, pid)

    const { stopCommand } = await import('../server/cli/commands')
    const written: string[] = []
    const restore = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true }) as typeof process.stderr.write

    try {
      expect(await stopCommand()).toBe(1)
    } finally {
      process.stderr.write = restore
      if (previous === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
      else process.env.LOOPTROOP_CONFIG_DIR = previous
    }

    expect(written.join('')).toContain(String(pid))
    expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
  })

  /**
   * The health probe answering "no" is not the daemon answering "I am gone".
   *
   * `readRunningDaemon` collapses an unreachable daemon and an absent one into
   * the same `null`, and `stop` used to act on that by clearing the state file
   * before it had looked at the lock. The state file holds the only copy of the
   * daemon's API token, so a two-second blip on a loaded machine cost the CLI
   * the credential it needs to ask that daemon to stop — permanently, since
   * every later `stop` took the same branch. `clean` then found no record,
   * reported nothing running, and was free to delete worktrees in use.
   *
   * All three cases below run against a port nobody is listening on, so the
   * probe fails in microseconds rather than waiting out its budget.
   */
  describe('a daemon that is alive but not answering', () => {
    /** Nothing listens here, so the health probe is refused rather than slow. */
    const DEAD_PORT = 1

    async function runStopCommand(configDir: string): Promise<{ code: number; output: string }> {
      const previous = process.env.LOOPTROOP_CONFIG_DIR
      process.env.LOOPTROOP_CONFIG_DIR = configDir
      const written: string[] = []
      const restoreOut = process.stdout.write.bind(process.stdout)
      const restoreErr = process.stderr.write.bind(process.stderr)
      const capture = ((chunk: string) => { written.push(String(chunk)); return true })

      process.stdout.write = capture as typeof process.stdout.write
      process.stderr.write = capture as typeof process.stderr.write
      try {
        const { stopCommand } = await import('../server/cli/commands')
        return { code: await stopCommand(), output: written.join('') }
      } finally {
        process.stdout.write = restoreOut
        process.stderr.write = restoreErr
        if (previous === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
        else process.env.LOOPTROOP_CONFIG_DIR = previous
      }
    }

    it('stops it when the recorded start token still matches the pid', async () => {
      const configDir = makeConfigDir()
      const pid = spawnStandIn(false)
      // The real token for this real process, so identity is proven without the
      // HTTP round trip the daemon is failing to serve.
      const startToken = readProcessStartToken(pid)
      expect(startToken).not.toBeNull()

      writeFileSync(getDaemonStatePath(configDir), JSON.stringify(
        makeState({ pid, port: DEAD_PORT, startToken: startToken ?? undefined }),
      ))
      writeLock(configDir, pid)

      const { code } = await runStopCommand(configDir)

      expect(code).toBe(0)
      expect(isAlive(pid)).toBe(false)
      // Removed because the stop finished, not because debris cleanup ran: a
      // successful escalation clears both, scoped to this daemon's identity.
      expect(existsSync(getDaemonStatePath(configDir))).toBe(false)
      expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
    })

    it('leaves an unverifiable process and its records completely alone', async () => {
      const configDir = makeConfigDir()
      const pid = spawnStandIn(false)
      // No start token: the record cannot prove this pid was not recycled, so
      // the process must not be signalled and its records must not be deleted.
      writeFileSync(getDaemonStatePath(configDir), JSON.stringify(makeState({ pid, port: DEAD_PORT })))
      writeLock(configDir, pid)

      const { code, output } = await runStopCommand(configDir)

      expect(code).toBe(1)
      expect(isAlive(pid)).toBe(true)
      expect(output).toContain(String(pid))
      // The whole point: the token survives, so `stop` can still work once the
      // daemon answers again, and `clean` still refuses.
      expect(existsSync(getDaemonStatePath(configDir))).toBe(true)
      expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
    })

    it('never signals a pid whose recorded token cannot match', async () => {
      const configDir = makeConfigDir()
      const pid = spawnStandIn(true)
      // A token that is present and wrong: the pid was recycled, so whatever
      // holds the number now belongs to somebody else.
      writeFileSync(getDaemonStatePath(configDir), JSON.stringify(
        makeState({ pid, port: DEAD_PORT, startToken: 'f'.repeat(32) }),
      ))

      const { code } = await runStopCommand(configDir)

      expect(code).toBe(0)
      expect(isAlive(pid)).toBe(true)
    })
  })

  function writeLock(configDir: string, pid: number): void {
    writeFileSync(getDaemonLockPath(configDir), JSON.stringify({
      nonce: 'lock-nonce',
      pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }))
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
})
