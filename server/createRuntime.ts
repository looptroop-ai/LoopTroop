import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import type { Hono } from 'hono'
import { createApp, type CreateAppOptions } from './app'
import { startupSequence } from './startup'
import { broadcaster } from './sse/broadcaster'
import { closeDatabase, ensureStorageDirs } from './db/index'
import { clearProjectDatabaseCache } from './db/project'
import { getAllowedBackendHost, getBackendPort } from '../shared/appConfig'

export interface RuntimeConfig extends CreateAppOptions {
  /** Omit to let the OS assign a free port by binding to 0. */
  port?: number
  hostname?: string
  /** Skip the database/OpenCode boot sequence. For tests that only need the app. */
  skipStartupSequence?: boolean
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

  async function start(): Promise<RuntimeAddress> {
    if (address) return address

    ensureStorageDirs()

    if (!config.skipStartupSequence) {
      await startupSequence()
    }

    broadcaster.startAutoCleanup()

    const hostname = config.hostname ?? getAllowedBackendHost()
    // Bind to 0 for dynamic allocation: probing for a free port and binding it
    // afterwards races against anything else claiming it in between.
    const requestedPort = config.port ?? getBackendPort()

    address = await new Promise<RuntimeAddress>((resolvePort, rejectPort) => {
      try {
        handle = serve({ fetch: app.fetch, port: requestedPort, hostname }, (info: AddressInfo) => {
          resolvePort({ port: info.port, hostname })
        })
        handle.once('error', rejectPort)
      } catch (error) {
        rejectPort(error)
      }
    })

    return address
  }

  async function close(): Promise<void> {
    closing ??= (async () => {
      if (handle && typeof handle.close === 'function') {
        await new Promise<void>((resolveClose) => {
          handle?.close(() => resolveClose())
        })
      }
      handle = null
      address = null
      broadcaster.stopAutoCleanup()
      clearProjectDatabaseCache()
      closeDatabase()
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
