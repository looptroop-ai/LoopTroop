import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

/** Attempts after a crash before the daemon stops trying and reports degraded. */
export const MAX_RESTART_ATTEMPTS = 3

const HEALTH_TIMEOUT_MS = 2_000
const READY_TIMEOUT_MS = 30_000

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

export interface OpenCodeSupervisorOptions {
  baseUrl: string
  mock?: boolean
  /** Injected by tests so no real process is spawned. */
  spawnProcess?: typeof spawn
  probe?: (baseUrl: string) => Promise<boolean>
  /**
   * Injected by tests, which hold fake children carrying invented pids. The
   * group kill below would otherwise aim a real signal at whatever process
   * group happens to hold that number on the machine running the suite.
   */
  killProcess?: (pid: number, signal: NodeJS.Signals) => void
  /** Injected by tests, so a launch that never comes up fails in milliseconds. */
  readyTimeoutMs?: number
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

    const child = spawnProcess('opencode', ['serve', '--hostname', host, '--port', port], {
      stdio: ['ignore', 'inherit', 'inherit'],
      // Its own group, so terminating the daemon can take the whole tree down
      // rather than orphaning children of OpenCode.
      detached: process.platform !== 'win32',
    })

    const spawnFailed = new Promise<never>((_, reject) => {
      child.once('error', () => reject(new OpenCodeMissingError(this.options.baseUrl)))
    })

    // An immediate exit almost always means the binary is missing.
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
      this.terminate(child)
      throw error
    }

    child.removeAllListeners('exit')
    child.once('exit', () => {
      // Dropped so a later stop() cannot signal a pid this process no longer
      // owns; a restart assigns its own child.
      if (this.child === child) this.child = null
      void this.handleUnexpectedExit()
    })

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

  private async handleUnexpectedExit(): Promise<void> {
    if (this.stopping) return

    this.restartAttempts += 1
    if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
      // Retrying forever would hide a broken install behind a restart loop.
      this.setStatus({
        kind: 'degraded',
        baseUrl: this.options.baseUrl,
        reason: `OpenCode exited ${MAX_RESTART_ATTEMPTS} times; giving up. Coding operations are unavailable.`,
      })
      console.error(`[opencode] ${this.describeStatusReason()}`)
      return
    }

    console.error(`[opencode] Exited unexpectedly; restarting (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS}).`)
    await delay(1_000 * this.restartAttempts)

    // The wait above is long enough for a shutdown to have started meanwhile,
    // and a restart then would spawn a server nothing is left to stop.
    if (this.stopping) return

    try {
      // Through setStatus, because a restart lands on a new pid: the daemon's
      // record still names the process that just died, which is the one thing
      // `clean` must not go looking for later.
      this.setStatus(await this.spawnAndWait())
    } catch (error) {
      this.setStatus({
        kind: 'degraded',
        baseUrl: this.options.baseUrl,
        reason: error instanceof Error ? error.message : String(error),
      })
      console.error(`[opencode] Restart failed: ${this.describeStatusReason()}`)
    }
  }

  private describeStatusReason(): string {
    return this.status.kind === 'degraded' ? this.status.reason : 'unknown'
  }

  /**
   * Signals a child this supervisor spawned, along with its process group.
   *
   * Separate from stop() because a launch that never became healthy needs the
   * same treatment: it is a real `opencode serve`, holding the port, and by
   * then the status says `degraded` rather than `managed`.
   */
  private terminate(child: ChildProcess): void {
    if (child.pid === undefined || child.exitCode !== null) return
    const kill = this.options.killProcess ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal) })

    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    }

    try {
      // Negative pid signals the group, so OpenCode's own children go too.
      kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
    }
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
    if (child) this.terminate(child)
  }
}
