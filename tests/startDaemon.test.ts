import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import {
  startDaemon,
  describeOpenCode,
  nextStateForOpenCode,
  type DaemonHandle,
} from '../server/daemon/startDaemon'
import { getDaemonLockPath, getDaemonStatePath, type DaemonState } from '../server/lib/daemonPaths'
import { resolveSettings } from '../server/lib/appSettings'
import { APP_SCHEMA_VERSION } from '../server/db/schemaVersion'
import { removeTempDir } from '../server/test/tempDir'

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
      removeTempDir(dir)
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

  /**
   * 2.16 contract: a database this build cannot open refuses the same start
   * every time, and the process that discovered it exits. The reason has to
   * outlive it, or the user is left with a non-zero exit and a log file nobody
   * told them to read.
   */
  describe('a start the schema guard refuses', () => {
    async function startAgainstNewerDatabase(configDir: string) {
      const dbPath = join(configDir, 'newer.sqlite')
      const { Database } = await import('../server/db/sqliteShim')
      const seed = new Database(dbPath)
      // A table as well as the marker: version 0 with no tables reads as a
      // brand-new file, which is the one case the guard lets through.
      seed.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY)')
      seed.pragma('user_version = 99')
      seed.close()

      // The app database path is read once at import time, so the module graph
      // has to be rebuilt after pointing it at the file above.
      process.env.LOOPTROOP_APP_DB_PATH = dbPath
      vi.resetModules()
      const { startDaemon: freshStartDaemon } = await import('../server/daemon/startDaemon')

      return {
        dbPath,
        run: () => freshStartDaemon({
          configDir,
          settings: ephemeralSettings(),
          version: '0.0.0-test',
        }),
      }
    }

    afterEach(() => {
      delete process.env.LOOPTROOP_APP_DB_PATH
      vi.resetModules()
    })

    it('records why the start was refused, with the numbers rather than prose', async () => {
      const configDir = makeConfigDir()
      const { dbPath, run } = await startAgainstNewerDatabase(configDir)

      await expect(run()).rejects.toThrow(/newer version of LoopTroop/)

      const { readDaemonStartFailure } = await import('../server/lib/daemonPaths')
      const failure = readDaemonStartFailure(configDir)
      expect(failure?.reason).toBe('schema-incompatible')
      expect(failure?.version).toBe('0.0.0-test')
      // Which database, what it reports, and what this build accepts — enough
      // for a later command to re-check without parsing the message.
      expect(failure?.schema).toMatchObject({
        databasePath: dbPath,
        found: 99,
        expected: APP_SCHEMA_VERSION,
      })
      expect(failure?.message).toContain(dbPath)
    })

    it('leaves no lock behind, so the fix can be tried immediately', async () => {
      const configDir = makeConfigDir()
      const { run } = await startAgainstNewerDatabase(configDir)

      await expect(run()).rejects.toThrow()

      expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
    })

    it('records no daemon anything could try to talk to', async () => {
      const configDir = makeConfigDir()
      const { run } = await startAgainstNewerDatabase(configDir)

      await expect(run()).rejects.toThrow()

      // `stop`, `status` and `open` all read this file; a refusal must never
      // read back as a running daemon.
      const { readDaemonState } = await import('../server/lib/daemonPaths')
      expect(readDaemonState(configDir)).toBeNull()
    })
  })

  /**
   * What the state file says about OpenCode, which is the only thing `status`,
   * `doctor` and `clean` have to go on once the daemon that wrote it is a pid.
   *
   * The record used to carry `owned` alone, so a supervisor that had given up
   * was written down as `{ owned: false }` — byte-identical to a healthy server
   * someone else started. `clean` read that and left nothing to reap, `status`
   * read it and reported a working daemon, and the one machine state anybody
   * would have wanted to see was the one the file could not express.
   */
  describe('OpenCode in the state file', () => {
    const baseUrl = 'http://127.0.0.1:4096'

    it('distinguishes a server it gave up on from one it never owned', () => {
      const degraded = describeOpenCode(
        { kind: 'degraded', baseUrl, reason: 'exited 3 times' },
        baseUrl,
      )
      const adopted = describeOpenCode({ kind: 'adopted', baseUrl }, baseUrl)

      expect(degraded).toMatchObject({ status: 'degraded', owned: false, detail: 'exited 3 times' })
      expect(adopted).toMatchObject({ status: 'adopted', owned: false })
      expect(degraded).not.toEqual(adopted)
    })

    it('marks a managed server owned, with the pid a reaper needs', () => {
      const managed = describeOpenCode({ kind: 'managed', baseUrl, pid: process.pid }, baseUrl)

      expect(managed).toMatchObject({ status: 'managed', owned: true, pid: process.pid })
    })

    it('says nothing at all in mock mode, where there is no server', () => {
      expect(describeOpenCode({ kind: 'mock' }, baseUrl)).toBeUndefined()
    })

    /**
     * The refresh path: OpenCode dies an hour in, or comes back under a new pid,
     * and the record written at startup is the only thing left describing it.
     */
    describe('refreshing the record after startup', () => {
      const recorded: DaemonState = {
        instanceId: 'i-1',
        pid: 999,
        port: 4317,
        host: '127.0.0.1',
        startedAt: '2026-01-01T00:00:00.000Z',
        version: '0.0.0-test',
        apiToken: 'secret',
        opencode: { baseUrl, owned: true, status: 'managed', pid: 111 },
      }

      it('moves the pid onto the server that is actually running', () => {
        const next = nextStateForOpenCode(
          recorded,
          { kind: 'managed', baseUrl, pid: 222 },
          baseUrl,
          { released: false },
        )

        // The old pid is dead by now, and could belong to anything; `clean`
        // signals what this file names.
        expect(next?.opencode).toMatchObject({ pid: 222, owned: true })
        // Everything else is carried through untouched, including the token the
        // CLI authenticates with.
        expect(next).toMatchObject({ instanceId: 'i-1', port: 4317, apiToken: 'secret' })
      })

      it('records giving up, where the file claimed a healthy server', () => {
        const next = nextStateForOpenCode(
          recorded,
          { kind: 'degraded', baseUrl, reason: 'exited 3 times' },
          baseUrl,
          { released: false },
        )

        expect(next?.opencode).toMatchObject({ status: 'degraded', detail: 'exited 3 times' })
      })

      /**
       * A shutdown removes daemon.json, and stopping OpenCode is itself a status
       * change. Writing after that point resurrects the file for a daemon that
       * has exited — and the next start reads it and believes it.
       */
      it('writes nothing once shutdown has released the file', () => {
        const next = nextStateForOpenCode(
          recorded,
          { kind: 'degraded', baseUrl, reason: 'stopped' },
          baseUrl,
          { released: true },
        )

        expect(next).toBeNull()
      })

      it('writes nothing before there is a record to patch', () => {
        const next = nextStateForOpenCode(
          null,
          { kind: 'managed', baseUrl, pid: 222 },
          baseUrl,
          { released: false },
        )

        expect(next).toBeNull()
      })
    })
  })
})
