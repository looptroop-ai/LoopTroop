import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import {
  DaemonStartBlockedError,
  DaemonShutdownPendingError,
  startDaemon,
  installShutdownHandlers,
  describeOpenCode,
  nextStateForOpenCode,
  type DaemonHandle,
} from '../server/daemon/startDaemon'
import * as runtimeFactory from '../server/createRuntime'
import * as openCodeFactory from '../server/opencode/factory'
import { OpenCodeSupervisor } from '../server/opencode/supervisor'
import type { OpenCodeStatus } from '../server/opencode/supervisor'
import * as daemonPaths from '../server/lib/daemonPaths'
import * as processControl from '../server/cli/processControl'
import * as processIdentity from '../server/lib/processIdentity'
import { getDaemonLockPath, getDaemonStatePath, writeDaemonStartFailure, writeDaemonState, type DaemonState } from '../server/lib/daemonPaths'
import { resolveSettings } from '../server/lib/appSettings'
import { APP_SCHEMA_VERSION } from '../server/db/schemaVersion'
import { initializeDatabase } from '../server/db/init'
import { removeTempDir } from '../server/test/tempDir'

/**
 * 2.7 contract: the daemon reports ready only once it is genuinely serving, and
 * a failed start leaves nothing behind. A supervisor that trusted a premature
 * ready would report success for a daemon that never bound a port.
 */
