import { ChildProcess } from 'node:child_process'
import { closeSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { LOOPTROOP_OPENCODE_LOGS_ENV } from '@shared/opencodeLogMode'
import {
  readDaemonStartFailure,
  readDaemonState,
  writeDaemonStartFailure,
  writeDaemonState,
  type DaemonState,
} from '../../lib/daemonPaths'
import { acquireDaemonLock } from '../../lib/daemonLock'
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

import { abandonFailedStart, browserOpener, openCommand, openInBrowser, probeRecordedDaemon, restartCommand, startCommand, stopCommand, waitForReady } from '../commands'

type FakeChild = Omit<ChildProcess, 'pid' | 'stderr' | 'kill' | 'unref'> & {
  pid: number
  stderr: PassThrough
  kill: Mock<(signal?: NodeJS.Signals) => boolean>
  unref: Mock<() => void>
}

const makeChild = (pid: number): FakeChild => {
  const child = new ChildProcess() as FakeChild
  Object.defineProperty(child, 'pid', { value: pid })
  child.stderr = new PassThrough()
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === 'SIGTERM') Object.defineProperty(child, 'exitCode', { value: 0 })
    return true
  })
  child.unref = vi.fn()
  return child
}

const closeSpawnLogFile = (options: { stdio?: unknown[] }): void => {
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

  it('says where OpenCode went when the default address belonged to another server', async () => {
    const child = makeChild(45_676)
    const movedFrom = { baseUrl: 'http://127.0.0.1:4096', reason: 'OpenCode requires a password, and none is configured (HTTP 401).' }
    const state = makeState({
      pid: child.pid,
      startToken: 'test-start-token',
      opencode: { baseUrl: 'http://127.0.0.1:4098', owned: true, status: 'managed', pid: 4242, movedFrom },
    })
    startDaemonOnSpawn(state, child)
    stubDaemonFetch(state, [])
    const output = captureOutput()

    expect(await startCommand()).toBe(0)
    expect(output.stdout()).toContain('\nOpenCode runs at http://127.0.0.1:4098 because http://127.0.0.1:4096 was taken by '
      + 'another server when LoopTroop started: OpenCode requires a password, and none is configured (HTTP 401).\n')
  })

  it('adopts a winning concurrent start and cleans up only its own losing child', async () => {
    const child = makeChild(45_681)
    const winner = makeState({ pid: 45_682, instanceId: 'winning-instance', startToken: 'winner-token' })
    mocks.isProcessAlive.mockReturnValue(true)
    mocks.readProcessStartToken.mockReturnValue('losing-token')
    mocks.spawn.mockImplementation((_file: string, _args: string[], options: { stdio?: unknown[] }) => {
      closeSpawnLogFile(options)
      writeDaemonState(winner, configDir)
      return child
    })
    stubDaemonFetch(winner)
    const output = captureOutput()

    expect(await startCommand()).toBe(0)
    expect(output.stdout()).toContain('LoopTroop is already running')
    expect(output.stderr()).toContain(`Stopped the daemon that never finished starting (pid ${child.pid}).`)
    expect(readDaemonState(configDir)).toEqual(winner)
  })

  it('refuses to start a second daemon while the recorded process is not answering', async () => {
    const state = makeState()
    writeDaemonState(state, configDir)
    stubFetch(() => { throw new Error('connection refused') })
    const output = captureOutput()

    expect(await startCommand()).toBe(1)
    expect(output.stderr()).toContain('but is not answering')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('keeps start idempotent and asks for a restart before enabling full OpenCode logs', async () => {
    const state = makeState()
    writeDaemonState(state, configDir)
    stubDaemonFetch(state)
    const output = captureOutput()

    expect(await startCommand({ opencodeLogs: 'all' })).toBe(0)
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(output.stdout()).toContain('LoopTroop is already running')
    expect(output.stderr()).toContain('Run `looptroop stop`, then start it again with that option.')
  })

  it('starts the foreground daemon with the selected options', async () => {
    expect(await startCommand({ foreground: true, port: 45_674, opencodeLogs: 'all' })).toBe(0)
    expect(mocks.runDaemonProcess).toHaveBeenCalledWith({ foreground: true, port: 45_674, opencodeLogs: 'all' })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('refuses to start while the previous shutdown still owns its retry state', async () => {
    writeDaemonState(makeState({ shutdownPending: true }), configDir)
    mocks.isProcessAlive.mockReturnValue(false)
    const output = captureOutput()

    expect(await startCommand()).toBe(1)
    expect(output.stderr()).toContain('previous daemon shutdown is still incomplete')
    expect(mocks.spawn).not.toHaveBeenCalled()
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

  it('does not adopt a ready state written by a different daemon child', async () => {
    const state = makeState({ pid: 45_677, startToken: 'winner-token' })
    mocks.isProcessAlive.mockReturnValue(true)
    writeDaemonState(state, configDir)
    stubDaemonFetch(state)

    await expect(waitForReady(configDir, 45_678, 'loser-token', makeChild(45_678)))
      .resolves.toMatchObject({ kind: 'other-instance', state })
  })

  it('accepts tokenless readiness only while the direct child is still live', async () => {
    const child = makeChild(45_679)
    const state = makeState({ pid: child.pid })
    mocks.isProcessAlive.mockReturnValue(true)
    writeDaemonState(state, configDir)
    stubDaemonFetch(state)

    await expect(waitForReady(configDir, child.pid, null, child)).resolves.toMatchObject({ kind: 'ready', state })

    Object.defineProperty(child, 'exitCode', { value: 0 })
    await expect(waitForReady(configDir, child.pid, null, child)).resolves.toMatchObject({ kind: 'unverifiable', state })
  })

  it('returns not-ready after a live child fails to publish state by the deadline', async () => {
    const now = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValue(60_000)
    mocks.isProcessAlive.mockReturnValue(true)

    await expect(waitForReady(configDir, 45_693, 'captured-start-token', makeChild(45_693)))
      .resolves.toEqual({ kind: 'not-ready' })

    expect(now).toHaveBeenCalled()
    expect(mocks.isProcessAlive).toHaveBeenCalledWith(45_693)
  })

  it('returns not-ready immediately when the launched child exits before publishing state', async () => {
    mocks.isProcessAlive.mockReturnValue(false)
    await expect(waitForReady(configDir, 45_683, 'missing-state-token', makeChild(45_683)))
      .resolves.toEqual({ kind: 'not-ready' })
  })

  it('stops its own failed-start child through the live handle when no start token exists', async () => {
    const child = makeChild(45_680)

    expect(await abandonFailedStart(configDir, child, null)).toBe(
      `Stopped the daemon that never finished starting (pid ${child.pid}).`,
    )
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(mocks.killProcessTree).not.toHaveBeenCalled()
  })

  it('force-stops its own failed-start child through the direct handle after SIGTERM times out', async () => {
    const child = makeChild(45_686)
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      if (signal === 'SIGKILL') Object.defineProperty(child, 'exitCode', { value: 0 })
      return true
    })
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(20_000)
      .mockReturnValueOnce(30_000)
      .mockReturnValueOnce(40_000)
      .mockReturnValue(50_000)

    await expect(abandonFailedStart(configDir, child, null))
      .resolves.toBe(`Stopped the daemon that never finished starting (pid ${child.pid}).`)
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(mocks.killProcessTree).not.toHaveBeenCalled()
  })

  it('reports a failed-start child that survives both direct-handle signals', async () => {
    const child = makeChild(45_687)
    child.kill = vi.fn(() => true)
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(20_000)
      .mockReturnValueOnce(30_000)
      .mockReturnValueOnce(40_000)
      .mockReturnValue(50_000)

    await expect(abandonFailedStart(configDir, child, null))
      .resolves.toContain('could not be stopped')
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(mocks.killProcessTree).not.toHaveBeenCalled()
  })

  it('leaves a live failed-start process alone when its identity cannot be verified', async () => {
    const child = makeChild(45_684)
    mocks.isProcessAlive.mockReturnValue(true)
    mocks.matchProcess.mockReturnValue({ kind: 'unknown', reason: 'the process start time is unavailable' })

    await expect(abandonFailedStart(configDir, child, 'captured-token'))
      .resolves.toContain('the process start time is unavailable')
    expect(mocks.killProcessTree).not.toHaveBeenCalled()
    expect(mocks.signalTermination).not.toHaveBeenCalled()
  })

  it('clears failed-start artifacts when its tokenless direct child has already exited', async () => {
    const child = makeChild(45_685)
    Object.defineProperty(child, 'exitCode', { value: 0 })

    await expect(abandonFailedStart(configDir, child, null)).resolves.toBeNull()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('does not signal a retained startup child when its process token is missing', async () => {
    const failure = {
      reason: 'startup-cleanup-incomplete' as const,
      at: '2026-09-28T00:00:00.000Z',
      version: '1.2.3',
      message: 'OpenCode cleanup could not be verified.',
      openCode: { baseUrl: 'http://127.0.0.1:4096', pid: 45_689 },
    }
    writeDaemonStartFailure(failure, configDir)
    const output = captureOutput()

    expect(await stopCommand()).toBe(1)
    expect(readDaemonStartFailure(configDir)).toEqual(failure)
    expect(output.stderr()).toContain('retained ownership of its previous startup')
    expect(output.stderr()).toContain('OpenCode pid 45689')
    expect(mocks.matchProcess).not.toHaveBeenCalled()
    expect(mocks.signalTermination).not.toHaveBeenCalled()
    expect(mocks.killProcessTree).not.toHaveBeenCalled()
  })

  it('keeps startup ownership when the recorded OpenCode pid belongs to another process', async () => {
    const failure = {
      reason: 'startup-cleanup-incomplete' as const,
      at: '2026-09-28T00:00:00.000Z',
      version: '1.2.3',
      message: 'OpenCode cleanup could not be verified.',
      openCode: {
        baseUrl: 'http://127.0.0.1:4096',
        pid: 45_690,
        startToken: 'original-opencode-token',
      },
    }
    writeDaemonStartFailure(failure, configDir)
    mocks.isProcessAlive.mockImplementation((pid: number) => pid === failure.openCode.pid)
    mocks.matchProcess.mockReturnValue({ kind: 'different' })
    const output = captureOutput()

    expect(await stopCommand()).toBe(1)
    expect(readDaemonStartFailure(configDir)).toEqual(failure)
    expect(output.stderr()).toContain('retained ownership of its previous startup')
    expect(mocks.matchProcess).toHaveBeenCalledWith(failure.openCode.pid, failure.openCode.startToken)
    expect(mocks.signalTermination).not.toHaveBeenCalled()
    expect(mocks.killProcessTree).not.toHaveBeenCalled()
  })

  it('rechecks process identity before force-stopping a failed-start child', async () => {
    const child = makeChild(45_691)
    const token = 'captured-start-token'
    writeDaemonState(makeState({ pid: child.pid, startToken: token }), configDir)
    mocks.isProcessAlive.mockReturnValue(true)
    mocks.matchProcess
      .mockReturnValueOnce({ kind: 'same' })
      .mockReturnValueOnce({ kind: 'same' })
      .mockReturnValueOnce({ kind: 'different' })
    mocks.signalTermination.mockReturnValue(true)
    mocks.waitForExit.mockResolvedValue(false)

    await expect(abandonFailedStart(configDir, child, token)).resolves.toBeNull()

    expect(mocks.signalTermination).toHaveBeenCalledOnce()
    expect(mocks.waitForExit).toHaveBeenCalledOnce()
    expect(mocks.killProcessTree).not.toHaveBeenCalled()
    expect(readDaemonState(configDir)).toBeNull()
  })

  it('clears a failed-start record when identity changes before any signal', async () => {
    const child = makeChild(45_692)
    const token = 'captured-start-token'
    writeDaemonState(makeState({ pid: child.pid, startToken: token }), configDir)
    mocks.isProcessAlive.mockReturnValue(true)
    mocks.matchProcess
      .mockReturnValueOnce({ kind: 'same' })
      .mockReturnValueOnce({ kind: 'different' })

    await expect(abandonFailedStart(configDir, child, token)).resolves.toBeNull()

    expect(mocks.signalTermination).not.toHaveBeenCalled()
    expect(mocks.killProcessTree).not.toHaveBeenCalled()
    expect(readDaemonState(configDir)).toBeNull()
  })

  it('restarts by starting the daemon in foreground mode after a clean stop', async () => {
    expect(await restartCommand({ foreground: true, port: 45_673 })).toBe(0)
    expect(mocks.runDaemonProcess).toHaveBeenCalledWith({ foreground: true, port: 45_673 })
  })

  it('reports a clean stop when no daemon or lock record exists', async () => {
    const output = captureOutput()

    expect(await stopCommand()).toBe(0)
    expect(output.stdout()).toBe('LoopTroop is not running.\n')
    expect(output.stderr()).toBe('')
    expect(mocks.signalTermination).not.toHaveBeenCalled()
    expect(mocks.killProcessTree).not.toHaveBeenCalled()
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
    expect(readDaemonState(configDir)).toEqual(state)
  })

  it('tries a graceful signal for a pending shutdown but retains the record when cleanup is unconfirmed', async () => {
    const state = makeState({ shutdownPending: true })
    writeDaemonState(state, configDir)
    stubFetch(() => { throw new Error('control plane is unavailable') })
    mocks.signalTermination.mockReturnValue(true)
    const output = captureOutput()

    expect(await stopCommand()).toBe(1)
    if (process.platform === 'win32') {
      expect(mocks.signalTermination).not.toHaveBeenCalled()
    } else {
      expect(mocks.signalTermination).toHaveBeenCalledWith(state.pid, null)
    }
    expect(mocks.killProcessTree).not.toHaveBeenCalled()
    expect(output.stderr()).toContain('runtime cleanup is still incomplete')
    expect(readDaemonState(configDir)).toEqual(state)
  })

  it('uses the process-tree fallback when the authenticated shutdown and signal fail', async () => {
    const state = makeState()
    writeDaemonState(state, configDir)
    stubFetch(() => { throw new Error('connection refused') })
    mocks.killProcessTree.mockResolvedValue(true)
    const output = captureOutput()

    expect(await stopCommand()).toBe(0)
    expect(mocks.killProcessTree).toHaveBeenCalledWith(state.pid, null)
    expect(output.stdout()).toContain('LoopTroop did not shut down cleanly and was killed.')
    expect(await probeRecordedDaemon(configDir)).toEqual({ kind: 'not-running' })
  })

  /**
   * A killed daemon runs no cleanup, and the OpenCode it started keeps its port
   * with a password only that daemon knew. `stop` used to clear the record and
   * leave it running, so the next start moved past its own server.
   */
  describe('the OpenCode a stopped daemon left running', () => {
    const DAEMON_PID = 99_999_998
    const OPENCODE_PID = 99_999_999

    /**
     * The pids are invented, so nothing real is signalled. `alive` is the
     * model: SIGTERM to OpenCode's group ends its leader, a tree kill ends the
     * pid it names, and the group is gone with its leader unless `survivor`
     * stands for a child that ignored the SIGTERM.
     */
    function recordLeftover(options: { daemonAlive?: boolean; survivor?: boolean } = {}) {
      const state = makeState({
        pid: DAEMON_PID,
        opencode: { baseUrl: 'http://127.0.0.1:4096', owned: true, status: 'managed', pid: OPENCODE_PID, startToken: 'opencode-token' },
      })
      writeDaemonState(state, configDir)
      const alive = new Set([OPENCODE_PID, ...(options.daemonAlive === true ? [DAEMON_PID] : [])])
      mocks.isProcessAlive.mockImplementation((pid: number) => alive.has(pid))
      mocks.killProcessTree.mockImplementation(async (pid: number) => alive.delete(pid))
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
        if (pid === -OPENCODE_PID && signal === 'SIGTERM') alive.delete(OPENCODE_PID)
        if (pid === -OPENCODE_PID && signal === 0 && !alive.has(OPENCODE_PID) && options.survivor !== true) {
          throw Object.assign(new Error('no such process group'), { code: 'ESRCH' })
        }
        return true
      })
      return { state, kill, alive }
    }

    it('is ended, and only then is its record cleared', async () => {
      const { kill } = recordLeftover()
      const output = captureOutput()

      expect(await stopCommand()).toBe(0)
      expect(output.stdout()).toContain(`Stopped the OpenCode server (pid ${OPENCODE_PID}) that LoopTroop left running.`)
      if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(-OPENCODE_PID, 'SIGTERM')
      expect(readDaemonState(configDir)).toBeNull()
    })

    it('keeps the record when it would not stop, so the next stop can retry', async () => {
      const { state } = recordLeftover()
      mocks.waitForExit.mockResolvedValue(false)
      const output = captureOutput()

      expect(await stopCommand()).toBe(1)
      expect(output.stderr()).toContain(`the OpenCode server it started (pid ${OPENCODE_PID}), or a process that server started, did not stop`)
      expect(readDaemonState(configDir)).toEqual(state)
    })

    // Leader exit alone is not proof: a child that ignored SIGTERM still
    // holds the port, and with the record gone nothing would name it.
    it.skipIf(process.platform === 'win32')('keeps the record while a process it started is still running', async () => {
      const { state, alive } = recordLeftover({ survivor: true })
      const output = captureOutput()

      expect(await stopCommand()).toBe(1)
      expect(alive.has(OPENCODE_PID)).toBe(false)
      expect(output.stderr()).toContain('or a process that server started, did not stop')
      expect(readDaemonState(configDir)).toEqual(state)
    })

    it('is never signalled once its pid belongs to something else', async () => {
      const { kill } = recordLeftover()
      mocks.matchProcess.mockReturnValue({ kind: 'different' })
      captureOutput()

      expect(await stopCommand()).toBe(0)
      expect(kill).not.toHaveBeenCalled()
      expect(mocks.killProcessTree).not.toHaveBeenCalled()
      expect(readDaemonState(configDir)).toBeNull()
    })

    // `start` refuses this record; clearing it here let the next start treat
    // LoopTroop's own server as someone else's and move past it.
    it('keeps the record, and signals nothing, when its identity cannot be read', async () => {
      const { state, kill } = recordLeftover()
      mocks.matchProcess.mockReturnValue({ kind: 'unknown', reason: 'no start-identity token was recorded for it' })
      const output = captureOutput()

      expect(await stopCommand()).toBe(1)
      expect(kill).not.toHaveBeenCalled()
      expect(mocks.killProcessTree).not.toHaveBeenCalled()
      expect(output.stderr()).toContain(`pid ${OPENCODE_PID}, recorded as the OpenCode server it started, could not be checked: no start-identity token was recorded for it`)
      expect(output.stderr()).toContain(`If pid ${OPENCODE_PID} is that OpenCode server, end it, then run \`looptroop stop\` again.`)
      expect(readDaemonState(configDir)).toEqual(state)
    })

    // OpenCode leads its own process group, so the kill that ends a daemon
    // which would not stop does not reach it.
    it('is ended before the record goes when the daemon itself had to be killed', async () => {
      const { kill } = recordLeftover({ daemonAlive: true })
      stubFetch(() => { throw new Error('connection refused') })
      const output = captureOutput()

      expect(await stopCommand()).toBe(0)
      expect(mocks.killProcessTree).toHaveBeenCalledWith(DAEMON_PID, null)
      if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(-OPENCODE_PID, 'SIGTERM')
      expect(output.stdout()).toContain(`Stopped the OpenCode server (pid ${OPENCODE_PID}) that LoopTroop left running.`)
      expect(output.stdout()).toContain('LoopTroop did not shut down cleanly and was killed.')
      expect(readDaemonState(configDir)).toBeNull()
    })

    it('keeps the record when the daemon had to be killed and its OpenCode will not stop', async () => {
      const { state } = recordLeftover({ daemonAlive: true })
      stubFetch(() => { throw new Error('connection refused') })
      mocks.waitForExit.mockImplementation(async (pid: number) => pid !== OPENCODE_PID)
      const output = captureOutput()

      expect(await stopCommand()).toBe(1)
      expect(output.stderr()).toContain(`the OpenCode server it started (pid ${OPENCODE_PID}), or a process that server started, did not stop`)
      expect(readDaemonState(configDir)).toEqual(state)
    })

    // "Nothing was stopped" has to be true when it is printed.
    it('touches nothing while another process holds the lock', async () => {
      const { state, kill, alive } = recordLeftover()
      alive.add(process.pid)
      const lock = acquireDaemonLock(configDir)
      const output = captureOutput()

      try {
        expect(await stopCommand()).toBe(1)
      } finally {
        lock.release()
      }
      expect(output.stderr()).toContain('Nothing was stopped')
      expect(kill).not.toHaveBeenCalled()
      expect(mocks.killProcessTree).not.toHaveBeenCalled()
      expect(readDaemonState(configDir)).toEqual(state)
    })
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
  it('prints the sign-in link when the browser opens but never spends its nonce', async () => {
    const state = makeState()
    writeDaemonState(state, configDir)
    stubFetch((url) => {
      if (url.pathname === '/api/health') return jsonResponse({ instanceId: state.instanceId })
      if (url.pathname === '/api/auth/bootstrap') return jsonResponse({ nonce: 'single-use-nonce' })
      if (url.pathname === '/api/auth/bootstrap/status') return jsonResponse({ pending: true })
      throw new Error(`Unexpected daemon request: ${url.pathname}`)
    })
    const output = captureOutput()

    expect(await openCommand({ open: () => ({ opened: true }), waitMs: 1 })).toBe(0)
    expect(output.stdout()).toContain('No browser signed in. If none opened, use this link:')
    expect(output.stdout()).toContain('http://127.0.0.1:4317/#bootstrap=single-use-nonce')
  })

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

  it('does not print the nonce when the browser sign-in check cannot reach the daemon', async () => {
    const state = makeState()
    writeDaemonState(state, configDir)
    stubFetch((url) => {
      if (url.pathname === '/api/health') return jsonResponse({ instanceId: state.instanceId })
      if (url.pathname === '/api/auth/bootstrap') return jsonResponse({ nonce: 'private-nonce' })
      if (url.pathname === '/api/auth/bootstrap/status') throw new Error('connection reset')
      throw new Error(`Unexpected daemon request: ${url.pathname}`)
    })
    const output = captureOutput()

    expect(await openCommand({ open: () => ({ opened: true }), waitMs: 10 })).toBe(0)
    expect(output.stdout()).toContain('Opened http://127.0.0.1:4317')
    expect(output.stdout()).not.toContain('private-nonce')
    expect(output.stdout()).not.toContain('No browser signed in')
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

  it('says where OpenCode went whether or not it started the daemon', async () => {
    const movedFrom = { baseUrl: 'http://127.0.0.1:4096', reason: 'OpenCode requires a password, and none is configured (HTTP 401).' }
    const opencode = { baseUrl: 'http://127.0.0.1:4098', owned: true, status: 'managed' as const, pid: 4242, movedFrom }
    const line = 'OpenCode runs at http://127.0.0.1:4098 because http://127.0.0.1:4096 was taken by another server when '
      + 'LoopTroop started: OpenCode requires a password, and none is configured (HTTP 401).'
    const child = makeChild(45_677)
    const state = makeState({ pid: child.pid, startToken: 'test-start-token', opencode })
    startDaemonOnSpawn(state, child)
    stubDaemonFetch(state, [])
    const started = captureOutput()

    expect(await openCommand({ printUrl: true })).toBe(0)
    expect(started.stdout()).toContain(`LoopTroop is not running. Starting it...\n\n${line}\n`)
    restoreOutput()

    // Already running: `open` is how people come back to it, and nothing else
    // on its screen says where OpenCode is.
    const running = captureOutput()
    expect(await openCommand({ printUrl: true })).toBe(0)
    expect(running.stdout()).toContain(`\n${line}\n`)
    restoreOutput()

    const startedAgain = captureOutput()
    expect(await startCommand()).toBe(0)
    expect(startedAgain.stdout()).toContain('LoopTroop is already running')
    expect(startedAgain.stdout()).toContain(`\n${line}\n`)
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

  it('returns an asynchronous browser spawn error and settles the child once', async () => {
    const child = makeChild(45_688)
    mocks.spawn.mockReturnValue(child)
    const pending = openInBrowser('http://127.0.0.1:4317')

    child.emit('error', new Error('browser launch failed'))
    child.emit('exit', 0)

    await expect(pending).resolves.toEqual({ opened: false, reason: 'browser launch failed' })
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('selects the native browser opener for each supported platform', () => {
    const url = 'https://example.test/#token'

    expect(browserOpener(url, 'darwin')).toEqual({ command: 'open', args: [url] })
    expect(browserOpener(url, 'win32')).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    })
    expect(browserOpener(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] })
  })
})
