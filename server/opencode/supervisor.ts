import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { isProcessAlive, killProcessTree } from '../cli/processControl'

/** Attempts after a crash before the daemon stops trying and reports degraded. */
export const MAX_RESTART_ATTEMPTS = 3

const HEALTH_TIMEOUT_MS = 2_000
const READY_TIMEOUT_MS = 30_000

/** Backoff between restart attempts, multiplied by the attempt number. */
const RESTART_BACKOFF_MS = 1_000

/**
 * How long a terminated OpenCode gets to exit on its own before it is killed,
 * and how long the kill itself gets to take effect.
 *
 * Both are bounded because the daemon awaits them during shutdown: the whole
 * point of waiting is that the lock outlives the process it protects, and a wait
 * with no ceiling would trade one hang for another.
 */
const GRACEFUL_EXIT_MS = 5_000
const FORCE_EXIT_MS = 5_000

export type OpenCodeStatus =
  | { kind: 'adopted'; baseUrl: string }
  | { kind: 'managed'; baseUrl: string; pid: number }
  | { kind: 'mock' }
  | { kind: 'degraded'; baseUrl: string; reason: string }

export class OpenCodeMissingError extends Error {
  constructor(baseUrl: string) {
    super(
      `OpenCode is not running at ${baseUrl} and the \`opencode\` command is not on PATH.\n` +
      'Install it from https://opencode.ai, or start it yourself with `opencode serve`.',
    )
    this.name = 'OpenCodeMissingError'
  }
}

/**
 * Everything the supervisor needs in order to end a process tree, named by what
 * it accomplishes rather than by how any one platform accomplishes it.
 *
 * The signals themselves are not portable. POSIX ends a tree by signalling a
 * negative pid; Windows has no process groups to signal and needs `taskkill /T`
 * to walk the real child tree. Code written against `process.kill(-pid)` is code
 * that only terminates OpenCode on two of the three platforms this ships to —
 * and tests written against it assert a POSIX implementation detail, so they fail
 * on Windows for describing the wrong machine rather than for finding a bug.
 */
export interface ProcessTermination {
  /**
   * Asks the tree to exit. False when this platform cannot ask — Windows has no
   * SIGTERM — which sends the caller straight to `force`.
   */
  request(pid: number): boolean
  /** Ends the tree outright. */
  force(pid: number): Promise<void>
  /** Whether the process is gone. */
  hasExited(pid: number): boolean
}

export const defaultTermination: ProcessTermination = {
  request(pid) {
    if (process.platform === 'win32') return false
    try {
      // Negative pid signals the group, so OpenCode's own children go too.
      process.kill(-pid, 'SIGTERM')
      return true
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
        return true
      } catch {
        // Already gone, which is the outcome the caller wanted.
        return true
      }
    }
  },
  force: killProcessTree,
  hasExited: (pid) => !isProcessAlive(pid),
}

export interface OpenCodeSupervisorOptions {
  baseUrl: string
  mock?: boolean
  /** Pass full DEBUG output through stdout/stderr for a managed server. */
  printLogs?: boolean
  /** Injected by tests so no real process is spawned. */
  spawnProcess?: typeof spawn
  probe?: (baseUrl: string) => Promise<boolean>
  /**
   * Injected by tests, which hold fake children carrying invented pids. Real
   * termination would otherwise aim at whatever process happens to hold that
   * number on the machine running the suite.
   */
  termination?: ProcessTermination
  /** Injected by tests, so a launch that never comes up fails in milliseconds. */
  readyTimeoutMs?: number
  /** Injected by tests, so the restart budget is spent in milliseconds. */
  restartBackoffMs?: number
  /** Injected by tests, so termination escalates without real waiting. */
  exitBudgets?: { gracefulMs: number; forceMs: number }
  /**
   * Reports every status change after start() has returned: a crash, a restart
   * onto a new pid, or the point where the supervisor gives up.
   *
   * The daemon writes its state file once, from the status start() returned. A
   * server that dies an hour later, or comes back under a different pid, leaves
   * that record describing something that is no longer true — and it is the
   * record `clean` reaps orphans from.
   */
  onStatusChange?: (status: OpenCodeStatus) => void
}

