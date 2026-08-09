import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { createRuntime, type LoopTroopRuntime } from '../createRuntime'
import { IncompatibleSchemaVersionError } from '../db/schemaVersion'
import { acquireDaemonLock, type AcquiredLock } from '../lib/daemonLock'
import {
  getDaemonStatePath,
  writeDaemonStartFailure,
  writeDaemonState,
  type DaemonStartFailure,
  type DaemonState,
} from '../lib/daemonPaths'
import { resolveSettings, type ResolvedSettings } from '../lib/appSettings'
import { readProcessStartToken } from '../lib/processIdentity'
import { createSessionCredentials, BootstrapNonceStore, type SessionCredentials } from '../middleware/sessionAuth'
import { OpenCodeSupervisor, type OpenCodeStatus } from '../opencode/supervisor'

/** Keeps the lock's heartbeat ahead of the staleness window. */
const HEARTBEAT_INTERVAL_MS = 15_000

const SHUTDOWN_FORCE_EXIT_MS = 30_000

export interface DaemonHandle {
  state: DaemonState
  credentials: SessionCredentials
  /** Mints the single-use nonces a browser exchanges for a session cookie. */
  bootstrapNonces: BootstrapNonceStore
  /**
   * One-time URL that exchanges a bootstrap nonce for a browser session.
   *
   * Reading it mints a nonce, so it must be handed to a person rather than
   * written anywhere durable — the daemon log is a file that outlives the run.
   */
  bootstrapUrl(): string
  /**
   * Registers a listener for "something asked this daemon to exit" — a signal,
   * or an authenticated call to the shutdown endpoint. The daemon process turns
   * that into a real exit; an embedder decides for itself.
   */
  onShutdownRequest(listener: (reason: string) => void): void
  stop(): Promise<void>
}

export interface StartDaemonOptions {
  configDir?: string
  settings?: ResolvedSettings
  version: string
  /** Reported to the parent once the daemon is genuinely serving requests. */
  onReady?: (state: DaemonState) => void
}

/**
 * Turns a refused start into a record worth keeping, or into nothing.
 *
 * Most things that stop a start are transient and already reported while the
 * user is watching: a bound port frees up, a missing OpenCode gets installed,
 * and a note about either would be a lie by the time anyone read it back. A
 * database this build cannot open is different — it refuses the same file every
 * time, and the process that discovered it is gone before the question is
 * asked. Only that one is written down.
 */
export function describeStartFailure(
  error: unknown,
  context: { version: string, at: string },
): DaemonStartFailure | null {
  if (!(error instanceof IncompatibleSchemaVersionError)) return null

  return {
    reason: 'schema-incompatible',
    at: context.at,
    version: context.version,
    message: error.message,
    schema: {
      databaseLabel: error.databaseLabel,
      databasePath: error.databasePath,
      found: error.found,
      expected: error.expected,
      migratableFrom: error.migratableFrom,
    },
  }
}

/**
 * Leaves daemon.json describing the truth: either why this start was refused,
 * or nothing at all. Recording is best effort, because the start failure is the
 * error worth reporting and must not be replaced by a failure to write it down.
 */
function recordStartFailure(error: unknown, version: string, configDir?: string): void {
  const failure = describeStartFailure(error, { version, at: new Date().toISOString() })
  if (failure) {
    try {
      writeDaemonStartFailure(failure, configDir)
      return
    } catch {
      // Fall through and clear the file rather than leave a partial record.
    }
  }
  rmSync(getDaemonStatePath(configDir), { force: true })
}

/**
 * What the state file should say about OpenCode, or nothing at all in mock mode
 * where there is no server to describe.
 *
 * A managed server is recorded with a start-identity token as well as its pid,
 * because this daemon can be killed outright — and when it is, it takes no
 * cleanup with it and OpenCode is left running in its own process group. The
 * token is what lets a later `clean` reap that orphan without ever signalling an
 * unrelated process that happened to inherit the number.
 */
