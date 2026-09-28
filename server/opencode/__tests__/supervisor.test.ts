import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminateProcessTree } from '../../lib/processTree'
import {
  defaultTermination,
  OpenCodeSupervisor,
  type ProcessTermination,
} from '../supervisor'
import { invalidateOpenCodeConnection } from '../connection'

vi.mock('../../lib/processTree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/processTree')>()
  return { ...actual, terminateProcessTree: vi.fn() }
})

const originalAuthEnv = {
  OPENCODE_PASSWORD: process.env.OPENCODE_PASSWORD,
  OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const [key, value] of Object.entries(originalAuthEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  invalidateOpenCodeConnection()
})

function fakeChild(pid: number, exitCode: number | null = null): EventEmitter & {
  pid: number
  exitCode: number | null
} {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode,
  })
}

function fetchFailure(code: string): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connection failed'), { code }),
  })
}

function terminationProbe() {
  const exited = new Set<number>()
  const termination: ProcessTermination = {
    request: vi.fn((pid: number) => {
      exited.add(pid)
      return true
    }),
    force: vi.fn(async (pid: number) => {
      exited.add(pid)
    }),
    hasExited: (pid: number) => exited.has(pid),
  }
  return { termination, exited }
}

describe('OpenCodeSupervisor', () => {
  it('waits for Windows tree termination proof after its leader exits', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!platformDescriptor?.configurable) throw new Error('process.platform cannot be stubbed in this test runtime')

    const child = Object.assign(fakeChild(4301), { kill: vi.fn() })
    const taskkill = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      kill: vi.fn(),
    })
    let probes = 0
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => ++probes > 1,
      spawnProcess: (() => child) as never,
      resolveProgram: () => '/opt/opencode',
      exitBudgets: { gracefulMs: 100, forceMs: 100 },
    })

    try {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
      await supervisor.start()
      vi.mocked(terminateProcessTree).mockImplementationOnce(() => taskkill as unknown as ChildProcess)

      let stopped = false
      const stopping = supervisor.stop().then((result) => {
        stopped = true
        return result
      })
      child.exitCode = 0
      child.emit('exit', 0)
      await Promise.resolve()

      expect(stopped).toBe(false)
      expect(taskkill.kill).not.toHaveBeenCalled()
      taskkill.exitCode = 0
      taskkill.emit('exit', 0)

      await expect(stopping).resolves.toBe(true)
      expect(terminateProcessTree).toHaveBeenCalledWith(child, 'SIGTERM', 'windows')
      expect(child.kill).not.toHaveBeenCalled()
      expect(supervisor.ownedProcess).toBeNull()
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('retains the Windows child handle when graceful and forced tree cleanup fail', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!platformDescriptor?.configurable) throw new Error('process.platform cannot be stubbed in this test runtime')

    const child = Object.assign(fakeChild(4309), { kill: vi.fn() })
    const gracefulTaskkill = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      kill: vi.fn(),
    })
    const forceTaskkill = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      kill: vi.fn(),
    })
    let probes = 0
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => ++probes > 1,
      spawnProcess: (() => child) as never,
      resolveProgram: () => '/opt/opencode',
      exitBudgets: { gracefulMs: 100, forceMs: 100 },
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
      await supervisor.start()
      vi.mocked(terminateProcessTree)
        .mockImplementationOnce((_ownedChild, signal) => {
          expect(signal).toBe('SIGTERM')
          queueMicrotask(() => {
            gracefulTaskkill.exitCode = 1
            gracefulTaskkill.emit('exit', 1)
          })
          return gracefulTaskkill as unknown as ChildProcess
        })
        .mockImplementationOnce((_ownedChild, signal) => {
          expect(signal).toBe('SIGKILL')
          queueMicrotask(() => forceTaskkill.emit('error', new Error('taskkill failed')))
          return forceTaskkill as unknown as ChildProcess
        })

      await expect(supervisor.stop()).resolves.toBe(false)

      expect(terminateProcessTree).toHaveBeenCalledTimes(2)
      expect(gracefulTaskkill.kill).not.toHaveBeenCalled()
      expect(forceTaskkill.kill).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
      expect(supervisor.ownedProcess).toEqual({ pid: 4309, startToken: null })
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
      consoleError.mockRestore()
    }
  })

  it('waits for a POSIX descendant group after its leader exits', () => {
    if (process.platform === 'win32') return

    let groupAlive = true
    const processKill = vi.spyOn(process, 'kill').mockImplementation(((pid, signal) => {
      if (pid === 4242 && signal === 0) {
        throw Object.assign(new Error('leader exited'), { code: 'ESRCH' })
      }
      if (pid === -4242 && signal === 0) {
        if (groupAlive) return undefined as never
        throw Object.assign(new Error('group exited'), { code: 'ESRCH' })
      }
      throw Object.assign(new Error('unexpected process probe'), { code: 'ESRCH' })
    }) as typeof process.kill)

    try {
      expect(defaultTermination.hasExited(4242, 'leader-start')).toBe(false)
      groupAlive = false
      expect(defaultTermination.hasExited(4242, 'leader-start')).toBe(true)
    } finally {
      processKill.mockRestore()
    }
  })

  it('adopts a healthy server without spawning or stopping it', async () => {
    const spawnProcess = vi.fn()
    const { termination } = terminationProbe()
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => true,
      spawnProcess: spawnProcess as never,
      resolveProgram: () => '/opt/opencode',
      termination,
    })

    await expect(supervisor.start()).resolves.toEqual({
      kind: 'adopted',
      baseUrl: 'http://127.0.0.1:4096',
    })
    await supervisor.stop()

    expect(spawnProcess).not.toHaveBeenCalled()
    expect(termination.request).not.toHaveBeenCalled()
    expect(termination.force).not.toHaveBeenCalled()
  })

  it('does not launch over a server that rejects authentication', async () => {
    vi.stubEnv('OPENCODE_PASSWORD', 'wrong-password')
    const spawnProcess = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      spawnProcess: spawnProcess as never,
      resolveProgram: () => '/opt/opencode',
    })

    await expect(supervisor.start()).rejects.toMatchObject({ failureKind: 'authentication', status: 401 })
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('does not launch over an occupied port serving an unsupported protocol', async () => {
    const spawnProcess = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>other service</html>', {
      headers: { 'content-type': 'text/html' },
    })))
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      spawnProcess: spawnProcess as never,
      resolveProgram: () => '/opt/opencode',
    })

    await expect(supervisor.start()).rejects.toMatchObject({ failureKind: 'unsupported_protocol' })
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('retries transient network responses while an existing server becomes ready', async () => {
    let probes = 0
    const fetchMock = vi.fn(async () => {
      probes += 1
      return probes < 3
        ? new Response('', { status: 503 })
        : new Response(JSON.stringify({ version: '2.0.15', pid: 812 }), {
            headers: { 'content-type': 'application/json' },
          })
    })
    vi.stubGlobal('fetch', fetchMock)
    const supervisor = new OpenCodeSupervisor({ baseUrl: 'http://127.0.0.1:4096', readyTimeoutMs: 2_000 })

    await expect(supervisor.start()).resolves.toEqual({ kind: 'adopted', baseUrl: 'http://127.0.0.1:4096' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps polling after a transient network failure during managed startup', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(fetchFailure('ECONNREFUSED'))
      .mockRejectedValueOnce(fetchFailure('ECONNRESET'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '2.0.15', pid: 813 }), {
        headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const child = fakeChild(4302)
    const { termination } = terminationProbe()
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      spawnProcess: (() => child) as never,
      resolveProgram: () => '/opt/opencode',
      termination,
      readyTimeoutMs: 2_000,
    })

    await expect(supervisor.start()).resolves.toEqual({
      kind: 'managed',
      baseUrl: 'http://127.0.0.1:4096',
      pid: 4302,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await supervisor.stop()
  })

  it('cleans up a child when its spawn error races the health probe', async () => {
    const child = fakeChild(4303)
    const { termination } = terminationProbe()
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => false,
      spawnProcess: (() => {
        queueMicrotask(() => child.emit('error', new Error('spawn failed')))
        return child
      }) as never,
      resolveProgram: () => '/opt/opencode',
      termination,
      readyTimeoutMs: 2_000,
    })

    await expect(supervisor.start()).rejects.toMatchObject({ name: 'OpenCodeMissingError' })
    expect(termination.request).toHaveBeenCalledWith(4303, null)
    expect(supervisor.ownedProcess).toBeNull()
    await expect(supervisor.stop()).resolves.toBe(true)
  })

  it('rejects startup when stop makes the child exit during its health wait', async () => {
    const child = fakeChild(4308)
    let resolveSpawned!: () => void
    const spawned = new Promise<void>((resolve) => { resolveSpawned = resolve })
    const termination: ProcessTermination = {
      request: vi.fn(() => true),
      force: vi.fn(async () => undefined),
      hasExited: vi.fn(() => {
        if (child.exitCode === null) {
          child.exitCode = 0
          child.emit('exit', 0)
        }
        return true
      }),
    }
    let probes = 0
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => ++probes === 1 ? false : new Promise<boolean>(() => {}),
      spawnProcess: (() => {
        resolveSpawned()
        return child
      }) as never,
      resolveProgram: () => '/opt/opencode',
      termination,
    })
    const starting = supervisor.start()

    await spawned
    await expect(supervisor.stop()).resolves.toBe(true)
    await expect(starting).rejects.toThrow('OpenCode exited with code 0')

    expect(termination.request).toHaveBeenCalledWith(4308, null)
    expect(supervisor.ownedProcess).toBeNull()
  })

  it('shares an in-memory ephemeral password with a managed child when no password was supplied', async () => {
    delete process.env.OPENCODE_PASSWORD
    delete process.env.OPENCODE_SERVER_PASSWORD
    const child = fakeChild(4401)
    const { termination } = terminationProbe()
    let probes = 0
    let childEnv: NodeJS.ProcessEnv | undefined
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => ++probes > 1,
      spawnProcess: ((_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        childEnv = options?.env as NodeJS.ProcessEnv
        return child
      }) as never,
      resolveProgram: () => '/opt/opencode',
      termination,
    })

    await expect(supervisor.start()).resolves.toMatchObject({ kind: 'managed', pid: 4401 })
    expect(childEnv?.OPENCODE_PASSWORD).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(childEnv?.OPENCODE_SERVER_PASSWORD).toBe(childEnv?.OPENCODE_PASSWORD)
    await supervisor.stop()
  })

  it('generates a password when configured password aliases are blank', async () => {
    vi.stubEnv('OPENCODE_PASSWORD', '   ')
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', '')
    const child = fakeChild(4402)
    const { termination } = terminationProbe()
    let probes = 0
    let childEnv: NodeJS.ProcessEnv | undefined
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => ++probes > 1,
      spawnProcess: ((_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        childEnv = options?.env as NodeJS.ProcessEnv
        return child
      }) as never,
      resolveProgram: () => '/opt/opencode',
      termination,
    })

    await expect(supervisor.start()).resolves.toMatchObject({ kind: 'managed', pid: 4402 })
    expect(childEnv?.OPENCODE_PASSWORD).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(childEnv?.OPENCODE_SERVER_PASSWORD).toBe(childEnv?.OPENCODE_PASSWORD)
    await supervisor.stop()
  })

  it('cleans up a child when health never becomes ready', async () => {
    const child = fakeChild(4101)
    const { termination } = terminationProbe()
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => false,
      spawnProcess: (() => child) as never,
      resolveProgram: () => '/opt/opencode',
      readyTimeoutMs: 0,
      termination,
      exitBudgets: { gracefulMs: 0, forceMs: 0 },
    })

    await expect(supervisor.start()).rejects.toThrow('did not become reachable')
    expect(termination.request).toHaveBeenCalledWith(4101, null)
    expect(termination.force).not.toHaveBeenCalled()
    await supervisor.stop()
  })

  it('uses the spawned child handle when its start token is unavailable', async () => {
    const child = Object.assign(fakeChild(4105), { kill: vi.fn() })
    const exited = new Set<number>()
    child.kill.mockImplementation(() => {
      exited.add(4105)
      return true
    })
    const termination: ProcessTermination = {
      request: vi.fn(() => false),
      force: vi.fn(async () => undefined),
      hasExited: (pid) => exited.has(pid),
    }
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => false,
      spawnProcess: (() => child) as never,
      resolveProgram: () => '/opt/opencode',
      termination,
      readyTimeoutMs: 0,
      exitBudgets: { gracefulMs: 0, forceMs: 0 },
    })

    await expect(supervisor.start()).rejects.toThrow('did not become reachable')
    // Windows uses taskkill /T for the owned tree; the fake child has no real
    // taskkill target, so only the POSIX direct-handle fallback is observable.
    if (process.platform === 'win32') {
      expect(child.kill).not.toHaveBeenCalled()
    } else {
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    }
  })

  it('retains a failed cleanup handle for a later stop retry', async () => {
    const child = fakeChild(4106)
    const termination: ProcessTermination = {
      request: vi.fn(() => false),
      force: vi.fn(async () => undefined),
      hasExited: vi.fn(() => false),
    }
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => false,
      spawnProcess: (() => child) as never,
      resolveProgram: () => '/opt/opencode',
      termination,
      readyTimeoutMs: 0,
      exitBudgets: { gracefulMs: 0, forceMs: 0 },
    })

    await expect(supervisor.start()).rejects.toThrow('did not become reachable')
    expect(termination.force).toHaveBeenCalledTimes(1)

    await expect(supervisor.stop()).resolves.toBe(false)
    expect(termination.force).toHaveBeenCalledTimes(2)

    // A later retry may finally prove the child gone; the failed attempt must
    // not poison the supervisor's ownership state.
    termination.hasExited = vi.fn(() => true)
    await expect(supervisor.stop()).resolves.toBe(true)
    expect(termination.force).toHaveBeenCalledTimes(3)
  })

  it('retains a healthy leader handle while descendants remain after exit', async () => {
    const child = Object.assign(fakeChild(4108), { kill: vi.fn() })
    let descendantsGone = false
    let leaderExited = false
    const termination: ProcessTermination = {
      request: vi.fn(() => false),
      force: vi.fn(async () => undefined),
      hasExited: vi.fn(() => {
        if (!leaderExited) {
          leaderExited = true
          child.exitCode = 1
          child.emit('exit', 1)
        }
        return descendantsGone
      }),
    }
    let spawned = false
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => spawned,
      spawnProcess: (() => {
        spawned = true
        return child
      }) as never,
      resolveProgram: () => '/opt/opencode',
      termination,
      exitBudgets: { gracefulMs: 0, forceMs: 0 },
    })

    await supervisor.start()
    await expect(supervisor.stop()).resolves.toBe(false)
    expect(supervisor.ownedProcess).toEqual({ pid: 4108, startToken: null })

    descendantsGone = true
    await expect(supervisor.stop()).resolves.toBe(true)
    expect(supervisor.ownedProcess).toBeNull()
  })

  it('forces token-proven cleanup again after the leader has exited', async () => {
    const child = fakeChild(4107, 1)
    const force = vi.fn(async () => undefined)
    const termination: ProcessTermination = {
      request: vi.fn(() => false),
      force,
      hasExited: vi.fn(() => true),
    }
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      termination,
    })
    ;(supervisor as unknown as {
      child: { process: ChildProcess; pid: number; startToken: string } | null
    }).child = {
      process: child as unknown as ChildProcess,
      pid: child.pid,
      startToken: 'leader-start',
    }

    await supervisor.stop()

    expect(force).toHaveBeenCalledWith(4107, 'leader-start')
  })

  it('forces a child when graceful termination is not confirmed', async () => {
    const child = fakeChild(4102)
    const force = vi.fn(async () => undefined)
    let firstProbe = true
    const termination: ProcessTermination = {
      request: vi.fn(() => false),
      force,
      hasExited: vi.fn(() => true),
    }
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => {
        if (firstProbe) {
          firstProbe = false
          return false
        }
        return true
      },
      spawnProcess: (() => child) as never,
      resolveProgram: () => '/opt/opencode',
      termination,
      exitBudgets: { gracefulMs: 0, forceMs: 0 },
    })

    await supervisor.start()
    await supervisor.stop()

    expect(force).toHaveBeenCalledWith(4102, null)
  })

  it('reports a restarted child under its new pid', async () => {
    const first = fakeChild(4103)
    const second = fakeChild(4104)
    const children = [first, second]
    const { termination } = terminationProbe()
    const spawnProcess = vi.fn(() => children.shift()!)
    const statuses: string[] = []
    let probeCalls = 0
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => {
        probeCalls += 1
        return probeCalls > 1
      },
      spawnProcess: spawnProcess as never,
      resolveProgram: () => '/opt/opencode',
      termination,
      restartBackoffMs: 0,
      onStatusChange: (status) => statuses.push(status.kind === 'managed' ? `managed:${status.pid}` : status.kind),
    })

    await supervisor.start()
    first.emit('exit', 1)
    await vi.waitFor(() => expect(supervisor.current).toEqual({
      kind: 'managed',
      baseUrl: 'http://127.0.0.1:4096',
      pid: 4104,
    }))

    expect(spawnProcess).toHaveBeenCalledTimes(2)
    expect(statuses).toContain('managed:4104')
    await supervisor.stop()
  })

  it('reports restart exhaustion even when the status listener throws', async () => {
    const firstChild = fakeChild(4304)
    const children = [firstChild, fakeChild(4305), fakeChild(4306), fakeChild(4307)]
    const { termination } = terminationProbe()
    const spawnProcess = vi.fn(() => children.shift()!)
    const onStatusChange = vi.fn(() => { throw new Error('status storage is unavailable') })
    let probes = 0
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => ++probes === 2,
      spawnProcess: spawnProcess as never,
      resolveProgram: () => '/opt/opencode',
      termination,
      readyTimeoutMs: 100,
      restartBackoffMs: 0,
      onStatusChange,
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await supervisor.start()
      firstChild.emit('exit', 1)

      await vi.waitFor(() => expect(supervisor.current).toMatchObject({
        kind: 'degraded',
        reason: 'OpenCode exited 3 times; giving up. Coding operations are unavailable.',
      }), { timeout: 5_000 })

      expect(spawnProcess).toHaveBeenCalledTimes(4)
      expect(onStatusChange).toHaveBeenCalledTimes(4)
      expect(onStatusChange).toHaveBeenLastCalledWith(supervisor.current)
      await expect(supervisor.stop()).resolves.toBe(true)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('rejects a managed launch whose child has no process id', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      kill: vi.fn(),
    })
    let firstProbe = true
    const { termination } = terminationProbe()
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => {
        if (firstProbe) {
          firstProbe = false
          return false
        }
        return true
      },
      spawnProcess: (() => child) as never,
      resolveProgram: () => '/opt/opencode',
      termination,
      readyTimeoutMs: 100,
    })

    await expect(supervisor.start()).rejects.toThrow('reported no process id')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(termination.request).not.toHaveBeenCalled()
    expect(termination.force).not.toHaveBeenCalled()
  })
})
