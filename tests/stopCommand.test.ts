import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { readRunningDaemon, stopRunningDaemon, type StopBudgets } from '../server/cli/commands'
import { getDaemonLockPath, getDaemonStatePath, type DaemonState } from '../server/lib/daemonPaths'

/**
 * 2.7 contract: `stop` asks the daemon over HTTP, escalates only as far as it
 * must, and every rung is bounded. A daemon that ignores the request must still
 * end, and a daemon that never existed must never be signalled in its place.
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
      rmSync(dir, { recursive: true, force: true })
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
    onShutdown?: () => void
  }): Promise<FakeDaemon> {
    const fake: FakeDaemon = { port: 0, shutdownRequests: 0 }

    const server = createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', instanceId: options.instanceId }))
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

  it('kills a daemon that accepts the request and then ignores it', async () => {
    const configDir = makeConfigDir()
    const pid = spawnStandIn(true)
    const fake = await startFakeDaemon({ instanceId: 'instance-under-test', apiToken: 'test-api-token' })
    writeLock(configDir, pid)
    writeFileSync(getDaemonStatePath(configDir), JSON.stringify(makeState({ pid, port: fake.port })))

    const outcome = await stopRunningDaemon(
      makeState({ pid, port: fake.port }),
      { configDir, budgets: FAST_BUDGETS },
    )

    expect(outcome).toEqual({ kind: 'stopped', forced: true })
    expect(isAlive(pid)).toBe(false)
    // A killed daemon runs no cleanup of its own, so the next start would be
    // blocked for the full stale window if these were left behind.
    expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
    expect(existsSync(getDaemonStatePath(configDir))).toBe(false)
  })

  it('stops a daemon whose HTTP endpoint is unreachable', async () => {
    const pid = spawnStandIn(false)
    // Port 1 is reserved and nothing answers there, so every rung above the
    // signal must fail before the daemon is stopped.
    const outcome = await stopRunningDaemon(makeState({ pid, port: 1 }), { budgets: FAST_BUDGETS })

    expect(outcome.kind).toBe('stopped')
    expect(isAlive(pid)).toBe(false)
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
