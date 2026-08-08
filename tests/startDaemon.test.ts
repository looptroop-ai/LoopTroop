import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { startDaemon, type DaemonHandle } from '../server/daemon/startDaemon'
import { getDaemonLockPath, getDaemonStatePath, type DaemonState } from '../server/lib/daemonPaths'
import { resolveSettings } from '../server/lib/appSettings'

/**
 * 2.7 contract: the daemon reports ready only once it is genuinely serving, and
 * a failed start leaves nothing behind. A supervisor that trusted a premature
 * ready would report success for a daemon that never bound a port.
 */
describe('daemon startup and shutdown', () => {
  const tempDirs: string[] = []
  const running: DaemonHandle[] = []

  afterEach(async () => {
    for (const handle of running.splice(0)) await handle.stop()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-daemon-'))
    tempDirs.push(dir)
    return dir
  }

  function ephemeralSettings() {
    // Port 0 keeps concurrent test files from colliding on a fixed port, and
    // mock mode keeps the supervisor from spawning a real `opencode serve`.
    return {
      ...resolveSettings({ env: {}, file: {} }),
      port: 0,
      portIsExplicit: false,
      opencodeMode: 'mock' as const,
    }
  }

  async function start(configDir: string, onReady?: (state: DaemonState) => void) {
    const handle = await startDaemon({
      configDir,
      settings: ephemeralSettings(),
      version: '0.0.0-test',
      ...(onReady ? { onReady } : {}),
    })
    running.push(handle)
    return handle
  }

  it('serves requests by the time it reports ready', async () => {
    const configDir = makeConfigDir()
    let readyState: DaemonState | null = null

    const handle = await start(configDir, (state) => { readyState = state })

    expect(readyState).not.toBeNull()
    // Health is the one unauthenticated route, and it names the instance so a
    // client can tell this daemon from a process that inherited its pid.
    const response = await fetch(`http://${handle.state.host}:${handle.state.port}/api/health`)
    expect(response.ok).toBe(true)
    expect(await response.json()).toMatchObject({ instanceId: handle.state.instanceId })
  })

  it('writes a state file describing the live daemon', async () => {
    const configDir = makeConfigDir()
    const handle = await start(configDir)

    const state = JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8')) as DaemonState
    expect(state.pid).toBe(process.pid)
    expect(state.port).toBe(handle.state.port)
    expect(state.instanceId).toBe(handle.state.instanceId)
    expect(state.version).toBe('0.0.0-test')
  })

  it('holds the lock while running', async () => {
    const configDir = makeConfigDir()
    await start(configDir)

    expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
  })

  it('refuses a second daemon in the same config directory', async () => {
    const configDir = makeConfigDir()
    await start(configDir)

    await expect(start(configDir)).rejects.toThrow(/already running/)
  })

  it('releases the lock and removes state on stop', async () => {
    const configDir = makeConfigDir()
    const handle = await start(configDir)

    await handle.stop()

    expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
    expect(existsSync(getDaemonStatePath(configDir))).toBe(false)
  })

  it('is safe to stop twice', async () => {
    const configDir = makeConfigDir()
    const handle = await start(configDir)

    await handle.stop()
    await expect(handle.stop()).resolves.toBeUndefined()
  })

  it('leaves no lock behind when the port cannot be bound', async () => {
    const configDir = makeConfigDir()
    const { createServer } = await import('node:net')
    const blocker = createServer()
    await new Promise<void>((ready) => blocker.listen(0, '127.0.0.1', ready))
    const taken = (blocker.address() as { port: number }).port

    try {
      await expect(startDaemon({
        configDir,
        settings: { ...ephemeralSettings(), port: taken, portIsExplicit: true },
        version: '0.0.0-test',
      })).rejects.toThrow(/already in use/)

      // A lock or state file left here would block every later start.
      expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
      expect(existsSync(getDaemonStatePath(configDir))).toBe(false)
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()))
    }
  })

  it('allows a fresh daemon after a previous one stopped', async () => {
    const configDir = makeConfigDir()
    const first = await start(configDir)
    await first.stop()

    const second = await start(configDir)
    expect(second.state.instanceId).not.toBe(first.state.instanceId)
  })

  it('keeps the state file owner-only because it carries the API token', async () => {
    const configDir = makeConfigDir()
    await start(configDir)

    const state = JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8')) as DaemonState
    expect(state.apiToken).toEqual(expect.any(String))

    // Windows has no POSIX mode bits; the ACL there already restricts the user
    // profile directory the config lives in.
    if (process.platform !== 'win32') {
      expect(statSync(getDaemonStatePath(configDir)).mode & 0o777).toBe(0o600)
    }
  })

  it('persists a token that authenticates a CLI which did not start the daemon', async () => {
    const configDir = makeConfigDir()
    const handle = await start(configDir)
    const origin = `http://${handle.state.host}:${handle.state.port}`

    // Exactly what `looptroop open` does: read the state file, mint a nonce with
    // the token in it, and hand the resulting URL to a browser.
    const state = JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8')) as DaemonState
    const minted = await fetch(`${origin}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.apiToken}` },
    })
    expect(minted.status).toBe(200)
    const { nonce } = await minted.json() as { nonce: string }

    const exchange = await fetch(`${origin}/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    })
    expect(exchange.status).toBe(200)
    expect(exchange.headers.get('Set-Cookie')).toContain('HttpOnly')
  })

  it('mints a fresh nonce for every bootstrap URL', async () => {
    const configDir = makeConfigDir()
    const handle = await start(configDir)

    // A URL that stayed constant would be a reusable secret; it must not be.
    expect(handle.bootstrapUrl()).not.toBe(handle.bootstrapUrl())
  })

  it('routes an authenticated shutdown request to the process that owns the exit', async () => {
    const configDir = makeConfigDir()
    const handle = await start(configDir)
    const reasons: string[] = []
    // Stands in for the daemon process, which turns this into process.exit.
    handle.onShutdownRequest((reason) => reasons.push(reason))

    const response = await fetch(`http://${handle.state.host}:${handle.state.port}/api/daemon/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${handle.credentials.apiToken}` },
    })

    expect(response.status).toBe(202)
    // The response comes back before anything closes, so the caller learns the
    // request was accepted rather than seeing its connection dropped.
    await vi.waitFor(() => { expect(reasons).toHaveLength(1) })
  })

  it('refuses to shut down for an unauthenticated caller', async () => {
    const configDir = makeConfigDir()
    const handle = await start(configDir)
    const origin = `http://${handle.state.host}:${handle.state.port}`
    handle.onShutdownRequest(() => { throw new Error('shutdown must not be reachable without a credential') })

    expect((await fetch(`${origin}/api/daemon/shutdown`, { method: 'POST' })).status).toBe(401)
    expect((await fetch(`${origin}/api/daemon/shutdown`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-the-token' },
    })).status).toBe(401)

    // Still serving: a rejected request must not have disturbed the daemon.
    expect((await fetch(`${origin}/api/health`)).ok).toBe(true)
  })

  it('closes the runtime itself when nothing is listening for the exit', async () => {
    const configDir = makeConfigDir()
    const handle = await start(configDir)
    const origin = `http://${handle.state.host}:${handle.state.port}`

    // An embedder installs no signal handlers, so the request would otherwise be
    // accepted and then quietly ignored.
    await fetch(`${origin}/api/daemon/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${handle.credentials.apiToken}` },
    })

    await vi.waitFor(async () => {
      await expect(fetch(`${origin}/api/health`)).rejects.toThrow()
    }, { timeout: 5_000 })
  })

  it('refuses a request whose Host header names a rebound domain', async () => {
    const configDir = makeConfigDir()
    const handle = await start(configDir)

    // node:http rather than fetch: the Host header is exactly what has to be
    // forged here, and fetch refuses to set it.
    const status = await new Promise<number>((done, fail) => {
      const req = httpRequest({
        host: handle.state.host,
        port: handle.state.port,
        path: '/api/health',
        headers: { Host: 'looptroop.attacker.example' },
      }, (res) => {
        res.resume()
        done(res.statusCode ?? 0)
      })
      req.on('error', fail)
      req.end()
    })

    expect(status).toBe(403)
  })
})
