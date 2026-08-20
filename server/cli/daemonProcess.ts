import { isEntryPoint } from './entryPoint'
import { APP_VERSION } from '../lib/appVersion'
import { startDaemon, installShutdownHandlers } from '../daemon/startDaemon'
import { startDaemonLogRotation } from '../lib/daemonLog'
import { resolveSettings } from '../lib/appSettings'

export interface DaemonProcessOptions {
  port?: number
  /** Include full DEBUG output from a managed OpenCode child. */
  opencodeLogs?: 'all'
  /**
   * True when the user asked for a foreground run. The detached daemon's stdout
   * is a log file that outlives the run, so the bootstrap URL is never printed
   * there; `looptroop start` mints its own over the API instead.
   */
  foreground?: boolean
}

export function resolveDaemonOpenCodeLogs(
  options: DaemonProcessOptions,
  env: NodeJS.ProcessEnv = process.env,
): 'all' | undefined {
  return options.opencodeLogs === 'all' || env.LOOPTROOP_OPENCODE_LOGS === 'all'
    ? 'all'
    : undefined
}

/**
 * What a foreground daemon says about signing in.
 *
 * The URL carries a nonce that buys a browser session, so it is written only to
 * a real terminal. Redirected to a file, captured by systemd or collected by
 * `docker logs`, that same line becomes a durable credential somewhere far more
 * readable than the daemon's own owner-only files. The URL is a thunk so a
 * nonce that will not be shown is never minted.
 */
export function signInLine(bootstrapUrl: () => string, stdoutIsTerminal: boolean): string {
  return stdoutIsTerminal
    ? `[daemon] Open ${bootstrapUrl()}`
    : '[daemon] Run `looptroop open` for a sign-in link.'
}

/**
 * Entry point for the daemon process itself, whether detached by `start` or run
 * in the foreground. Signal handlers are installed here rather than in
 * startDaemon so the embeddable path stays free of process-wide effects.
 */
export async function runDaemonProcess(options: DaemonProcessOptions = {}): Promise<void> {
  const settings = resolveSettings(options.port === undefined ? {} : { flags: { port: options.port } })
  const opencodeLogs = resolveDaemonOpenCodeLogs(options)

  const handle = await startDaemon({
    settings,
    version: APP_VERSION,
    ...(opencodeLogs === undefined ? {} : { opencodeLogs }),
    onReady: (state) => {
      console.log(`[daemon] Serving on http://${state.host}:${state.port} (pid ${state.pid}).`)
    },
  })

  installShutdownHandlers(handle)
  if (options.foreground) {
    console.log(signInLine(() => handle.bootstrapUrl(), process.stdout.isTTY === true))
    return
  }

  // Only the detached run: its stdout is the daemon log, and it is the run that
  // lasts long enough to fill one. A foreground daemon writes to whatever the
  // user pointed it at, which is not LoopTroop's to truncate.
  startDaemonLogRotation()
}

// Executed directly when spawned as the detached child.
if (isEntryPoint(import.meta.url, process.argv[1])) {
  runDaemonProcess().catch((error: unknown) => {
    console.error(`[daemon] Failed to start: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
