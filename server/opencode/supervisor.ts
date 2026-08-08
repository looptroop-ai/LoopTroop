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

  constructor(private readonly options: OpenCodeSupervisorOptions) {
    this.status = options.mock ? { kind: 'mock' } : { kind: 'degraded', baseUrl: options.baseUrl, reason: 'not started' }
  }

  get current(): OpenCodeStatus {
    return this.status
  }

  private get probe(): (baseUrl: string) => Promise<boolean> {
    return this.options.probe ?? probeOpenCode
  }

  async start(): Promise<OpenCodeStatus> {
    if (this.options.mock) {
      this.status = { kind: 'mock' }
      return this.status
    }

    if (await this.probe(this.options.baseUrl)) {
      this.status = { kind: 'adopted', baseUrl: this.options.baseUrl }
      return this.status
    }

    this.status = await this.spawnAndWait()
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

    this.child = child
    await Promise.race([this.waitForHealth(), spawnFailed, exitedEarly])

    child.removeAllListeners('exit')
    child.once('exit', () => { void this.handleUnexpectedExit() })

    return { kind: 'managed', baseUrl: this.options.baseUrl, pid: child.pid ?? 0 }
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.probe(this.options.baseUrl)) return
      await delay(250)
    }
    throw new Error(`OpenCode did not become reachable at ${this.options.baseUrl} within ${READY_TIMEOUT_MS / 1000}s.`)
  }

  private async handleUnexpectedExit(): Promise<void> {
    if (this.stopping) return

    this.restartAttempts += 1
    if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
      // Retrying forever would hide a broken install behind a restart loop.
      this.status = {
        kind: 'degraded',
        baseUrl: this.options.baseUrl,
        reason: `OpenCode exited ${MAX_RESTART_ATTEMPTS} times; giving up. Coding operations are unavailable.`,
      }
      console.error(`[opencode] ${this.status.reason}`)
      return
    }

    console.error(`[opencode] Exited unexpectedly; restarting (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS}).`)
    await delay(1_000 * this.restartAttempts)

    try {
      this.status = await this.spawnAndWait()
    } catch (error) {
      this.status = {
        kind: 'degraded',
        baseUrl: this.options.baseUrl,
        reason: error instanceof Error ? error.message : String(error),
      }
      console.error(`[opencode] Restart failed: ${this.status.reason}`)
    }
  }

  /** Only ever stops a server this supervisor started. */
  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = null

    if (!child || this.status.kind !== 'managed') return
    if (child.pid === undefined || child.exitCode !== null) return

    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    }

    try {
      // Negative pid signals the group, so OpenCode's own children go too.
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
    }
  }
}
