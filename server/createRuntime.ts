import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import type { Hono } from 'hono'
import { createApp, type CreateAppOptions } from './app'
import { startupSequence } from './startup'
import { broadcaster } from './sse/broadcaster'
import { closeDatabase, ensureStorageDirs } from './db/index'
import { clearProjectDatabaseCache } from './db/project'
import { assertAllowedBackendHost, getAllowedBackendHost } from '../shared/appConfig'
import { resolveSettings, type ResolvedSettings, type SettingSource } from './lib/appSettings'
import { configureOpenCodeRuntime } from './opencode/runtimeConfig'
import { resetOpenCodeAdapter } from './opencode/factory'

export interface RuntimeConfig extends CreateAppOptions {
  /** Overrides the resolved settings. Use 0 to let the OS assign a free port. */
  port?: number
  hostname?: string
  /** Skip the database/OpenCode boot sequence. For tests that only need the app. */
  skipStartupSequence?: boolean
  /** Pre-resolved settings, so a caller that already parsed flags resolves once. */
  settings?: ResolvedSettings
}

export interface RuntimeAddress {
  port: number
  hostname: string
}

export interface LoopTroopRuntime {
  app: Hono
  start(): Promise<RuntimeAddress>
  close(): Promise<void>
  /** Null until start() resolves. */
  readonly address: RuntimeAddress | null
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE'
}

function describeBindFailure(error: unknown, port: number, source: SettingSource): Error {
  if (!isAddressInUse(error)) return error instanceof Error ? error : new Error(String(error))

  const origin = source === 'flag' ? '--port'
    : source === 'env' ? 'LOOPTROOP_BACKEND_PORT'
      : source === 'file' ? 'config.json'
        : 'the default'
  return new Error(
    `Port ${port} is already in use (requested via ${origin}). ` +
    'Stop whatever is using it, or choose another port.',
  )
}

/**
 * Builds an embeddable runtime. Constructing one has no side effects: no files,
 * timers, sockets, child processes, or signal handlers exist until start() runs.
 * Signal handling is the caller's job, so a host can embed this without having
 * its own process lifecycle hijacked.
 */
export function createRuntime(config: RuntimeConfig = {}): LoopTroopRuntime {
  const app = createApp(config)
  let handle: ReturnType<typeof serve> | null = null
  let address: RuntimeAddress | null = null
  let closing: Promise<void> | null = null
  // `address` alone cannot say "starting": it is only set once listen succeeds,
  // so two concurrent start() calls both saw null and both ran the startup
  // sequence, each allocating its own timers.
  let starting: Promise<RuntimeAddress> | null = null

  function listen(port: number, hostname: string): Promise<RuntimeAddress> {
    return new Promise<RuntimeAddress>((resolveAddress, rejectAddress) => {
      try {
        const server = serve({ fetch: app.fetch, port, hostname }, (info: AddressInfo) => {
          resolveAddress({ port: info.port, hostname })
        })
        handle = server
        // serve() binds asynchronously, so a failure arrives here rather than
        // as a throw; without this the process would die on an unhandled event.
        server.once('error', (error: unknown) => {
          handle = null
          server.close(() => undefined)
          rejectAddress(error)
        })
      } catch (error) {
        rejectAddress(error)
      }
    })
  }

  /**
   * Starts, waiting out a shutdown that is still running.
   *
   * The wait is what makes a runtime re-startable: `close()` holds its promise
   * until every resource it knows about is gone, and starting on top of a
   * half-finished teardown would race it for the same database handle. A
   * failed close is not a reason to refuse — the caller has already been told
   * about it — so the rejection is absorbed here rather than surfaced twice.
   */
  async function start(): Promise<RuntimeAddress> {
    if (starting) return starting
    if (closing) await closing.catch(() => undefined)
    if (address) return address
    // A new generation gets its own shutdown. Keeping the settled promise is
    // what made a runtime that had been closed once impossible to close again.
    closing = null
    starting = runStart().finally(() => { starting = null })
    return starting
  }

  /** Undoes everything `runStart` may have started, without touching `handle`. */
  function teardownStartedResources(): void {
    broadcaster.stopAutoCleanup()
    clearProjectDatabaseCache()
    closeDatabase()
  }

  async function runStart(): Promise<RuntimeAddress> {
    const settings = config.settings ?? resolveSettings()

    // Before the startup sequence, which health-checks OpenCode through the
    // adapter: resolved later, `opencodeBaseUrl` from config.json would arrive
    // after the adapter had already built its client against the environment.
    // The reset drops any instance built during module import.
    configureOpenCodeRuntime(settings)
    resetOpenCodeAdapter()

    // Everything that acquires a resource is inside this try, not just the
    // bind. The startup sequence starts the WAL checkpoint and
    // `startAutoCleanup` starts the broadcaster's timer, and a throw between
    // either of those and `listen` — a rejected hydration, a hostname the host
    // policy refuses — left them running with no handle to stop them, because
    // `close()` is only reachable once a caller holds a started runtime.
    // Verified: a runtime configured with a non-loopback hostname rejected as
    // expected and left `broadcaster.cleanupInterval` alive behind it.
    try {
      ensureStorageDirs()

      if (!config.skipStartupSequence) {
        await startupSequence()
      }

      broadcaster.startAutoCleanup()

      const hostname = config.hostname === undefined
        ? getAllowedBackendHost()
        : assertAllowedBackendHost(config.hostname)

      const requestedPort = config.port ?? settings.port
      // A port the user named must fail loudly rather than move somewhere they
      // are not pointing at. Only the untouched default may relocate.
      const portIsExplicit = config.port !== undefined || settings.portIsExplicit

      try {
        address = await listen(requestedPort, hostname)
      } catch (error) {
        if (portIsExplicit || !isAddressInUse(error)) {
          throw describeBindFailure(error, requestedPort, config.port !== undefined ? 'flag' : settings.sources.port)
        }
        // Binding 0 asks the OS for a free port. Probing first and binding after
        // would race against anything claiming the port in between.
        address = await listen(0, hostname)
        console.warn(`[server] Port ${requestedPort} is in use; listening on ${address.port} instead.`)
      }
    } catch (error) {
      teardownStartedResources()
      throw error
    }

    return address
  }

  /**
   * Stops, waiting out a startup that is still running.
   *
   * Without the wait this resolved against whatever existed at the moment it
   * was called, and `runStart()` then went on to start timers and bind a
   * socket that nothing could close — reachable in production by pressing
   * Ctrl-C while the daemon is still starting, which takes seconds. A start
   * that fails still has to be torn down, so its rejection is absorbed.
   */
  async function close(): Promise<void> {
    closing ??= (async () => {
      if (starting) await starting.catch(() => undefined)
      if (handle && typeof handle.close === 'function') {
        await new Promise<void>((resolveClose) => {
          handle?.close(() => resolveClose())
        })
      }
      handle = null
      address = null
      teardownStartedResources()
    })()

    return closing
  }

  return {
    app,
    start,
    close,
    get address() {
      return address
    },
  }
}