export async function probeOpenCode(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/config`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Runs OpenCode for the daemon's lifetime.
 *
 * An already-running server is adopted, never restarted and never stopped: it
 * may belong to another tool or hold work we know nothing about. Only a server
 * this supervisor started is ours to terminate.
 */
export class OpenCodeSupervisor {
  private child: ChildProcess | null = null
  private status: OpenCodeStatus
  private restartAttempts = 0
  private stopping = false
  /** Gates change reports: start() hands its result back to the caller instead. */
  private startReported = false

  constructor(private readonly options: OpenCodeSupervisorOptions) {
    this.status = options.mock ? { kind: 'mock' } : { kind: 'degraded', baseUrl: options.baseUrl, reason: 'not started' }
  }

  get current(): OpenCodeStatus {
    return this.status
  }

  private get probe(): (baseUrl: string) => Promise<boolean> {
    return this.options.probe ?? probeOpenCode
  }

  /**
   * Records a status and tells the host, once there is a host to tell. A
   * listener that throws is swallowed: reporting a crash must not turn into a
   * second one.
   */
  private setStatus(status: OpenCodeStatus): void {
    this.status = status
    if (!this.startReported) return
    try {
      this.options.onStatusChange?.(status)
    } catch {
      // The status is already recorded; a bad listener changes nothing here.
    }
  }

  async start(): Promise<OpenCodeStatus> {
    if (this.options.mock) {
      this.status = { kind: 'mock' }
      this.startReported = true
      return this.status
    }

    if (await this.probe(this.options.baseUrl)) {
      this.status = { kind: 'adopted', baseUrl: this.options.baseUrl }
      this.startReported = true
      return this.status
    }

    this.status = await this.spawnAndWait()
    this.startReported = true
    return this.status
  }

  private async spawnAndWait(): Promise<OpenCodeStatus> {
    const url = new URL(this.options.baseUrl)
    const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    const spawnProcess = this.options.spawnProcess ?? spawn

    const logArgs = this.options.printLogs ? ['--print-logs', '--log-level', 'DEBUG'] : []
    const child = spawnProcess('opencode', ['serve', ...logArgs, '--hostname', host, '--port', port], {
      stdio: ['ignore', 'inherit', 'inherit'],
      // Its own group, so terminating the daemon can take the whole tree down
      // rather than orphaning children of OpenCode.
      detached: process.platform !== 'win32',
      // Through a shell on Windows, because `opencode` is only an `.exe` when it
      // came from the official installer or Scoop. Installed with npm, bun or
      // pnpm it is `opencode.cmd`, which `CreateProcess` cannot find — it
      // appends `.exe` and ignores `PATHEXT` — and which Node refuses to launch
      // directly since the BatBadBut hardening. Without this, every Windows user
      // who installed OpenCode from npm gets `OpenCodeMissingError` for a server
      // that is sitting on their PATH.
      //
      // cmd.exe re-parses the command line, which is safe here only because both
      // interpolations come from a parsed URL: a hostname cannot contain a space
      // or a shell metacharacter, and a port is digits.
      shell: process.platform === 'win32',
    })

    const spawnFailed = new Promise<never>((_, reject) => {
      child.once('error', () => reject(new OpenCodeMissingError(this.options.baseUrl)))
    })

    // An immediate exit almost always means the binary is missing — including
    // under the Windows shell above, where a missing command is not a spawn
    // error at all: cmd.exe starts, prints "is not recognized" and exits 9009.
    const exitedEarly = new Promise<never>((_, reject) => {
      child.once('exit', (code) => {
        if (!this.stopping) reject(new OpenCodeMissingError(this.options.baseUrl))
        else reject(new Error(`OpenCode exited with code ${code ?? 'unknown'}`))
      })
    })

    // Assigned before the wait, so a stop() arriving mid-launch still finds the
    // child. Everything that can go wrong from here leaves a process running
    // that nobody has a handle to unless this is cleaned up on the way out.
    this.child = child

    try {
      await Promise.race([this.waitForHealth(), spawnFailed, exitedEarly])
    } catch (error) {
      // A launch that never came up is the case that leaks: the binary is alive
      // and unresponsive, and the throw unwinds past every caller that could
      // have stopped it. `opencode serve` also holds the port, so the next
      // start would adopt this broken process rather than replace it.
      this.child = null
      await this.terminate(child)
      throw error
    }

    child.removeAllListeners('exit')
    child.once('exit', () => {
      // Dropped so a later stop() cannot signal a pid this process no longer
      // owns; a restart assigns its own child.
      if (this.child === child) this.child = null
      void this.handleUnexpectedExit()
    })

    // On Windows this is the cmd.exe wrapper's pid rather than OpenCode's, and
    // that is safe on every use it is put to: `cmd /c` waits for the command it
    // ran, so liveness and the exit event still describe OpenCode, and both stop
    // paths escalate to `killProcessTree`, which is `taskkill /T` and reaches
    // through the wrapper. Only `status` is affected, where it is the pid of the
    // process LoopTroop actually started.
    return { kind: 'managed', baseUrl: this.options.baseUrl, pid: child.pid ?? 0 }
  }

  private async waitForHealth(): Promise<void> {
    const timeout = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await this.probe(this.options.baseUrl)) return
      await delay(250)
    }
    throw new Error(`OpenCode did not become reachable at ${this.options.baseUrl} within ${timeout / 1000}s.`)
  }

  /**
   * Restarts a crashed server, up to the documented budget, then gives up.
   *
   * The budget counts attempts, not deaths. An earlier version incremented on
   * each unexpected exit and degraded the moment one relaunch threw, so a server
   * whose binary was broken got exactly one attempt while a server that started
   * cleanly and crashed again got three — the opposite of what the policy says,
   * and the case where retrying actually helps is the first one. A failed launch
   * and a launch that succeeds and dies again now cost the same: one attempt.
   */
  private async handleUnexpectedExit(): Promise<void> {
    if (this.stopping) return

    const backoff = this.options.restartBackoffMs ?? RESTART_BACKOFF_MS

    while (this.restartAttempts < MAX_RESTART_ATTEMPTS) {
      this.restartAttempts += 1
      const attempt = this.restartAttempts

      console.error(`[opencode] Exited unexpectedly; restarting (attempt ${attempt}/${MAX_RESTART_ATTEMPTS}).`)
      await delay(backoff * attempt)

      // The wait above is long enough for a shutdown to have started meanwhile,
      // and a restart then would spawn a server nothing is left to stop.
      if (this.stopping) return

      try {
        // Through setStatus, because a restart lands on a new pid: the daemon's
        // record still names the process that just died, which is the one thing
        // `clean` must not go looking for later.
        this.setStatus(await this.spawnAndWait())
        return
      } catch (error) {
        // Reported after every attempt, not only the last: a daemon that spends
        // the next several seconds retrying should not still be describing the
        // server that already died.
        this.setStatus({
          kind: 'degraded',
          baseUrl: this.options.baseUrl,
          reason: error instanceof Error ? error.message : String(error),
        })
        console.error(`[opencode] Restart attempt ${attempt} failed: ${this.describeStatusReason()}`)
      }
    }

    // Retrying forever would hide a broken install behind a restart loop.
    this.setStatus({
      kind: 'degraded',
      baseUrl: this.options.baseUrl,
      reason: `OpenCode exited ${MAX_RESTART_ATTEMPTS} times; giving up. Coding operations are unavailable.`,
    })
    console.error(`[opencode] ${this.describeStatusReason()}`)
  }

  private describeStatusReason(): string {
    return this.status.kind === 'degraded' ? this.status.reason : 'unknown'
  }

  /**
   * Ends a child this supervisor spawned, and does not return until it is gone
   * or the budget for making it go is spent.
   *
   * Awaiting matters because of what the caller does next. `stop()` runs during
   * daemon shutdown, immediately before the daemon releases its single-instance
   * lock and clears its state file — so a fire-and-forget signal means the next
   * `looptroop start` can acquire the lock while the previous OpenCode is still
   * alive and still holding its port. The new daemon then adopts that server as
   * though it were somebody else's, and it never gets stopped by anyone.
   *
   * Separate from stop() because a launch that never became healthy needs the
   * same treatment: it is a real `opencode serve`, holding the port, and by then
   * the status says `degraded` rather than `managed`.
   */
  private async terminate(child: ChildProcess): Promise<void> {
    const pid = child.pid
    if (pid === undefined || child.exitCode !== null) return

    const termination = this.options.termination ?? defaultTermination
    const budgets = this.options.exitBudgets ?? { gracefulMs: GRACEFUL_EXIT_MS, forceMs: FORCE_EXIT_MS }

    if (termination.request(pid) && await this.waitForExit(termination, pid, budgets.gracefulMs)) return

    await termination.force(pid)
    if (await this.waitForExit(termination, pid, budgets.forceMs)) return

    // Reported rather than thrown: shutdown continues either way, and the one
    // thing worse than a surviving OpenCode is a daemon that will not exit.
    console.error(`[opencode] pid ${pid} did not exit; it may still be holding ${this.options.baseUrl}.`)
  }

  private async waitForExit(termination: ProcessTermination, pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (termination.hasExited(pid)) return true
      await delay(50)
    }
    return termination.hasExited(pid)
  }

  /** Only ever stops a server this supervisor started. */
  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = null

    // Ownership is the child handle, not the status. A launch that timed out
    // or a restart that failed leaves the status `degraded` while the process
    // is still running — gating on `managed` orphaned exactly those. An adopted
    // server never sets a child in the first place, so it stays out of reach.
    if (child) await this.terminate(child)
  }
}
