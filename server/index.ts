import { createRuntime, type LoopTroopRuntime } from './createRuntime'
import { createApp } from './app'
import { isLoopbackHost } from '../shared/appConfig'
import { isEntryPoint } from './cli/entryPoint'
import { getErrorMessage } from '@shared/typeGuards'
import { SHUTDOWN_FORCE_EXIT_MS } from './lib/constants'

/**
 * Starts the backend as a process: signal handlers, exit codes, the lot.
 *
 * These belong behind a function rather than at module scope because this file
 * is the package's `main`. At module scope, `import('looptroop')` — or a test
 * that pulls in `createApp` from the package root, or a tool that inspects the
 * export shape — would bind a port and install process-wide signal handlers as
 * a side effect of the import, with no way to opt out and no obvious cause when
 * a port turns out to be taken.
 */
export async function main(): Promise<void> {
  const runtime = createRuntime()
  installShutdownHandlers(runtime)

  try {
    const address = await runtime.start()
    console.log(`[server] LoopTroop backend running on http://${address.hostname}:${address.port}`)
  } catch (error) {
    const message = getErrorMessage(error)
    console.error(`[server] LoopTroop backend failed to start: ${message}`)
    process.exit(1)
  }
}

function installShutdownHandlers(runtime: LoopTroopRuntime): void {
  let shutdownStarted = false

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
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
      const message = getErrorMessage(error)
      console.error(`[server] Shutdown failed: ${message}`)
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

// Run only when this file is what Node was asked to execute.
if (isEntryPoint(import.meta.url, process.argv[1])) {
  void main()
}

export { createApp, createRuntime, isLoopbackHost }
