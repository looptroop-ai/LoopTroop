import { EventEmitter } from 'node:events'
import { closeSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOOPTROOP_OPENCODE_LOGS_ENV } from '@shared/opencodeLogMode'
import { writeDaemonState, type DaemonState } from '../../lib/daemonPaths'
import { removeTempDir } from '../../test/tempDir'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  isProcessAlive: vi.fn(),
  killProcessTree: vi.fn(),
  signalTermination: vi.fn(),
  waitForExit: vi.fn(),
  matchProcess: vi.fn(),
  readProcessStartToken: vi.fn(),
  resolveTrustedExecutable: vi.fn(),
  runDaemonProcess: vi.fn(),
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: mocks.spawn }
})

vi.mock('../processControl', () => ({
  isProcessAlive: mocks.isProcessAlive,
  killProcessTree: mocks.killProcessTree,
  signalTermination: mocks.signalTermination,
  waitForExit: mocks.waitForExit,
}))

vi.mock('../../lib/processIdentity', () => ({
  matchProcess: mocks.matchProcess,
  readProcessStartToken: mocks.readProcessStartToken,
}))

vi.mock('../../lib/executablePath', async () => {
  const actual = await vi.importActual<typeof import('../../lib/executablePath')>('../../lib/executablePath')
  return { ...actual, resolveTrustedExecutable: mocks.resolveTrustedExecutable }
})

vi.mock('../daemonProcess', () => ({ runDaemonProcess: mocks.runDaemonProcess }))

import { openCommand, openInBrowser, probeRecordedDaemon, restartCommand, startCommand, stopCommand } from '../commands'

type FakeChild = EventEmitter & {
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
}

function makeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  child.stderr = new EventEmitter()
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === 'SIGTERM') child.exitCode = 0
    return true
  })
  child.unref = vi.fn()
  return child
}

function closeSpawnLogFile(options: { stdio?: unknown[] }) {
  const fds = new Set((options.stdio ?? []).filter((value): value is number => typeof value === 'number'))
  for (const fd of fds) closeSync(fd)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function stubFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(new URL(String(input)), init)),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

let configDir = ''
let previousConfigDir: string | undefined
let restoreOutput = () => {}
const tempDirs: string[] = []

function useConfigDir(): string {
  configDir = mkdtempSync(join(tmpdir(), 'looptroop-commands-'))
  tempDirs.push(configDir)
  process.env.LOOPTROOP_CONFIG_DIR = configDir
  return configDir
}

function captureOutput() {
  const originalStdout = process.stdout.write.bind(process.stdout)
  const originalStderr = process.stderr.write.bind(process.stderr)
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    return true
  }) as typeof process.stderr.write
  restoreOutput = () => {
    process.stdout.write = originalStdout
    process.stderr.write = originalStderr
  }
  return { stdout: () => stdout, stderr: () => stderr }
}

function makeState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    instanceId: 'commands-instance',
    pid: process.pid,
    host: '127.0.0.1',
    port: 4317,
    startedAt: new Date().toISOString(),
    version: '1.2.3',
    apiToken: 'test-token',
    ...overrides,
  }
}

function stubDaemonFetch(state: DaemonState, projects: unknown = [{ id: 'project-1' }]) {
  return stubFetch((url) => {
    if (url.pathname === '/api/health') return jsonResponse({ instanceId: state.instanceId })
    if (url.pathname === '/api/auth/bootstrap') return jsonResponse({ nonce: 'single-use-nonce' })
    if (url.pathname === '/api/auth/bootstrap/status') return jsonResponse({ pending: false })
    if (url.pathname === '/api/projects') return jsonResponse(projects)
    if (url.pathname === '/api/daemon/shutdown') return jsonResponse({ accepted: true })
    throw new Error(`Unexpected daemon request: ${url.pathname}`)
  })
}

function startDaemonOnSpawn(state: DaemonState, child: FakeChild) {
  mocks.isProcessAlive.mockImplementation((pid: number) => pid === child.pid)
  mocks.readProcessStartToken.mockReturnValue(state.startToken ?? null)
  mocks.spawn.mockImplementation((_file: string, _args: string[], options: { stdio?: unknown[] }) => {
    closeSpawnLogFile(options)
    writeDaemonState(state, configDir)
    return child
  })
}

