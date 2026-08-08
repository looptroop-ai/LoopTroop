import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon, installShutdownHandlers } from '../daemon/startDaemon'
import { resolveSettings } from '../lib/appSettings'

function readVersion(): string {
  try {
    // dist/server/cli/daemonProcess.js -> package root is three levels up.
    const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export interface DaemonProcessOptions {
  port?: number
  /**
   * True when stdout is the user's terminal. The detached daemon's stdout is a
   * log file that outlives the run, so the bootstrap URL is printed only for a
   * foreground run; `looptroop start` mints its own over the API instead.
   */
  foreground?: boolean
}

/**
 * Entry point for the daemon process itself, whether detached by `start` or run
 * in the foreground. Signal handlers are installed here rather than in
 * startDaemon so the embeddable path stays free of process-wide effects.
 */
export async function runDaemonProcess(options: DaemonProcessOptions = {}): Promise<void> {
  const settings = resolveSettings(options.port === undefined ? {} : { flags: { port: options.port } })

  const handle = await startDaemon({
    settings,
    version: readVersion(),
    onReady: (state) => {
      console.log(`[daemon] Serving on http://${state.host}:${state.port} (pid ${state.pid}).`)
    },
  })

  installShutdownHandlers(handle)
  if (options.foreground) {
    console.log(`[daemon] Open ${handle.bootstrapUrl()}`)
  }
}

// Executed directly when spawned as the detached child.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runDaemonProcess().catch((error: unknown) => {
    console.error(`[daemon] Failed to start: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