describe('daemon startup and shutdown', () => {
  const tempDirs: string[] = []
  const running: DaemonHandle[] = []

  beforeAll(() => {
    // Prepare the cold schema and native identity cache under the hook budget,
    // so the first readiness test has the same fixture as subsequent starts.
    processIdentity.readProcessStartToken(process.pid)
    initializeDatabase()
  })

  afterEach(async () => {
    for (const handle of running.splice(0)) await handle.stop()
    for (const dir of tempDirs.splice(0)) {
      removeTempDir(dir)
    }
    vi.unstubAllEnvs()
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

  it('retains the runtime and ownership when OpenCode shutdown is incomplete', async () => {
    const configDir = makeConfigDir()
    const stopSpy = vi.spyOn(OpenCodeSupervisor.prototype, 'stop')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    try {
      const handle = await start(configDir)

      await expect(handle.stop()).rejects.toThrow(/shutdown is incomplete/i)
      expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
      expect(existsSync(getDaemonStatePath(configDir))).toBe(true)
      expect((await fetch(`http://${handle.state.host}:${handle.state.port}/api/health`)).ok).toBe(true)

      await expect(handle.stop()).resolves.toBeUndefined()
      expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
      expect(existsSync(getDaemonStatePath(configDir))).toBe(false)
      expect(stopSpy).toHaveBeenCalledTimes(2)
    } finally {
      stopSpy.mockRestore()
    }
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

  it('does not reclaim a lock while startup cleanup still owns OpenCode', async () => {
    const configDir = makeConfigDir()
    writeDaemonStartFailure({
      reason: 'startup-cleanup-incomplete',
      at: '2026-01-02T03:04:05.000Z',
      version: '0.0.0-test',
      message: 'OpenCode did not stop during startup cleanup.',
      openCode: {
        baseUrl: 'http://127.0.0.1:4096',
        pid: 4242,
        startToken: 'child-start',
      },
    }, configDir)

    await expect(startDaemon({
      configDir,
      settings: ephemeralSettings(),
      version: '0.0.0-test',
    })).rejects.toBeInstanceOf(DaemonStartBlockedError)
    expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
  })

  it('does not replace a daemon state retained for an incomplete close', async () => {
    const configDir = makeConfigDir()
    const pending: DaemonState = {
      instanceId: 'pending-instance',
      pid: process.pid,
      port: 4096,
      host: '127.0.0.1',
      startedAt: '2026-01-02T03:04:05.000Z',
      version: '0.0.0-test',
      apiToken: 'pending-token',
      shutdownPending: true,
    }
    writeDaemonState(pending, configDir)

    await expect(startDaemon({
      configDir,
      settings: ephemeralSettings(),
      version: '0.0.0-test',
    })).rejects.toBeInstanceOf(DaemonShutdownPendingError)
    expect(JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8'))).toMatchObject(pending)
    expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
  })

  it('rechecks retained OpenCode ownership after acquiring the lock', async () => {
    const configDir = makeConfigDir()
    const failure = {
      reason: 'startup-cleanup-incomplete',
      at: '2026-01-02T03:04:05.000Z',
      version: '0.0.0-test',
      message: 'OpenCode did not stop during startup cleanup.',
      openCode: { baseUrl: 'http://127.0.0.1:4096', pid: 4242 },
    } as const
    const readFailure = vi.spyOn(daemonPaths, 'readDaemonStartFailure')
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(failure)

    try {
      await expect(startDaemon({
        configDir,
        settings: ephemeralSettings(),
        version: '0.0.0-test',
      })).rejects.toBeInstanceOf(DaemonStartBlockedError)

      expect(readFailure).toHaveBeenCalledTimes(2)
      expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
    } finally {
      readFailure.mockRestore()
    }
  })

  it('rechecks a pending shutdown after acquiring the lock', async () => {
    const configDir = makeConfigDir()
    const pending: DaemonState = {
      instanceId: 'pending-instance',
      pid: process.pid,
      port: 4096,
      host: '127.0.0.1',
      startedAt: '2026-01-02T03:04:05.000Z',
      version: '0.0.0-test',
      apiToken: 'pending-token',
      shutdownPending: true,
    }
    const readState = vi.spyOn(daemonPaths, 'readDaemonState')
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(pending)

    try {
      await expect(startDaemon({
        configDir,
        settings: ephemeralSettings(),
        version: '0.0.0-test',
      })).rejects.toBeInstanceOf(DaemonShutdownPendingError)

      expect(readState).toHaveBeenCalledTimes(2)
      expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
    } finally {
      readState.mockRestore()
    }
  })

  it('preserves an owned OpenCode record that has no safe pid to check', async () => {
    const configDir = makeConfigDir()
    const previous: DaemonState = {
      instanceId: 'previous-daemon',
      pid: 12_341,
      port: 4096,
      host: '127.0.0.1',
      startedAt: '2026-01-02T03:04:05.000Z',
      version: '0.0.0-test',
      apiToken: 'previous-api-token',
      opencode: { baseUrl: 'http://127.0.0.1:4096', owned: true, status: 'managed' },
    }
    writeDaemonState(previous, configDir)
    const alive = vi.spyOn(processControl, 'isProcessAlive').mockReturnValue(false)

    try {
      await expect(startDaemon({
        configDir,
        settings: ephemeralSettings(),
        version: '0.0.0-test',
      })).rejects.toThrow(/owned OpenCode server has no recorded pid/)

      expect(JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8'))).toEqual(previous)
      expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
    } finally {
      alive.mockRestore()
    }
  })

  it('releases startup ownership when runtime startup fails but cleanup succeeds', async () => {
    const configDir = makeConfigDir()
    const startupError = new Error('runtime could not bind')
    const runtime = {
      start: vi.fn().mockRejectedValue(startupError),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const create = vi.spyOn(runtimeFactory, 'createRuntime')
      .mockReturnValue(runtime as unknown as ReturnType<typeof runtimeFactory.createRuntime>)
    const startSpy = vi.spyOn(OpenCodeSupervisor.prototype, 'start').mockResolvedValue({
      kind: 'managed',
      baseUrl: 'http://127.0.0.1:4096',
      pid: 12_342,
    })
    const stopSpy = vi.spyOn(OpenCodeSupervisor.prototype, 'stop').mockResolvedValue(true)

    try {
      await expect(startDaemon({
        configDir,
        settings: ephemeralSettings(),
        version: '0.0.0-test',
      })).rejects.toBe(startupError)

      expect(runtime.start).toHaveBeenCalledOnce()
      expect(runtime.close).toHaveBeenCalledOnce()
      expect(stopSpy).toHaveBeenCalledOnce()
      expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
      expect(existsSync(getDaemonStatePath(configDir))).toBe(false)
      expect(daemonPaths.readDaemonStartFailure(configDir)).toBeNull()
    } finally {
      stopSpy.mockRestore()
      startSpy.mockRestore()
      create.mockRestore()
    }
  })

  it('retains the OpenCode identity when later startup cleanup is incomplete', async () => {
    const configDir = makeConfigDir()
    const startupError = new Error('runtime could not bind')
    const runtime = {
      start: vi.fn().mockRejectedValue(startupError),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const create = vi.spyOn(runtimeFactory, 'createRuntime')
      .mockReturnValue(runtime as unknown as ReturnType<typeof runtimeFactory.createRuntime>)
    const startSpy = vi.spyOn(OpenCodeSupervisor.prototype, 'start').mockResolvedValue({
      kind: 'managed',
      baseUrl: 'http://127.0.0.1:4096',
      pid: 12_342,
    })
    const stopSpy = vi.spyOn(OpenCodeSupervisor.prototype, 'stop').mockResolvedValue(false)
    const ownedProcess = vi.spyOn(OpenCodeSupervisor.prototype, 'ownedProcess', 'get')
      .mockReturnValue({ pid: 12_342, startToken: null })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(startDaemon({
        configDir,
        settings: ephemeralSettings(),
        version: '0.0.0-test',
      })).rejects.toBe(startupError)

      expect(runtime.start).toHaveBeenCalledOnce()
      expect(runtime.close).toHaveBeenCalledOnce()
      expect(stopSpy).toHaveBeenCalledOnce()
      expect(daemonPaths.readDaemonStartFailure(configDir)).toMatchObject({
        reason: 'startup-cleanup-incomplete',
        openCode: { baseUrl: 'http://127.0.0.1:4096', pid: 12_342 },
      })
      const failure = daemonPaths.readDaemonStartFailure(configDir)
      expect(failure?.reason).toBe('startup-cleanup-incomplete')
      expect(failure && 'openCode' in failure ? failure.openCode : undefined).toEqual({
        baseUrl: 'http://127.0.0.1:4096',
        pid: 12_342,
      })
      expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
      expect(report).toHaveBeenCalledWith(expect.stringContaining('daemon lock was retained'))
    } finally {
      report.mockRestore()
      ownedProcess.mockRestore()
      stopSpy.mockRestore()
      startSpy.mockRestore()
      create.mockRestore()
    }
  })

  it('retains the lock and child identity if OpenCode throws during startup cleanup', async () => {
    const configDir = makeConfigDir()
    const startupError = new Error('runtime could not bind')
    const runtime = {
      start: vi.fn().mockRejectedValue(startupError),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const create = vi.spyOn(runtimeFactory, 'createRuntime')
      .mockReturnValue(runtime as unknown as ReturnType<typeof runtimeFactory.createRuntime>)
    const startSpy = vi.spyOn(OpenCodeSupervisor.prototype, 'start').mockResolvedValue({
      kind: 'managed',
      baseUrl: 'http://127.0.0.1:4096',
      pid: 12_342,
    })
    const stopSpy = vi.spyOn(OpenCodeSupervisor.prototype, 'stop')
      .mockRejectedValue(new Error('OpenCode cleanup failed'))
    const ownedProcess = vi.spyOn(OpenCodeSupervisor.prototype, 'ownedProcess', 'get')
      .mockReturnValue({ pid: 12_342, startToken: 'child-start-token' })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(startDaemon({
        configDir,
        settings: ephemeralSettings(),
        version: '0.0.0-test',
      })).rejects.toBe(startupError)

      expect(daemonPaths.readDaemonStartFailure(configDir)).toMatchObject({
        reason: 'startup-cleanup-incomplete',
        openCode: { pid: 12_342, startToken: 'child-start-token' },
      })
      expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
      expect(report).toHaveBeenCalledWith(expect.stringContaining('daemon lock was retained'))
    } finally {
      report.mockRestore()
      ownedProcess.mockRestore()
      stopSpy.mockRestore()
      startSpy.mockRestore()
      create.mockRestore()
    }
  })

  it('leaves the previous daemon record when retained-child evidence cannot be written', async () => {
    const configDir = makeConfigDir()
    const previous: DaemonState = {
      instanceId: 'stale-daemon',
      pid: 12_341,
      port: 4096,
      host: '127.0.0.1',
      startedAt: '2026-01-02T03:04:05.000Z',
      version: '0.0.0-test',
      apiToken: 'stale-api-token',
    }
    writeDaemonState(previous, configDir)
    const alive = vi.spyOn(processControl, 'isProcessAlive').mockReturnValue(false)
    const startupError = new Error('runtime could not bind')
    const runtime = {
      start: vi.fn().mockRejectedValue(startupError),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const create = vi.spyOn(runtimeFactory, 'createRuntime')
      .mockReturnValue(runtime as unknown as ReturnType<typeof runtimeFactory.createRuntime>)
    const startSpy = vi.spyOn(OpenCodeSupervisor.prototype, 'start').mockResolvedValue({
      kind: 'managed',
      baseUrl: 'http://127.0.0.1:4096',
      pid: 12_342,
    })
    const stopSpy = vi.spyOn(OpenCodeSupervisor.prototype, 'stop').mockResolvedValue(false)
    const ownedProcess = vi.spyOn(OpenCodeSupervisor.prototype, 'ownedProcess', 'get')
      .mockReturnValue({ pid: 12_342, startToken: 'child-start-token' })
    const writeFailure = vi.spyOn(daemonPaths, 'writeDaemonStartFailure').mockImplementation(() => {
      throw new Error('disk full')
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(startDaemon({
        configDir,
        settings: ephemeralSettings(),
        version: '0.0.0-test',
      })).rejects.toBe(startupError)

      expect(daemonPaths.readDaemonStartFailure(configDir)).toBeNull()
      expect(JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8'))).toEqual(previous)
      expect(existsSync(getDaemonLockPath(configDir))).toBe(true)
      expect(report).toHaveBeenCalledWith(expect.stringContaining('leaving existing state untouched'))
    } finally {
      report.mockRestore()
      writeFailure.mockRestore()
      ownedProcess.mockRestore()
      stopSpy.mockRestore()
      startSpy.mockRestore()
      create.mockRestore()
      alive.mockRestore()
    }
  })

  function writeOwnedOrphan(configDir: string): DaemonState {
    const state: DaemonState = {
      instanceId: 'previous-daemon',
      pid: 12_341,
      port: 4096,
      host: '127.0.0.1',
      startedAt: '2026-01-02T03:04:05.000Z',
      version: '0.0.0-test',
      startToken: 'previous-daemon-token',
      apiToken: 'previous-api-token',
      opencode: {
        baseUrl: 'http://127.0.0.1:4096',
        owned: true,
        status: 'managed',
        pid: 12_342,
        startToken: 'previous-opencode-token',
      },
    }
    writeDaemonState(state, configDir)
    return state
  }

  function mockPreviousDaemonAndChild(
    state: DaemonState,
    childIdentity: { kind: 'same' | 'different' | 'unknown', reason?: string } = { kind: 'same' },
  ) {
    const alive = vi.spyOn(processControl, 'isProcessAlive').mockImplementation(pid => pid === state.opencode?.pid)
    const identity = vi.spyOn(processIdentity, 'matchProcess').mockImplementation((pid) => {
      if (pid === state.opencode?.pid) {
        return childIdentity.kind === 'unknown'
          ? { kind: 'unknown', reason: childIdentity.reason ?? 'the platform cannot read its start token' }
          : { kind: childIdentity.kind }
      }
      return { kind: 'different' }
    })
    return () => {
      identity.mockRestore()
      alive.mockRestore()
    }
  }

  it.each([
    ['an authentication failure', 'reject' as const],
    ['a healthy adopted server', 'adopt' as const],
  ])('blocks an owned orphan before the supervisor can reach %s', async (_description, supervisorOutcome) => {
    const configDir = makeConfigDir()
    const previous = writeOwnedOrphan(configDir)
    const restoreIdentity = mockPreviousDaemonAndChild(previous)
    const startSpy = vi.spyOn(OpenCodeSupervisor.prototype, 'start')
    if (supervisorOutcome === 'reject') {
      startSpy.mockRejectedValue(new Error('OpenCode returned 401 Unauthorized'))
    } else {
      startSpy.mockResolvedValue({ kind: 'adopted', baseUrl: previous.opencode!.baseUrl })
    }

    try {
      await expect(startDaemon({
        configDir,
        settings: ephemeralSettings(),
        version: '0.0.0-test',
      })).rejects.toBeInstanceOf(DaemonStartBlockedError)

      expect(startSpy).not.toHaveBeenCalled()
      expect(JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8'))).toMatchObject({
        startFailure: {
          reason: 'startup-cleanup-incomplete',
          openCode: {
            baseUrl: previous.opencode?.baseUrl,
            pid: previous.opencode?.pid,
            startToken: previous.opencode?.startToken,
          },
        },
      })
      expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
    } finally {
      startSpy.mockRestore()
      restoreIdentity()
    }
  })

  it('preserves the old ownership record and releases the lock if orphan recovery cannot be recorded', async () => {
    const configDir = makeConfigDir()
    const previous = writeOwnedOrphan(configDir)
    const restoreIdentity = mockPreviousDaemonAndChild(previous)
    const writeFailure = vi.spyOn(daemonPaths, 'writeDaemonStartFailure').mockImplementation(() => {
      throw new Error('disk full')
    })
    const startSpy = vi.spyOn(OpenCodeSupervisor.prototype, 'start')

    try {
      await expect(startDaemon({
        configDir,
        settings: ephemeralSettings(),
        version: '0.0.0-test',
      })).rejects.toThrow(/could not save its cleanup record/i)

      expect(writeFailure).toHaveBeenCalledOnce()
      expect(startSpy).not.toHaveBeenCalled()
      expect(JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8'))).toEqual(previous)
      expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
    } finally {
      startSpy.mockRestore()
      writeFailure.mockRestore()
      restoreIdentity()
    }
  })

  it.each(['previous daemon', 'owned OpenCode child'])('preserves state when the %s identity is unknown', async unknownOwner => {
    const configDir = makeConfigDir()
    const previous = writeOwnedOrphan(configDir)
    const alive = vi.spyOn(processControl, 'isProcessAlive').mockImplementation((pid) => {
      return unknownOwner === 'previous daemon' ? pid === previous.pid : pid === previous.opencode?.pid
    })
    const identity = vi.spyOn(processIdentity, 'matchProcess').mockReturnValue({
      kind: 'unknown',
      reason: 'the platform cannot report its start identity',
    })
    const startSpy = vi.spyOn(OpenCodeSupervisor.prototype, 'start')

    try {
      await expect(startDaemon({
        configDir,
        settings: ephemeralSettings(),
        version: '0.0.0-test',
      })).rejects.toThrow(/identity cannot be verified|alive but the platform cannot report/i)

      expect(startSpy).not.toHaveBeenCalled()
      expect(JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8'))).toEqual(previous)
      expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
    } finally {
      startSpy.mockRestore()
      identity.mockRestore()
      alive.mockRestore()
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

  it('persists the public browser origin and uses it for bootstrap links', async () => {
    vi.stubEnv('LOOPTROOP_ALLOW_REMOTE_API', '1')
    const configDir = makeConfigDir()
    const handle = await startDaemon({
      configDir,
      settings: { ...ephemeralSettings(), publicOrigin: 'https://public.example' },
      version: '0.0.0-test',
    })
    running.push(handle)

    expect(handle.state.publicOrigin).toBe('https://public.example')
    expect(handle.bootstrapUrl()).toMatch(/^https:\/\/public\.example\/#bootstrap=/)
    expect(JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8'))).toMatchObject({
      publicOrigin: 'https://public.example',
    })
  })

  it('rejects a public origin without remote mode before acquiring ownership', async () => {
    vi.stubEnv('LOOPTROOP_ALLOW_REMOTE_API', '0')
    const configDir = makeConfigDir()
    await expect(startDaemon({
      configDir,
      settings: { ...ephemeralSettings(), publicOrigin: 'https://public.example' },
      version: '0.0.0-test',
    })).rejects.toThrow('LOOPTROOP_ALLOW_REMOTE_API=1')
    expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
    expect(existsSync(getDaemonStatePath(configDir))).toBe(false)
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
      if (failure?.reason !== 'schema-incompatible') throw new Error('Expected schema-incompatible failure')
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

  it('refreshes the OpenCode record and keeps serving if a refresh write fails', async () => {
    const configDir = makeConfigDir()
    let publishStatus: ((status: OpenCodeStatus) => void) | undefined
    const startSpy = vi.spyOn(OpenCodeSupervisor.prototype, 'start').mockImplementation(async function (this: OpenCodeSupervisor) {
      const instance = this as unknown as { options: { onStatusChange?: (status: OpenCodeStatus) => void } }
      publishStatus = instance.options.onStatusChange
      return { kind: 'adopted', baseUrl: 'http://127.0.0.1:4096' }
    })
    const resetTransport = vi.spyOn(openCodeFactory, 'resetOpenCodeAdapterTransport')

    try {
      const handle = await start(configDir)
      expect(publishStatus).toBeDefined()
      publishStatus?.({ kind: 'managed', baseUrl: 'http://127.0.0.1:4096', pid: 12_342 })
      expect(resetTransport).toHaveBeenCalledOnce()
      expect(JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8'))).toMatchObject({
        opencode: { baseUrl: 'http://127.0.0.1:4096', owned: true, status: 'managed', pid: 12_342 },
      })

      const beforeFailedRefresh = readFileSync(getDaemonStatePath(configDir), 'utf8')
      const writeState = vi.spyOn(daemonPaths, 'writeDaemonState').mockImplementation(() => {
        throw new Error('disk full')
      })
      try {
        expect(() => publishStatus?.({
          kind: 'degraded',
          baseUrl: 'http://127.0.0.1:4096',
          reason: 'OpenCode restart failed',
        })).not.toThrow()
        expect(readFileSync(getDaemonStatePath(configDir), 'utf8')).toBe(beforeFailedRefresh)
        expect((await fetch(`http://${handle.state.host}:${handle.state.port}/api/health`)).ok).toBe(true)
      } finally {
        writeState.mockRestore()
      }
    } finally {
      resetTransport.mockRestore()
      startSpy.mockRestore()
    }
  })

  it('keeps the daemon running when pending-shutdown state cannot be written', async () => {
    const configDir = makeConfigDir()
    const handle = await start(configDir)
    const persistState = daemonPaths.writeDaemonState
    const writeState = vi.spyOn(daemonPaths, 'writeDaemonState').mockImplementation((state, stateDir) => {
      if (state.shutdownPending) throw new Error('disk full')
      return persistState(state, stateDir)
    })

    try {
      await expect(handle.stop()).rejects.toThrow('Could not record pending daemon shutdown: disk full')
      expect(JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8'))).not.toHaveProperty('shutdownPending')
      expect((await fetch(`http://${handle.state.host}:${handle.state.port}/api/health`)).ok).toBe(true)
    } finally {
      writeState.mockRestore()
    }

    await expect(handle.stop()).resolves.toBeUndefined()
  })

  it('logs a shutdown request failure when no process listener owns the exit', async () => {
    const configDir = makeConfigDir()
    const handle = await start(configDir)
    const stop = vi.spyOn(OpenCodeSupervisor.prototype, 'stop')
      .mockRejectedValueOnce(new Error('OpenCode is still running'))
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const response = await fetch(`http://${handle.state.host}:${handle.state.port}/api/daemon/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${handle.credentials.apiToken}` },
      })
      expect(response.status).toBe(202)
      await vi.waitFor(() => {
        expect(report).toHaveBeenCalledWith('[daemon] Shutdown failed: OpenCode is still running')
      })
      expect(stop).toHaveBeenCalledOnce()
      expect((await fetch(`http://${handle.state.host}:${handle.state.port}/api/health`)).ok).toBe(true)
    } finally {
      report.mockRestore()
      stop.mockRestore()
    }
  })

  it('retries a rejected shutdown handler and ignores duplicate signals', async () => {
    const beforeTerm = new Set(process.listeners('SIGTERM'))
    const beforeInt = new Set(process.listeners('SIGINT'))
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error('runtime drain is incomplete'))
      .mockResolvedValue(undefined)
    let requestShutdown: ((reason: string) => void) | undefined
    const handle = {
      onShutdownRequest(listener: (reason: string) => void) { requestShutdown = listener },
      stop,
    } as unknown as DaemonHandle
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    let termHandlers = process.listeners('SIGTERM').filter(() => false)
    let intHandlers = process.listeners('SIGINT').filter(() => false)

    vi.useFakeTimers()
    try {
      installShutdownHandlers(handle)
      termHandlers = process.listeners('SIGTERM').filter(listener => !beforeTerm.has(listener))
      intHandlers = process.listeners('SIGINT').filter(listener => !beforeInt.has(listener))
      expect(termHandlers).toHaveLength(1)
      expect(intHandlers).toHaveLength(1)

      requestShutdown?.('an API request')
      await Promise.resolve()
      await Promise.resolve()
      expect(stop).toHaveBeenCalledOnce()
      expect(report).toHaveBeenCalledWith(expect.stringContaining('retrying in 500ms'))

      ;(termHandlers[0] as () => void)()
      ;(intHandlers[0] as () => void)()
      expect(stop).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(500)
      expect(stop).toHaveBeenCalledTimes(2)
      expect(exit).toHaveBeenCalledWith(0)
      expect(log).toHaveBeenCalledWith('[daemon] Shutting down (an API request).')
    } finally {
      for (const listener of termHandlers) process.off('SIGTERM', listener as never)
      for (const listener of intHandlers) process.off('SIGINT', listener as never)
      vi.useRealTimers()
      exit.mockRestore()
      log.mockRestore()
      report.mockRestore()
    }
  })
})
