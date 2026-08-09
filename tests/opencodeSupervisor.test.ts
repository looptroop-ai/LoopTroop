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

  /**
   * Records what would have been signalled instead of signalling it. These
   * children carry an invented pid, so a real `process.kill` would aim at
   * whatever process group holds that number on the machine running the suite.
   */
  function makeKillRecorder(): { calls: number[]; kill: (pid: number, signal: NodeJS.Signals) => void } {
    const calls: number[] = []
    return { calls, kill: (pid) => { calls.push(pid) } }
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
    const adoptedKills = makeKillRecorder()

    const adopted = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => adoptedChild) as never,
      probe: async () => true,
      killProcess: adoptedKills.kill,
    })
    await adopted.start()
    await adopted.stop()
    expect(adoptedKilled).toBe(false)
    expect(adoptedKills.calls).toEqual([])

    // Managed: this supervisor spawned it, so stop takes it down.
    const managedChild = makeChild()
    const managedKills = makeKillRecorder()

    let spawnedManaged = false
    const managed = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => {
        spawnedManaged = true
        return managedChild as never
      }) as never,
      // Unreachable until spawned, then healthy.
      probe: async () => spawnedManaged,
      killProcess: managedKills.kill,
    })

    const status = await managed.start()
    expect(status.kind).toBe('managed')

    await managed.stop()
    // Negative, so OpenCode's own children go with it rather than reparenting.
    expect(managedKills.calls).toEqual([-managedChild.pid])
  })

  /**
   * The leak this class was written to prevent, and the one it had.
   *
   * A server that spawns but never answers within the ready window throws out
   * of start(), and the throw unwinds past the daemon that would have stopped
   * it. `stop()` used to gate on the status reaching `managed`, which this run
   * never does — so the process survived, still holding the OpenCode port, with
   * nothing anywhere holding its pid.
   */
  it('terminates a child that never became healthy', async () => {
    const baseUrl = makeBaseUrl()
    const child = makeChild()
    const kills = makeKillRecorder()

    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => child as never) as never,
      // Never reachable: it spawns, and then it just sits there.
      probe: async () => false,
      killProcess: kills.kill,
      readyTimeoutMs: 500,
    })

    await expect(supervisor.start()).rejects.toThrow(/did not become reachable/)

    // Killed on the way out, so the failure cleans up after itself even for a
    // caller that catches start() and never calls stop().
    expect(kills.calls).toEqual([-child.pid])

    // And a stop() afterwards does not signal the pid a second time — by then
    // it may belong to something else entirely.
    kills.calls.length = 0
    await supervisor.stop()
    expect(kills.calls).toEqual([])
  })

  /**
   * Same leak from the other direction: stop() arriving while a launch is still
   * in flight has to find the child, because the status has not reached
   * `managed` yet either.
   */
  it('terminates a child that is still launching when stop arrives', async () => {
    const baseUrl = makeBaseUrl()
    const child = makeChild()
    const kills = makeKillRecorder()

    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => child as never) as never,
      probe: async () => false,
      killProcess: kills.kill,
      readyTimeoutMs: 500,
    })

    const starting = supervisor.start()
    // Let the spawn happen and the first probe run before stopping.
    await new Promise((done) => setTimeout(done, 50))

    await supervisor.stop()
    expect(kills.calls).toEqual([-child.pid])

    // The launch still fails; stopping mid-flight is not a way to succeed.
    await expect(starting).rejects.toThrow()
  })

  it('reports a status change once the supervisor gives up', async () => {
    const baseUrl = makeBaseUrl()
    const changes: string[] = []
    let spawned = 0

    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => {
        const child = makeChild()
        spawned += 1
        setTimeout(() => child.emit('exit', 1), 5)
        return child as never
      }) as never,
      probe: async () => spawned > 0,
      killProcess: makeKillRecorder().kill,
      onStatusChange: (status) => { changes.push(status.kind) },
    })

    await supervisor.start()
    // start()'s own result goes back to the caller, not through the listener.
    expect(changes).toEqual([])

    await new Promise((done) => setTimeout(done, 9_000))

    // The daemon writes its state file from start()'s status; without this it
    // would still be describing a reachable server.
    expect(changes.at(-1)).toBe('degraded')
    expect(supervisor.current.kind).toBe('degraded')
  }, 20_000)
})