beforeEach(() => {
  previousConfigDir = process.env.LOOPTROOP_CONFIG_DIR
  useConfigDir()
  vi.clearAllMocks()
  mocks.isProcessAlive.mockImplementation((pid: number) => pid === process.pid)
  mocks.waitForExit.mockResolvedValue(true)
  mocks.signalTermination.mockReturnValue(false)
  mocks.killProcessTree.mockResolvedValue(false)
  mocks.matchProcess.mockReturnValue({ kind: 'same' })
  mocks.readProcessStartToken.mockReturnValue('test-start-token')
  mocks.resolveTrustedExecutable.mockReturnValue({ path: '/fake/browser' })
})

afterEach(() => {
  restoreOutput()
  restoreOutput = () => {}
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (previousConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
  else process.env.LOOPTROOP_CONFIG_DIR = previousConfigDir
  for (const dir of tempDirs.splice(0)) removeTempDir(dir)
})

describe('daemon startup and shutdown command paths', () => {
  it('starts a ready child with the selected port and managed OpenCode logs', async () => {
    const child = makeChild(45_671)
    const state = makeState({ pid: child.pid, startToken: 'test-start-token' })
    startDaemonOnSpawn(state, child)
    stubDaemonFetch(state, [])
    const output = captureOutput()

    expect(await startCommand({ port: 45_672, opencodeLogs: 'all' })).toBe(0)
    expect(mocks.spawn).toHaveBeenCalledOnce()
    const spawnOptions = mocks.spawn.mock.calls[0]?.[2] as { detached: boolean; env: NodeJS.ProcessEnv }
    expect(spawnOptions.detached).toBe(true)
    expect(spawnOptions.env.LOOPTROOP_BACKEND_PORT).toBe('45672')
    expect(spawnOptions.env[LOOPTROOP_OPENCODE_LOGS_ENV]).toBe('all')
    expect(child.unref).toHaveBeenCalledOnce()
    expect(output.stdout()).toContain('LoopTroop is running in the background.')
    expect(output.stdout()).toContain('No projects attached yet. Add one in the interface.')
  })

  it('shows the log path when a background start never publishes ready state', async () => {
    const child = makeChild(45_676)
    mocks.isProcessAlive.mockReturnValue(false)
    mocks.spawn.mockImplementation((_file: string, _args: string[], options: { stdio?: unknown[] }) => {
      closeSpawnLogFile(options)
      return child
    })
    const output = captureOutput()

    expect(await startCommand()).toBe(1)
    expect(child.kill).not.toHaveBeenCalled()
    expect(output.stderr()).toContain('LoopTroop failed to start. Recent log output:')
    expect(output.stderr()).toContain('Full log:')
  })

  it('restarts by starting the daemon in foreground mode after a clean stop', async () => {
    expect(await restartCommand({ foreground: true, port: 45_673 })).toBe(0)
    expect(mocks.runDaemonProcess).toHaveBeenCalledWith({ foreground: true, port: 45_673 })
  })

  it('reports a daemon whose probe cannot prove the live pid and leaves it alone', async () => {
    const state = makeState()
    writeDaemonState(state, configDir)
    stubFetch(() => { throw new Error('connection refused') })
    mocks.matchProcess.mockReturnValue({ kind: 'unknown', reason: 'the start time could not be read' })
    const output = captureOutput()

    expect(await stopCommand()).toBe(1)
    expect(output.stderr()).toContain('the start time could not be read')
    expect(mocks.signalTermination).not.toHaveBeenCalled()
    expect(mocks.killProcessTree).not.toHaveBeenCalled()
    expect(await probeRecordedDaemon(configDir)).toMatchObject({ kind: 'unverifiable', state })
  })

  it('uses the authenticated shutdown route and clears state after a graceful exit', async () => {
    const state = makeState()
    writeDaemonState(state, configDir)
    const fetchMock = stubDaemonFetch(state)
    const output = captureOutput()

    expect(await stopCommand()).toBe(0)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4317/api/daemon/shutdown',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    )
    expect(output.stdout()).toContain('LoopTroop stopped.')
    expect(mocks.waitForExit).toHaveBeenCalled()
  })

  it('keeps a pending shutdown record when owned runtime cleanup has not finished', async () => {
    const state = makeState({ shutdownPending: true })
    writeDaemonState(state, configDir)
    stubDaemonFetch(state)
    const output = captureOutput()

    expect(await stopCommand()).toBe(1)
    expect(output.stderr()).toContain('runtime cleanup is still incomplete')
    expect(mocks.signalTermination).not.toHaveBeenCalled()
    expect(await probeRecordedDaemon(configDir)).toMatchObject({ kind: 'running', state })
  })

  it('clears a record when its live pid answers as a different instance', async () => {
    const state = makeState()
    writeDaemonState(state, configDir)
    stubFetch(() => jsonResponse({ instanceId: 'different-instance' }))
    const output = captureOutput()

    expect(await stopCommand()).toBe(0)
    expect(output.stderr()).toContain('The recorded daemon is gone')
    expect(mocks.signalTermination).not.toHaveBeenCalled()
    expect(await probeRecordedDaemon(configDir)).toEqual({ kind: 'not-running' })
  })
})

describe('open command browser and sign-in paths', () => {
  it('opens a signed-in browser URL without printing the single-use nonce', async () => {
    const state = makeState()
    writeDaemonState(state, configDir)
    stubDaemonFetch(state)
    const opener = vi.fn(async () => ({ opened: true }))
    const output = captureOutput()

    expect(await openCommand({ open: opener, waitMs: 100, opencodeLogs: 'all' })).toBe(0)
    expect(opener).toHaveBeenCalledWith('http://127.0.0.1:4317/#bootstrap=single-use-nonce')
    expect(output.stdout()).toContain('Opened http://127.0.0.1:4317')
    expect(output.stdout()).not.toContain('single-use-nonce')
    expect(output.stderr()).toContain('only applies when LoopTroop starts the daemon')
  })

  it('prints the sign-in link when the browser opener cannot launch', async () => {
    const state = makeState()
    writeDaemonState(state, configDir)
    stubDaemonFetch(state)
    const output = captureOutput()

    expect(await openCommand({ open: () => ({ opened: false, reason: 'no handler' }) })).toBe(0)
    expect(output.stdout()).toContain('No browser could be opened (no handler). Sign in with this link:')
    expect(output.stdout()).toContain('http://127.0.0.1:4317/#bootstrap=single-use-nonce')
  })

  it('opens a fresh daemon and prints its link and log hint when requested', async () => {
    const child = makeChild(45_674)
    const state = makeState({ pid: child.pid, startToken: 'test-start-token' })
    startDaemonOnSpawn(state, child)
    stubDaemonFetch(state, [])
    const output = captureOutput()

    expect(await openCommand({ printUrl: true, opencodeLogs: 'all' })).toBe(0)
    expect(output.stdout()).toContain('LoopTroop is not running. Starting it...')
    expect(output.stdout()).toContain('http://127.0.0.1:4317/#bootstrap=single-use-nonce')
    expect(output.stdout()).toContain('Full managed OpenCode DEBUG output is enabled.')
    expect(output.stdout()).toContain('No projects attached yet. Add one in the interface.')
  })

  it('returns the opener error when the desktop browser process exits unsuccessfully', async () => {
    const child = makeChild(45_675)
    mocks.spawn.mockReturnValue(child)
    const pending = openInBrowser('http://127.0.0.1:4317')
    child.stderr.emit('data', Buffer.from('No browser registered\nadditional detail'))
    child.emit('exit', 1)

    await expect(pending).resolves.toEqual({ opened: false, reason: 'No browser registered' })
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('reports an unavailable browser executable without spawning a child', async () => {
    mocks.resolveTrustedExecutable.mockReturnValue({ path: undefined, reason: 'xdg-open was not found' })

    await expect(openInBrowser('http://127.0.0.1:4317')).resolves.toEqual({
      opened: false,
      reason: 'xdg-open was not found',
    })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('returns a synchronous browser spawn failure without throwing', async () => {
    mocks.spawn.mockImplementation(() => { throw new Error('permission denied') })

    await expect(openInBrowser('http://127.0.0.1:4317')).resolves.toEqual({
      opened: false,
      reason: 'permission denied',
    })
  })
})
