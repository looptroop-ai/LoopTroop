import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { OpenCodeSupervisor, OpenCodeMissingError } from '../server/opencode/supervisor'

/**
 * 2.10 contract: an already-running server is adopted untouched; a missing
 * binary fails loudly; a crash triggers a bounded restart then degradation; and
 * stop() touches only a server the supervisor started.
 */
describe('OpenCode supervision', () => {
  function makeBaseUrl(): string {
    return `http://127.0.0.1:${40000 + Math.floor(Math.random() * 10000)}`
  }

  function makeChild() {
    const child = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null; killed: boolean }
    child.pid = 12345
    child.exitCode = null
    child.killed = false
    return child
  }

  it('adopts an already-running server without starting one', async () => {
    const baseUrl = makeBaseUrl()
    const spawned: string[] = []

    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => {
        const child = makeChild()
        spawned.push('spawned')
        return child as never
      }) as never,
      probe: async () => true,
    })

    const status = await supervisor.start()
    expect(status).toEqual({ kind: 'adopted', baseUrl })
    expect(spawned).toEqual([])
    expect(supervisor.current).toEqual(status)
  })

  it('starts OpenCode when nothing is reachable', async () => {
    const baseUrl = makeBaseUrl()
    const child = makeChild()
    let spawned = 0

    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => {
        spawned += 1
        return child as never
      }) as never,
      probe: async () => {
        // First probe fails (nothing running), then the server appears.
        return spawned > 0
      },
    })

    const status = await supervisor.start()
    expect(status).toEqual({ kind: 'managed', baseUrl, pid: child.pid })
    expect(spawned).toBe(1)
  })

  it('fails loudly when the binary is missing', async () => {
    const baseUrl = makeBaseUrl()

    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => {
        const child = makeChild()
        // Simulate spawn emitting the error event for a missing executable.
        queueMicrotask(() => child.emit('error', new Error('spawn opencode ENOENT')))
        return child as never
      }) as never,
      probe: async () => false,
    })

    await expect(supervisor.start()).rejects.toThrow(OpenCodeMissingError)
  })

  it('restarts a bounded number of times, then degrades', async () => {
    const baseUrl = makeBaseUrl()
    let spawned = 0

    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => {
        const child = makeChild()
        spawned += 1
        // Crash only after start() has observed a healthy server, so the exit
        // is treated as an unexpected death rather than a failed launch.
        setTimeout(() => child.emit('exit', 1), 5)
        return child as never
      }) as never,
      // Unreachable until something is spawned, so the first call starts a
      // server rather than adopting one.
      probe: async () => spawned > 0,
    })

    const initial = await supervisor.start()
    expect(initial.kind).toBe('managed')

    // Backoff is one second per attempt, so three attempts need at least six
    // seconds before the supervisor gives up.
    await new Promise((done) => setTimeout(done, 9_000))

    expect(spawned).toBeGreaterThan(1)
    expect(supervisor.current.kind).toBe('degraded')
  }, 20_000)

  it('stops only a server it started, never an adopted one', async () => {
    const baseUrl = makeBaseUrl()

    // Adopted: nothing was spawned, so stop must not signal anything.
    const adoptedChild = makeChild()
    let adoptedKilled = false
    ;(adoptedChild as { kill?: () => boolean }).kill = () => {
      adoptedKilled = true
      return true
    }

    const adopted = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => adoptedChild) as never,
      probe: async () => true,
    })
    await adopted.start()
    await adopted.stop()
    expect(adoptedKilled).toBe(false)

    // Managed: this supervisor spawned it, so stop takes it down.
    const managedChild = makeChild()
    let managedKilled = false
    ;(managedChild as { kill?: () => boolean }).kill = () => {
      managedKilled = true
      return true
    }

    let spawnedManaged = false
    const managed = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => {
        spawnedManaged = true
        return managedChild as never
      }) as never,
      // Unreachable until spawned, then healthy.
      probe: async () => spawnedManaged,
    })

    const status = await managed.start()
    expect(status.kind).toBe('managed')

    await managed.stop()
    expect(managedKilled).toBe(true)
  })
})
