import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  defaultTermination,
  OpenCodeMissingError,
  OpenCodeSupervisor,
  probeOpenCode,
  type ProcessTermination,
} from '../supervisor'

function fakeChild(pid: number | undefined) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
  })
}

function confirmedTermination(exited = true): ProcessTermination {
  return {
    request: () => true,
    force: async () => undefined,
    hasExited: () => exited,
  }
}

describe('OpenCode supervisor coverage edges', () => {
  it('returns a boolean for healthy and unreachable OpenCode probes', async () => {
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '2.0.15', pid: 812 }), {
        headers: { 'content-type': 'application/json' },
      })))
      await expect(probeOpenCode('http://127.0.0.1:4096')).resolves.toBe(true)

      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
      await expect(probeOpenCode('http://127.0.0.1:4096')).resolves.toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not probe or spawn in mock mode', async () => {
    const probe = vi.fn(async () => false)
    const spawnProcess = vi.fn()
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      mock: true,
      probe,
      spawnProcess: spawnProcess as never,
    })

    await expect(supervisor.start()).resolves.toEqual({ kind: 'mock' })
    expect(supervisor.current).toEqual({ kind: 'mock' })
    expect(probe).not.toHaveBeenCalled()
    expect(spawnProcess).not.toHaveBeenCalled()
    await expect(supervisor.stop()).resolves.toBe(true)
  })

  it('keeps missing-binary and refused-binary guidance distinct', () => {
    const missing = new OpenCodeMissingError('http://127.0.0.1:4096')
    const refused = new OpenCodeMissingError('http://127.0.0.1:4096', 'executable is outside trusted paths')

    expect(missing.name).toBe('OpenCodeMissingError')
    expect(missing.message).toContain('command was not found on PATH or in an OpenCode installation directory')
    expect(missing.message).toContain('LOOPTROOP_OPENCODE_BASE_URL')
    expect(missing.message).toContain('OPENCODE_PASSWORD')
    expect(refused.message).toContain('OpenCode is not running at http://127.0.0.1:4096: executable is outside trusted paths')
    // OpenCode v2 makes up a password for every server started by hand, so
    // LoopTroop could never sign in to one it was told to go and start.
    for (const message of [missing.message, refused.message]) expect(message).not.toContain('opencode serve')
  })

  it('normalizes localhost and uses the default HTTPS port when it launches a server', async () => {
    const child = fakeChild(5401)
    let probes = 0
    let launchedArgs: string[] | undefined
    const spawnProcess = vi.fn((_program: string, args: string[]) => {
      launchedArgs = args
      return child
    })
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'https://localhost',
      probe: async () => ++probes > 1,
      spawnProcess: spawnProcess as never,
      resolveProgram: () => '/opt/opencode',
      termination: confirmedTermination(),
    })

    await expect(supervisor.start()).resolves.toEqual({ kind: 'managed', baseUrl: 'https://localhost', pid: 5401 })
    expect(launchedArgs).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '443'])
    expect(supervisor.current).toMatchObject({ kind: 'managed', pid: 5401 })
    child.exitCode = 0
    await expect(supervisor.stop()).resolves.toBe(true)
  })

  it('rejects unsafe URL host names before looking for or spawning OpenCode', async () => {
    const resolveProgram = vi.fn(() => '/opt/opencode')
    const spawnProcess = vi.fn()
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://foo&bar:4096',
      probe: async () => false,
      spawnProcess: spawnProcess as never,
      resolveProgram,
    })

    await expect(supervisor.start()).rejects.toThrow('host name LoopTroop will not start a server for')
    expect(resolveProgram).not.toHaveBeenCalled()
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('does not signal a live process whose start token does not match', async () => {
    const staleToken = 'not-the-current-process-start-token'
    expect(defaultTermination.request(process.pid, staleToken)).toBe(false)
    await defaultTermination.force(process.pid, staleToken)
    expect(defaultTermination.hasExited(process.pid, staleToken)).toBe(false)
  })

  it.skipIf(process.platform !== 'linux')('requires tree proof before treating a vanished Windows PID as stopped', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!platformDescriptor?.configurable) return

    try {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
      expect(defaultTermination.hasExited(process.pid, 'stale-windows-token')).toBe(false)
      expect(defaultTermination.hasExited(2_147_483_647, 'no-tree-proof')).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('retains an unverified startup child instead of overwriting it on another start', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 5402,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    })
    let exitedIsConfirmed = false
    const termination: ProcessTermination = {
      request: () => false,
      force: async () => undefined,
      hasExited: () => exitedIsConfirmed,
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => false,
      spawnProcess: (() => child) as never,
      resolveProgram: () => '/opt/opencode',
      termination,
      readyTimeoutMs: 0,
      exitBudgets: { gracefulMs: 0, forceMs: 0 },
    })

    try {
      await expect(supervisor.start()).rejects.toThrow('did not become reachable')
      expect(supervisor.ownedProcess).toEqual({ pid: 5402, startToken: null })
      await expect(supervisor.start()).rejects.toThrow('is still running at http://127.0.0.1:4096')
      expect(supervisor.ownedProcess).toEqual({ pid: 5402, startToken: null })

      child.exitCode = 0
      exitedIsConfirmed = true
      await expect(supervisor.stop()).resolves.toBe(true)
      expect(supervisor.ownedProcess).toBeNull()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('kills a spawned child that has no pid instead of reporting it as managed', async () => {
    const child = fakeChild(undefined)
    let probes = 0
    const supervisor = new OpenCodeSupervisor({
      baseUrl: 'http://127.0.0.1:4096',
      probe: async () => ++probes > 1,
      spawnProcess: (() => child) as never,
      resolveProgram: () => '/opt/opencode',
    })

    await expect(supervisor.start()).rejects.toThrow('reported no process id')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(supervisor.ownedProcess).toBeNull()
  })
})
