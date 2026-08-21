import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  MAX_RESTART_ATTEMPTS,
  OpenCodeSupervisor,
  OpenCodeMissingError,
  type ProcessTermination,
} from '../server/opencode/supervisor'

/**
 * 2.10 contract: an already-running server is adopted untouched; a missing
 * binary fails loudly; a crash triggers a bounded restart then degradation; and
 * stop() touches only a server the supervisor started.
 */
describe('OpenCode supervision', () => {
  /**
   * Waits for a condition instead of for a duration.
   *
   * These tests drive the restart budget with a millisecond backoff, so the
   * outcome arrives in well under a second — but a sleep sized to that is a
   * sleep that fails on a loaded CI runner, and one sized for the runner wastes
   * the difference on every local run. The deadline is only a bound on failure.
   */
  async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (condition()) return
      await new Promise((done) => setTimeout(done, 10))
    }
    throw new Error(`condition not met within ${timeoutMs}ms`)
  }

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
   * Records which processes were asked to end, instead of ending them. These
   * children carry an invented pid, so real termination would aim at whatever
   * process holds that number on the machine running the suite.
   *
   * Records pids rather than signals because the signals are not portable and
   * the contract is not about them: POSIX ends a tree by signalling a negative
   * pid and Windows has `taskkill /T`, so a test asserting `-pid` asserts that
   * the suite is running on POSIX. What every platform owes is that the right
   * process is ended and that stop() waits for it.
   */
  function makeTerminationRecorder(options: { exits?: boolean } = {}) {
    const exits = options.exits ?? true
    const requested: number[] = []
    const forced: number[] = []
    const gone = new Set<number>()

    const termination: ProcessTermination = {
      request(pid) {
        requested.push(pid)
        if (exits) gone.add(pid)
        return true
      },
      async force(pid) {
        forced.push(pid)
        if (exits) gone.add(pid)
      },
      hasExited: (pid) => gone.has(pid),
    }

    return { requested, forced, termination }
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

  /**
   * Installed from npm, bun or pnpm, OpenCode is `opencode.cmd` on Windows — a
   * batch shim that `CreateProcess` cannot find (it appends only `.exe`) and
   * that Node refuses to launch directly. Without a shell the daemon reported
   * OpenCode as missing for every user who installed it that way.
   */
  it('launches OpenCode through a shell on Windows and directly elsewhere', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    const seen: {
      command: unknown
      args: unknown
      port: string
      options: { shell?: boolean; detached?: boolean }
    }[] = []

    for (const platform of ['win32', 'linux'] as const) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      try {
        const child = makeChild()
        // Per iteration: a probe that counted every spawn so far would report
        // the second platform's server as already running and never launch it.
        let spawned = false
        // Each iteration gets its own port, so the expected command line has to
        // be built from the URL this supervisor was actually given.
        const baseUrl = makeBaseUrl()
        const port = new URL(baseUrl).port
        const supervisor = new OpenCodeSupervisor({
          baseUrl,
          spawnProcess: ((command: unknown, args: unknown, options: { shell?: boolean }) => {
            spawned = true
            seen.push({ command, args, port, options })
            return child as never
          }) as never,
          probe: async () => spawned,
        })
        await supervisor.start()
      } finally {
        if (original) Object.defineProperty(process, 'platform', original)
      }
    }

    // Under the shell the command line is joined here rather than handed over as
    // a separate array: Node joins the two identically and, since DEP0190, warns
    // about doing so — a security-flavoured notice about our own internals.
    expect(seen[0]?.command).toBe(`opencode serve --hostname 127.0.0.1 --port ${seen[0]?.port}`)
    expect(seen[0]?.args).toEqual([])
    expect(seen[0]?.options.shell).toBe(true)
    // Windows has no process groups to lead, and the shell does not change that.
    expect(seen[0]?.options.detached).toBe(false)
    // Off the shell there is nothing to join, so the argument array stays.
    expect(seen[1]?.command).toBe('opencode')
    expect(seen[1]?.args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', seen[1]?.port])
    expect(seen[1]?.options.shell).toBe(false)
    expect(seen[1]?.options.detached).toBe(true)
  })

  it('fails loudly when a shell reports the binary missing by exit code', async () => {
    const baseUrl = makeBaseUrl()

    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => {
        const child = makeChild()
        // What cmd.exe does for a command it cannot find: it starts, prints
        // "is not recognized" and exits 9009. There is no 'error' event at all,
        // so the early exit is the only signal that the binary is not there.
        queueMicrotask(() => child.emit('exit', 9009))
        return child as never
      }) as never,
      probe: async () => false,
    })

    await expect(supervisor.start()).rejects.toBeInstanceOf(OpenCodeMissingError)
  })

  it('prints full DEBUG output only when the all-log mode is requested', async () => {
    const baseUrl = makeBaseUrl()
    const child = makeChild()
    let spawned = false
    let args: string[] = []

    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      printLogs: true,
      spawnProcess: ((_command: string, commandArgs: string[]) => {
        args = commandArgs
        spawned = true
        return child as never
      }) as never,
      probe: async () => spawned,
    })

    await supervisor.start()

    expect(args).toEqual([
      'serve',
      '--print-logs',
      '--log-level',
      'DEBUG',
      '--hostname',
      '127.0.0.1',
      '--port',
      new URL(baseUrl).port,
    ])
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
      termination: makeTerminationRecorder().termination,
      restartBackoffMs: 5,
    })

    const initial = await supervisor.start()
    expect(initial.kind).toBe('managed')

    await waitFor(() => supervisor.current.kind === 'degraded')

    // One launch plus exactly the documented budget, and no more: a supervisor
    // that kept trying would hide a broken install behind a restart loop.
    expect(spawned).toBe(1 + MAX_RESTART_ATTEMPTS)
    expect(supervisor.current).toMatchObject({ kind: 'degraded', reason: expect.stringContaining('giving up') })
  })

  /**
   * The restart budget counts attempts, not deaths.
   *
   * A server whose binary is broken never comes back up, so every attempt ends
   * in a throw rather than in another crash. An earlier version degraded on the
   * first such throw — one attempt for the case that most needs three, while a
   * server that restarted cleanly and died again got the full budget.
   */
  it('spends the whole restart budget when every relaunch fails', async () => {
    const baseUrl = makeBaseUrl()
    let launches = 0

    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => {
        const child = makeChild()
        launches += 1
        // The first launch comes up; every relaunch dies on arrival, the way a
        // missing or broken binary does.
        if (launches > 1) queueMicrotask(() => child.emit('error', new Error('spawn opencode ENOENT')))
        else setTimeout(() => child.emit('exit', 1), 5)
        return child as never
      }) as never,
      probe: async () => launches > 0,
      termination: makeTerminationRecorder().termination,
      restartBackoffMs: 5,
    })

    await supervisor.start()
    await waitFor(() => supervisor.current.kind === 'degraded' && launches > MAX_RESTART_ATTEMPTS)

    expect(launches).toBe(1 + MAX_RESTART_ATTEMPTS)
  })

  it('stops only a server it started, never an adopted one', async () => {
    const baseUrl = makeBaseUrl()

    // Adopted: nothing was spawned, so stop must not signal anything.
    const adoptedChild = makeChild()
    let adoptedKilled = false
    ;(adoptedChild as { kill?: () => boolean }).kill = () => {
      adoptedKilled = true
      return true
    }
    const adoptedTermination = makeTerminationRecorder()

    const adopted = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => adoptedChild) as never,
      probe: async () => true,
      termination: adoptedTermination.termination,
    })
    await adopted.start()
    await adopted.stop()
    expect(adoptedKilled).toBe(false)
    expect(adoptedTermination.requested).toEqual([])
    expect(adoptedTermination.forced).toEqual([])

    // Managed: this supervisor spawned it, so stop takes it down.
    const managedChild = makeChild()
    const managedTermination = makeTerminationRecorder()

    let spawnedManaged = false
    const managed = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => {
        spawnedManaged = true
        return managedChild as never
      }) as never,
      // Unreachable until spawned, then healthy.
      probe: async () => spawnedManaged,
      termination: managedTermination.termination,
    })

    const status = await managed.start()
    expect(status.kind).toBe('managed')

    await managed.stop()
    expect(managedTermination.requested).toEqual([managedChild.pid])
  })

  /**
   * What the daemon does immediately after stop() returns: release the
   * single-instance lock and clear the state file. A stop that only signals and
   * returns lets the next `looptroop start` acquire that lock while the previous
   * OpenCode is still alive and still holding its port — and the new daemon then
   * adopts it as somebody else's server, so nothing ever stops it.
   */
  it('does not return from stop until the server has actually exited', async () => {
    const baseUrl = makeBaseUrl()
    const child = makeChild()

    let exited = false
    const termination: ProcessTermination = {
      request: () => {
        // Slow to die, the way a real server flushing state on SIGTERM is.
        setTimeout(() => { exited = true }, 100)
        return true
      },
      force: async () => { exited = true },
      hasExited: () => exited,
    }

    let spawned = false
    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => {
        spawned = true
        return child as never
      }) as never,
      probe: async () => spawned,
      termination,
    })

    await supervisor.start()
    await supervisor.stop()

    expect(exited).toBe(true)
  })

  /**
   * A server that ignores SIGTERM must not be able to hold shutdown open. The
   * daemon awaits stop(), so an unbounded wait here is a daemon that never
   * exits — which is worse than the leaked process it was trying to prevent.
   */
  it('escalates to a forced kill when the server ignores the request to exit', async () => {
    const baseUrl = makeBaseUrl()
    const child = makeChild()
    const recorder = makeTerminationRecorder({ exits: false })

    let spawned = false
    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => {
        spawned = true
        return child as never
      }) as never,
      probe: async () => spawned,
      termination: recorder.termination,
      exitBudgets: { gracefulMs: 60, forceMs: 60 },
    })

    await supervisor.start()
    await supervisor.stop()

    expect(recorder.requested).toEqual([child.pid])
    expect(recorder.forced).toEqual([child.pid])
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
    const recorder = makeTerminationRecorder()

    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => child as never) as never,
      // Never reachable: it spawns, and then it just sits there.
      probe: async () => false,
      termination: recorder.termination,
      readyTimeoutMs: 500,
    })

    await expect(supervisor.start()).rejects.toThrow(/did not become reachable/)

    // Killed on the way out, so the failure cleans up after itself even for a
    // caller that catches start() and never calls stop().
    expect(recorder.requested).toEqual([child.pid])

    // And a stop() afterwards does not signal the pid a second time — by then
    // it may belong to something else entirely.
    recorder.requested.length = 0
    await supervisor.stop()
    expect(recorder.requested).toEqual([])
  })

  /**
   * Same leak from the other direction: stop() arriving while a launch is still
   * in flight has to find the child, because the status has not reached
   * `managed` yet either.
   */
  it('terminates a child that is still launching when stop arrives', async () => {
    const baseUrl = makeBaseUrl()
    const child = makeChild()
    const recorder = makeTerminationRecorder()

    const supervisor = new OpenCodeSupervisor({
      baseUrl,
      spawnProcess: (() => child as never) as never,
      probe: async () => false,
      termination: recorder.termination,
      readyTimeoutMs: 500,
    })

    const starting = supervisor.start()
    // Let the spawn happen and the first probe run before stopping.
    await new Promise((done) => setTimeout(done, 50))

    await supervisor.stop()
    expect(recorder.requested).toEqual([child.pid])

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
      termination: makeTerminationRecorder().termination,
      restartBackoffMs: 5,
      onStatusChange: (status) => { changes.push(status.kind) },
    })

    await supervisor.start()
    // start()'s own result goes back to the caller, not through the listener.
    expect(changes).toEqual([])

    await waitFor(() => supervisor.current.kind === 'degraded')

    // The daemon writes its state file from start()'s status; without this it
    // would still be describing a reachable server.
    expect(changes.at(-1)).toBe('degraded')
    expect(supervisor.current.kind).toBe('degraded')
  })
})
