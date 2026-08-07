import { createRuntime } from './createRuntime'
import { createApp } from './app'
import { isLoopbackHost } from '../shared/appConfig'

const SHUTDOWN_FORCE_EXIT_MS = 30_000

// This module is the daemon executable, not a library. Process-level concerns
// (signal handlers, exit codes) live here so createRuntime stays embeddable.
const runtime = createRuntime()
let shutdownStarted = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true
  console.log(`[server] Received ${signal}; shutting down LoopTroop backend.`)

  const forceExit = setTimeout(() => {
    console.error('[server] Graceful shutdown timed out; forcing exit.')
    process.exit(1)
  }, SHUTDOWN_FORCE_EXIT_MS)
  forceExit.unref()

  try {
    await runtime.close()
    clearTimeout(forceExit)
    console.log('[server] Graceful shutdown completed.')
    process.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[server] Shutdown failed: ${message}`)
    process.exit(1)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

runtime.start().then((address) => {
  console.log(`[server] LoopTroop backend running on http://${address.hostname}:${address.port}`)
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[server] LoopTroop backend failed to start: ${message}`)
  process.exit(1)
})

export { createApp, createRuntime, isLoopbackHost }
