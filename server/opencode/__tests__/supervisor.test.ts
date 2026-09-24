import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultTermination,
  OpenCodeSupervisor,
  type ProcessTermination,
} from '../supervisor'
import { invalidateOpenCodeConnection } from '../connection'

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