function describeOpenCode(
  status: OpenCodeStatus,
  baseUrl: string,
): DaemonState['opencode'] {
  if (status.kind === 'mock') return undefined
  if (status.kind !== 'managed') return { baseUrl, owned: false }

  const startToken = readProcessStartToken(status.pid)
  return {
    baseUrl,
    owned: true,
    pid: status.pid,
    ...(startToken === null ? {} : { startToken }),
  }
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
  let opencode: OpenCodeSupervisor | null = null
  const credentials = createSessionCredentials()
  const bootstrapNonces = new BootstrapNonceStore()
  // Minted before the app is built so /api/health can report it, which is what
  // lets a client tell this daemon from a process that inherited its pid.
  const instanceId = randomUUID()

  const shutdownListeners = new Set<(reason: string) => void>()
  // Assigned once `stop` exists below. A shutdown requested before then can only
  // come from a caller that has not been told the daemon is ready yet.
  let stopRuntime: () => Promise<void> = async () => undefined
  const requestShutdown = (reason: string): void => {
    // With no listener there is no process to exit — an embedder gets its
    // runtime closed rather than a request that silently does nothing.
    if (shutdownListeners.size === 0) {
      void stopRuntime()
      return
    }
    for (const listener of shutdownListeners) listener(reason)
  }

  try {
    // Before the server binds: a missing OpenCode is fatal, and failing here
    // avoids a half-started daemon that cannot do any work.
    opencode = new OpenCodeSupervisor({
      baseUrl: settings.opencodeBaseUrl,
      mock: settings.opencodeMode === 'mock',
    })
    const opencodeStatus = await opencode.start()

    runtime = createRuntime({
      settings,
      mode: 'production',
      credentials,
      bootstrapNonces,
      instanceId,
      onShutdownRequest: () => requestShutdown('an API request'),
    })
    const address = await runtime.start()

    const opencodeState = describeOpenCode(opencodeStatus, settings.opencodeBaseUrl)
    // Recorded so `stop` can tell this process from whatever inherits its pid
    // once it stops answering /api/health partway through its own shutdown.
    const startToken = readProcessStartToken(process.pid)
    const state: DaemonState = {
      instanceId,
      pid: process.pid,
      port: address.port,
      host: address.hostname,
      startedAt: new Date().toISOString(),
      version: options.version,
      ...(startToken === null ? {} : { startToken }),
      // Persisted so `stop`, `open` and `doctor` can authenticate against a
      // daemon they did not start. The file is owner-only.
      apiToken: credentials.apiToken,
      ...(opencodeState === undefined ? {} : { opencode: opencodeState }),
    }

    writeDaemonState(state, options.configDir)

    // The nonce travels in the fragment so it is never sent to the server as
    // part of the request line, and so it stays out of access logs. A fresh one
    // is minted per call: a nonce is single-use and expires, so a URL captured
    // once cannot be replayed or reused later.
    const bootstrapUrl = (): string =>
      `http://${address.hostname}:${address.port}/#bootstrap=${bootstrapNonces.issue()}`

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
          // Only stops a server this daemon started; an adopted one is left alone.
          await opencode?.stop()
          rmSync(getDaemonStatePath(options.configDir), { force: true })
          lock.release()
        }
      })()
      return stopping
    }
    stopRuntime = stop

    return {
      state,
      credentials,
      bootstrapNonces,
      bootstrapUrl,
      onShutdownRequest: (listener) => { shutdownListeners.add(listener) },
      stop,
    }
  } catch (error) {
    if (heartbeat) clearInterval(heartbeat)
    try {
      await runtime?.close()
      await opencode?.stop()
    } catch {
      // The start failure is the useful error; a close failure would mask it.
    }
    // The daemon is about to exit, taking the reason with it. A refusal that
    // will recur on every start is left behind for `status` and `doctor`.
    recordStartFailure(error, options.version, options.configDir)
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

  const shutdown = (reason: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[daemon] Shutting down (${reason}).`)

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

  // `looptroop stop` asks over HTTP first, which works on Windows where there
  // is no real SIGTERM, and proves the daemon answered before anything is
  // signalled at the process.
  handle.onShutdownRequest(shutdown)
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

/** Describes the machine a state file was written on, for cross-host checks. */
export function currentHostname(): string {
  return hostname()
}
