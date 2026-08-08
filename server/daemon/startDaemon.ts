import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { createRuntime, type LoopTroopRuntime } from '../createRuntime'
import { acquireDaemonLock, type AcquiredLock } from '../lib/daemonLock'
import { getDaemonStatePath, type DaemonState } from '../lib/daemonPaths'
import { resolveSettings, type ResolvedSettings } from '../lib/appSettings'
import { createSessionCredentials, type SessionCredentials } from '../middleware/sessionAuth'
import { safeAtomicWrite } from '../io/atomicWrite'
import { ensureSecureDir, secureFile } from '../lib/appConfigDir'
import { dirname } from 'node:path'

/** Keeps the lock's heartbeat ahead of the staleness window. */
const HEARTBEAT_INTERVAL_MS = 15_000

const SHUTDOWN_FORCE_EXIT_MS = 30_000

export interface DaemonHandle {
  state: DaemonState
  credentials: SessionCredentials
  /** One-time URL that exchanges the bootstrap nonce for a browser session. */
  bootstrapUrl: string
  stop(): Promise<void>
}

export interface StartDaemonOptions {
  configDir?: string
  settings?: ResolvedSettings
  version: string
  /** Reported to the parent once the daemon is genuinely serving requests. */
  onReady?: (state: DaemonState) => void
}

function writeState(state: DaemonState, configDir?: string): void {
  const statePath = getDaemonStatePath(configDir)
  ensureSecureDir(dirname(statePath))
  safeAtomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`)
  // The state file names the port and instance id a client authenticates with.
  secureFile(statePath)
}

/**
 * Brings up the daemon in the order a supervisor can trust: the lock is taken
 * before any port is bound, and state is durable before ready is reported. A
 * failure at any step unwinds everything that already succeeded, so a crashed
 * start never leaves a lock or a state file describing a daemon that is not
 * running.
 */
export async function startDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
  const settings = options.settings ?? resolveSettings({ configDir: options.configDir })

  // First, so a second daemon is refused before it can bind a port or touch
  // the database that the running one owns.
  const lock: AcquiredLock = acquireDaemonLock(options.configDir)

  let runtime: LoopTroopRuntime | null = null
  let heartbeat: NodeJS.Timeout | null = null
  const credentials = createSessionCredentials()

  try {
    runtime = createRuntime({ settings, mode: 'production', credentials })
    const address = await runtime.start()

    const state: DaemonState = {
      instanceId: randomUUID(),
      pid: process.pid,
      port: address.port,
      host: address.hostname,
      startedAt: new Date().toISOString(),
      version: options.version,
    }

    writeState(state, options.configDir)

    // The nonce travels in the fragment so it is never sent to the server as
    // part of the request line, and so it stays out of access logs.
    const bootstrapUrl =
      `http://${address.hostname}:${address.port}/#bootstrap=${credentials.bootstrapNonce}`

    heartbeat = setInterval(() => lock.heartbeat(), HEARTBEAT_INTERVAL_MS)
    // The daemon's own timer must not be the reason the process stays alive.
    heartbeat.unref()

    options.onReady?.(state)

    let stopping: Promise<void> | null = null
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        if (heartbeat) clearInterval(heartbeat)
        try {
          await runtime?.close()
        } finally {
          rmSync(getDaemonStatePath(options.configDir), { force: true })
          lock.release()
        }
      })()
      return stopping
    }

    return { state, credentials, bootstrapUrl, stop }
  } catch (error) {
    if (heartbeat) clearInterval(heartbeat)
    try {
      await runtime?.close()
    } catch {
      // The start failure is the useful error; a close failure would mask it.
    }
    rmSync(getDaemonStatePath(options.configDir), { force: true })
    lock.release()
    throw error
  }
}

/**
 * Installs signal handling for a daemon process. Kept out of startDaemon so an
 * embedding host is never given process-wide handlers it did not ask for.
 */
export function installShutdownHandlers(handle: DaemonHandle): void {
  let shuttingDown = false

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[daemon] Received ${signal}; shutting down.`)

    const forceExit = setTimeout(() => {
      console.error('[daemon] Graceful shutdown timed out; forcing exit.')
      process.exit(1)
    }, SHUTDOWN_FORCE_EXIT_MS)
    forceExit.unref()

    handle.stop().then(() => {
      clearTimeout(forceExit)
      process.exit(0)
    }).catch((error: unknown) => {
      console.error(`[daemon] Shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

/** Describes the machine a state file was written on, for cross-host checks. */
export function currentHostname(): string {
  return hostname()
}
