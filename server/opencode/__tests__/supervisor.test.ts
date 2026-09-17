import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  OpenCodeSupervisor,
  type ProcessTermination,
} from '../supervisor'

function fakeChild(pid: number): EventEmitter & Pick<ChildProcess, 'pid' | 'exitCode'> {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
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

  it('strips daemon credentials while retaining OpenCode provider credentials', async () => {
    const ambient = process.env.LOOPTROOP_API_TOKEN
    const provider = process.env.OPENCODE_SERVER_PASSWORD
    process.env.LOOPTROOP_API_TOKEN = 'ambient-daemon-token'
    process.env.OPENCODE_SERVER_PASSWORD = 'provider-password'
    const child = fakeChild(4100)
    const spawnProcess = vi.fn((..._args: unknown[]) => child)
    const { termination } = terminationProbe()
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => false,
      spawnProcess: spawnProcess as never,
      resolveProgram: () => '/opt/opencode',
      termination,
      readyTimeoutMs: 0,
      exitBudgets: { gracefulMs: 0, forceMs: 0 },
    })

    try {
      await expect(supervisor.start()).rejects.toThrow('did not become reachable')
      const options = spawnProcess.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined
      expect(options?.env?.LOOPTROOP_API_TOKEN).toBeUndefined()
      expect(options?.env?.OPENCODE_SERVER_PASSWORD).toBe('provider-password')
      expect(process.env.LOOPTROOP_API_TOKEN).toBe('ambient-daemon-token')
    } finally {
      if (ambient === undefined) delete process.env.LOOPTROOP_API_TOKEN
      else process.env.LOOPTROOP_API_TOKEN = ambient
      if (provider === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = provider
      await supervisor.stop()
    }
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
